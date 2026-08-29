"""
Speaking Postgres while the code keeps writing SQLite.

The application holds roughly two hundred hand-written SQL statements, and
`get_db` is the single place they all get a connection from. That chokepoint is
the whole reason this port is a module rather than a rewrite of forty-seven
files: everything above it can keep passing `?` placeholders and reading rows
by name, and this layer makes that mean the right thing to asyncpg.

The one genuinely dangerous piece is placeholder translation, so it is worth
being explicit about why it is safe. Turning `?` into `$1, $2, ...` is
positional and carries no meaning -- it does not parse, rewrite or reorder
anything. The only way it can go wrong is by rewriting a question mark that
was never a placeholder, which means one inside a string literal, so that is
the case the scanner exists to handle and the case most of the tests are
about.

What this deliberately does NOT do is translate SQL dialect. A layer that
quietly rewrites date functions and upserts is a small ORM with none of an
ORM's testing, and its failure mode is a query that is *almost* right --
silently wrong data in an application whose entire job is telling people the
truth about their money. Dialect differences are fixed at the source instead,
in portable SQL that both engines read the same way.
"""
from __future__ import annotations


def translate(sql: str) -> str:
    """
    Rewrite `?` placeholders as `$1`, `$2`, ... leaving everything else alone.

    Question marks inside quoted strings are left untouched. SQL uses doubled
    quotes to escape a quote inside a literal (`'it''s'`), which needs no
    special handling here: the closing quote ends the literal and the next one
    immediately opens another, so the scanner stays outside the literal for
    exactly zero characters and any `?` in between is still correctly seen as
    quoted.
    """
    return _scan(sql)[0]


def placeholder_count(sql: str) -> int:
    """
    How many parameters a statement expects.

    Worth having separately so that a mismatch between the SQL and the tuple
    passed to it is reported as that, rather than as an asyncpg error about a
    parameter number that nothing in the source code contains.
    """
    return _scan(sql)[1]


def _scan(sql: str) -> tuple[str, int]:
    out: list[str] = []
    index = 0
    quote: str | None = None

    for char in sql:
        if quote:
            # Inside a literal or a quoted identifier: copy verbatim.
            if char == quote:
                quote = None
            out.append(char)
            continue

        if char in ("'", '"'):
            quote = char
            out.append(char)
            continue

        if char == "?":
            index += 1
            out.append(f"${index}")
            continue

        out.append(char)

    return "".join(out), index
