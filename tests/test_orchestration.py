import io
import json
import os
import shutil
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
os.environ.setdefault("ROLINK_QUEUE_PORT", "18081")
sys.path.insert(0, ROOT)

import bridge


FIGMA_TREE = {
    "nodes": [{
        "id": "1:23", "name": "ShopFrame", "type": "FRAME",
        "children": [
            {"id": "1:24", "name": "Header", "type": "FRAME", "children": []},
            {"id": "1:25", "name": "Title", "type": "TEXT", "characters": "Shop"},
            {"id": "1:26", "name": "Buy", "type": "TEXT", "characters": "Buy now"},
        ],
    }],
}

STUDIO_TREE = {
    "path": "StarterGui/ShopUI",
    "nodes": [
        {"name": "ShopUI", "class": "ScreenGui", "depth": 0},
        {"name": "Header", "class": "Frame", "depth": 1},
        {"name": "Title", "class": "TextLabel", "depth": 2, "text": "Shop"},
        {"name": "Buy", "class": "TextButton", "depth": 1, "text": "Buy"},
        {"name": "DebugLabel", "class": "TextLabel", "depth": 1, "text": "temp"},
    ],
}


class ChainTestBase(unittest.TestCase):
    """Shared fake-both-clients harness for the Phase 6 chain tools."""

    def setUp(self):
        self.ctxdir = os.path.join(bridge.HERE, "context")
        shutil.rmtree(self.ctxdir, ignore_errors=True)
        self._safe = bridge.safe_call
        self._alive = bridge._client_alive
        self._server_on = bridge._queue_server_on[0]
        self.calls = []
        self.responses = {}

    def tearDown(self):
        bridge.safe_call = self._safe
        bridge._client_alive = self._alive
        bridge._queue_server_on[0] = self._server_on
        shutil.rmtree(self.ctxdir, ignore_errors=True)

    def stub_clients(self, responses, both_alive=True, server_on=True):
        """Route safe_call through a canned response table; record every call."""
        self.responses = responses
        self.calls = []

        def fake_safe_call(name, arguments, timeout):
            self.calls.append({"tool": name, "args": arguments, "timeout": timeout})
            r = self.responses.get(name)
            if r is None:
                return {"ok": False, "kind": "execution_error",
                        "error": f"no canned response for {name}"}
            if isinstance(r, dict) and "__raise__" in r:
                raise RuntimeError(r["__raise__"])
            return r

        def fake_alive(client):
            return both_alive or bridge._normalize_client(client) != "figma"

        bridge.safe_call = fake_safe_call
        bridge._client_alive = fake_alive
        bridge._queue_server_on[0] = server_on

    def ok(self, text_body):
        return {"ok": True, "text": json.dumps(text_body)}


def read(*parts):
    with io.open(os.path.join(ROOT, *parts), encoding="utf-8", errors="replace") as f:
        return f.read()


CHAIN_TOOLS = ("send_figma_to_studio", "check_ui_sync")
CONTEXT_TOOLS = ("get_ui_context", "set_ui_context")


