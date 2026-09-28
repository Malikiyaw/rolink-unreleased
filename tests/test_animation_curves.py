# tests/test_animation_curves.py - Phase 3 curve/bake regression suite.
#   py -3 tests/test_animation_curves.py
# Task 3.6: curve continuity, arc shape correctness, in-between density.
#
# Static pins keep the TS/Luau easing tables and module surfaces aligned;
# behavioral checks execute the REAL TS curve solver via node+tsx and
# SKIP (not fail) when that toolchain is absent.
import io
import json
import math
import os
import re
import shutil
import subprocess
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


def read(*parts):
    with io.open(os.path.join(ROOT, *parts), encoding="utf-8", errors="replace") as f:
        return f.read()


TS_CURVES = read("mcp-server", "src", "animation", "curves.ts")
TS_POSE = read("mcp-server", "src", "animation", "pose.ts")
TS_INBETWEEN = read("mcp-server", "src", "animation", "inbetween.ts")
LUAU_CURVES = read("studio-plugin", "animation", "Curves.lua")
LUAU_POSE = read("studio-plugin", "animation", "PoseSolver.lua")
PLUGIN = read("studio-plugin", "RoLink.lua")

EASINGS = ["linear", "quadIn", "quadOut", "quadInOut", "cubicIn", "cubicOut",
           "cubicInOut", "sineIn", "sineOut", "sineInOut", "bezierOut", "springOut"]


def node_json(snippet):
    node = shutil.which("node")
    if not node:
        raise unittest.SkipTest("node not on PATH")
    tsx = os.path.join(ROOT, "mcp-server", "node_modules", "tsx", "dist", "cli.mjs")
    if not os.path.exists(tsx):
        raise unittest.SkipTest("tsx not installed (run npm ci in mcp-server/)")
    code = ("import('./src/animation/curves.ts').then(async (c) => {"
            " const ib = await import('./src/animation/inbetween.ts');"
            " const p = await import('./src/animation/pose.ts');"
            " const q = await import('./src/animation/quaternion.ts');"
            " const j = await import('./src/animation/jointAdapter.ts');"
            " const s = await import('./src/animation/semanticRig.ts');"
            " console.log(JSON.stringify(" + snippet + ")); })")
    r = subprocess.run([node, tsx, "-e", code],
                       cwd=os.path.join(ROOT, "mcp-server"),
                       capture_output=True, text=True, timeout=180)
    if r.returncode != 0:
        raise AssertionError("tsx eval failed: " + r.stderr[-2000:])
    return json.loads(r.stdout.strip().splitlines()[-1])


PLAN_JS = """{
  goal: "strike", target: "Workspace/NPC", style: "ANIME", duration: 1.2,
  beats: [
    {kind: "ANTICIPATION", start: 0, duration: 0.3, importance: 1},
    {kind: "PRIMARY_ACTION", start: 0.3, duration: 0.4, importance: 1},
    {kind: "IMPACT", start: 0.7, duration: 0.2, importance: 1},
    {kind: "SETTLE", start: 0.9, duration: 0.3, importance: 0.5},
  ],
}"""

RIG_JS = """[
  {path: "Workspace.NPC", name: "NPC", class: "Model", kind: "root", depth: 0},
  {path: "Workspace.NPC.HumanoidRootPart", name: "HumanoidRootPart", class: "Part", kind: "rigid", depth: 1},
  {path: "Workspace.NPC.Torso", name: "Torso", class: "Part", kind: "rigid", depth: 1},
  {path: "Workspace.NPC.UpperTorso", name: "UpperTorso", class: "MeshPart", kind: "rigid", depth: 1},
  {path: "Workspace.NPC.Head", name: "Head", class: "Part", kind: "rigid", depth: 1},
  {path: "Workspace.NPC.UpperTorso.Neck", name: "Neck", class: "Motor6D", kind: "rotational", depth: 2},
  {path: "Workspace.NPC.LeftUpperArm", name: "LeftUpperArm", class: "MeshPart", kind: "rigid", depth: 1},
  {path: "Workspace.NPC.UpperTorso.LeftShoulder", name: "LeftShoulder", class: "Motor6D", kind: "rotational", depth: 2},
  {path: "Workspace.NPC.LeftHand", name: "LeftHand", class: "MeshPart", kind: "rigid", depth: 1},
  {path: "Workspace.NPC.RightHand", name: "RightHand", class: "MeshPart", kind: "rigid", depth: 1},
]"""


