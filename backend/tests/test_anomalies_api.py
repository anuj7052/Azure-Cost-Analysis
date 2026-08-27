"""
The anomalies endpoint, end to end with Azure stubbed.

The engine and the period arithmetic are tested on their own; what these cover
is the wiring between them -- that a partial month is trimmed before it is
compared, that a new cost survives the journey to the response, and that a
subscription the caller does not own never reaches Cost Management.
"""
from __future__ import annotations

import aiosqlite
import pytest
import pytest_asyncio
from fastapi.testclient import TestClient

import core.db as db_module
import routers.anomalies as route
from auth.dependencies import get_current_user
from main import app

TENANT = "tenant-a"


def usage(day: str, service: str, cost: float, qty: float = 1.0, sub: str = "sub-a"):
    return {
        "UsageDate": day.replace("-", ""),
        "ServiceName": service,
        "ResourceGroupName": "rg-prod",
        "Meter": f"{service} meter",
        "PreTaxCost": cost,
        "UsageQuantity": qty,
        "Currency": "INR",
        "SubscriptionId": sub,
    }


@pytest_asyncio.fixture
async def client(tmp_path, monkeypatch):
    path = str(tmp_path / "api.db")
    monkeypatch.setattr(db_module, "DB_PATH", path)
    await db_module.init_db()

    conn = await aiosqlite.connect(path)
    await conn.execute(
        "INSERT INTO users (id, azure_oid, email, name, azure_tenant_id) "
        "VALUES (1, 'oid-a', 'a@a.com', 'Alice', ?)",
        (TENANT,),
    )
    await conn.commit()
    await conn.close()

    app.dependency_overrides[get_current_user] = lambda: {
        "account_id": 1, "name": "Alice", "email": "a@a.com", "tenant_id": TENANT,
    }
    monkeypatch.setattr(route, "resolve_tenant_token", _fake_token)
    monkeypatch.setattr(route, "subscription_names", lambda t, tok: {"sub-a": "kredily"})

    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


async def _fake_token(tenant_id, user, db):
    return "token"


def analyze(client, **over):
    body = {
        "tenant_id": TENANT,
        "subscription_ids": ["sub-a"],
        "from_date": "2026-08-01",
        "to_date": "2026-08-31",
        "comparison": "previous_month",
        **over,
    }
    return client.post("/api/v1/anomalies/analyze", json=body)


