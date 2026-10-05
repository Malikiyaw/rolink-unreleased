# SPDX-License-Identifier: GPL-3.0-or-later
"""tests/test_phase3_import.py - Phase 3 build engine (import-first, revise by
delta) contract + honesty tests.

    python3 -m unittest tests.test_phase3_import -v

Everything runs OFFLINE. `websockets` is not installed, so it is stubbed into
sys.modules before bridge is imported (same precedent as
tests/test_sprint1_truth.py and tests/test_asset_search.py).

The store is redirected into a temp directory by patching bridge.HERE, so no
test can touch the real memory/model-graph.json.

The centre of gravity of this file is the NO-FABRICATION rule: whenever the
import cannot complete, no field of the answer may claim the kit landed. Those
assertions live in `assert_no_import_claimed` and are applied to every failure
path below.
"""
import json
import os
import shutil
import sys
import tempfile
import types
import unittest

if "websockets" not in sys.modules:
    _fake = types.ModuleType("websockets")
    _fake.ConnectionClosed = type("ConnectionClosed", (Exception,), {})
    _fake.serve = lambda *a, **kw: None
    sys.modules["websockets"] = _fake

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

import bridge  # noqa: E402

IMPORT = bridge.LOCAL_HANDLERS["import_distinctus_build"]
REVISE = bridge.LOCAL_HANDLERS["revise_import"]
GRAPH = bridge.LOCAL_HANDLERS["get_model_graph"]


def body_of(res):
    """Best-effort terminal body: the handler answers with {"text"} on success
    and {"error": <json>} on failure (the run_task/batch_queue precedent)."""
    for key in ("text", "error"):
        raw = res.get(key)
        if not isinstance(raw, str) or not raw:
            continue
        try:
            data = json.loads(raw)
        except Exception:
            continue
        if isinstance(data, dict) and ("status" in data or "tool" in data or "plan" in data):
            return data
    return {}


def assert_no_import_claimed(testcase, res, why="", root_allowed=False):
    """THE central assertion: a failed answer must not contain a field claiming
    the kit landed. Checks the parsed body AND the raw text so a smuggled claim
    cannot hide in a nested field. `root_allowed` is for revise_import, where a
    root that was READ and confirmed to exist is legitimately reportable even
    though the revision itself failed."""
    testcase.assertIsInstance(res, dict, why)
    testcase.assertFalse(res.get("ok"), "expected a failure envelope: %r" % (res,))
    b = body_of(res)
    testcase.assertIsNot(b.get("imported"), True,
                         "body claims imported:true on a failed import (%s)" % why)
    testcase.assertIsNot(b.get("applied"), True,
                         "body claims applied:true on a failed revision (%s)" % why)
    testcase.assertNotEqual(b.get("status"), "success",
                            "body claims status success on a failed run (%s)" % why)
    if not root_allowed:
        testcase.assertIsNone(b.get("root"),
                              "a failed import must not report a root (%s)" % why)
    raw = json.dumps(res, default=str).replace(" ", " ")
    testcase.assertNotIn('"imported":true', raw.lower(),
                         "raw text claims imported:true (%s)" % why)
    testcase.assertNotIn('"applied":true', raw.lower(),
                         "raw text claims applied:true (%s)" % why)


def assert_no_placement_claimed(testcase, res, why="", unverified=()):
    """The kit may legitimately be in the place while the PLACEMENT is not.
    Then nothing in the answer may claim it was positioned, scaled, rotated or
    anchored as asked. `unverified` names fields this particular run was never
    able to measure - they must be null, never true."""
    testcase.assertFalse(res.get("ok"), why)
    b = body_of(res)
    for field in unverified:
        testcase.assertIsNot(b.get(field), True,
                             "%s claims true but was never measured (%s)" % (field, why))
        testcase.assertIsNone(b.get(field),
                              "%s must be null when it could not be measured (%s)" % (field, why))
    testcase.assertFalse(b.get("verification", {}).get("passed"),
                         "verification.passed claims success (%s)" % why)
    testcase.assertNotEqual(b.get("status"), "success",
                            "status claims success on a partial import (%s)" % why)


