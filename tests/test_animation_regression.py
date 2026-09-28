# tests/test_animation_regression.py - Phase 2 semantic-rig regression suite.
#   py -3 tests/test_animation_regression.py
# Seven synthetic rigs (R15, R6, quadruped, door, car, cannon, skinned bones)
# run through the REAL analyzer (mcp-server/src/animation/rigAnalyzer.ts)
# via node+tsx; behavioral tests SKIP when that toolchain is absent.
# Fixtures use the exact rlModelAnalyze node shape so they double as
# documentation of what the Studio side must report.
import io
import json
import math
import os
import shutil
import subprocess
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


def read(*parts):
    with io.open(os.path.join(ROOT, *parts), encoding="utf-8", errors="replace") as f:
        return f.read()


def N(path, name, cls, kind, depth):
    return {"path": path, "name": name, "class": cls, "kind": kind, "depth": depth}


RIGS = {
    "r15": {
        "target": "Workspace/NPC",
        "nodes": [
            N("Workspace.NPC", "NPC", "Model", "root", 0),
            N("Workspace.NPC.HumanoidRootPart", "HumanoidRootPart", "Part", "rigid", 1),
            N("Workspace.NPC.LowerTorso", "LowerTorso", "MeshPart", "rigid", 1),
            N("Workspace.NPC.LowerTorso.Root", "Root", "Motor6D", "rotational", 2),
            N("Workspace.NPC.UpperTorso", "UpperTorso", "MeshPart", "rigid", 1),
            N("Workspace.NPC.UpperTorso.Waist", "Waist", "Motor6D", "rotational", 2),
            N("Workspace.NPC.Head", "Head", "Part", "rigid", 1),
            N("Workspace.NPC.UpperTorso.Neck", "Neck", "Motor6D", "rotational", 2),
            N("Workspace.NPC.LeftUpperArm", "LeftUpperArm", "MeshPart", "rigid", 1),
            N("Workspace.NPC.UpperTorso.LeftShoulder", "LeftShoulder", "Motor6D", "rotational", 2),
            N("Workspace.NPC.LeftLowerArm", "LeftLowerArm", "MeshPart", "rigid", 1),
            N("Workspace.NPC.LeftUpperArm.LeftElbow", "LeftElbow", "Motor6D", "rotational", 2),
            N("Workspace.NPC.LeftHand", "LeftHand", "MeshPart", "rigid", 1),
            N("Workspace.NPC.RightUpperArm", "RightUpperArm", "MeshPart", "rigid", 1),
            N("Workspace.NPC.UpperTorso.RightShoulder", "RightShoulder", "Motor6D", "rotational", 2),
            N("Workspace.NPC.RightHand", "RightHand", "MeshPart", "rigid", 1),
            N("Workspace.NPC.LeftUpperLeg", "LeftUpperLeg", "MeshPart", "rigid", 1),
            N("Workspace.NPC.LowerTorso.LeftHip", "LeftHip", "Motor6D", "rotational", 2),
            N("Workspace.NPC.LeftLowerLeg", "LeftLowerLeg", "MeshPart", "rigid", 1),
            N("Workspace.NPC.LeftUpperLeg.LeftKnee", "LeftKnee", "Motor6D", "rotational", 2),
            N("Workspace.NPC.LeftFoot", "LeftFoot", "MeshPart", "rigid", 1),
            N("Workspace.NPC.RightUpperLeg", "RightUpperLeg", "MeshPart", "rigid", 1),
            N("Workspace.NPC.LowerTorso.RightHip", "RightHip", "Motor6D", "rotational", 2),
            N("Workspace.NPC.RightFoot", "RightFoot", "MeshPart", "rigid", 1),
        ],
        "expect": {
            "rigType": "humanoid", "root": "NPC", "head": "Head",
            "hands": ["LeftHand", "RightHand"], "feet": ["LeftFoot", "RightFoot"],
            "roles": {"Neck": "neck", "LeftShoulder": "limb", "LeftElbow": "limb",
                      "LeftHip": "limb", "LeftKnee": "limb",
                      "HumanoidRootPart": "locomotionRoot",
                      "UpperTorso": "chest", "LowerTorso": "spine"},
            "spineFirst": "NPC", "spineLast": "Head",
            "spineContains": ["Neck", "Waist"],
        },
    },
    "r6": {
        "target": "Workspace/Noob",
        "nodes": [
            N("Workspace.Noob", "Noob", "Model", "root", 0),
            N("Workspace.Noob.HumanoidRootPart", "HumanoidRootPart", "Part", "rigid", 1),
            N("Workspace.Noob.Torso", "Torso", "Part", "rigid", 1),
            N("Workspace.Noob.HumanoidRootPart.RootJoint", "RootJoint", "Motor6D", "rotational", 2),
            N("Workspace.Noob.Head", "Head", "Part", "rigid", 1),
            N("Workspace.Noob.Torso.Neck", "Neck", "Motor6D", "rotational", 2),
            N("Workspace.Noob.Torso.Left Shoulder", "Left Shoulder", "Motor6D", "rotational", 2),
            N("Workspace.Noob.Left Arm", "Left Arm", "Part", "rigid", 1),
            N("Workspace.Noob.Torso.Right Shoulder", "Right Shoulder", "Motor6D", "rotational", 2),
            N("Workspace.Noob.Right Arm", "Right Arm", "Part", "rigid", 1),
            N("Workspace.Noob.Torso.Left Hip", "Left Hip", "Motor6D", "rotational", 2),
            N("Workspace.Noob.Left Leg", "Left Leg", "Part", "rigid", 1),
            N("Workspace.Noob.Torso.Right Hip", "Right Hip", "Motor6D", "rotational", 2),
            N("Workspace.Noob.Right Leg", "Right Leg", "Part", "rigid", 1),
        ],
        "expect": {
            "rigType": "humanoid", "root": "Noob", "head": "Head",
            "hands": ["Left Arm", "Right Arm"], "feet": ["Left Leg", "Right Leg"],
            "roles": {"Left Shoulder": "limb", "Left Hip": "limb",
                      "Left Arm": "hand", "Left Leg": "foot", "Torso": "spine"},
            "spineExact": ["Noob", "HumanoidRootPart", "RootJoint", "Torso", "Neck", "Head"],
        },
    },
    "wolf": {
        "target": "Workspace/Wolf",
        "nodes": [
            N("Workspace.Wolf", "Wolf", "Model", "root", 0),
            N("Workspace.Wolf.Body", "Body", "Part", "rigid", 1),
            N("Workspace.Wolf.Head", "Head", "Part", "rigid", 1),
            N("Workspace.Wolf.Body.Neck", "Neck", "Motor6D", "rotational", 2),
            N("Workspace.Wolf.FLLeg", "FLLeg", "Part", "rigid", 1),
            N("Workspace.Wolf.FLPaw", "FLPaw", "Part", "rigid", 1),
            N("Workspace.Wolf.FRLeg", "FRLeg", "Part", "rigid", 1),
            N("Workspace.Wolf.FRPaw", "FRPaw", "Part", "rigid", 1),
            N("Workspace.Wolf.BLLeg", "BLLeg", "Part", "rigid", 1),
            N("Workspace.Wolf.BLPaw", "BLPaw", "Part", "rigid", 1),
            N("Workspace.Wolf.BRLeg", "BRLeg", "Part", "rigid", 1),
            N("Workspace.Wolf.BRPaw", "BRPaw", "Part", "rigid", 1),
            N("Workspace.Wolf.Body.Tail1", "Tail1", "Motor6D", "rotational", 2),
            N("Workspace.Wolf.Body.Tail1.Tail2", "Tail2", "Motor6D", "rotational", 3),
            N("Workspace.Wolf.TailTip", "TailTip", "Part", "rigid", 1),
        ],
        "expect": {
            "rigType": "creature", "root": "Wolf", "head": "Head",
            "roles": {"FLPaw": "foot", "FLLeg": "limb", "Tail1": "limb",
                      "TailTip": "endEffector", "Neck": "neck"},
            "spineFirst": "Wolf", "spineLast": "Head",
            "spineContains": ["Neck"],
            "minFeet": 2,
        },
    },
    "door": {
        "target": "Workspace/Door",
        "nodes": [
            N("Workspace.Door", "Door", "Model", "root", 0),
            N("Workspace.Door.Frame", "Frame", "Part", "rigid", 1),
            N("Workspace.Door.Frame.HingeJoint", "HingeJoint", "Motor6D", "rotational", 2),
            N("Workspace.Door.Frame.HingeJoint.Panel", "Panel", "Part", "rigid", 3),
            N("Workspace.Door.Frame.HingeJoint.Panel.Handle", "Handle", "Weld", "follow", 4),
        ],
        "expect": {
            "rigType": "mechanical", "root": "Door",
            "roles": {"HingeJoint": "hinge", "Panel": "rigid", "Handle": "follow"},
            "noHead": True, "maxDepth": 4,
            "chains": [("Frame", "Panel", ["Frame", "HingeJoint", "Panel"])],
        },
    },
    "car": {
        "target": "Workspace/Car",
        "nodes": [
            N("Workspace.Car", "Car", "Model", "root", 0),
            N("Workspace.Car.Chassis", "Chassis", "Part", "rigid", 1),
            N("Workspace.Car.Seat", "Seat", "Seat", "rigid", 1),
            N("Workspace.Car.EngineBlock", "EngineBlock", "Part", "rigid", 1),
            N("Workspace.Car.Chassis.WheelFL", "WheelFL", "Motor6D", "rotational", 2),
            N("Workspace.Car.TireFL", "TireFL", "Part", "rigid", 1),
            N("Workspace.Car.Chassis.WheelFR", "WheelFR", "Motor6D", "rotational", 2),
            N("Workspace.Car.TireFR", "TireFR", "Part", "rigid", 1),
            N("Workspace.Car.Chassis.WheelBL", "WheelBL", "Motor6D", "rotational", 2),
            N("Workspace.Car.TireBL", "TireBL", "Part", "rigid", 1),
            N("Workspace.Car.Chassis.WheelBR", "WheelBR", "Motor6D", "rotational", 2),
            N("Workspace.Car.TireBR", "TireBR", "Part", "rigid", 1),
            N("Workspace.Car.Chassis.SteeringWheel", "SteeringWheel", "Motor6D", "rotational", 2),
        ],
        "expect": {
            "rigType": "vehicle", "root": "Car",
            "roles": {"WheelFL": "mechanical", "TireFL": "mechanical",
                      "EngineBlock": "mechanical", "Chassis": "rigid", "Seat": "rigid"},
            "noHead": True,
        },
    },
    "cannon": {
        "target": "Workspace/Cannon",
        "nodes": [
            N("Workspace.Cannon", "Cannon", "Model", "root", 0),
            N("Workspace.Cannon.Base", "Base", "Part", "rigid", 1),
            N("Workspace.Cannon.Base.Barrel", "Barrel", "Motor6D", "rotational", 2),
            N("Workspace.Cannon.Base.Barrel.Muzzle", "Muzzle", "Part", "rigid", 3),
            N("Workspace.Cannon.CannonBall", "CannonBall", "Part", "rigid", 1),
        ],
        "expect": {
            "rigType": "mechanical", "root": "Cannon",
            "roles": {"Barrel": "mechanical", "Muzzle": "endEffector",
                      "Base": "rigid", "CannonBall": "rigid"},
            "noHead": True,
            "chains": [("Base", "Muzzle", ["Base", "Barrel", "Muzzle"])],
        },
    },
    "skinned": {
        "target": "Workspace/Creature",
        "nodes": [
            N("Workspace.Creature", "Creature", "Model", "root", 0),
            N("Workspace.Creature.Body", "Body", "MeshPart", "rigid", 1),
            N("Workspace.Creature.RootBone", "RootBone", "Bone", "rotational", 1),
            N("Workspace.Creature.RootBone.SpineBone", "SpineBone", "Bone", "rotational", 2),
            N("Workspace.Creature.RootBone.SpineBone.HeadBone", "HeadBone", "Bone", "rotational", 3),
        ],
        "expect": {
            "rigType": "unknown", "root": "Creature", "head": "HeadBone",
            "roles": {"RootBone": "root", "SpineBone": "spine",
                      "HeadBone": "head"},
            "allBonesClipOnly": True,
            "spineExact": ["Creature", "RootBone", "SpineBone", "HeadBone"],
        },
    },
}


