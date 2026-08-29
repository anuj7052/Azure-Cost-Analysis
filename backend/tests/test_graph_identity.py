"""
Tests for directory name resolution.

The distinction these tests exist to protect: an object id shown because nobody
asked, an object id shown because Graph refused, and an object id shown because
the account really is gone are three different facts. Collapsing them would let
a permissions problem masquerade as a clean result, which is the single failure
mode this whole module was written to avoid.
"""
import httpx
import pytest

from services import graph_identity


@pytest.fixture(autouse=True)
def clear_cache():
    graph_identity.reset_cache()
    yield
    graph_identity.reset_cache()


def user(oid, name, upn=None, enabled=None):
    body = {
        "@odata.type": "#microsoft.graph.user",
        "id": oid,
        "displayName": name,
    }
    if upn:
        body["userPrincipalName"] = upn
    if enabled is not None:
        body["accountEnabled"] = enabled
    return body


class TestCleanIds:
    def test_deduplicates_and_lowercases(self):
        ids = graph_identity.clean_ids(["ABC", "abc", "  DEF  ", "abc"])
        assert ids == ["abc", "def"]

    def test_drops_empty_values(self):
        assert graph_identity.clean_ids(["", None, "  ", "a"]) == ["a"]

    def test_preserves_first_seen_order(self):
        assert graph_identity.clean_ids(["b", "a", "b"]) == ["b", "a"]


class TestChunk:
    def test_splits_at_batch_size(self):
        parts = graph_identity.chunk(list(range(2500)), size=1000)
        assert [len(p) for p in parts] == [1000, 1000, 500]

    def test_empty_input_makes_no_batches(self):
        assert graph_identity.chunk([]) == []


class TestNoToken:
    """Without a Graph token nothing is looked up, and the answer says so."""

    async def test_reports_no_token_reason(self):
        result = await graph_identity.resolve_principals(None, ["a", "b"])
        assert result["resolved"] is False
        assert result["reason"] == graph_identity.REASON_NO_TOKEN
        assert result["principals"] == {}
        assert "did not supply" in result["note"]

    async def test_empty_string_token_counts_as_absent(self):
        result = await graph_identity.resolve_principals("", ["a"])
        assert result["reason"] == graph_identity.REASON_NO_TOKEN

    async def test_no_ids_is_not_a_failure(self):
        result = await graph_identity.resolve_principals("tok", [])
        assert result["resolved"] is True
        assert result["requested"] == 0


class TestResolution:
    async def test_returns_names_keyed_by_lowercased_id(self, monkeypatch):
        async def fake(client, token, ids):
            return [user("AAA-111", "Dana Shah", "dana@contoso.com")]

        monkeypatch.setattr(graph_identity, "_fetch_batch", fake)
        result = await graph_identity.resolve_principals("tok", ["AAA-111"])

        assert result["resolved"] is True
        assert result["found"] == 1
        assert result["principals"]["aaa-111"]["display_name"] == "Dana Shah"
        assert result["principals"]["aaa-111"]["type"] == "User"

    async def test_ids_graph_does_not_return_are_simply_absent(self, monkeypatch):
        async def fake(client, token, ids):
            return [user("aaa", "Known")]

        monkeypatch.setattr(graph_identity, "_fetch_batch", fake)
        result = await graph_identity.resolve_principals("tok", ["aaa", "deleted"])

        # A deleted account is a real finding: access left behind by someone who
        # no longer exists. It must not be confused with a failed lookup.
        assert result["resolved"] is True
        assert result["requested"] == 2
        assert result["found"] == 1
        assert "deleted" not in result["principals"]

    async def test_service_principal_type_is_mapped(self, monkeypatch):
        async def fake(client, token, ids):
            return [{
                "@odata.type": "#microsoft.graph.servicePrincipal",
                "id": "sp1",
                "appDisplayName": "Backup Runner",
            }]

        monkeypatch.setattr(graph_identity, "_fetch_batch", fake)
        result = await graph_identity.resolve_principals("tok", ["sp1"])
        entry = result["principals"]["sp1"]
        assert entry["type"] == "Service principal"
        assert entry["display_name"] == "Backup Runner"

    async def test_second_call_is_served_from_cache(self, monkeypatch):
        calls = []

        async def fake(client, token, ids):
            calls.append(list(ids))
            return [user("aaa", "Dana")]

        monkeypatch.setattr(graph_identity, "_fetch_batch", fake)
        await graph_identity.resolve_principals("tok", ["aaa"], "tenant-1")
        await graph_identity.resolve_principals("tok", ["aaa"], "tenant-1")
        assert len(calls) == 1

    async def test_a_different_tenant_does_not_share_the_cache(self, monkeypatch):
        calls = []

        async def fake(client, token, ids):
            calls.append(list(ids))
            return [user("aaa", "Dana")]

        monkeypatch.setattr(graph_identity, "_fetch_batch", fake)
        await graph_identity.resolve_principals("tok", ["aaa"], "tenant-1")
        await graph_identity.resolve_principals("tok", ["aaa"], "tenant-2")
        assert len(calls) == 2


