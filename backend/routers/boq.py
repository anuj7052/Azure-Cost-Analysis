from typing import Any, Dict, List, Literal, Optional

import aiosqlite
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import PlainTextResponse, Response
from pydantic import BaseModel, Field

import logging
from datetime import datetime, timezone

from auth.dependencies import get_current_user
from services.azure_errors import azure_error
from core.db import get_db
from models.schemas import CostQueryRequest, GeneratedBoqResponse
from services import iac_service, integration_service
from services.analysis import resource_cost_index
from services.boq_builder import build_boq
from services.boq_chat_service import BoqChatService
from services.boq_parser import BOQ_EXTENSIONS, parse_boq_file
from services.cost_client import query_active_resources, query_costs
from services.estimate_export import build_estimate_workbook
from services.token_resolver import resolve_tenant_token

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/boq", tags=["boq"])

MAX_UPLOAD_BYTES = 10 * 1024 * 1024  # 10 MB — estimates are small


async def _read_estimate(file: UploadFile) -> Dict[str, Any]:
    """Validate and parse an uploaded estimate, or raise the right HTTP error."""
    filename = file.filename or "estimate.csv"
    if not filename.lower().endswith(BOQ_EXTENSIONS):
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file type. Accepted: {', '.join(BOQ_EXTENSIONS)}",
        )

    content = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"File too large. Maximum size is {MAX_UPLOAD_BYTES // (1024 * 1024)} MB",
        )

    try:
        return parse_boq_file(content, filename)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Failed to parse the estimate: {exc}")


@router.post("/parse")
async def upload_boq(
    file: UploadFile = File(...),
    current_user: dict = Depends(get_current_user),
) -> Dict[str, Any]:
    """
    Parse an Azure Pricing Calculator estimate (BOQ) into budget line items.

    The result is returned to the client rather than stored, so several
    estimates can be held side by side and compared against imported usage.
    """
    return await _read_estimate(file)


@router.post("/plan")
async def plan_boq(
    file: UploadFile = File(...),
    resource_group: str = Form("rg-boq"),
    current_user: dict = Depends(get_current_user),
) -> Dict[str, Any]:
    """Recover the Azure resources an estimate describes, without deploying them."""
    boq = await _read_estimate(file)
    return iac_service.build_plan(boq, resource_group=resource_group)


@router.post("/generate")
async def generate_iac(
    file: UploadFile = File(...),
    format: str = Form("bicep"),
    resource_group: str = Form("rg-boq"),
    current_user: dict = Depends(get_current_user),
) -> Dict[str, Any]:
    """Generate a Bicep or Terraform template for the estimate.

    Generation only: the template is handed back for the customer to review and
    run. Nothing here holds write access to an Azure subscription.
    """
    if format not in {"bicep", "terraform"}:
        raise HTTPException(status_code=400, detail="Unsupported format. Use 'bicep' or 'terraform'.")

    boq = await _read_estimate(file)
    plan = iac_service.build_plan(boq, resource_group=resource_group)
    return {
        **plan,
        "format": format,
        "filename": "main.bicep" if format == "bicep" else "main.tf",
        "content": iac_service.render(plan, format),
    }


@router.post("/generate/download", response_class=PlainTextResponse)
async def download_iac(
    file: UploadFile = File(...),
    format: str = Form("bicep"),
    resource_group: str = Form("rg-boq"),
    current_user: dict = Depends(get_current_user),
):
    result = await generate_iac(
        file=file,
        format=format,
        resource_group=resource_group,
        current_user=current_user,
    )
    return PlainTextResponse(
        result["content"],
        media_type="text/plain; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{result["filename"]}"'},
    )


class ChatTurn(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(max_length=4000)


class BoqChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=2000)
    # The parsed estimate from /parse, echoed back by the client. Nothing is
    # stored server-side, so the BOQ never leaves the caller's session.
    boq: Optional[Dict[str, Any]] = None
    history: List[ChatTurn] = Field(default_factory=list, max_length=20)
    resource_group: str = Field(default="rg-boq", max_length=90)


@router.post("/chat")
async def chat_about_boq(
    payload: BoqChatRequest,
    current_user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
) -> Dict[str, Any]:
    """Converse about an estimate and generate templates on request."""
    llm = await integration_service.llm_config(db, current_user["account_id"])
    try:
        # The same endpoint and the same invoice as the build assistant, so it
        # draws on the same daily allowance. Two chats sharing a key must not
        # mean two separate budgets.
        await integration_service.consume(
            db, llm.get("integration_id"), llm.get("source", "your endpoint")
        )
    except integration_service.RateLimitExceeded as exc:
        raise HTTPException(status_code=429, detail=str(exc)) from None
    service = BoqChatService(payload.boq, resource_group=payload.resource_group, llm=llm)
    return await service.chat(
        payload.message, [t.model_dump() for t in payload.history]
    )


