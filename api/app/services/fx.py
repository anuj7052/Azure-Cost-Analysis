from __future__ import annotations

import json
from functools import lru_cache

from app.core.config import settings

# Units of the quoted currency per 1 USD. Azure bills each subscription in the
# billing account's own currency (INR for Indian EA/CSP accounts, USD for most
# others), so a tenant with subscriptions across billing accounts holds cost
# rows in mixed currencies. Reporting has to normalise them before summing.
DEFAULT_RATES: dict[str, float] = {
    "USD": 1.0,
    "INR": 83.0,
    "EUR": 0.92,
    "GBP": 0.79,
    "AUD": 1.52,
    "CAD": 1.36,
    "SGD": 1.35,
    "AED": 3.67,
    "JPY": 157.0,
    "CHF": 0.89,
}

SUPPORTED_CURRENCIES = tuple(DEFAULT_RATES)


@lru_cache(maxsize=1)
def _rates() -> dict[str, float]:
    """Merge any operator-supplied rates over the built-in defaults."""
    override = (getattr(settings, "FX_RATES_JSON", "") or "").strip()
    if not override:
        return dict(DEFAULT_RATES)
    try:
        parsed = json.loads(override)
    except json.JSONDecodeError:
        return dict(DEFAULT_RATES)
    merged = dict(DEFAULT_RATES)
    for code, rate in parsed.items():
        try:
            value = float(rate)
        except (TypeError, ValueError):
            continue
        if value > 0:
            merged[code.upper()] = value
    return merged


def normalise(currency: str | None) -> str:
    code = (currency or "").strip().upper()
    return code if code in _rates() else "USD"


def convert(amount: float, source: str | None, target: str | None) -> float:
    """Convert `amount` between two currencies via their USD rates.

    An unknown currency is treated as USD rather than raising, so a new Azure
    billing currency degrades to an approximate figure instead of a 500.
    """
    src = normalise(source)
    dst = normalise(target)
    if src == dst or not amount:
        return amount
    rates = _rates()
    return amount / rates[src] * rates[dst]
