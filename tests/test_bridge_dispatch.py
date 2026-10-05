# SPDX-License-Identifier: GPL-3.0-or-later
# tests/test_bridge_dispatch.py — Phase 1 bridge-side defense in depth.
#
# Verifies that handle_call_tool / safe_call rejects invalid (empty /
# non-string / non-dict-args) tool names with a structured error and that
# the rejection happens BEFORE any stdio spawn would be attempted.
#
# Run: cd /workspace/cad48349-765c-4c08-becd-f0aeb983a551/sessions/agent_82b0051a-e602-4800-a81d-2c8476d3a7a2
#       python3 tests/test_bridge_dispatch.py
#
# Strategy: drive the SAME `safe_call` function that the call_tool handler
# invokes. This is the function that fails FIRST in the production
# sequence (before any stdio spawn), so it's the only one that has to be
# wrong for the v4.3.0 "invalid tool name undefined" to leak out.

import sys, os, json, types, unittest

# Stub `websockets` so bridge.py can be imported.
if "websockets" not in sys.modules:
    fake = types.ModuleType("websockets")
    fake.ConnectionClosed = type("ConnectionClosed", (Exception,), {})
    fake.serve = lambda *a, **kw: None
    sys.modules["websockets"] = fake

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))  # repo root

import bridge


class _FakeMCPClientMgr:
    """Stub mgr. safe_call reaches mgr.any_alive() and (for valid calls)
    mgr.call(); we need both to behave sensibly and the latter to RECORD
    that it was reached so a test can assert 'never called'."""

    def __init__(self):
        self.calls = []

    def any_alive(self):
        return True

    def call(self, name, args, timeout):
        self.calls.append((name, args, timeout))
        return {"text": "ok", "images": []}


class BridgeDispatchTest(unittest.TestCase):
    def setUp(self):
        self._orig_mgr = bridge.mgr
        bridge.mgr = _FakeMCPClientMgr()

    def tearDown(self):
        bridge.mgr = self._orig_mgr

    # ── the actual assertions ────────────────────────────────────────
    def test_empty_name_rejected_no_call(self):
        r = bridge.handle_call_tool("", {}, 30)
        self.assertFalse(r["ok"])
        self.assertEqual(r["kind"], "validation_error")
        self.assertIn("tool name is required", r["error"])
        self.assertEqual(bridge.mgr.calls, [], "no stdio spawn expected")

    def test_none_name_rejected_no_call(self):
        r = bridge.handle_call_tool(None, {}, 30)
        self.assertFalse(r["ok"])
        self.assertEqual(r["kind"], "validation_error")
        self.assertEqual(bridge.mgr.calls, [])

    def test_int_name_rejected_no_call(self):
        r = bridge.handle_call_tool(42, {}, 30)
        self.assertFalse(r["ok"])
        self.assertEqual(r["kind"], "validation_error")
        self.assertEqual(bridge.mgr.calls, [])

    def test_valid_name_reaches_mcp(self):
        # valid path: mgr.call IS called when a live server natively knows
        # the name (overlap). We don't assert on the result here
        # (probe_studio would need a full mock for that); we just want to
        # confirm the validation does NOT swallow a valid call.
        # Stub probe_studio so the valid path doesn't blow up on mgr.index.
        bridge.probe_studio = lambda: {"app": True, "place": True}
        # Simulate StudioMCP natively advertising the name: the queue-tools
        # guard lets known-live spellings fall through to mgr.call.
        bridge.mgr.index = {"create_instance": (None, "create_instance")}
        r = bridge.handle_call_tool("create_instance", {"className": "Part"}, 30)
        # mgr.call WAS called
        self.assertEqual(len(bridge.mgr.calls), 1)
        self.assertEqual(bridge.mgr.calls[0][0], "create_instance")

    def test_validation_always_returns_ai_readable_shape(self):
        # The contract: every validation_error MUST have ok:false, kind,
        # and an error string the model can act on (no empty error, no
        # "undefined" leaking through).
        for bad in ("", None, 42, [], {}):
            r = bridge.handle_call_tool(bad, {}, 30)
            self.assertFalse(r["ok"])
            self.assertEqual(r["kind"], "validation_error")
            self.assertIsInstance(r["error"], str)
            self.assertGreater(len(r["error"]), 5)
            self.assertNotIn("undefined", r["error"], f"error must not contain 'undefined': {r['error']!r}")


if __name__ == "__main__":
    unittest.main()