class GraphIsolation(unittest.TestCase):
    """Redirect the model graph into a temp dir for every test."""

    def setUp(self):
        self._here = bridge.HERE
        self._active = dict(bridge._active_project)
        self._poll = bridge._queue_last_poll[0]
        self._on = bridge._queue_server_on[0]
        self._mgr = getattr(bridge, "mgr", None)
        self._save = bridge.safe_call
        self._tmp = tempfile.mkdtemp(prefix="rolink_p3_")
        bridge.HERE = self._tmp
        bridge._queue_last_poll[0] = 0.0        # plugin never seen polling
        bridge._queue_server_on[0] = False
        bridge.mgr = bridge.MCPManager()        # nothing advertised
        self.store = os.path.join(self._tmp, "memory", "model-graph.json")

    def tearDown(self):
        bridge.HERE = self._here
        bridge._active_project.clear()
        bridge._active_project.update(self._active)
        bridge._queue_last_poll[0] = self._poll
        bridge._queue_server_on[0] = self._on
        bridge.mgr = self._mgr
        bridge.safe_call = self._save
        shutil.rmtree(self._tmp, ignore_errors=True)

    # ── helpers: a scripted plugin ─────────────────────────────────────────

    def stub_plugin(self, tree=None, anchored=True, position=(0.0, 0.0, 0.0),
                    offline_tools=(), import_result=None):
        """Replace bridge.safe_call with a scripted Studio.

        `tree` maps a path to a list of {name, class, path} children, mirroring
        what the real get_instances branch returns. Paths are normalised
        (slash form -> dot form, lowercased) because the plugin answers with
        GetFullName's dotted spelling. Anything not in `tree` is an honest
        "not found". `offline_tools` names tools that must answer with a
        plugin_offline envelope, so a failure path is driven for real rather
        than simulated. Returns the router so a test can inspect which tools
        were actually called."""
        def key(p):
            return str(p or "").lower().replace("/", ".")

        state = {"tree": {key(k): list(v) for k, v in (tree or {}).items()},
                 "calls": []}

        def route(name, args, timeout):
            state["calls"].append((name, dict(args or {})))
            if name in offline_tools:
                return {"ok": False, "tool": name, "kind": "plugin_offline",
                        "error_code": "PLUGIN_OFFLINE",
                        "error": "ERROR calling %s: the RoLink Studio plugin did not answer.\n"
                                 "install studio-plugin/RoLink.lua" % name,
                        "verification": {"checked": False}}
            a = args or {}
            path = str(a.get("path") or "")
            if name == "take_snapshot":
                # atomic mode needs a real pre-snapshot; its hash only has to be
                # stable, so emit the scripted tree.
                lines = ["RoLink snapshot (scripted)"] + sorted(state["tree"])
                return {"ok": True, "text": json.dumps({"snapshot": "\n".join(lines)})}
            if name == "rollback":
                return {"ok": True, "text": json.dumps({"rolledBack": a.get("steps", 0)})}
            if name == "get_instances":
                kids = state["tree"].get(key(path))
                if kids is None:
                    return {"ok": False, "kind": "execution_error",
                            "error": "not found " + path, "verification": {"checked": False}}
                return {"ok": True, "text": json.dumps(
                    {"matchedPath": path, "path": path, "count": len(kids),
                     "instances": kids})}
            if name == "get_property_value":
                prop = a.get("property")
                if prop == "Position":
                    x, y, z = position
                    return {"ok": True, "text": json.dumps(
                        {"matchedPath": path, "value": {"X": x, "Y": y, "Z": z}})}
                if prop == "Anchored":
                    return {"ok": True, "text": json.dumps(
                        {"matchedPath": path, "value": bool(anchored)})}
                return {"ok": False, "kind": "validation_error",
                        "error": "unknown property " + str(prop),
                        "verification": {"checked": False}}
            if name in ("import_asset", "clone_instance"):
                if import_result is not None:
                    return import_result
                parent = str(a.get("parent") or "workspace").rstrip("/")
                base = a.get("assetName") or a.get("newName") or "ImportedKit"
                # Real GetFullName() keeps Studio's casing, so the scripted path
                # does too; lookups stay case-insensitive via key().
                root = "%s.%s" % (parent, base)
                child = {"name": "Baseplate", "class": "Part", "path": root + ".Baseplate"}
                state["tree"][key(root)] = [child]
                state["tree"][key(root + ".Baseplate")] = []
                state["tree"].setdefault(key(parent), []).append(
                    {"name": base, "class": "Model", "path": root})
                return {"ok": True, "text": json.dumps(
                    {"imported": True, "assetId": a.get("assetId"), "id": a.get("assetId"),
                     "path": root, "className": "Model", "parent": parent,
                     "scriptsStripped": True, "removedScripts": 3})}
            if name == "set_properties":
                # A rename really renames in the scripted place, so the
                # post-revision read-back can confirm or refute it.
                want = (a.get("properties") or {}).get("Name")
                if want:
                    old_key = key(path)
                    parent_key = old_key.rsplit(".", 1)[0] if "." in old_key else ""
                    for c in state["tree"].get(parent_key, []):
                        if key(c.get("path")) == old_key:
                            kids = state["tree"].pop(old_key, [])
                            new_key = (parent_key + "." if parent_key else "") + key(want)
                            c = dict(c, name=want, path=new_key)
                            state["tree"][new_key] = kids
                            state["tree"][parent_key] = [
                                c if key(x.get("path")) != old_key else c for x
                                in state["tree"].get(parent_key, [])]
                            break
                return {"ok": True, "text": json.dumps(
                    {"matchedPath": path, "applied": {"Name": True}, "failed": {}})}
            if name in ("set_properties", "move_instance", "execute_luau"):
                return {"ok": True, "text": json.dumps(
                    {"matchedPath": path, "applied": {"Position": True}, "failed": {},
                     "executed": True, "returned": {"className": "Model",
                                                   "fullName": path, "anchoredParts": 12,
                                                   "pivotX": position[0],
                                                   "pivotY": position[1],
                                                   "pivotZ": position[2]}})}
            return {"ok": False, "kind": "validation_error",
                    "error": "stubbed safe_call has no route for %s" % name,
                    "verification": {"checked": False}}

        bridge.safe_call = route
        return types.SimpleNamespace(route=route, state=state)


# ── 1. source validation ───────────────────────────────────────────────────

