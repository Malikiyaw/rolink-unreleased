# tests/test_animation_contacts.py - Phase 4 IK/contact/limit pins.
#   py -3 tests/test_animation_contacts.py
# Task 4.8: IK reach accuracy, contact-lock drift < tolerance, joint-limit
# violations detected. Behavioral checks run the REAL TS implementation via
# node+tsx and SKIP when that toolchain is absent.
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


TS_IK = read("mcp-server", "src", "animation", "ik.ts")
TS_CONTACTS = read("mcp-server", "src", "animation", "contacts.ts")
LUAU_IK = read("studio-plugin", "animation", "IK.lua")
LUAU_CONTACTS = read("studio-plugin", "animation", "Contacts.lua")
PLUGIN = read("studio-plugin", "RoLink.lua")


def node_anim(snippet):
    node = shutil.which("node")
    if not node:
        raise unittest.SkipTest("node not on PATH")
    tsx = os.path.join(ROOT, "mcp-server", "node_modules", "tsx", "dist", "cli.mjs")
    if not os.path.exists(tsx):
        raise unittest.SkipTest("tsx not installed (run npm ci in mcp-server/)")
    code = ("import('./src/animation/ik.ts').then(async (ik) => {"
            " const ct = await import('./src/animation/contacts.ts');"
            " const q = await import('./src/animation/quaternion.ts');"
            " console.log(JSON.stringify(" + snippet + ")); })")
    r = subprocess.run([node, tsx, "-e", code],
                       cwd=os.path.join(ROOT, "mcp-server"),
                       capture_output=True, text=True, timeout=180)
    if r.returncode != 0:
        raise AssertionError("tsx eval failed: " + r.stderr[-2000:])
    return json.loads(r.stdout.strip().splitlines()[-1])


class IKReachTest(unittest.TestCase):
    """Exit criterion: IK reaches targets within 0.1 studs."""

    def test_two_bone_reach(self):
        res = node_anim("""(() => {
          const model = ik.createIKChainModel({names: ["S", "E"], lengths: [1, 1], endLength: 1});
          const sols = [
            {x: 1.2, y: -1.2, z: 0}, {x: 0, y: -1.9, z: 0}, {x: -0.8, y: -0.8, z: 0.4},
          ].map((t) => ik.solveTwoBone(model, {x: 0, y: 0, z: 0}, t, {pole: {x: 0, y: 0, z: -1}}));
          return {residuals: sols.map((s) => s.residualStud),
                  converged: sols.map((s) => s.converged)};
        })()""")
        for r in res["residuals"]:
            self.assertLess(r, 0.1, res)
        self.assertTrue(all(res["converged"]), res)

    def test_unreachable_reports_clamp(self):
        res = node_anim("""(() => {
          const model = ik.createIKChainModel({names: ["S", "E"], lengths: [1, 1], endLength: 1});
          const s = ik.solveTwoBone(model, {x: 0, y: 0, z: 0}, {x: 0, y: -10, z: 0});
          return {clamped: s.clamped, converged: s.converged, residual: s.residualStud};
        })()""")
        self.assertTrue(res["clamped"], res)
        self.assertFalse(res["converged"], res)
        self.assertGreater(res["residual"], 0, res)


class ContactLockTest(unittest.TestCase):
    """Exit criterion: contact drift < 0.05 studs after solving."""

    def test_foot_lock_holds(self):
        res = node_anim("""(() => {
          const mk = (t, y) => ({t, pose: {joint: "Foot",
            position: {x: 0, y, z: 0}, rotation: {w: 1, x: 0, y: 0, z: 0},
            semanticRole: "foot"}, easing: "linear", interpolation: "linear"});
          const keys = [mk(0.2, 0), mk(0.5, 0.18), mk(0.8, 0.3)];
          const tracks = {Foot: keys};
          const spec = {name: "Plant", type: "FOOT", joint: "Foot",
            worldPosition: {x: 0, y: 0, z: 0},
            startTime: 0.2, endTime: 0.8, stiffness: 1, tolerance: 0.05};
          const src = ct.rigidWorldSource(tracks);
          const rep = ct.solveContactLock(spec, keys, src, (joint, t, d) => {
            const k = tracks[joint].find((x) => Math.abs(x.t - t) < 1e-9);
            if (k) { k.pose.position.x += d.x; k.pose.position.y += d.y; k.pose.position.z += d.z; }
          });
          const after = ct.detectContactBreak(spec, keys, ct.rigidWorldSource(tracks));
          return {before: rep.maxDriftBeforeStud, after: rep.maxDriftAfterStud,
                  adjusted: rep.keysAdjusted, locked: after.locked};
        })()""")
        self.assertAlmostEqual(res["before"], 0.3, places=6)
        self.assertLess(res["after"], 0.05, res)
        self.assertTrue(res["locked"], res)
        self.assertGreater(res["adjusted"], 0, res)


class ContactSurfaceTest(unittest.TestCase):
    """Static pins: solver surfaces on both sides of the bridge."""

    def test_ts_surfaces(self):
        for token in ("solveTwoBone", "solveCCD", "solveIKChain", "fkChain",
                      "bakeIKToKeys", "createIKChain", "createIKChainModel",
                      "setIKTarget", "sortChainsByPriority", "smoothRotations"):
            self.assertIn(token, TS_IK, token)
        for token in ("quatFromTo", "quatRotateVec"):
            self.assertIn(token, read("mcp-server", "src", "animation", "quaternion.ts"), token)
        for token in ("validateContactSpec", "detectContactBreak", "solveContactLock",
                      "rigidWorldSource", "ContactBreak", "LockReport"):
            self.assertIn(token, TS_CONTACTS, token)

    def test_luau_surfaces(self):
        for fn in ("create", "setTarget", "setPole", "setWeight", "setEnabled",
                   "remove", "describe"):
            self.assertIn("function IK." + fn, LUAU_IK, "IK." + fn)
            self.assertIn("function IK." + fn, PLUGIN, "inline IK." + fn)
        for fn in ("resolveJoint", "drivenPart", "measure", "applyLock",
                   "createLock", "releaseLock", "enforceAll"):
            self.assertIn("function Contacts." + fn, LUAU_CONTACTS, "Contacts." + fn)
            self.assertIn("function Contacts." + fn, PLUGIN, "inline Contacts." + fn)
        for marker in ("--[[IK_BEGIN", "--[[IK_END]]",
                       "--[[CONTACTS_BEGIN", "--[[CONTACTS_END]]"):
            self.assertEqual(PLUGIN.count(marker), 1, marker)

    def test_no_new_tool_branches(self):
        for name in ("IKControl", "applyLock", "enforceAll", "Contacts", "IK."):
            lines = [ln for ln in PLUGIN.splitlines() if name in ln]
            self.assertFalse(any('tool=="%s"' % name in ln for ln in lines),
                             "must not add registry tools in Phase 4")


if __name__ == "__main__":
    unittest.main()
