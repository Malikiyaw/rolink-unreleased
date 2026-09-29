# SPDX-License-Identifier: GPL-3.0-or-later
"""Live Creator Store search (bridge-side) - contract + honesty tests.

search_asset must return REAL Roblox catalog rows when the network is up and
must NEVER fabricate results when it is not. These tests monkeypatch
urlopen so they run offline and deterministically.
"""
import io
import json
import os
import sys
import types
import unittest

if "websockets" not in sys.modules:
    fake = types.ModuleType("websockets")
    fake.ConnectionClosed = type("ConnectionClosed", (Exception,), {})
    fake.serve = lambda *a, **kw: None
    sys.modules["websockets"] = fake

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

import bridge

CATALOG_FIXTURE = {
    "nextPageToken": "opaque",
    "creatorStoreAssets": [
        {"asset": {"id": "12345678", "name": "Medieval Sword", "description": "Sharp blade",
                    "assetTypeId": 10, "hasScripts": True, "scriptCount": 2},
         "creator": {"name": "Swordsmith"},
         "creatorStoreProduct": {"purchasePrice": {"quantity": {"significand": 0, "exponent": 0}}}},
        {"asset": {"id": 87654321, "name": "Rusty Axe", "description": "Old but sharp",
                    "assetTypeId": 10},
         "creator": {"name": "Axeman"}},
        {"asset": {"id": 0, "name": "Broken Row (no id)"}, "creator": {"name": "Nobody"}},
        {"asset": {"id": "not-a-number", "name": "Also dropped"}, "creator": {"name": "Nobody"}},
        "not an object",
    ],
    "totalResults": 2,
}


class _Resp:
    def __init__(self, payload):
        self._payload = payload

    def read(self, _n=None):
        return self._payload

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class _NoNetwork:
    def __call__(self, *a, **kw):
        raise OSError("simulated offline")


