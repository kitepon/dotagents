#!/usr/bin/env python3
"""Claude PreToolUse frontend for the responsibility boundary gate."""

import importlib.util
from pathlib import Path


CORE = Path(__file__).resolve().parents[1] / "lib/boundary-gate.py"
try:
    spec = importlib.util.spec_from_file_location("dotagents_boundary_gate", CORE)
    if spec is not None and spec.loader is not None:
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        module.main("claude")
except Exception:
    pass
