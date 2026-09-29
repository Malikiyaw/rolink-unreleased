# SPDX-License-Identifier: GPL-3.0-or-later
# tests/test_figma_converter.py — PLAN.md Phase 3, Task 3.4.
#
# Verifies the Figma→Studio UI converter contract:
#   - pure mapping helpers (_figma_fill_to_color, _figma_bounds_to_udim,
#     _figma_node_class) match PLAN.md 4.3
#   - bridge-side arg validation fails fast (no queue wait)
#   - import_asset rejects raw Figma export bytes (never fake an asset ID)
#   - create_ui_from_figma routes to the STUDIO queue client
#   - studio-plugin/RoLink.lua contains the buildFigmaUi converter branch
#
# Run: py -m unittest tests.test_figma_converter -v
import sys
import os
import io
import types
import time
import unittest

if "websockets" not in sys.modules:
    fake = types.ModuleType("websockets")
    fake.ConnectionClosed = type("ConnectionClosed", (Exception,), {})
    fake.serve = lambda *a, **kw: None
    sys.modules["websockets"] = fake

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
# See tests/test_figma_queue.py: pin the test queue port before bridge import
# so unittest module import order never breaks tests/test_queue.py.
os.environ.setdefault("ROLINK_QUEUE_PORT", "18081")
sys.path.insert(0, ROOT)

import bridge


def _read(*parts):
    with io.open(os.path.join(ROOT, *parts), encoding="utf-8", errors="replace") as f:
        return f.read()


class FillToColorTest(unittest.TestCase):
    def test_white_default(self):
        self.assertEqual(bridge._figma_fill_to_color(None), (255, 255, 255, 0.0))
        self.assertEqual(bridge._figma_fill_to_color({}), (255, 255, 255, 0.0))

    def test_red_solid_opaque(self):
        fill = {"type": "SOLID", "color": {"r": 1, "g": 0, "b": 0}, "opacity": 1}
        self.assertEqual(bridge._figma_fill_to_color(fill), (255, 0, 0, 0.0))

    def test_half_transparent(self):
        fill = {"type": "SOLID", "color": {"r": 0, "g": 0, "b": 1}, "opacity": 0.5}
        r, g, b, t = bridge._figma_fill_to_color(fill)
        self.assertEqual((r, g, b), (0, 0, 255))
        self.assertAlmostEqual(t, 0.5)

    def test_alpha_in_color(self):
        fill = {"color": {"r": 0, "g": 1, "b": 0, "a": 0.25}}
        self.assertEqual(bridge._figma_fill_to_color(fill), (0, 255, 0, 0.75))

    def test_invalid_input_defaults(self):
        self.assertEqual(bridge._figma_fill_to_color("junk"), (255, 255, 255, 0.0))
        self.assertEqual(bridge._figma_fill_to_color({"color": {"r": 9, "g": -9, "b": 0.5}}),
                         (255, 0, 128, 0.0))


class BoundsToUdimTest(unittest.TestCase):
    def test_absolute_top_level(self):
        out = bridge._figma_bounds_to_udim({"x": 10, "y": 20, "width": 400, "height": 600})
        self.assertEqual(out, {"x": 10, "y": 20, "w": 400, "h": 600})

    def test_child_relative_to_parent(self):
        parent = {"x": 100, "y": 100, "width": 400, "height": 400}
        child = {"x": 120, "y": 150, "width": 80, "height": 40}
        out = bridge._figma_bounds_to_udim(child, parent)
        self.assertEqual(out, {"x": 20, "y": 50, "w": 80, "h": 40})

    def test_scale(self):
        out = bridge._figma_bounds_to_udim({"x": 10, "y": 10, "width": 100, "height": 50}, None, 2.0)
        self.assertEqual(out, {"x": 20, "y": 20, "w": 200, "h": 100})

    def test_scale_clamped(self):
        out = bridge._figma_bounds_to_udim({"x": 0, "y": 0, "width": 100, "height": 100}, None, 99)
        self.assertEqual(out["w"], 400)  # scale clamped to 4.0

    def test_defaults(self):
        out = bridge._figma_bounds_to_udim(None)
        self.assertEqual(out, {"x": 0, "y": 0, "w": 100, "h": 100})


class NodeClassTest(unittest.TestCase):
    def test_text_becomes_textlabel(self):
        self.assertEqual(bridge._figma_node_class({"type": "TEXT"}), "TextLabel")
        self.assertEqual(bridge._figma_node_class({"type": "text"}), "TextLabel")

    def test_frame_becomes_frame(self):
        for t in ("FRAME", "RECTANGLE", "COMPONENT", "GROUP", None, {}, "junk"):
            node = {"type": t} if isinstance(t, str) else t
            self.assertEqual(bridge._figma_node_class(node), "Frame", repr(t))


