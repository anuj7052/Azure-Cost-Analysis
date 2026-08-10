"""BOQ upload, parsing and infrastructure-as-code generation.

Generation only: these endpoints never call Azure and never need write access
to a customer subscription. The caller downloads the template and runs it
themselves, which keeps the platform inside its read-only consent grant.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, File, Form, Request, UploadFile
from fastapi.responses import PlainTextResponse

from app.auth.dependencies import CurrentUser, DbSession, require
from app.auth.rbac import Permission
from app.core.errors import RateLimitedError, ValidationError
from app.schemas import BoqChatAnswer, BoqChatRequest, BoqOut, IacPlanOut, IacTemplateOut
from app.services import boq_parser, iac_service
from app.services.audit import AuditService
from app.services.boq_chat_service import BoqChatService

log = logging.getLogger(__name__)
router = APIRouter(prefix="/boq", tags=["boq"])

_FORMATS = {"bicep": ("bicep", "main.bicep"), "terraform": ("terraform", "main.tf")}


async def _parse_upload(file: UploadFile) -> dict:
    content = await file.read()
    if not content:
        raise ValidationError("The uploaded file is empty.")
    if len(content) > boq_parser.MAX_BOQ_BYTES:
        raise ValidationError(
            f"File too large. Maximum is {boq_parser.MAX_BOQ_BYTES // (1024 * 1024)} MB."
        )
    try:
        return boq_parser.parse_boq_file(content, file.filename or "estimate.xlsx")
    except ValueError as exc:
        raise ValidationError(str(exc)) from exc


@router.post(
    "/parse",
    response_model=BoqOut,
    dependencies=[Depends(require(Permission.READ))],
    summary="Parse an Azure Pricing Calculator estimate",
)
async def parse_boq(principal: CurrentUser, file: UploadFile = File(...)):
    return await _parse_upload(file)


@router.post(
    "/plan",
    response_model=IacPlanOut,
    dependencies=[Depends(require(Permission.GENERATE_IAC))],
    summary="Recover the deployable resources described by an estimate",
)
async def plan_boq(
    principal: CurrentUser,
    file: UploadFile = File(...),
    resource_group: str = Form("rg-boq"),
):
    boq = await _parse_upload(file)
    return iac_service.build_plan(boq, resource_group=resource_group)


@router.post(
    "/generate",
    response_model=IacTemplateOut,
    dependencies=[Depends(require(Permission.GENERATE_IAC))],
    summary="Generate a Bicep or Terraform template from an estimate",
)
async def generate_iac(
    request: Request,
    principal: CurrentUser,
    db: DbSession,
    file: UploadFile = File(...),
    fmt: str = Form("bicep", alias="format"),
    resource_group: str = Form("rg-boq"),
):
    if fmt not in _FORMATS:
        raise ValidationError("Unsupported format. Use 'bicep' or 'terraform'.")

    boq = await _parse_upload(file)
    plan = iac_service.build_plan(boq, resource_group=resource_group)
    _, filename = _FORMATS[fmt]

    await AuditService(db, principal.tenant_id).record(
        principal=principal,
        action="iac.generate",
        target_type="boq",
        target_id=plan["name"][:255],
        ip_address=request.client.host if request.client else "",
        details={
            "format": fmt,
            "resources": len(plan["resources"]),
            "needs_review": len(plan["needs_review"]),
        },
    )

    return {**plan, "format": fmt, "filename": filename, "content": iac_service.render(plan, fmt)}


@router.post(
    "/generate/download",
    response_class=PlainTextResponse,
    dependencies=[Depends(require(Permission.GENERATE_IAC))],
    summary="Download the generated template as a file",
)
async def download_iac(
    request: Request,
    principal: CurrentUser,
    db: DbSession,
    file: UploadFile = File(...),
    fmt: str = Form("bicep", alias="format"),
    resource_group: str = Form("rg-boq"),
):
    result = await generate_iac(
        request=request,
        principal=principal,
        db=db,
        file=file,
        fmt=fmt,
        resource_group=resource_group,
    )
    return PlainTextResponse(
        result["content"],
        media_type="text/plain; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{result["filename"]}"'},
    )


def _rate_limit_key(principal: CurrentUser) -> str:
    return f"boqchat:{principal.tenant_id}:{principal.object_id}"


async def _run_chat(
    *,
    request: Request,
    principal: CurrentUser,
    db: DbSession,
    message: str,
    boq: dict | None,
    history: list[dict],
    resource_group: str,
) -> dict:
    limiter = getattr(request.app.state, "rate_limiter", None)
    if limiter is not None and not await limiter.allow(_rate_limit_key(principal)):
        raise RateLimitedError("Chat hourly limit reached for this user.")

    service = BoqChatService(boq, resource_group=resource_group)
    result = await service.chat(message, history)

    await AuditService(db, principal.tenant_id).record(
        principal=principal,
        action="boq.chat",
        target_type="boq",
        target_id=(boq or {}).get("name", "")[:255],
        ip_address=request.client.host if request.client else "",
        details={
            "message": message[:500],
            "tools": result["used_tools"],
            "artifacts": [a["format"] for a in result["artifacts"]],
        },
    )
    return result


@router.post(
    "/chat",
    response_model=BoqChatAnswer,
    dependencies=[Depends(require(Permission.GENERATE_IAC))],
    summary="Chat about an estimate and generate templates on request",
)
async def chat_about_boq(
    payload: BoqChatRequest, request: Request, principal: CurrentUser, db: DbSession
):
    return await _run_chat(
        request=request,
        principal=principal,
        db=db,
        message=payload.message,
        boq=payload.boq.model_dump() if payload.boq else None,
        history=[t.model_dump() for t in payload.history],
        resource_group=payload.resource_group,
    )


@router.post(
    "/chat/upload",
    response_model=BoqChatAnswer,
    dependencies=[Depends(require(Permission.GENERATE_IAC))],
    summary="Upload an estimate and act on it in one call",
)
async def chat_with_upload(
    request: Request,
    principal: CurrentUser,
    db: DbSession,
    file: UploadFile = File(...),
    message: str = Form("Generate the infrastructure-as-code for this estimate."),
    resource_group: str = Form("rg-boq"),
):
    boq = await _parse_upload(file)
    return await _run_chat(
        request=request,
        principal=principal,
        db=db,
        message=message,
        boq=boq,
        history=[],
        resource_group=resource_group,
    )
