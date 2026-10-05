# tests/test_run_task.py - Sprint 2 orchestrator (run_task) behavior.
#   python3 tests/test_run_task.py
# Offline: steps use local-only tools (get_time, validate_command,
# get_memory), so no Studio and no MCP server are needed. Follows the
# websockets-stub precedent of tests/test_asset_search.py.
import json
import os
import sys
import types
import unittest

if "websockets" not in sys.modules:
    fake = types.ModuleType("websockets")
    fake.ConnectionClosed = type("ConnectionClosed", (Exception,), {})
    fake.serve = lambda *a, **kw: None
    sys.modules["websockets"] = fake

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

import bridge


def run(goal="test", steps=None, mode="best_effort"):
    return bridge.safe_call("run_task", {"goal": goal, "steps": steps if steps is not None else [],
                                         "mode": mode, "projectId": "test"}, 60)


def body(res):
    return json.loads(res.get("text") or res.get("error") or "{}")


def T(id, tool, args=None, depends_on=None, verify=None):
    s = {"id": id, "tool": tool, "args": args or {}}
    if depends_on:
        s["depends_on"] = depends_on
    if verify:
        s["verify"] = verify
    return s


class RunTaskValidationTest(unittest.TestCase):
    def test_missing_goal_rejected(self):
        r = run(goal="", steps=[T("a", "get_time")])
        self.assertFalse(r["ok"])
        self.assertIn("goal", r["error"])

    def test_empty_steps_rejected(self):
        r = run(steps=[])
        self.assertFalse(r["ok"])
        self.assertIn("steps", r["error"])

    def test_too_many_steps_rejected(self):
        r = run(steps=[T("s%d" % i, "get_time") for i in range(11)])
        self.assertFalse(r["ok"])
        self.assertIn("max 10", r["error"])

    def test_bad_mode_rejected(self):
        r = run(steps=[T("a", "get_time")], mode="yolo")
        self.assertFalse(r["ok"])
        self.assertIn("mode", r["error"])

    def test_missing_id_and_tool_rejected(self):
        r = run(steps=[{"tool": "get_time"}])
        self.assertFalse(r["ok"])
        r = run(steps=[{"id": "a"}])
        self.assertFalse(r["ok"])

    def test_duplicate_id_rejected(self):
        r = run(steps=[T("a", "get_time"), T("a", "get_time")])
        self.assertFalse(r["ok"])
        self.assertIn("duplicate", r["error"])

    def test_unknown_dep_rejected(self):
        r = run(steps=[T("a", "get_time", depends_on=["ghost"])])
        self.assertFalse(r["ok"])
        self.assertIn("unknown step", r["error"])

    def test_self_dep_rejected(self):
        r = run(steps=[T("a", "get_time", depends_on=["a"])])
        self.assertFalse(r["ok"])
        self.assertIn("itself", r["error"])

    def test_cycle_rejected(self):
        r = run(steps=[T("a", "get_time", depends_on=["b"]),
                       T("b", "get_time", depends_on=["a"])])
        self.assertFalse(r["ok"])
        self.assertIn("cycle", r["error"])

    def test_nesting_rejected(self):
        r = run(steps=[T("a", "run_task", {"goal": "x", "steps": []})])
        self.assertFalse(r["ok"])
        self.assertIn("no run_task/batch_queue nesting", r["error"])
        r = run(steps=[T("a", "batch_queue", {"commands": []})])
        self.assertFalse(r["ok"])
        self.assertIn("no run_task/batch_queue nesting", r["error"])

    def test_bad_verify_shape_rejected(self):
        r = run(steps=[T("a", "get_time", verify={"args": {}})])
        self.assertFalse(r["ok"])
        self.assertIn("verify", r["error"])


class RunTaskExecutionTest(unittest.TestCase):
    def test_topological_order(self):
        r = run(goal="order", steps=[
            T("third", "get_time", depends_on=["second"]),
            T("first", "get_time"),
            T("second", "get_time", depends_on=["first"])])
        self.assertTrue(r["ok"], r.get("error"))
        b = body(r)
        self.assertEqual(b["status"], "success")
        self.assertEqual([e["id"] for e in b["evidence"]], ["first", "second", "third"])
        self.assertEqual(b["succeeded"], 3)

    def test_verify_pass_and_evidence(self):
        r = run(goal="verify-ok", steps=[
            T("t", "get_time", verify={"tool": "get_time", "expect": "T"})])
        self.assertTrue(r["ok"], r.get("error"))
        b = body(r)
        ev = b["evidence"][0]
        self.assertTrue(ev["verify"]["ok"])
        self.assertEqual(ev["verify"]["expect"], "T")

    def test_verify_expect_mismatch_stops(self):
        r = run(goal="verify-fail", steps=[
            T("t", "get_time", verify={"tool": "get_time", "expect": "zzz-no-such-substring"}),
            T("u", "get_time")])
        b = body(r)
        self.assertEqual(b["status"], "stopped-at-first-failure")
        self.assertEqual(b["succeeded"], 0)
        self.assertFalse(b["evidence"][0]["verify"]["ok"])
        self.assertEqual(len(b["evidence"]), 1)

    def test_unknown_tool_step_stops_honestly(self):
        r = run(goal="unknown", steps=[T("t", "definitely_not_a_tool_xyz")])
        b = body(r)
        self.assertEqual(b["status"], "stopped-at-first-failure")
        self.assertIn("unknown tool", b["evidence"][0]["error"].lower())

    def test_atomic_offline_fails_fast(self):
        # No plugin polling here, so no snapshot is possible: atomic must
        # refuse up front rather than run steps it cannot roll back.
        r = run(goal="atomic-offline", steps=[T("t", "get_time")], mode="atomic")
        self.assertFalse(r["ok"])
        self.assertIn("pre-snapshot", r["error"])

    def test_envelope_shape(self):
        r = run(goal="shape", steps=[T("t", "validate_command", {"tool": "get_time"})])
        self.assertTrue(r["ok"], r.get("error"))
        b = body(r)
        for key in ("goal", "mode", "status", "steps", "succeeded", "evidence"):
            self.assertIn(key, b, "missing body key %s" % key)
        self.assertEqual(b["goal"], "shape")


if __name__ == "__main__":
    unittest.main(verbosity=1)
