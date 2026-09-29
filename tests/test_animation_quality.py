# tests/test_animation_quality.py - Phase 5 kinematic quality pins.
#   py -3 tests/test_animation_quality.py
# Task 5.7: velocity continuity, spike detection, style-dependent limits.
# Behavioral checks run the REAL TS validator via node+tsx and SKIP when
# that toolchain is absent.
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


TS_VALIDATOR = read("mcp-server", "src", "animation", "validator.ts")


def node_anim(snippet):
    node = shutil.which("node")
    if not node:
        raise unittest.SkipTest("node not on PATH")
    tsx = os.path.join(ROOT, "mcp-server", "node_modules", "tsx", "dist", "cli.mjs")
    if not os.path.exists(tsx):
        raise unittest.SkipTest("tsx not installed (run npm ci in mcp-server/)")
    code = ("import('./src/animation/validator.ts').then(async (v) => {"
            " console.log(JSON.stringify(" + snippet + ")); })")
    r = subprocess.run([node, tsx, "-e", code],
                       cwd=os.path.join(ROOT, "mcp-server"),
                       capture_output=True, text=True, timeout=180)
    if r.returncode != 0:
        raise AssertionError("tsx eval failed: " + r.stderr[-2000:])
    return json.loads(r.stdout.strip().splitlines()[-1])


def pos_key(t, x):
    return {"t": t, "pose": {"joint": "Arm",
                             "position": {"x": x, "y": 0, "z": 0},
                             "rotation": {"w": 1, "x": 0, "y": 0, "z": 0},
                             "semanticRole": "limb"},
            "easing": "linear", "interpolation": "linear"}


class VelocityContinuityTest(unittest.TestCase):
    def test_constant_velocity_measured(self):
        res = node_anim("""(() => {
          const keys = [%s, %s, %s].map(([t, x]) => (
            {t, pose: {joint: "A", position: {x, y: 0, z: 0},
             rotation: {w: 1, x: 0, y: 0, z: 0}, semanticRole: "limb"},
             easing: "linear", interpolation: "linear"}));
          const s = v.computeKinematics(keys);
          return {v: s[1].vel.x, a: Math.hypot(s[1].acc.x, s[1].acc.y, s[1].acc.z)};
        })()""" % ("[0, 0]", "[0.5, 1]", "[1, 2]"))
        self.assertAlmostEqual(res["v"], 2.0, places=9)
        self.assertAlmostEqual(res["a"], 0.0, places=9)

    def test_snap_flagged_realistic(self):
        keys = [pos_key(0, 0), pos_key(0.45, 0), pos_key(0.55, 8), pos_key(1, 8)]
        res = node_anim("""v.analyzeKinematics(
          [{joint: "Arm", keys: %s}], "REALISTIC").map((i) => i.code)""" % json.dumps(keys))
        self.assertIn("SPEED_SPIKE", res, res)

    def test_anime_tolerates_more_than_realistic(self):
        keys = [pos_key(0, 0), pos_key(0.4, 0), pos_key(0.5, 3), pos_key(1, 3)]
        strict = node_anim("""v.analyzeKinematics(
          [{joint: "Arm", keys: %s}], "REALISTIC").length""" % json.dumps(keys))
        loose = node_anim("""v.analyzeKinematics(
          [{joint: "Arm", keys: %s}], "ANIME").length""" % json.dumps(keys))
        self.assertGreater(strict, loose, (strict, loose))

    def test_teleport_is_discontinuity(self):
        keys = [pos_key(0, 0), pos_key(0.1, 0), pos_key(0.2, 50)]
        res = node_anim("""v.analyzeKinematics(
          [{joint: "A", keys: %s}], "EXAGGERATED").map((i) => i.code)""" % json.dumps(keys))
        self.assertIn("DISCONTINUITY", res, res)

    def test_gentle_motion_passes_realistic(self):
        keys = [pos_key(t / 10.0, t / 10.0) for t in range(11)]
        res = node_anim("""v.analyzeKinematics(
          [{joint: "A", keys: %s}], "REALISTIC")""" % json.dumps(keys))
        self.assertEqual(res, [], res)