class SourceValidationTest(GraphIsolation):
    def test_accepted_spellings(self):
        for good, expect in ((123, ("asset", 123)),
                             ("123", ("asset", 123)),
                             ("rbxassetid://123", ("asset", 123)),
                             ("workspace/TemplateBuild", ("placePath", "workspace/TemplateBuild")),
                             ("  456  ", ("asset", 456))):
            self.assertEqual(bridge._import_source(good), expect, good)

    def test_malformed_and_non_numeric_ids_are_rejected(self):
        for bad in ("rbxassetid:/123", "rbxassetid//123", "rbxassetid://abc",
                    "rbxassetid://", "rbxassetid://12.5", "http://roblox/x",
                    "rbx://thing", "123abc", "12 34"):
            with self.subTest(source=bad):
                r = IMPORT({"source": bad})
                self.assertFalse(r["ok"])
                self.assertEqual(r["kind"], "validation_error")
                self.assertIn("source", r["error"])

    def test_non_positive_ids_are_rejected(self):
        for bad in (0, -5, "0", -1, 0.0, -2.5, 1.5, True, None, [], {}):
            with self.subTest(source=bad):
                r = IMPORT({"source": bad})
                self.assertFalse(r["ok"], bad)
                self.assertEqual(r["kind"], "validation_error", bad)
                self.assertIn("source", r["error"])

    def test_bare_name_is_ambiguous_not_guessed(self):
        r = IMPORT({"source": "TemplateBuild"})
        self.assertFalse(r["ok"])
        self.assertIn("ambiguous", r["error"])
        self.assertIn("workspace/TemplateBuild", r["error"])

    def test_at_is_parsed_and_malformed_at_is_rejected(self):
        self.assertEqual(bridge._parse_vec3("1,2,3", "at"), [1.0, 2.0, 3.0])
        self.assertEqual(bridge._parse_vec3([1, -2, "3.5"], "at"), [1.0, -2.0, 3.5])
        for bad in ("1,2", "1,2,3,4", "a,b,c", "", None, 5, "1,2,nan", "1,2,1e99"):
            with self.subTest(at=bad):
                r = IMPORT({"source": 123, "at": bad})
                self.assertFalse(r["ok"], bad)
                self.assertEqual(r["kind"], "validation_error", bad)
                self.assertIn("at", r["error"])

    def test_scale_and_rotate_ranges(self):
        self.assertEqual(bridge._parse_scale(None), 1.0)
        self.assertEqual(bridge._parse_scale("2.5"), 2.5)
        for bad in (0, 0.009, 100.1, 1e9, "big", None if False else "x"):
            with self.subTest(scale=bad):
                r = IMPORT({"source": 123, "scale": bad})
                self.assertFalse(r["ok"], bad)
                self.assertEqual(r["kind"], "validation_error", bad)
        for bad in (361, -361, 1e9, "spin"):
            with self.subTest(rotate=bad):
                r = IMPORT({"source": 123, "rotate": bad})
                self.assertFalse(r["ok"], bad)
                self.assertEqual(r["kind"], "validation_error", bad)
        # boundaries are accepted (rejection, not silent clamping)
        self.assertEqual(bridge._parse_scale(0.01), 0.01)
        self.assertEqual(bridge._parse_scale(100), 100.0)
        self.assertEqual(bridge._parse_rotate(-360), -360.0)
        self.assertEqual(bridge._parse_rotate(360), 360.0)

    def test_bad_mode_and_bad_name_are_rejected(self):
        r = IMPORT({"source": 123, "mode": "nope"})
        self.assertEqual(r["kind"], "validation_error")
        self.assertIn("mode", r["error"])
        for bad in ("", "   ", "a/b", "x" * 200, 5):
            with self.subTest(name=bad):
                r = IMPORT({"source": 123, "name": bad})
                self.assertFalse(r["ok"], bad)
                self.assertEqual(r["kind"], "validation_error", bad)

    def test_bad_parent_is_rejected_before_anything_runs(self):
        r = IMPORT({"source": 123, "parent": "workspace//Foo"})
        self.assertEqual(r["kind"], "validation_error")
        self.assertIn("empty segment", r["error"])


# ── 2. preflight / plan shape ──────────────────────────────────────────────

class PreflightTest(GraphIsolation):
    def test_plan_only_returns_a_plan_and_mutates_nothing(self):
        self.stub_plugin()   # even with a live plugin, plan_only must not act
        r = IMPORT({"source": 123, "at": "5,0,-5", "name": "Kit", "scale": 2,
                    "rotate": 90, "anchor": False, "plan_only": True})
        self.assertTrue(r["ok"], r)
        b = json.loads(r["text"])
        self.assertEqual(b["status"], "plan_only")
        self.assertFalse(b["plan"]["willMutate"])
        self.assertIs(b["imported"], False)
        self.assertIsNone(b["root"])
        self.assertIsNone(b["path"])
        self.assertIsNone(b["positioned"])
        self.assertIsNone(b["anchored"])
        self.assertIsNone(b["instanceCount"])
        self.assertFalse(b["verification"]["checked"])
        plan = b["plan"]
        self.assertEqual(plan["source"], {"kind": "asset", "assetId": 123})
        self.assertEqual(plan["at"], [5.0, 0.0, -5.0])
        self.assertEqual(plan["name"], "Kit")
        self.assertEqual(plan["mode"], "atomic")
        self.assertEqual(plan["steps"][0]["tool"], "import_asset")
        self.assertEqual(plan["steps"][0]["args"]["assetName"], "Kit")
        self.assertIn("never predicted", plan["steps"][1]["args"]["path"])
        self.assertFalse(os.path.exists(self.store),
                         "plan_only must not write the model graph")

    def test_plan_only_for_a_place_path_uses_clone_instance(self):
        self.stub_plugin()
        r = IMPORT({"source": "workspace/TemplateBuild", "parent": "workspace",
                    "plan_only": True})
        plan = json.loads(r["text"])["plan"]
        self.assertEqual(plan["source"], {"kind": "placePath", "path": "workspace/TemplateBuild"})
        self.assertEqual(plan["steps"][0]["tool"], "clone_instance")
        self.assertEqual(plan["steps"][0]["args"]["path"], "workspace/TemplateBuild")

    def test_existing_name_is_not_clobbered(self):
        self.stub_plugin(tree={"workspace": [{"name": "Kit", "class": "Model",
                                             "path": "workspace.Kit"}]})
        r = IMPORT({"source": 123, "name": "kit"})
        self.assertFalse(r["ok"])
        self.assertEqual(r["kind"], "validation_error")
        self.assertIn("already exists", r["error"])
        self.assertIn("does not clobber", r["error"])
        self.assertFalse(os.path.exists(self.store))

    def test_unresolvable_parent_is_an_honest_stop(self):
        self.stub_plugin(tree={})   # 'workspace' is NOT in the tree
        r = IMPORT({"source": 123})
        self.assertFalse(r["ok"])
        self.assertEqual(r["kind"], "execution_error")
        b = body_of(r)
        self.assertEqual(b["status"], "preflight_failed")
        self.assertIn("plan", b)             # the plan still came back
        self.assertIn("before mutating", b["detail"])
        assert_no_import_claimed(self, r, "unresolvable parent")


