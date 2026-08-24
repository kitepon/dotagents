#!/usr/bin/env python3
"""Cursor sessionStart / stop frontend for the todo gate."""

import os
from pathlib import Path
import runpy


os.environ["DOTAGENTS_HOOK_HOST"] = "cursor"
runpy.run_path(str(Path(__file__).resolve().parent / "todo-gate-hook.sh"), run_name="__main__")
