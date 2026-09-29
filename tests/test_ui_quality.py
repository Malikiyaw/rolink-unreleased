# SPDX-License-Identifier: GPL-3.0-or-later
# tests/test_ui_quality.py — PLAN.md Phases 2-5 (GUI quality loop).
#
# Verifies preview_ui + validate_ui, the component builders, the theme
# system, and the UI layout templates across the stack:
#   - bridge _QUEUE_EXTRA_TOOLS routing + advertised descriptions
#   - studio-plugin branches + rect/audit primitives + caps
#   - Node registry/prompts/generated artifacts at 213 tools
#
# Run: py -m unittest tests.test_ui_quality -v
import sys
import os
import io
import json
import re
import time
import threading
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
os.environ.setdefault("ROLINK_QUEUE_PORT", "18081")
sys.path.insert(0, ROOT)

import bridge


def read(*parts):
    with io.open(os.path.join(ROOT, *parts), encoding="utf-8", errors="replace") as f:
        return f.read()


UI_TOOLS = ("preview_ui", "validate_ui")


class UiBridgeRoutingTest(unittest.TestCase):
    def test_extras_contain_both(self):
        for name in UI_TOOLS:
            self.assertIn(name, bridge._QUEUE_EXTRA_TOOLS, name)

    def test_advertised_locally(self):
        for name in UI_TOOLS:
            entry = bridge._local_tool_entry(name)
            self.assertIsNotNone(entry, name)
            self.assertEqual(entry.get("server"), "local")
            self.assertTrue((entry.get("description") or "").strip(), name)

    def test_offline_is_plugin_offline(self):
        old_poll, old_on = bridge._queue_last_poll[0], bridge._queue_server_on[0]
        bridge._queue_last_poll[0] = 0.0
        bridge._queue_server_on[0] = True
        try:
            for name in UI_TOOLS:
                res = bridge.safe_call(name, {}, 5)
                self.assertFalse(res.get("ok"), name)
                self.assertEqual(res.get("kind"), "plugin_offline", (name, res))
        finally:
            bridge._queue_last_poll[0] = old_poll
            bridge._queue_server_on[0] = old_on

    def test_queues_when_plugin_alive(self):
        bridge._queue_server_on[0] = True
        bridge._queue_last_poll[0] = time.time()
        bridge._queue_consec_timeouts[0] = 0
        try:
            with bridge._queue_lock:
                ids = [cid for cid, c in bridge._queue_cmds.items()
                       if c.get("status") in ("queued", "claimed")]
            for cid in ids:
                try:
                    bridge.queue_cancel(cid)
                except Exception:
                    pass
            out = {}

            def run():
                out["res"] = bridge.safe_call("validate_ui", {"root": "StarterGui"}, 5)

            t = threading.Thread(target=run, daemon=True)
            t.start()
            deadline = time.time() + 6
            cmd = None
            while time.time() < deadline:
                c = bridge.queue_take(client="studio")
                if c is not None and c.get("tool") == "validate_ui":
                    cmd = c
                    break
                if c is not None:
                    try:
                        bridge.queue_cancel(c.get("id", ""))
                    except Exception:
                        pass
                time.sleep(0.05)
            self.assertIsNotNone(cmd, "validate_ui never enqueued")
            bridge.queue_complete(cmd["id"], {"passed": True, "issues": []}, None)
            t.join(timeout=8)
            self.assertTrue(out["res"].get("ok"), out["res"])
        finally:
            bridge._queue_last_poll[0] = 0.0


class UiPluginBranchTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.plugin = read("studio-plugin", "RoLink.lua")

    def test_helpers_defined(self):
        self.assertIn("local function previewUI", self.plugin)
        self.assertIn("local function validateUI", self.plugin)

    def test_dispatcher_branches(self):
        self.assertIn('tool=="preview_ui"', self.plugin)
        self.assertIn('tool=="validate_ui"', self.plugin)
        self.assertIn("previewUI(args)", self.plugin)
        self.assertIn("validateUI(args)", self.plugin)

    def test_rect_primitives(self):
        for snippet in ("AbsolutePosition", "AbsoluteSize", "AnchorPoint",
                        "ZIndex", "posScale", "sizeScale"):
            self.assertIn(snippet, self.plugin, f"missing: {snippet}")

    def test_audit_codes(self):
        for code in ("OVERLAP", "DUPLICATE_RECT", "OFFSCREEN", "CLIPPED",
                     "ZERO_SIZE", "EMPTY_TEXT", "FIXED_FULLSCREEN"):
            self.assertIn(f'"{code}"', self.plugin, f"missing code: {code}")

    def test_caps(self):
        for snippet in ("#els >= 200", "#issues >= 50", "#items >= 200"):
            self.assertIn(snippet, self.plugin, f"missing cap: {snippet}")


class UiCatalogTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.registry_ts = read("mcp-server", "src", "tools", "registry.ts")
        with io.open(os.path.join(ROOT, "generated", "tool-prompts.json"), encoding="utf-8") as f:
            cls.generated = json.load(f)
        with io.open(os.path.join(ROOT, "generated", "code-fields.json"), encoding="utf-8") as f:
            cls.fields = json.load(f)

    def test_registry_entries(self):
        for name in UI_TOOLS:
            self.assertIn(f'name: "{name}"', self.registry_ts, name)
            seg = self.registry_ts[self.registry_ts.find(f'name: "{name}"'):
                                   self.registry_ts.find(f'name: "{name}"') + 1200]
            self.assertIn("studioQueueAndWait", seg, name)
            self.assertIn('provider:"roblox"', seg.replace(" ", ""), name)
            m = re.search(r'name: "%s", description: "([^"]*)"' % re.escape(name), self.registry_ts)
            self.assertIsNotNone(m, name)
            self.assertLessEqual(len(m.group(1)), 200, name)

    def test_prompts_complete(self):
        prompts = self.generated.get("prompts", {})
        for name in UI_TOOLS:
            self.assertIn(name, prompts, name)
            for field in ("persona", "when_to_use", "args_guide", "example_call",
                          "output", "pitfalls"):
                self.assertTrue((prompts[name].get(field) or "").strip(),
                                f"{name}: {field} empty")

    def test_counts_213(self):
        self.assertEqual(self.generated.get("toolCount"), 213)
        self.assertEqual(self.generated.get("coverage"), "213/213")
        self.assertEqual(self.fields.get("toolCount"), 213)
        for name in UI_TOOLS:
            self.assertIn(name, self.fields.get("toolFields", {}), name)

    def test_converter_loop_wired(self):
        out = self.generated["prompts"]["create_ui_from_figma"]["output"]
        self.assertIn("validate_ui", out)
        self.assertIn("screenshot_studio", out)


COMPONENT_TOOLS = (
    "create_button",
    "create_panel",
    "create_text_label",
    "create_icon_button",
    "create_list",
    "create_modal",
    "create_tab_bar",
    "create_progress_bar",
    "create_input",
)


class UiComponentTest(unittest.TestCase):
    """PLAN.md Phase 3: styled component builders with baked-in theme."""

    def test_routed_and_advertised(self):
        for name in COMPONENT_TOOLS:
            self.assertIn(name, bridge._QUEUE_EXTRA_TOOLS, name)
            entry = bridge._local_tool_entry(name)
            self.assertIsNotNone(entry, name)
            self.assertEqual(entry.get("server"), "local")

    def test_offline_is_plugin_offline(self):
        old_poll, old_on = bridge._queue_last_poll[0], bridge._queue_server_on[0]
        bridge._queue_last_poll[0] = 0.0
        bridge._queue_server_on[0] = True
        try:
            res = bridge.safe_call("create_button", {"text": "Play"}, 5)
            self.assertFalse(res.get("ok"))
            self.assertEqual(res.get("kind"), "plugin_offline", res)
        finally:
            bridge._queue_last_poll[0] = old_poll
            bridge._queue_server_on[0] = old_on

    def test_plugin_core_and_branches(self):
        plugin = read("studio-plugin", "RoLink.lua")
        self.assertIn("local function buildUIComponent", plugin)
        kinds = ("button", "panel", "text_label", "icon_button", "list",
                 "modal", "tab_bar", "progress_bar", "input")
        for tool, kind in zip(COMPONENT_TOOLS, kinds):
            self.assertIn(f'tool=="{tool}"', plugin, tool)
            self.assertIn(f'buildUIComponent("{kind}"', plugin, kind)
        for snippet in ("GothamBold", "UICorner", "UIListLayout", "ScrollingFrame",
                        "TextButton", "ImageButton", "TextBox", "UIPadding",
                        "AutomaticCanvasSize", "ResetOnSpawn"):
            self.assertIn(snippet, plugin, f"missing: {snippet}")

    def test_catalog_counts_213(self):
        with io.open(os.path.join(ROOT, "generated", "tool-prompts.json"), encoding="utf-8") as f:
            generated = json.load(f)
        self.assertEqual(generated.get("toolCount"), 213)
        for name in COMPONENT_TOOLS:
            self.assertIn(name, generated.get("prompts", {}), name)
            for field in ("persona", "when_to_use", "args_guide", "example_call",
                          "output", "pitfalls"):
                self.assertTrue((generated["prompts"][name].get(field) or "").strip(),
                                f"{name}: {field} empty")
        with io.open(os.path.join(ROOT, "generated", "code-fields.json"), encoding="utf-8") as f:
            fields = json.load(f)
        self.assertEqual(fields.get("toolCount"), 213)
        for name in COMPONENT_TOOLS:
            self.assertIn(name, fields.get("toolFields", {}), name)