# ── 3. no plugin at all ────────────────────────────────────────────────────

class OfflineTest(GraphIsolation):
    def test_import_without_plugin_polling_fails_honestly(self):
        bridge.safe_call = self._save   # the REAL safe_call, no plugin polling
        r = IMPORT({"source": "rbxassetid://123"})
        self.assertIsInstance(r, dict)
        self.assertFalse(r["ok"], r)
        self.assertEqual(r["kind"], "plugin_offline", r.get("error"))
        assert_no_import_claimed(self, r, "plugin never polled")
        self.assertFalse(os.path.exists(self.store),
                         "a failed import must not be recorded")

    def test_import_step_offline_never_claims_success(self):
        # Parent resolves, but the import step itself is plugin_offline: this is
        # the path a fabricated 'imported' receipt would hide in.
        self.stub_plugin(tree={"workspace": []}, offline_tools=("import_asset",))
        r = IMPORT({"source": "rbxassetid://123"})
        self.assertFalse(r["ok"])
        assert_no_import_claimed(self, r, "import step offline")
        b = body_of(r)
        self.assertIsNotNone(b.get("failedStep"))
        self.assertEqual(b["failedStep"]["tool"], "import_asset")
        self.assertIn("plugin", b["failedStep"]["kind"])
        self.assertFalse(b["partialCommitAllowed"])

    def test_transform_step_offline_still_reports_the_import(self):
        self.stub_plugin(tree={"workspace": []}, offline_tools=("execute_luau",))
        r = IMPORT({"source": "rbxassetid://123"})
        self.assertFalse(r["ok"])
        b = body_of(r)
        # the import really landed (observed in the parent listing) - so saying
        # so is honest - but the placement claims must all stay unproven.
        self.assertIs(b["imported"], True)
        self.assertEqual(b["status"], "transform_failed")
        self.assertIs(b["transform"]["ok"], False)
        self.assertIsNone(b["positioned"])
        self.assertTrue(b["recorded"])
        self.assertIn("importId", b)
        assert_no_placement_claimed(self, r, "transform offline")
        raw = json.dumps(r, default=str).lower()
        self.assertNotIn('"positioned":true', raw)
        self.assertNotIn('"transformok":true', raw)

    def test_revise_offline_root_is_reported_missing_not_recreated(self):
        bridge.safe_call = self._save
        iid, _ = bridge._graph_append({
            "created": "2026-01-01T00:00:00+00:00", "sourceKey": "123",
            "source": {"kind": "asset", "assetId": 123}, "parent": "workspace",
            "path": "workspace.ImportedKit", "className": "Model",
            "instanceCount": 4, "revisions": []})
        r = REVISE({"importId": iid, "move": "1,2,3"})
        self.assertFalse(r["ok"])
        b = body_of(r)
        self.assertEqual(b["status"], "root_missing")
        self.assertFalse(b["applied"])
        self.assertIn("will NOT recreate", b["detail"])
        self.assertEqual(b["verification"]["rootExists"], False)


# ── 4. the store ───────────────────────────────────────────────────────────