class ValidateConverterArgsTest(unittest.TestCase):
    def test_missing_nodes(self):
        err = bridge._validate_create_ui_from_figma({})
        self.assertIn("'nodes' is required", err)

    def test_node_id_only_guidance(self):
        err = bridge._validate_create_ui_from_figma({"figmaNodeId": "F1"})
        self.assertIn("figma_get_nodes", err)
        self.assertIn("'nodes' is required", err)

    def test_empty_and_bad_shape(self):
        self.assertIn("non-empty array", bridge._validate_create_ui_from_figma({"nodes": []}))
        self.assertIn("non-empty array", bridge._validate_create_ui_from_figma({"nodes": "nope"}))
        self.assertIn("must be an object", bridge._validate_create_ui_from_figma({"nodes": ["x"]}))

    def test_too_many(self):
        err = bridge._validate_create_ui_from_figma({"nodes": [{"id": str(i)} for i in range(21)]})
        self.assertIn("max 20", err)

    def test_bad_scale_parent(self):
        base = {"nodes": [{"id": "F1", "type": "FRAME"}]}
        self.assertIn("scale", bridge._validate_create_ui_from_figma(dict(base, scale=99)))
        self.assertIn("scale", bridge._validate_create_ui_from_figma(dict(base, scale="big")))
        self.assertIn("parent", bridge._validate_create_ui_from_figma(dict(base, parent=42)))

    def test_valid_passes(self):
        ok = {"nodes": [{"id": "F1", "type": "FRAME", "name": "Shop",
                         "bounds": {"x": 0, "y": 0, "width": 400, "height": 600}}],
              "name": "ShopUI", "parent": "StarterGui", "scale": 1.0}
        self.assertEqual(bridge._validate_create_ui_from_figma(ok), "")
        # children alias also accepted.
        self.assertEqual(bridge._validate_create_ui_from_figma(
            {"children": [{"id": "F1"}]}), "")


class ConverterDispatchTest(unittest.TestCase):
    def test_routes_to_studio_client(self):
        self.assertEqual(bridge._client_for_tool("create_ui_from_figma"), "studio")
        cid = bridge.queue_enqueue("create_ui_from_figma", "create_ui_from_figma",
                                   {"nodes": [{"id": "F1"}]})
        try:
            with bridge._queue_lock:
                self.assertEqual(bridge._queue_cmds[cid].get("client"), "studio")
        finally:
            bridge.queue_cancel(cid)

    def test_safe_call_validation_no_queue_wait(self):
        import time as _t
        t0 = _t.monotonic()
        res = bridge.safe_call("create_ui_from_figma", {}, 10)
        dt = _t.monotonic() - t0
        self.assertFalse(res.get("ok"))
        self.assertEqual(res.get("kind"), "validation_error", res)
        self.assertIn("nodes", res.get("error", ""), res)
        self.assertLess(dt, 2.0, f"validation must fail fast, took {dt:.1f}s")

    def test_import_asset_rejects_figma_bytes(self):
        res = bridge.safe_call("import_asset", {"bytesB64": "aGVsbG8=", "format": "PNG"}, 5)
        self.assertFalse(res.get("ok"))
        self.assertEqual(res.get("kind"), "validation_error", res)
        self.assertIn("Asset Manager", res.get("error", ""), res)
        res2 = bridge.safe_call("import_asset", {"bytes": [1, 2, 3]}, 5)
        self.assertEqual(res2.get("kind"), "validation_error", res2)


class PluginConverterBranchTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.plugin = _read("studio-plugin", "RoLink.lua")

    def test_helper_defined(self):
        self.assertIn("local function buildFigmaUi", self.plugin)

    def test_dispatcher_branch(self):
        self.assertIn('tool=="create_ui_from_figma"', self.plugin)
        self.assertIn("buildFigmaUi(args)", self.plugin)

    def test_mapping_primitives(self):
        for snippet in ("Color3.fromRGB", "BackgroundTransparency",
                        "UICorner", "UIListLayout", "TextLabel",
                        "UDim2.fromOffset", "Enum.Font.Gotham"):
            self.assertIn(snippet, self.plugin, f"missing mapping: {snippet}")

    def test_caps(self):
        # 50-instance cap, depth guard, 20 top-level cap.
        for snippet in ("created + skipped >= 50", "depth > 4", "max 20"):
            self.assertIn(snippet, self.plugin, f"missing cap: {snippet}")

    def test_line_cap(self):
        bad = [(i + 1, len(l)) for i, l in enumerate(self.plugin.split("\n"))
               if len(l) > 900]
        self.assertEqual(bad, [], f"lines over 900 chars: {bad[:5]}")

    def test_honest_limits_note(self):
        self.assertIn("Asset Manager", self.plugin)


if __name__ == "__main__":
    unittest.main(verbosity=1)