@router.post("/chat/upload")
async def chat_with_upload(
    file: UploadFile = File(...),
    message: str = Form("Generate the infrastructure-as-code for this estimate."),
    resource_group: str = Form("rg-boq"),
    current_user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
) -> Dict[str, Any]:
    """Upload an estimate and act on it in a single call."""
    boq = await _read_estimate(file)
    llm = await integration_service.llm_config(db, current_user["account_id"])
    try:
        # The same endpoint and the same invoice as the build assistant, so it
        # draws on the same daily allowance. Two chats sharing a key must not
        # mean two separate budgets.
        await integration_service.consume(
            db, llm.get("integration_id"), llm.get("source", "your endpoint")
        )
    except integration_service.RateLimitExceeded as exc:
        raise HTTPException(status_code=429, detail=str(exc)) from None
    service = BoqChatService(boq, resource_group=resource_group, llm=llm)
    return await service.chat(message, [])


@router.post("/from-subscription", response_model=GeneratedBoqResponse)
async def boq_from_subscription(
    body: CostQueryRequest,
    current_user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    """
    Build a Bill of Quantities from what is actually running.

    The rest of this router runs the other way — an estimate is uploaded and
    compared against reality. This produces the estimate *from* reality, which
    is otherwise a manual job: reading the portal resource by resource and
    copying SKUs into a spreadsheet.

    Costs are what Azure billed, not list prices. A quotation built on list
    prices disagrees with the invoice the moment a discount, reservation or
    negotiated rate applies.

    The cost half is best effort. A throttled billing query still leaves a
    complete inventory, which is a usable BOQ missing its prices rather than
    no BOQ at all — and `unpriced_count` says how much is missing.
    """
    token = await resolve_tenant_token(body.tenant_id, current_user, db)

    try:
        resources = await query_active_resources(token, body.subscription_ids)
    except Exception as exc:
        raise azure_error(exc, "your resources")

    cost_records: List[Dict[str, Any]] = []
    for sub_id in body.subscription_ids:
        try:
            cost_records.extend(await query_costs(
                token=token,
                subscription_id=sub_id,
                months=1,
                group_by=["ResourceId", "ServiceName", "Meter"],
                granularity="Monthly",
            ))
        except Exception as exc:
            log.warning("BOQ cost lookup failed for %s: %s", sub_id, exc)
            continue

    costs = resource_cost_index(cost_records)
    currency = next((r.get("Currency") for r in cost_records if r.get("Currency")), "USD")

    priced = []
    for r in resources:
        billed = costs.get((r.get("id") or "").lower(), {})
        priced.append({
            "name": r.get("name", ""),
            "type": r.get("type", ""),
            "resource_group": r.get("resourceGroup", ""),
            "location": r.get("location", ""),
            "sku": (r.get("skuName") or r.get("vmSize") or "").strip(),
            "size": (r.get("skuSize") or "").strip(),
            "tier": (r.get("skuTier") or r.get("diskTier") or "").strip(),
            "service": billed.get("service", ""),
            "cost": billed.get("cost"),
        })

    return build_boq(priced, currency=currency)


class EstimateExportRequest(BaseModel):
    """
    A BOQ to render, echoed back by the client.

    The BOQ is sent rather than rebuilt because rebuilding would re-run the
    resource and cost queries against Azure — a second round of throttled calls
    to produce a document the caller is already looking at. It also means the
    export matches the figures on screen exactly, including any that were
    filtered before download.
    """
    items: List[Dict[str, Any]] = Field(default_factory=list, max_length=5000)
    currency: str = Field(default="USD", max_length=8)
    total_monthly: float = 0.0
    total_yearly: float = 0.0
    resource_count: int = 0
    line_count: int = 0
    unpriced_count: int = 0
    title: str = Field(default="Your Estimate", max_length=120)
    billing_account: str = Field(default="", max_length=200)
    billing_profile: str = Field(default="", max_length=200)


@router.post("/export/estimate.xlsx")
async def export_estimate_xlsx(
    payload: EstimateExportRequest,
    current_user: dict = Depends(get_current_user),
):
    """
    Download a BOQ as an .xlsx in the Azure Pricing Calculator's export layout.

    The calculator's own export is the shape procurement already reads, so a BOQ
    in that shape needs no covering explanation and can be placed side by side
    with a real estimate. What it is *not* is a calculator estimate — the
    figures are billed amounts, and the disclaimer block in the sheet says so.
    """
    boq = payload.model_dump()
    content = build_estimate_workbook(boq, title=payload.title)
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    return Response(
        content=content,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={
            "Content-Disposition": f'attachment; filename="azure-estimate-{stamp}.xlsx"',
        },
    )