class ValidatorSurfaceTest(unittest.TestCase):
    def test_kinematic_surface(self):
        for token in ("computeKinematics", "kinematicPeaks", "analyzeKinematics",
                      "KinematicSample", "KinematicPeaks", "KinematicTrackInput",
                      "SPEED_SPIKE", "ACCELERATION_SPIKE", "JERK_SPIKE", "DISCONTINUITY"):
            self.assertIn(token, TS_VALIDATOR, token)


def node_anim2(snippet):
    node = shutil.which("node")
    if not node:
        raise unittest.SkipTest("node not on PATH")
    tsx = os.path.join(ROOT, "mcp-server", "node_modules", "tsx", "dist", "cli.mjs")
    if not os.path.exists(tsx):
        raise unittest.SkipTest("tsx not installed (run npm ci in mcp-server/)")
    code = ("import('./src/animation/dynamics.ts').then(async (d) => {"
            " const mp = await import('./src/animation/motionPlanner.ts');"
            " const p = await import('./src/animation/pose.ts');"
            " const c = await import('./src/animation/curves.ts');"
            " const j = await import('./src/animation/jointAdapter.ts');"
            " const s = await import('./src/animation/semanticRig.ts');"
            " const v = await import('./src/animation/validator.ts');"
            " console.log(JSON.stringify(" + snippet + ")); })")
    r = subprocess.run([node, tsx, "-e", code],
                       cwd=os.path.join(ROOT, "mcp-server"),
                       capture_output=True, text=True, timeout=180)
    if r.returncode != 0:
        raise AssertionError("tsx eval failed: " + r.stderr[-2000:])
    return json.loads(r.stdout.strip().splitlines()[-1])


class SecondaryLagTest(unittest.TestCase):
    """Task 6.5: secondary motion lags primary by a configurable delay."""

    CFG = {"joint": "Tail", "lag": 0.12, "stiffness": 60, "damping": 8,
           "mass": 1, "maxDisplacement": 1.5, "maxRotationDeg": 30, "followWeight": 1}
    def test_step_trails_then_settles(self):
        res = node_anim2("""(() => {
          const cfg = %s;
          const st = d.createSecondaryState();
          const dt = 1 / 30;
          const at = (y) => ({position: {x: 0, y, z: 0}, rotation: {w: 1, x: 0, y: 0, z: 0}});
          for (let i = 0; i < 10; i++) d.stepSecondaryMotion(st, at(0), cfg, dt);
          let peak = 0, fin = 0;
          for (let i = 0; i < 120; i++) {
            const r = d.stepSecondaryMotion(st, at(2), cfg, dt);
            peak = Math.max(peak, 2 - r.position.y);
            if (i === 119) fin = Math.abs(2 - r.position.y);
          }
          return {peak, fin};
        })()""" % json.dumps(self.CFG))
        self.assertGreater(res["peak"], 0.1, res)
        self.assertLess(res["fin"], 0.05, res)

    def test_softer_spring_settles_later(self):
        res = node_anim2("""(() => {
          const run = (k) => {
            const cfg = {...%s, stiffness: k, damping: 2 * Math.sqrt(k)};
            const st = d.createSecondaryState();
            const dt = 1 / 60;
            const at = (y) => ({position: {x: 0, y, z: 0}, rotation: {w: 1, x: 0, y: 0, z: 0}});
            for (let i = 0; i < 30; i++) d.stepSecondaryMotion(st, at(0), cfg, dt);
            for (let i = 0; i < 300; i++) {
              if (d.stepSecondaryMotion(st, at(1), cfg, dt).position.y >= 0.5) return i;
            }
            return 1e9;
          };
          return {soft: run(30), stiff: run(200)};
        })()""" % json.dumps(self.CFG))
        self.assertLess(res["stiff"], res["soft"], res)


