# SPDX-License-Identifier: GPL-3.0-or-later
# tests/test_figma_catalog.py — PLAN.md Phase 4, Tasks 4.1-4.5.
#
# Verifies the Figma catalog layer (Node registry + prompts + generated
# artifacts + extension bundle):
#   - registry.ts declares all 6 figma tools with zod schemas, provider figma
#   - figma-native handlers answer FIGMA_BRIDGE_REQUIRED (terminal, isError);
#     create_ui_from_figma genuinely queues to Studio (no bare queued:true)
#   - toolPrompts.ts has all 6 prompts with all 6 required fields non-empty
#   - generated/tool-prompts.json + code-fields.json cover 213 tools
#   - extension code-fields.js / tool-prompts.js / persona-lines.js include figma
#   - registry descriptions stay <= 200 chars (CI guard in toolPrompts.ts)
#   - tests/__registry__.json stays 150 (figma tools are queue extras, same
#     precedent as _QUEUE_EXTRA_TOOLS: routed + advertised, registry untouched)
#
# Run: py -m unittest tests.test_figma_catalog -v
import sys
import os
import io
import json
import re
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
# Pin the test queue port before any bridge import (see test_figma_queue.py).
os.environ.setdefault("ROLINK_QUEUE_PORT", "18081")
sys.path.insert(0, ROOT)


def read(*parts):
    with io.open(os.path.join(ROOT, *parts), encoding="utf-8", errors="replace") as f:
        return f.read()


FIGMA_TOOLS = [
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
]

FIGMA_NATIVES = [t for t in FIGMA_TOOLS if t.startswith("figma_")]

PROMPT_FIELDS = ("persona", "when_to_use", "args_guide", "example_call",
                 "output", "pitfalls")


def handler_segment(registry_ts, name):
    idx = registry_ts.find('name: "%s"' % name)
    if idx < 0:
        return ""
    nxt = registry_ts.find('{ name: "', idx + 10)
    return registry_ts[idx:nxt if nxt > 0 else len(registry_ts)]


class FigmaRegistryTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.registry_ts = read("mcp-server", "src", "tools", "registry.ts")

    def test_provider_union_includes_figma(self):
        self.assertIn('"figma"', self.registry_ts)

    def test_all_tools_declared_with_schema(self):
        for name in FIGMA_TOOLS:
            seg = handler_segment(self.registry_ts, name)
            self.assertTrue(seg, f"no registry entry: {name}")
            self.assertIn("inputSchema: z.object", seg, f"{name}: no zod schema")
            self.assertIn('provider:"figma"', seg.replace(" ", ""), f"{name}: provider figma")
            self.assertIn('execution:"studio"', seg.replace(" ", ""), f"{name}: execution studio")

    def test_descriptions_short(self):
        for name in FIGMA_TOOLS:
            m = re.search(r'name: "%s", description: "([^"]*)"' % re.escape(name), self.registry_ts)
            self.assertIsNotNone(m, f"no description: {name}")
            self.assertLessEqual(len(m.group(1)), 200, f"{name}: description {len(m.group(1))} chars > 200")

    def test_natives_answer_bridge_required(self):
        for name in FIGMA_NATIVES:
            seg = handler_segment(self.registry_ts, name)
            self.assertIn("FIGMA_BRIDGE_REQUIRED", seg, f"{name}: no honest terminal error")
            self.assertIn("isError:true", seg.replace(" ", ""), f"{name}: must be isError")
            self.assertIn("rl_rejected", seg, f"{name}: must carry rl_rejected id")

    def test_converter_queues_to_studio(self):
        seg = handler_segment(self.registry_ts, "create_ui_from_figma")
        self.assertIn("studioQueueAndWait", seg)
        self.assertIn("create_ui_from_figma", seg)
        self.assertNotIn("FIGMA_BRIDGE_REQUIRED", seg)

    def test_no_bare_queued(self):
        for name in FIGMA_TOOLS:
            seg = handler_segment(self.registry_ts, name)
            nospace = seg.replace(" ", "")
            if "queued:true" in nospace:
                self.assertIn("studioQueueAndWait", seg, f"{name}: bare queued:true without wait")


class FigmaPromptsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.prompts_ts = read("mcp-server", "src", "tools", "toolPrompts.ts")
        with io.open(os.path.join(ROOT, "generated", "tool-prompts.json"), encoding="utf-8") as f:
            cls.generated = json.load(f)

    def test_prompts_declared(self):
        for name in FIGMA_TOOLS:
            self.assertIn(f"  {name}: {{", self.prompts_ts, f"no prompt block: {name}")

    def test_prompt_fields_nonempty(self):
        prompts = self.generated.get("prompts", {})
        for name in FIGMA_TOOLS:
            self.assertIn(name, prompts, f"no generated prompt: {name}")
            for field in PROMPT_FIELDS:
                self.assertTrue((prompts[name].get(field) or "").strip(),
                                f"{name}: prompt field {field} empty")

    def test_generated_counts(self):
        self.assertEqual(self.generated.get("toolCount"), 213)
        self.assertEqual(self.generated.get("promptCount"), 213)
        self.assertEqual(self.generated.get("coverage"), "213/213")

    def test_figma_guidance_content(self):
        prompts = self.generated.get("prompts", {})
        self.assertIn("figma_get_nodes", prompts["create_ui_from_figma"]["args_guide"])
        export_text = (prompts["figma_export_node"]["when_to_use"] +
                       prompts["figma_export_node"]["args_guide"] +
                       prompts["figma_export_node"]["pitfalls"] +
                       prompts["create_ui_from_figma"]["args_guide"])
        self.assertIn("Asset Manager", export_text)


class FigmaCodeFieldsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with io.open(os.path.join(ROOT, "generated", "code-fields.json"), encoding="utf-8") as f:
            cls.fields = json.load(f)
        cls.ext_fields = read("rolink-extension", "core", "code-fields.js")
        cls.ext_prompts = read("rolink-extension", "core", "tool-prompts.js")
        cls.persona = read("rolink-extension", "core", "persona-lines.js")

    def test_generated_fields_cover_figma(self):
        self.assertEqual(self.fields.get("toolCount"), 213)
        tool_fields = self.fields.get("toolFields", {})
        for name in FIGMA_TOOLS:
            self.assertIn(name, tool_fields, f"no code fields: {name}")
        # create_ui_from_figma exposes its string args for ###RAW### parsing.
        self.assertIn("name", tool_fields["create_ui_from_figma"])
        self.assertIn("parent", tool_fields["create_ui_from_figma"])

    def test_extension_bundle_includes_figma(self):
        for name in FIGMA_TOOLS:
            self.assertIn(f'"{name}"', self.ext_fields, f"code-fields.js missing {name}")
            self.assertIn(name, self.ext_prompts, f"tool-prompts.js missing {name}")
            self.assertIn(name, self.persona, f"persona-lines.js missing {name}")

    def test_extension_counts(self):
        self.assertIn('"toolCount": 213', self.ext_fields)


class FigmaRegistryUntouchedTest(unittest.TestCase):
    def test_python_registry_stays_150(self):
        with io.open(os.path.join(ROOT, "tests", "__registry__.json"), encoding="utf-8") as f:
            registry = json.load(f)
        self.assertEqual(len(registry), 150)
        for name in FIGMA_TOOLS:
            self.assertNotIn(name, registry,
                             f"{name} must stay out of __registry__.json (queue-extra precedent)")


class FigmaPluginCodeTest(unittest.TestCase):
    """figma-plugin/code.js must use the async node API (dynamic-page bans sync
    getNodeById) and expose the create_node builder with font loading."""

    @classmethod
    def setUpClass(cls):
        cls.code = read("figma-plugin", "code.js")

    def test_no_sync_getnodebyid(self):
        self.assertNotIn("figma.getNodeById(", self.code,
                         "sync getNodeById is banned under dynamic-page access")

    def test_async_lookup_everywhere(self):
        for tool in ("figma_get_nodes", "figma_set_properties",
                     "figma_export_node", "figma_create_node"):
            self.assertIn("getNodeByIdAsync", self.code, tool)

    def test_create_node_builder(self):
        for snippet in ("handleCreateNode", "figma.createText",
                        "figma.createRectangle", "figma.createEllipse",
                        "loadFontAsync", "appendChild"):
            self.assertIn(snippet, self.code, f"missing: {snippet}")

    def test_dispatch_lists_create_node(self):
        self.assertIn('"figma_create_node"', self.code)

    def test_every_native_has_dispatch(self):
        # Every figma_* tool the bridge routes must have a dispatch branch in
        # the plugin — otherwise the Figma queue accepts a command no poller
        # can execute (silent wedge until the 25s claim timeout).
        missing = [n for n in FIGMA_TOOLS
                   if n.startswith("figma_")
                   and f'tool === "{n}"' not in self.code]
        self.assertEqual(missing, [], f"no dispatch branch: {missing}")


if __name__ == "__main__":
    unittest.main(verbosity=1)
