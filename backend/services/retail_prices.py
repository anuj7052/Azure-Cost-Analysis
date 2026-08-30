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
import time
from typing import Any, Dict, Iterable, List, Optional

import httpx

from services import azure_retry

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


class PriceCache:
    """
    A small time-boxed cache for published retail rates.

    Azure's public pricing endpoint is slow and unauthenticated, and it was
    being re-queried on every page load and every resize preview even though
    list prices change on the order of months. On an estate large enough to
    need several regions, those round-trips were a real part of the
    60-second budget the whole request has — the Compute page timed out
    outright once a second lookup was added.

    Deliberately holds nothing tenant-specific: these are published list
    prices, identical for every customer, so there is nothing here that could
    leak between accounts. Cost, quota and telemetry are never cached — those
    are per-customer and must be read fresh on every request.
    """

    TTL_SECONDS = 6 * 60 * 60
    MAX_ENTRIES = 64

    def __init__(self) -> None:
        self._entries: Dict[Any, tuple] = {}

    def get(self, key: Any) -> Optional[Any]:
        entry = self._entries.get(key)
        if entry is None:
            return None
        stored_at, value = entry
        if time.monotonic() - stored_at > self.TTL_SECONDS:
            self._entries.pop(key, None)
            return None
        return value

    def put(self, key: Any, value: Any) -> None:
        if len(self._entries) >= self.MAX_ENTRIES:
            oldest = min(self._entries, key=lambda k: self._entries[k][0])
            self._entries.pop(oldest, None)
        self._entries[key] = (time.monotonic(), value)

    def clear(self) -> None:
        self._entries.clear()


# Shared by the fleet page and the resize review, so opening a review straight
# after loading the fleet reuses the rates the fleet already paid for.
price_cache = PriceCache()


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


def vm_sku_filter(skus: Iterable[str], region: str) -> str:
    """
    An OData filter matching several VM sizes in one region.

    Written as a chain of `or` clauses rather than `armSkuName in (...)`.
    That reads like valid OData and every reference to the `in` operator says
    it should work, but the Retail Prices service rejects it outright with
    `400 Invalid OData parameters supplied` — verified against the live public
    endpoint. Because the caller treated any failure as "no price available",
    the entire application silently reported that Azure publishes no price for
    any VM size, and every right-sizing saving came out blank.
    """
    names = sorted({(s or "").strip() for s in skus if (s or "").strip()})
    if not names or not region:
        return ""
    clause = " or ".join(f"armSkuName eq '{_quote(n)}'" for n in names)
    return (
        f"serviceName eq 'Virtual Machines' "
        f"and armRegionName eq '{_quote(region)}' "
        f"and type eq 'Consumption' and ({clause})"
    )


def best_vm_rates(
    items: Iterable[Dict[str, Any]], windows: bool
) -> Dict[str, float]:
    """
    The lowest on-demand hourly rate per size, keyed lower-case.

    Three kinds of meter are refused rather than ranked:

      - **Spot and low-priority.** They are 4-5x cheaper and can be evicted at
        any moment. Quoting one as the price of a VM would invent a saving that
        only exists for a workload that tolerates being killed.
      - **The wrong operating system.** A Windows meter carries the licence and
        costs roughly 2.5x the Linux rate for the same silicon. Comparing a
        Windows current price against a Linux target price produces a saving
        that is arithmetic on two different products.
      - **Cloud Services.** Microsoft publishes the classic Cloud Services
        meters under the same `armSkuName`, at the Windows rate. They are not
        virtual machines, and letting them into the pool skews the minimum.

    Keys are lower-cased because Resource Graph, Cost Management and the
    pricing catalogue each capitalise `Standard_D4as_v5` differently, and an
    exact-match lookup loses the row without saying so.
    """
    best: Dict[str, float] = {}
    for item in items:
        name = (item.get("arm_sku_name") or "").strip()
        if not name:
            continue
        meter = (item.get("meter_name") or "").lower()
        product = (item.get("product_name") or "").lower()
        if "spot" in meter or "low priority" in meter:
            continue
        if "cloud services" in product:
            continue
        if ("windows" in product) != windows:
            continue
        rate = item.get("retail_price")
        if not isinstance(rate, (int, float)) or rate <= 0:
            continue
        key = name.lower()
        if key not in best or rate < best[key]:
            best[key] = float(rate)
    return best


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
            # The Retail Prices API is public and unauthenticated, which makes
            # it throttled by source address: every region queried in parallel
            # shares one budget.
            page_url, page_params = url, (params if pages == 0 else None)
            response = await azure_retry.send_with_retry(
                lambda: client.get(page_url, params=page_params)
            )
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


# Azure Retail Prices rejects a filter with too many `or` clauses -- probing
# the live endpoint, 15 names are accepted and 20 are answered with
# "Invalid OData parameters supplied". Any list longer than that has to be
# asked for a different way, so a caller needing hundreds of sizes asks for
# the region instead of naming them. One region-wide query is eight pages and
# covers every VM in it, which is both faster and immune to the clause limit.
MAX_SKUS_PER_FILTER = 15

# Enough pages to cover the largest region's VM meters. Measured against
# centralindia: 8 pages, ~7,100 meters, ~1,460 distinct sizes.
REGION_MAX_PAGES = 12


def region_vm_filter(region: str) -> str:
    """Every pay-as-you-go virtual machine meter in one region."""
    if not region:
        return ""
    return (
        f"serviceName eq 'Virtual Machines' "
        f"and armRegionName eq '{_quote(region)}' "
        f"and type eq 'Consumption'"
    )


async def region_vm_rates(region: str, currency: str) -> Dict[bool, Dict[str, float]]:
    """
    The cheapest hourly rate for every VM size in a region, keyed by whether
    the meter carries a Windows licence.

    Only the two small rate maps are cached, never the seven thousand meters
    they were derived from -- caching the raw response would put a hundred
    megabytes of published prices in memory to answer a question about a few
    hundred sizes.

    An empty result means Azure did not answer, and callers must render that
    as "price not available". It never means the region is free.
    """
    odata = region_vm_filter(region)
    if not odata:
        return {False: {}, True: {}}

    key = (odata, currency, "region_rates")
    cached = price_cache.get(key)
    if cached is not None:
        return cached

    items = await fetch_prices(odata, currency=currency, max_pages=REGION_MAX_PAGES)
    rates = {
        False: best_vm_rates(items, windows=False),
        True: best_vm_rates(items, windows=True),
    }
    price_cache.put(key, rates)
    return rates
