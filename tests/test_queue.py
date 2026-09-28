# tests/test_queue.py - embedded Studio queue (:3001) round-trips.
#   python3 tests/test_queue.py
# Covers: HTTP shapes the Studio plugin needs (/health, /queue/next,
# /queue/result, /metrics), safe_call routing through the queue with a
# simulated plugin poll, alias canonicalization, and the plugin_offline
# path when no plugin is polling. No Studio, no Node required.
import sys, os, json, time, threading, unittest
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

os.environ["ROLINK_QUEUE_PORT"] = "18081"
sys.path.insert(0, ROOT)
import bridge

BASE = "http://127.0.0.1:18081"


def http(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return r.status, json.loads(r.read().decode())


def mark_polled():
    bridge._queue_last_poll[0] = time.time()


class QueueTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        assert bridge.QUEUE_PORT == 18081, bridge.QUEUE_PORT
        assert bridge.start_queue_server() is True
        assert bridge._queue_server_on[0] is True
        mgr = bridge.MCPManager()
        mgr.load_config()
        bridge.mgr = mgr  # servers never started: StudioMCP path stays mcp_offline

    def test_health(self):
        code, body = http("GET", "/health")
        self.assertEqual(code, 200)
        self.assertTrue(body["ok"])
        self.assertEqual(body["tools"], 150)

    def test_plugin_status_live(self):
        import json as _json
        bridge._queue_last_poll[0] = time.time()
        res = bridge.safe_call("plugin_status", {}, 5)
        self.assertTrue(res["ok"], res)
        body = _json.loads(res["text"])
        self.assertTrue(body["queue_up"])
        self.assertTrue(body["plugin_alive"])
        self.assertLess(body["last_poll_age_s"], 30)

    def test_versionless_poll_warns_once(self):
        old_ver, old_warn = bridge._plugin_version[0], bridge._plugin_stale_warned[0]
        bridge._plugin_version[0] = ""
        bridge._plugin_stale_warned[0] = False
        try:
            code, _ = http("GET", "/queue/next?projectId=default")
            self.assertEqual(code, 200)
            self.assertTrue(bridge._plugin_stale_warned[0])
            self.assertEqual(bridge._plugin_version[0], "")
            code, _ = http("GET", "/queue/next?projectId=default&pv=9.9.9")
            self.assertEqual(bridge._plugin_version[0], "9.9.9")
        finally:
            bridge._plugin_version[0] = old_ver
            bridge._plugin_stale_warned[0] = old_warn

    def test_next_empty_then_result_flow(self):
        code, body = http("GET", "/queue/next?projectId=default")
        self.assertEqual(code, 200)
        self.assertIsNone(body["command"])
        cid = bridge.queue_enqueue("get_instances", "get_instances", {"path": "workspace"})
        code, body = http("GET", "/queue/next?projectId=default")
        cmd = body["command"]
        self.assertEqual(cmd["id"], cid)
        self.assertEqual(cmd["tool"], "get_instances")
        code, body = http("POST", "/queue/result",
                          {"id": cid, "result": {"found": ["workspace"]}, "error": None})
        self.assertTrue(body["ok"])
        res, err = bridge.queue_wait(cid, 5)
        self.assertIsNone(err)
        self.assertEqual(res, {"found": ["workspace"]})

    def test_metrics_sink(self):
        code, body = http("POST", "/metrics", {"projectId": "default"})
        self.assertTrue(body["ok"])

    def test_safe_call_via_simulated_plugin(self):
        mark_polled()
        out = {}

        def run():
            out["res"] = bridge.safe_call("create_instance",
                                          {"className": "Part", "parent": "workspace"}, 10)

        t = threading.Thread(target=run, daemon=True)
        t.start()
        deadline = time.time() + 8
        cmd = None
        while time.time() < deadline:
            _, body = http("GET", "/queue/next?projectId=default")
            if body["command"] and body["command"]["tool"] == "create_instance":
                cmd = body["command"]
                break
            time.sleep(0.1)
        self.assertIsNotNone(cmd, "safe_call never enqueued")
        http("POST", "/queue/result", {"id": cmd["id"], "result": {"created": "workspace/Part"}})
        t.join(timeout=8)
        self.assertTrue(out["res"]["ok"], out["res"])
        self.assertIn("workspace/Part", out["res"]["text"])

    def test_alias_routes_to_queue(self):
        # inspect_instance is a pure alias of get_instances (same args): it
        # must canonicalize and ride the queue as get_instances.
        mark_polled()
        out = {}

        def run():
            out["res"] = bridge.safe_call("inspect_instance", {"path": "workspace"}, 10)

        t = threading.Thread(target=run, daemon=True)
        t.start()
        deadline = time.time() + 8
        cmd = None
        while time.time() < deadline:
            _, body = http("GET", "/queue/next?projectId=default")
            if body["command"] and body["command"]["tool"] == "get_instances":
                cmd = body["command"]
                break
            time.sleep(0.1)
        self.assertIsNotNone(cmd, "alias did not canonicalize to get_instances")
        http("POST", "/queue/result", {"id": cmd["id"], "result": {"found": []}})
        t.join(timeout=8)
        self.assertTrue(out["res"]["ok"], out["res"])

    def test_plugin_never_polled_falls_through(self):
        # No plugin ever seen: instant plugin_offline install guidance (never
        # burn a queue timeout, never forward registry names to StudioMCP for
        # a confusing "unknown tool"). Overlaps a live server knows still fall
        # through - covered in test_stuck_routing.py.
        bridge._queue_last_poll[0] = 0.0
        res = bridge.safe_call("create_instance", {"className": "Part"}, 5)
        self.assertFalse(res["ok"])
        self.assertEqual(res["kind"], "plugin_offline")
        self.assertIn("install-plugin", res.get("error", ""))

    def test_queue_server_disabled(self):
        bridge._queue_server_on[0] = False
        try:
            bridge._queue_last_poll[0] = time.time()
            res = bridge.safe_call("create_instance", {"className": "Part"}, 5)
            self.assertFalse(res["ok"])
            self.assertEqual(res["kind"], "plugin_offline")
        finally:
            bridge._queue_server_on[0] = True

    def test_queue_wait_timeout_is_plugin_offline(self):
        # Plugin was seen, but nothing completes the command: short timeout
        # must surface stuck-execution (plugin alive but hung), not a hang.
        bridge._queue_last_poll[0] = time.time()
        res = bridge.safe_call("get_instances", {"path": "workspace"}, 0.3)
        self.assertFalse(res["ok"])
        self.assertEqual(res["kind"], "stuck-execution")
        self.assertIn("plugin_status", res["error"])

    def test_code_payload_round_trip(self):
        # Code-carrying tools must travel with the CODE as the command payload
        # (the plugin runs cmd.command as Luau); other tools send the name.
        bridge._queue_last_poll[0] = time.time()
        seen = {}

        def run(tool, args):
            seen[tool] = bridge.safe_call(tool, args, 10)

        t1 = threading.Thread(target=run,
                              args=("execute_luau", {"code": 'return 1+1'}), daemon=True)
        t1.start()
        deadline = time.time() + 8
        cmd = None
        while time.time() < deadline:
            _, body = http("GET", "/queue/next?projectId=default")
            if body["command"] and body["command"]["tool"] == "execute_luau":
                cmd = body["command"]
                break
            time.sleep(0.1)
        self.assertIsNotNone(cmd, "execute_luau never enqueued")
        self.assertEqual(cmd["command"], "return 1+1")
        self.assertEqual(cmd["args"], {"code": "return 1+1"})
        http("POST", "/queue/result", {"id": cmd["id"], "result": 2})
        t1.join(timeout=8)
        self.assertTrue(seen["execute_luau"]["ok"], seen)
        self.assertIn("2", seen["execute_luau"]["text"])

        t2 = threading.Thread(target=run,
                              args=("create_instance", {"className": "Part"}), daemon=True)
        t2.start()
        deadline = time.time() + 8
        cmd2 = None
        while time.time() < deadline:
            _, body = http("GET", "/queue/next?projectId=default")
            if body["command"] and body["command"]["tool"] == "create_instance":
                cmd2 = body["command"]
                break
            time.sleep(0.1)
        self.assertIsNotNone(cmd2, "create_instance never enqueued")
        self.assertEqual(cmd2["command"], "create_instance")
        http("POST", "/queue/result", {"id": cmd2["id"], "result": {"created": "x"}})
        t2.join(timeout=8)
        self.assertTrue(seen["create_instance"]["ok"], seen)

    def test_original_name_kept_for_studiomcp(self):
        # list_commands must NOT be rewritten: with no plugin and no MCP up,
        # it falls through to the StudioMCP path (mcp_offline), proving the
        # original spelling survived alias handling.
        bridge._queue_last_poll[0] = 0.0
        res = bridge.safe_call("list_commands", {}, 5)
        self.assertFalse(res["ok"])
        self.assertEqual(res["kind"], "mcp_offline")

    def _drain_queue(self, tool, timeout=8):
        import time
        deadline = time.time() + timeout
        while time.time() < deadline:
            _, body = http("GET", "/queue/next?projectId=default")
            if body["command"] and body["command"]["tool"] == tool:
                return body["command"]
            time.sleep(0.1)
        return None

    def test_extra_natives_route_via_queue(self):
        import time
        for tool, args in (("script_search", {"pattern": "x"}),
                           ("script_grep", {"pattern": "y"}),
                           ("search_game_tree", {"query": "z"})):
            bridge._queue_last_poll[0] = time.time()
            out = {}

            def run(t=tool, a=args):
                out[t] = bridge.safe_call(t, a, 10)

            t = threading.Thread(target=run, daemon=True)
            t.start()
            cmd = self._drain_queue(tool)
            self.assertIsNotNone(cmd, f"{tool} never enqueued")
            self.assertEqual(cmd["tool"], tool)
            http("POST", "/queue/result", {"id": cmd["id"], "result": {"ok": True}})
            t.join(timeout=8)
            self.assertTrue(out[tool]["ok"], (tool, out[tool]))

    def test_search_scripts_alias_maps_to_native(self):
        import time
        bridge._queue_last_poll[0] = time.time()
        out = {}

        def run():
            out["res"] = bridge.safe_call("search_scripts", {"query": "q"}, 10)

        t = threading.Thread(target=run, daemon=True)
        t.start()
        cmd = self._drain_queue("script_search")
        self.assertIsNotNone(cmd, "search_scripts did not canonicalize to script_search")
        http("POST", "/queue/result", {"id": cmd["id"], "result": {"hits": []}})
        t.join(timeout=8)
        self.assertTrue(out["res"]["ok"], out)

    def test_timeout_text_carries_queue_snapshot(self):
        import time
        bridge._queue_last_poll[0] = time.time()
        res = bridge.safe_call("get_instances", {"path": "workspace"}, 0.3)
        self.assertFalse(res["ok"])
        self.assertEqual(res["kind"], "stuck-execution")
        self.assertIn("queue:", res["error"], res["error"])


if __name__ == "__main__":
    unittest.main(verbosity=1)
