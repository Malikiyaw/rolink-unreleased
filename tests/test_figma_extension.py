# SPDX-License-Identifier: GPL-3.0-or-later
# tests/test_figma_extension.py — PLAN.md Phase 5, Tasks 5.1-5.4.
#
# Verifies the extension-side Figma integration (static, no browser needed):
#   - options.html has the Figma bridge section (status dot/text/meta/note,
#     Check + Reconnect buttons)
#   - options.js polls figma_status via the generic call_tool path every 5s,
#     renders every figma_status verdict, and reconnects via type reconnect
#   - background.js needs NO change (generic call_tool forwards name+arguments
#     verbatim — asserted so a future refactor keeps the path generic)
#   - config.js system prompt names the figma tools + figma_status diagnostics
#
# Run: py -m unittest tests.test_figma_extension -v
import sys
import os
import io
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
os.environ.setdefault("ROLINK_QUEUE_PORT", "18081")
sys.path.insert(0, ROOT)


def read(*parts):
    with io.open(os.path.join(ROOT, *parts), encoding="utf-8", errors="replace") as f:
        return f.read()


class FigmaOptionsHtmlTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.html = read("rolink-extension", "options.html")

    def test_figma_section_exists(self):
        self.assertIn("Figma bridge", self.html)

    def test_status_elements(self):
        for el in ('id="figmaDot"', 'id="figmaStatus"', 'id="figmaMeta"',
                   'id="figmaNote"', 'id="figmaMsg"'):
            self.assertIn(el, self.html, f"missing {el}")

    def test_buttons(self):
        for el in ('id="figmaCheck"', 'id="figmaReconnect"'):
            self.assertIn(el, self.html, f"missing {el}")

    def test_desktop_guidance(self):
        self.assertIn("Desktop", self.html)


class FigmaOptionsJsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.js = read("rolink-extension", "options.js")

    def test_uses_generic_call_tool_path(self):
        self.assertIn('"call_tool"', self.js)
        self.assertIn('"figma_status"', self.js)

    def test_polls_every_5s(self):
        self.assertIn("setInterval(refreshFigmaStatus, 5000)", self.js)

    def test_renders_all_verdicts(self):
        for verdict in ("healthy", "executing", "stuck-execution",
                        "plugin-stale", "no-queue"):
            self.assertIn(f'"{verdict}"', self.js, f"verdict not rendered: {verdict}")
        # no-plugin shares the default branch (with anything unknown).
        self.assertIn("default: // no-plugin", self.js)

    def test_handles_bridge_offline(self):
        self.assertIn("Bridge offline", self.js)

    def test_reconnect_asks_background(self):
        self.assertIn('"reconnect"', self.js)


class FigmaBackgroundUnchangedTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.js = read("rolink-extension", "background.js")

    def test_call_tool_stays_generic(self):
        # The Figma routing must keep working through the generic forwarder:
        # background.js forwards msg.name/msg.arguments verbatim and never
        # allowlists tool names. If someone adds a name check here, Figma
        # tools break — this test pins the generic shape.
        self.assertIn('name: msg.name', self.js)
        self.assertIn('arguments: msg.arguments', self.js)
        self.assertNotIn("figma", self.js)


class FigmaSystemPromptTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.config = read("rolink-extension", "core", "config.js")

    def test_tool_lines(self):
        for tool in ("figma_create_frame", "figma_get_nodes",
                     "create_ui_from_figma"):
            self.assertIn(tool, self.config, f"prompt missing {tool}")
        # The remaining 30+ tools are covered by condensed groups.
        for marker in ("figma_create_frame/node", "figma_set_*",
                       "figma_delete/duplicate/move/resize/group",
                       "figma_export_node", "figma_get_document"):
            self.assertIn(marker, self.config, f"prompt missing {marker}")

    def test_figma_status_diagnostics(self):
        self.assertIn("figma_status (instant, local)", self.config)

    def test_offline_rule(self):
        self.assertIn("On figma plugin_offline", self.config)

    def test_no_invented_ids_rule(self):
        self.assertIn("never pass bytes as an assetId", self.config)

    def test_prompt_structure_intact(self):
        self.assertEqual(self.config.count("SPECIAL FORMAT FOR execute_luau"), 1)


if __name__ == "__main__":
    unittest.main(verbosity=1)
