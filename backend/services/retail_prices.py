"""
Microsoft's published Azure prices.

Source: https://prices.azure.com/api/retail/prices — the Azure Retail Prices
API, which is unauthenticated and is what the Pricing Calculator itself is
built on.

This exists to answer a question the billing data cannot: "is this rate normal?"
Cost Management reports what *you* were charged, which already includes any
discount, reservation or negotiated rate. Comparing that against Microsoft's
list price is what turns "this costs 8.43 an hour" into "list is 9.60, so you
are paying 12% under".

Two documented behaviours shape the code:

  * Microsoft prices everything in USD. Other currencies are returned for
    reference only, so a non-USD figure is an estimate rather than the rate the
    invoice is built from.
  * From API version 2023-01-01 the filter values are **case sensitive**, so
    'Virtual Machines' matches and 'virtual machines' does not.
"""
import logging
from typing import Any, Dict, List, Optional

import httpx

PRICES_URL = "https://prices.azure.com/api/retail/prices"

# The preview version is backward compatible and is the only one that returns
# savings-plan rates, which are needed to answer "what would committing save".
API_VERSION = "2023-01-01-preview"

# Microsoft's own page size. Following every page of an unfiltered query would
# walk hundreds of thousands of meters, so callers always filter.
PAGE_SIZE = 1000
MAX_PAGES = 5

log = logging.getLogger(__name__)


def _quote(value: str) -> str:
    """Escape a value for an OData string literal."""
    return str(value).replace("'", "''")


def build_filter(
    service_name: Optional[str] = None,
    arm_sku_name: Optional[str] = None,
    arm_region: Optional[str] = None,
    meter_name: Optional[str] = None,
    price_type: Optional[str] = "Consumption",
) -> str:
    """
    An OData filter for the fields Microsoft documents as filterable.

    `priceType` defaults to Consumption because that is the pay-as-you-go rate a
    bill is compared against. Reservation and savings-plan rates are different
    questions and are asked for explicitly.
    """
    clauses = []
    if service_name:
        clauses.append(f"serviceName eq '{_quote(service_name)}'")
    if arm_sku_name:
        clauses.append(f"armSkuName eq '{_quote(arm_sku_name)}'")
    if arm_region:
        clauses.append(f"armRegionName eq '{_quote(arm_region)}'")
    if meter_name:
        clauses.append(f"meterName eq '{_quote(meter_name)}'")
    if price_type:
        clauses.append(f"priceType eq '{_quote(price_type)}'")

    return " and ".join(clauses)


def normalise(item: Dict[str, Any]) -> Dict[str, Any]:
    """One published price, reduced to the fields worth comparing against."""
    return {
        # Microsoft's stable identity for a meter. Names get reworded and
        # regions get renamed, so anything tracking a price over time has to key
        # on this or it will read a rename as a price change.
        "meter_id": item.get("meterId", ""),
        "sku_id": item.get("skuId", ""),
        "product_id": item.get("productId", ""),
        "meter_name": item.get("meterName", ""),
        "sku_name": item.get("skuName", ""),
        "arm_sku_name": item.get("armSkuName", ""),
        "product_name": item.get("productName", ""),
        "service_name": item.get("serviceName", ""),
        "service_family": item.get("serviceFamily", ""),
        "region": item.get("armRegionName", ""),
        "location": item.get("location", ""),
        "unit_of_measure": item.get("unitOfMeasure", ""),
        "retail_price": item.get("retailPrice"),
        "unit_price": item.get("unitPrice"),
        "currency": item.get("currencyCode", "USD"),
        "price_type": item.get("type", ""),
        "reservation_term": item.get("reservationTerm"),
        # Present only on the preview version, and only for eligible meters.
        "savings_plans": [
            {"term": p.get("term"), "unit_price": p.get("unitPrice")}
            for p in (item.get("savingsPlan") or [])
        ],
        "effective_from": item.get("effectiveStartDate"),
    }


async def fetch_raw_prices(
    odata_filter: str,
    currency: str = "USD",
    max_pages: int = MAX_PAGES,
    timeout: float = 30.0,
) -> List[Dict[str, Any]]:
    """
    Read published prices for a filter, exactly as Microsoft returned them.

    Kept separate from `fetch_prices` because the price history store writes the
    untouched response. Microsoft has no history endpoint — a reading not
    recorded verbatim today cannot be recovered tomorrow, and a field we chose
    not to normalise is a field no future question can be asked about.

    Paging is capped. An over-broad filter can return hundreds of thousands of
    meters, and walking all of them to display a handful helps nobody — the
    caller narrows the filter instead.
    """
    if not odata_filter:
        # An unfiltered read is a request for Microsoft's entire price list.
        # Refusing is friendlier than appearing to hang.
        raise ValueError("A filter is required: an unfiltered price query is unbounded.")

    params = {"api-version": API_VERSION, "$filter": odata_filter}
    if currency and currency.upper() != "USD":
        params["currencyCode"] = currency.upper()

    items: List[Dict[str, Any]] = []
    async with httpx.AsyncClient(timeout=timeout) as client:
        url: Optional[str] = PRICES_URL
        pages = 0

        while url and pages < max_pages:
            response = await client.get(url, params=params if pages == 0 else None)
            response.raise_for_status()
            payload = response.json()

            items.extend(payload.get("Items", []))
            url = payload.get("NextPageLink")
            pages += 1

    return items


async def fetch_prices(
    odata_filter: str,
    currency: str = "USD",
    max_pages: int = MAX_PAGES,
    timeout: float = 30.0,
) -> List[Dict[str, Any]]:
    """Published prices for a filter, reduced to the fields worth comparing."""
    raw = await fetch_raw_prices(
        odata_filter, currency=currency, max_pages=max_pages, timeout=timeout
    )
    return [normalise(i) for i in raw]


def cheapest(prices: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """
    The lowest published price in a result set.

    Azure lists several meters for the same size — Windows and Linux, spot and
    standard — so a set is rarely one number. The lowest is the honest baseline
    for "what could this cost", and the caller shows the meter name alongside it
    so nobody compares a Linux rate against a Windows bill.
    """
    priced = [p for p in prices if p.get("retail_price") is not None]
    return min(priced, key=lambda p: p["retail_price"]) if priced else None


def compare_to_list(actual_rate: Optional[float], list_rate: Optional[float]) -> Dict[str, Any]:
    """
    How an effective rate compares to the published one.

    Returns nothing rather than guessing when either side is missing: a
    percentage against an unknown baseline is a number with no meaning, and it
    would be read as a discount that may not exist.
    """
    if actual_rate is None or list_rate is None or list_rate == 0:
        return {"difference": None, "percent": None, "verdict": "unknown"}

    difference = actual_rate - list_rate
    percent = difference / list_rate * 100

    if abs(percent) < 1:
        verdict = "at_list"
    elif percent < 0:
        verdict = "below_list"
    else:
        verdict = "above_list"

    return {
        "difference": round(difference, 6),
        "percent": round(percent, 2),
        "verdict": verdict,
    }
