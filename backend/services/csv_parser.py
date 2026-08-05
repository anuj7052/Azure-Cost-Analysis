"""
Parse Azure cost exports (CSV / Excel / PDF) into normalized records.

Handles the old and new Azure export column naming conventions, and keeps the
meter-level fields so a single upload can drive both the cost analysis and the
bandwidth (data transfer) report.
"""
import io
import re
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

import pandas as pd

# Column aliases: possible export column names → our standard names.
# Lower number = stronger preference when a file offers several candidates for
# the same field (partner "usage detail" reports do exactly that).
COLUMN_MAP = {
    # Cost
    "pretaxcost": "cost",
    "cost": "cost",
    "costinbillingcurrency": "cost",
    "extendedcost": "cost",
    "billedcost": "cost",
    "costinusd": "cost",
    "effectiveprice": "cost",
    # Partner / CSP usage-detail reports bill the customer in this column.
    "customertotal": "cost",
    "amount": "cost",
    "totalcost": "cost",
    "chargeamount": "cost",
    "pretaxcharges": "cost",
    # Date
    "date": "date",
    "usagedate": "date",
    "usagedatetime": "date",
    "billingperiodstartdate": "date",
    "billingmonth": "date",
    "chargeperiodstart": "date",
    "chargestartdate": "date",
    "fromdate": "date",
    # Service
    "servicename": "service_name",
    "metercategory": "service_name",
    "consumedservice": "service_name",
    "productname": "service_name",
    # Subscription
    "subscriptionid": "subscription_id",
    "subscriptionguid": "subscription_id",
    "subaccountid": "subscription_id",
    # In CSP reports `SubscriptionId` is the Azure Plan and is identical on every
    # row; `entitlementId` is the actual Azure subscription the cost belongs to.
    "entitlementid": "subscription_id",
    # Subscription display name
    "subscriptionname": "subscription_name",
    "subaccountname": "subscription_name",
    "entitlementdescription": "subscription_name",
    # Resource group
    "resourcegroup": "resource_group",
    "resourcegroupname": "resource_group",
    # The full ARM id, which is the only place the real resource name appears
    "resourceuri": "resource_id",
    "resourceid": "resource_id",
    "instanceid": "resource_id",
    "instancename": "resource_name",
    "resourcename": "resource_name",
    # Currency
    "currency": "currency",
    "billingcurrency": "currency",
    "currencycode": "currency",
    "customercurrency": "currency",
    # Meter details (used by the bandwidth report)
    "meter": "meter",
    "metername": "meter",
    "metersubcategory": "meter_subcategory",
    "unitofmeasure": "unit_of_measure",
    "unit": "unit_of_measure",
    "unittype": "unit_of_measure",
    "quantity": "quantity",
    "usagequantity": "quantity",
    "consumedquantity": "quantity",
    "resourcelocation": "region",
    "location": "region",
    "meterregion": "region",
}

# When a file has more than one candidate for a field, prefer these (in order).
COLUMN_PREFERENCE = {
    "cost": [
        "costinbillingcurrency", "pretaxcost", "customertotal", "billedcost",
        "cost", "extendedcost", "amount", "totalcost", "chargeamount",
        "pretaxcharges", "costinusd", "effectiveprice",
    ],
    "subscription_id": ["entitlementid", "subscriptionguid", "subscriptionid", "subaccountid"],
    "subscription_name": ["entitlementdescription", "subscriptionname", "subaccountname"],
    "date": [
        "date", "usagedate", "usagedatetime", "chargeperiodstart",
        "chargestartdate", "billingperiodstartdate", "billingmonth", "fromdate",
    ],
    "service_name": ["servicename", "metercategory", "consumedservice", "productname"],
    "meter": ["metername", "meter"],
    "quantity": ["quantity", "usagequantity", "consumedquantity"],
    "region": ["resourcelocation", "meterregion", "location"],
    "unit_of_measure": ["unitofmeasure", "unit", "unittype"],
    "resource_id": ["resourceuri", "resourceid", "instanceid"],
    "resource_name": ["resourcename", "instancename"],
}