class StyleTimingTest(unittest.TestCase):
    """Task 6.5: style profiles change timing; no style breaks validation."""

    STYLES = ["REALISTIC", "CINEMATIC", "ANIME", "EXAGGERATED",
              "MECHANICAL", "CREATURE", "CARTOON", "SUBTLE"]
    CFG = SecondaryLagTest.CFG

    def test_fractions_sum_to_one(self):
        res = node_anim2("""(() => {
          const out = {};
          for (const st of %s) {
            const t = mp.STYLE_BEAT_TIMING[st];
            out[st] = Object.values(t).reduce((a, b) => a + b.fraction, 0);
          }
          return out;
        })()""" % json.dumps(self.STYLES))
        for style, total in res.items():
            self.assertAlmostEqual(total, 1.0, places=9, msg=style)

    def test_anime_impacts_sharper_than_realistic(self):
        res = node_anim2("""(() => {
          const f = (st, beat) => mp.STYLE_BEAT_TIMING[st][beat].fraction;
          return {
            animeImpact: f("ANIME", "IMPACT"), realImpact: f("REALISTIC", "IMPACT"),
            animeFollow: f("ANIME", "FOLLOW_THROUGH"), realFollow: f("REALISTIC", "FOLLOW_THROUGH"),
            mechAnt: f("MECHANICAL", "ANTICIPATION"), toonAnt: f("CARTOON", "ANTICIPATION"),
          };
        })()""")
        self.assertLess(res["animeImpact"], res["realImpact"], res)
        self.assertGreater(res["animeFollow"], res["realFollow"], res)
        self.assertLess(res["mechAnt"], res["toonAnt"], res)

    def test_no_style_produces_invalid_angles(self):
        res = node_anim2("""(() => {
          const nodes = [
            {path: "Workspace.NPC", name: "NPC", class: "Model", kind: "root", depth: 0},
            {path: "Workspace.NPC.HumanoidRootPart", name: "HumanoidRootPart",
             class: "Part", kind: "rigid", depth: 1},
            {path: "Workspace.NPC.Torso", name: "Torso", class: "Part", kind: "rigid", depth: 1},
            {path: "Workspace.NPC.Head", name: "Head", class: "Part", kind: "rigid", depth: 1},
            {path: "Workspace.NPC.UpperTorso.Neck", name: "Neck",
             class: "Motor6D", kind: "rotational", depth: 2},
          ];
          const cfg = {...%s, joint: "Head"};
          const out = {};
          for (const st of %s) {
            const plan = mp.planMotion("hop", "Workspace/NPC", st, 1.0);
            const bindings = j.adaptersFromAnalyzeNodes(nodes);
            const skel = s.buildSemanticSkeleton(bindings);
            const tracks = p.generateSparsePoses(bindings, skel, plan, {seed: 2, style: st});
            let bad = 0, n = 0, worst = 0;
            for (const t of tracks) {
              const baked = c.bakeTrackDense(
                {joint: t.joint, jointKind: t.jointKind,
                 semanticRole: t.semanticRole, keys: t.keys}, {fps: 30});
              const prim = baked.keys.map((k) => ({...k, pose: {...k.pose, joint: "Head"}}));
              const sec = d.simulateSecondaryTrack(prim, cfg);
              for (const k of sec) {
                n += 1;
                const q = k.pose.rotation;
                const len = Math.hypot(q.w, q.x, q.y, q.z);
                if (![q.w, q.x, q.y, q.z].every(Number.isFinite) || Math.abs(len - 1) > 1e-6) bad += 1;
                worst = Math.max(worst, Math.abs(len - 1));
              }
              const iss = v.validateJointLimits(
                [{joint: t.joint, keys: baked.keys}], [], {});
              bad += iss.filter((i) => i.code === "IMPOSSIBLE_ROTATION").length;
            }
            out[st] = {bad, n, worst};
          }
          return out;
        })()""" % (json.dumps(self.CFG), json.dumps(self.STYLES)))
        for style, row in res.items():
            self.assertGreater(row["n"], 0, style)
            self.assertEqual(row["bad"], 0, (style, row))


