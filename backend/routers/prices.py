"""
Microsoft's published prices, and why they differ from what you were billed.

Read-only against a public Microsoft API, so nothing here touches a tenant's
credentials or data. It answers "is this rate normal", which the billing data
alone cannot.

Every unit rate in this app is *effective*: the cost Azure billed divided by the
quantity it billed. Microsoft's pricing calculator shows something different —
a list price, in a currency it converted from dollars. The two rarely match, and
without an account of why, the gap gets read as an error in whichever number the
reader trusts less.

There are only a few honest explanations, and this separates them:

  * the exchange rate moved, and the dollar price did not;
  * Microsoft actually repriced the meter;
  * the account has a discount, reservation or negotiated rate;
  * the meters are not the same one (a Windows rate against a Linux bill).

The last is the trap. A confident comparison between two different meters is
worse than no comparison, so the meter that was matched is always named, and how
well it matched is stated rather than implied.
"""
from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional
from urllib.parse import quote_plus

import aiosqlite
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from auth.dependencies import get_current_user
from core.db import get_db
from models.schemas import RetailPriceResponse
from services import fx_rates, price_history
from services.azure_errors import azure_error
from services.retail_prices import (
    build_filter,
    cheapest,
    compare_to_list,
    fetch_raw_prices,
    normalise,
)

router = APIRouter(prefix="/api/prices", tags=["prices"])

log = logging.getLogger(__name__)

CALCULATOR_URL = "https://azure.microsoft.com/pricing/calculator/"
PRICES_API_URL = "https://prices.azure.com/api/retail/prices"


