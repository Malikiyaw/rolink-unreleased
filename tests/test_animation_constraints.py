# tests/test_animation_constraints.py - Phase 1 + Phase 4 constraint pins.
#   py -3 tests/test_animation_constraints.py
# Task 1.5: quaternion interpolation, slerp continuity, Euler round-trip.
# Task 1.6: JointAdapter creation for every supported joint type.
# Task 4.5/4.8: joint-limit violations reported, never clamped.
#
# Strategy (no Studio, no TS toolchain assumed):
#  - static pins: the Luau/TS sources contain the required algorithms and the
#    two RigAdapter copies stay structurally identical;
#  - Python ports of Shepperd/axis-angle prove the algorithms on known cases;
#  - behavioral checks execute the REAL TS implementation via node+tsx and
#    SKIP (not fail) when that toolchain is absent.
import io
import json
import math
import os
import re
import shutil
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


def read(*parts):
    with io.open(os.path.join(ROOT, *parts), encoding="utf-8", errors="replace") as f:
        return f.read()


PLUGIN = read("studio-plugin", "RoLink.lua")
MODULE = read("studio-plugin", "animation", "RigAdapter.lua")
TS_QUAT = read("mcp-server", "src", "animation", "quaternion.ts")
TS_ADAPTER = read("mcp-server", "src", "animation", "jointAdapter.ts")

EULER_CASES = [
    (0, 0, 0),
    (90, 0, 0),
    (0, 90, 0),
    (0, 0, 90),
    (180, 0, 0),
    (0, 180, 0),
    (0, 0, 180),
    (-30, 10, 20),
    (45, -60, 120),
    (179, 3, -45),
]


# -- Python ports of the RigAdapter algorithms (mirrors, not imports) --------

def _qmul(a, b):
    aw, ax, ay, az = a
    bw, bx, by, bz = b
    return (
        aw * bw - ax * bx - ay * by - az * bz,
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
    )


def _axis_q(ax, ay, az, angle):
    s = math.sin(angle / 2.0)
    return (math.cos(angle / 2.0), ax * s, ay * s, az * s)


def euler_deg_to_quat(ex, ey, ez):
    """Intrinsic XYZ, matching shared/animationProtocol.ts eulerDegToQuat."""
    rx = _axis_q(1, 0, 0, math.radians(ex))
    ry = _axis_q(0, 1, 0, math.radians(ey))
    rz = _axis_q(0, 0, 1, math.radians(ez))
    return _qmul(_qmul(rx, ry), rz)


def quat_to_matrix(q):
    w, x, y, z = q
    return [
        1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
        2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
        2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
    ]


def shepperd(m):
    """Port of RigAdapter.cframeToQuat (GetComponents order r00..r22)."""
    r00, r01, r02, r10, r11, r12, r20, r21, r22 = m
    trace = r00 + r11 + r22
    if trace > 0:
        s = math.sqrt(trace + 1) * 2
        w, x, y, z = 0.25 * s, (r21 - r12) / s, (r02 - r20) / s, (r10 - r01) / s
    elif r00 > r11 and r00 > r22:
        s = math.sqrt(1 + r00 - r11 - r22) * 2
        w, x, y, z = (r21 - r12) / s, 0.25 * s, (r01 + r10) / s, (r02 + r20) / s
    elif r11 > r22:
        s = math.sqrt(1 + r11 - r00 - r22) * 2
        w, x, y, z = (r02 - r20) / s, (r01 + r10) / s, 0.25 * s, (r12 + r21) / s
    else:
        s = math.sqrt(1 + r22 - r00 - r11) * 2
        w, x, y, z = (r10 - r01) / s, (r02 + r20) / s, (r12 + r21) / s, 0.25 * s
    n = math.sqrt(w * w + x * x + y * y + z * z)
    return (w / n, x / n, y / n, z / n)


def axis_angle_matrix(q):
    """Port of RigAdapter.quatToCFrame rotation part (Rodrigues)."""
    n = math.sqrt(sum(c * c for c in q))
    nw = max(-1.0, min(1.0, q[0] / n))
    angle = 2 * math.acos(nw)
    s = math.sqrt(max(0.0, 1 - nw * nw))
    if s < 1e-9 or angle < 1e-9:
        return [1, 0, 0, 0, 1, 0, 0, 0, 1]
    ax, ay, az = q[1] / n / s, q[2] / n / s, q[3] / n / s
    c, si, t = math.cos(angle), math.sin(angle), 1 - math.cos(angle)
    return [
        t * ax * ax + c, t * ax * ay - si * az, t * ax * az + si * ay,
        t * ax * ay + si * az, t * ay * ay + c, t * ay * az - si * ax,
        t * ax * az - si * ay, t * ay * az + si * ax, t * az * az + c,
    ]