class Phase6SurfaceTest(unittest.TestCase):
    def test_ts_surface(self):
        dyn = read("mcp-server", "src", "animation", "dynamics.ts")
        for token in ("stepSecondaryMotion", "createSecondaryState",
                      "simulateSecondaryTrack", "SecondaryState", "SecondaryTarget"):
            self.assertIn(token, dyn, token)
        plan = read("mcp-server", "src", "animation", "motionPlanner.ts")
        for token in ("planMotion", "STYLE_BEAT_TIMING", "MOTION_BEAT_SEQUENCE",
                      "beatDuration"):
            self.assertIn(token, plan, token)

    def test_luau_surface(self):
        dyn = read("studio-plugin", "animation", "Dynamics.lua")
        plugin = read("studio-plugin", "RoLink.lua")
        for fn in ("createState", "adapters", "resolveJoint", "springAxis",
                   "step", "applySecondary", "simulateTrack",
                   "qlog", "qexp", "qmul", "qconj", "qAngularVelocity", "qnorm"):
            self.assertIn("function Dynamics." + fn, dyn, "Dynamics." + fn)
            self.assertIn("function Dynamics." + fn, plugin, "inline Dynamics." + fn)
        self.assertEqual(plugin.count("--[[DYNAMICS_BEGIN"), 1)
        self.assertEqual(plugin.count("--[[DYNAMICS_END]]"), 1)


def node_anim3(snippet):
    node = shutil.which("node")
    if not node:
        raise unittest.SkipTest("node not on PATH")
    tsx = os.path.join(ROOT, "mcp-server", "node_modules", "tsx", "dist", "cli.mjs")
    if not os.path.exists(tsx):
        raise unittest.SkipTest("tsx not installed (run npm ci in mcp-server/)")
    code = ("import('./src/animation/compiler.ts').then(async (cp) => {"
            " const cr = await import('./src/animation/critic.ts');"
            " const rp = await import('./src/animation/repair.ts');"
            " const j = await import('./src/animation/jointAdapter.ts');"
            " const s = await import('./src/animation/semanticRig.ts');"
            " console.log(JSON.stringify(" + snippet + ")); })")
    r = subprocess.run([node, tsx, "-e", code],
                       cwd=os.path.join(ROOT, "mcp-server"),
                       capture_output=True, text=True, timeout=180)
    if r.returncode != 0:
        raise AssertionError("tsx eval failed: " + r.stderr[-2000:])
    return json.loads(r.stdout.strip().splitlines()[-1])


RIG8_JS = """[
  {path: "Workspace/M", name: "M", class: "Model", kind: "root", depth: 0},
  {path: "Workspace/M/Leg", name: "Leg", class: "Part", kind: "rigid", depth: 1},
  {path: "Workspace/M/Foot", name: "Foot", class: "Part", kind: "rigid", depth: 1},
  {path: "Workspace/M/Elbow", name: "Elbow", class: "Motor6D", kind: "rotational", depth: 1},
]"""

SETUP8_JS = """(() => {
  const bindings = j.adaptersFromAnalyzeNodes(%s);
  const skel = s.buildSemanticSkeleton(bindings);
  const roles = Object.fromEntries(skel.joints.map((x) => [x.name, x.semanticRole]));
  return {bindings, roles};
})()""" % RIG8_JS


