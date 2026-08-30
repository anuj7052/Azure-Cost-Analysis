"""Downloadable documentation. No tenant data, but sign-in is still required."""
from fastapi import APIRouter, Depends
from fastapi.responses import Response

from auth.dependencies import get_current_user
from core.config import settings
from services.setup_guide import build_setup_guide
from services import permissions_manifest

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


def _redirect_uri() -> str:
    """
    Where an administrator lands after consenting.

    Taken from the configured origins rather than a separate setting, because
    a redirect URI that is not already registered on the app registration will
    be rejected by Entra, and the origins list is what that registration is
    kept in step with.
    """
    origins = [o for o in settings.cors_origins_list if o]
    if not origins:
        return ""
    return next((o for o in origins if o.startswith("https://")), origins[0])


@router.get("/permissions")
async def permissions(
    tenant_id: str = "",
    current_user: dict = Depends(get_current_user),
):
    """
    Everything this app asks for, in one list.

    `tenant_id` defaults to the caller's own directory. It is only used to
    build the consent link, and an administrator consenting is scoped entirely
    to their own tenant, so accepting it from the caller costs nothing.
    """
    return permissions_manifest.manifest(
        tenant_id=tenant_id or current_user.get("tenant_id", "") or "",
        client_id=settings.AZURE_CLIENT_ID,
        redirect_uri=_redirect_uri(),
    )