def analyze_via_node(rig):
    node = shutil.which("node")
    if not node:
        raise unittest.SkipTest("node not on PATH")
    tsx = os.path.join(ROOT, "mcp-server", "node_modules", "tsx", "dist", "cli.mjs")
    if not os.path.exists(tsx):
        raise unittest.SkipTest("tsx not installed (run npm ci in mcp-server/)")
    payload = json.dumps({"target": rig["target"], "nodes": rig["nodes"]})
    code = ("import('./src/animation/rigAnalyzer.ts').then(async (m) => {"
            " const j = await import('./src/animation/jointAdapter.ts');"
            " const input = " + payload + ";"
            " const res = m.analyzeRig(input.target, input.nodes);"
            " const g = j.buildJointGraph(res.bindings);"
            " const out = {rigType: res.rigType, analysis: res.analysis,"
            "  roles: Object.fromEntries(res.analysis.skeleton.joints.map((x) => [x.name, x.semanticRole])),"
            "  drives: Object.fromEntries(res.bindings.map((b) => [b.name,"
            "   [b.kind, b.drive.writable, ...b.drive.channels]])),"
            "  chain: (a, b) => { const c = j.chainBetween(g, a, b);"
            "   return c ? c.map((x) => x.name) : null; }};"
            " console.log(JSON.stringify(out));"
            "})")
    # Per-rig chains are asserted in Python via a second call below; keep the
    # first call free of fixture-specific logic.
    r = subprocess.run([node, tsx, "-e", code],
                       cwd=os.path.join(ROOT, "mcp-server"),
                       capture_output=True, text=True, timeout=180)
    if r.returncode != 0:
        raise AssertionError("tsx eval failed: " + r.stderr[-2000:])
    return json.loads(r.stdout.strip().splitlines()[-1])


