"""
The Azure CLI as a credential source.

What this removes, and what it does not.

An operator running this on their own machine has already signed in to Azure —
`az login` put a token cache on disk that carries exactly the rights they hold
in the directory. Asking them to also create an app registration, grant it
Cost Management Reader, copy a client secret into a form, and repeat the whole
exercise for every tenant they own is asking them to re-issue a credential they
already have. Worse, the alternative people reach for is pasting a session
token out of the portal, which expires in about an hour and has to be pasted
again every time.

So when `AZURE_CLI_AUTH` is on, the CLI becomes a credential source alongside
the stored ones, and neither a service principal nor a pasted token is needed
for any tenant the signed-in CLI account can reach.

It does **not** remove the app registration used to sign in to this product.
That token answers "who is calling", and the answer cannot come from a CLI
sitting on the server: every user of a hosted deployment would resolve to the
same machine account, which is an authentication bypass rather than a
convenience. This is why the flag defaults to off and why enabling it is
refused outright in production — the CLI identity belongs to whoever runs the
process, and handing it to every caller is only safe when those are the same
person.

Tokens are read by running `az`, not by parsing its token cache. The cache
format is undocumented, differs per platform and changes between releases, and
a token read from it would bypass the CLI's own refresh — so the first expiry
would fail in a way nobody could diagnose.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import shutil
import time
from typing import Any, Dict, List, Optional

log = logging.getLogger(__name__)

ARM_RESOURCE = "https://management.azure.com/"

# The CLI takes a noticeable moment on a cold token cache, and rather longer
# when it decides to refresh. Long enough to allow that, short enough that a
# hung `az` cannot wedge a request for ever.
CLI_TIMEOUT = 45.0

# A token is reused until a minute before it expires. Shelling out per request
# would add hundreds of milliseconds to every Azure call on a page that makes
# a dozen of them, and the token is valid for an hour regardless.
_EXPIRY_MARGIN = 60

_tokens: Dict[str, Dict[str, Any]] = {}


class CliUnavailable(RuntimeError):
    """The CLI could not answer. The message is written to be shown to a user."""


def cli_installed() -> bool:
    return shutil.which("az") is not None


async def _run(args: List[str]) -> Any:
    """Run `az` and return its parsed JSON, or raise something explainable."""
    if not cli_installed():
        raise CliUnavailable(
            "The Azure CLI is not installed on the machine running this "
            "service, so CLI sign-in cannot be used."
        )

    try:
        proc = await asyncio.create_subprocess_exec(
            "az", *args, "--output", "json",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=CLI_TIMEOUT)
    except asyncio.TimeoutError:
        raise CliUnavailable(
            "The Azure CLI did not respond within "
            f"{int(CLI_TIMEOUT)} seconds. It may be waiting for an interactive "
            "sign-in, which it cannot complete from here."
        )
    except OSError as exc:
        raise CliUnavailable(f"The Azure CLI could not be started: {exc}")

    if proc.returncode != 0:
        message = (stderr or b"").decode("utf-8", "replace").strip()
        # The CLI's own wording for "you are signed out" is long and mentions
        # several commands. Only the instruction is useful here.
        if "az login" in message.lower():
            raise CliUnavailable(
                "The Azure CLI is installed but not signed in. Run `az login` "
                "on the machine running this service."
            )
        raise CliUnavailable(message or "The Azure CLI failed without saying why.")

    try:
        return json.loads((stdout or b"").decode("utf-8", "replace") or "null")
    except json.JSONDecodeError:
        raise CliUnavailable("The Azure CLI returned something that was not JSON.")


async def get_token(tenant_id: str, resource: str = ARM_RESOURCE) -> str:
    """
    An ARM access token for one tenant, from the signed-in CLI account.

    `--tenant` is always passed, even for the CLI's current tenant. Without it
    the CLI answers for whichever subscription happens to be the default, which
    on a machine with several directories silently returns a token for the
    wrong one — and a token for the wrong tenant fails much later, as an empty
    subscription list rather than as an authentication error.
    """
    key = f"{tenant_id}|{resource}"
    cached = _tokens.get(key)
    if cached and cached["expires_at"] - _EXPIRY_MARGIN > time.time():
        return cached["token"]

    payload = await _run([
        "account", "get-access-token",
        "--resource", resource,
        "--tenant", tenant_id,
    ])
    token = (payload or {}).get("accessToken")
    if not token:
        raise CliUnavailable("The Azure CLI returned no access token.")

    # `expires_on` is a unix timestamp and `expiresOn` a local-time string with
    # no zone. Only the first can be compared without guessing a timezone, so
    # a missing one falls back to a conservative half hour rather than to a
    # parse that could be an hour out in either direction.
    try:
        expires_at = float(payload.get("expires_on"))
    except (TypeError, ValueError):
        expires_at = time.time() + 1800

    _tokens[key] = {"token": token, "expires_at": expires_at}
    return token


async def list_tenants() -> List[Dict[str, str]]:
    """
    Every tenant the signed-in CLI account can reach, from its subscriptions.

    `az account list` is used rather than `az account tenant list`, which is an
    extension that is not installed by default. The subscription list already
    carries the tenant of each subscription, and a tenant with no subscription
    the account can see is one this product would have nothing to show for.
    """
    accounts = await _run(["account", "list", "--all"])
    seen: Dict[str, Dict[str, Any]] = {}
    for entry in accounts or []:
        tenant_id = entry.get("tenantId") or ""
        if not tenant_id:
            continue
        found = seen.setdefault(tenant_id, {
            "tenant_id": tenant_id,
            # `tenantDisplayName` appears only on newer CLI versions, so the id
            # is the fallback rather than an invented name.
            "tenant_name": entry.get("tenantDisplayName") or tenant_id,
            "account": (entry.get("user") or {}).get("name") or "",
            "subscription_count": 0,
        })
        found["subscription_count"] += 1
    return sorted(seen.values(), key=lambda t: t["tenant_name"].lower())


async def status() -> Dict[str, Any]:
    """
    Whether CLI sign-in is usable, and if not, what to do about it.

    Returned to the Settings page so it can say "not installed", "installed but
    signed out" and "ready" as three different things. Collapsing them into one
    disabled button was the version of this that told nobody anything.
    """
    if not cli_installed():
        return {
            "available": False, "signed_in": False, "account": "", "tenants": [],
            "reason": "The Azure CLI is not installed on the machine running this service.",
        }
    try:
        tenants = await list_tenants()
    except CliUnavailable as exc:
        return {
            "available": True, "signed_in": False, "account": "", "tenants": [],
            "reason": str(exc),
        }
    return {
        "available": True,
        "signed_in": bool(tenants),
        "account": tenants[0]["account"] if tenants else "",
        "tenants": tenants,
        "reason": "" if tenants else (
            "The Azure CLI is signed in but the account can see no "
            "subscriptions, so there is nothing to read."
        ),
    }


def forget(tenant_id: Optional[str] = None) -> None:
    """Drop cached tokens, for a re-login or a sign-out."""
    if tenant_id is None:
        _tokens.clear()
        return
    for key in [k for k in _tokens if k.startswith(f"{tenant_id}|")]:
        _tokens.pop(key, None)


# --------------------------------------------------------------------------
# Signing the CLI in from the browser.
#
# `az login` normally opens a browser on the machine it runs on and waits for
# a redirect to localhost. Driven from a web page that is the wrong machine
# often enough to be useless, and on a headless host it is always wrong.
#
# The device-code flow is the one that survives the split: the CLI prints a
# short code, the person types it into microsoft.com/devicelogin in whatever
# browser they already have, and the CLI picks the result up. Nothing is
# proxied through this service, so no password or token ever passes through
# it -- which is why this is a safer button than a form asking for the same
# thing.
#
# One login may be in flight at a time. Two would race for the same on-disk
# token cache, and the second would clobber the first's answer.
# --------------------------------------------------------------------------

LOGIN_TIMEOUT = 300.0

_login: Dict[str, Any] = {"state": "idle"}
_login_task: Optional[asyncio.Task] = None

# The CLI's device-code line has been reworded more than once, so the code is
# matched by shape -- a run of at least eight capitals and digits -- rather
# than by the sentence around it.
_CODE = re.compile(r"\b([A-Z0-9]{8,})\b")
_URL = re.compile(r"(https://\S*devicelogin\S*)")


def _reset_login(**fields: Any) -> Dict[str, Any]:
    _login.clear()
    _login.update({"state": "idle", "code": "", "url": "", "message": "", "account": ""})
    _login.update(fields)
    return dict(_login)


async def _drive_login(args: List[str]) -> None:
    """Run `az login`, publish the device code, and record how it ended."""
    try:
        proc = await asyncio.create_subprocess_exec(
            "az", *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            stdin=asyncio.subprocess.DEVNULL,
        )
    except OSError as exc:
        _reset_login(state="failed", message=f"The Azure CLI could not be started: {exc}")
        return

    _login["pid"] = proc.pid
    tail: List[str] = []

    async def pump() -> None:
        assert proc.stdout is not None
        while True:
            raw = await proc.stdout.readline()
            if not raw:
                return
            line = raw.decode("utf-8", "replace").strip()
            if not line:
                continue
            tail.append(line)
            del tail[:-8]
            if _login.get("state") == "starting":
                # The instruction sentence carries both halves. Publishing the
                # code before the URL would leave the page telling somebody to
                # type a code with nowhere to type it.
                found = _CODE.search(line)
                url = _URL.search(line)
                if found and url:
                    _login.update({
                        "state": "pending",
                        "code": found.group(1),
                        "url": url.group(1),
                        "message": line,
                    })

    try:
        await asyncio.wait_for(asyncio.gather(pump(), proc.wait()), timeout=LOGIN_TIMEOUT)
    except asyncio.TimeoutError:
        proc.kill()
        _reset_login(
            state="failed",
            message=(
                "The sign-in was not completed within five minutes, so it was "
                "cancelled. Start it again when you are ready to enter the code."
            ),
        )
        return
    except asyncio.CancelledError:
        proc.kill()
        raise

    if proc.returncode != 0:
        _reset_login(state="failed", message="\n".join(tail[-3:]) or "The sign-in failed.")
        return

    # A fresh login means fresh rights. Any token cached against the previous
    # account would otherwise keep answering for it until it expired.
    forget()
    try:
        tenants = await list_tenants()
    except CliUnavailable as exc:
        _reset_login(state="failed", message=str(exc))
        return

    _reset_login(
        state="complete",
        account=tenants[0]["account"] if tenants else "",
        message=(
            f"Signed in. {len(tenants)} tenant{'' if len(tenants) == 1 else 's'} available."
            if tenants else
            "Signed in, but this account can see no subscriptions."
        ),
    )


async def begin_login(tenant_id: Optional[str] = None) -> Dict[str, Any]:
    """Start a device-code sign-in and return as soon as the code is known."""
    global _login_task

    if not cli_installed():
        raise CliUnavailable(
            "The Azure CLI is not installed on the machine running this "
            "service, so it cannot be signed in from here."
        )
    if _login.get("state") in ("starting", "pending"):
        return dict(_login)

    args = ["login", "--use-device-code", "--output", "json"]
    # Without this the CLI treats an account with no subscriptions as a failed
    # login, which is wrong for a directory that is only being read for
    # identity or advisory data.
    args.append("--allow-no-subscriptions")
    if tenant_id:
        args += ["--tenant", tenant_id]

    _reset_login(state="starting")
    _login_task = asyncio.create_task(_drive_login(args))

    # Wait briefly for the code rather than making the page poll for something
    # that almost always arrives within a second.
    for _ in range(60):
        if _login.get("state") != "starting":
            break
        await asyncio.sleep(0.25)
    return dict(_login)


def login_status() -> Dict[str, Any]:
    return dict(_login) if _login.get("state") else _reset_login()


async def cancel_login() -> Dict[str, Any]:
    global _login_task
    if _login_task and not _login_task.done():
        _login_task.cancel()
        try:
            await _login_task
        except (asyncio.CancelledError, Exception):
            pass
    _login_task = None
    return _reset_login(state="idle", message="Sign-in cancelled.")
