# SPDX-License-Identifier: GPL-3.0-or-later
"""Drift guard: generated artifacts must match their source of truth.

RoLink ships eight copies of the tool catalogue (the TS registry, the JSON
catalogue, the HUD registry, three prompt mirrors, code-fields, persona-lines).
They drifted before: `retarget_animation` was implemented in registry.ts and
RoLink.lua but missing from tests/__registry__.json, the prompt mirrors and
code-fields, so the model could never call it and nothing failed.

These tests do not re-derive the artifacts (that needs Node + tsx). They assert
the *invariants* that make drift impossible to miss, and they skip cleanly when
the generated files are absent (e.g. a release built without them).
"""
import io
import json
import os
import unittest

try:
    from _catalog import catalog_path, load_catalog
except ImportError:  # invoked with a different sys.path
    import sys as _sys
    _sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from _catalog import catalog_path, load_catalog

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _read(rel):
    path = os.path.join(ROOT, rel)
    if not os.path.exists(path):
        return None
    return io.open(path, encoding="utf-8").read()


def _read_json(rel):
    raw = _read(rel)
    if raw is None:
        return None
    return json.loads(raw)


class CatalogIsAProductFileTest(unittest.TestCase):
    def test_catalog_lives_outside_the_test_tree(self):
        path = catalog_path()
        rel = os.path.relpath(path, ROOT).replace("\\", "/")
        self.assertEqual(
            rel, "catalog/tools.json",
            "the runtime catalogue must be a product file, not a test fixture",
        )

    def test_bridge_reads_the_product_catalog(self):
        src = _read("bridge.py") or ""
        self.assertIn('os.path.join(HERE, "catalog", "tools.json")', src,
                      "bridge.py must prefer catalog/tools.json")

    def test_catalog_count_field_matches_the_list(self):
        raw = _read_json("catalog/tools.json")
        if raw is None:
            self.skipTest("catalog/tools.json missing")
        self.assertEqual(raw.get("count"), len(raw.get("tools") or []),
                         "catalog 'count' disagrees with the actual list length")


class PromptMirrorsCoverTheCatalogTest(unittest.TestCase):
    def setUp(self):
        self.catalog = load_catalog()
        self.prompts = _read_json("generated/tool-prompts.json")

    def test_generated_prompts_cover_every_catalog_tool(self):
        if self.prompts is None:
            self.skipTest("generated/tool-prompts.json missing")
        covered = set((self.prompts.get("prompts") or {}).keys())
        missing = [t for t in self.catalog if t not in covered]
        self.assertEqual(missing, [], "catalog tools with no master prompt: %s" % missing)

    def test_generated_prompt_counts_agree_with_catalog(self):
        if self.prompts is None:
            self.skipTest("generated/tool-prompts.json missing")
        self.assertEqual(self.prompts.get("toolCount"), len(self.catalog),
                         "regenerate prompts: toolCount is stale")
        self.assertEqual(self.prompts.get("promptCount"), len(self.catalog),
                         "regenerate prompts: a catalog tool has no prompt")

    def test_extension_prompt_mirror_is_not_empty_and_covers_hot_tools(self):
        src = _read("rolink-extension/core/tool-prompts.js")
        if src is None:
            self.skipTest("core/tool-prompts.js missing")
        for name in self.catalog:
            self.assertIn('"%s"' % name, src,
                          "core/tool-prompts.js is stale: %s missing" % name)

    def test_persona_mirror_covers_the_catalog(self):
        src = _read("rolink-extension/core/persona-lines.js")
        if src is None:
            self.skipTest("core/persona-lines.js missing")
        missing = [t for t in self.catalog if '"%s"' % t not in src]
        self.assertEqual(missing, [], "persona-lines.js is stale: %s" % missing)


class CodeFieldsAndHudCoverTheCatalogTest(unittest.TestCase):
    def setUp(self):
        self.catalog = load_catalog()

    def test_code_fields_cover_the_catalog(self):
        raw = _read_json("generated/code-fields.json")
        if raw is None:
            self.skipTest("generated/code-fields.json missing")
        fields = raw.get("toolFields") or {}
        self.assertEqual(raw.get("toolCount"), len(self.catalog),
                         "regenerate code-fields: toolCount is stale")
        missing = [t for t in self.catalog if t not in fields]
        self.assertEqual(missing, [], "code-fields.json is stale: %s" % missing)

    def test_hud_tool_registry_matches_the_catalog(self):
        src = _read("rolink-extension/ui/toolHud/toolRegistry.js")
        if src is None:
            self.skipTest("toolRegistry.js missing")
        start = src.find("var TOOL_NAMES = [")
        self.assertGreaterEqual(start, 0, "TOOL_NAMES block not found")
        end = src.find("];", start)
        block = src[start:end]
        listed = set()
        import re
        for m in re.finditer(r'"([a-z0-9_]+)"', block):
            listed.add(m.group(1))
        missing = [t for t in self.catalog if t not in listed]
        extra = [t for t in listed if t not in self.catalog]
        self.assertEqual(missing, [],
                         "toolRegistry.js is stale (run scripts/emit-tool-registry.js): %s" % missing)
        self.assertEqual(extra, [], "toolRegistry.js lists unknown tools: %s" % extra)


class EveryCatalogToolIsReachableTest(unittest.TestCase):
    """A tool the model cannot reach is worse than a missing tool: it looks
    implemented. This is the check that would have caught retarget_animation."""

    def setUp(self):
        self.catalog = load_catalog()
        self.registry_ts = _read("mcp-server/src/tools/registry.ts") or ""

    def test_every_catalog_tool_has_a_zod_schema(self):
        if not self.registry_ts:
            self.skipTest("registry.ts missing")
        missing = [t for t in self.catalog if 'name: "%s"' % t not in self.registry_ts]
        self.assertEqual(missing, [], "catalog tools with no schema/handler: %s" % missing)

    def test_every_registry_tool_is_in_the_catalog(self):
        if not self.registry_ts:
            self.skipTest("registry.ts missing")
        import re
        implemented = set(re.findall(r'\{ name: "([a-z0-9_]+)"', self.registry_ts))
        orphaned = sorted(implemented - set(self.catalog))
        self.assertEqual(orphaned, [],
                         "implemented but unreachable (missing from catalog/tools.json): %s"
                         % orphaned)


if __name__ == "__main__":
    unittest.main()