class AssetSearchTest(unittest.TestCase):
    def setUp(self):
        self._orig_urlopen = bridge.__dict__.get("_TEST_URLOPEN")

    # -- validation ------------------------------------------------------
    def test_empty_keyword_rejected(self):
        r = bridge._local_search_asset({})
        self.assertFalse(r["ok"])
        self.assertEqual(r["kind"], "validation_error")
        self.assertIn("keyword", r["error"])

    def test_blank_keyword_rejected(self):
        r = bridge._local_search_asset({"keyword": "   "})
        self.assertFalse(r["ok"])
        self.assertEqual(r["kind"], "validation_error")

    def test_non_string_and_overlong_keyword_rejected(self):
        for value in (123, ["sword"], "x" * 65):
            r = bridge._local_search_asset({"keyword": value})
            self.assertFalse(r["ok"], repr(value))
            self.assertEqual(r["kind"], "validation_error", repr(value))

    def test_alias_keyword_query_and_q_accepted(self):
        # query/q are accepted spellings; with no network they must fail on
        # the NETWORK, not on validation (proves the keyword was found).
        import urllib.request
        orig = urllib.request.urlopen
        urllib.request.urlopen = _NoNetwork()
        try:
            for key in ("keyword", "query", "q"):
                r = bridge._local_search_asset({key: "sword", "limit": 3})
                self.assertFalse(r["ok"], key)
                self.assertNotEqual(r.get("kind"), "validation_error", key)
                self.assertEqual(r.get("error_code"), "ASSET_SEARCH_UNAVAILABLE", key)
        finally:
            urllib.request.urlopen = orig

    # -- offline honesty -------------------------------------------------
    def test_offline_never_fabricates(self):
        import urllib.request
        orig = urllib.request.urlopen
        urllib.request.urlopen = _NoNetwork()
        try:
            r = bridge._local_search_asset({"keyword": "sword"})
        finally:
            urllib.request.urlopen = orig
        self.assertFalse(r["ok"])
        self.assertTrue(r.get("transient"), "offline must be marked transient for Studio fallback")
        self.assertEqual(r.get("error_code"), "ASSET_SEARCH_UNAVAILABLE")
        body = json.dumps(r)
        for bad in ("Mock for", "1000000", "mock asset", "SciFi Crate"):
            self.assertNotIn(bad, body, "offline search must not invent results")

    # -- happy path ------------------------------------------------------
    def test_normalizes_fixture_catalog(self):
        import urllib.request
        orig = urllib.request.urlopen
        captured = {}

        def fake(req, timeout=None):
            captured["url"] = getattr(req, "full_url", str(req))
            captured["timeout"] = timeout
            return _Resp(json.dumps(CATALOG_FIXTURE).encode("utf-8"))

        urllib.request.urlopen = fake
        try:
            r = bridge._local_search_asset({"keyword": "sword", "limit": 5})
        finally:
            urllib.request.urlopen = orig
        self.assertTrue(r["ok"], r)
        body = json.loads(r["text"])
        self.assertEqual(body["source"], "roblox-catalog")
        self.assertEqual(body["count"], 2, "rows without a positive numeric id must be dropped")
        first = body["assets"][0]
        self.assertEqual(first["id"], 12345678)
        self.assertEqual(first["name"], "Medieval Sword")
        self.assertEqual(first["creator"], "Swordsmith")
        self.assertTrue(first["hasScripts"])
        self.assertEqual(first["scriptCount"], 2)
        self.assertTrue(first["isFree"])
        self.assertEqual(first["priceCents"], 0)
        self.assertIn("/library/12345678/redirect", first["url"])
        second = body["assets"][1]
        self.assertEqual(second["id"], 87654321)
        self.assertEqual(second["creator"], "Axeman")
        self.assertIn("apis.roblox.com/toolbox-service/v2/assets:search", captured["url"])
        self.assertIn("searchCategoryType=Model", captured["url"])
        self.assertIn("query=sword", captured["url"])
        self.assertIn("maxPageSize=5", captured["url"])
        self.assertIn("includeOnlyVerifiedCreators=false", captured["url"])
        self.assertLessEqual(captured["timeout"] or 0, 10)

    def test_normalizes_legacy_shape_without_losing_rows(self):
        legacy = {"data": [{"ItemId": 42, "Name": "Old API Model", "CreatorName": "Creator"}]}
        import urllib.request
        orig = urllib.request.urlopen
        urllib.request.urlopen = lambda *a, **kw: _Resp(json.dumps(legacy).encode("utf-8"))
        try:
            r = bridge._local_search_asset({"keyword": "model"})
        finally:
            urllib.request.urlopen = orig
        self.assertTrue(r["ok"], r)
        body = json.loads(r["text"])
        self.assertEqual(body["assets"][0]["id"], 42)
        self.assertEqual(body["assets"][0]["creator"], "Creator")

    def test_limit_clamped_and_category_mapped(self):
        import urllib.request
        orig = urllib.request.urlopen
        urls = []

        def fake(req, timeout=None):
            urls.append(getattr(req, "full_url", str(req)))
            return _Resp(json.dumps([]).encode("utf-8"))

        urllib.request.urlopen = fake
        try:
            r = bridge._local_search_asset({"keyword": "x" * 64, "limit": 999, "category": "mesh"})
        finally:
            urllib.request.urlopen = orig
        self.assertTrue(r["ok"], r)
        body = json.loads(r["text"])
        self.assertEqual(body["count"], 0)
        self.assertEqual(body["category"], "MeshPart")
        self.assertIn("searchCategoryType=MeshPart", urls[0])
        self.assertIn("maxPageSize=20", urls[0])

    def test_empty_result_is_not_an_error(self):
        import urllib.request
        orig = urllib.request.urlopen
        urllib.request.urlopen = lambda *a, **kw: _Resp(b"[]")
        try:
            r = bridge._local_search_asset({"keyword": "zzzznotathing"})
        finally:
            urllib.request.urlopen = orig
        self.assertTrue(r["ok"], "zero matches is a successful search")
        body = json.loads(r["text"])
        self.assertEqual(body["assets"], [])
        self.assertIn("no matches", body["note"].lower())

    # -- routing ---------------------------------------------------------
    def test_registered_local_and_not_queue_routed(self):
        self.assertIn("search_asset", bridge.LOCAL_HANDLERS)
        self.assertIs(bridge.LOCAL_HANDLERS["search_asset"], bridge._local_search_asset)
        self.assertNotIn("search_asset", bridge.STUDIO_QUEUE_TOOLS,
                         "a local handler must never also be queue-routed")
        # The alias must resolve to the local handler too.
        self.assertEqual(bridge._TOOL_ALIASES.get("search_assets"), "search_asset")

    def test_alias_spelling_uses_local_handler(self):
        import urllib.request
        orig = urllib.request.urlopen
        urllib.request.urlopen = lambda *a, **kw: _Resp(json.dumps(CATALOG_FIXTURE).encode("utf-8"))
        try:
            r = bridge.safe_call("search_assets", {"keyword": "sword", "limit": 2}, 5)
        finally:
            urllib.request.urlopen = orig
        self.assertTrue(r["ok"], r)
        self.assertIn("Medieval Sword", r["text"])

    def test_transient_falls_back_to_native_studio_mcp(self):
        class _Mgr:
            index = {"roblox/search_asset": (None, "search_asset")}

            def any_alive(self):
                return True

            def call(self, name, args, timeout):
                return {"ok": True, "text": json.dumps({"status": "success", "results": [
                    {"assetId": "5", "name": "Native", "creatorName": "Studio", "assetType": "Model"}
                ]})}

        import urllib.request
        orig_url = urllib.request.urlopen
        orig_mgr = bridge.mgr
        urllib.request.urlopen = _NoNetwork()
        bridge.mgr = _Mgr()
        try:
            r = bridge.safe_call("search_asset", {"keyword": "sword"}, 5)
        finally:
            urllib.request.urlopen = orig_url
            bridge.mgr = orig_mgr
        self.assertTrue(r["ok"], r)
        body = json.loads(r["text"])
        self.assertEqual(body["source"], "studio-mcp")
        self.assertEqual(body["assets"][0]["id"], 5)

    def test_native_error_shape_is_not_reported_as_empty_success(self):
        class _Mgr:
            index = {"search_asset": (None, "search_asset")}

            def call(self, name, args, timeout):
                return {"ok": True, "text": json.dumps({"status": "error", "error": "studio unavailable"})}

        import urllib.request
        orig_url = urllib.request.urlopen
        orig_mgr = bridge.mgr
        urllib.request.urlopen = _NoNetwork()
        bridge.mgr = _Mgr()
        try:
            r = bridge.safe_call("search_asset", {"keyword": "sword", "studio_id": "studio-test"}, 5)
        finally:
            urllib.request.urlopen = orig_url
            bridge.mgr = orig_mgr
        self.assertFalse(r["ok"])
        self.assertEqual(r["error_code"], "ASSET_SEARCH_UNAVAILABLE")

    def test_pluginless_import_routes_to_native_insert(self):
        class _Holder:
            id = "roblox"

        class _Mgr:
            index = {"insert_asset": (_Holder(), "insert_asset")}

            def call(self, name, args, timeout):
                return {"text": json.dumps({"status": "success", "result": {
                    "path": "Workspace.NativeImported"
                }})}

        orig_mgr = bridge.mgr
        orig_alive = bridge._plugin_alive
        bridge.mgr = _Mgr()
        bridge._plugin_alive = lambda: False
        try:
            result = bridge.safe_call("import_asset", {"assetId": 123, "studio_id": "studio-test"}, 5)
        finally:
            bridge.mgr = orig_mgr
            bridge._plugin_alive = orig_alive
        self.assertTrue(result["ok"])
        self.assertEqual(json.loads(result["text"])["source"], "studio-mcp")

    def test_native_insert_fallback_requires_a_verified_path(self):
        class _Holder:
            id = "roblox"

        class _Mgr:
            index = {"insert_asset": (_Holder(), "insert_asset")}

            def call(self, name, args, timeout):
                self.seen = (name, args)
                return {"text": json.dumps({"status": "success", "result": {
                    "path": "Workspace.ImportedSword"
                }})}

        mgr = _Mgr()
        orig_mgr = bridge.mgr
        bridge.mgr = mgr
        try:
            result = bridge._native_import_asset({"assetId": 123, "studio_id": "studio-test"}, 5)
        finally:
            bridge.mgr = orig_mgr
        self.assertTrue(result["ok"])
        body = json.loads(result["text"])
        self.assertEqual(body["path"], "Workspace.ImportedSword")
        self.assertEqual(body["source"], "studio-mcp")
        self.assertEqual(mgr.seen[1]["assetId"], "123")
        self.assertEqual(mgr.seen[1]["parentPath"], "game.Workspace")

    def test_transient_without_native_returns_structured_error(self):
        class _Mgr:
            index = {}

            def any_alive(self):
                return False

            def call(self, *a, **kw):
                raise AssertionError("must not call Studio without a live tool")

        import urllib.request
        orig_url = urllib.request.urlopen
        orig_mgr = bridge.mgr
        urllib.request.urlopen = _NoNetwork()
        bridge.mgr = _Mgr()
        try:
            r = bridge.safe_call("search_asset", {"keyword": "sword"}, 5)
        finally:
            urllib.request.urlopen = orig_url
            bridge.mgr = orig_mgr
        self.assertFalse(r["ok"])
        self.assertEqual(r["error_code"], "ASSET_SEARCH_UNAVAILABLE")
        self.assertIn("never invent asset IDs", r["error"])


