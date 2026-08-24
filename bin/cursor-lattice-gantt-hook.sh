#!/usr/bin/env python3
"""Cursor sessionStart frontend for the shared Lattice Gantt hook."""

import importlib.util
from pathlib import Path


CORE = Path(__file__).resolve().parents[1] / "lib/lattice-hook.py"
try:
    SPEC = importlib.util.spec_from_file_location("dotagents_lattice_hook", CORE)
    if SPEC is not None and SPEC.loader is not None:
        MODULE = importlib.util.module_from_spec(SPEC)
        SPEC.loader.exec_module(MODULE)
        MODULE.main("cursor")
except Exception:
    pass