class ModelGraphStoreTest(GraphIsolation):
    def test_empty_store_is_honest_not_a_fake_import(self):
        r = GRAPH({})
        self.assertTrue(r["ok"])
        b = json.loads(r["text"])
        self.assertEqual(b["count"], 0)
        self.assertEqual(b["imports"], [])          # no fake import entry
        self.assertEqual(b["returned"], 0)
        self.assertIn("empty graph", b["note"])
        self.assertFalse(b["truncated"])

    def test_ids_are_unique_stable_and_not_raw_timestamps(self):
        seen = set()
        for i in range(5):
            iid, err = bridge._graph_append({
                "created": "x", "sourceKey": "123", "source": {"kind": "asset", "assetId": 123},
                "parent": "workspace", "path": "workspace.Kit%d" % i, "className": "Model",
                "instanceCount": 1, "revisions": []})
            self.assertIsNone(err)
            self.assertTrue(iid.startswith("imp-"), iid)
            self.assertNotIn(iid, seen)
            seen.add(iid)
        self.assertEqual(len(seen), 5)
        # seq is monotonic and the digest is stable for the same input
        self.assertEqual(bridge._graph_import_id(7, "123", "workspace/Kit"),
                         bridge._graph_import_id(7, "123", "workspace/Kit"))
        self.assertNotEqual(bridge._graph_import_id(7, "123", "workspace/Kit"),
                            bridge._graph_import_id(7, "123", "workspace/Other"))

    def test_imports_are_capped_so_the_file_cannot_grow_forever(self):
        for i in range(bridge._MODEL_GRAPH_MAX_IMPORTS + 7):
            bridge._graph_append({"created": "x", "sourceKey": str(i),
                                  "source": {"kind": "asset", "assetId": i},
                                  "parent": "workspace", "path": "workspace.K%d" % i,
                                  "className": "Model", "instanceCount": 1, "revisions": []})
        data = bridge._model_graph_load()
        self.assertEqual(len(data["imports"]), bridge._MODEL_GRAPH_MAX_IMPORTS)
        self.assertEqual(data["seq"], bridge._MODEL_GRAPH_MAX_IMPORTS + 7)
        # the oldest fell off, the newest survived
        self.assertEqual(data["imports"][-1]["path"], "workspace.K%d" % (bridge._MODEL_GRAPH_MAX_IMPORTS + 6))

    def test_revisions_are_capped(self):
        iid, _ = bridge._graph_append({
            "created": "x", "sourceKey": "1", "source": {"kind": "asset", "assetId": 1},
            "parent": "workspace", "path": "workspace.Kit", "className": "Model",
            "instanceCount": 1, "revisions": []})
        for i in range(bridge._MODEL_GRAPH_MAX_REVISIONS + 4):
            self.assertIsNone(bridge._graph_append_revision(iid, {"rev": i, "at": "t"}))
        b = json.loads(GRAPH({"importId": iid})["text"])
        self.assertEqual(b["revisionsReturned"], bridge._MODEL_GRAPH_MAX_REVISIONS)
        # the cap is enforced AT WRITE time, so the store itself never holds more
        self.assertEqual(b["revisionCount"], bridge._MODEL_GRAPH_MAX_REVISIONS)
        self.assertFalse(b["revisionsCapped"])
        # what survives is the tail - the oldest fell off
        self.assertEqual(b["revisions"][-1]["rev"], bridge._MODEL_GRAPH_MAX_REVISIONS + 3)

    def test_corrupt_store_falls_back_to_empty_instead_of_crashing(self):
        os.makedirs(os.path.dirname(self.store), exist_ok=True)
        with open(self.store, "w", encoding="utf-8") as f:
            f.write("{not json at all")
        self.assertEqual(bridge._model_graph_load(),
                         {"version": 1, "seq": 0, "imports": []})
        r = GRAPH({})
        self.assertTrue(r["ok"])
        self.assertEqual(json.loads(r["text"])["count"], 0)

    def test_failed_write_keeps_the_previous_store_and_never_raises(self):
        iid, _ = bridge._graph_append({
            "created": "x", "sourceKey": "1", "source": {"kind": "asset", "assetId": 1},
            "parent": "workspace", "path": "workspace.Kit", "className": "Model",
            "instanceCount": 1, "revisions": []})
        with open(self.store, encoding="utf-8") as f:
            before = f.read()
        real_save = bridge._model_graph_save
        bridge._model_graph_save = lambda *a, **kw: (_ for _ in ()).throw(
            OSError("disk full"))
        try:
            got, err = bridge._graph_append({
                "created": "x", "sourceKey": "2",
                "source": {"kind": "asset", "assetId": 2}, "parent": "workspace",
                "path": "workspace.Kit2", "className": "Model", "instanceCount": 1,
                "revisions": []})
            self.assertIsNone(got)
            self.assertIn("disk full", err)
            rerr = bridge._graph_append_revision(iid, {"rev": 1, "at": "t"})
            self.assertIn("disk full", rerr)
        finally:
            bridge._model_graph_save = real_save
        with open(self.store, encoding="utf-8") as f:
            self.assertEqual(f.read(), before,
                             "a failed graph write must not damage the existing store")

    def test_store_lives_next_to_project_memory(self):
        # Same location/mechanism as get_memory/update_memory: a JSON file under
        # memory/, written through a .tmp sibling + os.replace.
        self.assertEqual(os.path.basename(bridge._model_graph_path()),
                         bridge._MODEL_GRAPH_FILE)
        self.assertEqual(os.path.dirname(bridge._model_graph_path()),
                         os.path.dirname(bridge._memory_path("default")))
        bridge._graph_append({"created": "x", "sourceKey": "1",
                              "source": {"kind": "asset", "assetId": 1},
                              "parent": "workspace", "path": "workspace.Kit",
                              "className": "Model", "instanceCount": 1, "revisions": []})
        self.assertFalse(os.path.exists(bridge._model_graph_path() + ".tmp"))
        with open(self.store, encoding="utf-8") as f:
            self.assertEqual(json.load(f)["imports"][0]["path"], "workspace.Kit")

    def test_unknown_import_id_is_a_validation_error_naming_known_ids(self):
        iid, _ = bridge._graph_append({
            "created": "x", "sourceKey": "1", "source": {"kind": "asset", "assetId": 1},
            "parent": "workspace", "path": "workspace.Kit", "className": "Model",
            "instanceCount": 1, "revisions": []})
        r = REVISE({"importId": "imp-0000-deadbe", "move": "1,1,1"})
        self.assertFalse(r["ok"])
        self.assertEqual(r["kind"], "validation_error")
        self.assertIn("unknown importId", r["error"])
        self.assertIn(iid, r["error"])          # names the known ids
        g = GRAPH({"importId": "imp-0000-deadbe"})
        self.assertEqual(g["kind"], "validation_error")
        self.assertIn("known ids", g["error"])
        self.assertIn(iid, g["error"])

    def test_missing_import_id_is_a_validation_error(self):
        for bad in (None, "", "   ", 5):
            r = REVISE({"importId": bad, "move": "1,1,1"})
            self.assertEqual(r["kind"], "validation_error", bad)

    def test_known_id_list_is_capped(self):
        for i in range(30):
            bridge._graph_append({"created": "x", "sourceKey": str(i),
                                  "source": {"kind": "asset", "assetId": i},
                                  "parent": "workspace", "path": "workspace.K%d" % i,
                                  "className": "Model", "instanceCount": 1, "revisions": []})
        self.assertLessEqual(len(bridge._known_import_ids()), 10)

    def test_get_model_graph_limits_its_answer(self):
        for i in range(12):
            bridge._graph_append({"created": "x", "sourceKey": str(i),
                                  "source": {"kind": "asset", "assetId": i},
                                  "parent": "workspace", "path": "workspace.K%d" % i,
                                  "className": "Model", "instanceCount": 1, "revisions": []})
        b = json.loads(GRAPH({"limit": 3})["text"])
        self.assertEqual(b["returned"], 3)
        self.assertTrue(b["truncated"])
        self.assertEqual(b["count"], 12)
        self.assertEqual(json.loads(GRAPH({"limit": 999})["text"])["limit"],
                         bridge._MODEL_GRAPH_MAX_IMPORTS)
        # newest first
        self.assertEqual(b["imports"][0]["path"], "workspace.K11")
        self.assertIn("read-only", b["note"])