def _resource_identity(resource_id: str, fallback_name: str = "") -> tuple[str, str]:
    """Split an ARM id into a display name and an Azure resource type.

    `/subscriptions/../resourceGroups/RG/providers/Microsoft.Compute/disks/mydisk`
    becomes ("mydisk", "Microsoft.Compute/disks").
    """
    text = (resource_id or "").strip().strip("/")
    if not text:
        return fallback_name.strip(), ""
    parts = text.split("/")
    name = fallback_name.strip() or parts[-1]
    kind = ""
    if "providers" in parts:
        i = parts.index("providers")
        # provider, type[, subtype...] — keep the provider and the first type.
        segment = parts[i + 1:i + 3]
        if len(segment) == 2:
            kind = "/".join(segment)
    return name, kind


def _rank(field: str, header: str) -> int:
    """Lower is better. Unlisted candidates sort after the preferred ones."""
    order = COLUMN_PREFERENCE.get(field)
    if not order:
        return 0
    return order.index(header) if header in order else len(order)

# `MeterCategory` doubles as the service name, so it needs its own pass.
METER_CATEGORY_HEADERS = {"metercategory"}

SUPPORTED_EXTENSIONS = (".csv", ".tsv", ".txt", ".xlsx", ".xlsm", ".xls", ".pdf")


def _normalize_header(col: Any) -> str:
    return (
        str(col).strip().lower()
        .replace(" ", "").replace("-", "").replace("_", "").replace("/", "")
    )


# ── Readers ────────────────────────────────────────────────────────────────

def _read_csv(content: bytes) -> pd.DataFrame:
    for encoding in ("utf-8-sig", "utf-16", "latin-1"):
        try:
            df = pd.read_csv(
                io.BytesIO(content), dtype=str, encoding=encoding, sep=None, engine="python"
            )
            if len(df.columns) > 1:
                return df
        except Exception:
            continue
    raise ValueError("Could not read this file as CSV — check the delimiter and encoding.")


def _read_excel(content: bytes) -> pd.DataFrame:
    """Pick the sheet that actually looks like a cost export."""
    book = pd.read_excel(io.BytesIO(content), dtype=str, sheet_name=None)
    best, best_score = None, -1
    for frame in book.values():
        headers = {_normalize_header(c) for c in frame.columns}
        score = len(headers & set(COLUMN_MAP)) * 1000 + len(frame)
        if score > best_score:
            best, best_score = frame, score
    if best is None or best.empty:
        raise ValueError("The workbook has no readable sheet.")
    return best


def _read_pdf(content: bytes) -> pd.DataFrame:
    """
    Extract the first usable table from a PDF invoice / exported report.
    PDFs carry no schema, so we look for a header row naming a cost column.
    """
    try:
        import pdfplumber
    except ImportError as exc:  # pragma: no cover - dependency is pinned
        raise ValueError("PDF support requires the 'pdfplumber' package.") from exc

    rows: List[List[str]] = []
    header: Optional[List[str]] = None

    with pdfplumber.open(io.BytesIO(content)) as pdf:
        for page in pdf.pages:
            for table in page.extract_tables() or []:
                clean = [[(cell or "").strip() for cell in row] for row in table if any(row)]
                if len(clean) < 2:
                    continue
                candidate = clean[0]
                normalized = {_normalize_header(c) for c in candidate}
                if header is None and normalized & set(COLUMN_MAP):
                    header = candidate
                    rows.extend(clean[1:])
                elif header is not None and len(candidate) == len(header):
                    # Continuation of the same table on a later page.
                    rows.extend(clean[1:] if candidate == header else clean)

    if header is None or not rows:
        raise ValueError(
            "No cost table could be extracted from this PDF. Export the data as CSV or "
            "Excel from Cost Management for a reliable import."
        )

    width = len(header)
    rows = [r[:width] + [""] * (width - len(r)) for r in rows]
    return pd.DataFrame(rows, columns=header, dtype=str)


def _read_any(content: bytes, filename: str) -> Tuple[pd.DataFrame, str]:
    name = (filename or "").lower()
    if name.endswith((".xlsx", ".xlsm", ".xls")):
        return _read_excel(content), "excel"
    if name.endswith(".pdf"):
        return _read_pdf(content), "pdf"
    return _read_csv(content), "csv"


# ── Normalisation ──────────────────────────────────────────────────────────

_NUMERIC_NOISE = re.compile(r"[^0-9.\-]")


def _to_number(value: Any) -> Optional[float]:
    if value is None:
        return None
    text = _NUMERIC_NOISE.sub("", str(value))
    if text in ("", "-", ".", "-."):
        return None
    try:
        return float(text)
    except ValueError:
        return None


