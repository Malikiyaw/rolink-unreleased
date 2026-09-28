# tests/test_animation_collision.py - Phase 5 interpenetration pins.
#   py -3 tests/test_animation_collision.py
# Task 5.7: interpenetration on known-bad poses, joint-aware filtering, and
# the <5% false-positive bar on intentional connections (parent/child and
# joint-endpoint overlaps must never report).
import io
import json
import os
import shutil
import subprocess
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


def read(*parts):
    with io.open(os.path.join(ROOT, *parts), encoding="utf-8", errors="replace") as f:
        return f.read()


TS_COLLISION = read("mcp-server", "src", "animation", "collision.ts")
LUAU_COLLISION = read("studio-plugin", "animation", "Collision.lua")
PLUGIN = read("studio-plugin", "RoLink.lua")


def node_anim(snippet):
    node = shutil.which("node")
    if not node:
        raise unittest.SkipTest("node not on PATH")
    tsx = os.path.join(ROOT, "mcp-server", "node_modules", "tsx", "dist", "cli.mjs")
    if not os.path.exists(tsx):
        raise unittest.SkipTest("tsx not installed (run npm ci in mcp-server/)")
    code = ("import('./src/animation/collision.ts').then(async (c) => {"
            " const j = await import('./src/animation/jointAdapter.ts');"
            " console.log(JSON.stringify(" + snippet + ")); })")
    r = subprocess.run([node, tsx, "-e", code],
                       cwd=os.path.join(ROOT, "mcp-server"),
                       capture_output=True, text=True, timeout=180)
    if r.returncode != 0:
        raise AssertionError("tsx eval failed: " + r.stderr[-2000:])
    return json.loads(r.stdout.strip().splitlines()[-1])


def vol(name, x, y=0, z=0, h=0.5):
    return {"name": name, "center": {"x": x, "y": y, "z": z},
            "half": {"x": h, "y": h, "z": h}}


class KnownBadPoseTest(unittest.TestCase):
    def test_hand_inside_torso_detected(self):
        res = node_anim("""(() => {
          const s = [{t: 0, volumes: [
            {name: "Torso", center: {x: 0, y: 0, z: 0}, half: {x: 1, y: 1, z: 1}},
            {name: "Hand", center: {x: 0.2, y: 0, z: 0}, half: {x: 0.5, y: 0.5, z: 0.5}},
          ]}];
          return c.detectSelfIntersection(s, new Set()).map((i) => i.code);
        })()""")
        self.assertEqual(res, ["SELF_INTERSECTION"], res)

    def test_foot_through_floor_detected(self):
        res = node_anim("""(() => {
          const s = [{t: 0.3, volumes: [
            {name: "Foot", center: {x: 0, y: 0.1, z: 0}, half: {x: 0.5, y: 0.5, z: 0.5}},
          ]}];
          const out = c.detectFloorPenetration(s, 0, ["Foot"]);
          return {codes: out.map((i) => i.code), depth: out[0] && out[0].measured};
        })()""")
        self.assertEqual(res["codes"], ["GROUND_PENETRATION"], res)
        self.assertAlmostEqual(res["depth"], 0.4, places=9)

    def test_impossible_stretch_detected(self):
        res = node_anim("""(() => {
          const s = [{t: 1, positions: {A: {x: 0, y: 0, z: 0}, B: {x: 0, y: -3, z: 0}}}];
          return c.detectDeformation(s, [{a: "A", b: "B", restStud: 2}]).map((i) => i.code);
        })()""")
        self.assertEqual(res, ["EXCESSIVE_STRETCH"], res)


