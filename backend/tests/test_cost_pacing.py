"""
Pacing the Cost Management query API.

Backing off after a 429 was never enough. The request that earned the 429 is
already spent, the retry spends another, and a scope being asked for more than
its share never escapes -- each wave of retries becomes the next wave of
requests. These tests pin the behaviour that breaks that loop: wait for a turn
*before* sending, and learn the real limit from the refusals.
"""
import time

import pytest

from services import cost_client


@pytest.fixture(autouse=True)
def clean_scope_state(monkeypatch):
    monkeypatch.setattr(cost_client, "_scope_sent", {})
    monkeypatch.setattr(cost_client, "_scope_rate", {})
    monkeypatch.setattr(cost_client, "_throttled_until", {})


class TestAllowance:
    def test_a_scope_under_its_allowance_sends_immediately(self):
        """Pacing must be invisible to an estate that is not overusing Azure."""
        for _ in range(int(cost_client.SCOPE_RATE_PER_MINUTE) - 1):
            cost_client._record_send("sub-1")

        assert cost_client._pace_wait("sub-1") == 0

    def test_a_scope_at_its_allowance_waits_for_the_oldest_to_age_out(self):
        for _ in range(int(cost_client.SCOPE_RATE_PER_MINUTE)):
            cost_client._record_send("sub-1")

        wait = cost_client._pace_wait("sub-1")
        assert 0 < wait <= 60

    def test_one_busy_subscription_does_not_pace_another(self):
        """
        Azure meters per scope, so borrowing one subscription's exhaustion to
        delay a different one would be a limit we invented ourselves.
        """
        for _ in range(int(cost_client.SCOPE_RATE_PER_MINUTE) * 2):
            cost_client._record_send("sub-1")

        assert cost_client._pace_wait("sub-2") == 0

    def test_requests_older_than_a_minute_no_longer_count(self):
        cost_client._scope_sent["sub-1"] = [
            time.time() - 61 for _ in range(int(cost_client.SCOPE_RATE_PER_MINUTE) * 2)
        ]

        assert cost_client._pace_wait("sub-1") == 0


class TestLearningTheLimit:
    """
    Azure does not publish the figure and it varies by agreement, so the
    allowance is a guess that corrects itself.
    """

    def test_a_refusal_halves_the_allowance(self):
        cost_client._penalise("sub-1")

        assert cost_client._rate_of("sub-1") == cost_client.SCOPE_RATE_PER_MINUTE / 2

    def test_the_allowance_never_reaches_zero(self):
        """A scope that stopped asking entirely could never learn it was forgiven."""
        for _ in range(20):
            cost_client._penalise("sub-1")

        assert cost_client._rate_of("sub-1") == cost_client.MIN_SCOPE_RATE

    def test_success_edges_the_allowance_back_up(self):
        cost_client._penalise("sub-1")
        reduced = cost_client._rate_of("sub-1")

        cost_client._reward("sub-1")

        assert cost_client._rate_of("sub-1") > reduced

    def test_recovery_stops_at_the_ceiling(self):
        for _ in range(50):
            cost_client._reward("sub-1")

        assert cost_client._rate_of("sub-1") == cost_client.SCOPE_RATE_PER_MINUTE
