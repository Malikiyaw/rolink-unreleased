# tests/test_preflight_atomic.py - Luau risk gate + atomic batch_queue.
#   py -3 tests/test_preflight_atomic.py
# Unit: _luau_risk levels, string/comment blindness, confirm gate offline.
# Integration (simulated plugin over the embedded queue): atomic batch rolls
# back the succeeded Studio step on failure and verifies the tree hash;
# best_effort leaves prior steps and issues no rollback.
import sys, os, json, time, threading, unittest
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

os.environ["ROLINK_QUEUE_PORT"] = "18082"
sys.path.insert(0, ROOT)
import bridge

BASE = "http://127.0.0.1:18082"

DS_WRITE = 'local ds = game:GetService("DataStoreService"):GetDataStore("P")\nds:SetAsync("k", 1)\nreturn 1'
HTTP = 'local h = game:GetService("HttpService")\nreturn h:RequestAsync({Url="https://x.example", Method="GET"})'
BROAD = 'for _, d in ipairs(workspace:GetDescendants()) do d:Destroy() end\nreturn 1'
TARGETED = 'workspace.Map.OldSign:Destroy()\nreturn 1'
SCAN_THEN_TARGETED = ('local all = game.Workspace:GetDescendants()\n'
                      'local t = workspace.Map.OldSign\n'
                      'if t then t:Destroy() end\nreturn 1')
LOOP_WIPE_CHILDREN = 'for _, v in pairs(folder:GetChildren()) do v:Destroy() end\nreturn 1'
LOOP_UNRELATED = 'for i = 1, 3 do print(i) end\nworkspace.Map.OldSign:Destroy()\nreturn 1'
CLEAN = 'local x = 1 + 1\nreturn x'
STRING_TRAP = 'local s = "call httpservice destroy :Destroy("\n-- workspace:GetDescendants() destroy\nreturn s'
MASS = 'for i = 1, 200 do local p = Instance.new("Part") p.Parent = workspace end\nreturn 1'


def http(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=15) as r:
        return r.status, json.loads(r.read().decode())


class PreflightUnitTest(unittest.TestCase):
    def test_low_clean(self):
        r = bridge._luau_risk(CLEAN)
        self.assertEqual(r["level"], "LOW")
        self.assertFalse(r["requiresConfirm"])

    def test_datastore_write_high_confirm(self):
        r = bridge._luau_risk(DS_WRITE)
        self.assertEqual(r["level"], "HIGH")
        self.assertTrue(r["requiresConfirm"])
        self.assertIn("DataStoreService", r["services"])
        self.assertTrue(any(d["id"] == "datastore-write" for d in r["dangers"]))

    def test_http_high_confirm(self):
        r = bridge._luau_risk(HTTP)
        self.assertEqual(r["level"], "HIGH")
        self.assertTrue(r["requiresConfirm"])

    def test_broad_destroy_high_confirm(self):
        r = bridge._luau_risk(BROAD)
        self.assertTrue(any(d["id"] == "broad-destroy" for d in r["dangers"]))
        self.assertTrue(r["requiresConfirm"])

    def test_targeted_destroy_medium_no_confirm(self):
        r = bridge._luau_risk(TARGETED)
        self.assertEqual(r["level"], "MEDIUM")
        self.assertFalse(r["requiresConfirm"])

    def test_scan_then_targeted_destroy_no_confirm(self):
        # A tree scan followed by a Destroy OUTSIDE any loop is one
        # undoable delete, not a wipe: no confirmation gate.
        r = bridge._luau_risk(SCAN_THEN_TARGETED)
        self.assertFalse(r["requiresConfirm"], r)
        self.assertFalse(any(d["id"] == "broad-destroy" for d in r["dangers"]), r)
        res = bridge.safe_call("execute_luau", {"code": SCAN_THEN_TARGETED}, 5)
        self.assertNotEqual(res.get("status"), "confirm_required", res)

    def test_loop_wipe_children_still_confirms(self):
        r = bridge._luau_risk(LOOP_WIPE_CHILDREN)
        self.assertTrue(any(d["id"] == "broad-destroy" for d in r["dangers"]), r)
        self.assertTrue(r["requiresConfirm"])

    def test_destroy_after_closed_loop_is_targeted(self):
        # The loop is over before the Destroy runs: the stack machine must
        # pop the closed block instead of blaming every later call.
        r = bridge._luau_risk(LOOP_UNRELATED)
        self.assertFalse(r["requiresConfirm"], r)
        self.assertFalse(any(d["id"] == "broad-destroy" for d in r["dangers"]), r)

    def test_strings_and_comments_are_blind(self):
        r = bridge._luau_risk(STRING_TRAP)
        self.assertEqual(r["level"], "LOW", r)
        self.assertFalse(r["requiresConfirm"])

    def test_mass_create_flagged(self):
        r = bridge._luau_risk(MASS)
        self.assertIn(r["level"], ("MEDIUM", "HIGH"))
        self.assertTrue(any(d["id"] == "mass-create" for d in r["dangers"]))

    def test_confirm_gate_offline(self):
        # No plugin needed: the gate fires before any queue wait.
        res = bridge.safe_call("execute_luau", {"code": DS_WRITE}, 5)
        self.assertFalse(res["ok"])
        self.assertEqual(res.get("status"), "confirm_required")
        self.assertEqual(res.get("error_code"), "CONFIRM_REQUIRED")
        self.assertIn("confirm", res.get("error", ""))

    def test_confirm_true_passes_gate(self):
        # Gate passed -> falls through to offline path (never confirm_required).
        bridge._queue_last_poll[0] = 0.0
        res = bridge.safe_call("execute_luau", {"code": DS_WRITE, "confirm": True}, 5)
        self.assertNotEqual(res.get("status"), "confirm_required")

    def test_validate_command_carries_risk(self):
        res = bridge.safe_call("validate_command",
                               {"tool": "execute_luau", "code": TARGETED}, 5)
        self.assertTrue(res["ok"], res)
        body = json.loads(res["text"])
        self.assertEqual(body["risk"]["level"], "MEDIUM")
        self.assertIn("Preflight", body["summary"])

    def test_bad_mode_rejected(self):
        res = bridge.safe_call("batch_queue",
                               {"commands": [{"tool": "get_time"}], "mode": "yolo"}, 5)
        self.assertFalse(res["ok"])
        self.assertEqual(res.get("kind"), "validation_error")


class AtomicBatchTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        assert bridge.QUEUE_PORT == 18082, bridge.QUEUE_PORT
        assert bridge.start_queue_server() is True
        mgr = bridge.MCPManager()
        mgr.load_config()
        bridge.mgr = mgr
        bridge._queue_last_poll[0] = time.time()

    def _run_plugin(self, seen, stop):
        # Simulated Studio plugin: snapshots identical (perfect revert),
        # create succeeds, delete fails, rollback succeeds.
        while not stop.is_set():
            try:
                _, body = http("GET", "/queue/next?projectId=default")
            except Exception:
                time.sleep(0.05)
                continue
            cmd = body.get("command")
            if not cmd:
                time.sleep(0.05)
                continue
            seen.append(cmd["tool"])
            if cmd["tool"] in ("take_snapshot", "get_snapshot"):
                http("POST", "/queue/result",
                     {"id": cmd["id"], "result": {"snapshot": "HDR\ntree-v1"}})
            elif cmd["tool"] == "create_instance":
                http("POST", "/queue/result",
                     {"id": cmd["id"], "result": {"created": "Workspace/P"}})
            elif cmd["tool"] == "delete_instance":
                http("POST", "/queue/result",
                     {"id": cmd["id"], "result": None, "error": "not found Workspace/Nope"})
            elif cmd["tool"] == "rollback":
                http("POST", "/queue/result",
                     {"id": cmd["id"], "result": {"undone": True}})
            else:
                http("POST", "/queue/result",
                     {"id": cmd["id"], "result": {"ok": True}})
        return

    def _batch(self, mode):
        seen, stop = [], threading.Event()
        t = threading.Thread(target=self._run_plugin, args=(seen, stop), daemon=True)
        t.start()
        try:
            bridge._queue_last_poll[0] = time.time()
            res = bridge.safe_call("batch_queue", {
                "projectId": "default",
                "mode": mode,
                "commands": [
                    {"tool": "create_instance",
                     "args": {"className": "Part", "parent": "workspace"}},
                    {"tool": "delete_instance",
                     "args": {"path": "Workspace/Nope"}},
                ]}, 30)
        finally:
            stop.set()
            t.join(timeout=5)
        return res, seen

    def test_atomic_rolls_back_and_verifies(self):
        res, seen = self._batch("atomic")
        self.assertFalse(res["ok"], res)
        self.assertEqual(res.get("error_code"), "TX_ROLLBACK")
        body = json.loads(res["error"])
        self.assertEqual(body["mode"], "atomic")
        self.assertEqual(body["status"], "rolled_back")
        self.assertTrue(body["rolledBack"])
        self.assertEqual(body["undoneSteps"], 1)
        self.assertFalse(body["partialCommitAllowed"])
        self.assertTrue(body["verification"]["passed"])
        self.assertIn("rollback", seen, "atomic failure must issue rollback")
        self.assertEqual(body["succeeded"], 1)

    def test_best_effort_leaves_steps_no_rollback(self):
        res, seen = self._batch("best_effort")
        self.assertTrue(res["ok"], res)
        body = json.loads(res["text"])
        self.assertEqual(body["status"], "stopped-at-first-failure")
        self.assertTrue(body["partialCommitAllowed"])
        self.assertNotIn("rollback", seen)


if __name__ == "__main__":
    unittest.main(verbosity=1)
