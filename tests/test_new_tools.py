# tests/test_new_tools.py - 2.4.0: diagnostics/inspection/state/memory/HUD/audit.
#   py -3 tests/test_new_tools.py
import sys, os, io, json, re, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

os.environ["ROLINK_QUEUE_PORT"] = "18083"
sys.path.insert(0, ROOT)
import bridge

NEW_TOOLS = ["scan_errors", "inspect_ui", "screenshot_studio",
             "playtest_scenario", "migrate_system",
             "analyze_animatable_model", "create_model_animation",
             "set_model_keyframe", "set_model_easing", "add_animation_marker",
             "preview_model_animation", "validate_model_animation",
             "retime_animation", "reverse_animation", "mirror_animation",
             "blend_animation", "fix_animation", "create_attack_animation",
             "create_idle_animation", "create_walk_cycle",
             "set_track_lock", "create_motion_animation",
             "inspect_motion_animation", "validate_motion_animation",
             "preview_motion_animation", "remove_motion_animation",
             "inspect_motion_effect", "remove_motion_effect",
             "preview_cutscene", "validate_cutscene", "remove_cutscene"]


def read(*parts):
    with io.open(os.path.join(ROOT, *parts), encoding="utf-8", errors="replace") as f:
        return f.read()


class NewToolChainTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with io.open(os.path.join(ROOT, "tests", "__registry__.json"), encoding="utf-8") as f:
            cls.registry = json.load(f)
        with io.open(os.path.join(ROOT, "generated", "tool-prompts.json"), encoding="utf-8") as f:
            cls.prompts = json.load(f).get("prompts", {})
        with io.open(os.path.join(ROOT, "tests", "tool-samples.json"), encoding="utf-8") as f:
            cls.samples = json.load(f)
        cls.registry_ts = read("mcp-server", "src", "tools", "registry.ts")
        cls.plugin = read("studio-plugin", "RoLink.lua")
        mgr = bridge.MCPManager()
        mgr.load_config()
        bridge.mgr = mgr  # no servers started: queue/Studio paths stay offline

    def test_registry_has_147_with_new_tools(self):
        self.assertEqual(len(self.registry), 150)
        for n in NEW_TOOLS:
            self.assertIn(n, self.registry)

    def test_new_tools_full_chain(self):
        for n in NEW_TOOLS:
            self.assertIn(f'name: "{n}"', self.registry_ts, f"{n}: no zod schema")
            self.assertIn(f'"{n}"', self.plugin, f"{n}: no plugin branch")
            p = self.prompts.get(n)
            self.assertTrue(p, f"{n}: no prompt")
            for field in ("when_to_use", "args_guide", "example_call", "pitfalls"):
                self.assertTrue((p.get(field) or "").strip(), f"{n}: prompt {field} empty")
            self.assertIn(n, self.samples, f"{n}: no sample")

    def test_probes_route_to_queue_offline(self):
        # Offline they must report plugin_offline install guidance (never a
        # StudioMCP "unknown tool", never a burnt queue wait).
        for n, args in (("scan_errors", {"limit": 5}),
                        ("inspect_ui", {"root": "StarterGui"}),
                        ("screenshot_studio", {}),
                        ("analyze_animatable_model", {"target": "Workspace/Nope"}),
                        ("blend_animation", {"base": "X", "overlay": "Y", "newName": "Z"}),
                        ("set_track_lock", {"anim": "X", "track": "Y"})):
            bridge._queue_last_poll[0] = 0.0
            res = bridge.safe_call(n, args, 5)
            self.assertFalse(res["ok"], (n, res))
            self.assertEqual(res.get("kind"), "plugin_offline", (n, res))
            self.assertIn("install-plugin", res.get("error", ""))

    def test_playtest_composes_offline(self):
        res = bridge.safe_call("playtest_scenario",
                               {"scenario": "x joins", "seconds": 1, "expect": "y"}, 10)
        self.assertFalse(res["ok"], res)  # nothing alive: checks fail honestly
        body = json.loads(res["text"])
        self.assertEqual(body["scenario"], "x joins")
        self.assertIn("checks", body)

    def test_migrate_plans_offline(self):
        res = bridge.safe_call("migrate_system",
                               {"system": "lb", "goal": "modules",
                                "sources": ["ServerScriptService/LB"]}, 10)
        self.assertTrue(res["ok"], res)
        body = json.loads(res["text"])
        self.assertTrue(body["planOnly"])
        self.assertEqual(body["plan"]["system"], "lb")

    def test_migrate_rejects_bad_steps(self):
        res = bridge.safe_call("migrate_system",
                               {"system": "lb", "goal": "modules", "sources": [],
                                "plan_only": False, "confirm": True,
                                "steps": [{"tool": "delete_instance",
                                           "args": {"path": "Workspace"}}]}, 10)
        self.assertFalse(res["ok"])
        self.assertEqual(res.get("kind"), "validation_error")

    def test_studio_state_offline_shape(self):
        bridge._queue_last_poll[0] = 0.0
        res = bridge.safe_call("get_studio_state", {}, 5)
        self.assertTrue(res["ok"], res)
        body = json.loads(res["text"])
        for key in ("studio", "place", "playState", "selected", "plugin",
                    "bridge", "pendingTasks", "project"):
            self.assertIn(key, body, f"missing {key}")
        self.assertEqual(body["bridge"], "2.14.0")
        self.assertIsInstance(body["selected"], list)
        self.assertIsInstance(body["pendingTasks"], int)

    def test_memory_round_trip(self):
        proj = "test_tmp_mem"
        try:
            res = bridge.safe_call("get_memory", {"project": proj}, 5)
            self.assertTrue(res["ok"], res)
            self.assertIn("architecture", json.loads(res["text"])["sections"])
            res = bridge.safe_call("update_memory",
                                   {"project": proj, "section": "decisions",
                                    "content": "use modules"}, 5)
            self.assertTrue(res["ok"], res)
            res = bridge.safe_call("get_memory",
                                   {"project": proj, "section": "decisions"}, 5)
            self.assertIn("use modules", res["text"])
            res = bridge.safe_call("update_memory",
                                   {"project": proj, "section": "decisions",
                                    "content": "and remotes", "mode": "append"}, 5)
            self.assertTrue(res["ok"], res)
            res = bridge.safe_call("get_memory",
                                   {"project": proj, "section": "decisions"}, 5)
            self.assertIn("remotes", res["text"])
            bad = bridge.safe_call("update_memory",
                                   {"project": proj, "section": "nope",
                                    "content": "x"}, 5)
            self.assertFalse(bad["ok"])
            self.assertEqual(bad.get("kind"), "validation_error")
        finally:
            try:
                os.remove(bridge._memory_path(proj))
            except Exception:
                pass


class HudWiringTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with io.open(os.path.join(ROOT, "rolink-extension", "manifest.json"),
                     encoding="utf-8") as f:
            cls.manifest = json.load(f)
        cls.panel = read("rolink-extension", "ui", "build-panel.js")
        cls.css = read("rolink-extension", "overlay.css")

    def test_panel_wired_in_every_isolated_bundle(self):
        bundles = [cs for cs in self.manifest["content_scripts"]
                   if "core/main.js" in cs.get("js", []) and "world" not in cs]
        self.assertGreaterEqual(len(bundles), 8, "expected provider bundles")
        for cs in bundles:
            js = cs["js"]
            self.assertIn("core/tool-events.js", js, cs.get("matches"))
            self.assertIn("ui/build-panel.js", js, cs.get("matches"))
            self.assertLess(js.index("core/tool-events.js"), js.index("core/main.js"))
            self.assertLess(js.index("ui/build-panel.js"), js.index("core/main.js"))

    def test_panel_api_surface(self):
        for token in ("RolinkBuildPanel", "setGoal", "notifyLoopStart",
                      "phaseOf", "RolinkToolEvents", "rl-build-panel"):
            self.assertIn(token, self.panel, f"panel missing {token}")

    def test_panel_styles_present(self):
        for token in ("#rl-build-panel", ".rl-bp-bar", ".rl-bp-cur", ".rl-bp-now"):
            self.assertIn(token, self.css, f"css missing {token}")


class AuditScriptTest(unittest.TestCase):
    def test_audit_runs_clean(self):
        import subprocess
        r = subprocess.run([sys.executable, os.path.join(ROOT, "scripts", "audit_tools.py")],
                           capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("150 registered", r.stdout)
        qpath = os.path.join(ROOT, "generated", "tool-quarantine.json")
        self.assertTrue(os.path.exists(qpath))
        q = json.load(io.open(qpath, encoding="utf-8"))
        self.assertEqual(q["failing"], [])
        self.assertIn("verified", q)

    def test_generated_mirrors_have_new_tools(self):
        ext = read("rolink-extension", "core", "tool-prompts.js")
        cf = read("rolink-extension", "core", "code-fields.js")
        for n in NEW_TOOLS:
            self.assertIn(f'"{n}"', ext, f"extension prompts missing {n}")
            self.assertIn(f'"{n}"', cf, f"code-fields missing {n}")


if __name__ == "__main__":
    unittest.main(verbosity=1)
