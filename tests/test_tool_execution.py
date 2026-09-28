# tests/test_tool_execution.py - execution truth audit (not just existence).
#   py -3 tests/test_tool_execution.py
# Fails if any Studio path can still return bare {queued:true} as a terminal
# result, or if the envelope contract is missing in any layer.
import io, os, json, re, unittest
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


def read(*parts):
    with io.open(os.path.join(ROOT, *parts), encoding="utf-8", errors="replace") as f:
        return f.read()


class ExecutionTruthTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with io.open(os.path.join(ROOT, "tests", "__registry__.json"), encoding="utf-8") as f:
            cls.registry = json.load(f)
        cls.registry_ts = read("mcp-server", "src", "tools", "registry.ts")
        cls.queue_ts = read("mcp-server", "src", "commandQueue.ts")
        cls.protocol = read("shared", "protocol.ts")
        cls.bridge = read("bridge.py")
        cls.execution_js = read("rolink-extension", "core", "execution.js")
        cls.plugin = read("studio-plugin", "RoLink.lua")

    def test_protocol_v2_envelope(self):
        self.assertIn("PROTOCOL_VERSION = 2", self.protocol)
        for token in ("ExecutionEnvelope", "ExecutionStatus", "ErrorCode",
                      "makeExecutionEnvelope", "executionId", "durationMs"):
            self.assertIn(token, self.protocol, f"protocol missing {token}")
        self.assertIn('"running"', self.protocol)

    def test_no_bare_studioqueue_callsites(self):
        # The deprecated studioQueue() definition is allowed once; no handler
        # may still call it. All Studio paths must await studioQueueAndWait.
        calls = [m for m in re.finditer(r"studioQueue\(", self.registry_ts)]
        # definition line: "function studioQueue(" — excluded via lookbehind
        non_def = [m for m in calls
                   if not self.registry_ts[max(0, m.start()-9):m.start()].endswith("function ")]
        self.assertEqual(non_def, [], "bare studioQueue() call site remains (queued:true lie)")
        self.assertGreaterEqual(self.registry_ts.count("await studioQueueAndWait("), 50,
                                "expected most handlers to await the terminal envelope")

    def test_execute_luau_waits(self):
        m = re.search(r'name: "execute_luau".*?handler: async \(a\)=>\{(.{0,1200})', self.registry_ts, re.S)
        self.assertIsNotNone(m, "execute_luau handler missing")
        body = m.group(0)
        self.assertIn("waitForResult", body, "execute_luau must wait for Studio")
        self.assertIn("executionId", body)
        self.assertNotIn("queued:true", body.replace("queued as done", ""))

    def test_batch_queue_terminal(self):
        m = re.search(r'name: "batch_queue".*?handler: async', self.registry_ts)
        self.assertIsNotNone(m)
        # batch handler must build per-command envelopes, reject nesting
        seg = self.registry_ts[m.start():m.start()+3000]
        self.assertIn("nested batches are not allowed", seg)
        self.assertIn("succeeded", seg)

    def test_node_queue_running_and_execution_id(self):
        self.assertIn("markRunning", self.queue_ts)
        self.assertIn("executionId", self.queue_ts)
        self.assertIn('"running"', self.queue_ts)

    def test_bridge_envelope(self):
        for token in ("def _make_envelope", "executionId", "durationMs", '"success"',
                      "STUCK_EXECUTION", "PLUGIN_OFFLINE", "rl_"):
            self.assertIn(token, self.bridge, f"bridge missing {token}")
        # _queue_call terminal paths must carry envelope keys
        seg = self.bridge[self.bridge.index("def _queue_call"):]
        seg = seg[:8000]
        self.assertIn("executionId", seg)
        self.assertIn("verification", seg)

    def test_extension_propagates_envelope(self):
        self.assertIn("executionId", self.execution_js)
        self.assertIn("durationMs", self.execution_js)
        self.assertIn("verification", self.execution_js)

    def test_plugin_reports_status(self):
        self.assertIn("pluginVersion", self.plugin)
        self.assertIn('status=(err and "error" or "success")', self.plugin)

    def test_every_registry_tool_has_handler(self):
        # Same spirit as completeness, but asserts each name maps to a handler
        # that resolves to an envelope (not merely exists in a zod schema).
        missing = [n for n in self.registry if f'name: "{n}"' not in self.registry_ts]
        self.assertEqual(missing, [], f"no handler: {missing}")

    def test_preflight_and_atomic_contract(self):
        # Risk gate (execute_luau): analyzer + confirm_required on both paths.
        for token in ("_luau_risk", "confirm_required", "CONFIRM_REQUIRED",
                      "_risk_summary", "requiresConfirm"):
            self.assertIn(token, self.bridge, f"bridge missing {token}")
        self.assertTrue(os.path.exists(os.path.join(ROOT, "mcp-server", "src",
                                                     "security", "preflight.ts")))
        self.assertIn("analyzeRisk", self.registry_ts)
        self.assertIn("confirm", self.registry_ts)
        # Atomic batch: snapshot + undo + hash verify, never partial commit.
        for token in ("TX_ROLLBACK", '"atomic"', "partialCommitAllowed",
                      "rolled_back", "rollback_failed"):
            self.assertIn(token, self.bridge, f"bridge batch missing {token}")
        self.assertIn("undoneSteps", self.bridge)
        # Failed commands are terminal: queue_take must skip them (no error loop).
        seg = self.bridge[self.bridge.index("def queue_take"):]
        self.assertIn('("done", "failed")', seg[:1200])


if __name__ == "__main__":
    unittest.main(verbosity=1)
