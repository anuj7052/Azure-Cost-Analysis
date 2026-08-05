from collections import defaultdict
from typing import Any, Dict

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile

from auth.dependencies import get_current_user
from services.csv_parser import SUPPORTED_EXTENSIONS, parse_cost_file

router = APIRouter(prefix="/api/upload", tags=["upload"])

MAX_UPLOAD_BYTES = 20 * 1024 * 1024  # 20 MB


@router.post("")
async def upload_cost_file(
    file: UploadFile = File(...),
    current_user: dict = Depends(get_current_user),
) -> Dict[str, Any]:
    """
    Import an Azure cost export (CSV, Excel or PDF).

    Returns meter-level rows aggregated by month / subscription / service /
    meter. The client keeps them for the session and recomputes every summary
    locally, so subscription filters apply to imported data exactly the same
    way they do to live API data.
    """
    filename = file.filename or "upload.csv"
    if not filename.lower().endswith(SUPPORTED_EXTENSIONS):
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file type. Accepted: {', '.join(SUPPORTED_EXTENSIONS)}",
        )

    content = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"File too large. Maximum size is {MAX_UPLOAD_BYTES // (1024 * 1024)} MB",
        )

    try:
        parsed = parse_cost_file(content, filename)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Failed to parse the file: {exc}")

    records = parsed["records"]
    if not records:
        raise HTTPException(
            status_code=422,
            detail="No valid cost rows found. Check that the file has a cost column with numeric values.",
        )

    # Collapse to one row per month / subscription / service / RG / meter.
    buckets: Dict[tuple, Dict[str, Any]] = {}
    sub_names: Dict[str, str] = {}
    sub_totals: Dict[str, float] = defaultdict(float)

    for r in records:
        sub_id = r["subscription_id"]
        if r["subscription_name"]:
            sub_names.setdefault(sub_id, r["subscription_name"])
        sub_totals[sub_id] += r["cost"]

        # Keeping the resource in the key is what lets the UI name the exact
        # disk or VM behind a charge instead of just its meter.
        key = (
            r["month"], sub_id, r["service_name"], r["resource_group"],
            r["meter"], r["resource_name"],
        )
        bucket = buckets.get(key)
        if bucket is None:
            bucket = buckets[key] = {
                "month": r["month"],
                "subscription_id": sub_id,
                "service": r["service_name"],
                "resource_group": r["resource_group"],
                "resource_name": r["resource_name"],
                "resource_type": r["resource_type"],
                "meter": r["meter"],
                "meter_category": r["meter_category"],
                "meter_subcategory": r["meter_subcategory"],
                "unit_of_measure": r["unit_of_measure"],
                "region": r["region"],
                "cost": 0.0,
                "quantity": 0.0,
            }
        bucket["cost"] += r["cost"]
        bucket["quantity"] += r["quantity"]

    rows = [
        {**b, "cost": round(b["cost"], 4), "quantity": round(b["quantity"], 6)}
        for b in buckets.values()
    ]
    rows.sort(key=lambda b: (b["month"], -b["cost"]))

    months = sorted({r["month"] for r in rows})
    currency = records[0]["currency"]

    subscriptions = [
        {
            "subscription_id": sub_id,
            "display_name": sub_names.get(sub_id) or sub_id,
            "state": "Imported",
            "total_cost": round(total, 2),
        }
        for sub_id, total in sorted(sub_totals.items(), key=lambda kv: kv[1], reverse=True)
    ]

    return {
        "source": "upload",
        "file_name": filename,
        "source_type": parsed["source_type"],
        "rows_read": parsed["rows_read"],
        "rows_used": parsed["rows_used"],
        "columns": parsed["columns"],
        "dated": parsed["dated"],
        "currency": currency,
        "months": months,
        "subscriptions": subscriptions,
        "rows": rows,
    }
