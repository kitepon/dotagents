import importlib.util
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("lattice_hook", ROOT / "lib/lattice-hook.py")
hook = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hook)


def response():
    return {
        "schema": "lattice.session_context.v1",
        "status": {"schema": "lattice.project_status.v1", "state": "active_run"},
        "todo": {
            "schema": "lattice.todo_status_result.v7", "project_id": "test",
            "active_set": [{"plan_key": "plan", "task_id": "task", "label": "修理", "unmet_dependencies": []}],
            "next_ready": [], "member_heads": [], "audit_pending": [],
            "structure_finalization_pending": [],
            "parallel_candidates": [{"unreadable_reason": "new-field", "coverage": None}],
        },
        "independence": [],
    }


def parse(value):
    return hook.parse_session_context(json.dumps(value).encode())


class SessionContextTest(unittest.TestCase):
    def test_public_session_contract_accepts_new_todo_versions(self):
        for version in ("v7", "v99"):
            value = response()
            value["todo"]["schema"] = "lattice.todo_status_result." + version
            value["todo"]["future"] = {"data": [None]}
            value["todo"]["active_set"][0]["future"] = True
            context = parse(value)
            self.assertIsNotNone(context)
            self.assertIn("修理", hook.status_message(ROOT, context["todo"]))

    def test_display_fields_still_validate(self):
        for bad in (42, "bad\nlabel", "a" * 161):
            value = response()
            value["todo"]["active_set"][0]["label"] = bad
            self.assertIsNone(parse(value))
        value = response()
        value["todo"]["active_set"] *= 2001
        self.assertIsNone(parse(value))
        value = response()
        value["schema"] = "lattice.session_context.v2"
        self.assertIsNone(parse(value))

    def test_product_next_action_keeps_finalization_visible(self):
        value = response()
        value["todo"]["active_set"] = []
        value["status"]["next_action"] = {"command": "lattice todo status", "reason": "structure_finalization_pending"}
        context = parse(value)
        self.assertIsNotNone(context)
        self.assertTrue(hook.has_guidance(context["todo"]))
        self.assertIn("lattice todo status", hook.status_message(ROOT, context["todo"]))
        value["status"]["next_action"]["reason"] = "no_ready_task"
        self.assertFalse(hook.has_guidance(parse(value)["todo"]))

    def test_next_action_is_display_only_and_bounded(self):
        value = response()
        value["status"]["next_action"] = {"command": "bad\ncommand", "reason": "pending"}
        self.assertIsNone(parse(value))

    def test_uninitialized_product_action_needs_no_todo_reason(self):
        value = response()
        value["todo"] = None
        value["status"]["state"] = "uninitialized"
        value["status"]["next_action"] = {
            "command": "lattice plan create --input .lattice/plan-create.json",
            "input_schema": "lattice.plan_create_input.v1",
            "schema_command": "lattice plan create --schema",
        }
        context = parse(value)
        self.assertIsNotNone(context)
        self.assertIsNone(context["todo"])

    def test_large_valid_frontier_fits_capture_limit(self):
        value = response()
        value["todo"]["next_ready"] = [{"plan_key": "p", "task_id": "t", "label": "t"}] * 513
        self.assertLess(len(json.dumps(value).encode()), hook.CAPTURE_LIMIT)
        self.assertEqual(len(parse(value)["todo"]["next_ready"]), 513)

    def test_member_state_invalid_values_and_legacy_omission(self):
        for state in ([], None, 1, "unknown"):
            value = response()
            value["todo"]["member_heads"] = [{"reconciliation_state": state}]
            self.assertIsNone(parse(value))
        value = response()
        value["todo"]["member_heads"] = [{"reconciliation_state": "reconciled"}, {}]
        context = parse(value)
        self.assertEqual(context["todo"]["member_heads"], value["todo"]["member_heads"])
        self.assertNotIn("校正状態:", hook.status_message(ROOT, context["todo"]))


if __name__ == "__main__":
    unittest.main()
