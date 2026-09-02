"""
Today's exchange rates, for the display-currency switch.

The switch converts every figure on every page into one unit, which is the only
way a tenant billed in two currencies can read a total at all. That makes these
rates load-bearing, and the failure mode is silent: a missing rate defaulted to
1.0 would report a dollar figure as rupees, and nothing on the screen would look
wrong. So the contract tested here is that an unresolvable currency is *absent*
from the result rather than assumed, and that a stale rate is labelled as one.
"""
import aiosqlite
import pytest
import pytest_asyncio

import core.db as db_module
from services import fx_rates


@pytest_asyncio.fixture
async def db(tmp_path, monkeypatch):
    path = str(tmp_path / "test.db")
    monkeypatch.setattr(db_module, "DB_PATH", path)
    await db_module.init_db()
    conn = await aiosqlite.connect(path)
    conn.row_factory = aiosqlite.Row
    yield conn
    await conn.close()


class FakeResponse:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self._payload


class FakeClient:
    """Stands in for httpx, and records what was asked for."""

    def __init__(self, payload=None, fail=False):
        self.payload = payload
        self.fail = fail
        self.params = None

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def get(self, url, params=None):
        self.params = params
        if self.fail:
            raise RuntimeError("network down")
        return FakeResponse(self.payload)


def patch_client(monkeypatch, client):
    monkeypatch.setattr(fx_rates.httpx, "AsyncClient", lambda **kw: client)


@pytest.mark.asyncio
async def test_it_returns_one_rate_per_currency_with_the_dollar_at_one(db, monkeypatch):
    patch_client(monkeypatch, FakeClient(
        {"date": "2026-09-01", "rates": {"INR": 88.2, "EUR": 0.91}}))

    out = await fx_rates.latest_rates(db, ["INR", "EUR", "USD"])

    assert out["base"] == "USD"
    assert out["rates"]["USD"] == 1.0
    assert out["rates"]["INR"] == pytest.approx(88.2)
    assert out["stale"] is False
    assert out["note"] is None


@pytest.mark.asyncio
async def test_asking_only_for_dollars_needs_no_request(db, monkeypatch):
    client = FakeClient({"rates": {}})
    patch_client(monkeypatch, client)

    out = await fx_rates.latest_rates(db, ["USD"])

    assert out["rates"] == {"USD": 1.0}
    assert client.params is None


@pytest.mark.asyncio
async def test_a_fetched_rate_is_stored_so_the_next_call_has_a_fallback(db, monkeypatch):
    patch_client(monkeypatch, FakeClient(
        {"date": "2026-09-01", "rates": {"INR": 88.2}}))
    await fx_rates.latest_rates(db, ["INR"])

    row = await db.execute(
        "SELECT rate_day, rate FROM fx_rates WHERE quote = 'INR'")
    stored = await row.fetchone()
    assert stored["rate_day"] == "2026-09-01"
    assert stored["rate"] == pytest.approx(88.2)


@pytest.mark.asyncio
async def test_a_failed_fetch_falls_back_to_the_newest_stored_rate(db, monkeypatch):
    # A rate from last week converts far better than no rate at all, provided
    # the page is told how old it is.
    await fx_rates._store(db, "INR", {"2026-08-25": 87.0, "2026-08-28": 88.0})
    patch_client(monkeypatch, FakeClient(fail=True))

    out = await fx_rates.latest_rates(db, ["INR"])

    assert out["rates"]["INR"] == pytest.approx(88.0)
    assert out["stale"] is True
    assert out["as_of"] == "2026-08-28"


@pytest.mark.asyncio
async def test_an_unresolvable_currency_is_absent_rather_than_assumed(db, monkeypatch):
    # The failure that would be invisible: defaulting to 1.0 would print a
    # dollar amount under a yen label and look entirely plausible.
    patch_client(monkeypatch, FakeClient(fail=True))

    out = await fx_rates.latest_rates(db, ["JPY"])

    assert "JPY" not in out["rates"]
    assert "JPY" in out["note"]


@pytest.mark.asyncio
async def test_the_dollar_is_never_requested_as_a_quote(db, monkeypatch):
    client = FakeClient({"date": "2026-09-01", "rates": {"INR": 88.2}})
    patch_client(monkeypatch, client)

    await fx_rates.latest_rates(db, ["USD", "INR", "usd"])

    assert client.params["symbols"] == "INR"