THEME_TOOLS = ("get_ui_theme", "set_ui_theme", "apply_ui_theme")


class UiThemeTest(unittest.TestCase):
    """PLAN.md Phase 4: design tokens (store/get/set/apply)."""

    def test_routed_and_advertised(self):
        for name in THEME_TOOLS:
            self.assertIn(name, bridge._QUEUE_EXTRA_TOOLS, name)
            entry = bridge._local_tool_entry(name)
            self.assertIsNotNone(entry, name)
            self.assertEqual(entry.get("server"), "local")

    def test_offline_is_plugin_offline(self):
        old_poll, old_on = bridge._queue_last_poll[0], bridge._queue_server_on[0]
        bridge._queue_last_poll[0] = 0.0
        bridge._queue_server_on[0] = True
        try:
            res = bridge.safe_call("get_ui_theme", {}, 5)
            self.assertFalse(res.get("ok"))
            self.assertEqual(res.get("kind"), "plugin_offline", res)
        finally:
            bridge._queue_last_poll[0] = old_poll
            bridge._queue_server_on[0] = old_on

    def test_plugin_theme_core(self):
        plugin = read("studio-plugin", "RoLink.lua")
        for snippet in ("local function defaultTheme", "local function effectiveTheme",
                        "local function getUITheme", "local function setUITheme",
                        "local function applyUITheme", "local function themeRole",
                        "local function weightToFont", "local function encodeThemeSrc",
                        "local function parseThemeColor", "RoLinkTheme"):
            self.assertIn(snippet, plugin, f"missing: {snippet}")
        for tool in THEME_TOOLS:
            self.assertIn(f'tool=="{tool}"', plugin, tool)

    def test_components_read_effective_theme(self):
        plugin = read("studio-plugin", "RoLink.lua")
        self.assertIn("effectiveTheme()", plugin)
        self.assertIn("Overlay custom theme colors", plugin)

    def test_catalog_covers_theme(self):
        with io.open(os.path.join(ROOT, "generated", "tool-prompts.json"), encoding="utf-8") as f:
            generated = json.load(f)
        for name in THEME_TOOLS:
            self.assertIn(name, generated.get("prompts", {}), name)
            for field in ("persona", "when_to_use", "args_guide", "example_call",
                          "output", "pitfalls"):
                self.assertTrue((generated["prompts"][name].get(field) or "").strip(),
                                f"{name}: {field} empty")
        with io.open(os.path.join(ROOT, "generated", "code-fields.json"), encoding="utf-8") as f:
            fields = json.load(f)
        for name in THEME_TOOLS:
            self.assertIn(name, fields.get("toolFields", {}), name)


TEMPLATE_TOOLS = ("list_ui_templates", "apply_ui_template", "fill_ui_template")
TEMPLATE_IDS = ("shop_ui", "hud", "inventory", "settings", "dialog", "login",
               "leaderboard")


