# SPDX-License-Identifier: GPL-3.0-or-later
# tests/test_figma_queue.py — PLAN.md Phase 1, Tasks 1.1-1.5.
#
# Task 1.1: FIGMA_QUEUE_TOOLS declaration + safe_call routing.
# Task 1.2: ?client=figma|studio filtering, per-client single-flight.
# Task 1.3: _figma_alive() heartbeat tracking.
# Task 1.4: figma_status local handler.
#
# Run: py -m unittest tests.test_figma_queue -v
import sys
import os
import json
import types
import time
import threading
import unittest

# Stub `websockets` so bridge.py imports without the dependency.
if "websockets" not in sys.modules:
    fake = types.ModuleType("websockets")
    fake.ConnectionClosed = type("ConnectionClosed", (Exception,), {})
    fake.serve = lambda *a, **kw: None
    sys.modules["websockets"] = fake

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
# Match tests/test_queue.py: the queue HTTP port is fixed at import time from
# the env, and unittest imports all modules before running any test. If this
# module imports bridge first (default port 3001), test_queue's assert fails.
# Set the same test port here so import order never matters.
os.environ.setdefault("ROLINK_QUEUE_PORT", "18081")
sys.path.insert(0, ROOT)

import bridge

EXPECTED_FIGMA_TOOLS = frozenset([
    "figma_create_frame",
    "figma_create_node",
    "figma_get_nodes",
    "figma_set_properties",
    "figma_export_node",
    "figma_get_document",
    "create_ui_from_figma",
    # Full CRUD + styling + layout + components (PLAN.md Phase 1).
    "figma_delete_node",
    "figma_duplicate_node",
    "figma_move_node",
    "figma_resize_node",
    "figma_set_text",
    "figma_set_font",
    "figma_set_stroke",
    "figma_set_shadow",
    "figma_set_blur",
    "figma_set_constraint",
    "figma_set_visible",
    "figma_set_locked",
    "figma_set_clips",
    "figma_set_min_max",
    "figma_set_auto_layout",
    "figma_set_padding",
    "figma_set_axis",
    "figma_set_counter_axis",
    "figma_set_primary_axis",
    "figma_set_resize",
    "figma_group_nodes",
    "figma_ungroup",
    "figma_align_nodes",
    "figma_distribute_nodes",
    "figma_create_component",
    "figma_create_instance",
    "figma_detach_instance",
    "figma_set_variant",
    "figma_set_plugin_data",
    "figma_get_plugin_data",
    "figma_set_reactions",
    "figma_import_image",
    "figma_set_image_fill",
    "figma_create_slice",
    "figma_set_export_settings",
])


def _drain(client="studio"):
    """Cancel all pending commands for a client (test isolation)."""
    try:
        with bridge._queue_lock:
            ids = [cid for cid, c in bridge._queue_cmds.items()
                   if c.get("client", "studio") == client
                   and c.get("status") in ("queued", "claimed")]
        for cid in ids:
            try:
                bridge.queue_cancel(cid)
            except Exception:
                pass
    except Exception:
        pass