def chain_via_node(rig, start, end):
    node = shutil.which("node")
    if not node:
        raise unittest.SkipTest("node not on PATH")
    tsx = os.path.join(ROOT, "mcp-server", "node_modules", "tsx", "dist", "cli.mjs")
    code = ("import('./src/animation/rigAnalyzer.ts').then(async (m) => {"
            " const j = await import('./src/animation/jointAdapter.ts');"
            " const res = m.analyzeRig(" + json.dumps(rig["target"]) + ", "
            + json.dumps(rig["nodes"]) + ");"
            " const g = j.buildJointGraph(res.bindings);"
            " const c = j.chainBetween(g, " + json.dumps(start) + ", "
            + json.dumps(end) + ");"
            " console.log(JSON.stringify(c ? c.map((x) => x.name) : null)); })")
    r = subprocess.run([node, tsx, "-e", code],
                       cwd=os.path.join(ROOT, "mcp-server"),
                       capture_output=True, text=True, timeout=180)
    if r.returncode != 0:
        raise AssertionError("tsx eval failed: " + r.stderr[-2000:])
    return json.loads(r.stdout.strip().splitlines()[-1])


class RigAnalysisRegressionTest(unittest.TestCase):
    maxDiff = 4000

    def assertRig(self, key):
        rig = RIGS[key]
        res = analyze_via_node(rig)
        exp = rig["expect"]
        skel = res["analysis"]["skeleton"]
        self.assertEqual(res["rigType"], exp["rigType"], "%s rigType: %s" % (key, res))
        self.assertEqual(skel["root"], exp["root"], "%s root" % key)
        if "head" in exp:
            self.assertEqual(skel.get("probableHead"), exp["head"], "%s head" % key)
        if exp.get("noHead"):
            self.assertIsNone(skel.get("probableHead"), "%s must have no head" % key)
            self.assertEqual(skel.get("probableHands", []), [])
            self.assertEqual(skel.get("probableFeet", []), [])
        for name in exp.get("hands", []):
            self.assertIn(name, skel.get("probableHands", []), "%s hands" % key)
        for name in exp.get("feet", []):
            self.assertIn(name, skel.get("probableFeet", []), "%s feet" % key)
        for name, role in exp.get("roles", {}).items():
            self.assertEqual(res["roles"].get(name), role, "%s role %s" % (key, name))
        if "spineExact" in exp:
            self.assertEqual(skel.get("spineChain"), exp["spineExact"], "%s spine" % key)
        if "spineFirst" in exp:
            chain = skel.get("spineChain", [])
            self.assertGreater(len(chain), 0, "%s empty spine" % key)
            self.assertEqual(chain[0], exp["spineFirst"], "%s spine first" % key)
            self.assertEqual(chain[-1], exp["spineLast"], "%s spine last" % key)
            for member in exp.get("spineContains", []):
                self.assertIn(member, chain, "%s spine member %s" % (key, member))
        if "maxDepth" in exp:
            self.assertEqual(res["analysis"]["maxDepth"], exp["maxDepth"], "%s depth" % key)
        if "minFeet" in exp:
            self.assertGreaterEqual(len(skel.get("probableFeet", [])), exp["minFeet"])
            for fname in skel.get("probableFeet", []):
                self.assertIn("Paw", fname, "%s foot should be a paw" % key)
        if exp.get("allBonesClipOnly"):
            for name, drive in res["drives"].items():
                if res["roles"].get(name) in ("rotational", "head", "spine", "root") and name.endswith("Bone"):
                    self.assertEqual(drive, ["Bone", False, "ClipOnly"], name)
        for start, end, want in exp.get("chains", []):
            self.assertEqual(chain_via_node(rig, start, end), want, "%s chain" % key)
        return res

    def test_r15_humanoid(self):
        self.assertRig("r15")

    def test_r6_humanoid(self):
        self.assertRig("r6")

    def test_quadruped_creature(self):
        self.assertRig("wolf")

    def test_door_mechanical(self):
        self.assertRig("door")

    def test_car_vehicle(self):
        self.assertRig("car")

    def test_cannon_articulated(self):
        self.assertRig("cannon")

    def test_skinned_bones(self):
        self.assertRig("skinned")

    def test_hinge_constraint_stays_readonly(self):
        # HingeConstraint/PrismaticConstraint have no Transform channel in the
        # current adapter: read-only Custom, never silently drivable.
        node = shutil.which("node")
        if not node:
            raise unittest.SkipTest("node not on PATH")
        tsx = os.path.join(ROOT, "mcp-server", "node_modules", "tsx", "dist", "cli.mjs")
        if not os.path.exists(tsx):
            raise unittest.SkipTest("tsx not installed (run npm ci in mcp-server/)")
        code = ("import('./src/animation/jointAdapter.ts').then(async (j) => {"
                " const out = ['HingeConstraint', 'PrismaticConstraint'].map((cls) => {"
                "  const b = j.createJointBinding({name: 'H', path: 'Workspace/M/H', className: cls});"
                "  return [b.kind, b.drive.writable, ...b.drive.channels]; });"
                " console.log(JSON.stringify(out)); })")
        r = subprocess.run([node, tsx, "-e", code],
                           cwd=os.path.join(ROOT, "mcp-server"),
                           capture_output=True, text=True, timeout=180)
        if r.returncode != 0:
            raise AssertionError("tsx eval failed: " + r.stderr[-2000:])
        for row in json.loads(r.stdout.strip().splitlines()[-1]):
            self.assertEqual(row, ["Custom", False, "None"], row)

    def test_analyzer_surface_pins(self):
        for token in ("analyzeRig", "summarizeRigAnalysis", "EnrichedJointInput",
                      "JointPropertyPayload", "RigAnalysisResult"):
            self.assertIn(token, read("mcp-server", "src", "animation", "rigAnalyzer.ts"))
        for token in ("classifySemanticRole", "detectLandmarks", "classifyRigType",
                      "buildSemanticSkeleton", "detectSide", "splitWords",
                      "computeDepths", "rigRoleContext"):
            self.assertIn(token, read("mcp-server", "src", "animation", "semanticRig.ts"))
        for token in ("jointEndpoints", "partInfo", "jointPoseInfo", "cframePose",
                      "describeModel", "primaryPart"):
            self.assertIn(token, read("studio-plugin", "animation", "RigAdapter.lua"))