@router.get("", response_model=RetailPriceResponse)
async def get_retail_prices(
    service_name: Optional[str] = Query(None, description="e.g. Virtual Machines"),
    arm_sku_name: Optional[str] = Query(None, description="e.g. Standard_D2s_v3"),
    arm_region: Optional[str] = Query(None, description="e.g. eastus"),
    meter_name: Optional[str] = Query(None),
    price_type: str = Query("Consumption", description="Consumption | Reservation"),
    currency: str = Query("USD"),
    current_user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    """
    Microsoft's list prices for a service, SKU or region.

    Filter values are case sensitive from API version 2023-01-01 onwards, so
    'Virtual Machines' matches and 'virtual machines' returns nothing. That is
    Microsoft's behaviour, not ours, and passing the value through unchanged is
    what lets a caller reproduce the same query against their documentation.

    Everything returned is also written to the price history store. Microsoft
    publishes no history, so a reading not kept today cannot be recovered later
    — and the cheapest moment to record a price is the moment it was already
    being fetched for another reason.
    """
    odata = build_filter(
        service_name=service_name,
        arm_sku_name=arm_sku_name,
        arm_region=arm_region,
        meter_name=meter_name,
        price_type=price_type,
    )

    if not odata:
        raise HTTPException(
            status_code=400,
            detail=(
                "At least one filter is required. Microsoft's price list runs to "
                "hundreds of thousands of meters, so an unfiltered query is unbounded."
            ),
        )

    try:
        raw = await fetch_raw_prices(odata, currency=currency)
    except Exception as exc:
        raise azure_error(exc, "Microsoft's published prices")

    prices = [normalise(item) for item in raw]
    await price_history.record_prices(db, prices, raw)

    lowest = cheapest(prices)

    return RetailPriceResponse(
        prices=prices,
        count=len(prices),
        cheapest=lowest,
        currency=(lowest or {}).get("currency", currency.upper()),
        odata_filter=odata,
        # Microsoft prices in USD; anything else is their conversion for
        # reference, not the rate an invoice is built from.
        is_reference_currency=currency.upper() != "USD",
    )


# ── Matching a billed meter to a published one ─────────────────────────────
#
# This used to score every candidate and return the highest, which meant a
# billed line always got *an* answer — including a Windows meter in Switzerland
# quoted against a Linux VM in India, labelled "close match". Scoring cannot
# express "none of these is the same thing", and that is the answer more often
# than it looks.
#
# So the rules below are pass/fail, not weighted. Region, SKU and OS variant
# either agree or the candidate is out, and if nothing survives the panel says
# so and shows what it rejected. A named non-answer is worth more than a
# confident wrong one, because only the wrong one gets repeated to a customer.

# Variants that are separate meters answering a different question. A Windows
# rate includes a licence a Linux bill never carried; a Spot rate is a different
# market entirely. Matching one to the other manufactures a discount or a
# premium that does not exist.
_VARIANTS = ("windows", "spot", "low priority")

# Words that appear in nearly every meter name and so carry no evidence that two
# meters are the same one.
_STOPWORDS = {"the", "and", "per", "of", "for", "unit", "units"}


def _norm(value: Any) -> str:
    return str(value or "").strip().lower()


def _tokens(text: str) -> set:
    raw = _norm(text).replace("/", " ").replace("-", " ").replace("_", " ").split()
    return {t for t in raw if t and t not in _STOPWORDS}


def _variants_in(text: str) -> set:
    """Which variant markers a name carries."""
    name = _norm(text)
    return {marker for marker in _VARIANTS if marker in name}


def _unit_family(unit: str) -> str:
    """
    A unit of measure reduced to what it actually meters.

    Microsoft writes "1 Hour", Cost Management writes "10 Hours", and the same
    meter can be quoted per 1 GB or per 100 GB. The multiplier is a scaling
    difference worth flagging, but the *dimension* is what decides whether two
    numbers are even comparable.
    """
    words = [w for w in _norm(unit).replace("/", " ").split() if not w.isdigit()]
    if not words:
        return ""
    return words[0].rstrip("s")


def _unit_multiplier(unit: str) -> float:
    """
    The count a unit of measure is quoted in: 1 for "1 Hour", 10 for "10 Hours".

    Ignoring this is a silent factor-of-ten error in the gap between billed and
    list — the two rates are both correct and still not comparable until one is
    rescaled to the other.
    """
    for word in _norm(unit).replace("/", " ").split():
        if word.replace(".", "", 1).isdigit():
            try:
                value = float(word)
            except ValueError:
                continue
            if value > 0:
                return value
    return 1.0


def _check(label: str, wanted: Any, got: Any, ok: Optional[bool], note: str = "") -> Dict[str, Any]:
    return {
        "field": label,
        "wanted": wanted or "",
        "got": got or "",
        # None means the billed line did not carry this field, so nothing was
        # proven either way — reported honestly rather than counted as a pass.
        "state": "match" if ok else ("unknown" if ok is None else "differs"),
        "note": note,
    }


def _inspect(
    candidate: Dict[str, Any],
    *,
    meter_name: str,
    sku: str,
    region: str,
    unit: str,
) -> Dict[str, Any]:
    """
    Compare one published meter against the billed line, field by field.

    Returns the full checklist plus whether anything disqualifying was found, so
    the client can show *why* a meter was accepted or rejected instead of asking
    the reader to trust a confidence label.
    """
    checks: List[Dict[str, Any]] = []
    blockers: List[str] = []

    # ── Region ──
    cand_region = candidate.get("region") or candidate.get("location") or ""
    if region:
        ok = _norm(cand_region) == _norm(region)
        checks.append(_check("Region", region, cand_region, ok))
        if not ok:
            blockers.append(
                f"published for {cand_region or 'another region'}, billed in {region}"
            )
    else:
        checks.append(_check(
            "Region", "", cand_region, None,
            "The billed line carries no region, so this was not verified.",
        ))

    # ── SKU ──
    cand_sku = candidate.get("arm_sku_name") or ""
    if sku:
        ok = _norm(cand_sku) == _norm(sku)
        checks.append(_check("SKU", sku, cand_sku, ok))
        if not ok:
            blockers.append(f"SKU {cand_sku or 'unnamed'} is not {sku}")
    else:
        checks.append(_check("SKU", "", cand_sku, None, "No SKU on the billed line."))

    # ── OS / purchase variant ──
    wanted_variants = _variants_in(f"{meter_name} {sku}")
    got_variants = _variants_in(
        f"{candidate.get('meter_name', '')} {candidate.get('sku_name', '')} "
        f"{candidate.get('product_name', '')}"
    )
    extra = got_variants - wanted_variants
    missing = wanted_variants - got_variants
    checks.append(_check(
        "Variant",
        ", ".join(sorted(wanted_variants)) or "standard (no Windows / Spot marker)",
        ", ".join(sorted(got_variants)) or "standard",
        not (extra or missing),
        "A Windows meter carries a licence, and a Spot meter is a different market."
        if (extra or missing) else "",
    ))
    if extra:
        blockers.append(f"this is a {', '.join(sorted(extra))} meter and the billed line is not")
    if missing:
        blockers.append(
            f"the billed line is a {', '.join(sorted(missing))} meter and this one is not"
        )

    # ── Meter name ──
    wanted_tokens = _tokens(meter_name)
    got_tokens = _tokens(candidate.get("meter_name", "")) | _tokens(candidate.get("sku_name", ""))
    exact_name = bool(meter_name) and _norm(candidate.get("meter_name")) == _norm(meter_name)
    if wanted_tokens:
        overlap = len(wanted_tokens & got_tokens) / len(wanted_tokens)
        ok = exact_name or overlap >= 0.6
        checks.append(_check(
            "Meter", meter_name, candidate.get("meter_name", ""), ok,
            "" if exact_name else f"{round(overlap * 100)}% of the billed meter's words matched.",
        ))
        if not ok:
            blockers.append(f"meter '{candidate.get('meter_name')}' does not name the same thing")
    else:
        checks.append(_check(
            "Meter", "", candidate.get("meter_name", ""), None, "No meter name on the billed line.",
        ))

    # ── Unit of measure ──
    cand_unit = candidate.get("unit_of_measure") or ""
    if unit:
        ok = _unit_family(cand_unit) == _unit_family(unit)
        scale = _unit_multiplier(unit) / _unit_multiplier(cand_unit)
        checks.append(_check(
            "Unit", unit, cand_unit, ok,
            ("" if scale == 1 else
             f"Quoted per {_unit_multiplier(cand_unit):g} and billed per {_unit_multiplier(unit):g} — "
             f"the list price is scaled by {scale:g} before the two are compared.")
            if ok else "The two rates are per different things and cannot be subtracted.",
        ))
        if not ok:
            blockers.append(f"priced per {cand_unit or 'an unknown unit'}, billed per {unit}")
    else:
        scale = 1.0
        checks.append(_check("Unit", "", cand_unit, None, "No unit on the billed line."))

    verified = sum(1 for c in checks if c["state"] == "match")
    return {
        "checks": checks,
        "blockers": blockers,
        "qualified": not blockers,
        "verified": verified,
        "unverified": sum(1 for c in checks if c["state"] == "unknown"),
        "exact_name": exact_name,
        # What the published price must be multiplied by to sit on the billed
        # line's unit.
        "unit_scale": scale,
    }


def _summarise_rejection(candidate: Dict[str, Any], verdict: Dict[str, Any]) -> Dict[str, Any]:
    """A rejected candidate, with the reason it was rejected, for display."""
    return {
        "meter_name": candidate.get("meter_name"),
        "product_name": candidate.get("product_name"),
        "arm_sku_name": candidate.get("arm_sku_name"),
        "region": candidate.get("region"),
        "unit_of_measure": candidate.get("unit_of_measure"),
        "retail_price": candidate.get("retail_price"),
        "currency": candidate.get("currency"),
        "meter_id": candidate.get("meter_id"),
        "why_not": verdict["blockers"],
    }


def _resolve_unstated(
    checks: List[Dict[str, Any]], qualified: List[tuple], chosen: Dict[str, Any]
) -> None:
    """
    Fill in the fields the billed line never carried, where Microsoft's own
    catalogue leaves nothing to decide.

    Cost Management groups usage by service, resource group and meter — three
    dimensions is its limit — so a live row carries no SKU and no unit of
    measure. Reporting those as "not on the billed line" and stopping is
    accurate and useless: if every published meter that survived matching agrees
    on the SKU, then the SKU is known, and refusing to say so helps nobody.

    Where the candidates *disagree*, nothing is filled in. That is a real
    ambiguity and inventing a value would put the panel back in the business of
    guessing, which is what it exists not to do.
    """
    for check in checks:
        if check["state"] != "unknown":
            continue

        field = "arm_sku_name" if check["field"] == "SKU" else (
            "unit_of_measure" if check["field"] == "Unit" else (
                "region" if check["field"] == "Region" else None
            )
        )
        if not field:
            continue

        values = {
            (c.get(field) or "").strip()
            for c, _ in qualified
            if (c.get(field) or "").strip()
        }
        if len(values) != 1:
            continue

        value = values.pop()
        check["state"] = "resolved"
        check["got"] = value
        check["note"] = (
            f"Not billed as a separate field. Every published meter that matched "
            f"({len(qualified)}) carries the same value, so there is nothing to "
            f"disambiguate."
        )
        chosen.setdefault("resolved", {})[check["field"]] = value


def _match_published(
    candidates: List[Dict[str, Any]],
    *,
    meter_name: str,
    sku: str,
    region: str,
    unit: str,
) -> Dict[str, Any]:
    """
    The published meter that *is* the billed one, or an account of why there
    isn't one.

    Two outcomes are deliberately kept apart. "No candidate passed" means the
    published price for this line was not found. "Several passed but they are
    priced differently" means it was found more than once — Azure prices per
    region, so without a region on the billed line there is no single right
    answer, and picking one at random is how a comparison ends up quoting
    Switzerland at a customer in India.
    """
    priced = [c for c in candidates if c.get("retail_price") is not None]
    if not priced:
        return {
            "published": None,
            "reason": "Microsoft published no priced meter for this filter.",
            "checks": [],
            "rejected": [],
            "regions": [],
        }

    qualified: List[tuple] = []
    rejected: List[Dict[str, Any]] = []

    for candidate in priced:
        verdict = _inspect(candidate, meter_name=meter_name, sku=sku, region=region, unit=unit)
        if verdict["qualified"]:
            qualified.append((candidate, verdict))
        else:
            rejected.append(_summarise_rejection(candidate, verdict))

    if not qualified:
        # Show the closest rejections rather than all of them: a list of two
        # hundred near misses is not evidence, it is noise.
        rejected.sort(key=lambda r: len(r["why_not"]))
        return {
            "published": None,
            "reason": (
                "No published meter matched this line on region, SKU, meter name and unit "
                "together, so there is nothing safe to quote against it."
            ),
            "checks": [],
            "rejected": rejected[:6],
            "regions": [],
            "considered": len(priced),
        }

    # Regional prices differ. Report the spread rather than resolving it by luck.
    by_region = {}
    for candidate, _ in qualified:
        by_region.setdefault(candidate.get("region") or "", candidate.get("retail_price"))
    distinct_prices = {round(float(p), 10) for p in by_region.values() if p is not None}

    if not region and len(distinct_prices) > 1:
        regions = sorted(
            ({"region": r, "retail_price": p} for r, p in by_region.items() if r),
            key=lambda r: r["retail_price"],
        )
        return {
            "published": None,
            "reason": (
                "This line has no region on it, and Microsoft prices this meter differently "
                "in each region. Pick the region the resource runs in and the exact published "
                "price will be shown."
            ),
            "checks": [],
            "rejected": [],
            "regions": regions,
            "considered": len(priced),
        }

    # Prefer the most fully verified candidate, then an exact meter name, then
    # the lowest price — the last only ever breaks a tie between meters already
    # proven to be the same thing.
    candidate, verdict = max(
        qualified,
        key=lambda cv: (cv[1]["verified"], cv[1]["exact_name"], -(cv[0].get("retail_price") or 0)),
    )

    best = dict(candidate)
    best["match_confidence"] = "exact" if verdict["unverified"] == 0 else "close"
    best["verified_fields"] = verdict["verified"]
    best["unverified_fields"] = verdict["unverified"]
    # The published rate restated on the billed line's unit, so the gap below is
    # a like-for-like subtraction rather than a factor-of-ten surprise.
    best["comparable_price"] = (
        None if candidate.get("retail_price") is None
        else round(float(candidate["retail_price"]) * verdict["unit_scale"], 10)
    )
    best["unit_scale"] = verdict["unit_scale"]

    checks = verdict["checks"]
    _resolve_unstated(checks, qualified, best)
    # Anything resolved from the catalogue is settled, so "partly verified" no
    # longer applies to it.
    best["unverified_fields"] = sum(1 for c in checks if c["state"] == "unknown")
    best["match_confidence"] = "exact" if best["unverified_fields"] == 0 else "close"

    # Meters that passed every check and are still priced differently — usually
    # the same size offered under a second product ("Dasv5 Series Cloud
    # Services" alongside "Virtual Machines Dasv5 Series"). One of them was
    # picked on price, which is a tiebreak and not evidence, so the others are
    # named instead of quietly dropped.
    alternatives = [
        {
            "meter_name": c.get("meter_name"),
            "product_name": c.get("product_name"),
            "region": c.get("region"),
            "retail_price": c.get("retail_price"),
            "currency": c.get("currency"),
            "unit_of_measure": c.get("unit_of_measure"),
            "meter_id": c.get("meter_id"),
        }
        for c, _ in qualified
        if c.get("meter_id") != candidate.get("meter_id")
        and c.get("retail_price") != candidate.get("retail_price")
    ]

    return {
        "published": best,
        "reason": "",
        "checks": checks,
        "alternatives": alternatives[:4],
        "rejected": rejected[:4],
        "regions": (
            [] if region or len(distinct_prices) <= 1
            else sorted(({"region": r, "retail_price": p} for r, p in by_region.items() if r),
                        key=lambda r: r["retail_price"])
        ),
        "considered": len(priced),
        "same_price_regions": len(by_region) if not region else 0,
    }


def _verification_links(
    service_name: str, sku: str, currency: str, odata: str
) -> List[Dict[str, str]]:
    """
    Where to check every claim on the panel, at its source.

    A derived number nobody can verify is worth very little in a conversation
    about an invoice, and "trust us" is not an answer a customer can take to
    their finance team.
    """
    links = [
        {
            "label": "Azure Pricing Calculator",
            "url": CALCULATOR_URL,
            "note": "Microsoft's own list prices. Pick the same region and currency to compare like for like.",
        },
        {
            "label": "Retail Prices API — this exact query",
            "url": f"{PRICES_API_URL}?api-version=2023-01-01-preview&$filter={quote_plus(odata)}"
                   + (f"&currencyCode={currency.upper()}" if currency.upper() != "USD" else ""),
            "note": "The unauthenticated Microsoft endpoint this page read. Open it and you get the same JSON.",
        },
        {
            "label": "Retail Prices API documentation",
            "url": "https://learn.microsoft.com/rest/api/cost-management/retail-prices/azure-retail-prices",
            "note": "Field meanings, and Microsoft's statement that all Azure prices are set in USD.",
        },
    ]

    if service_name:
        links.append({
            "label": f"{service_name} pricing page",
            "url": f"https://azure.microsoft.com/pricing/details/?search={quote_plus(service_name)}",
            "note": "Microsoft's published page for this service, including any pricing notes.",
        })
    if sku:
        links.append({
            "label": f"{sku} specification",
            "url": f"https://learn.microsoft.com/azure/virtual-machines/sizes?search={quote_plus(sku)}",
            "note": "Confirm the size being compared is the size that is running.",
        })

    return links


# ─────────────────────────── the currency question ───────────────────────────
#
# Microsoft sets every Azure price in US dollars. Every other currency on an
# invoice or in the pricing calculator is that dollar price multiplied by a rate
# — and crucially, *not the market rate, and not the same rate in both places*:
#
#   * the **invoice** uses the exchange rate Microsoft fixed for that billing
#     month, published in the billing account and unchanged for the whole month;
#   * the **Retail Prices API** converts at a rate Microsoft applies to the
#     catalogue, which moves on its own schedule;
#   * the **market** rate on any given day is a third number again.
#
# The gap between the first two and the third is not small. Checked against live
# Microsoft data: Standard_D4as_v5 in centralindia is published at USD 0.111 and
# INR 10.61715 on the same day for the same meterId — an implied rate of 95.65
# when the market was near 84. That is a ~14% currency premium built into the
# non-USD price, and it is Microsoft's, not the customer's.
#
# The consequence matters more than the fact: converting an INR bill to dollars
# at the *market* rate and comparing it to the dollar list price invents a 14%
# overcharge that does not exist. So the conversion used here is Microsoft's
# own — derived by dividing their two published prices for the same meter — and
# the market rate is shown beside it as context rather than used as the basis.

# Below this, two rates are the same rate. Retail prices carry five decimals and
# the billed rate is a division of two rounded numbers, so exact equality never
# happens even when nothing is wrong.
SAME_PRICE_TOLERANCE = 0.005      # 0.5%


def _gap(billed: Optional[float], published: Optional[float]) -> Optional[float]:
    """Billed against published, as a signed fraction. Positive means paying more."""
    if billed is None or not published:
        return None
    return (billed - published) / published


def _currency_view(
    *,
    billed_rate: Optional[float],
    billing_currency: str,
    published_usd: Optional[float],
    published_local: Optional[float],
    market_fx: Optional[float],
) -> Dict[str, Any]:
    """
    The same comparison twice — once in dollars, once in the billing currency —
    reconciled through Microsoft's own conversion rate.

    The two views deliberately produce the *same* percentage gap. That is the
    point: a difference between them would be an artefact of picking a different
    exchange rate for each side, which is precisely the mistake this function
    exists to prevent. Changing the currency here changes the units the numbers
    are quoted in and nothing else.

    Three separate exchange rates are reported so the reader can see what is
    theirs and what is Microsoft's:

      * ``catalogue_fx`` — Microsoft's own, taken from their two published
        prices for the same meterId. Not an estimate; it is their arithmetic.
      * ``implied_fx`` — what the invoice divided by the dollar list price says
        the rate must have been. Equal to ``catalogue_fx`` when the line is on
        list, and different when it is not.
      * ``market_fx`` — the ECB reference rate for the month. Shown to expose
        the premium in the other two, never used to restate the bill.
    """
    is_usd = billing_currency.upper() == "USD"

    # Microsoft's own conversion, derived from their own two numbers. Preferred
    # over any market rate because it is the rate that actually produced the
    # published local price, so using it keeps both sides on one basis.
    catalogue_fx = None
    if published_usd and published_local:
        catalogue_fx = published_local / published_usd

    conversion = catalogue_fx or market_fx
    fx_basis = (
        "microsoft" if catalogue_fx else ("market" if market_fx else "none")
    )

    billed_usd = billed_rate if is_usd else (
        billed_rate / conversion if billed_rate is not None and conversion else None
    )

    usd_gap = _gap(billed_usd, published_usd)
    local_gap = _gap(billed_rate, published_local)
    # One basis, so the two views agree. Where the local price is missing the
    # dollar gap stands in, rather than leaving a hole the reader fills in.
    if local_gap is None:
        local_gap = usd_gap

    implied_fx = None
    if not is_usd and billed_rate is not None and published_usd:
        implied_fx = billed_rate / published_usd

    premium = None
    if catalogue_fx and market_fx:
        premium = (catalogue_fx - market_fx) / market_fx

    view = {
        "billing_currency": billing_currency.upper(),
        "is_usd": is_usd,
        "usd": {
            "billed_rate": billed_usd,
            "published_rate": published_usd,
            "gap": usd_gap,
            "gap_percent": round(usd_gap * 100, 4) if usd_gap is not None else None,
            "matches": usd_gap is not None and abs(usd_gap) <= SAME_PRICE_TOLERANCE,
            # A converted figure is an estimate; the dollar list price is not.
            # Saying which is which stops both being read as equally exact.
            "billed_is_converted": not is_usd,
            "fx_used": None if is_usd else conversion,
        },
        "billing": {
            "billed_rate": billed_rate,
            "published_rate": published_local,
            "gap": local_gap,
            "gap_percent": round(local_gap * 100, 4) if local_gap is not None else None,
            "matches": local_gap is not None and abs(local_gap) <= SAME_PRICE_TOLERANCE,
            "published_is_converted": not is_usd,
        },
        "catalogue_fx": round(catalogue_fx, 6) if catalogue_fx else None,
        "implied_fx": round(implied_fx, 6) if implied_fx else None,
        "market_fx": round(market_fx, 6) if market_fx else None,
        "fx_basis": fx_basis,
        # How much more than the market rate Microsoft charges for pricing in
        # this currency. A real, quantified cost of not billing in dollars.
        "fx_premium_percent": round(premium * 100, 3) if premium is not None else None,
    }
    view["verdict"] = _currency_verdict(view)
    return view


def _currency_verdict(view: Dict[str, Any]) -> Dict[str, str]:
    """
    Which of the four honest explanations this particular gap is.

    Ordered so the cheapest explanation is tested first. Currency costs nobody
    anything and explains most gaps; a discount and a reprice are real findings
    and should not be claimed while a conversion still accounts for the
    difference.
    """
    usd = view["usd"]
    currency = view["billing_currency"]

    if usd["published_rate"] is None:
        return {
            "code": "unknown",
            "headline": "No published dollar price to compare against",
            "detail": (
                "Microsoft's catalogue did not return a price that matches this billed "
                "line, so there is nothing to put the billed rate beside."
            ),
        }

    if usd["billed_rate"] is None:
        return {
            "code": "no-bill",
            "headline": "No billed rate for this line",
            "detail": "This line has no billed quantity, so it has no effective rate.",
        }

    if view["fx_basis"] == "market" and not view["is_usd"]:
        note = (
            f" Microsoft's own {currency} price for this meter could not be read, so the bill "
            f"was converted at the market rate instead. Microsoft normally converts at several "
            f"percent above market, so a small apparent premium here may be conversion rather "
            f"than money."
        )
    elif view["fx_premium_percent"] and abs(view["fx_premium_percent"]) >= 1:
        note = (
            f" Both figures are on Microsoft's own conversion of {view['catalogue_fx']} "
            f"{currency} to the dollar — about {abs(view['fx_premium_percent']):.1f}% "
            f"{'above' if view['fx_premium_percent'] > 0 else 'below'} the market rate of "
            f"{view['market_fx']}. That premium applies to every {currency} figure equally, "
            f"so it does not affect the comparison."
        )
    else:
        note = ""

    usd_gap = usd["gap"] or 0.0
    percent = abs(round(usd_gap * 100, 1))

    if usd["matches"]:
        if view["is_usd"]:
            return {
                "code": "identical",
                "headline": "The billed rate is Microsoft's published rate",
                "detail": (
                    "Billed and published agree to within half a percent. This line is "
                    "on list price with no discount and no reservation applied."
                ),
            }
        return {
            "code": "identical",
            "headline": f"Same price — the two rates match once both are on one exchange rate",
            "detail": (
                f"Billed and published agree to within half a percent in dollars and in "
                f"{currency}. This line is on list price: nothing was repriced, and no "
                f"discount or reservation is applied.{note}"
            ),
        }

    if usd_gap < -SAME_PRICE_TOLERANCE:
        return {
            "code": "discount",
            "headline": f"Paying {percent}% below the published price",
            "detail": (
                f"The gap is the same in dollars and in {currency}, so it is not an "
                f"exchange-rate effect. Paying less than list normally means a reservation, "
                f"a savings plan, an Azure Hybrid Benefit, or a negotiated rate on the "
                f"agreement — none of which appear in the public catalogue.{note}"
            ),
        }

    return {
        "code": "above-list",
        "headline": f"Paying {percent}% above the published price",
        "detail": (
            f"The gap is the same in dollars and in {currency}, so it is not an exchange-rate "
            f"effect. Paying more than list usually means the matched meter is not the one being "
            f"billed — a different region, tier or OS — or that the billed line bundles charges "
            f"the single published meter does not cover. Check the field-by-field match below "
            f"before treating this as an overcharge.{note}"
        ),
    }


class RateExplainRequest(BaseModel):
    """A billed unit rate, and enough context to find its published equivalent."""
    service_name: str = Field(default="", max_length=200)
    meter_name: str = Field(default="", max_length=200)
    arm_sku_name: str = Field(default="", max_length=120)
    arm_region: str = Field(default="", max_length=80)
    currency: str = Field(default="USD", max_length=8)
    unit_of_measure: str = Field(default="", max_length=80)

    # The effective rate from billing: cost ÷ billed quantity.
    current_rate: Optional[float] = None
    previous_rate: Optional[float] = None
    # "YYYY-MM". Used to look up the exchange rate that applied at the time.
    current_month: str = Field(default="", max_length=7)
    previous_month: str = Field(default="", max_length=7)


@router.post("/explain")
async def explain_unit_rate(
    payload: RateExplainRequest,
    current_user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
) -> Dict[str, Any]:
    """
    Put the billed rate and Microsoft's published rate side by side, and account
    for the gap between them.

    Best effort throughout. Microsoft's price API is public and occasionally
    slow or unavailable, and a failure there still leaves the billed rate, the
    exchange rates and the stored price history — which is most of the answer.
    Returning nothing because one of four sources was down would be a worse
    trade than returning three of them and naming the one that is missing.
    """
    currency = (payload.currency or "USD").upper()
    odata = build_filter(
        service_name=payload.service_name or None,
        arm_sku_name=payload.arm_sku_name or None,
        arm_region=payload.arm_region or None,
        meter_name=payload.meter_name or None,
    )

    if not odata:
        raise HTTPException(
            status_code=400,
            detail="Give at least a service, SKU, region or meter name to look up.",
        )

    published: Optional[Dict[str, Any]] = None
    published_error: Optional[str] = None
    candidates: List[Dict[str, Any]] = []
    match: Dict[str, Any] = {}
    published_local: Optional[Dict[str, Any]] = None

    try:
        # Read the catalogue in **US dollars** whatever the billing currency is.
        # Microsoft sets every Azure price in USD and converts everything else,
        # so the dollar figure is the only one that is a price rather than a
        # price times somebody's exchange rate. Matching happens on this list
        # because it is the authoritative one; the billing-currency list is
        # fetched afterwards purely so the panel can show familiar numbers.
        raw = await fetch_raw_prices(odata, currency="USD", max_pages=2)
        candidates = [normalise(item) for item in raw]
        await price_history.record_prices(db, candidates, raw)
        match = _match_published(
            candidates,
            meter_name=payload.meter_name,
            sku=payload.arm_sku_name,
            region=payload.arm_region,
            unit=payload.unit_of_measure,
        )
        published = match.get("published")
    except Exception as exc:
        log.warning("Published price lookup failed: %s", exc)
        published_error = (
            "Microsoft's price list could not be read just now, so only the "
            "billed rate is shown."
        )

    # The same meter priced in the billing currency. Looked up by meterId rather
    # than matched again: the match has already been made and re-running it
    # against a second list risks the two views describing different meters.
    if published and currency != "USD":
        try:
            local_raw = await fetch_raw_prices(odata, currency=currency, max_pages=2)
            wanted_meter = published.get("meter_id")
            for item in (normalise(i) for i in local_raw):
                if item.get("meter_id") and item["meter_id"] == wanted_meter:
                    published_local = item
                    break
            if published_local:
                await price_history.record_prices(db, [published_local], local_raw)
        except Exception as exc:
            log.warning("Local-currency price lookup failed: %s", exc)

    # ── What moved the billed rate between the two months ──
    old_fx = new_fx = None
    if currency != "USD":
        if payload.previous_month:
            old_fx = await fx_rates.average_for_month(db, currency, payload.previous_month)
        if payload.current_month:
            new_fx = await fx_rates.average_for_month(db, currency, payload.current_month)
    elif payload.previous_month and payload.current_month:
        # Already the pricing currency: the exchange rate cannot be the cause.
        old_fx = new_fx = 1.0

    movement = fx_rates.split_movement(
        payload.previous_rate, payload.current_rate, old_fx, new_fx
    )

    # ── The comparison in dollars first, then in the billing currency ──
    # This is the block that answers "why are the two rates different". Almost
    # always they are not: they are the same dollar price wearing two different
    # exchange rates.
    published_unit_scale = (published or {}).get("unit_scale") or 1.0
    local_comparable = (
        published_local["retail_price"] * published_unit_scale
        if published_local and published_local.get("retail_price") is not None
        else None
    )
    currency_view = _currency_view(
        billed_rate=payload.current_rate,
        billing_currency=currency,
        published_usd=(published or {}).get("comparable_price"),
        published_local=local_comparable if currency != "USD"
        else (published or {}).get("comparable_price"),
        market_fx=new_fx,
    )
    currency_view["published_local"] = published_local
    currency_view["unit_scale"] = published_unit_scale

    # ── The gap between billed and published ──
    # Computed in dollars, because that is the only pair where both sides are a
    # price rather than a price times somebody's exchange rate. Comparing the
    # rupee bill against the rupee catalogue produces a gap that is mostly the
    # difference between two conversion rates, and reads as an overcharge.
    against_list = compare_to_list(
        currency_view["usd"]["billed_rate"],
        currency_view["usd"]["published_rate"],
    )
    against_list_local = compare_to_list(
        currency_view["billing"]["billed_rate"],
        currency_view["billing"]["published_rate"],
    )

    # ── The dollar, day by day, over the month in question ──
    fx_series: Dict[str, Any] = {}
    if currency != "USD" and payload.current_month:
        fx_series = await fx_rates.daily_rates(db, currency, payload.current_month)
        fx_series["summary"] = fx_rates.summarise(fx_series.get("series") or [])
        if payload.previous_month and payload.previous_month != payload.current_month:
            previous = await fx_rates.daily_rates(db, currency, payload.previous_month)
            fx_series["previous"] = {
                "month": payload.previous_month,
                "series": previous.get("series") or [],
                "summary": fx_rates.summarise(previous.get("series") or []),
            }

    # ── What Microsoft has done to this meter's price over time ──
    # Capped at the last ten movements. Beyond that the list stops being read
    # and the ones that matter — the most recent — get buried.
    meter_id = (published or {}).get("meter_id") or ""
    history: Dict[str, Any] = {"series": [], "changes": [], "timeline": {}}
    if meter_id:
        # Held in USD, because that is the currency the catalogue is read in and
        # the only one where a movement means Microsoft repriced something. A
        # rupee series would show a change every time the rupee moved, which is
        # true of the number and false of the price.
        history = {
            "meter_id": meter_id,
            "currency": "USD",
            "series": await price_history.series_for_meter(db, meter_id, "USD"),
            "changes": await price_history.changes_for_meter(db, meter_id, "USD", limit=10),
            # Three years of dated movements, anchored on Microsoft's own
            # effectiveStartDate so the timeline has a beginning even before
            # this installation had recorded anything.
            "timeline": await price_history.timeline_for_meter(
                db, meter_id, "USD", years=3,
                effective_from=(published or {}).get("effective_from"),
            ),
        }
    history["coverage"] = await price_history.coverage(db)

    return {
        "currency": currency,
        # Microsoft sets every Azure price in USD and converts for display, so a
        # non-USD figure moves with the currency even when nothing was repriced.
        # This flag is what lets the client say so instead of implying Azure
        # changed its prices.
        "is_converted_currency": currency != "USD",
        "billed": {
            "rate": payload.current_rate,
            "previous_rate": payload.previous_rate,
            "unit_of_measure": payload.unit_of_measure,
            "region": payload.arm_region,
            "sku": payload.arm_sku_name,
            "meter": payload.meter_name,
            "month": payload.current_month,
            "previous_month": payload.previous_month,
            "source": "Azure Cost Management — cost ÷ billed quantity",
        },
        "published": published,
        "published_error": published_error,
        # The field-by-field evidence behind the match, so "same meter" is a
        # checkable claim rather than a badge.
        "match_checks": match.get("checks") or [],
        "match_reason": match.get("reason") or "",
        "rejected": match.get("rejected") or [],
        # Meters that also passed every check but are priced differently.
        "alternatives": match.get("alternatives") or [],
        # Regions this meter is published in, when the billed line carries none
        # and the price is not the same everywhere.
        "region_options": match.get("regions") or [],
        "same_price_regions": match.get("same_price_regions") or 0,
        "candidate_count": len(candidates),
        "considered_count": match.get("considered") or 0,
        # In dollars, which is the comparison that settles the question.
        "against_list": against_list,
        # The same comparison in the billing currency, for a reader who needs
        # the number that appears on their invoice.
        "against_list_local": against_list_local,
        # Both views plus the exchange rate that reconciles them, and a verdict
        # naming which of the four explanations this gap actually is.
        "currency_view": currency_view,
        "movement": movement,
        "fx": fx_series,
        "price_history": history,
        "odata_filter": odata,
        "verify": _verification_links(
            payload.service_name, payload.arm_sku_name, currency, odata
        ),
    }


@router.get("/history")
async def get_price_history(
    meter_id: str = Query("", description="Microsoft's meterId"),
    currency: str = Query("USD"),
    price_type: str = Query("Consumption"),
    direction: Optional[str] = Query(None, description="up | down"),
    years: int = Query(3, ge=1, le=10, description="Timeline window for a single meter"),
    limit: int = Query(100, ge=1, le=500),
    current_user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
) -> Dict[str, Any]:
    """
    Recorded price movements — for one meter, or across everything seen.

    Only covers what this installation has actually observed. Microsoft
    publishes no history, so the record starts the first time a price was read
    here and not a day earlier; `coverage` says when that was, because "no
    changes" over two days of observation means nothing at all.
    """
    if meter_id:
        return {
            "meter_id": meter_id,
            "currency": currency.upper(),
            "series": await price_history.series_for_meter(db, meter_id, currency, price_type),
            "changes": await price_history.changes_for_meter(db, meter_id, currency, price_type),
            "timeline": await price_history.timeline_for_meter(
                db, meter_id, currency, price_type, years=years
            ),
            "coverage": await price_history.coverage(db),
        }

    return {
        "currency": currency.upper(),
        "changes": await price_history.recent_changes(db, currency, direction, limit),
        "coverage": await price_history.coverage(db),
    }


@router.get("/fx")
async def get_fx_rates(
    quote: str = Query("INR", description="Currency to convert USD into"),
    month: str = Query(..., description="YYYY-MM"),
    current_user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
) -> Dict[str, Any]:
    """
    The dollar's daily rate against a currency, for one month.

    Azure prices are set in USD, so this is what turns a stable dollar price
    into a local rate that appears to move.
    """
    if len(month) != 7 or month[4] != "-":
        raise HTTPException(status_code=400, detail="Month must be in YYYY-MM form.")

    data = await fx_rates.daily_rates(db, quote, month)
    data["summary"] = fx_rates.summarise(data.get("series") or [])
    return data

