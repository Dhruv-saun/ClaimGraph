"""WSGI entry point for production deployment (gunicorn / Render / etc.).

Usage::

    gunicorn wsgi:app
"""

from __future__ import annotations

import os
from pathlib import Path

from claimgraph import ClaimGraph
from claimgraph.api import create_app
from claimgraph.storage import load

DEFAULT_DATASET = "remote_work"
DATA_DIR = Path(__file__).resolve().parent / "data"


def _load_initial_graph() -> ClaimGraph:
    name = os.environ.get("CLAIMGRAPH_DATASET", DEFAULT_DATASET)
    if name == "empty":
        return ClaimGraph()
    path = DATA_DIR / f"{name}.json"
    if not path.exists():
        return ClaimGraph()
    return load(path)


app = create_app(_load_initial_graph())
