import pytest


@pytest.fixture(autouse=True)
def _all_benchmark_sources(monkeypatch):
    """Tests exercise the leaderboard cache; the product default is HF only."""
    monkeypatch.setenv("WHICHLLM_ALL_SOURCES", "1")