class CurveContinuityTest(unittest.TestCase):
    """Task 3.6: baked motion is smooth, dense, and gimbal-free."""

    def test_full_pipeline_continuity(self):
        res = node_json("""(() => {
          const bindings = j.adaptersFromAnalyzeNodes(%s);
          const skel = s.buildSemanticSkeleton(bindings);
          const tracks = p.generateSparsePoses(bindings, skel, %s, {seed: 11});
          const out = tracks.map((t) => {
            const dense = c.bakeTrackDense(
              {joint: t.joint, jointKind: t.jointKind, semanticRole: t.semanticRole, keys: t.keys},
              {fps: 30});
            let lo = Infinity, hi = -Infinity, bad = 0;
            for (const k of dense.keys) {
              const r = k.pose.rotation;
              if (![r.w, r.x, r.y, r.z].every(Number.isFinite)) bad += 1;
              for (const v of [k.pose.position.x, k.pose.position.y, k.pose.position.z]) {
                if (!Number.isFinite(v)) bad += 1;
              }
            }
            for (let i = 1; i < dense.keys.length; i += 1) {
              const a = dense.keys[i - 1].pose.rotation, b = dense.keys[i].pose.rotation;
              const dot = Math.abs(a.w*b.w + a.x*b.x + a.y*b.y + a.z*b.z);
              const step = 2 * Math.acos(Math.min(1, dot)) * 180 / Math.PI;
              lo = Math.min(lo, step); hi = Math.max(hi, step);
            }
            return {joint: t.joint, sparse: t.keys.length,
                    baked: dense.keys.length, maxStep: hi, bad};
          });
          return out;
        })()""" % (RIG_JS, PLAN_JS))
        self.assertGreater(len(res), 3, res)
        for row in res:
            self.assertGreater(row["sparse"], 1, row)
            self.assertGreater(row["baked"], row["sparse"], row)
            self.assertEqual(row["bad"], 0, row)
            # No pops: springOut legitimately peaks ~5x mean slope (same
            # formula in-Studio), so the cap is anti-pop, not a speed limit
            # (speed limits are Phase 5 style thresholds).
            self.assertLess(row["maxStep"], 25.0, row)

    def test_baked_quats_stay_normalized(self):
        res = node_json("""(() => {
          const bindings = j.adaptersFromAnalyzeNodes(%s);
          const skel = s.buildSemanticSkeleton(bindings);
          const tracks = p.generateSparsePoses(bindings, skel, %s, {seed: 5});
          let worst = 0;
          for (const t of tracks) {
            const dense = c.bakeTrackDense(
              {joint: t.joint, jointKind: t.jointKind, semanticRole: t.semanticRole, keys: t.keys},
              {fps: 30});
            for (const k of dense.keys) {
              const q = k.pose.rotation;
              worst = Math.max(worst, Math.abs(Math.hypot(q.w, q.x, q.y, q.z) - 1));
            }
          }
          return {worst};
        })()""" % (RIG_JS, PLAN_JS))
        self.assertLess(res["worst"], 1e-6, res)

    def test_densify_then_bake_density(self):
        res = node_json("""(() => {
          const mk = (t, deg) => ({t, pose: {joint: "A",
            position: {x: 0, y: 0, z: 0},
            rotation: q.eulerDegToQuat({x: deg, y: 0, z: 0}),
            semanticRole: "limb"}, easing: "quadInOut", interpolation: "slerp"});
          const sparse = [mk(0, 0), mk(1, 120)];
          const d = ib.densifyKeys(sparse, {maxGapSec: 0.2, maxAngleDeg: 30, maxMoveStud: 99});
          const baked = c.bakeTrackDense(
            {joint: "A", jointKind: "Motor6D", semanticRole: "limb", keys: d.keys}, {fps: 30});
          return {inserted: d.report.inserted, longest: d.report.longestGapSec,
                  baked: baked.keys.length, maxStep: c.maxBakedAngleStep(baked.keys)};
        })()""")
        self.assertGreater(res["inserted"], 0, res)
        self.assertLessEqual(res["longest"], 0.2 + 1e-9, res)
        self.assertGreater(res["baked"], 10, res)
        self.assertLessEqual(res["maxStep"], 30 + 1e-6, res)


class ArcShapeTest(unittest.TestCase):
    """Task 3.6: arcs apex correctly and ground at both ends."""

    def test_arc_apex_and_endpoints(self):
        res = node_json("""(() => {
          const arc = c.resolveArc({direction: {x: 0, y: 1, z: 0}, arcHeight: 2, peakTiming: 0.5});
          const lift = (t) => 2 * c.arcLiftFactor(t, arc.peak);
          let apex = 0, apexT = 0;
          for (let i = 0; i <= 40; i += 1) {
            const v = lift(i / 40);
            if (v > apex) { apex = v; apexT = i / 40; }
          }
          return {peak: arc.peak, lift0: lift(0), lift1: lift(1),
                  apex, apexT, biased: c.resolveArc(
                    {direction: {x: 0, y: 1, z: 0}, arcHeight: 1,
                     peakTiming: 0.5, arcBias: 1}).peak};
        })()""")
        self.assertAlmostEqual(res["peak"], 0.5, places=9)
        self.assertAlmostEqual(res["lift0"], 0.0, places=9)
        self.assertAlmostEqual(res["lift1"], 0.0, places=9)
        self.assertAlmostEqual(res["apex"], 2.0, places=6)
        self.assertAlmostEqual(res["apexT"], 0.5, places=2)
        self.assertAlmostEqual(res["biased"], 0.75, places=9)