def qdot(a, b):
    return abs(sum(x * y for x, y in zip(a, b)))


def node_json(snippet):
    """Evaluate snippet with q=quaternion.ts, j=jointAdapter.ts in scope."""
    node = shutil.which("node")
    if not node:
        raise unittest.SkipTest("node not on PATH")
    tsx = os.path.join(ROOT, "mcp-server", "node_modules", "tsx", "dist", "cli.mjs")
    if not os.path.exists(tsx):
        raise unittest.SkipTest("tsx not installed (run npm ci in mcp-server/)")
    code = ("import('./src/animation/quaternion.ts').then(async (q) => {"
            " const j = await import('./src/animation/jointAdapter.ts');"
            " console.log(JSON.stringify(" + snippet + ")); })")
    r = subprocess.run([node, tsx, "-e", code],
                       cwd=os.path.join(ROOT, "mcp-server"),
                       capture_output=True, text=True, timeout=180)
    if r.returncode != 0:
        raise AssertionError("tsx eval failed: " + r.stderr[-2000:])
    return json.loads(r.stdout.strip().splitlines()[-1])


class QuaternionInterpolationTest(unittest.TestCase):
    """Task 1.5: interpolation, continuity, Euler round-trip."""

    def test_luau_shepperd_has_four_branches(self):
        for src, label in ((MODULE, "module"), (PLUGIN, "inline")):
            for token in ("trace > 0",
                          "r00 > r11 and r00 > r22",
                          "r11 > r22",
                          "r22 - r00 - r11",
                          "GetComponents"):
                self.assertIn(token, src, "%s missing Shepperd branch %r" % (label, token))

    def test_luau_axis_angle_path(self):
        for src, label in ((MODULE, "module"), (PLUGIN, "inline")):
            for token in ("fromAxisAngle", "math.clamp", "math.acos",
                          "cframeToQuat", "quatToCFrame"):
                self.assertIn(token, src, "%s missing %r" % (label, token))

    def test_luau_sync_markers(self):
        self.assertEqual(PLUGIN.count("--[[RIGADAPTER_BEGIN"), 1)
        self.assertEqual(PLUGIN.count("--[[RIGADAPTER_END]]"), 1)
        inline = PLUGIN.split("--[[RIGADAPTER_BEGIN")[1].split("--[[RIGADAPTER_END]]")[0]
        for fn in ("classify", "probe", "cframeToQuat", "quatToCFrame",
                   "readPose", "writePose", "describe", "describeModel"):
            self.assertIn("function RigAdapter." + fn, inline, fn + " missing inline")
            self.assertIn("function RigAdapter." + fn, MODULE, fn + " missing in module")

    def test_shepperd_roundtrip_python(self):
        # Covers every Shepperd branch: identity/trace>0, x/y/z-dominant 180s.
        for ex, ey, ez in EULER_CASES:
            q = euler_deg_to_quat(ex, ey, ez)
            back = shepperd(quat_to_matrix(q))
            self.assertGreater(qdot(q, back), 0.999999, "euler %r" % ((ex, ey, ez),))

    def test_axis_angle_rebuild_python(self):
        for ex, ey, ez in EULER_CASES:
            q = euler_deg_to_quat(ex, ey, ez)
            rebuilt = axis_angle_matrix(q)
            gap = max(abs(a - b) for a, b in zip(quat_to_matrix(q), rebuilt))
            self.assertLess(gap, 1e-9, "euler %r" % ((ex, ey, ez),))

    def test_slerp_endpoints_midpoint_node(self):
        res = node_json("""(() => {
          const ID = {w:1,x:0,y:0,z:0};
          const X90 = q.quatFromAxisAngle({x:1,y:0,z:0}, Math.PI/2);
          const Y90 = q.quatFromAxisAngle({x:0,y:1,z:0}, Math.PI/2);
          const dot = (a,b) => Math.abs(a.w*b.w+a.x*b.x+a.y*b.y+a.z*b.z);
          const anti = {w:-X90.w,x:-X90.x,y:-X90.y,z:-X90.z};
          return {
            t0: q.quatEqualsApprox(q.quatSlerp(X90, Y90, 0), X90),
            t1: q.quatEqualsApprox(q.quatSlerp(X90, Y90, 1), Y90),
            mid: dot(q.quatSlerp(ID, X90, 0.5),
                      q.quatFromAxisAngle({x:1,y:0,z:0}, Math.PI/4)),
            anti: dot(q.quatSlerp(X90, anti, 0.5), X90),
          };
        })()""")
        self.assertTrue(res["t0"], res)
        self.assertTrue(res["t1"], res)
        self.assertGreater(res["mid"], 0.99999, res)
        self.assertGreater(res["anti"], 0.99999, res)

    def test_slerp_continuity_monotonic_node(self):
        res = node_json("""(() => {
          const ID = {w:1,x:0,y:0,z:0};
          const Y90 = q.quatFromAxisAngle({x:0,y:1,z:0}, Math.PI/2);
          const total = q.quatAngleBetween(ID, Y90);
          return [0.1, 0.25, 0.5, 0.75, 0.9].map((t) =>
            q.quatAngleBetween(ID, q.quatSlerp(ID, Y90, t)) / total);
        })()""")
        for got, want in zip(res, (0.1, 0.25, 0.5, 0.75, 0.9)):
            self.assertAlmostEqual(got, want, places=5)
        self.assertEqual(sorted(res), res, "sweep must be monotonic")

    def test_squad_endpoints_node(self):
        res = node_json("""(() => {
          const ID = {w:1,x:0,y:0,z:0};
          const X90 = q.quatFromAxisAngle({x:1,y:0,z:0}, Math.PI/2);
          const Y90 = q.quatFromAxisAngle({x:0,y:1,z:0}, Math.PI/2);
          const tA = q.quatSquadTangent(ID, ID, X90);
          const tB = q.quatSquadTangent(ID, X90, Y90);
          return {
            t0: q.quatEqualsApprox(q.quatSquad(ID, tA, tB, X90, 0), ID),
            t1: q.quatEqualsApprox(q.quatSquad(ID, tA, tB, X90, 1), X90),
          };
        })()""")
        self.assertTrue(res["t0"], res)
        self.assertTrue(res["t1"], res)

    def test_euler_roundtrip_node(self):
        res = node_json("""(() => {
          const cases = [{x:0,y:45,z:0},{x:-30,y:10,z:20},{x:90,y:0,z:0}];
          const dot = (a,b) => Math.abs(a.w*b.w+a.x*b.x+a.y*b.y+a.z*b.z);
          return cases.map((e) => {
            const a = q.eulerDegToQuat(e);
            return dot(a, q.eulerDegToQuat(q.quatToEulerDeg(a)));
          });
        })()""")
        for got in res:
            self.assertGreater(got, 0.999, res)

    def test_angular_velocity_roundtrip_node(self):
        res = node_json("""(() => {
          const ID = {w:1,x:0,y:0,z:0};
          const X90 = q.quatFromAxisAngle({x:1,y:0,z:0}, Math.PI/2);
          const w = q.quatAngularVelocity(ID, X90, 0.5);
          const mag = Math.hypot(w.x, w.y, w.z);
          const back = q.quatFromAngularVelocity(w, 0.5);
          const dot = Math.abs(back.w*X90.w+back.x*X90.x+back.y*X90.y+back.z*X90.z);
          return {mag, dot};
        })()""")
        self.assertAlmostEqual(res["mag"], 180.0, places=3)
        self.assertGreater(res["dot"], 0.9999, res)