class NoMocksAnywhereTest(unittest.TestCase):
    def test_no_mock_asset_fallbacks_remain(self):
        for rel in ("mcp-server/src/assetStore.ts", "mcp-server/src/index.ts",
                    "studio-plugin/RoLink.lua", "bridge.py"):
            with io.open(os.path.join(ROOT, rel), encoding="utf-8") as f:
                src = f.read()
            for bad in ("mockAssets", "Mock for", "mock asset", "id: 1000000",
                        "search.roblox.com/catalog/json"):
                self.assertNotIn(bad, src, "%s still fabricates or uses retired asset search" % rel)

    def test_plugin_branch_points_at_bridge(self):
        with io.open(os.path.join(ROOT, "studio-plugin", "RoLink.lua"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("search_asset is served by the bridge", src)
        self.assertNotIn('tool=="search_asset" or tool=="search_assets" then result=', src)
        self.assertIn("local function importCreatorAsset", src)
        self.assertIn('game:GetObjects("rbxassetid://" .. digits)', src)
        self.assertIn('game:GetService("InsertService"):LoadAsset(id)', src)
        self.assertIn("args.__rlCancelled", src)
        self.assertIn("__rlCancelled = true", src)
        self.assertIn("LuaSourceContainer", src)
        self.assertIn("scriptsStripped", src)
        self.assertNotIn("LoadAsset('..tostring(args.assetId)", src)
        with io.open(os.path.join(ROOT, "bridge.py"), encoding="utf-8") as f:
            br = f.read()
        self.assertIn("apis.roblox.com/toolbox-service/v2/assets:search", br)
        self.assertNotIn("search.roblox.com/catalog/json", br)

    def test_quarantine_lists_search_asset_as_verified(self):
        with io.open(os.path.join(ROOT, "generated", "tool-quarantine.json"), encoding="utf-8") as f:
            q = json.load(f)
        self.assertNotIn("search_asset", q["partial"])
        self.assertEqual(q["failing"], [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
