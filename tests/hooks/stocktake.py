import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class StocktakeTest(unittest.TestCase):
    def test_both_hosts_ignore_stubs_and_report_actual_checklists(self):
        for frontend in ("todo-gate-hook.sh", "codex-callout-hook.sh"):
            for text, expected in (("# 完了済み計画の案内\n", False), ("- [x] 完了\n", True), ("- [ ] 未完了\n", True)):
                with self.subTest(frontend=frontend, text=text), tempfile.TemporaryDirectory() as temp:
                    repo = Path(temp) / "repo"
                    repo.mkdir()
                    subprocess.run(["git", "init", "-q", str(repo)], check=True)
                    subprocess.run(["git", "-C", str(repo), "-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "fixture"], check=True)
                    (repo / "docs").mkdir()
                    (repo / "docs/plan_example.md").write_text(text)
                    env = {**os.environ, "HOME": temp, "XDG_CACHE_HOME": temp, "XDG_STATE_HOME": temp}
                    result = subprocess.run([sys.executable, str(ROOT / "bin" / frontend), "session-start"],
                                            input=json.dumps({"session_id": "stocktake", "source": "startup", "cwd": str(repo)}),
                                            text=True, capture_output=True, env=env, check=True)
                    self.assertEqual("INFO: docs/" in result.stdout, expected, result.stdout)


if __name__ == "__main__":
    unittest.main()