class TestFailures:
    async def test_403_is_reported_as_denied_not_as_empty(self, monkeypatch):
        async def fake(client, token, ids):
            request = httpx.Request("POST", "https://graph.microsoft.com")
            response = httpx.Response(403, request=request)
            raise httpx.HTTPStatusError("denied", request=request, response=response)

        monkeypatch.setattr(graph_identity, "_fetch_batch", fake)
        result = await graph_identity.resolve_principals("tok", ["aaa"])

        assert result["resolved"] is False
        assert result["reason"] == graph_identity.REASON_DENIED
        assert "Directory.Read.All" in result["note"]

    async def test_network_failure_is_unavailable_not_denied(self, monkeypatch):
        async def fake(client, token, ids):
            raise httpx.ConnectError("no route")

        monkeypatch.setattr(graph_identity, "_fetch_batch", fake)
        result = await graph_identity.resolve_principals("tok", ["aaa"])

        assert result["reason"] == graph_identity.REASON_UNAVAILABLE
        assert result["resolved"] is False

    async def test_failure_never_raises(self, monkeypatch):
        async def fake(client, token, ids):
            raise RuntimeError("boom")

        monkeypatch.setattr(graph_identity, "_fetch_batch", fake)
        result = await graph_identity.resolve_principals("tok", ["aaa"])
        assert result["resolved"] is False


class TestApplyNames:
    def test_writes_name_and_marks_resolved(self):
        rows = [{"principal_id": "AAA", "principal_name": "AAA", "resolved": False}]
        updated = graph_identity.apply_names(
            rows, {"aaa": {"display_name": "Dana Shah", "upn": "dana@x.com", "type": "User"}}
        )
        assert updated == 1
        assert rows[0]["principal_name"] == "Dana Shah"
        assert rows[0]["resolved"] is True
        assert rows[0]["principal_type"] == "User"

    def test_does_not_overwrite_a_name_azure_already_gave(self):
        rows = [{"principal_id": "aaa", "principal_name": "From ARM", "resolved": True}]
        graph_identity.apply_names(rows, {"aaa": {"display_name": "From Graph"}})
        assert rows[0]["principal_name"] == "From ARM"

    def test_unknown_id_is_left_untouched(self):
        rows = [{"principal_id": "zzz", "principal_name": "zzz", "resolved": False}]
        assert graph_identity.apply_names(rows, {"aaa": {"display_name": "A"}}) == 0
        assert rows[0]["resolved"] is False

    def test_disabled_account_is_flagged(self):
        rows = [{"principal_id": "aaa", "resolved": False}]
        graph_identity.apply_names(
            rows, {"aaa": {"display_name": "Ex Employee", "enabled": False}}
        )
        assert rows[0]["principal_disabled"] is True

    def test_entry_without_a_name_does_not_claim_resolution(self):
        rows = [{"principal_id": "aaa", "resolved": False}]
        assert graph_identity.apply_names(rows, {"aaa": {"display_name": "", "upn": ""}}) == 0
        assert rows[0]["resolved"] is False