class FigmaQueueToolsTest(unittest.TestCase):
    def test_constant_defined_type_safe(self):
        self.assertTrue(hasattr(bridge, "FIGMA_QUEUE_TOOLS"))
        self.assertIsInstance(bridge.FIGMA_QUEUE_TOOLS, frozenset)
        self.assertEqual(bridge.FIGMA_QUEUE_TOOLS, EXPECTED_FIGMA_TOOLS)
        for name in bridge.FIGMA_QUEUE_TOOLS:
            self.assertIsInstance(name, str)
            self.assertTrue(len(name) > 0)

    def test_is_figma_tool_helper(self):
        self.assertTrue(hasattr(bridge, "is_figma_tool"))
        for name in EXPECTED_FIGMA_TOOLS:
            self.assertTrue(bridge.is_figma_tool(name), name)
        for bad in ("get_instances", "create_ui", "", "FIGMA_CREATE_FRAME",
                    None, 42, [], {}, "figma_unknown"):
            self.assertFalse(bridge.is_figma_tool(bad), repr(bad))

    def test_validate_command_accepts_figma(self):
        for name in EXPECTED_FIGMA_TOOLS:
            res = bridge.safe_call(
                "validate_command", {"tool": name}, 5)
            self.assertIn("ok", res)
            if res.get("ok"):
                body = json.loads(res.get("text") or "{}")
                self.assertTrue(body.get("allowed"), (name, body))
            else:
                self.assertNotIn("unknown tool",
                                 str(res.get("error", "")).lower())

    def test_bridge_owned_claims_figma(self):
        for name in EXPECTED_FIGMA_TOOLS:
            self.assertTrue(bridge._bridge_owned(name), name)
        self.assertFalse(bridge._bridge_owned("figma_nonexistent_xyz"))

    def test_local_tool_entry_advertises_figma(self):
        for name in EXPECTED_FIGMA_TOOLS:
            entry = bridge._local_tool_entry(name)
            self.assertIsNotNone(entry, name)
            self.assertEqual(entry.get("name"), name)
            self.assertEqual(entry.get("server"), "local")
            self.assertTrue((entry.get("description") or "").strip(),
                            name)

    def test_figma_descriptions_present(self):
        self.assertTrue(hasattr(bridge, "_FIGMA_TOOL_DESC"))
        self.assertIsInstance(bridge._FIGMA_TOOL_DESC, dict)
        for name in EXPECTED_FIGMA_TOOLS:
            desc = bridge._FIGMA_TOOL_DESC.get(name, "")
            self.assertTrue(isinstance(desc, str) and len(desc) > 10, name)

    def test_safe_call_figma_no_plugin_offline(self):
        old_fpoll, old_spoll = bridge._figma_last_poll[0], bridge._queue_last_poll[0]
        old_on = bridge._queue_server_on[0]
        bridge._figma_last_poll[0] = 0.0
        bridge._queue_last_poll[0] = 0.0
        bridge._queue_server_on[0] = True
        try:
            # Figma-native tools take no required args: empty call reaches the
            # queue gate -> plugin_offline. create_ui_from_figma has bridge-side
            # arg validation (fails fast without a queue wait), so it needs
            # valid nodes to reach the same gate.
            _valid_nodes = {"nodes": [{"id": "F1", "type": "FRAME"}]}
            for name in EXPECTED_FIGMA_TOOLS:
                args = _valid_nodes if name == "create_ui_from_figma" else {}
                res = bridge.safe_call(name, args, 5)
                self.assertFalse(res.get("ok"), name)
                self.assertEqual(res.get("kind"), "plugin_offline",
                                 (name, res))
                self.assertNotIn("unknown tool",
                                 str(res.get("error", "")).lower())
                # Figma-native tools must mention Figma (create_ui_from_figma
                # runs in Studio, so it gives Studio guidance instead).
                if name.startswith("figma_"):
                    self.assertIn("Figma", res.get("error", ""), (name, res))
        finally:
            bridge._figma_last_poll[0] = old_fpoll
            bridge._queue_last_poll[0] = old_spoll
            bridge._queue_server_on[0] = old_on

    def test_safe_call_figma_queues_when_plugin_alive(self):
        bridge._queue_server_on[0] = True
        bridge._figma_last_poll[0] = time.time()
        bridge._figma_consec_timeouts[0] = 0
        _drain("figma")
        out = {}

        def run():
            out["res"] = bridge.safe_call(
                "figma_create_frame",
                {"title": "Shop", "width": 400, "height": 600}, 5)

        t = threading.Thread(target=run, daemon=True)
        t.start()
        deadline = time.time() + 6
        cmd = None
        while time.time() < deadline:
            c = bridge.queue_take(client="figma")
            if c is not None and c.get("tool") == "figma_create_frame":
                cmd = c
                break
            if c is not None:
                try:
                    bridge.queue_cancel(c.get("id", ""))
                except Exception:
                    pass
            time.sleep(0.05)
        self.assertIsNotNone(cmd, "figma_create_frame never enqueued")
        self.assertEqual(cmd.get("client"), "figma")
        bridge.queue_complete(cmd["id"], {"id": "F1", "name": "Shop"}, None)
        t.join(timeout=8)
        self.assertTrue(out["res"].get("ok"), out["res"])
        self.assertIn("F1", out["res"].get("text", ""))
        bridge._figma_last_poll[0] = 0.0
        _drain("figma")

    def test_list_tools_advertises_figma(self):
        mgr = bridge.MCPManager()
        mgr.load_config()
        names = {t.get("name") for t in mgr.list_tools()}
        missing = sorted(set(EXPECTED_FIGMA_TOOLS) - names)
        self.assertEqual(missing, [], f"not advertised: {missing}")
        # figma_status must be discoverable too — without advertisement no
        # session can learn the health check exists.
        self.assertIn("figma_status", names)
        entry = bridge._local_tool_entry("figma_status")
        self.assertIsNotNone(entry)
        self.assertEqual(entry.get("server"), "local")
        self.assertTrue((entry.get("description") or "").strip())

    def test_figma_not_in_needs_studio(self):
        old_poll = bridge._figma_last_poll[0]
        bridge._figma_last_poll[0] = 0.0
        try:
            res = bridge.safe_call("figma_get_document", {}, 5)
            self.assertEqual(res.get("kind"), "plugin_offline", res)
        finally:
            bridge._figma_last_poll[0] = old_poll


