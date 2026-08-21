"""
Tests for the currency reconciliation on the unit-rate panel.

The behaviour under test comes from a real observation against Microsoft's live
catalogue: Standard_D4as_v5 in centralindia is published at USD 0.111 and
INR 10.61715 for the same meterId on the same day. That is an implied rate of
95.65 when the market was near 84 — a ~14% premium baked into the non-USD price.

The consequence is the thing worth protecting with tests. Converting an INR bill
to dollars at the *market* rate and comparing it to the dollar list price invents
a 14% overcharge out of nothing. So the conversion has to be Microsoft's own, and
the two currency views have to produce the same percentage. A test suite that let
those drift apart would let the app tell a customer they are being overcharged
when they are paying exactly list.
"""
import pytest

from routers.prices import SAME_PRICE_TOLERANCE, _currency_view, _gap

# Live values, read from prices.azure.com.
USD_LIST = 0.111
INR_LIST = 10.61715
CATALOGUE_FX = INR_LIST / USD_LIST      # 95.65
MARKET_FX = 83.9


def view(billed, *, currency="INR", usd=USD_LIST, local=INR_LIST, market=MARKET_FX):
    return _currency_view(
        billed_rate=billed,
        billing_currency=currency,
        published_usd=usd,
        published_local=local,
        market_fx=market,
    )


def test_gap_is_signed_and_relative():
    assert _gap(110, 100) == pytest.approx(0.1)
    assert _gap(90, 100) == pytest.approx(-0.1)
    assert _gap(None, 100) is None
    assert _gap(100, None) is None
    assert _gap(100, 0) is None


def test_a_line_on_list_reads_as_list_in_both_currencies():
    result = view(INR_LIST)

    assert result["usd"]["gap_percent"] == pytest.approx(0.0, abs=1e-6)
    assert result["billing"]["gap_percent"] == pytest.approx(0.0, abs=1e-6)
    assert result["usd"]["matches"] is True
    assert result["billing"]["matches"] is True
    assert result["verdict"]["code"] == "identical"


def test_the_market_rate_is_never_used_to_restate_the_bill():
    # The regression this whole module exists for. Dividing the INR bill by the
    # market rate would give 0.1265 against a 0.111 list price — a fabricated
    # 14% overcharge on a line that is exactly on list.
    result = view(INR_LIST)

    assert result["fx_basis"] == "microsoft"
    assert result["usd"]["fx_used"] == pytest.approx(CATALOGUE_FX)
    assert result["usd"]["billed_rate"] == pytest.approx(USD_LIST)
    assert result["usd"]["billed_rate"] != pytest.approx(INR_LIST / MARKET_FX)


def test_both_currencies_report_the_same_percentage():
    # Switching currency changes the units, not the finding. Any divergence here
    # means each side is being converted by a different rate again.
    for billed in (INR_LIST * 0.62, INR_LIST, INR_LIST * 1.3):
        result = view(billed)
        assert result["usd"]["gap_percent"] == pytest.approx(
            result["billing"]["gap_percent"], abs=1e-6
        )


def test_the_currency_premium_is_quantified():
    result = view(INR_LIST)

    assert result["catalogue_fx"] == pytest.approx(CATALOGUE_FX, abs=1e-3)
    assert result["market_fx"] == MARKET_FX
    assert result["fx_premium_percent"] == pytest.approx(14.005, abs=0.01)
    # It is Microsoft's premium, not a customer overcharge, so it must not leak
    # into the verdict as a price finding.
    assert result["verdict"]["code"] == "identical"
    assert "14.0% above the market rate" in result["verdict"]["detail"]


def test_the_rate_the_bill_implies_is_reported():
    # A discounted line implies a lower rate than the catalogue's. That is the
    # number a reader checks against their own billing account.
    result = view(INR_LIST * 0.62)
    assert result["implied_fx"] == pytest.approx(CATALOGUE_FX * 0.62, abs=1e-3)
    assert result["catalogue_fx"] == pytest.approx(CATALOGUE_FX, abs=1e-3)


def test_a_reservation_survives_the_conversion():
    result = view(INR_LIST * 0.62)

    assert result["usd"]["gap_percent"] == pytest.approx(-38.0, abs=0.01)
    assert result["verdict"]["code"] == "discount"
    assert "reservation" in result["verdict"]["detail"]


def test_paying_over_list_is_flagged_but_not_asserted_as_an_overcharge():
    result = view(INR_LIST * 1.3)

    assert result["verdict"]["code"] == "above-list"
    assert "30.0%" in result["verdict"]["headline"]
    # The likeliest cause is a bad meter match, and saying so prevents the
    # number being repeated as an overcharge.
    assert "not the one being billed" in result["verdict"]["detail"]


def test_half_a_percent_is_the_same_price():
    # Retail prices carry five decimals and the billed rate is a division of two
    # rounded numbers, so exact equality never occurs even when nothing is wrong.
    assert view(INR_LIST * (1 + SAME_PRICE_TOLERANCE * 0.9))["usd"]["matches"] is True
    assert view(INR_LIST * (1 + SAME_PRICE_TOLERANCE * 2))["usd"]["matches"] is False


def test_a_usd_account_needs_no_conversion():
    result = view(USD_LIST, currency="USD", local=USD_LIST)

    assert result["is_usd"] is True
    assert result["usd"]["billed_rate"] == USD_LIST
    assert result["usd"]["fx_used"] is None
    assert result["usd"]["billed_is_converted"] is False
    assert result["verdict"]["code"] == "identical"


def test_falls_back_to_the_market_rate_and_says_so():
    # Microsoft's local price is a second HTTP call and can fail on its own.
    result = view(INR_LIST, local=None)

    assert result["fx_basis"] == "market"
    assert result["usd"]["fx_used"] == MARKET_FX
    assert result["catalogue_fx"] is None
    # The apparent premium is conversion, not money, and the verdict has to warn
    # rather than report a 14% overcharge as fact.
    assert "converted at the market rate instead" in result["verdict"]["detail"]


def test_a_missing_local_price_still_reports_a_gap():
    # The billing view borrows the dollar gap rather than showing a blank the
    # reader would fill in themselves.
    result = view(INR_LIST, local=None)
    assert result["billing"]["gap_percent"] is not None
    assert result["billing"]["gap_percent"] == result["usd"]["gap_percent"]


def test_no_published_price_makes_no_claim():
    result = view(INR_LIST, usd=None, local=None, market=MARKET_FX)

    assert result["verdict"]["code"] == "unknown"
    assert result["usd"]["gap_percent"] is None


def test_no_billed_rate_makes_no_claim():
    result = view(None)

    assert result["verdict"]["code"] == "no-bill"
    assert result["usd"]["billed_rate"] is None


def test_no_exchange_rate_at_all_does_not_invent_one():
    result = view(INR_LIST, local=None, market=None)

    assert result["fx_basis"] == "none"
    assert result["usd"]["billed_rate"] is None
    assert result["verdict"]["code"] == "no-bill"