class UiTemplateTest(unittest.TestCase):
    """PLAN.md Phase 5: whole-screen layout templates (apply + fill)."""

    def test_routed_and_advertised(self):
        for name in TEMPLATE_TOOLS:
            self.assertIn(name, bridge._QUEUE_EXTRA_TOOLS, name)
            entry = bridge._local_tool_entry(name)
            self.assertIsNotNone(entry, name)
            self.assertEqual(entry.get("server"), "local")

    def test_offline_is_plugin_offline(self):
        old_poll, old_on = bridge._queue_last_poll[0], bridge._queue_server_on[0]
        bridge._queue_last_poll[0] = 0.0
        bridge._queue_server_on[0] = True
        try:
            res = bridge.safe_call("list_ui_templates", {}, 5)
            self.assertFalse(res.get("ok"))
            self.assertEqual(res.get("kind"), "plugin_offline", res)
        finally:
            bridge._queue_last_poll[0] = old_poll
            bridge._queue_server_on[0] = old_on

    def test_plugin_template_core(self):
        plugin = read("studio-plugin", "RoLink.lua")
        for snippet in ("local UITemplateDefs", "local function listUITemplates",
                        "local function applyUITemplate", "local function fillUITemplate"):
            self.assertIn(snippet, plugin, f"missing: {snippet}")
        for tool in TEMPLATE_TOOLS:
            self.assertIn(f'tool=="{tool}"', plugin, tool)

    def test_every_template_id_is_defined(self):
        plugin = read("studio-plugin", "RoLink.lua")
        start = plugin.index("local UITemplateDefs")
        end = plugin.index("local function listUITemplates")
        block = plugin[start:end]
        for tid in TEMPLATE_IDS:
            self.assertIn(f"{tid} = {{", block, f"template missing: {tid}")

    def test_templates_reuse_component_builders(self):
        """No duplicated builders - steps must use buildUIComponent kinds."""
        plugin = read("studio-plugin", "RoLink.lua")
        start = plugin.index("local UITemplateDefs")
        end = plugin.index("local function listUITemplates")
        block = plugin[start:end]
        kinds = set(re.findall(r'kind = "(\w+)"', block))
        self.assertTrue(kinds, "no template steps found")
        for kind in kinds:
            self.assertIn(f'kind == "{kind}"', plugin,
                          f"template uses unknown builder kind: {kind}")

    def test_steps_do_not_share_one_pixel(self):
        """Sibling steps need explicit x/y so parts do not stack centered."""
        plugin = read("studio-plugin", "RoLink.lua")
        start = plugin.index("local UITemplateDefs")
        end = plugin.index("local function listUITemplates")
        block = plugin[start:end]
        steps = re.findall(r'\{ kind = "(\w+)"(.*?)\}(?=,\s*\n|\s*\} )', block, re.S)
        self.assertGreaterEqual(len(steps), len(TEMPLATE_IDS))
        for kind, body in steps:
            if kind == "modal":
                continue  # veil is deliberately fullscreen-centered
            self.assertTrue('x = ' in body and 'y = ' in body,
                            f"step {kind} has no explicit x/y: {body[:80]}")

    def test_nesting_resolves_to_earlier_step(self):
        plugin = read("studio-plugin", "RoLink.lua")
        start = plugin.index("local UITemplateDefs")
        end = plugin.index("local function listUITemplates")
        block = plugin[start:end]
        for container, template in re.findall(r'\{ kind = "panel", name = "(\w+)"(.*?)\n    \} \}', block, re.S):
            for nest in re.findall(r'parentStep = "(\w+)"', template):
                self.assertEqual(nest, container,
                                 f"step nests in {nest} but template container is {container}")
        self.assertIn("which is not an earlier step", plugin)
        # `in` is a reserved Luau word: as a table key it is a hard parse
        # error that stops the WHOLE plugin loading (shipped broken in 2.13.0).
        self.assertNotIn(", in = ", block)
        self.assertNotIn("s.in", plugin)

    def test_fill_is_bounded_and_validated(self):
        plugin = read("studio-plugin", "RoLink.lua")
        self.assertIn("'values' (array of {path, property, value}, 1-50) is required", plugin)
        self.assertIn("max 50 values, got", plugin)
        self.assertIn("return { target = target, applied = applied, failed = failed,", plugin)

    def test_catalog_counts_213(self):
        with io.open(os.path.join(ROOT, "generated", "tool-prompts.json"), encoding="utf-8") as f:
            generated = json.load(f)
        self.assertEqual(generated.get("toolCount"), 213)
        self.assertEqual(generated.get("coverage"), "213/213")
        for name in TEMPLATE_TOOLS:
            self.assertIn(name, generated.get("prompts", {}), name)
            for field in ("persona", "when_to_use", "args_guide", "example_call",
                          "output", "pitfalls"):
                self.assertTrue((generated["prompts"][name].get(field) or "").strip(),
                                f"{name}: {field} empty")
        with io.open(os.path.join(ROOT, "generated", "code-fields.json"), encoding="utf-8") as f:
            fields = json.load(f)
        self.assertEqual(fields.get("toolCount"), 213)
        for name in TEMPLATE_TOOLS:
            self.assertIn(name, fields.get("toolFields", {}), name)

    def test_template_tools_are_distinct_from_code_templates(self):
        """list_ui_templates must not collide with the run_code templates."""
        plugin = read("studio-plugin", "RoLink.lua")
        self.assertIn('tool=="list_templates" or tool=="add_template" or tool=="apply_template"'
                      ' or tool=="create_template"', plugin)
        with io.open(os.path.join(ROOT, "tests", "__registry__.json"), encoding="utf-8") as f:
            registry = json.load(f)
        for name in TEMPLATE_TOOLS:
            self.assertNotIn(name, registry, f"{name} must stay a queue extra")


if __name__ == "__main__":
    unittest.main(verbosity=1)