class ContextEngineTest(ChainTestBase):
    """PLAN.md Phase 6: the shared Figma<->Studio state store."""

    def test_routed_and_advertised(self):
        for name in CHAIN_TOOLS + CONTEXT_TOOLS:
            self.assertIn(name, bridge.LOCAL_HANDLERS, name)
            self.assertIn(name, bridge._QUEUE_EXTRA_TOOLS, name)
            entry = bridge._local_tool_entry(name)
            self.assertIsNotNone(entry, name)
            self.assertEqual(entry.get("server"), "local")

    def test_get_is_offline_and_never_waits(self):
        """The store is a file read - it must answer with both plugins dead."""
        self.stub_clients({}, both_alive=False, server_on=False)
        res = bridge._local_get_ui_context({})
        self.assertTrue(res.get("ok"), res)
        self.assertEqual(self.calls, [], "get_ui_context must not call a plugin")

    def test_link_survives_a_companion_notes_write(self):
        """Regression: the link upsert is its own save, so a later write from a
        stale snapshot used to drop it."""
        bridge._local_set_ui_context({"link": {"figmaNodeId": "1:1",
                                               "studioPath": "StarterGui/A"}})
        bridge._local_set_ui_context({"notes": {"k": "v"}})
        body = json.loads(bridge._local_get_ui_context({})["text"])
        self.assertEqual(body["linkCount"], 1)
        self.assertEqual(body["links"][0]["studioPath"], "StarterGui/A")
        self.assertEqual(body["notes"], {"k": "v"})

    def test_link_upsert_replaces_in_place_newest_first(self):
        for fid, path in (("1:1", "StarterGui/A"), ("1:2", "StarterGui/B"),
                          ("1:1", "StarterGui/A2")):
            bridge._local_set_ui_context({"link": {"figmaNodeId": fid,
                                                   "studioPath": path}})
        body = json.loads(bridge._local_get_ui_context({})["text"])
        self.assertEqual(body["linkCount"], 2, body)
        self.assertEqual([l["figmaNodeId"] for l in body["links"]], ["1:1", "1:2"])
        self.assertEqual(body["links"][0]["studioPath"], "StarterGui/A2")

    def test_notes_merge_delete_and_cap(self):
        bridge._local_set_ui_context({"notes": {"a": "1", "b": "2"}})
        bridge._local_set_ui_context({"notes": {"b": None, "c": "3"}})
        body = json.loads(bridge._local_get_ui_context({})["text"])
        self.assertEqual(body["notes"], {"a": "1", "c": "3"})
        big = {"k%d" % i: "x" * 5000 for i in range(40)}
        bridge._local_set_ui_context({"notes": big})
        body = json.loads(bridge._local_get_ui_context({})["text"])
        self.assertLessEqual(body["noteCount"], bridge._UI_CTX_MAX_NOTES)
        self.assertTrue(all(len(v) <= bridge._UI_CTX_MAX_NOTE_LEN
                            for v in body["notes"].values()))

    def test_links_capped(self):
        for i in range(bridge._UI_CTX_MAX_LINKS + 8):
            bridge._local_set_ui_context({"link": {"figmaNodeId": "1:%d" % i,
                                                   "studioPath": "StarterGui/U%d" % i}})
        body = json.loads(bridge._local_get_ui_context({})["text"])
        self.assertEqual(body["linkCount"], bridge._UI_CTX_MAX_LINKS)
        self.assertEqual(body["links"][0]["figmaNodeId"],
                         "1:%d" % (bridge._UI_CTX_MAX_LINKS + 7))

    def test_get_filters_by_id_and_path(self):
        bridge._local_set_ui_context({"link": {"figmaNodeId": "1:1",
                                               "studioPath": "StarterGui/A"}})
        bridge._local_set_ui_context({"link": {"figmaNodeId": "1:2",
                                               "studioPath": "StarterGui/B"}})
        one = json.loads(bridge._local_get_ui_context({"figmaNodeId": "1:2"})["text"])
        self.assertEqual(one["linkCount"], 1)
        self.assertEqual(one["links"][0]["studioPath"], "StarterGui/B")
        bypath = json.loads(bridge._local_get_ui_context({"studioPath": "StarterGui/A"})["text"])
        self.assertEqual(bypath["links"][0]["figmaNodeId"], "1:1")

    def test_set_rejects_bad_shapes(self):
        cases = [
            ({}, "pass notes"),
            ({"link": "nope"}, "must be an object"),
            ({"link": {"figmaNodeId": "1:1"}}, "needs both"),
            ({"notes": ["a"]}, "must be an object map"),
            ({"unlink": {"figmaNodeId": "0:0"}}, "no such link"),
            ({"clear": "everything"}, "must be 'notes'"),
        ]
        for args, needle in cases:
            res = bridge._local_set_ui_context(args)
            self.assertFalse(res.get("ok"), args)
            self.assertEqual(res.get("kind"), "validation_error", args)
            self.assertIn(needle, res.get("error", ""), args)

    def test_clear_scopes(self):
        bridge._local_set_ui_context({"link": {"figmaNodeId": "1:1",
                                               "studioPath": "StarterGui/A"},
                                      "notes": {"k": "v"}})
        bridge._local_set_ui_context({"clear": "notes"})
        body = json.loads(bridge._local_get_ui_context({})["text"])
        self.assertEqual(body["notes"], {})
        self.assertEqual(body["linkCount"], 1)
        bridge._local_set_ui_context({"clear": "all"})
        body = json.loads(bridge._local_get_ui_context({})["text"])
        self.assertEqual((body["linkCount"], body["noteCount"]), (0, 0))

    def test_projects_are_isolated(self):
        bridge._local_set_ui_context({"projectId": "alpha",
                                      "link": {"figmaNodeId": "1:1",
                                               "studioPath": "StarterGui/A"}})
        body = json.loads(bridge._local_get_ui_context({"projectId": "beta"})["text"])
        self.assertEqual(body["linkCount"], 0)
        self.assertEqual(body["project"], "beta")

    def test_corrupt_store_degrades_to_empty(self):
        path = bridge._ui_context_path("default")
        with io.open(path, "w", encoding="utf-8") as f:
            f.write("{not json at all")
        res = bridge._local_get_ui_context({})
        self.assertTrue(res.get("ok"), res)
        self.assertEqual(json.loads(res["text"])["linkCount"], 0)

    def test_path_traversal_in_project_name_is_neutralized(self):
        path = bridge._ui_context_path("../../evil")
        self.assertNotIn("..", os.path.relpath(path, bridge.HERE).replace("\\", "/"))


