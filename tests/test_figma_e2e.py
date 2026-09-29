# SPDX-License-Identifier: GPL-3.0-or-later
# tests/test_figma_e2e.py — PLAN.md Phase 6, Tasks 6.1/6.2/6.4.
#
# Simulated end-to-end: AI sequence figma_create_frame -> figma_get_nodes ->
# figma_set_properties -> create_ui_from_figma, with a fake Figma poller and a
# fake Studio poller draining their own queue clients in threads. Proves the
# full shop-UI flow routes correctly without Figma Desktop or Studio.
#
# Live checks (Tasks 6.1/6.3: real Figma Desktop, Studio, AI provider) cannot
# run headless; they are explicit skips documenting the manual steps.
# Task 6.4 live API needs FIGMA_PAT, skipped when absent.
#
# Run: py -m unittest tests.test_figma_e2e -v
import sys
import os
import json
import time
import threading
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
os.environ.setdefault("ROLINK_QUEUE_PORT", "18081")
sys.path.insert(0, ROOT)

import bridge


def _drain(client="studio"):
    try:
        with bridge._queue_lock:
            ids = [cid for cid, c in bridge._queue_cmds.items()
                   if c.get("client", "studio") == client
                   and c.get("status") in ("queued", "claimed")]
        for cid in ids:
            try:
                bridge.queue_cancel(cid)
            except Exception:
                pass
    except Exception:
        pass


def _poller(client, handlers, stop):
    """Fake plugin: take own-client commands, answer from handlers, loop."""
    while not stop[0]:
        try:
            cmd = bridge.queue_take(client=client)
        except Exception:
            cmd = None
        if cmd is None:
            time.sleep(0.05)
            continue
        try:
            fn = handlers.get(cmd.get("tool"))
            if fn is None:
                bridge.queue_complete(cmd["id"], None,
                                      f"no handler for {cmd.get('tool')}")
            else:
                bridge.queue_complete(cmd["id"], fn(cmd.get("args", {})), None)
        except Exception as e:
            try:
                bridge.queue_complete(cmd["id"], None, str(e)[:200])
            except Exception:
                pass


class FigmaShopFlowTest(unittest.TestCase):
    """Task 6.1 (simulated): Figma frame -> Studio ScreenGui."""

    def test_shop_ui_end_to_end(self):
        bridge._queue_server_on[0] = True
        bridge._figma_last_poll[0] = time.time()
        bridge._queue_last_poll[0] = time.time()
        bridge._figma_consec_timeouts[0] = 0
        bridge._queue_consec_timeouts[0] = 0
        _drain("figma")
        _drain("studio")
        stop = [False]

        def figma_create_frame(args):
            return {"id": "F100", "name": args.get("title", "Frame"),
                    "width": 400, "height": 600}

        def figma_get_nodes(args):
            return {"count": 1, "nodes": [{
                "id": "F100", "name": "Shop", "type": "FRAME",
                "bounds": {"x": 0, "y": 0, "width": 400, "height": 600},
                "fills": [{"type": "SOLID",
                           "color": {"r": 0.1, "g": 0.45, "b": 0.91}}],
                "cornerRadius": 12,
                "children": [{
                    "id": "F101", "name": "Title", "type": "TEXT",
                    "bounds": {"x": 20, "y": 16, "width": 360, "height": 40},
                    "characters": "Shop", "fontSize": 28}]}]}

        def figma_set_properties(args):
            assert args.get("nodeId") == "F100", args
            return {"id": "F100", "updated": True}

        def create_ui_from_figma(args):
            # Studio-side shape check mirrors buildFigmaUi caps.
            assert isinstance(args.get("nodes"), list) and args["nodes"], args
            return {"gui": "StarterGui/ShopUI", "created": 2, "skipped": 0,
                    "paths": ["StarterGui/ShopUI (ScreenGui)",
                              "StarterGui/ShopUI/Shop (Frame)"],
                    "truncated": False}

        tf = threading.Thread(target=_poller, args=(
            "figma", {"figma_create_frame": figma_create_frame,
                      "figma_get_nodes": figma_get_nodes,
                      "figma_set_properties": figma_set_properties}, stop),
            daemon=True)
        ts = threading.Thread(target=_poller, args=(
            "studio", {"create_ui_from_figma": create_ui_from_figma}, stop),
            daemon=True)
        tf.start()
        ts.start()
        try:
            r1 = bridge.safe_call("figma_create_frame",
                                  {"title": "Shop", "width": 400, "height": 600}, 10)
            self.assertTrue(r1.get("ok"), r1)
            fid = json.loads(r1["text"])["id"]
            self.assertEqual(fid, "F100")

            r2 = bridge.safe_call("figma_get_nodes", {"nodeId": fid}, 10)
            self.assertTrue(r2.get("ok"), r2)
            nodes = json.loads(r2["text"])["nodes"]
            self.assertEqual(nodes[0]["name"], "Shop")

            r3 = bridge.safe_call("figma_set_properties",
                                  {"nodeId": fid, "cornerRadius": 12}, 10)
            self.assertTrue(r3.get("ok"), r3)

            r4 = bridge.safe_call("create_ui_from_figma",
                                  {"nodes": nodes, "name": "ShopUI"}, 10)
            self.assertTrue(r4.get("ok"), r4)
            body = json.loads(r4["text"])
            self.assertEqual(body["gui"], "StarterGui/ShopUI")
            self.assertEqual(body["created"], 2)
            self.assertFalse(body["truncated"])
        finally:
            stop[0] = True
            tf.join(timeout=5)
            ts.join(timeout=5)
            bridge._figma_last_poll[0] = 0.0
            bridge._queue_last_poll[0] = 0.0
            _drain("figma")
            _drain("studio")

    def test_figma_and_studio_pollers_independent(self):
        # A wedged Studio queue (claim never completed) must not starve Figma.
        bridge._queue_server_on[0] = True
        bridge._figma_last_poll[0] = time.time()
        bridge._queue_last_poll[0] = time.time()
        _drain("figma")
        _drain("studio")
        stop = [False]
        tf = threading.Thread(target=_poller, args=(
            "figma", {"figma_get_document": lambda a: {"name": "Doc"}}, stop),
            daemon=True)
        tf.start()
        try:
            # Wedge Studio: enqueue + claim, never complete.
            cid = bridge.queue_enqueue("get_instances", "get_instances", {})
            wedged = bridge.queue_take(client="studio")
            self.assertIsNotNone(wedged)
            # Figma still flows.
            res = bridge.safe_call("figma_get_document", {}, 10)
            self.assertTrue(res.get("ok"), res)
            self.assertIn("Doc", res.get("text", ""))
        finally:
            stop[0] = True
            tf.join(timeout=5)
            bridge.queue_cancel(cid)
            bridge._figma_last_poll[0] = 0.0
            bridge._queue_last_poll[0] = 0.0
            _drain("figma")
            _drain("studio")


