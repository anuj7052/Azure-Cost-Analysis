"""
What happens when an account has not connected a model endpoint.

This is the one place in the app where a request would otherwise be paid for
by whoever is hosting it, rather than by the person making it. Everything
else runs on the customer's own Azure credentials. So the assistant runs on
the customer's own model key, and the interesting question is not whether it
refuses -- it is whether it refuses in a way that tells the truth.

An empty key handed to a provider comes back as an authentication failure,
which reads as "your key is wrong" to someone who never had a key. That is
the failure these tests exist to prevent.
"""
import pytest

from core.config import settings
from services import integration_service as svc


@pytest.fixture
async def db(tmp_path, monkeypatch):
    import aiosqlite
    import core.db as core_db

    path = str(tmp_path / "t.db")
    monkeypatch.setattr(core_db, "DB_PATH", path)
    monkeypatch.setattr(settings, "DB_BACKEND", "sqlite")
    await core_db.init_db()

    async with aiosqlite.connect(path) as conn:
        conn.row_factory = aiosqlite.Row
        yield conn


@pytest.fixture(autouse=True)
def hosted(monkeypatch):
    """The hosted product: the operator has set no key of their own."""
    monkeypatch.setattr(settings, "OPENAI_API_KEY", "")


async def _own_endpoint(db, user_id=1, key="sk-mine", enabled=1):
    await db.execute(
        """INSERT INTO user_integrations
           (user_id, label, kind, base_url, model, api_key, enabled, rate_limit_per_day)
           VALUES (?, 'mine', 'openai', '', 'gpt-4o', ?, ?, 100)""",
        (user_id, key, enabled),
    )
    await db.commit()


# ── it refuses, rather than borrowing someone else's key ─────────────────────

async def test_an_account_with_no_endpoint_is_refused(db):
    with pytest.raises(svc.NoEndpointConfigured):
        await svc.llm_config(db, 1)


async def test_a_signed_out_caller_is_refused(db):
    with pytest.raises(svc.NoEndpointConfigured):
        await svc.llm_config(db, None)


async def test_a_disabled_endpoint_does_not_count(db):
    # Turning an endpoint off has to mean off. Falling through to a shared key
    # would make "disabled" mean "billed to someone else instead".
    await _own_endpoint(db, enabled=0)

    with pytest.raises(svc.NoEndpointConfigured):
        await svc.llm_config(db, 1)


async def test_an_endpoint_saved_without_a_key_does_not_count(db):
    await _own_endpoint(db, key="")

    with pytest.raises(svc.NoEndpointConfigured):
        await svc.llm_config(db, 1)


async def test_another_accounts_endpoint_is_not_borrowed(db):
    await _own_endpoint(db, user_id=2)

    with pytest.raises(svc.NoEndpointConfigured):
        await svc.llm_config(db, 1)


# ── the message has to be usable ─────────────────────────────────────────────

async def test_the_message_says_where_to_go(db):
    with pytest.raises(svc.NoEndpointConfigured) as caught:
        await svc.llm_config(db, 1)

    assert "Settings" in str(caught.value)


async def test_the_message_says_who_pays(db):
    # People are reasonably wary of pasting a key into a hosted app. Saying
    # plainly that the requests go to their endpoint is the answer to the
    # question they are actually asking.
    with pytest.raises(svc.NoEndpointConfigured) as caught:
        await svc.llm_config(db, 1)

    assert "billed to your account" in str(caught.value)


async def test_the_message_says_the_rest_still_works(db):
    # Without this, a refusal on one page reads as the whole product being
    # unusable until you hand over a key.
    with pytest.raises(svc.NoEndpointConfigured) as caught:
        await svc.llm_config(db, 1)

    assert "rest of the app works without this" in str(caught.value)


# ── a configured account is unaffected ───────────────────────────────────────

async def test_an_account_with_an_endpoint_gets_it(db):
    await _own_endpoint(db)

    config = await svc.llm_config(db, 1)

    assert config["api_key"] == "sk-mine"


async def test_the_integration_id_is_carried_so_usage_is_counted(db):
    await _own_endpoint(db)

    assert (await svc.llm_config(db, 1))["integration_id"] is not None


# ── self-hosting still works ─────────────────────────────────────────────────

async def test_an_operator_who_sets_a_key_still_gets_the_fallback(db, monkeypatch):
    # Running this privately, where the operator and the users are the same
    # people, a shared key is convenient rather than a liability.
    monkeypatch.setattr(settings, "OPENAI_API_KEY", "sk-operator")

    assert (await svc.llm_config(db, 1))["source"] == "platform"
