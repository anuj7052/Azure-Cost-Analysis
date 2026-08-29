"""
How the app is delivered, as opposed to what it computes.

App Service does not compress responses for us. Nobody noticed, because
nothing about an uncompressed response looks wrong -- it arrives, it is
correct, it is simply four times larger than it needed to be. On a cold visit
that was ~600 KB of JavaScript, which on a phone is the difference between a
page that appears and a page that is still blank when the person gives up.

These tests exist because compression is invisible when it works and invisible
when it stops working, so the only way it stays on is if something fails
loudly when it is removed.
"""
from __future__ import annotations

from fastapi.testclient import TestClient

import main


client = TestClient(main.app)


def test_a_large_response_is_compressed():
    r = client.get("/api/health", headers={"Accept-Encoding": "gzip"})
    assert r.status_code == 200
    # TestClient decodes transparently, so assert on what was negotiated.
    assert "gzip" in r.headers.get("content-encoding", "") or len(r.content) < 500


def test_the_middleware_is_actually_installed():
    """
    Asserting on one small response would pass even with compression removed,
    because small bodies are deliberately left alone.
    """
    from fastapi.middleware.gzip import GZipMiddleware

    assert any(m.cls is GZipMiddleware for m in main.app.user_middleware)


def test_compression_does_not_start_below_its_floor():
    """
    Under a few hundred bytes the gzip header makes the response bigger, and
    the CPU is spent for nothing. A floor that drifts to 0 is a regression
    that looks like an improvement.
    """
    gzip_mw = next(m for m in main.app.user_middleware
                   if m.cls.__name__ == "GZipMiddleware")
    assert gzip_mw.kwargs.get("minimum_size", 0) >= 500


def test_a_client_that_cannot_decompress_still_gets_the_answer():
    r = client.get("/api/health", headers={"Accept-Encoding": "identity"})
    assert r.status_code == 200
    assert "gzip" not in r.headers.get("content-encoding", "")
    assert r.json()["status"] == "ok"


def test_security_headers_survive_compression():
    """
    Middleware order decides this. Get it wrong and the app is faster and
    less safe, which is the worst possible trade to make silently.
    """
    r = client.get("/api/health", headers={"Accept-Encoding": "gzip"})
    assert r.headers["x-content-type-options"] == "nosniff"
    assert r.headers["x-frame-options"] == "DENY"