class FigmaErrorMatrixTest(unittest.TestCase):
    """Task 6.2: every failure mode answers structurally, never hangs."""

    def test_queue_down(self):
        old = bridge._queue_server_on[0]
        bridge._queue_server_on[0] = False
        try:
            res = bridge.safe_call("figma_create_frame", {"title": "X"}, 5)
            self.assertFalse(res.get("ok"))
            self.assertEqual(res.get("kind"), "plugin_offline", res)
        finally:
            bridge._queue_server_on[0] = old

    def test_figma_never_polled_guidance(self):
        old_poll, old_on = bridge._figma_last_poll[0], bridge._queue_server_on[0]
        bridge._figma_last_poll[0] = 0.0
        bridge._queue_server_on[0] = True
        try:
            res = bridge.safe_call("figma_export_node", {"nodeId": "1:2"}, 5)
            self.assertEqual(res.get("kind"), "plugin_offline", res)
            self.assertIn("Figma Desktop", res.get("error", ""), res)
        finally:
            bridge._figma_last_poll[0] = old_poll
            bridge._queue_server_on[0] = old_on

    def test_converter_validation_errors(self):
        for args, hint in [({}, "nodes"), ({"nodes": []}, "non-empty"),
                           ({"nodes": [{"id": "F1"}] * 21}, "max 20"),
                           ({"nodes": [{"id": "F1"}], "scale": 9}, "scale")]:
            res = bridge.safe_call("create_ui_from_figma", args, 5)
            self.assertEqual(res.get("kind"), "validation_error", (args, res))
            self.assertIn(hint, res.get("error", ""), (args, res))

    def test_export_bytes_rejected_as_asset_id(self):
        res = bridge.safe_call("import_asset", {"bytesB64": "e30=", "format": "PNG"}, 5)
        self.assertEqual(res.get("kind"), "validation_error", res)
        self.assertIn("Asset Manager", res.get("error", ""), res)

    def test_unknown_figma_tool_suggests(self):
        res = bridge.safe_call("figma_make_button", {}, 5)
        self.assertFalse(res.get("ok"))
        self.assertEqual(res.get("kind"), "validation_error", res)
        self.assertNotIn("undefined", res.get("error", ""))


class FigmaLiveTest(unittest.TestCase):
    """Tasks 6.1/6.3/6.4 live legs — skipped headless, manual steps inline."""

    def test_live_figma_desktop_flow(self):
        self.skipTest(
            "Manual (Task 6.1): open Figma Desktop > RoLink Bridge plugin (green dot), "
            "AI: figma_create_frame{Shop,400,600} -> figma_get_nodes -> "
            "create_ui_from_figma{nodes}; verify Studio StarterGui/ShopUI matches "
            "layout via get_ui_tree. Known limits: solid fills only, 50-instance cap.")

    def test_live_ai_provider_flow(self):
        self.skipTest(
            "Manual (Task 6.3): DeepSeek session, ask 'design a shop UI in Figma and "
            "send it to Studio'; expect figma_* calls then create_ui_from_figma with "
            "inline nodes; verify ScreenGui + no invented asset IDs.")

    def test_live_figma_rest_api(self):
        if not os.environ.get("FIGMA_PAT"):
            self.skipTest("Needs FIGMA_PAT env (Task 6.4 live REST check).")
        self.fail("FIGMA_PAT set but live REST check not implemented for this env")


if __name__ == "__main__":
    unittest.main(verbosity=1)