class TestAnalyze:
    def test_a_spike_is_reported_with_a_readable_subscription_name(self, client, monkeypatch):
        rows = (
            [usage("2026-07-05", "Postgres", 100.0)]
            + [usage("2026-08-05", "Postgres", 5000.0)]
        )

        async def fake_query(**kwargs):
            return rows
        monkeypatch.setattr(route, "query_usage", fake_query)

        r = analyze(client)

        assert r.status_code == 200
        body = r.json()
        found = body["anomalies"][0]
        assert found["service"] == "Postgres"
        # A GUID tells the reader nothing they can act on.
        assert found["subscription_name"] == "kredily"
        assert found["delta"] == pytest.approx(4900.0)
        assert found["status"] == "new"
        assert found["anomaly_key"]

    def test_a_newly_deployed_cost_is_reported_rather_than_skipped(self, client, monkeypatch):
        # The previous rule divided by the old cost and skipped anything that
        # was new, hiding the most common real surprise on a bill.
        async def fake_query(**kwargs):
            return [usage("2026-08-05", "Azure OpenAI", 9000.0)]
        monkeypatch.setattr(route, "query_usage", fake_query)

        body = analyze(client).json()

        assert [r["service"] for r in body["new_costs"]] == ["Azure OpenAI"]

    def test_a_partial_month_is_trimmed_before_comparison(self, client, monkeypatch):
        # July costs after the 10th must be excluded when only 10 days of
        # August exist, or every unfinished month looks like a huge saving.
        async def fake_query(**kwargs):
            return [
                usage("2026-07-05", "Storage", 100.0),
                usage("2026-07-25", "Storage", 900.0),
                usage("2026-08-05", "Storage", 100.0),
            ]
        monkeypatch.setattr(route, "query_usage", fake_query)

        body = analyze(client, from_date="2026-08-01", to_date="2026-08-10").json()

        assert body["window"]["previous_end"] == "2026-07-10"
        # Compared like for like the cost is flat, not down 90%.
        every = body["anomalies"] + body["reductions"] + body["immaterial"]
        assert all(r["previous_cost"] == pytest.approx(100.0) for r in every)

    def test_savings_are_never_claimed_without_evidence(self, client, monkeypatch):
        async def fake_query(**kwargs):
            return [usage("2026-07-05", "Storage", 5000.0), usage("2026-08-05", "Storage", 100.0)]
        monkeypatch.setattr(route, "query_usage", fake_query)

        body = analyze(client).json()

        # A bill going down proves a cost fell, not that anyone saved anything.
        assert body["summary"]["verified_savings"] is None
        assert body["summary"]["total_reduction"] > 0

    def test_a_reversed_date_range_is_refused(self, client, monkeypatch):
        async def fake_query(**kwargs):
            return []
        monkeypatch.setattr(route, "query_usage", fake_query)

        r = analyze(client, from_date="2026-08-31", to_date="2026-08-01")

        assert r.status_code == 400

    def test_a_malformed_date_is_refused(self, client, monkeypatch):
        async def fake_query(**kwargs):
            return []
        monkeypatch.setattr(route, "query_usage", fake_query)

        assert analyze(client, from_date="31/08/2026").status_code == 400

    def test_a_tenant_the_caller_does_not_own_never_reaches_azure(self, client, monkeypatch):
        from fastapi import HTTPException

        called = []

        async def deny(tenant_id, user, db):
            raise HTTPException(status_code=403, detail="Not your tenant.")

        async def fake_query(**kwargs):
            called.append(kwargs)
            return []

        monkeypatch.setattr(route, "resolve_tenant_token", deny)
        monkeypatch.setattr(route, "query_usage", fake_query)

        r = analyze(client, tenant_id="tenant-b")

        assert r.status_code == 403
        # Authorisation before the request, not after it.
        assert called == []


class TestStatusEndpoint:
    def test_a_status_is_saved_and_returned_with_its_trail(self, client):
        r = client.post("/api/v1/anomalies/status", json={
            "tenant_id": TENANT, "anomaly_key": "k",
            "status": "investigating", "comment": "Checking with the team.",
        })

        assert r.status_code == 200
        body = r.json()
        assert body["status"] == "investigating"
        assert body["previous_status"] == "new"
        assert body["history"][0]["comment"] == "Checking with the team."
        assert body["history"][0]["actor_name"] == "Alice"

    def test_an_invented_status_is_refused_with_the_valid_ones(self, client):
        r = client.post("/api/v1/anomalies/status", json={
            "tenant_id": TENANT, "anomaly_key": "k", "status": "probably-fine",
        })

        assert r.status_code == 400
        # The message lists what is allowed, so the caller does not have to guess.
        assert "investigating" in r.text

    def test_history_is_readable_on_its_own(self, client):
        client.post("/api/v1/anomalies/status", json={
            "tenant_id": TENANT, "anomaly_key": "k2", "status": "resolved",
        })

        r = client.get("/api/v1/anomalies/history", params={"tenant_id": TENANT, "anomaly_key": "k2"})

        assert r.status_code == 200
        assert r.json()["history"][0]["new_status"] == "resolved"

    def test_a_status_survives_and_is_attached_on_the_next_analysis(self, client, monkeypatch):
        async def fake_query(**kwargs):
            return [usage("2026-07-05", "Postgres", 100.0), usage("2026-08-05", "Postgres", 5000.0)]
        monkeypatch.setattr(route, "query_usage", fake_query)

        key = analyze(client).json()["anomalies"][0]["anomaly_key"]
        client.post("/api/v1/anomalies/status", json={
            "tenant_id": TENANT, "anomaly_key": key, "status": "acknowledged",
        })

        again = analyze(client).json()["anomalies"][0]

        # The point of the fingerprint: recomputing from billing data must not
        # reset what somebody already decided about it.
        assert again["status"] == "acknowledged"