class IntentionalConnectionFilterTest(unittest.TestCase):
    """Exit criterion: <5% false positives on intentional connections."""

    def test_spaced_chain_reports_nothing(self):
        # Six volumes on a limb-like chain (consecutive pairs overlap by
        # construction) plus a small hand on the chest (endpoint-linked):
        # every overlap is intentional, so nothing may report.
        res = node_anim("""(() => {
          const names = ["Root", "Spine", "Chest", "Neck", "Head", "Hand"];
          const bindings = names.map((n, i) => ({
            name: n, path: "Workspace/M/" + n,
            className: i === 0 ? "Model" : "Part",
            kind: "Rigid", legacyKind: i === 0 ? "root" : "rigid",
            semanticRole: "unknown",
            ...(i > 0 ? {parent: names[i - 1]} : {}),
            children: [], rest: {position: {x: 0, y: 0, z: 0},
              rotation: {w: 1, x: 0, y: 0, z: 0}},
            drive: {writable: true, channels: ["PartCFrame"], reason: "t"},
            notes: [],
          }));
          const adj = c.buildAdjacency(bindings, [["Chest", "Hand"]]);
          const at = (y, h) => ({center: {x: 0, y, z: 0}, half: {x: h, y: h, z: h}});
          const vols = [
            {name: "Root", ...at(0, 0.7)}, {name: "Spine", ...at(-1.2, 0.7)},
            {name: "Chest", ...at(-2.4, 0.7)}, {name: "Neck", ...at(-3.6, 0.7)},
            {name: "Head", ...at(-4.8, 0.7)}, {name: "Hand", ...at(-2.4, 0.3)},
          ];
          const totalPairs = vols.length * (vols.length - 1) / 2;
          const issues = c.detectSelfIntersection([{t: 0, volumes: vols}], adj);
          return {totalPairs, reported: issues.length,
                  reportedPairs: issues.map((i) => i.message)};
        })()""")
        self.assertEqual(res["totalPairs"], 15, res)
        fp_rate = res["reported"] / res["totalPairs"]
        self.assertLess(fp_rate, 0.05, res)
        self.assertEqual(res["reported"], 0, res)

    def test_filter_never_reports_adjacent_pairs(self):
        # Degenerate worst case: all volumes coincide, so every non-filtered
        # pair fires — but no reported pair may be an intentional connection.
        res = node_anim("""(() => {
          const names = ["Root", "Spine", "Chest", "Neck", "Head", "Hand"];
          const bindings = names.map((n, i) => ({
            name: n, path: "Workspace/M/" + n,
            className: i === 0 ? "Model" : "Part",
            kind: "Rigid", legacyKind: i === 0 ? "root" : "rigid",
            semanticRole: "unknown",
            ...(i > 0 ? {parent: names[i - 1]} : {}),
            children: [], rest: {position: {x: 0, y: 0, z: 0},
              rotation: {w: 1, x: 0, y: 0, z: 0}},
            drive: {writable: true, channels: ["PartCFrame"], reason: "t"},
            notes: [],
          }));
          const adj = c.buildAdjacency(bindings, [["Chest", "Hand"]]);
          const vols = names.map((n) => (
            {name: n, center: {x: 0, y: 0, z: 0}, half: {x: 1, y: 1, z: 1}}));
          const issues = c.detectSelfIntersection([{t: 0, volumes: vols}], adj);
          const hits = c.scanSampleOverlaps({t: 0, volumes: vols}, adj);
          const adjList = [...adj];
          return {reported: issues.length, adjSize: adjList.length,
                  pairs: hits.map((h) => [h.a, h.b].sort().join("|")),
                  adjList};
        })()""")
        self.assertEqual(res["adjSize"], 6, res)
        self.assertGreater(res["reported"], 0, res)
        self.assertLess(res["reported"] / 15.0, 0.7, res)
        for pair in res["pairs"]:
            self.assertNotIn(pair, res["adjList"],
                             "intentional connection reported: " + pair)


class CollisionSurfaceTest(unittest.TestCase):
    def test_ts_surface(self):
        for token in ("buildAdjacency", "aabbOverlap", "scanSampleOverlaps",
                      "detectSelfIntersection", "detectFloorPenetration",
                      "detectDeformation", "BodyVolume", "VolumeSample",
                      "GROUND_PENETRATION", "SELF_INTERSECTION",
                      "EXCESSIVE_STRETCH", "EXCESSIVE_COMPRESSION"):
            self.assertIn(token, TS_COLLISION, token)

    def test_luau_surface(self):
        for fn in ("pairKey", "partVolumes", "aabbOverlap", "adjacentPairs",
                   "scan", "measureDeformation"):
            self.assertIn("function Collision." + fn, LUAU_COLLISION, "Collision." + fn)
            self.assertIn("function Collision." + fn, PLUGIN, "inline Collision." + fn)
        self.assertEqual(PLUGIN.count("--[[COLLISION_BEGIN"), 1)
        self.assertEqual(PLUGIN.count("--[[COLLISION_END]]"), 1)

    def test_no_new_tool_branches(self):
        lines = [ln for ln in PLUGIN.splitlines() if "Collision" in ln]
        self.assertFalse(any('tool=="Collision"' in ln for ln in lines))


if __name__ == "__main__":
    unittest.main()
