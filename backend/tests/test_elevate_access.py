"""Elevating a Global Administrator to root scope, and giving it back."""
import httpx
import pytest

from services import actions, elevate_access


def _client(handler):
    """An httpx client whose every request is answered by `handler`."""
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def _assignment(principal_id="oid-1", role=elevate_access.USER_ACCESS_ADMINISTRATOR,
                scope="/", created="2026-09-14T10:00:00Z"):
    return {
        "id": f"/providers/Microsoft.Authorization/roleAssignments/{principal_id}-ra",
        "properties": {
            "principalId": principal_id,
            "roleDefinitionId": f"/providers/Microsoft.Authorization/roleDefinitions/{role}",
            "scope": scope,
            "createdOn": created,
        },
    }


class TestTakingTheElevation:
    @pytest.mark.asyncio
    async def test_it_posts_to_the_elevate_endpoint(self):
        seen = {}

        def handler(request):
            seen["url"] = str(request.url)
            seen["method"] = request.method
            seen["auth"] = request.headers.get("Authorization")
            return httpx.Response(200)

        async with _client(handler) as client:
            ok, message = await elevate_access.elevate(client, "tok")

        assert ok and message == ""
        assert seen["method"] == "POST"
        assert "/providers/Microsoft.Authorization/elevateAccess" in seen["url"]
        assert seen["auth"] == "Bearer tok"

    @pytest.mark.asyncio
    async def test_it_sends_the_only_api_version_this_endpoint_has(self):
        # A newer date here is not a newer API, it is a 400.
        seen = {}

        def handler(request):
            seen["version"] = request.url.params.get("api-version")
            return httpx.Response(204)

        async with _client(handler) as client:
            await elevate_access.elevate(client, "tok")

        assert seen["version"] == "2016-07-01"

    @pytest.mark.asyncio
    async def test_an_empty_204_is_success_not_a_puzzle(self):
        async with _client(lambda r: httpx.Response(204)) as client:
            ok, _ = await elevate_access.elevate(client, "tok")
        assert ok

    @pytest.mark.asyncio
    async def test_a_refusal_explains_that_this_needs_global_administrator(self):
        # The caller can act on "you are not a Global Administrator". They
        # cannot act on "403".
        async with _client(lambda r: httpx.Response(403, json={})) as client:
            ok, message = await elevate_access.elevate(client, "tok")

        assert not ok
        assert "Global Administrator" in message

    @pytest.mark.asyncio
    async def test_it_prefers_azures_own_explanation_when_there_is_one(self):
        body = {"error": {"message": "Tenant is managed by Lighthouse."}}
        async with _client(lambda r: httpx.Response(403, json=body)) as client:
            ok, message = await elevate_access.elevate(client, "tok")

        assert not ok
        assert message == "Tenant is managed by Lighthouse."

    @pytest.mark.asyncio
    async def test_an_expired_session_says_to_sign_in_again(self):
        async with _client(lambda r: httpx.Response(401, json={})) as client:
            _, message = await elevate_access.elevate(client, "tok")
        assert "Sign in again" in message

    @pytest.mark.asyncio
    async def test_an_unreachable_azure_is_reported_not_raised(self):
        def handler(request):
            raise httpx.ConnectError("no route")

        async with _client(handler) as client:
            ok, message = await elevate_access.elevate(client, "tok")

        assert not ok
        assert "could not be reached" in message


class TestReadingWhetherSomebodyIsElevated:
    @pytest.mark.asyncio
    async def test_it_finds_the_callers_own_root_assignment(self):
        body = {"value": [_assignment(principal_id="oid-1")]}
        async with _client(lambda r: httpx.Response(200, json=body)) as client:
            found, error = await elevate_access.read_elevation(client, "tok", "oid-1")

        assert error == ""
        assert found["properties"]["principalId"] == "oid-1"

    @pytest.mark.asyncio
    async def test_it_ignores_somebody_elses_elevation(self):
        # Another administrator being elevated is not this person being
        # elevated, and offering them a Remove button would be a lie.
        body = {"value": [_assignment(principal_id="someone-else")]}
        async with _client(lambda r: httpx.Response(200, json=body)) as client:
            found, error = await elevate_access.read_elevation(client, "tok", "oid-1")

        assert found is None and error == ""

    @pytest.mark.asyncio
    async def test_it_ignores_a_different_role_at_the_same_scope(self):
        body = {"value": [_assignment(role="00000000-0000-0000-0000-000000000000")]}
        async with _client(lambda r: httpx.Response(200, json=body)) as client:
            found, _ = await elevate_access.read_elevation(client, "tok", "oid-1")

        assert found is None

    @pytest.mark.asyncio
    async def test_it_ignores_the_same_role_at_a_narrower_scope(self):
        # User Access Administrator on one subscription is a normal grant, not
        # an elevation, and removing it would take away access nobody asked
        # this feature to touch.
        body = {"value": [_assignment(scope="/subscriptions/abc")]}
        async with _client(lambda r: httpx.Response(200, json=body)) as client:
            found, _ = await elevate_access.read_elevation(client, "tok", "oid-1")

        assert found is None

    @pytest.mark.asyncio
    async def test_it_scopes_the_query_so_it_does_not_enumerate_the_tenant(self):
        seen = {}

        def handler(request):
            seen["filter"] = request.url.params.get("$filter")
            return httpx.Response(200, json={"value": []})

        async with _client(handler) as client:
            await elevate_access.read_elevation(client, "tok", "oid-1")

        assert seen["filter"] == "atScope()"

    @pytest.mark.asyncio
    async def test_not_elevated_is_distinct_from_could_not_find_out(self):
        # These lead to different buttons, so they must not collapse together.
        async with _client(lambda r: httpx.Response(200, json={"value": []})) as client:
            found, error = await elevate_access.read_elevation(client, "tok", "oid-1")
        assert found is None and error == ""

        async with _client(lambda r: httpx.Response(500, json={})) as client:
            found, error = await elevate_access.read_elevation(client, "tok", "oid-1")
        assert found is None and error != ""

    @pytest.mark.asyncio
    async def test_an_unreadable_body_is_reported_rather_than_treated_as_empty(self):
        async with _client(lambda r: httpx.Response(200, text="<html>")) as client:
            found, error = await elevate_access.read_elevation(client, "tok", "oid-1")

        assert found is None
        assert "could not be read" in error

    @pytest.mark.asyncio
    async def test_a_missing_scope_is_taken_as_the_root_it_was_queried_at(self):
        item = _assignment()
        del item["properties"]["scope"]
        async with _client(lambda r: httpx.Response(200, json={"value": [item]})) as client:
            found, _ = await elevate_access.read_elevation(client, "tok", "oid-1")

        assert found is not None


