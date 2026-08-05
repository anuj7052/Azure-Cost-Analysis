from __future__ import annotations

from datetime import date

from app.services.periods import (
    full_month,
    last_n_days,
    month_to_date,
    previous_month,
    run_rate_forecast,
)
from app.services.security_service import analyze_nsg_rules, classify_expiry


def test_month_to_date_starts_on_the_first():
    period = month_to_date(date(2026, 3, 17))
    assert period.start == date(2026, 3, 1)
    assert period.end == date(2026, 3, 17)


def test_previous_month_handles_january():
    period = previous_month(date(2026, 1, 10))
    assert period.start == date(2025, 12, 1)
    assert period.end == date(2025, 12, 31)


def test_full_month_covers_leap_february():
    assert full_month(date(2028, 2, 5)).end == date(2028, 2, 29)


def test_last_n_days_is_inclusive():
    assert last_n_days(7, date(2026, 5, 10)).days == 7


def test_run_rate_projects_to_month_end():
    # 300 spent over 10 of 31 days -> 930 projected
    assert run_rate_forecast(300.0, date(2026, 1, 10)) == 930.0


def test_nsg_analysis_flags_ssh_from_internet():
    exposures = analyze_nsg_rules(
        [
            {
                "nsgId": "/subscriptions/s/nsg1",
                "nsgName": "nsg1",
                "ruleName": "allow-ssh",
                "direction": "Inbound",
                "access": "Allow",
                "protocol": "Tcp",
                "priority": 100,
                "sourcePrefix": "Internet",
                "destPort": "22",
            }
        ]
    )
    assert len(exposures) == 1
    assert exposures[0]["ports"] == [22]
    assert exposures[0]["severity"] == "high"


def test_nsg_analysis_flags_wildcard_port_as_critical():
    exposures = analyze_nsg_rules(
        [
            {
                "nsgId": "/subscriptions/s/nsg2",
                "nsgName": "nsg2",
                "ruleName": "allow-all",
                "direction": "Inbound",
                "access": "Allow",
                "priority": 200,
                "sourcePrefix": "*",
                "destPort": "*",
            }
        ]
    )
    assert exposures[0]["severity"] == "critical"


def test_nsg_analysis_ignores_scoped_and_outbound_rules():
    rules = [
        {
            "nsgId": "n",
            "ruleName": "internal-ssh",
            "direction": "Inbound",
            "access": "Allow",
            "sourcePrefix": "10.0.0.0/8",
            "destPort": "22",
        },
        {
            "nsgId": "n",
            "ruleName": "deny-ssh",
            "direction": "Inbound",
            "access": "Deny",
            "sourcePrefix": "*",
            "destPort": "22",
        },
        {
            "nsgId": "n",
            "ruleName": "outbound",
            "direction": "Outbound",
            "access": "Allow",
            "sourcePrefix": "*",
            "destPort": "22",
        },
    ]
    assert analyze_nsg_rules(rules) == []


def test_certificate_expiry_classification():
    from datetime import datetime, timedelta, timezone

    now = datetime.now(timezone.utc)
    assert classify_expiry(now + timedelta(days=3))[1] == "critical"
    assert classify_expiry(now + timedelta(days=20))[1] == "warning"
    assert classify_expiry(now + timedelta(days=200))[1] == "ok"
    assert classify_expiry(None)[1] == "ok"