class FigmaClientRoutingTest(unittest.TestCase):
    """Task 1.2: ?client= filtering + per-client single-flight."""

    def setUp(self):
        _drain("studio")
        _drain("figma")

    def tearDown(self):
        _drain("studio")
        _drain("figma")

    def test_normalize_client(self):
        self.assertEqual(bridge._normalize_client("figma"), "figma")
        self.assertEqual(bridge._normalize_client("FIGMA"), "figma")
        self.assertEqual(bridge._normalize_client(" figma "), "figma")
        for other in ("studio", "STUDIO", "", None, 42, [], "blender"):
            self.assertEqual(bridge._normalize_client(other), "studio", repr(other))

    def test_client_for_tool(self):
        for name in ("figma_create_frame", "figma_get_nodes",
                     "figma_set_properties", "figma_export_node",
                     "figma_get_document"):
            self.assertEqual(bridge._client_for_tool(name), "figma", name)
        # create_ui_from_figma is declared in FIGMA_QUEUE_TOOLS but executes
        # IN STUDIO (Phase 3 converter).
        self.assertEqual(bridge._client_for_tool("create_ui_from_figma"), "studio")
        for name in ("get_instances", "create_ui", "execute_luau", "", None):
            self.assertEqual(bridge._client_for_tool(name), "studio", repr(name))

    def test_enqueue_tags_client(self):
        cid_f = bridge.queue_enqueue("figma_create_frame", "figma_create_frame",
                                     {}, "default")
        cid_s = bridge.queue_enqueue("create_instance", "create_instance",
                                     {}, "default")
        try:
            with bridge._queue_lock:
                self.assertEqual(bridge._queue_cmds[cid_f].get("client"), "figma")
                self.assertEqual(bridge._queue_cmds[cid_s].get("client"), "studio")
            # Explicit client wins over tool derivation.
            cid_x = bridge.queue_enqueue("create_instance", "create_instance",
                                         {}, "default", "figma")
            with bridge._queue_lock:
                self.assertEqual(bridge._queue_cmds[cid_x].get("client"), "figma")
            bridge.queue_cancel(cid_x)
        finally:
            bridge.queue_cancel(cid_f)
            bridge.queue_cancel(cid_s)

    def test_take_filters_by_client(self):
        cid_f = bridge.queue_enqueue("figma_get_nodes", "figma_get_nodes",
                                     {"nodeId": "1"}, "default")
        cid_s = bridge.queue_enqueue("get_instances", "get_instances",
                                     {"path": "workspace"}, "default")
        try:
            # Studio poll must NOT see the figma command.
            cmd_s = bridge.queue_take(client="studio")
            self.assertIsNotNone(cmd_s)
            self.assertEqual(cmd_s.get("tool"), "get_instances")
            self.assertEqual(cmd_s.get("client"), "studio")
            # Figma poll must NOT see the studio command (already claimed above,
            # but the remaining queued figma command must surface).
            cmd_f = bridge.queue_take(client="figma")
            self.assertIsNotNone(cmd_f)
            self.assertEqual(cmd_f.get("tool"), "figma_get_nodes")
            self.assertEqual(cmd_f.get("client"), "figma")
        finally:
            bridge.queue_cancel(cid_f)
            bridge.queue_cancel(cid_s)

    def test_take_defaults_to_studio(self):
        cid = bridge.queue_enqueue("get_instances", "get_instances", {}, "default")
        try:
            cmd = bridge.queue_take()  # no client -> studio (backward compat)
            self.assertIsNotNone(cmd)
            self.assertEqual(cmd.get("tool"), "get_instances")
        finally:
            bridge.queue_cancel(cid)

    def test_per_client_single_flight(self):
        # A Studio claim must not block Figma (and vice versa).
        cid_s = bridge.queue_enqueue("get_instances", "get_instances", {}, "default")
        cid_f = bridge.queue_enqueue("figma_get_document", "figma_get_document", {}, "default")
        try:
            first_s = bridge.queue_take(client="studio")
            self.assertIsNotNone(first_s)
            # Second studio take blocked (single-flight).
            self.assertIsNone(bridge.queue_take(client="studio"))
            # Figma take still works despite the studio claim.
            first_f = bridge.queue_take(client="figma")
            self.assertIsNotNone(first_f)
            self.assertEqual(first_f.get("client"), "figma")
        finally:
            bridge.queue_cancel(cid_s)
            bridge.queue_cancel(cid_f)

    def test_studio_commands_invisible_to_figma(self):
        cid = bridge.queue_enqueue("create_instance", "create_instance",
                                   {"className": "Part"}, "default")
        try:
            self.assertIsNone(bridge.queue_take(client="figma"))
            cmd = bridge.queue_take(client="studio")
            self.assertIsNotNone(cmd)
        finally:
            bridge.queue_cancel(cid)


