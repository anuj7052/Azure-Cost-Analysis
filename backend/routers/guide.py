"""Downloadable documentation. No tenant data, but sign-in is still required."""
from fastapi import APIRouter, Depends
from fastapi.responses import Response

from auth.dependencies import get_current_user
from services.setup_guide import build_setup_guide

router = APIRouter(prefix="/api/guide", tags=["guide"])


@router.get("/setup.pdf")
async def setup_guide_pdf(current_user: dict = Depends(get_current_user)):
    pdf = build_setup_guide()
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={
            "Content-Disposition":
                'attachment; filename="azure-cost-analysis-setup-guide.pdf"'
        },
    )