class SendFigmaToStudioTest(ChainTestBase):
    """PLAN.md Phase 6: the cross-app one-liner."""

    def _happy(self, **overrides):
        responses = {
            "figma_get_nodes": self.ok(FIGMA_TREE),
            "create_ui_from_figma": self.ok({"gui": "StarterGui/ShopUI", "created": 5,
                                             "skipped": 0}),
            "validate_ui": self.ok({"passed": True, "errors": 0, "issues": []}),
        }
        responses.update(overrides)
        self.stub_clients(responses)
        return responses

    def test_happy_path_runs_three_hops_in_order(self):
        self._happy()
        res = bridge._local_send_figma_to_studio({"figmaNodeId": "1:23"})
        self.assertTrue(res.get("ok"), res)
        body = json.loads(res["text"])
        self.assertEqual([c["tool"] for c in self.calls],
                         ["figma_get_nodes", "create_ui_from_figma", "validate_ui"])
        self.assertEqual(body["gui"], "StarterGui/ShopUI")
        self.assertEqual(body["created"], 5)
        self.assertEqual(body["nodesSent"], 1)
        self.assertTrue(body["validation"]["passed"])
        self.assertTrue(body["linkRecorded"])
        self.assertEqual(len(body["hops"]), 3)
        for hop in body["hops"]:
            self.assertNotIn("body", hop, "hop bodies must not bloat the reply")

    def test_hops_route_to_the_right_client(self):
        self._happy()
        bridge._local_send_figma_to_studio({"figmaNodeId": "1:23"})
        self.assertEqual([h["client"] for h in json.loads(
            bridge._local_send_figma_to_studio({"figmaNodeId": "1:23"})["text"])["hops"]],
            ["figma", "studio", "studio"])

    def test_nodes_are_forwarded_inline_not_by_id(self):
        """The converter takes a tree, never a bare id - that was the whole
        point of the manual two-call flow."""
        self._happy()
        bridge._local_send_figma_to_studio({"figmaNodeId": "1:23"})
        send = next(c for c in self.calls if c["tool"] == "create_ui_from_figma")
        self.assertNotIn("nodeId", send["args"])
        self.assertNotIn("figmaNodeId", send["args"])
        self.assertEqual(send["args"]["nodes"][0]["id"], "1:23")

    def test_link_is_recorded_for_check_ui_sync(self):
        self._happy()
        bridge._local_send_figma_to_studio({"figmaNodeId": "1:23"})
        body = json.loads(bridge._local_get_ui_context({})["text"])
        self.assertEqual(body["linkCount"], 1)
        self.assertEqual(body["links"][0]["studioPath"], "StarterGui/ShopUI")
        self.assertEqual(body["links"][0]["nodeCount"], 1)

    def test_validate_can_be_skipped(self):
        self._happy()
        bridge._local_send_figma_to_studio({"figmaNodeId": "1:23", "validate": False})
        self.assertEqual([c["tool"] for c in self.calls],
                         ["figma_get_nodes", "create_ui_from_figma"])

    def test_validation_failure_is_reported_not_swallowed(self):
        self._happy(validate_ui=self.ok({"passed": False, "errors": 2,
                                         "issues": [{"code": "OVERLAP"}]}))
        res = bridge._local_send_figma_to_studio({"figmaNodeId": "1:23"})
        self.assertTrue(res.get("ok"), "sending succeeded; the LAYOUT is what failed")
        body = json.loads(res["text"])
        self.assertFalse(body["validation"]["passed"])
        self.assertIn("Layout issues", body["next"])

    def test_stops_at_first_failed_hop(self):
        self._happy(create_ui_from_figma={"ok": False, "kind": "execution_error",
                                          "error": "produced 0 instances"})
        res = bridge._local_send_figma_to_studio({"figmaNodeId": "1:23"})
        self.assertFalse(res.get("ok"))
        self.assertEqual([c["tool"] for c in self.calls],
                         ["figma_get_nodes", "create_ui_from_figma"])
        body = json.loads(res["text"])
        self.assertEqual(body["stoppedAt"], "create_ui_from_figma")
        self.assertEqual(body["completed"], ["figma_get_nodes"])
        self.assertIn("chain stopped at", res["error"])

    def test_empty_figma_tree_fails_before_conversion(self):
        self._happy(figma_get_nodes=self.ok({"nodes": []}))
        res = bridge._local_send_figma_to_studio({"figmaNodeId": "1:23"})
        self.assertFalse(res.get("ok"))
        self.assertNotIn("create_ui_from_figma", [c["tool"] for c in self.calls])
        self.assertIn("no convertible nodes", res["error"])

    def test_inline_nodes_skip_the_figma_hop(self):
        self._happy()
        res = bridge._local_send_figma_to_studio(
            {"figmaNodeId": "1:23", "nodes": FIGMA_TREE["nodes"]})
        self.assertTrue(res.get("ok"), res)
        self.assertEqual(self.calls[0]["tool"], "create_ui_from_figma")
        self.assertTrue(json.loads(res["text"])["hops"][0]["skipped"])

    def test_inline_nodes_without_id_rejected(self):
        """Without the id there is nothing to link, so check_ui_sync could
        never work later - refuse rather than silently break it."""
        self._happy()
        res = bridge._local_send_figma_to_studio({"nodes": FIGMA_TREE["nodes"]})
        self.assertFalse(res.get("ok"))
        self.assertEqual(res.get("kind"), "validation_error")
        self.assertEqual(self.calls, [])

    def test_requires_both_clients(self):
        self._happy()
        bridge._client_alive = lambda client: False
        res = bridge._local_send_figma_to_studio({"figmaNodeId": "1:23"})
        self.assertFalse(res.get("ok"))
        self.assertEqual(res.get("kind"), "plugin_offline")
        self.assertIn("Figma", res["error"])
        self.assertIn("Studio", res["error"])
        self.assertIn("figma_status", res["error"])
        self.assertEqual(self.calls, [])

    def test_requires_the_queue(self):
        self._happy()
        bridge._queue_server_on[0] = False
        res = bridge._local_send_figma_to_studio({"figmaNodeId": "1:23"})
        self.assertFalse(res.get("ok"))
        self.assertIn("restart the bridge", res["error"])

    def test_requires_an_id_or_nodes(self):
        self._happy()
        res = bridge._local_send_figma_to_studio({})
        self.assertFalse(res.get("ok"))
        self.assertEqual(res.get("kind"), "validation_error")

    def test_node_tree_is_capped_at_20(self):
        many = {"nodes": [{"id": "1:%d" % i, "name": "N%d" % i, "type": "FRAME"}
                          for i in range(40)]}
        self._happy(figma_get_nodes=self.ok(many))
        res = bridge._local_send_figma_to_studio({"figmaNodeId": "1:0"})
        self.assertEqual(json.loads(res["text"])["nodesSent"], 20)

    def test_scale_is_clamped_and_validated(self):
        self._happy()
        bridge._local_send_figma_to_studio({"figmaNodeId": "1:23", "scale": 99})
        self.assertEqual(self.calls[1]["args"]["scale"], 4.0)
        self.calls.clear()
        res = bridge._local_send_figma_to_studio({"figmaNodeId": "1:23", "scale": "big"})
        self.assertFalse(res.get("ok"))
        self.assertEqual(self.calls, [])

    def test_timeout_budget_is_shared_across_hops(self):
        self._happy()
        bridge._local_send_figma_to_studio({"figmaNodeId": "1:23",
                                            "timeoutSeconds": 1000})
        for c in self.calls:
            self.assertLessEqual(c["timeout"], 300.0,
                                 "one chain must never exceed the cap")

    def test_plugin_exception_becomes_a_terminal_envelope(self):
        self._happy(figma_get_nodes={"__raise__": "kaboom"})
        res = bridge._local_send_figma_to_studio({"figmaNodeId": "1:23"})
        self.assertFalse(res.get("ok"))
        self.assertIn("kaboom", res["error"])