class FigmaHeartbeatTest(unittest.TestCase):
    """Task 1.3: _figma_alive() + version + circuit breaker."""

    def test_figma_alive_states(self):
        old = bridge._figma_last_poll[0]
        try:
            bridge._figma_last_poll[0] = 0.0
            self.assertFalse(bridge._figma_alive())
            bridge._figma_last_poll[0] = time.time()
            self.assertTrue(bridge._figma_alive())
            bridge._figma_last_poll[0] = time.time() - 120.0
            self.assertFalse(bridge._figma_alive())
        finally:
            bridge._figma_last_poll[0] = old

    def test_client_alive_dispatch(self):
        old_s, old_f = bridge._queue_last_poll[0], bridge._figma_last_poll[0]
        try:
            bridge._queue_last_poll[0] = time.time()
            bridge._figma_last_poll[0] = 0.0
            self.assertTrue(bridge._client_alive("studio"))
            self.assertFalse(bridge._client_alive("figma"))
            bridge._queue_last_poll[0] = 0.0
            bridge._figma_last_poll[0] = time.time()
            self.assertFalse(bridge._client_alive("studio"))
            self.assertTrue(bridge._client_alive("figma"))
        finally:
            bridge._queue_last_poll[0] = old_s
            bridge._figma_last_poll[0] = old_f

    def test_figma_circuit_breaker_trips(self):
        old_poll, old_to, old_cb = (bridge._figma_last_poll[0],
                                    bridge._figma_last_timeout[0],
                                    bridge._figma_consec_timeouts[0])
        bridge._queue_server_on[0] = True
        try:
            # Fresh poll but 2 timeouts with no newer poll -> fail fast.
            bridge._figma_last_poll[0] = time.time() - 10
            bridge._figma_last_timeout[0] = time.time()
            bridge._figma_consec_timeouts[0] = 2
            # _figma_alive is False (poll 10s... wait, 10s < 30s so alive True).
            # Circuit breaker requires poll <= last_timeout (no recovery poll).
            res = bridge.safe_call("figma_get_document", {}, 5)
            self.assertFalse(res.get("ok"))
            self.assertEqual(res.get("kind"), "plugin_offline", res)
        finally:
            bridge._figma_last_poll[0] = old_poll
            bridge._figma_last_timeout[0] = old_to
            bridge._figma_consec_timeouts[0] = old_cb

    def test_studio_circuit_breaker_unaffected_by_figma(self):
        # Figma timeouts must not trip the Studio breaker.
        old_fcb = bridge._figma_consec_timeouts[0]
        old_scb = bridge._queue_consec_timeouts[0]
        bridge._figma_consec_timeouts[0] = 5
        bridge._queue_consec_timeouts[0] = 0
        bridge._queue_last_poll[0] = time.time()
        _drain("studio")
        out = {}

        def run():
            out["res"] = bridge.safe_call("get_instances",
                                          {"path": "workspace"}, 5)

        t = threading.Thread(target=run, daemon=True)
        t.start()
        deadline = time.time() + 6
        cmd = None
        while time.time() < deadline:
            c = bridge.queue_take(client="studio")
            if c is not None and c.get("tool") == "get_instances":
                cmd = c
                break
            if c is not None:
                try:
                    bridge.queue_cancel(c.get("id", ""))
                except Exception:
                    pass
            time.sleep(0.05)
        try:
            self.assertIsNotNone(cmd, "studio command blocked by figma breaker")
            bridge.queue_complete(cmd["id"], {"found": []}, None)
            t.join(timeout=8)
            self.assertTrue(out["res"].get("ok"), out["res"])
        finally:
            bridge._figma_consec_timeouts[0] = old_fcb
            bridge._queue_consec_timeouts[0] = old_scb
            bridge._queue_last_poll[0] = 0.0
            _drain("studio")


