"""Dated sticky notes on cost activity, shared within a workspace.

A note pins context ("scaled the AKS pool for a load test") to a date in a
tenant, optionally to one subscription, so whoever opens that day's costs later
sees why the amount moved. Notes are scoped to the signed-in workspace; any
member may add one, and only its author or a workspace admin may change it.
"""
import uuid
from datetime import date
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, field_validator

from auth.dependencies import get_current_user
from core.db import get_db

router = APIRouter(prefix="/api/cost-notes", tags=["cost notes"])

COLORS = ("yellow", "orange", "blue", "green", "pink")
MAX_RANGE_DAYS = 800
FIELDS = "id,tenant_id,subscription_id,note_date,body,color,author_id,author_name,created_at,updated_at"


def _day(value: str) -> str:
    try:
        return date.fromisoformat(value).isoformat()
    except (TypeError, ValueError) as exc:
        raise ValueError("Use a YYYY-MM-DD date.") from exc


class NoteInput(BaseModel):
    tenant_id: str = Field(min_length=1, max_length=100)
    subscription_id: str = Field(default="", max_length=100)
    note_date: str
    body: str = Field(min_length=1, max_length=2000, pattern=r"\S")
    color: Literal[COLORS] = "yellow"

    @field_validator("note_date")
    @classmethod
    def _valid_date(cls, value):
        return _day(value)


class NoteUpdate(BaseModel):
    body: Optional[str] = Field(default=None, min_length=1, max_length=2000, pattern=r"\S")
    color: Optional[Literal[COLORS]] = None
    note_date: Optional[str] = None

    @field_validator("note_date")
    @classmethod
    def _valid_date(cls, value):
        return None if value is None else _day(value)


def _row(row, user) -> dict:
    note = dict(zip(FIELDS.split(","), row))
    note["can_edit"] = note["author_id"] == user["actor_id"] or bool(user.get("can_administer"))
    return note


def _author_name(user: dict) -> str:
    return str(user.get("name") or user.get("email") or user.get("preferred_username") or "Workspace member")[:200]


async def _owned(db, user, note_id: str):
    cursor = await db.execute(f"SELECT {FIELDS} FROM cost_notes WHERE id=? AND owner_id=?", (note_id, user["account_id"]))
    row = await cursor.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Note not found.")
    note = _row(row, user)
    if not note["can_edit"]:
        raise HTTPException(status_code=403, detail="Only the note's author or a workspace admin can change it.")
    return note


@router.get("")
async def list_notes(
    tenant_id: str = Query(min_length=1, max_length=100),
    from_date: str = Query(...),
    to_date: str = Query(...),
    subscription_ids: list[str] = Query(default=[]),
    user=Depends(get_current_user),
    db=Depends(get_db),
):
    try:
        start, end = _day(from_date), _day(to_date)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if start > end:
        raise HTTPException(status_code=422, detail="The start date must be on or before the end date.")
    if (date.fromisoformat(end) - date.fromisoformat(start)).days > MAX_RANGE_DAYS:
        raise HTTPException(status_code=422, detail="Choose a shorter date range.")
    cursor = await db.execute(
        f"SELECT {FIELDS} FROM cost_notes WHERE owner_id=? AND tenant_id=? AND note_date>=? AND note_date<=? "
        "ORDER BY note_date, created_at",
        (user["account_id"], tenant_id, start, end),
    )
    rows = [_row(row, user) for row in await cursor.fetchall()]
    # Tenant-wide notes always apply; subscription notes only when that
    # subscription is part of the current selection.
    wanted = set(subscription_ids)
    if wanted:
        rows = [note for note in rows if not note["subscription_id"] or note["subscription_id"] in wanted]
    return {"notes": rows}


@router.post("", status_code=201)
async def create_note(body: NoteInput, user=Depends(get_current_user), db=Depends(get_db)):
    key = str(uuid.uuid4())
    await db.execute(
        "INSERT INTO cost_notes(id,owner_id,tenant_id,subscription_id,note_date,body,color,author_id,author_name) "
        "VALUES(?,?,?,?,?,?,?,?,?)",
        (key, user["account_id"], body.tenant_id, body.subscription_id, body.note_date, body.body.strip(),
         body.color, user["actor_id"], _author_name(user)),
    )
    await db.commit()
    cursor = await db.execute(f"SELECT {FIELDS} FROM cost_notes WHERE id=?", (key,))
    return _row(await cursor.fetchone(), user)


@router.patch("/{note_id}")
async def update_note(note_id: str, body: NoteUpdate, user=Depends(get_current_user), db=Depends(get_db)):
    note = await _owned(db, user, note_id)
    changes = {key: value for key, value in body.model_dump().items() if value is not None}
    if "body" in changes:
        changes["body"] = changes["body"].strip()
    if changes:
        assignments = ",".join(f"{key}=?" for key in changes)
        await db.execute(
            f"UPDATE cost_notes SET {assignments},updated_at=CURRENT_TIMESTAMP WHERE id=? AND owner_id=?",
            (*changes.values(), note["id"], user["account_id"]),
        )
        await db.commit()
    cursor = await db.execute(f"SELECT {FIELDS} FROM cost_notes WHERE id=?", (note["id"],))
    return _row(await cursor.fetchone(), user)


@router.delete("/{note_id}", status_code=204)
async def delete_note(note_id: str, user=Depends(get_current_user), db=Depends(get_db)):
    note = await _owned(db, user, note_id)
    await db.execute("DELETE FROM cost_notes WHERE id=? AND owner_id=?", (note["id"], user["account_id"]))
    await db.commit()