class CheckUiSyncTest(ChainTestBase):
    """PLAN.md Phase 6: what drifted between Figma and Studio."""

    def _pair(self, figma=FIGMA_TREE, studio=STUDIO_TREE):
        self.stub_clients({"figma_get_nodes": self.ok(figma),
                           "get_ui_tree": self.ok(studio)})
        bridge._local_set_ui_context({"link": {"figmaNodeId": "1:23",
                                               "studioPath": "StarterGui/ShopUI"}})

    def test_reports_drift(self):
        self._pair()
        res = bridge._local_check_ui_sync({"figmaNodeId": "1:23"})
        self.assertTrue(res.get("ok"), res)
        body = json.loads(res["text"])
        self.assertEqual([c["tool"] for c in self.calls],
                         ["figma_get_nodes", "get_ui_tree"])
        self.assertFalse(body["inSync"])
        self.assertIn("DebugLabel", body["studioOnly"])
        self.assertEqual(body["notSent"], [])
        # "Buy now" upstream, "Buy" downstream.
        self.assertEqual([d["name"] for d in body["textDiffers"]], ["Buy"])

    def test_container_nodes_are_never_reported_as_drift(self):
        """The Figma root became the ScreenGui and the ScreenGui is named by
        the converter - comparing them would report drift forever."""
        self._pair()
        body = json.loads(bridge._local_check_ui_sync({"figmaNodeId": "1:23"})["text"])
        self.assertNotIn("ShopFrame", body["notSent"])
        self.assertNotIn("ShopUI", body["studioOnly"])
        self.assertNotIn("ShopFrame", [d["name"] for d in body["textDiffers"]])

    def test_detects_unsent_and_edited_text(self):
        figma = {"nodes": [{
            "id": "1:23", "name": "ShopFrame", "type": "FRAME",
            "children": [
                {"id": "1:24", "name": "Header", "type": "FRAME", "children": []},
                {"id": "1:25", "name": "Title", "type": "TEXT", "characters": "Store"},
                {"id": "1:27", "name": "Footer", "type": "FRAME", "children": []},
            ]}]}
        self._pair(figma=figma)
        body = json.loads(bridge._local_check_ui_sync({"figmaNodeId": "1:23"})["text"])
        self.assertEqual(body["notSent"], ["Footer"])
        # "Buy" is gone upstream and "DebugLabel" was never in Figma, so both
        # are Studio-only rather than text drift.
        self.assertEqual(body["studioOnly"], ["Buy", "DebugLabel"])
        self.assertEqual([d["name"] for d in body["textDiffers"]], ["Title"])
        self.assertEqual(body["textDiffers"][0]["figma"], "Store")
        self.assertEqual(body["textDiffers"][0]["studio"], "Shop")

    def test_in_sync_when_identical(self):
        studio = {"nodes": [
            {"name": "ShopUI", "class": "ScreenGui", "depth": 0},
            {"name": "Header", "class": "Frame", "depth": 1},
            {"name": "Title", "class": "TextLabel", "depth": 2, "text": "Shop"},
            {"name": "Buy", "class": "TextButton", "depth": 1, "text": "Buy now"},
        ]}
        self._pair(studio=studio)
        body = json.loads(bridge._local_check_ui_sync({"figmaNodeId": "1:23"})["text"])
        self.assertTrue(body["inSync"], body)
        self.assertEqual(body["compared"], {"figma": 3, "studio": 3})
        self.assertEqual(body["notSent"], [])
        self.assertEqual(body["studioOnly"], [])

    def test_falls_back_to_the_only_link(self):
        self._pair()
        res = bridge._local_check_ui_sync({})
        self.assertTrue(res.get("ok"), res)
        self.assertEqual(json.loads(res["text"])["studioPath"], "StarterGui/ShopUI")

    def test_ambiguous_without_args_is_a_clear_error(self):
        self._pair()
        bridge._local_set_ui_context({"link": {"figmaNodeId": "1:24",
                                               "studioPath": "StarterGui/Other"}})
        res = bridge._local_check_ui_sync({})
        self.assertFalse(res.get("ok"))
        self.assertIn("Pass figmaNodeId or studioPath", res["error"])

    def test_no_link_yet(self):
        self.stub_clients({})
        res = bridge._local_check_ui_sync({})
        self.assertFalse(res.get("ok"))
        self.assertEqual(res.get("kind"), "validation_error")
        self.assertIn("send_figma_to_studio", res["error"])

    def test_studio_tree_is_scoped_to_the_linked_gui(self):
        self._pair()
        bridge._local_check_ui_sync({"figmaNodeId": "1:23"})
        self.assertEqual(self.calls[1]["args"]["path"], "StarterGui/ShopUI")

    def test_legacy_uitree_shape_still_diffs(self):
        studio = {"uiTree": ["StarterGui/ShopUI (ScreenGui)", "StarterGui/ShopUI/Header (Frame)"]}
        self._pair(studio=studio)
        body = json.loads(bridge._local_check_ui_sync({"figmaNodeId": "1:23"})["text"])
        self.assertFalse(body["inSync"])
        self.assertIn("Title", body["notSent"])

    def test_requires_both_clients(self):
        self._pair()
        bridge._client_alive = lambda client: False
        res = bridge._local_check_ui_sync({"figmaNodeId": "1:23"})
        self.assertFalse(res.get("ok"))
        self.assertEqual(res.get("kind"), "plugin_offline")
        self.assertEqual(self.calls, [])

    def test_stops_when_the_figma_hop_fails(self):
        self._pair()
        bridge.safe_call = lambda n, a, t: ({"ok": False, "kind": "timeout",
                                             "error": "timeout"} if n == "figma_get_nodes"
                                            else {"ok": True, "text": "{}"})
        res = bridge._local_check_ui_sync({"figmaNodeId": "1:23"})
        self.assertFalse(res.get("ok"))
        self.assertEqual(json.loads(res["text"])["stoppedAt"], "figma_get_nodes")