class BenchmarkSuiteRegressionTest(unittest.TestCase):
    """Task 11.2: benchmark suite produces reproducible, bounded metrics.

    Runs the REAL suite (mcp-server/src/animation/benchmarks.ts) and asserts
    its quality metrics. Wall-clock timing (Task 11.3) lives in
    benchmarks.perf.ts and is never asserted -- it is machine-dependent.
    """
    maxDiff = 4000

    STYLES = ["REALISTIC", "CINEMATIC", "ANIME", "EXAGGERATED",
              "MECHANICAL", "CREATURE", "CARTOON", "SUBTLE"]
    METRIC_KEYS = ("contactMaxDriftStud", "contactMeanDriftStud",
                   "loopPositionSeamStud", "loopVelocitySeamRatio",
                   "peakSpeedStudPerSec", "peakJerkStudPerSec3",
                   "velocityContinuity", "repairIterations", "totalErrors")

    def bench(self, snippet):
        node = shutil.which("node")
        if not node:
            raise unittest.SkipTest("node not on PATH")
        tsx = os.path.join(ROOT, "mcp-server", "node_modules", "tsx", "dist", "cli.mjs")
        if not os.path.exists(tsx):
            raise unittest.SkipTest("tsx not installed (run npm ci in mcp-server/)")
        code = ("import('./src/animation/benchmarks.ts').then((m) => {"
                " console.log(JSON.stringify(" + snippet + ")); })")
        r = subprocess.run([node, tsx, "-e", code],
                           cwd=os.path.join(ROOT, "mcp-server"),
                           capture_output=True, text=True, timeout=300)
        if r.returncode != 0:
            raise AssertionError("tsx eval failed: " + r.stderr[-2000:])
        return json.loads(r.stdout.strip().splitlines()[-1])

    def test_every_style_reports_every_metric(self):
        res = self.bench("m.benchmarkAll()")
        self.assertEqual(sorted(res.keys()), sorted(self.STYLES))
        for style in self.STYLES:
            m = res[style]
            for key in self.METRIC_KEYS:
                self.assertIn(key, m, style)
                self.assertTrue(math.isfinite(m[key]), "%s.%s=%r" % (style, key, m[key]))
            self.assertIsInstance(m["contactLocked"], bool)

    def test_reproducible_across_runs(self):
        a = self.bench("m.benchmarkAll()")
        b = self.bench("m.benchmarkAll()")
        self.assertEqual(json.dumps(b, sort_keys=True), json.dumps(a, sort_keys=True))

    def test_exit_criteria_hold_for_every_style(self):
        # Delegates to the engine's own checker so this layer cannot drift
        # from mcp-server/tests/benchmarks.test.ts -- both read the same
        # BENCH_EXIT_CRITERIA table.
        failures = self.bench("m.allExitCriterionFailures()")
        self.assertEqual(failures, [], "; ".join(failures))

    def test_exit_criteria_cover_every_bounded_metric(self):
        crit = self.bench("m.BENCH_EXIT_CRITERIA")
        self.assertTrue(crit)
        for key in ("contactMaxDriftStud", "loopPositionSeamStud",
                    "loopVelocitySeamRatio", "peakSpeedStudPerSec",
                    "peakJerkStudPerSec3", "repairIterations"):
            self.assertIn(key, crit)
            self.assertTrue(math.isfinite(crit[key]) and crit[key] > 0, key)

    def test_non_finite_metrics_are_reported_as_failures(self):
        # A leak/NaN must never launder into a passing benchmark.
        out = self.bench("m.exitCriterionFailures({ ...m.benchmarkStyle('ANIME'), "
                         "contactMaxDriftStud: NaN, contactLocked: false })")
        joined = " ".join(out)
        self.assertIn("contactMaxDriftStud", joined)
        self.assertIn("contactLocked=false", joined)

    def test_styles_are_kinematically_distinct(self):
        res = self.bench("m.benchmarkAll()")
        # Same rig and beat layout for every style; only the profile differs.
        self.assertGreater(res["ANIME"]["peakSpeedStudPerSec"],
                           res["SUBTLE"]["peakSpeedStudPerSec"])
        self.assertGreater(res["REALISTIC"]["peakSpeedStudPerSec"], 0)
        self.assertGreater(res["SUBTLE"]["peakSpeedStudPerSec"], 0)

    def test_fixture_generation_is_deterministic(self):
        ok = self.bench("(() => { const a = m.buildFixture('ANIME');"
                        " const b = m.buildFixture('ANIME');"
                        " return JSON.stringify(a.tracks) === JSON.stringify(b.tracks); })()")
        self.assertTrue(ok)

    def test_benchmark_module_surface_pins(self):
        bench = read("mcp-server", "src", "animation", "benchmarks.ts")
        for token in ("BENCH_STYLES", "benchmarkAll", "benchmarkStyle", "buildFixture",
                      "bakeFixture", "BenchMetrics", "BENCH_EXIT_CRITERIA",
                      "exitCriterionFailures", "allExitCriterionFailures",
                      "contactMaxDriftStud", "loopPositionSeamStud",
                      "loopVelocitySeamRatio", "peakSpeedStudPerSec",
                      "peakJerkStudPerSec3", "repairIterations"):
            self.assertIn(token, bench, token)