def parse_cost_file(content: bytes, filename: str = "upload.csv") -> Dict[str, Any]:
    """
    Parse an Azure cost export into normalized records.

    Returns the record list plus a small parse report so the UI can tell the
    user exactly what was picked up.
    """
    df, kind = _read_any(content, filename)

    rename: Dict[str, str] = {}
    meter_category_col = None
    best_rank: Dict[str, int] = {}
    for col in df.columns:
        normalized = _normalize_header(col)
        if normalized in METER_CATEGORY_HEADERS:
            meter_category_col = col
        field = COLUMN_MAP.get(normalized)
        if field is None:
            continue
        rank = _rank(field, normalized)
        # Keep the strongest candidate rather than whichever column came first.
        if field in best_rank and best_rank[field] <= rank:
            continue
        best_rank[field] = rank
        rename = {c: f for c, f in rename.items() if f != field}
        rename[col] = field

    # Keep MeterCategory available even when it was consumed as the service name.
    if meter_category_col is not None:
        df["meter_category"] = df[meter_category_col]

    df = df.rename(columns=rename)
    df = df.loc[:, ~df.columns.duplicated()]

    missing = {"cost"} - set(df.columns)
    if missing:
        raise ValueError(
            f"The file is missing required column(s): {', '.join(sorted(missing))}. "
            f"Columns found: {', '.join(str(c) for c in list(df.columns)[:20])}"
        )

    # Resource-level "Cost analysis" exports carry no date at all - they are a
    # snapshot of whatever period was selected in the portal. Import them as a
    # single period rather than rejecting the file.
    dated = "date" in df.columns

    if "service_name" not in df.columns:
        df["service_name"] = df["meter_category"] if "meter_category" in df.columns else "Unknown"

    for col, default in (
        ("subscription_id", "imported"),
        ("subscription_name", ""),
        ("resource_group", "unknown"),
        ("currency", "USD"),
        ("meter", ""),
        ("meter_category", ""),
        ("meter_subcategory", ""),
        ("unit_of_measure", ""),
        ("quantity", ""),
        ("region", ""),
        ("resource_id", ""),
        ("resource_name", ""),
    ):
        if col not in df.columns:
            df[col] = default

    rows_read = len(df)

    df["cost"] = df["cost"].map(_to_number)
    df = df.dropna(subset=["cost"])

    if dated:
        df["date"] = pd.to_datetime(df["date"], errors="coerce", format="mixed")
        df = df.dropna(subset=["date"])
        df["month"] = df["date"].dt.strftime("%Y-%m")
    else:
        df["month"] = datetime.now().strftime("%Y-%m")

    records: List[Dict[str, Any]] = []
    for row in df.to_dict("records"):
        sub_id = str(row.get("subscription_id") or "imported").strip() or "imported"
        resource_name, resource_type = _resource_identity(
            str(row.get("resource_id") or ""),
            str(row.get("resource_name") or ""),
        )
        records.append({
            "month": row["month"],
            "service_name": str(row.get("service_name") or "Unknown").strip() or "Unknown",
            "resource_group": str(row.get("resource_group") or "unknown").strip() or "unknown",
            "subscription_id": sub_id,
            "subscription_name": str(row.get("subscription_name") or "").strip(),
            "cost": round(float(row["cost"]), 4),
            "currency": str(row.get("currency") or "USD").strip() or "USD",
            "meter": str(row.get("meter") or "").strip(),
            "meter_category": str(row.get("meter_category") or "").strip(),
            "meter_subcategory": str(row.get("meter_subcategory") or "").strip(),
            "unit_of_measure": str(row.get("unit_of_measure") or "").strip(),
            "quantity": _to_number(row.get("quantity")) or 0.0,
            "region": str(row.get("region") or "").strip(),
            "resource_name": resource_name,
            "resource_type": resource_type,
        })

    return {
        "records": records,
        "source_type": kind,
        "rows_read": rows_read,
        "rows_used": len(records),
        "columns": [str(c) for c in df.columns],
        "dated": dated,
    }


def parse_csv(content: bytes) -> List[Dict[str, Any]]:
    """Backwards-compatible helper for the original CSV-only path."""
    return parse_cost_file(content, "upload.csv")["records"]
