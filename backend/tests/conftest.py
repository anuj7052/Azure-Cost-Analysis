"""
Shared fixtures.

Nothing here changes what the code does -- it resets the caches that the code
deliberately keeps for the life of the process, so that one test's answer
cannot become another test's starting point.
"""
import pytest

from services import azure_metrics


@pytest.fixture(autouse=True)
def _forget_cached_metric_definitions():
    """
    Start every test with an empty metric-definitions cache.

    The cache is keyed by resource id and lives for the life of the process,
    which is right in production -- what a VM publishes changes only when
    somebody installs the diagnostics agent -- and wrong in a suite where
    every test reuses the same handful of fake resource ids. Without this, a
    test that stubs a rich catalogue silently supplies it to the next test
    that expects an empty one, and the failure appears in whichever test
    happens to run second.
    """
    azure_metrics.clear_definitions_cache()
    yield
    azure_metrics.clear_definitions_cache()