class CriticRepairTest(unittest.TestCase):
    """Task 8.4: critic catches, repair fixes, loop converges or fails loud."""

    def test_critic_catches_injected_defects(self):
        res = node_anim3("""(() => {
          const {bindings, roles} = %s;
          const key = (joint, t, x, y, degX) => ({t,
            pose: {joint, position: {x, y, z: 0},
             rotation: (() => { const a = (degX || 0) * Math.PI / 360; return {w: Math.cos(a), x: Math.sin(a), y: 0, z: 0}; })(),
             semanticRole: "limb"}, easing: "linear", interpolation: "linear"});
          const tracks = [
            {joint: "Elbow", keys: [key("Elbow", 0, 0, 0, 0), key("Elbow", 0.5, 0, 0, 170)]},
            {joint: "Foot", keys: [key("Foot", 0.2, 0, 0), key("Foot", 0.5, 0, 0.3), key("Foot", 0.8, 0, 0)]},
            {joint: "Leg", keys: [key("Leg", 0, 0, 0), key("Leg", 0.5, 0, 0), key("Leg", 0.55, 8, 0), key("Leg", 1, 8, 0)]},
          ];
          const byJoint = Object.fromEntries(tracks.map((t) => [t.joint, t.keys]));
          const rep = cr.criticize({animation: "X", tracks, bindings, roles, style: "REALISTIC",
            contacts: [{name: "Plant", type: "FOOT", joint: "Foot",
              worldPosition: {x: 0, y: 0, z: 0}, startTime: 0.2, endTime: 0.8,
              stiffness: 1, tolerance: 0.05}],
            worldPos: (joint, t) => {
              const ks = byJoint[joint] || [];
              let best = null;
              for (const k of ks) {
                if (!best || Math.abs(k.t - t) < Math.abs(best.t - t)) best = k;
              }
              return best && Math.abs(best.t - t) < 1e-6
                ? {...best.pose.position} : undefined;
            },
            floorY: 0,
            volumes: [{t: 0.5, volumes: [
              {name: "Foot", center: {x: 0, y: -1, z: 0}, half: {x: 0.5, y: 0.5, z: 0.5}}]}]});
          const codes = rep.issues.map((i) => i.code);
          const want = ["JOINT_LIMIT", "FOOT_SLIDE", "SPEED_SPIKE", "GROUND_PENETRATION"];
          return {codes, caught: want.filter((c) => codes.includes(c)).length,
                  checked: rep.checked, skipped: rep.skipped.map((x) => x.suite)};
        })()""" % SETUP8_JS)
        for code in ("JOINT_LIMIT", "FOOT_SLIDE", "SPEED_SPIKE", "GROUND_PENETRATION"):
            self.assertIn(code, res["codes"], res)
        self.assertGreaterEqual(res["caught"] / 4.0, 0.95, res)
        self.assertNotIn("kinematics", res["skipped"], res)

    def test_repair_loop_converges(self):
        res = node_anim3("""(() => {
          const {bindings, roles} = %s;
          const key = (joint, t, x, y, degX) => ({t,
            pose: {joint, position: {x, y, z: 0},
             rotation: (() => { const a = (degX || 0) * Math.PI / 360; return {w: Math.cos(a), x: Math.sin(a), y: 0, z: 0}; })(),
             semanticRole: "limb"}, easing: "linear", interpolation: "linear"});
          const before = JSON.stringify([
            {joint: "Elbow", keys: [key("Elbow", 0, 0, 0, 0), key("Elbow", 0.5, 0, 0, 170)]},
            {joint: "Foot", keys: [key("Foot", 0.2, 0, 0), key("Foot", 0.5, 0, 0.3), key("Foot", 0.8, 0, 0.1)]},
          ]);
          const tracks = JSON.parse(before);
          const out = cp.compileAnimation({animation: "Fix", tracks, bindings, roles,
            style: "REALISTIC",
            contacts: [{name: "Plant", type: "FOOT", joint: "Foot",
              worldPosition: {x: 0, y: 0, z: 0}, startTime: 0.2, endTime: 0.8,
              stiffness: 1, tolerance: 0.05}],
            rigidAssembly: true});
          return {status: out.status, iterations: out.iterations,
                  errors: out.remainingIssues.filter((i) => i.severity === "error").length,
                  untouched: JSON.stringify(tracks) === before};
        })()""" % SETUP8_JS)
        self.assertEqual(res["status"], "READY_DATA", res)
        self.assertLessEqual(res["iterations"], 5, res)
        self.assertEqual(res["errors"], 0, res)
        self.assertTrue(res["untouched"], "compiler must never mutate caller tracks")

    def test_unfixable_fails_loudly(self):
        res = node_anim3("""(() => {
          const {bindings, roles} = %s;
          const key = (joint, t, x, y) => ({t,
            pose: {joint, position: {x, y, z: 0}, rotation: {w: 1, x: 0, y: 0, z: 0},
             semanticRole: "limb"}, easing: "linear", interpolation: "linear"});
          const out = cp.compileAnimation({animation: "Hopeless",
            tracks: [{joint: "Foot", keys: [key("Foot", 0.2, 0, 0), key("Foot", 0.5, 0, 0.4)]}],
            bindings, roles, style: "REALISTIC",
            contacts: [{name: "Plant", type: "FOOT", joint: "Foot",
              worldPosition: {x: 0, y: 0, z: 0}, startTime: 0.2, endTime: 0.8,
              stiffness: 0, tolerance: 0.05}],
            rigidAssembly: true, maxIterations: 3});
          return {status: out.status, iterations: out.iterations,
                  reason: out.failReason, remaining: out.remainingIssues.length};
        })()""" % SETUP8_JS)
        self.assertEqual(res["status"], "FAILED", res)
        self.assertLessEqual(res["iterations"], 3, res)
        self.assertIn("budget exhausted", res["reason"], res)
        self.assertGreater(res["remaining"], 0, res)

    def test_compiler_surface(self):
        comp = read("mcp-server", "src", "animation", "compiler.ts")
        for token in ("compileAnimation", "CompilerInput", "CompilerResult",
                      "CompilerPass", "READY_DATA", "FAILED", "maxIterations"):
            self.assertIn(token, comp, token)
        rep = read("mcp-server", "src", "animation", "repair.ts")
        for token in ("repairIssues", "RepairContext", "RepairAction",
                      "clamp-to-limit", "neighbor-smooth", "retime-window",
                      "relock-contact", "lift-above-floor"):
            self.assertIn(token, rep, token)
        crit = read("mcp-server", "src", "animation", "critic.ts")
        for token in ("criticize", "CriticReport", "FOOT_SLIDE",
                      "HAND_CONTACT_BREAK", "CONTACT_BREAK", "checked", "skipped"):
            self.assertIn(token, crit, token)