class PerfBenchmarkRegressionTest(unittest.TestCase):
    """Task 11.3: the wall-clock harness exists, covers every stage, and is
    explicitly never asserted (machine-dependent timing must not gate CI)."""

    def test_perf_benchmark_measures_every_pipeline_stage(self):
        perf = read("mcp-server", "src", "animation", "benchmarks.perf.ts")
        for token in ("analyzeRig", "generateSparsePoses", "densifyKeys",
                      "bakeTrackDense", "analyzeKinematics", "sampleSegment",
                      "nowMs", "measure", "hrtime"):
            self.assertIn(token, perf, token)

    def test_perf_benchmark_never_asserts_timing(self):
        perf = read("mcp-server", "src", "animation", "benchmarks.perf.ts")
        self.assertNotIn("expect(", perf)
        self.assertIn("not asserted", perf)

    def test_perf_benchmark_runs_and_reports_us_per_op(self):
        node = shutil.which("node")
        if not node:
            raise unittest.SkipTest("node not on PATH")
        tsx = os.path.join(ROOT, "mcp-server", "node_modules", "tsx", "dist", "cli.mjs")
        if not os.path.exists(tsx):
            raise unittest.SkipTest("tsx not installed (run npm ci in mcp-server/)")
        r = subprocess.run([node, tsx, "src/animation/benchmarks.perf.ts"],
                           cwd=os.path.join(ROOT, "mcp-server"),
                           capture_output=True, text=True, timeout=300)
        self.assertEqual(r.returncode, 0, (r.stdout + r.stderr)[-1500:])
        out = r.stdout.encode("ascii", "replace").decode()
        for row in ("analyzeRig", "generateSparsePoses", "bakeTrackDense",
                    "analyzeKinematics", "sampleSegment"):
            self.assertIn(row, out, row)
        self.assertIn("us/op", out)
        self.assertIn("ops/s", out)

    def test_hot_path_optimizations_are_pinned(self):
        # Each replaced a linear scan inside a nested loop (Task 11.3).
        pins = {
            ("mcp-server", "src", "animation", "pose.ts"): "bindingByName",
            ("mcp-server", "src", "animation", "graph.ts"): "edgesByTarget",
            ("mcp-server", "src", "animation", "collision.ts"): "jointFilter",
            ("mcp-server", "src", "animation", "layering.ts"): "maskSetOf",
            ("mcp-server", "src", "animation", "critic.ts"): "cursors",
        }
        for parts, token in pins.items():
            self.assertIn(token, read(*parts), "%s in %s" % (token, parts[-1]))

    def test_splitwords_is_memoized(self):
        semantic = read("mcp-server", "src", "animation", "semanticRig.ts")
        self.assertIn("wordsOf", semantic)
        self.assertIn("WORDS_CACHE_MAX", semantic)
        # Every consumer must go through the memo, not the raw splitter.
        for part in ("validator.ts", "pose.ts"):
            body = read("mcp-server", "src", "animation", part)
            self.assertIn("wordsOf", body, part)
            self.assertNotIn("splitWords(name)", body, part)


if __name__ == "__main__":
    unittest.main()