class FigmaTreeParsingTest(unittest.TestCase):
    """The Figma plugin has shipped the tree under several keys."""

    def test_every_known_shape_yields_nodes(self):
        node = {"id": "1:1", "name": "A", "type": "FRAME"}
        shapes = (
            {"nodes": [node]},
            {"nodes": [dict(node, children=[])]},
            {"node": dict(node, children=[])},
            {"root": dict(node, children=[])},
            {"result": {"nodes": [node]}},
        )
        for body in shapes:
            self.assertTrue(bridge._figma_nodes_from(body), body)

    def test_garbage_yields_nothing(self):
        for body in ({}, None, "nope", {"nodes": []}, {"nodes": "x"}):
            self.assertEqual(bridge._figma_nodes_from(body), [], body)

    def test_names_flattens_nested_children(self):
        nodes = [{"name": "A", "children": [{"name": "B", "children": [
            {"name": "C", "characters": "hi"}]}]}]
        flat = bridge._figma_names(nodes)
        self.assertEqual(sorted(flat), ["A", "B", "C"])
        self.assertEqual(flat["C"], "hi")
        self.assertIsNone(flat["A"])

    def test_skip_root_drops_only_the_container(self):
        nodes = [{"name": "Screen", "children": [{"name": "A"}]}]
        self.assertEqual(sorted(bridge._figma_names(nodes, skip_root=True)), ["A"])
        self.assertEqual(sorted(bridge._figma_names(nodes)), ["A", "Screen"])
        # A second top-level node is a real part, not a container.
        two = [{"name": "Screen", "children": []}, {"name": "Side"}]
        self.assertEqual(sorted(bridge._figma_names(two, skip_root=True)), ["Side"])

    def test_names_stops_at_depth_6(self):
        """Depth 0..6 are compared; anything deeper is dropped, so a deeply
        nested Figma tree cannot blow up the diff."""
        deep = {"name": "d0"}
        for i in range(1, 10):
            deep = {"name": "d%d" % i, "children": [deep]}
        flat = bridge._figma_names([deep])
        self.assertEqual(sorted(flat, key=lambda n: -int(n[1:])),
                         ["d9", "d8", "d7", "d6", "d5", "d4", "d3"])
        self.assertNotIn("d2", flat)


