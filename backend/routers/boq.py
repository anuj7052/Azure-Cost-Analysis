from typing import Any, Dict

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile

from auth.dependencies import get_current_user
from services.boq_parser import BOQ_EXTENSIONS, parse_boq_file

router = APIRouter(prefix="/api/boq", tags=["boq"])

MAX_UPLOAD_BYTES = 10 * 1024 * 1024  # 10 MB — estimates are small


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
