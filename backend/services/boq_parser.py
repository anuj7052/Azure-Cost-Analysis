"""
Parse an Azure Pricing Calculator estimate (a "BOQ") into budget line items.

The export is not a table — it is a report. A title block sits above the real
header row, subtotal rows sit below the items, and the currency is only stated
in a disclaimer sentence at the bottom. Amounts arrive pre-formatted for the
customer's locale ("? 41,668.64" when the rupee sign was lost to encoding), so
they have to be stripped back down to numbers.
"""

import io
import re
from typing import Any, Dict, List

import pandas as pd

BOQ_EXTENSIONS = (".csv", ".xlsx", ".xlsm", ".xls")

# Columns of the estimate grid, in export order.
HEADER_FIRST_CELL = "service category"
_EXPECTED_HEADERS = ("service category", "service type", "region", "description")

# Rows that close out the estimate rather than describing a resource.
_SUBTOTAL_LABELS = {
    "infrastructure subtotal": "infrastructure_subtotal",
    "managed services": "managed_services",
    "support": "support",
    "total monthly cost": "total_monthly",
    "upfront cost": "upfront_cost",
}

_CURRENCY_HINT = re.compile(r"all prices shown are in .*?\b([A-Z]{3})\b", re.IGNORECASE)
_AMOUNT_CHARS = re.compile(r"[^0-9.,\-]")

# Windows-1252 punctuation that survives a latin-1 decode as control characters.
_CP1252_FIXES = {
    0x91: "'", 0x92: "'", 0x93: '"', 0x94: '"',
    0x95: "\u2022", 0x96: "\u2013", 0x97: "\u2014", 0x85: "\u2026",
}


def _clean(value: Any) -> str:
    if value is None:
        return ""
    text = str(value).strip()
    if text.lower() in {"nan", "none"}:
        return ""
    # Estimates are often served as Windows-1252 but read as latin-1, which turns
    # dashes and curly quotes into control characters. Put them back.
    return text.translate(_CP1252_FIXES)


def _to_amount(value: Any):
    """Turn "? 41,668.64" / "₹1,234.50" / "1 234,50" into a float, or None."""
    text = _clean(value)
    if not text:
        return None
    stripped = _AMOUNT_CHARS.sub("", text)
    if not stripped or stripped in {"-", ".", ","}:
        return None
    # A comma is a decimal separator only when no dot is present and it is
    # followed by exactly two digits ("1 234,50"); otherwise it groups thousands.
    if "." in stripped:
        stripped = stripped.replace(",", "")
    elif re.search(r",\d{2}$", stripped):
        stripped = stripped.replace(".", "").replace(",", ".")
    else:
        stripped = stripped.replace(",", "")
    try:
        return float(stripped)
    except ValueError:
        return None


def _read_grid(content: bytes, filename: str) -> pd.DataFrame:
    """Read the file with no header, so the title block does not become columns."""
    if filename.lower().endswith((".xlsx", ".xlsm", ".xls")):
        book = pd.read_excel(io.BytesIO(content), dtype=str, header=None, sheet_name=None)
        # Estimates are single-sheet, but pick the sheet with the header row if not.
        for frame in book.values():
            if frame.astype(str).apply(
                lambda col: col.str.strip().str.lower().eq(HEADER_FIRST_CELL)
            ).any().any():
                return frame
        return next(iter(book.values()))

    for encoding in ("utf-8-sig", "utf-16", "latin-1"):
        try:
            return pd.read_csv(
                io.BytesIO(content), dtype=str, header=None,
                encoding=encoding, sep=None, engine="python",
                skip_blank_lines=False, on_bad_lines="skip",
            )
        except (UnicodeDecodeError, UnicodeError):
            continue
    raise ValueError("Could not read the file — unrecognised text encoding.")


def parse_boq_file(content: bytes, filename: str) -> Dict[str, Any]:
    """
    Extract the budget line items and totals from an Azure estimate.

    Returns the estimate name, currency, per-line monthly costs and the
    subtotals, so the client can compare planned spend against real usage.
    """
    grid = _read_grid(content, filename)
    if grid.empty:
        raise ValueError("The file is empty.")

    rows: List[List[str]] = [[_clean(v) for v in row] for row in grid.values.tolist()]

    header_idx = next(
        (i for i, row in enumerate(rows) if row and row[0].lower() == HEADER_FIRST_CELL),
        None,
    )
    if header_idx is None:
        raise ValueError(
            "This does not look like an Azure Pricing Calculator estimate — no "
            "'Service category' header row was found."
        )

    header = [c.lower() for c in rows[header_idx]]
    missing = [h for h in _EXPECTED_HEADERS if h not in header]
    if missing:
        raise ValueError(f"The estimate is missing the column(s): {', '.join(missing)}")

    col = {name: header.index(name) for name in _EXPECTED_HEADERS if name in header}
    name_col = header.index("custom name") if "custom name" in header else None
    # The amount sits in the first unnamed column after Description.
    amount_col = col["description"] + 1

    # The estimate name is the last non-empty line above the header.
    title = next(
        (
            r[0] for r in reversed(rows[:header_idx])
            if r and r[0] and r[0].lower() != "microsoft azure estimate"
        ),
        "",
    )

    def cell(row: List[str], index) -> str:
        return row[index] if index is not None and index < len(row) else ""

    items: List[Dict[str, Any]] = []
    totals: Dict[str, float] = {}

    for row in rows[header_idx + 1:]:
        if not any(row):
            continue

        # Subtotal rows carry their label in one of the inner columns, and may be
        # preceded by unrelated text ("Disclaimer" shares the Total Monthly Cost
        # row). Skip the first two columns so a real line item whose service
        # category is "Support" is not mistaken for the support subtotal.
        key = next(
            (_SUBTOTAL_LABELS[c.lower()] for c in row[2:amount_col] if c.lower() in _SUBTOTAL_LABELS),
            None,
        )
        if key:
            amount = next(
                (a for a in (_to_amount(c) for c in row[amount_col:]) if a is not None),
                None,
            )
            if amount is not None:
                totals[key] = amount
            continue

        category, service_type = cell(row, col["service category"]), cell(row, col["service type"])
        amount = _to_amount(cell(row, amount_col))
        if not category or not service_type or amount is None:
            continue

        items.append({
            "service_category": category,
            "service_type": service_type,
            "custom_name": cell(row, name_col),
            "region": cell(row, col["region"]),
            "description": cell(row, col["description"]),
            "monthly_cost": round(amount, 2),
        })

    if not items:
        raise ValueError("No priced line items were found in the estimate.")

    joined = " ".join(" ".join(r) for r in rows[header_idx:])
    currency_match = _CURRENCY_HINT.search(joined)
    currency = currency_match.group(1).upper() if currency_match else "INR"

    items_total = round(sum(i["monthly_cost"] for i in items), 2)

    return {
        "name": title or filename,
        "file_name": filename,
        "currency": currency,
        "items": items,
        "items_total": items_total,
        "infrastructure_subtotal": totals.get("infrastructure_subtotal"),
        "managed_services": totals.get("managed_services"),
        "support": totals.get("support"),
        # Fall back to the sum of the lines when the export omits the total row.
        "total_monthly": totals.get("total_monthly", items_total),
    }