# ── 5. the pipeline, against a scripted Studio ─────────────────────────────

class PipelineTest(GraphIsolation):
    """Wiring test: every field must equal what the scripted plugin was asked
    for and answered - nothing is invented here either.

    The tree starts with an EMPTY workspace: the scripted import_asset is what
    adds the kit, exactly like the real branch."""

    def test_successful_import_is_verified_then_recorded(self):
        stub = self.stub_plugin(tree={"workspace": []})
        r = IMPORT({"source": "rbxassetid://123", "name": "ImportedKit",
                    "at": "0,0,0", "scale": 1, "rotate": 0, "anchor": True})
        self.assertTrue(r["ok"], r)
        b = json.loads(r["text"])
        self.assertEqual(b["status"], "success")
        self.assertIs(b["imported"], True)
        self.assertEqual(b["path"], "workspace.ImportedKit")
        self.assertEqual(b["className"], "Model")
        self.assertEqual(b["instanceCount"], 1)
        self.assertIn("direct children", b["instanceCountScope"])
        self.assertTrue(b["verification"]["checked"])
        self.assertTrue(b["verification"]["passed"])
        self.assertIn("importId", b)
        self.assertTrue(b["recorded"])
        # scriptsStripped comes from the plugin branch, not from us
        self.assertIs(b["scriptsStripped"], True)
        self.assertEqual(b["removedScripts"], 3)
        # the import really went through import_asset, then the transform
        tools = [c[0] for c in stub.state["calls"]]
        self.assertIn("import_asset", tools)
        self.assertIn("get_instances", tools)
        self.assertIn("get_property_value", tools)
        self.assertEqual([str(c[1]["assetId"]) for c in stub.state["calls"]
                          if c[0] == "import_asset"], ["123"])
        # the graph now holds exactly what was observed
        g = json.loads(GRAPH({})["text"])
        self.assertEqual(g["count"], 1)
        self.assertEqual(g["imports"][0]["path"], "workspace.ImportedKit")
        self.assertEqual(g["imports"][0]["instanceCount"], 1)

    def test_positional_value_comes_from_a_read_not_an_assumption(self):
        # root is a Model -> no Position property, so the pivot read-back decides
        self.stub_plugin(tree={"workspace": []}, position=(9.0, 0.0, 0.0))
        r = IMPORT({"source": 123, "at": "0,0,0"})
        self.assertFalse(r["ok"], "a read-back that disagrees must not be success")
        b = body_of(r)
        self.assertIs(b["imported"], True)      # the kit IS there - that was observed
        self.assertIs(b["positioned"], False)
        self.assertIn("NOT at the requested position", b["positionNote"])
        self.assertFalse(b["verification"]["passed"])
        self.assertEqual(b["status"], "placed_unverified")
        self.assertEqual(b["observedPosition"], [9.0, 0.0, 0.0])
        assert_no_placement_claimed(self, r, "pivot read-back disagreed")

    def test_basepart_root_is_positioned_from_a_real_property_read(self):
        self.stub_plugin(tree={"workspace": [{"name": "ImportedKit", "class": "MeshPart",
                                               "path": "workspace.importedkit"}],
                               "workspace.importedkit": []},
                         position=(4.0, 5.0, 6.0), import_result={
                             "ok": True, "text": json.dumps(
                                 {"imported": True, "assetId": 123,
                                  "path": "workspace.importedkit", "className": "MeshPart"})})
        r = IMPORT({"source": 123, "at": "4,5,6"})
        b = json.loads(r["text"])
        self.assertEqual(b["className"], "MeshPart")
        self.assertIs(b["positioned"], True)
        self.assertEqual(b["observedPosition"], [4.0, 5.0, 6.0])
        self.assertEqual(b["transform"]["commands"], ["set_properties"])

    def test_unanchored_parts_report_anchored_false(self):
        self.stub_plugin(tree={"workspace": []}, anchored=False)
        r = IMPORT({"source": 123, "anchor": True})
        self.assertFalse(r["ok"])
        b = body_of(r)
        self.assertIs(b["anchored"], False)
        self.assertEqual(b["anchoredObservation"]["checked"], 1)
        self.assertEqual(b["anchoredObservation"]["anchoredSeen"], 0)
        self.assertIn("not anchored", b["anchoredObservation"]["note"])
        self.assertFalse(b["verification"]["passed"])
        self.assertEqual(b["status"], "placed_unverified")
        # anchoring was the only thing that failed; the pivot read-back did pass
        assert_no_placement_claimed(self, r, "parts unanchored")
        self.assertIs(b["positioned"], True)

    def test_unmeasurable_anchoring_is_null_not_assumed(self):
        # The kit lands as a Model with no BasePart directly under it, so the
        # anchoring question cannot be answered here - it must be null.
        self.stub_plugin(tree={"workspace": [
                                  {"name": "ImportedKit", "class": "Model",
                                   "path": "workspace.ImportedKit"}],
                               # a Model whose direct children hold no BasePart
                               "workspace.ImportedKit": [
                                   {"name": "Walls", "class": "Folder",
                                    "path": "workspace.ImportedKit.Walls"}]},
                         import_result={"ok": True, "text": json.dumps(
                             {"imported": True, "assetId": 123,
                              "path": "workspace.ImportedKit", "className": "Model",
                              "scriptsStripped": False, "removedScripts": 0})})
        b = body_of(IMPORT({"source": 123, "anchor": True}))
        self.assertIsNone(b["anchored"])
        self.assertIn("no BasePart", b["anchoredObservation"]["note"])
        self.assertEqual(b["anchoredObservation"]["checked"], 0)
        assert_no_placement_claimed(self, IMPORT({"source": 123, "anchor": True}),
                                    "anchoring not measurable", unverified=("anchored",))

    def test_root_that_never_appears_is_never_called_success(self):
        # import_asset claims success but the root is NOT in the parent listing
        self.stub_plugin(tree={"workspace": []},
                         import_result={"ok": True, "text": json.dumps(
                             {"imported": True, "assetId": 123,
                              "path": "workspace.Ghost", "className": "Model"})})
        r = IMPORT({"source": 123})
        self.assertFalse(r["ok"])
        # the path is what the PLUGIN reported, so echoing it is honest as long
        # as every claim around it says unverified
        assert_no_import_claimed(self, r, "root never appeared", root_allowed=True)
        b = body_of(r)
        self.assertEqual(b["status"], "import_unverified")
        self.assertIs(b["imported"], False)
        self.assertIsNone(b["positioned"])
        self.assertIsNone(b["anchored"])
        self.assertIsNone(b["instanceCount"])
        self.assertFalse(b["recorded"])
        self.assertIn("no new child", b["verification"]["detail"])
        self.assertFalse(os.path.exists(self.store))

    def test_missing_root_path_in_a_success_reply_is_not_treated_as_success(self):
        self.stub_plugin(tree={"workspace": []}, import_result={"ok": True, "text": json.dumps(
            {"imported": True, "assetId": 123})})
        r = IMPORT({"source": 123})
        self.assertFalse(r["ok"])
        assert_no_import_claimed(self, r, "success reply with no path")

    def test_model_transform_goes_through_execute_luau_not_a_fake_property(self):
        self.stub_plugin(tree={"workspace": []}, position=(1.0, 2.0, 3.0))
        r = IMPORT({"source": 123, "at": "1,2,3", "rotate": 45})
        self.assertTrue(r["ok"], r)
        b = json.loads(r["text"])
        self.assertEqual(b["transform"]["commands"], ["execute_luau"])
        seen = [row for ev in b["evidence"] for row in (ev.get("evidence") or [])
                if row.get("tool") == "execute_luau"]
        self.assertEqual(len(seen), 1)
        self.assertTrue(b["transform"]["ok"])

    def test_folder_root_reports_it_has_no_pivot_instead_of_pretending(self):
        self.stub_plugin(tree={"workspace": [{"name": "ImportedKit", "class": "Folder",
                                               "path": "workspace.importedkit"}],
                               "workspace.importedkit": []},
                         import_result={"ok": True, "text": json.dumps(
                             {"imported": True, "assetId": 123,
                              "path": "workspace.importedkit", "className": "Folder"})})
        r = IMPORT({"source": 123, "at": "1,2,3"})
        b = body_of(r)
        self.assertEqual(b["className"], "Folder")
        self.assertEqual(b["transform"]["commands"], [])
        self.assertIn("no pivot", b["transformSkipped"])
        self.assertIsNone(b["positioned"])
        assert_no_placement_claimed(self, r, "folder root has no pivot")

    def test_generated_pivot_snippet_compiles_and_escapes_names(self):
        code, err = bridge._model_transform_luau(
            'workspace.Kit "quoted"/Sub', at=[1, 2, 3], rotate=90, anchor=True, scale=2)
        self.assertIsNone(err)
        self.assertIsNone(bridge._luau_preflight(code),
                          "generated snippet must pass the bridge's own Luau pre-flight")
        self.assertIn('t:WaitForChild("Kit \\"quoted\\"")', code)
        self.assertIn("t:PivotTo(", code)
        self.assertIn("d.Anchored = true", code)
        self.assertNotIn('WaitForChild("Kit "quoted"")', code)

    def test_rename_only_revision_skips_the_pivot_pass(self):
        iid, _ = bridge._graph_append({
            "created": "x", "sourceKey": "123", "source": {"kind": "asset", "assetId": 123},
            "parent": "workspace", "path": "workspace.ImportedKit", "className": "Model",
            "instanceCount": 1, "revisions": []})
        self.stub_plugin(tree={"workspace": [{"name": "ImportedKit", "class": "Model",
                                               "path": "workspace.importedkit"}],
                               "workspace.importedkit": [{"name": "Baseplate",
                                                         "class": "Part",
                                                         "path": "workspace.importedkit.Baseplate"}],
                               "workspace.importedkit.baseplate": []})
        r = REVISE({"importId": iid, "rename": "Kit2"})
        self.assertTrue(r["ok"], r)
        b = json.loads(r["text"])
        self.assertEqual(b["status"], "success")
        self.assertTrue(b["applied"])
        self.assertEqual(b["rev"], 1)
        self.assertEqual(b["changes"], {"rename": "Kit2"})
        self.assertTrue(b["verification"]["rootExists"])
        self.assertTrue(b["recorded"])
        g = json.loads(GRAPH({"importId": iid})["text"])
        self.assertEqual(g["revisionCount"], 1)
        self.assertEqual(g["revisions"][0]["changes"], {"rename": "Kit2"})
        self.assertIn("rev", g["revisions"][0])
        self.assertIn("at", g["revisions"][0])

    def test_revision_with_nothing_to_do_is_rejected(self):
        iid, _ = bridge._graph_append({
            "created": "x", "sourceKey": "1", "source": {"kind": "asset", "assetId": 1},
            "parent": "workspace", "path": "workspace.ImportedKit", "className": "Model",
            "instanceCount": 1, "revisions": []})
        r = REVISE({"importId": iid})
        self.assertFalse(r["ok"])
        self.assertEqual(r["kind"], "validation_error")
        self.assertIn("nothing to revise", r["error"])

    def test_revision_validates_its_deltas(self):
        iid, _ = bridge._graph_append({
            "created": "x", "sourceKey": "1", "source": {"kind": "asset", "assetId": 1},
            "parent": "workspace", "path": "workspace.ImportedKit", "className": "Model",
            "instanceCount": 1, "revisions": []})
        for args, needle in (({"move": "1,2"}, "move"),
                             ({"scale": 900}, "scale"),
                             ({"rotate": -900}, "rotate"),
                             ({"rename": "a/b"}, "rename"),
                             ({"mode": "weird"}, "mode"),
                             ({"anchor": "maybe"}, "anchor")):
            with self.subTest(args=args):
                r = REVISE(dict(args, importId=iid))
                self.assertFalse(r["ok"], args)
                self.assertEqual(r["kind"], "validation_error", args)
                self.assertIn(needle.split(".")[0], r["error"])

    def test_failed_revision_is_not_recorded(self):
        iid, _ = bridge._graph_append({
            "created": "x", "sourceKey": "1", "source": {"kind": "asset", "assetId": 1},
            "parent": "workspace", "path": "workspace.ImportedKit", "className": "Model",
            "instanceCount": 1, "revisions": []})
        self.stub_plugin(tree={"workspace": [
                                  {"name": "ImportedKit", "class": "Model",
                                   "path": "workspace.ImportedKit"}],
                               "workspace.ImportedKit": []},
                         offline_tools=("set_properties", "execute_luau"))
        r = REVISE({"importId": iid, "rename": "Kit2"})
        self.assertFalse(r["ok"])
        # the root WAS read and confirmed, so reporting it is honest - but the
        # revision itself must claim nothing.
        assert_no_import_claimed(self, r, "revision batch offline", root_allowed=True)
        self.assertEqual(json.loads(GRAPH({"importId": iid})["text"])["revisionCount"], 0)


