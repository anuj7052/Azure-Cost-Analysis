"""
Team management for a workspace owner.

Reads are open to everyone in the workspace, because a member should be able to
see who else can see their organisation's cost data. Writes require the owner.
"""
import aiosqlite
from fastapi import APIRouter, Depends, Header, HTTPException, Query
from typing import Optional

from auth.dependencies import get_current_user, require_workspace_owner
from core.db import get_db
from models.schemas import (
    DirectorySearchResult,
    InviteRequest,
    MemberRoleRequest,
    TeamOverview,
)
from services import graph_directory, team_service

router = APIRouter(prefix="/api/team", tags=["team"])


async def _owner_row(db: aiosqlite.Connection, owner_id: int) -> aiosqlite.Row:
    async with db.execute("SELECT * FROM users WHERE id = ?", (owner_id,)) as cursor:
        row = await cursor.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Workspace owner not found.")
    return row


@router.get("", response_model=TeamOverview)
async def get_team(
    db: aiosqlite.Connection = Depends(get_db),
    current_user: dict = Depends(get_current_user),
):
    owner_id = current_user["account_id"]
    owner = await _owner_row(db, owner_id)
    usage = await team_service.seat_usage(db, owner_id)
    members = await team_service.list_team(db, owner_id)

    return TeamOverview(
        is_owner=current_user["is_owner"],
        owner_email=owner["email"] or "",
        members=members,
        **usage,
    )


@router.get("/directory", response_model=DirectorySearchResult)
async def search_directory(
    q: str = Query("", max_length=60),
    graph_token: Optional[str] = Header(None, alias="X-Graph-Token"),
    current_user: dict = Depends(require_workspace_owner),
):
    """
    People in the caller's own Microsoft directory matching what they typed.

    Graph resolves this against the directory the token was issued for, so the
    tenant scoping is structural: there is no parameter here that could be
    pointed at somebody else's organisation.

    Reserved to the owner because the results are the only thing the add-person
    control consumes, and only the owner can add a person.
    """
    result = await graph_directory.search_people(graph_token, q)
    return DirectorySearchResult(**result)


@router.post("/invitations", response_model=TeamOverview, status_code=201)
async def create_invitation(
    body: InviteRequest,
    db: aiosqlite.Connection = Depends(get_db),
    current_user: dict = Depends(require_workspace_owner),
):
    owner = await _owner_row(db, current_user["account_id"])
    try:
        await team_service.invite(db, owner, body.email, body.role)
    except team_service.TeamError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message)

    return await get_team(db=db, current_user=current_user)


@router.patch("/members/{member_id}/role", response_model=TeamOverview)
async def change_member_role(
    member_id: int,
    body: MemberRoleRequest,
    db: aiosqlite.Connection = Depends(get_db),
    current_user: dict = Depends(require_workspace_owner),
):
    try:
        await team_service.set_member_role(
            db, current_user["account_id"], member_id, body.role
        )
    except team_service.TeamError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message)

    return await get_team(db=db, current_user=current_user)


@router.patch("/invitations/{invitation_id}/role", response_model=TeamOverview)
async def change_invitation_role(
    invitation_id: int,
    body: MemberRoleRequest,
    db: aiosqlite.Connection = Depends(get_db),
    current_user: dict = Depends(require_workspace_owner),
):
    try:
        await team_service.set_invitation_role(
            db, current_user["account_id"], invitation_id, body.role
        )
    except team_service.TeamError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message)

    return await get_team(db=db, current_user=current_user)


@router.delete("/invitations/{invitation_id}", response_model=TeamOverview)
async def delete_invitation(
    invitation_id: int,
    db: aiosqlite.Connection = Depends(get_db),
    current_user: dict = Depends(require_workspace_owner),
):
    try:
        await team_service.revoke_invitation(
            db, current_user["account_id"], invitation_id
        )
    except team_service.TeamError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message)

    return await get_team(db=db, current_user=current_user)


@router.delete("/members/{member_id}", response_model=TeamOverview)
async def delete_member(
    member_id: int,
    db: aiosqlite.Connection = Depends(get_db),
    current_user: dict = Depends(require_workspace_owner),
):
    try:
        await team_service.remove_member(db, current_user["account_id"], member_id)
    except team_service.TeamError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message)

    return await get_team(db=db, current_user=current_user)
