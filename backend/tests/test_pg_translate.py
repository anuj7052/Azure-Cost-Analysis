"""
Placeholder translation for the Postgres backend.

This is the one piece of the port that can corrupt data quietly. Everything
else fails loudly -- a wrong table name is an error, a missing column is an
error -- but a question mark rewritten in the wrong place produces a statement
that still runs and means something else. So the interesting tests here are
not "does it work", they are "what does it refuse to touch".
"""
import pytest

from core.pg import placeholder_count, translate


# ── the ordinary case ────────────────────────────────────────────────────────

def test_a_single_placeholder_is_numbered_from_one():
    assert translate("SELECT * FROM users WHERE id = ?") == (
        "SELECT * FROM users WHERE id = $1"
    )


def test_placeholders_are_numbered_in_order():
    assert translate("INSERT INTO t (a, b, c) VALUES (?, ?, ?)") == (
        "INSERT INTO t (a, b, c) VALUES ($1, $2, $3)"
    )


def test_sql_without_placeholders_is_unchanged():
    sql = "SELECT COUNT(*) FROM user_sessions"
    assert translate(sql) == sql


def test_numbering_passes_ten():
    # A naive single-character substitution would produce $1 followed by $0.
    sql = "INSERT INTO t VALUES (" + ", ".join(["?"] * 12) + ")"
    assert "$10" in translate(sql)
    assert "$12" in translate(sql)
    assert placeholder_count(sql) == 12


# ── what it must refuse to touch ─────────────────────────────────────────────

def test_a_question_mark_inside_a_string_is_left_alone():
    sql = "SELECT * FROM t WHERE label = 'why?'"
    assert translate(sql) == sql


def test_a_quoted_question_mark_does_not_consume_a_number():
    # The dangerous version of the bug: the literal is left intact but the
    # counter has already moved on, so every later placeholder is off by one
    # and the statement runs with the arguments shifted.
    assert translate("SELECT ? FROM t WHERE label = 'eh?' AND id = ?") == (
        "SELECT $1 FROM t WHERE label = 'eh?' AND id = $2"
    )


def test_an_escaped_quote_does_not_end_the_literal_early():
    sql = "SELECT * FROM t WHERE label = 'it''s ok? really'"
    assert translate(sql) == sql


def test_a_question_mark_in_a_quoted_identifier_is_left_alone():
    sql = 'SELECT "odd?column" FROM t'
    assert translate(sql) == sql


def test_a_literal_between_two_placeholders_keeps_the_numbering_straight():
    assert translate("UPDATE t SET a = ?, note = 'q?' WHERE id = ?") == (
        "UPDATE t SET a = $1, note = 'q?' WHERE id = $2"
    )


# ── statements taken from the application itself ─────────────────────────────

def test_the_session_continuation_query():
    sql = (
        "SELECT id FROM user_sessions "
        "WHERE user_id = ? AND ended_at IS NULL "
        "ORDER BY id DESC LIMIT 1"
    )
    assert translate(sql).endswith("WHERE user_id = $1 AND ended_at IS NULL ORDER BY id DESC LIMIT 1")


def test_the_session_insert():
    assert translate(
        "INSERT INTO user_sessions (user_id, user_agent, ip_hash) VALUES (?, ?, ?)"
    ) == "INSERT INTO user_sessions (user_id, user_agent, ip_hash) VALUES ($1, $2, $3)"


def test_a_statement_with_a_default_string_in_the_ddl():
    # Schema DDL carries quoted defaults, and is passed through the same path.
    sql = "ALTER TABLE users ADD COLUMN company TEXT NOT NULL DEFAULT ''"
    assert translate(sql) == sql


# ── counting ─────────────────────────────────────────────────────────────────

@pytest.mark.parametrize(
    "sql, expected",
    [
        ("SELECT 1", 0),
        ("SELECT * FROM t WHERE a = ?", 1),
        ("SELECT * FROM t WHERE a = ? AND b = ?", 2),
        ("SELECT * FROM t WHERE a = 'x?'", 0),
    ],
)
def test_the_expected_parameter_count_is_reported(sql, expected):
    assert placeholder_count(sql) == expected


def test_translation_is_stable_under_repetition():
    # Translating an already-translated statement must not invent new
    # parameters, or a retry path would corrupt the query.
    once = translate("SELECT * FROM t WHERE a = ? AND b = ?")
    assert translate(once) == once
