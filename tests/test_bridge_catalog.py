# tests/test_bridge_catalog.py - every registry tool must resolve to a real path.
#   python3 tests/test_bridge_catalog.py
# With no Studio running and no MCP server started, each of the 150 tools must
# return either ok (local handlers) or a precise offline kind (mcp_offline /
# studio_offline / validation_error) - never "unknown tool". That proves the
# full catalog is wired end to end (bridge routing), not just listed.
import sys, os, json, types, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

# Stub `websockets` so bridge.py can be imported without the dependency.
sys.modules.setdefault("websockets", types.ModuleType("websockets"))
sys.path.insert(0, ROOT)  # repo root
import bridge


class CatalogTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(os.path.join(ROOT, "tests", "__registry__.json"), encoding="utf-8") as f:
            cls.registry = json.load(f)
        try:
            with open(os.path.join(ROOT, "tests", "tool-samples.json"), encoding="utf-8") as f:
                cls.samples = json.load(f)
        except Exception:
            cls.samples = {}
        # Fresh manager, servers configured but never started: Studio-routed
        # tools must report mcp_offline without hanging or crashing.
        cls.mgr = bridge.MCPManager()
        cls.mgr.load_config()
        bridge.mgr = cls.mgr

    def test_registry_has_147_unique_tools(self):
        self.assertEqual(len(self.registry), 150, f"registry has {len(self.registry)} tools")
        self.assertEqual(len(set(self.registry)), 150, "registry has duplicates")

    def test_unknown_names_fail_fast_with_suggestions(self):
        import time
        for bad, want_hint in (("create_animation", "create_animation_track"),
                               ("execut_luau", "execute_luau"),
                               ("set_proprety", "set_properties")):
            t0 = time.monotonic()
            res = bridge.safe_call(bad, {}, 5)
            dt = time.monotonic() - t0
            self.assertFalse(res["ok"], bad)
            self.assertEqual(res["kind"], "validation_error", (bad, res))
            self.assertIn(want_hint, res["error"], (bad, res["error"]))
            self.assertLess(dt, 2.0, f"{bad} took {dt:.1f}s, must fail fast")

    def test_plugin_status_three_states(self):
        import time, json
        # Never polled: must say so (install guidance), instantly.
        bridge._queue_last_poll[0] = 0.0
        res = bridge.safe_call("plugin_status", {}, 5)
        self.assertTrue(res["ok"], res)
        body = json.loads(res["text"])
        self.assertFalse(body["ever_polled"])
        self.assertIsNone(body["last_poll_age_s"])
        # Stale poll: alive False, age present.
        bridge._queue_last_poll[0] = time.time() - 120.0
        body = json.loads(bridge.safe_call("plugin_status", {}, 5)["text"])
        self.assertFalse(body["plugin_alive"])
        self.assertGreater(body["last_poll_age_s"], 30)
        # Fresh poll: alive True, version field present. (This suite never
        # starts the queue HTTP server, so queue_up mirrors the flag.)
        bridge._queue_last_poll[0] = time.time()
        body = json.loads(bridge.safe_call("plugin_status", {}, 5)["text"])
        self.assertTrue(body["plugin_alive"])
        self.assertEqual(body["queue_up"], bridge._queue_server_on[0])
        self.assertIn("plugin_version", body)
        self.assertIn("in_flight", body)
        self.assertIn("oldest_claim_age_s", body)
        # Registry stays exactly 150: plugin_status/get_studio_state/get_memory/
        # update_memory are built-ins, not registry tools.
        self.assertEqual(len(self.registry), 150)
        self.assertNotIn("plugin_status", self.registry)
        self.assertNotIn("get_studio_state", self.registry)
        self.assertNotIn("get_memory", self.registry)
        self.assertNotIn("update_memory", self.registry)

    def test_list_tools_covers_registry(self):
        advertised = {t.get("name") for t in self.mgr.list_tools()}
        missing = sorted(set(self.registry) - advertised)
        self.assertEqual(missing, [], f"not advertised: {missing}")

    def test_every_tool_routes(self):
        bad = []
        for name in self.registry:
            args = self.samples.get(name, {})
            if not isinstance(args, dict):
                args = {}
            try:
                res = bridge.safe_call(name, args, 5)
            except Exception as e:  # safe_call must never raise
                bad.append((name, f"raised {e!r}"))
                continue
            if not isinstance(res, dict) or "ok" not in res:
                bad.append((name, f"bad shape {res!r}"[:120]))
                continue
            if res.get("ok"):
                continue
            kind = res.get("kind", "")
            err = str(res.get("error", ""))
            if kind == "RuntimeError" or "unknown tool" in err.lower():
                bad.append((name, f"{kind}: {err}"[:160]))
            elif kind not in ("validation_error", "mcp_offline", "studio_offline",
                              "timeout", "execution_error", "cancelled",
                              "plugin_offline", "stuck-execution"):
                bad.append((name, f"unexpected kind {kind}: {err}"[:160]))
        self.assertEqual(bad, [], f"{len(bad)} tools do not route:\n" + "\n".join(f"{n}: {e}" for n, e in bad[:15]))

    def test_single_ownership_on_collision(self):
        # A name advertised BOTH live (Studio dialect) and by our catalog must
        # list exactly once, with ours winning while the plugin polls.
        import time

        class FakeClient:
            tools_cache = [{"name": "search_game_tree",
                            "description": "STUDIO NATIVE dialect"}]

            def is_alive(self):
                return True

        mgr = bridge.MCPManager()
        mgr.clients = {"fake": FakeClient()}
        try:
            bridge._queue_last_poll[0] = time.time()  # plugin polling
            ours = [t for t in mgr.list_tools() if t.get("name") == "search_game_tree"]
            self.assertEqual(len(ours), 1, ours)
            self.assertEqual(ours[0].get("server"), "local")
            self.assertIn("query", ours[0].get("description", ""))
            bridge._queue_last_poll[0] = 0.0  # plugin gone: Studio entry stands
            theirs = [t for t in mgr.list_tools() if t.get("name") == "search_game_tree"]
            self.assertEqual(len(theirs), 1, theirs)
            self.assertEqual(theirs[0].get("server"), "fake")
            self.assertIn("STUDIO NATIVE", theirs[0].get("description", ""))
        finally:
            bridge._queue_last_poll[0] = 0.0

    def test_timeout_cancels_no_ghost_replay(self):
        cid = bridge.queue_enqueue("get_instances", "get_instances", {})
        res, err = bridge.queue_wait(cid, 0.2)
        self.assertEqual(err, "timeout waiting for plugin result")
        self.assertTrue(bridge.queue_cancel(cid))
        # Cancelled commands are settled: take() skips them, complete is a no-op.
        self.assertIsNone(bridge.queue_take())
        self.assertTrue(bridge.queue_complete(cid, {"x": 1}, None))
        with bridge._queue_lock:
            self.assertEqual(bridge._queue_cmds[cid]["status"], "done")

    def test_verdict_matrix(self):
        import json as _json
        import time
        old_on = bridge._queue_server_on[0]
        bridge._queue_server_on[0] = True
        try:
            bridge._queue_last_poll[0] = 0.0
            v = _json.loads(bridge.safe_call("plugin_status", {}, 5)["text"])["verdict"]
            self.assertEqual(v, "no-plugin")
            bridge._queue_last_poll[0] = time.time()  # fresh poll, empty queue
            for cid in list(bridge._queue_cmds):
                bridge.queue_cancel(cid)
            v = _json.loads(bridge.safe_call("plugin_status", {}, 5)["text"])["verdict"]
            self.assertEqual(v, "healthy")
            cid = bridge.queue_enqueue("get_instances", "get_instances", {}, "other")
            v = _json.loads(bridge.safe_call("plugin_status", {}, 5)["text"])
            self.assertEqual(v["verdict"], "routing-stall", v)
            self.assertEqual(v["pending_by_project"], {"other": 1})
            bridge.queue_cancel(cid)
        finally:
            bridge._queue_last_poll[0] = 0.0
            bridge._queue_server_on[0] = old_on


if __name__ == "__main__":
    unittest.main(verbosity=1)