class OrchestrationCatalogTest(unittest.TestCase):
    """Phase 6 wiring: prompts, generated artifacts, and the Node registry."""

    def test_catalog_counts_213(self):
        with io.open(os.path.join(ROOT, "generated", "tool-prompts.json"), encoding="utf-8") as f:
            generated = json.load(f)
        self.assertEqual(generated.get("toolCount"), 213)
        self.assertEqual(generated.get("coverage"), "213/213")
        for name in CHAIN_TOOLS + CONTEXT_TOOLS:
            self.assertIn(name, generated.get("prompts", {}), name)
            for field in ("persona", "when_to_use", "args_guide", "example_call",
                          "output", "pitfalls"):
                self.assertTrue((generated["prompts"][name].get(field) or "").strip(),
                                f"{name}: {field} empty")
        with io.open(os.path.join(ROOT, "generated", "code-fields.json"), encoding="utf-8") as f:
            fields = json.load(f)
        self.assertEqual(fields.get("toolCount"), 213)
        for name in CHAIN_TOOLS + CONTEXT_TOOLS:
            self.assertIn(name, fields.get("toolFields", {}), name)

    def test_send_prompt_teaches_the_one_liner(self):
        with io.open(os.path.join(ROOT, "generated", "tool-prompts.json"), encoding="utf-8") as f:
            p = json.load(f)["prompts"]
        send = p["send_figma_to_studio"]
        # The chain is documented where it helps, and every arg is listed.
        self.assertIn("figma_get_nodes", send["args_guide"])
        self.assertIn("validate_ui", send["args_guide"])
        for arg in ("figmaNodeId", "nodes?", "parent?", "name?", "scale?",
                    "validate?", "timeoutSeconds?"):
            self.assertIn(arg, send["args_guide"], arg)
        self.assertIn("BOTH plugins", send["pitfalls"])
        self.assertIn("ok:true means the SCREENGUI was built", send["pitfalls"])
        self.assertIn("never hand-roll", send["when_to_use"])

    def test_sync_prompt_separates_the_drift_kinds(self):
        with io.open(os.path.join(ROOT, "generated", "tool-prompts.json"), encoding="utf-8") as f:
            p = json.load(f)["prompts"]
        out = p["check_ui_sync"]["output"]
        for token in ("notSent", "studioOnly", "textDiffers"):
            self.assertIn(token, out)

    def test_node_registry_returns_terminal_bridge_required(self):
        """Never a queued:true that can never resolve from the stdio server."""
        reg = read("mcp-server", "src", "tools", "registry.ts")
        self.assertIn("function bridgeRequired", reg)
        self.assertIn('code: "BRIDGE_REQUIRED"', reg)
        for name in CHAIN_TOOLS + CONTEXT_TOOLS:
            self.assertIn(f'name: "{name}"', reg, name)
            self.assertIn(f'bridgeRequired("{name}"', reg, name)

    def test_context_store_documented_as_local_only(self):
        """The store is machine-local runtime state, not repo content."""
        readme = read("README.md")
        self.assertIn("context/", readme)
        self.assertIn("local to this machine", readme)


if __name__ == "__main__":
    unittest.main(verbosity=1)