# ── 6. registration / dispatch ──────────────────────────────────────────────

class RegistrationTest(GraphIsolation):
    def test_all_three_are_registered_and_local(self):
        for name, fn in (("import_distinctus_build", bridge._local_import_distinctus_build),
                         ("revise_import", bridge._local_revise_import),
                         ("get_model_graph", bridge._local_get_model_graph)):
            self.assertIn(name, bridge.LOCAL_HANDLERS)
            self.assertIs(bridge.LOCAL_HANDLERS[name], fn)
            # local handlers must never be re-routed to the Studio queue
            self.assertNotIn(name, bridge.STUDIO_QUEUE_TOOLS)
            self.assertIn(name, bridge._LOCAL_EXTRA_DESC)

    def test_safe_call_answers_all_three_without_studio(self):
        for name, args in (("get_model_graph", {}),
                           ("import_distinctus_build", {"source": 1}),
                           ("revise_import", {"importId": "nope"})):
            res = bridge.safe_call(name, args, 5)
            self.assertIsInstance(res, dict, name)
            self.assertIn("ok", res, name)

    def test_every_handler_never_raises_on_hostile_arguments(self):
        for name, fn in (("import_distinctus_build", IMPORT),
                         ("revise_import", REVISE),
                         ("get_model_graph", GRAPH)):
            for args in (None, {}, {"source": {"a": 1}}, {"importId": ["x"]},
                         {"source": 1, "at": [None, 2, 3]},
                         {"source": 1, "anchor": object()},
                         {"limit": "abc"}, {"importId": 1e400 if False else "x" * 500}):
                res = fn(args)
                self.assertIsInstance(res, dict, (name, args))
                self.assertIn("ok", res, (name, args))
                self.assertIsInstance(res.get("ok"), bool, (name, args))


if __name__ == "__main__":
    unittest.main(verbosity=1)