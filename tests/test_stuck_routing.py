# tests/test_stuck_routing.py - stuck-execution cascade fixes.
#   py -3 tests/test_stuck_routing.py
# Workstream D (bridge routing): registry tools must get plugin_offline
# guidance instead of StudioMCP's "unknown tool"; genuine overlaps still fall
# through. Workstreams A-C/E pinned statically (Lua/JS have no runtime here).
import sys, os, io, json, time, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

os.environ["ROLINK_QUEUE_PORT"] = "18084"
sys.path.insert(0, ROOT)
import bridge


def read(*parts):
    with io.open(os.path.join(ROOT, *parts), encoding="utf-8", errors="replace") as f:
        return f.read()


class FakeAlive:
    def is_alive(self):
        return True


class FakeHolder:
    def __init__(self, fn):
        self._fn = fn

    def call_tool(self, real_name, arguments, timeout):
        return self._fn(real_name, arguments, timeout)


class RoutingTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        assert bridge.QUEUE_PORT == 18084, bridge.QUEUE_PORT
        assert bridge.start_queue_server() is True
        mgr = bridge.MCPManager()
        mgr.load_config()
        bridge.mgr = mgr  # real config, no servers started

    def test_never_polled_queue_tool_is_plugin_offline(self):
        # Screenshot 2: get_context_summary answered "unknown tool" in 0.05s.
        # Must now be instant plugin_offline guidance, never an MCP hop.
        bridge._queue_last_poll[0] = 0.0
        t0 = time.monotonic()
        res = bridge.safe_call("get_context_summary", {"projectId": "default"}, 5)
        dt = time.monotonic() - t0
        self.assertFalse(res["ok"], res)
        self.assertEqual(res.get("kind"), "plugin_offline", res)
        self.assertEqual(res.get("error_code"), "PLUGIN_OFFLINE")
        self.assertIn("install-plugin", res.get("error", ""))
        self.assertNotIn("unknown tool", res.get("error", "").lower())
        self.assertLess(dt, 2.0, "must fail fast, never burn a wait")

    def test_stale_poll_names_age(self):
        bridge._queue_last_poll[0] = time.time() - 120.0
        res = bridge.safe_call("scan_errors", {"limit": 5}, 5)
        self.assertFalse(res["ok"])
        self.assertEqual(res.get("kind"), "plugin_offline")
        self.assertIn("120s", res.get("error", ""))

    def test_overlap_still_falls_through_to_live_server(self):
        # A StudioMCP that natively knows the name keeps working without plugin.
        mgr = bridge.mgr
        old_clients, old_index = mgr.clients, getattr(mgr, "index", {})
        try:
            mgr.clients = {"fake": FakeAlive()}
            mgr.index = {"get_context_summary":
                         (FakeHolder(lambda n, a, t: {"text": '{"ctx": 1}', "images": []}),
                          "get_context_summary")}
            bridge._queue_last_poll[0] = 0.0
            res = bridge.safe_call("get_context_summary", {}, 5)
            self.assertTrue(res["ok"], res)
            self.assertIn('"ctx"', res.get("text", ""))
        finally:
            mgr.clients, mgr.index = old_clients, old_index

    def test_unknown_tool_backstop_is_plugin_guidance(self):
        # Liveness flipped mid-call: Studio answered "unknown tool" for a
        # registry name -> translate, never leak the raw confusion.
        mgr = bridge.mgr
        old_clients, old_index = mgr.clients, getattr(mgr, "index", {})
        def boom(n, a, t):
            raise RuntimeError("unknown tool 'scan_errors'")
        try:
            mgr.clients = {"fake": FakeAlive()}
            mgr.index = {"scan_errors": (FakeHolder(boom), "scan_errors")}
            bridge._queue_last_poll[0] = 0.0
            res = bridge.safe_call("scan_errors", {}, 5)
            self.assertFalse(res["ok"])
            self.assertEqual(res.get("kind"), "plugin_offline", res)
            self.assertIn("28 native", res.get("error", ""))
        finally:
            mgr.clients, mgr.index = old_clients, old_index

    def test_garbage_names_still_rejected(self):
        res = bridge.safe_call("frobnicate_the_db", {}, 5)
        self.assertFalse(res["ok"])
        self.assertEqual(res.get("kind"), "validation_error")
        self.assertIn("unknown tool", res.get("error", ""))

    def test_local_builtins_unaffected(self):
        res = bridge.safe_call("get_memory", {"project": "test_tmp_rt",
                                              "section": "tasks"}, 5)
        self.assertTrue(res["ok"], res)
        try:
            os.remove(bridge._memory_path("test_tmp_rt"))
        except Exception:
            pass


class PluginHardeningTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.plugin = read("studio-plugin", "RoLink.lua")

    def test_busy_watchdog(self):
        for token in ("__RL_BUSY_AT", "__RL_BUSY_TOOL", "TOOL_BUDGET_S + 15",
                      "force-clearing so the queue can move"):
            self.assertIn(token, self.plugin, f"missing {token}")

    def test_claim_span_protected(self):
        self.assertIn("ignoring malformed queue command (no id)", self.plugin)
        self.assertIn("claim span failed", self.plugin)
        # Busy reset unconditional: set true once, cleared twice (normal +
        # post-pcall), i.e. no path can hold it.
        self.assertGreaterEqual(self.plugin.count("_G.__RL_BUSY = false"), 2)

    def test_result_sanitized(self):
        for token in ("jsonSafe", "[cycle]", "[truncated depth]",
                      "result POST failed for"):
            self.assertIn(token, self.plugin, f"missing {token}")

    def test_twin_lookup_total(self):
        self.assertIn("no clip-twin helper in this plugin copy", self.plugin)

    def test_publish_handoff(self):
        self.assertIn("Do NOT retry prepare here", self.plugin)
        self.assertIn("action:register", self.plugin)


class ExtensionFeedbackTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.main = read("rolink-extension", "core", "main.js")

    def test_assistant_frame_stripped(self):
        self.assertIn("AssistantCommand", self.main)
        self.assertIn("frameLine", self.main)

    def test_compare_hint(self):
        self.assertIn("attempt to compare", self.main)
        self.assertIn("tonumber()", self.main)

    def test_error_label_names_tool(self):
        self.assertIn('ERROR in ([A-Za-z_]+)', self.main)
        self.assertIn("ERROR calling '([^']+)'", self.main)


if __name__ == "__main__":
    unittest.main(verbosity=1)
