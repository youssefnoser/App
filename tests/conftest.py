"""Shared test isolation.

The committed exposure snapshot (data/exposures.sqlite) exists in every checkout,
so tests must not see it: routes that expect "no snapshot" would otherwise
answer from 1.6 million real rows. Each test starts as if the committed copy
were absent (and SPHEREX_CATALOG_URL unset, so no test reaches Postgres); tests that exercise the committed copy point REPO_DB at their own
file (tests/test_catalog.py).
"""

from pathlib import Path

import pytest

from server import catalog as cat


@pytest.fixture(autouse=True)
def no_repo_snapshot(tmp_path, monkeypatch):
    monkeypatch.setattr(cat, "REPO_DB", tmp_path / "no" / "repo.sqlite")
    # A developer shell may point at the Postgres snapshot; tests never do.
    monkeypatch.delenv("SPHEREX_CATALOG_URL", raising=False)
