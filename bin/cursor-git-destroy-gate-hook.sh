#!/usr/bin/env python3
"""Cursor beforeShellExecution frontend for the git destroy gate."""

import importlib.util
from pathlib import Path


CORE = Path(__file__).resolve().parents[1] / "lib/git-destroy-gate.py"
try:
    spec = importlib.util.spec_from_file_location("dotagents_git_destroy_gate", CORE)
    if spec is not None and spec.loader is not None:
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        module.main("cursor")
except Exception:
    pass
