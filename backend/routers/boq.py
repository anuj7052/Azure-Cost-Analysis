from typing import Any, Dict, List, Literal, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field

from auth.dependencies import get_current_user
from services import iac_service
from services.boq_chat_service import BoqChatService
from services.boq_parser import BOQ_EXTENSIONS, parse_boq_file

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
) -> Dict[str, Any]:
    """Converse about an estimate and generate templates on request."""
    service = BoqChatService(payload.boq, resource_group=payload.resource_group)
    return await service.chat(
        payload.message, [t.model_dump() for t in payload.history]
    )


@router.post("/chat/upload")
async def chat_with_upload(
    file: UploadFile = File(...),
    message: str = Form("Generate the infrastructure-as-code for this estimate."),
    resource_group: str = Form("rg-boq"),
    current_user: dict = Depends(get_current_user),
) -> Dict[str, Any]:
    """Upload an estimate and act on it in a single call."""
    boq = await _read_estimate(file)
    service = BoqChatService(boq, resource_group=resource_group)
    return await service.chat(message, [])
