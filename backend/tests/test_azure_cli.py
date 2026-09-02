"""
Tests for the Azure CLI credential path.

`az` is never actually run: every test replaces the subprocess, because a test
that depended on the developer's own login would pass or fail for reasons that
have nothing to do with this code.
"""
import asyncio
import json
import time

import pytest

from services import azure_cli


class FakeProc:
    def __init__(self, returncode, stdout=b"", stderr=b""):
        self.returncode = returncode
        self._out = (stdout, stderr)

    async def communicate(self):
        return self._out


def fake_exec(returncode=0, stdout=b"", stderr=b"", record=None):
    async def _exec(program, *args, **kwargs):
        if record is not None:
            record.append([program, *args])
        return FakeProc(returncode, stdout, stderr)
    return _exec


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    azure_cli.forget()
    azure_cli._reset_login()
    monkeypatch.setattr(azure_cli.shutil, "which", lambda name: "/usr/bin/az")
    yield
    azure_cli.forget()
    azure_cli._reset_login()


TOKEN_JSON = json.dumps({
    "accessToken": "cli-token",
    "expires_on": str(int(time.time()) + 3600),
}).encode()


@pytest.mark.asyncio
async def test_returns_the_token_the_cli_prints(monkeypatch):
    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec(stdout=TOKEN_JSON))
    assert await azure_cli.get_token("tenant-a") == "cli-token"


@pytest.mark.asyncio
async def test_always_asks_for_a_named_tenant(monkeypatch):
    """A token for the CLI's default tenant would fail later, as empty data."""
    calls = []
    monkeypatch.setattr(
        asyncio, "create_subprocess_exec", fake_exec(stdout=TOKEN_JSON, record=calls),
    )
    await azure_cli.get_token("tenant-a")
    assert "--tenant" in calls[0] and "tenant-a" in calls[0]


@pytest.mark.asyncio
async def test_a_live_token_is_reused_rather_than_reshelled(monkeypatch):
    calls = []
    monkeypatch.setattr(
        asyncio, "create_subprocess_exec", fake_exec(stdout=TOKEN_JSON, record=calls),
    )
    await azure_cli.get_token("tenant-a")
    await azure_cli.get_token("tenant-a")
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_an_expiring_token_is_fetched_again(monkeypatch):
    """Inside the safety margin the cached token is treated as already gone."""
    nearly = json.dumps({
        "accessToken": "old", "expires_on": str(int(time.time()) + 5),
    }).encode()
    calls = []
    monkeypatch.setattr(
        asyncio, "create_subprocess_exec", fake_exec(stdout=nearly, record=calls),
    )
    await azure_cli.get_token("tenant-a")
    await azure_cli.get_token("tenant-a")
    assert len(calls) == 2


@pytest.mark.asyncio
async def test_separate_tenants_do_not_share_a_token(monkeypatch):
    calls = []
    monkeypatch.setattr(
        asyncio, "create_subprocess_exec", fake_exec(stdout=TOKEN_JSON, record=calls),
    )
    await azure_cli.get_token("tenant-a")
    await azure_cli.get_token("tenant-b")
    assert len(calls) == 2


@pytest.mark.asyncio
async def test_a_missing_cli_says_so_rather_than_failing_obscurely(monkeypatch):
    monkeypatch.setattr(azure_cli.shutil, "which", lambda name: None)
    with pytest.raises(azure_cli.CliUnavailable, match="not installed"):
        await azure_cli.get_token("tenant-a")


@pytest.mark.asyncio
async def test_a_signed_out_cli_names_the_command_to_run(monkeypatch):
    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec(
        returncode=1,
        stderr=b"Please run 'az login' to setup account.",
    ))
    with pytest.raises(azure_cli.CliUnavailable, match="az login"):
        await azure_cli.get_token("tenant-a")


@pytest.mark.asyncio
async def test_tenants_are_collected_from_the_subscription_list(monkeypatch):
    accounts = json.dumps([
        {"tenantId": "t1", "tenantDisplayName": "Contoso", "user": {"name": "a@b.com"}},
        {"tenantId": "t1", "tenantDisplayName": "Contoso", "user": {"name": "a@b.com"}},
        {"tenantId": "t2", "user": {"name": "a@b.com"}},
    ]).encode()
    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec(stdout=accounts))

    tenants = await azure_cli.list_tenants()
    by_id = {t["tenant_id"]: t for t in tenants}
    assert by_id["t1"]["subscription_count"] == 2
    assert by_id["t1"]["tenant_name"] == "Contoso"
    # No display name from an older CLI means the id, not an invented label.
    assert by_id["t2"]["tenant_name"] == "t2"