FRAME_JS = """(id, modality) => cr.packageVisualFrame(
  Object.assign({frameId: id, animation: "Wave", t: 0.5, width: 320, height: 180},
    modality === "pixels"
      ? {mimeType: "image/png", dataBase64: "aGVsbG8="}
      : {boxes: [{joint: "Head", x: 10, y: 10, w: 40, h: 40, depth: 5, visible: true}]}))"""

CRIT_JS = """(id, verdict, modality) => ({frameId: id, verdict, modality,
  defects: verdict === "fail"
    ? [{code: "WEAK_SILHOUETTE", severity: "error", message: "blob"}] : []})"""


class VisualReviewTest(unittest.TestCase):
    """Phase 9: frames package honestly, critiques validate, states hold."""

    def test_frame_modalities(self):
        res = node_anim3("""(() => {
          const frame = %s;
          const px = frame("a", "pixels"), sch = frame("b", "schematic");
          return {pxMod: px.modality, pxPix: px.pixels,
                  schMod: sch.modality, schPix: sch.pixels,
                  boxes: sch.boxes.length};
        })()""" % FRAME_JS)
        self.assertEqual(res["pxMod"], "pixels", res)
        self.assertTrue(res["pxPix"], res)
        self.assertEqual(res["schMod"], "schematic", res)
        self.assertFalse(res["schPix"], res)
        self.assertEqual(res["boxes"], 1, res)

    def test_schematic_cannot_certify_pixel_defects(self):
        res = node_anim3("""(() => {
          const frame = %s;
          const f = frame("a", "schematic");
          const overreach = {frameId: "a", verdict: "pass", modality: "schematic",
            defects: [{code: "INTERPENETRATION_VISIBLE", severity: "error",
                       message: "looks clean"}]};
          const flag = {frameId: "a", verdict: "fail", modality: "schematic",
            defects: [{code: "DETACHED_LIMB", severity: "error", message: "floats"}]};
          return {downgraded: cr.reviewVisuals([f], [overreach]).verification,
                  flagged: cr.reviewVisuals([f], [flag]).verification,
                  badCrit: cr.validateVisualCritique(
                    {frameId: "a", verdict: "fail", modality: "pixels", defects: []})};
        })()""" % FRAME_JS)
        self.assertEqual(res["downgraded"], "required", res)
        self.assertEqual(res["flagged"], "failed", res)
        self.assertFalse(res["badCrit"], res)

    def test_compiler_visual_states(self):
        res = node_anim3("""(() => {
          const nodes = [
            {path: "Workspace/M", name: "M", class: "Model", kind: "root", depth: 0},
            {path: "Workspace/M/Leg", name: "Leg", class: "Part", kind: "rigid", depth: 1},
          ];
          const bindings = j.adaptersFromAnalyzeNodes(nodes);
          const skel = s.buildSemanticSkeleton(bindings);
          const roles = Object.fromEntries(skel.joints.map((x) => [x.name, x.semanticRole]));
          const tracks = [{joint: "Leg", keys: [0, 1].map((t) => ({t,
            pose: {joint: "Leg", position: {x: t, y: 0, z: 0},
             rotation: {w: 1, x: 0, y: 0, z: 0}, semanticRole: "limb"},
            easing: "linear", interpolation: "linear"}))}];
          const base = {animation: "Clean", tracks, bindings, roles, style: "REALISTIC",
            densify: {maxGapSec: 99, maxAngleDeg: 999, maxMoveStud: 999}};
          const frame = %s, crit = %s;
          const none = cp.compileAnimation(base);
          const ok = cp.compileAnimation({...base,
            visual: {frames: [frame("f1", "schematic")],
                     critiques: [crit("f1", "pass", "schematic")]}});
          const bad = cp.compileAnimation({...base,
            visual: {frames: [frame("f1", "schematic")],
                     critiques: [crit("f1", "fail", "schematic")]}});
          return {none: [none.status, none.visual],
                  ok: [ok.status, ok.visual], bad: [bad.status, bad.visual, bad.failReason]};
        })()""" % (FRAME_JS, CRIT_JS))
        self.assertEqual(res["none"], ["READY_DATA", "required"], res)
        self.assertEqual(res["ok"], ["READY_VISUAL", "passed"], res)
        self.assertEqual(res["bad"][0], "FAILED", res)
        self.assertEqual(res["bad"][1], "failed", res)
        self.assertIn("visual review failed", res["bad"][2], res)

    def test_visual_surface(self):
        crit = read("mcp-server", "src", "animation", "critic.ts")
        for token in ("packageVisualFrame", "validateVisualCritique", "reviewVisuals",
                      "VisualFrame", "VisualCritique", "VisualReview", "VisualDefect",
                      "PIXEL_ONLY_DEFECTS", "VISUAL_CODES", "WEAK_SILHOUETTE",
                      "STIFF_MOTION", "BAD_FRAMING", "VISIBLE_SNAPPING",
                      "INTERPENETRATION_VISIBLE", "DETACHED_LIMB",
                      "HIDDEN_ACTION", "TIMING_OFF"):
            self.assertIn(token, crit, token)
        comp = read("mcp-server", "src", "animation", "compiler.ts")
        self.assertIn("READY_VISUAL", comp)
        self.assertIn("visual", comp)
        lab = read("studio-plugin", "animation", "AnimationLab.lua")
        plugin = read("studio-plugin", "RoLink.lua")
        for fn in ("viewportInfo", "resolveJoint", "drivenPart", "project",
                   "jointBox", "collectJoints", "captureFrame", "captureSequence"):
            self.assertIn("function AnimationLab." + fn, lab, "AnimationLab." + fn)
            self.assertIn("function AnimationLab." + fn, plugin, "inline AnimationLab." + fn)
        self.assertEqual(plugin.count("--[[ANIMLAB_BEGIN"), 1)
        self.assertEqual(plugin.count("--[[ANIMLAB_END]]"), 1)
        self.assertIn("pixels", lab)
        self.assertIn("no pixel capture", lab)


if __name__ == "__main__":
    unittest.main()
