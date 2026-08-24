#!/usr/bin/env python3
"""Cursor Task / subagentStart frontend for the delegation gate."""

import os
from pathlib import Path
import runpy


os.environ["DOTAGENTS_HOOK_HOST"] = "cursor"
runpy.run_path(str(Path(__file__).resolve().parent / "delegation-gate-hook.sh"), run_name="__main__")