class FigmaStatusTest(unittest.TestCase):
    """Task 1.4: figma_status local handler."""

    def test_registered_in_local_handlers(self):
        self.assertIn("figma_status", bridge.LOCAL_HANDLERS)
        self.assertIs(bridge.LOCAL_HANDLERS["figma_status"],
                      bridge._local_figma_status)

    def test_no_plugin_verdict(self):
        old_poll, old_on = bridge._figma_last_poll[0], bridge._queue_server_on[0]
        bridge._figma_last_poll[0] = 0.0
        bridge._queue_server_on[0] = True
        try:
            res = bridge.safe_call("figma_status", {}, 5)
            self.assertTrue(res.get("ok"), res)
            body = json.loads(res.get("text") or "{}")
            self.assertFalse(body.get("figma_alive"))
            self.assertFalse(body.get("ever_polled"))
            self.assertIsNone(body.get("last_poll_age_s"))
            self.assertEqual(body.get("verdict"), "no-plugin")
            self.assertIn("consecutive_timeouts", body)
        finally:
            bridge._figma_last_poll[0] = old_poll
            bridge._queue_server_on[0] = old_on

    def test_healthy_verdict(self):
        old_poll = bridge._figma_last_poll[0]
        bridge._figma_last_poll[0] = time.time()
        _drain("figma")
        try:
            res = bridge.safe_call("figma_status", {}, 5)
            body = json.loads(res.get("text") or "{}")
            self.assertTrue(body.get("figma_alive"))
            self.assertEqual(body.get("verdict"), "healthy")
            self.assertEqual(body.get("pending"), 0)
        finally:
            bridge._figma_last_poll[0] = old_poll

    def test_stale_verdict(self):
        old_poll = bridge._figma_last_poll[0]
        bridge._figma_last_poll[0] = time.time() - 120.0
        try:
            body = json.loads(bridge.safe_call("figma_status", {}, 5)["text"])
            self.assertFalse(body.get("figma_alive"))
            self.assertGreater(body.get("last_poll_age_s", 0), 30)
            self.assertEqual(body.get("verdict"), "plugin-stale")
        finally:
            bridge._figma_last_poll[0] = old_poll

    def test_pending_counts_only_figma(self):
        old_poll = bridge._figma_last_poll[0]
        bridge._figma_last_poll[0] = time.time()
        cid_s = bridge.queue_enqueue("get_instances", "get_instances", {}, "default")
        cid_f = bridge.queue_enqueue("figma_get_nodes", "figma_get_nodes", {}, "default")
        try:
            fbody = json.loads(bridge.safe_call("figma_status", {}, 5)["text"])
            self.assertEqual(fbody.get("pending"), 1, fbody)
            pbody = json.loads(bridge.safe_call("plugin_status", {}, 5)["text"])
            self.assertEqual(pbody.get("pending"), 1, pbody)
        finally:
            bridge.queue_cancel(cid_s)
            bridge.queue_cancel(cid_f)
            bridge._figma_last_poll[0] = old_poll
            _drain("studio")
            _drain("figma")

    def test_plugin_status_ignores_figma(self):
        # plugin_status (Studio) must not count figma commands.
        old_sp, old_fp = bridge._queue_last_poll[0], bridge._figma_last_poll[0]
        bridge._queue_last_poll[0] = time.time()
        bridge._figma_last_poll[0] = time.time()
        _drain("studio")
        _drain("figma")
        cid_f = bridge.queue_enqueue("figma_export_node", "figma_export_node",
                                     {"nodeId": "1"}, "default")
        try:
            pbody = json.loads(bridge.safe_call("plugin_status", {}, 5)["text"])
            self.assertEqual(pbody.get("pending"), 0, pbody)
        finally:
            bridge.queue_cancel(cid_f)
            bridge._queue_last_poll[0] = old_sp
            bridge._figma_last_poll[0] = old_fp


if __name__ == "__main__":
    unittest.main(verbosity=1)