class TestGivingItBack:
    @pytest.mark.asyncio
    async def test_it_deletes_the_assignment_it_was_given(self):
        seen = {}

        def handler(request):
            seen["method"] = request.method
            seen["url"] = str(request.url)
            return httpx.Response(200)

        async with _client(handler) as client:
            ok, _ = await elevate_access.remove_elevation(client, "tok", "/providers/x/ra-1")

        assert ok
        assert seen["method"] == "DELETE"
        assert seen["url"].endswith("api-version=2022-04-01")
        assert "/providers/x/ra-1" in seen["url"]

    @pytest.mark.asyncio
    async def test_already_gone_counts_as_gone(self):
        # The caller asked for the elevation to be removed and it is removed.
        # Reporting a failure would invite a retry of something already done.
        async with _client(lambda r: httpx.Response(204)) as client:
            ok, message = await elevate_access.remove_elevation(client, "tok", "/ra")

        assert ok and message == ""

    @pytest.mark.asyncio
    async def test_a_refusal_is_reported(self):
        body = {"error": {"message": "Assignment is locked."}}
        async with _client(lambda r: httpx.Response(403, json=body)) as client:
            ok, message = await elevate_access.remove_elevation(client, "tok", "/ra")

        assert not ok
        assert message == "Assignment is locked."


class TestDescribingItForTheAuditTrail:
    def test_nothing_is_recorded_as_not_elevated(self):
        assert elevate_access.describe(None) == {"elevated": False}

    def test_it_keeps_the_assignment_id_the_removal_will_need(self):
        described = elevate_access.describe(_assignment())
        assert described["assignment_id"].endswith("oid-1-ra")

    def test_it_keeps_when_the_elevation_was_taken(self):
        # An elevation from four minutes ago is somebody working. The same one
        # from four months ago is a standing administrator nobody reviewed.
        described = elevate_access.describe(_assignment(created="2026-01-01T00:00:00Z"))
        assert described["created_on"] == "2026-01-01T00:00:00Z"

    def test_it_names_the_role_in_words(self):
        assert elevate_access.describe(_assignment())["role"] == "User Access Administrator"

    def test_a_missing_field_becomes_empty_rather_than_raising(self):
        described = elevate_access.describe({"id": "/ra", "properties": {}})
        assert described["elevated"] is True
        assert described["principal_id"] == ""


class TestWhatTheRegistrySays:
    def test_both_halves_of_the_feature_are_registered(self):
        assert actions.get_spec("access.elevate") is not None
        assert actions.get_spec("access.remove_elevation") is not None

    def test_elevating_demands_confirmation(self):
        assert actions.get_spec("access.elevate").requires_confirmation is True

    def test_giving_it_back_does_not(self):
        # A barrier in front of returning access is how the access stays.
        assert actions.get_spec("access.remove_elevation").requires_confirmation is False

    def test_elevating_is_reversible_and_says_by_what(self):
        spec = actions.get_spec("access.elevate")
        assert spec.reversible is True
        assert spec.enabled is True

    def test_the_caveats_warn_that_it_reaches_the_whole_tenant(self):
        caveats = " ".join(actions.get_spec("access.elevate").caveats).lower()
        assert "tenant-wide" in caveats
        assert "temporary" in caveats

    def test_the_caveats_say_azure_audits_it_regardless(self):
        caveats = " ".join(actions.get_spec("access.elevate").caveats).lower()
        assert "activity log" in caveats