class InbetweenDensityTest(unittest.TestCase):
    """Task 3.6: densify inserts where needed, prunes where safe."""

    def test_prune_keeps_extremes(self):
        res = node_json("""(() => {
          const mk = (t, deg, easing) => ({t, pose: {joint: "A",
            position: {x: 0, y: 0, z: 0},
            rotation: q.eulerDegToQuat({x: deg, y: 0, z: 0}),
            semanticRole: "limb"}, easing, interpolation: "slerp"});
          const straight = ib.pruneKeys([mk(0, 0, "linear"), mk(0.5, 45, "linear"), mk(1, 90, "linear")], {});
          const bent = ib.pruneKeys([mk(0, 0, "linear"), mk(0.5, 80, "quadIn"), mk(1, 90, "quadIn")], {});
          return {straightRemoved: straight.report.removed, straightKept: straight.keys.length,
                  bentRemoved: bent.report.removed};
        })()""")
        self.assertEqual(res["straightRemoved"], 1, res)
        self.assertEqual(res["straightKept"], 2, res)
        self.assertEqual(res["bentRemoved"], 0, res)


class CurveSurfaceTest(unittest.TestCase):
    """Static pins: easing parity and module surfaces across TS/Luau."""

    def test_easing_names_match_plugin(self):
        for name in EASINGS:
            self.assertIn(name, TS_CURVES, "TS missing " + name)
            self.assertIn(name, LUAU_CURVES, "Luau missing " + name)
            self.assertIn(name, PLUGIN, "plugin missing " + name)
        for token in ("1 - math.exp(-5 * t) * math.cos(9 * t)", "c1 = 1.2"):
            self.assertIn(token, LUAU_CURVES, "Luau formula drift: " + token)
            self.assertIn(token, PLUGIN, "plugin formula drift: " + token)
        self.assertIn("1.15", LUAU_CURVES)
        self.assertIn("-0.15", LUAU_CURVES)

    def test_ts_curve_surface(self):
        for token in ("applyEasing", "EASING_FNS", "sampleSegment", "evaluateTrack",
                      "resolveArc", "arcLiftFactor", "applyArc", "bakeTrackDense",
                      "normalizeKeys", "trackDuration", "maxBakedAngleStep"):
            self.assertIn(token, TS_CURVES, "curves.ts missing " + token)
        for token in ("densifyKeys", "pruneKeys", "DensifyReport", "PruneReport"):
            self.assertIn(token, TS_INBETWEEN, "inbetween.ts missing " + token)
        for token in ("generateSparsePoses", "BEAT_RECIPES", "POSE_ROLE_EASING",
                      "mulberry32", "GeneratedTrack"):
            self.assertIn(token, TS_POSE, "pose.ts missing " + token)

    def test_luau_module_surface(self):
        for fn in ("ease", "quatNorm", "quatMul", "eulerDegToQuat", "slerp",
                   "lerp3", "arcLift", "rotToQuat", "bakeKeys"):
            self.assertIn("function Curves." + fn, LUAU_CURVES, "Curves." + fn)
            self.assertIn("function Curves." + fn, PLUGIN, "inline Curves." + fn)
        for fn in ("adapters", "curves", "resolveJoint", "applyKey",
                   "applyTrackAtTime", "bakeTrack"):
            self.assertIn("function PoseSolver." + fn, LUAU_POSE, "PoseSolver." + fn)
            self.assertIn("function PoseSolver." + fn, PLUGIN, "inline PoseSolver." + fn)
        self.assertEqual(PLUGIN.count("--[[CURVES_BEGIN"), 1)
        self.assertEqual(PLUGIN.count("--[[CURVES_END]]"), 1)
        self.assertEqual(PLUGIN.count("--[[POSESOLVER_BEGIN"), 1)
        self.assertEqual(PLUGIN.count("--[[POSESOLVER_END]]"), 1)

    def test_no_new_tool_branches(self):
        for name in ("applyTrackAtTime", "bakeTrack", "PoseSolver", "Curves"):
            lines = [ln for ln in PLUGIN.splitlines() if name in ln]
            self.assertFalse(any('tool=="%s"' % name in ln for ln in lines),
                             "must not add registry tools in Phase 3")


if __name__ == "__main__":
    unittest.main()
