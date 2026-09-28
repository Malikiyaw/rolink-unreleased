# tests/test_tool_completeness.py - all 150 tools exist in every layer.
#   python3 tests/test_tool_completeness.py
# For each registry name: (a) zod schema in mcp-server registry.ts,
# (b) dispatcher branch in studio-plugin/RoLink.lua, (c) prompt entry in
# generated/tool-prompts.json, (d) sample args (tool-samples.json) or an
# extension fixture. Fails naming the tool and the missing piece.
import io, os, json, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


def read(*parts):
    with io.open(os.path.join(ROOT, *parts), encoding="utf-8", errors="replace") as f:
        return f.read()


class CompletenessTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with io.open(os.path.join(ROOT, "tests", "__registry__.json"), encoding="utf-8") as f:
            cls.registry = json.load(f)
        with io.open(os.path.join(ROOT, "generated", "tool-prompts.json"), encoding="utf-8") as f:
            cls.prompts = json.load(f).get("prompts", {})
        try:
            with io.open(os.path.join(ROOT, "tests", "tool-samples.json"), encoding="utf-8") as f:
                cls.samples = json.load(f)
        except Exception:
            cls.samples = {}
        cls.registry_ts = read("mcp-server", "src", "tools", "registry.ts")
        cls.plugin = read("studio-plugin", "RoLink.lua")
        import glob
        cls.fixtures = {os.path.splitext(os.path.basename(p))[0]
                        for p in glob.glob(os.path.join(
                            ROOT, "rolink-extension", "core", "__fixtures__",
                            "tool-calls", "*.txt"))}

    def test_registry_is_147_unique(self):
        self.assertEqual(len(self.registry), 150)
        self.assertEqual(len(set(self.registry)), 150)

    def test_every_tool_in_registry_ts(self):
        missing = [n for n in self.registry if f'name: "{n}"' not in self.registry_ts]
        self.assertEqual(missing, [], f"no zod schema: {missing}")

    def test_every_tool_in_studio_plugin(self):
        # Dispatcher uses tool=="<name>" branches (aliases included, e.g.
        # tool=="run_code" shares the execute_luau branch).
        missing = [n for n in self.registry if f'"{n}"' not in self.plugin]
        self.assertEqual(missing, [], f"no plugin branch: {missing}")

    def test_every_tool_has_prompt(self):
        missing = [n for n in self.registry if n not in self.prompts]
        self.assertEqual(missing, [], f"no prompt: {missing}")
        for n in self.registry:
            for field in ("when_to_use", "args_guide", "example_call", "pitfalls"):
                self.assertTrue((self.prompts[n].get(field) or "").strip(),
                                f"{n}: prompt field {field} empty")

    def test_every_tool_has_sample_or_fixture(self):
        missing = [n for n in self.registry
                   if n not in self.samples and n not in self.fixtures]
        self.assertEqual(missing, [], f"no sample/fixture: {missing}")

    def test_plugin_has_no_hud(self):
        # The in-Studio hologram HUD is removed: a Visualizer throw inside
        # poll() used to abort the whole poll, so claimed commands were never
        # reported and the bridge timed out. The bridge terminal is the display.
        for marker in ("Visualizer", "VHud", "VLog", "VStats", "hudBtn",
                       "hologram", "RoLinkHUD"):
            self.assertNotIn(marker, self.plugin, f"HUD remnant: {marker}")
        # ...but the execution + reporting path must survive the removal.
        for snippet in ("local function poll()", "pcall(executeCommand",
                        "reportResult(cmd.id, result, err, elapsed",
                        "local function executeCommand",
                        "/queue/next", "/queue/result"):
            self.assertIn(snippet, self.plugin, f"poll path broken, missing: {snippet}")

    def test_plugin_character_help(self):
        # CHARACTER errors must name real rigs; render honesty needs IsRunning.
        for snippet in ("local function rigCandidates", "FindFirstChildOfClass(\"Humanoid\")",
                        "Rigs with a Humanoid here", "IsRunning()",
                        "Edit mode never renders animation playback"):
            self.assertIn(snippet, self.plugin, f"missing: {snippet}")

    def test_plugin_version_handshake(self):
        # Poll carries ?pv=PLUGIN_VERSION; bridge tracks + warns on mismatch.
        # PLUGIN_VERSION must equal the repo VERSION (kept in sync by hand).
        import re
        m = re.search(r'local PLUGIN_VERSION = "([^"]+)"', self.plugin)
        self.assertIsNotNone(m, "PLUGIN_VERSION missing in plugin")
        repo_version = open(os.path.join(ROOT, "VERSION"), encoding="utf-8").read().strip()
        self.assertEqual(m.group(1), repo_version,
                         f"plugin {m.group(1)} != repo {repo_version}")
        self.assertIn("pv=", self.plugin)
        bridge_src = open(os.path.join(ROOT, "bridge.py"), encoding="utf-8").read()
        self.assertIn("VERSION MISMATCH", bridge_src)

    def test_plugin_sandbox_parity(self):
        # The index-nil class dies here: datatype globals the model uses.
        for g in ("Vector3=", "Vector2=", "CFrame=", "Color3=", "UDim2=",
                  "BrickColor=", "TweenInfo=", "utf8=", "bit32=", "coroutine="):
            self.assertIn(g, self.plugin, f"sandbox missing: {g}")

    def test_plugin_stuck_watchdog(self):
        # Hung executions must announce themselves in Studio Output.
        for snippet in ("STILL RUNNING", "probable infinite loop",
                        "do not resend the same code"):
            self.assertIn(snippet, self.plugin, f"missing: {snippet}")

    def test_execution_budget(self):
        # Yield-transparent execution: direct pcall (poll already runs in
        # task.spawn, so task.wait resumes normally), hook only where the
        # engine supports it, never a busy-resume loop.
        for snippet in ("local function runBudgeted", "HAS_SETHOOK", "sethook",
                        "HOOK_MAX_HITS",
                        "budget exceeded"):
            self.assertIn(snippet, self.plugin, f"missing: {snippet}")
        self.assertNotIn("while r[1] and coroutine.status", self.plugin)
        self.assertNotIn("while results[1] and coroutine.status", self.plugin)
        self.assertIn("runBudgeted", self.plugin)
        # Both the main and heal paths execute via runWithDeadline, which is
        # the only caller of runBudgeted (it owns the instruction budget).
        self.assertGreaterEqual(self.plugin.count("pcall(runWithDeadline"), 2)
        self.assertGreaterEqual(self.plugin.count("pcall(runBudgeted"), 1)

    def test_findbypath_walk_order(self):
        # Slash-walk, then dot-walk, then legacy exact-name fallbacks. Order
        # is the feature: dot paths ("Workspace.Rig") must resolve before the
        # legacy scan, which must survive for dotted names ("My.Part").
        slash = self.plugin.index("slash-walk")
        dot = self.plugin.index("dot-walk")
        legacy = self.plugin.index("legacy fallbacks")
        self.assertLess(slash, dot)
        self.assertLess(dot, legacy)
        self.assertIn('gmatch("[^/]+")', self.plugin)
        self.assertIn('gmatch("[^.]+")', self.plugin)

    def test_plugin_poll_unfiltered(self):
        # Project-scoped polls starved cross-project commands with zero
        # visible cause; the plugin must poll unfiltered (bridge scopes).
        self.assertIn("queue/next?projectId=&pv=", self.plugin)

    def test_alias_audit_no_arg_mismatch(self):
        # Every bridge alias target must exist in the registry, and the native
        # extras must exist as plugin branches (not aliases) with queue
        # routing + advertised descriptions in the bridge.
        import re
        bridge_src = open(os.path.join(ROOT, "bridge.py"), encoding="utf-8").read()
        m = re.search(r"_TOOL_ALIASES = \{(.*?)\n\}", bridge_src, re.S)
        pairs = re.findall(r'"(\w+)":\s*"(\w+)"', m.group(1))
        self.assertTrue(pairs, "no aliases parsed")
        # Alias targets live in the registry - except search_scripts, which
        # targets the native extra script_search (same rule as the bridge).
        for src, dst in pairs:
            self.assertIn(dst, self.registry + ["script_search"],
                          f"alias {src} -> unknown {dst}")
            self.assertNotIn(src, self.registry, f"alias {src} shadows a registry tool")
        for native in ("script_search", "script_grep", "search_game_tree",
                       "inspect_keyframe_track"):
            self.assertNotIn(f'"{native}":', m.group(1), f"{native} must not be an alias")
            self.assertIn(f'tool=="{native}"', self.plugin, f"no plugin branch: {native}")
            self.assertIn(native, bridge_src, f"bridge does not route {native}")
        # mcp-server parity: same alias keys except deliberate exclusions.
        ts = open(os.path.join(ROOT, "mcp-server", "src", "tools", "registry.ts"),
                  encoding="utf-8").read()
        m2 = re.search(r"aliasMap[^{]*\{(.*?)\};", ts, re.S)
        node_keys = set(re.findall(r"^\s{2}(\w+):", m2.group(1), re.M))
        bridge_keys = {s for s, _ in pairs}
        # Deliberate divergences: list_commands must never rewrite (catalog
        # flow), list_templates is a self-map, and the three search natives
        # are real plugin tools in the bridge (aliases in node's map only).
        allowed = {"list_commands", "list_templates",
                   "script_search", "script_grep", "search_game_tree"}
        self.assertEqual(node_keys - bridge_keys - allowed, set(),
                         "node aliases missing from bridge")


if __name__ == "__main__":
    unittest.main(verbosity=1)