def parse_ts_drive_channels(src):
    block = src.split("DRIVE_CHANNELS")[1].split("};")[0]
    out = {}
    for m in re.finditer(r"(\w+):\s*\[([^\]]*)\]", block):
        out[m.group(1)] = [s.strip().strip('"') for s in m.group(2).split(",") if s.strip()]
    return out


def parse_luau_channels(src):
    block = src.split("CHANNELS = {")[1].split("\n  },")[0]
    out = {}
    for m in re.finditer(r"(\w+)\s*=\s*\{([^}]*)\}", block):
        out[m.group(1)] = [s.strip().strip('"') for s in m.group(2).split(",") if s.strip()]
    return out


class JointAdapterCreationTest(unittest.TestCase):
    """Task 1.6: JointAdapter creation for each supported joint type."""

    KINDS = ("Motor6D", "AnimationConstraint", "Bone", "Weld", "Rigid", "Custom")

    def test_ts_adapter_supports_all_kinds(self):
        for token in ("createJointBinding", "adaptersFromAnalyzeNodes",
                      "validateBindings", "isJointBinding", "chainBetween",
                      "buildJointGraph", "resolveLegacyCandidate",
                      "classifyRobloxClass", "DRIVE_CHANNELS"):
            self.assertIn(token, TS_ADAPTER, "jointAdapter.ts missing " + token)
        for kind in self.KINDS:
            self.assertIn(kind, TS_ADAPTER, "kind missing: " + kind)

    def test_ts_drive_channels_complete(self):
        channels = parse_ts_drive_channels(TS_ADAPTER)
        self.assertEqual(
            channels,
            {"Motor6D": ["Motor6DTransform"],
             "AnimationConstraint": ["ConstraintTransform", "ClipOnly"],
             "Bone": ["ClipOnly"],
             "Weld": ["None"],
             "Rigid": ["PartCFrame"],
             "Custom": ["None"]},
            channels)

    def test_luau_adapter_surface(self):
        for src, label in ((MODULE, "module"), (PLUGIN, "inline")):
            for fn in ("classify", "probe", "cframeToQuat", "quatToCFrame",
                       "readPose", "writePose", "effectiveChannels",
                       "describe", "describeModel"):
                self.assertIn("function RigAdapter." + fn, src,
                              "%s missing RigAdapter.%s" % (label, fn))
        n_mod = len(re.findall(r"function RigAdapter\.\w+", MODULE))
        n_inline = len(re.findall(r"function RigAdapter\.\w+", PLUGIN))
        self.assertGreaterEqual(n_mod, 9)
        self.assertEqual(n_mod, n_inline, "inline/module RigAdapter drift")
        self.assertEqual(len(re.findall(r"local function raNum\b", PLUGIN)), 1)

    def test_luau_channel_parity_python(self):
        ts_channels = parse_ts_drive_channels(TS_ADAPTER)
        for src, label in ((MODULE, "module"), (PLUGIN, "inline")):
            self.assertEqual(parse_luau_channels(src), ts_channels,
                             "%s CHANNELS drift from DRIVE_CHANNELS" % label)

    def test_binding_creation_per_kind_node(self):
        res = node_json("""([
          ["Motor6D", "Motor6D", true, "Motor6DTransform"],
          ["AnimationConstraint", "AnimationConstraint", true, "ConstraintTransform"],
          ["Bone", "Bone", false, "ClipOnly"],
          ["Weld", "Weld", false, "None"],
          ["WeldConstraint", "Weld", false, "None"],
          ["Part", "Rigid", true, "PartCFrame"],
          ["MeshPart", "Rigid", true, "PartCFrame"],
          ["Model", "Rigid", true, "PartCFrame"],
          ["Humanoid", "Custom", false, "None"],
        ].map(([cls, kind, writable, ch0]) => {
          const b = j.createJointBinding({name: "J", path: "Workspace/M/J", className: cls});
          return {cls, ok: b.kind === kind && b.drive.writable === writable
                      && b.drive.channels[0] === ch0 && j.isJointBinding(b)};
        }))""")
        for row in res:
            self.assertTrue(row["ok"], row)

    def test_binding_validation_node(self):
        res = node_json("""(() => {
          const mk = (path, name, cls) =>
            j.createJointBinding({name, path, className: cls});
          const dupes = j.validateBindings(
            [mk("Workspace.A.Head", "Head", "Motor6D"),
             mk("Workspace.B.Head", "Head", "Motor6D")]);
          const mixed = j.validateBindings(
            [mk("Workspace.M.A", "A", "Motor6D"),
             mk("Workspace.M.B", "B", "AnimationConstraint")]);
          const dead = j.validateBindings([mk("Workspace.M.W", "W", "Weld")]);
          const b = mk("Workspace.M.Neck", "Neck", "Motor6D");
          return {
            dupeError: !dupes.ok && dupes.errors.join(" ").includes("duplicate joint name"),
            mixedWarn: mixed.ok && mixed.warnings.join(" ").includes("mixed rig technology"),
            deadError: !dead.ok,
            roundTrip: j.isJointBinding(JSON.parse(JSON.stringify(b))),
          };
        })()""")
        for key in ("dupeError", "mixedWarn", "deadError", "roundTrip"):
            self.assertTrue(res[key], (key, res))

    def test_chain_query_node(self):
        res = node_json("""(() => {
          const nodes = [
            {path: "Workspace.NPC", name: "NPC", class: "Model", kind: "root", depth: 0},
            {path: "Workspace.NPC.Torso", name: "Torso", class: "Part", kind: "rigid", depth: 1},
            {path: "Workspace.NPC.Torso.Neck", name: "Neck", class: "Motor6D", kind: "rotational", depth: 2},
          ];
          const bindings = j.adaptersFromAnalyzeNodes(nodes);
          const g = j.buildJointGraph(bindings);
          const chain = j.chainBetween(g, "Torso", "Neck");
          const neck = bindings.find((b) => b.name === "Neck");
          return {
            count: bindings.length,
            parent: neck && neck.parent,
            chain: chain && chain.map((b) => b.name),
            legacy: j.resolveLegacyCandidate(bindings, "Neck")?.className,
            missing: j.chainBetween(g, "Torso", "Nope") === undefined,
          };
        })()""")
        self.assertEqual(res["count"], 3, res)
        self.assertEqual(res["parent"], "Torso", res)
        self.assertEqual(res["chain"], ["Torso", "Neck"], res)
        self.assertEqual(res["legacy"], "Motor6D", res)
        self.assertTrue(res["missing"], res)