@pytest.mark.asyncio
async def test_status_separates_not_installed_from_signed_out(monkeypatch):
    monkeypatch.setattr(azure_cli.shutil, "which", lambda name: None)
    missing = await azure_cli.status()
    assert missing["available"] is False

    monkeypatch.setattr(azure_cli.shutil, "which", lambda name: "/usr/bin/az")
    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec(
        returncode=1, stderr=b"Please run 'az login'.",
    ))
    out = await azure_cli.status()
    assert out["available"] is True and out["signed_in"] is False
    assert "az login" in out["reason"]


# --- signing in from the browser -----------------------------------------

DEVICE_LINE = (
    b"To sign in, use a web browser to open the page "
    b"https://microsoft.com/devicelogin and enter the code F7X2K9QRT to authenticate.\n"
)


class FakeLoginProc:
    """An `az login` that prints the device line, then finishes when told to."""

    def __init__(self, lines, returncode=0):
        self.stdout = self
        self.returncode = returncode
        self._lines = list(lines)
        self.pid = 4242
        self.killed = False
        self.done = asyncio.Event()

    async def readline(self):
        if self._lines:
            return self._lines.pop(0)
        await self.done.wait()
        return b""

    async def wait(self):
        await self.done.wait()
        return self.returncode

    def kill(self):
        self.killed = True
        self.done.set()


@pytest.fixture
def login_proc(monkeypatch):
    proc = FakeLoginProc([DEVICE_LINE])
    calls = []

    async def _exec(program, *args, **kwargs):
        calls.append([program, *args])
        return proc

    monkeypatch.setattr(asyncio, "create_subprocess_exec", _exec)
    monkeypatch.setattr(azure_cli, "list_tenants", _fake_tenants)
    proc.calls = calls
    yield proc
    proc.done.set()


async def _fake_tenants():
    return [{
        "tenant_id": "t1", "tenant_name": "Contoso",
        "account": "a@b.com", "subscription_count": 2,
    }]


@pytest.mark.asyncio
async def test_login_publishes_the_device_code(login_proc):
    out = await azure_cli.begin_login()
    assert out["state"] == "pending"
    assert out["code"] == "F7X2K9QRT"
    assert "devicelogin" in out["url"]
    await azure_cli.cancel_login()


@pytest.mark.asyncio
async def test_login_uses_the_device_code_flow(login_proc):
    """A browser-driven login must never wait on a redirect to the server."""
    await azure_cli.begin_login()
    assert "--use-device-code" in login_proc.calls[0]
    await azure_cli.cancel_login()


@pytest.mark.asyncio
async def test_a_finished_login_reports_the_account(login_proc):
    await azure_cli.begin_login()
    login_proc.done.set()
    for _ in range(40):
        if azure_cli.login_status()["state"] == "complete":
            break
        await asyncio.sleep(0.02)
    out = azure_cli.login_status()
    assert out["state"] == "complete"
    assert out["account"] == "a@b.com"
    # The code is not left on screen once it has been used.
    assert out["code"] == ""


@pytest.mark.asyncio
async def test_a_new_login_discards_the_previous_accounts_tokens(login_proc):
    azure_cli._tokens["t1|arm"] = {"token": "stale", "expires_at": time.time() + 9999}
    await azure_cli.begin_login()
    login_proc.done.set()
    for _ in range(40):
        if azure_cli.login_status()["state"] == "complete":
            break
        await asyncio.sleep(0.02)
    assert azure_cli._tokens == {}


@pytest.mark.asyncio
async def test_a_second_login_does_not_race_the_first(login_proc):
    first = await azure_cli.begin_login()
    second = await azure_cli.begin_login()
    assert second["code"] == first["code"]
    assert len(login_proc.calls) == 1
    await azure_cli.cancel_login()


@pytest.mark.asyncio
async def test_cancelling_stops_the_waiting_process(login_proc):
    await azure_cli.begin_login()
    out = await azure_cli.cancel_login()
    assert out["state"] == "idle"
    assert login_proc.killed is True


@pytest.mark.asyncio
async def test_login_needs_the_cli_to_exist(monkeypatch):
    monkeypatch.setattr(azure_cli.shutil, "which", lambda name: None)
    with pytest.raises(azure_cli.CliUnavailable, match="not installed"):
        await azure_cli.begin_login()