def node_anim(snippet):
    """Evaluate snippet with animation modules (q/j/s/c/ib/p/v) in scope."""
    node = shutil.which("node")
    if not node:
        raise unittest.SkipTest("node not on PATH")
    tsx = os.path.join(ROOT, "mcp-server", "node_modules", "tsx", "dist", "cli.mjs")
    if not os.path.exists(tsx):
        raise unittest.SkipTest("tsx not installed (run npm ci in mcp-server/)")
    code = ("import('./src/animation/validator.ts').then(async (v) => {"
            " const q = await import('./src/animation/quaternion.ts');"
            " console.log(JSON.stringify(" + snippet + ")); })")
    r = subprocess.run([node, tsx, "-e", code],
                       cwd=os.path.join(ROOT, "mcp-server"),
                       capture_output=True, text=True, timeout=180)
    if r.returncode != 0:
        raise AssertionError("tsx eval failed: " + r.stderr[-2000:])
    return json.loads(r.stdout.strip().splitlines()[-1])


class JointLimitReportTest(unittest.TestCase):
    """Task 4.5: joint-limit violations are reported, never clamped."""

    def test_validator_surface(self):
        src = read("mcp-server", "src", "animation", "validator.ts")
        for token in ("inferJointLimit", "inferJointLimits", "validateJointLimits",
                      "ROLE_LIMIT_TEMPLATES", "IMPOSSIBLE_ROTATION", "OVEREXTENSION",
                      "JOINT_LIMIT", "suggestedFix"):
            self.assertIn(token, src, "validator.ts missing " + token)

    def test_elbow_overextension_reported(self):
        res = node_anim("""(() => {
          const lim = v.inferJointLimits([{name: "LeftElbow", kind: "Motor6D"}], {LeftElbow: "limb"});
          const bent = {t: 0.5, pose: {joint: "LeftElbow",
            position: {x: 0, y: 0, z: 0},
            rotation: q.eulerDegToQuat({x: 170, y: 0, z: 0}),
            semanticRole: "limb"}, easing: "linear", interpolation: "slerp"};
          const tracks = [{joint: "LeftElbow", keys: [bent]}];
          const before = JSON.stringify(tracks);
          const issues = v.validateJointLimits(tracks, lim, {});
          return {codes: issues.map((i) => i.code), fix: (issues[0] || {}).suggestedFix,
                  untouched: JSON.stringify(tracks) === before};
        })()""")
        self.assertTrue(res["codes"], res)
        self.assertIn(res["codes"][0], ("JOINT_LIMIT", "OVEREXTENSION"), res)
        self.assertIn("clamp", res["fix"], res)
        self.assertTrue(res["untouched"], "validator must never mutate inputs")

    def test_valid_pose_passes(self):
        res = node_anim("""(() => {
          const lim = v.inferJointLimits([{name: "Neck", kind: "Motor6D"}], {Neck: "neck"});
          const ok = {t: 0, pose: {joint: "Neck",
            position: {x: 0, y: 0, z: 0},
            rotation: q.eulerDegToQuat({x: 10, y: 0, z: 0}),
            semanticRole: "neck"}, easing: "linear", interpolation: "slerp"};
          return {n: v.validateJointLimits([{joint: "Neck", keys: [ok]}], lim, {}).length};
        })()""")
        self.assertEqual(res["n"], 0, res)


if __name__ == "__main__":
    unittest.main()
