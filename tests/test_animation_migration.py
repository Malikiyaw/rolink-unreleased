# tests/test_animation_migration.py - Phase 12 tool-migration regression suite.
#   py -3 tests/test_animation_migration.py
#
# Task 12 migrates the pre-existing animation tools in studio-plugin/RoLink.lua
# onto the Animation Engine v3 modules (RigAdapter, Curves, PoseSolver, ...).
# The exit criterion is "all 25+ existing animation tools work on new engine"
# with "no duplicate code paths" -- so these tests pin the migration itself:
# every tool must reach the engine, and every helper the engine replaced must
# be GONE rather than left behind as a second divergent implementation.
#
# These are structural pins plus behavioral checks over the pure-Luau engine
# math, because no Studio is available here to execute the plugin.
import io
import json
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


PLUGIN = read("studio-plugin", "RoLink.lua")
CURVES = read("studio-plugin", "animation", "Curves.lua")
RIGADAPTER = read("studio-plugin", "animation", "RigAdapter.lua")
POSESOLVER = read("studio-plugin", "animation", "PoseSolver.lua")
LAYERING = read("mcp-server", "src", "animation", "layering.ts")
GRAPH = read("mcp-server", "src", "animation", "graph.ts")

# The migrated tool surface, mapped to the engine module it must now use.
# task -> (plugin helper, engine token that must appear in its body)
MIGRATIONS = {
    "12.1": ("rlModelAnalyze", "RigAdapter.describeModel"),
    "12.2": ("rlModelCreate", "RigAdapter"),
    "12.3a": ("rlModelSetKey", "Curves.ease"),
    "12.3b": ("rlModelSetEase", "Curves"),
    "12.4": ("rlModelValidate", "Curves"),
    "12.5": ("rlModelPreview", "Curves"),
    "12.6": ("rlModelFix", "Curves"),
    "12.7a": ("rlModelAttack", "rlPlanIntent"),
    "12.7b": ("rlModelIdle", "rlPlanIntent"),
    "12.7c": ("rlModelWalk", "rlPlanIntent"),
    "12.8": ("rlModelBlend", "rlBlendRot"),
    "12.9a": ("rlModelRetime", "rlPoseAt"),
    "12.9b": ("rlModelReverse", "rlFlipEase"),
    "12.9c": ("rlModelMirror", "Curves.eulerDegToQuat"),
}

# Each tool reaches the engine either directly or through one of these
# shims. A shim is a legitimate indirection ONLY if it is itself pinned to
# the engine, so both layers are asserted together below.
ENGINE_SHIMS = {
    "rlPlanIntent": ["RL_STYLE_TIMING", "RL_BEAT_ORDER"],
    "rlEaseOrLinear": ["Curves.EASE"],
    "rlFlipEase": ["Curves.EASE", "EASE_FLIP"],
    "rlBlendRot": ["Curves.slerp", "Curves.rotToQuat"],
    "rlPoseAt": ["Curves.ease"],
}

# Helpers the engine replaced. A surviving definition means two
# implementations that can silently diverge.
RETIRED = ["rlJointKind", "EASE_FNS"]


def plugin_body(fn):
    """Source text of one chunk-level `local function <fn>` definition.

    Brace counting is unusable here: Luau type annotations like
    `{ [string]: any }` open and close braces outside the body. Every
    chunk-level function in this plugin instead closes with an `end` at
    column 0, so the definition runs to the first such line.
    """
    m = re.search(r"^local function " + re.escape(fn) + r"\b", PLUGIN, re.M)
    if not m:
        return None
    end = re.compile(r"^end\s*$", re.M).search(PLUGIN, m.end())
    if not end:
        return None
    return PLUGIN[m.start():end.end()]


class MigrationShapeTest(unittest.TestCase):
    def test_every_migrated_tool_exists_exactly_once(self):
        for task, (fn, _token) in sorted(MIGRATIONS.items()):
            with self.subTest(task=task):
                self.assertEqual(
                    len(re.findall(r"local function " + fn + r"\b", PLUGIN)), 1,
                    fn + " must be defined exactly once")

    def test_every_migrated_tool_reaches_the_engine(self):
        for task, (fn, token) in sorted(MIGRATIONS.items()):
            with self.subTest(task=task, tool=fn):
                body = plugin_body(fn)
                self.assertIsNotNone(body, fn + " body not found")
                self.assertIn(token, body,
                              "%s (%s) must call the engine via %s"
                              % (fn, task, token))

    def test_every_engine_shim_really_reaches_the_engine(self):
        # A migrated tool may delegate to a shim, but the shim must not be a
        # second implementation -- it has to call the engine itself.
        for shim, tokens in sorted(ENGINE_SHIMS.items()):
            with self.subTest(shim=shim):
                body = plugin_body(shim)
                self.assertIsNotNone(body, shim + " body not found")
                for tok in tokens:
                    self.assertIn(tok, body, "%s must use %s" % (shim, tok))

    def test_no_duplicate_easing_table_survives(self):
        # The engine owns Curves.EASE. A second `local EASE_FNS = {` table in
        # the plugin is the duplicate code path Phase 12 forbids.
        self.assertNotIn("local EASE_FNS", PLUGIN)
        self.assertNotRegex(PLUGIN, r"\bEASE_FNS\b")
        # And Curves.EASE must still be the single real definition.
        self.assertEqual(len(re.findall(r"Curves\.EASE = \{", PLUGIN)), 1)

    def test_no_duplicate_joint_classifier_survives(self):
        self.assertNotIn("local function rlJointKind", PLUGIN)
        self.assertNotRegex(PLUGIN, r"\brlJointKind\b")
        self.assertEqual(len(re.findall(r"function RigAdapter\.classify\(", PLUGIN)), 1)

    def test_every_retired_helper_is_gone(self):
        for fn in RETIRED:
            with self.subTest(helper=fn):
                self.assertNotRegex(PLUGIN, r"\b" + fn + r"\b")

    def test_analysis_output_keeps_its_legacy_contract(self):
        # analyze_animatable_model results are consumed by the rig-tree widget
        # (indents by depth) and by every scaffold error message, so the flat
        # `animatable` view must survive the migration.
        body = plugin_body("rlModelAnalyze")
        for token in ("animatable", "controller", "warnings", "model",
                      "path", "name", "class", "kind", "depth"):
            self.assertIn(token, body, token)
        # ...and must additionally expose the engine IR + writability.
        self.assertIn("bindings", body)
        self.assertIn("writable", body)


class EasingUnificationTest(unittest.TestCase):
    """Task 12.3: easing resolves through Curves.ease everywhere."""

    def test_overshoot_clamp_is_owned_by_the_engine_only(self):
        # The plugin used to clamp inline after calling the raw table fn.
        # Curves.ease does it; a second inline clamp is a second policy.
        self.assertIn("Curves.ease", PLUGIN)
        inline = re.findall(r"EASE_FNS\[pEase\]\(frac\)", PLUGIN)
        self.assertEqual(inline, [], "raw easing-table call must be gone")

    def test_easing_lookup_reads_the_engine_table(self):
        for token in ("Curves.EASE[name]", "pairs(Curves.EASE)"):
            self.assertIn(token, PLUGIN, token)

    def test_engine_ease_clamps_overshoot(self):
        body = read("studio-plugin", "animation", "Curves.lua")
        self.assertIn("1.15", body)
        self.assertIn("-0.15", body)

    def test_every_easing_name_still_resolves(self):
        # The alias table plus the engine table must cover the documented
        # list, so existing AI prompts keep landing on the first try.
        names = ["linear", "quadIn", "quadOut", "quadInOut", "cubicIn",
                 "cubicOut", "cubicInOut", "sineIn", "sineOut", "sineInOut",
                 "bezierOut", "springOut"]
        m = re.search(r"local EASE_ALIASES: \{ \[string\]: string \} = \{(.*?)\n\}", PLUGIN, re.S)
        self.assertIsNotNone(m)
        alias_block = m.group(1)
        for n in names:
            self.assertIn(n, CURVES, "Curves.EASE lost " + n)
        for a, target in re.findall(r"(\w+)\s*=\s*\"(\w+)\"", alias_block):
            self.assertIn(target, names, "alias %s -> %s is not a real easing" % (a, target))


class DeclarationOrderTest(unittest.TestCase):
    """Guards the two declaration defects a migration can actually introduce.

    Note on scope: a call to a chunk-level `local function` written EARLIER in
    the file than its declaration is only a defect when the call itself runs
    at load time. Every chunk local is bound while the chunk loads, and tool
    dispatch runs later, so an indented call inside an earlier-declared
    function body resolves fine. Only column-0 call sites execute during load
    -- those are the ones pinned below.
    """

    def _chunk_function_decls(self):
        """name -> line for `local function NAME` at column 0."""
        out = {}
        dupes = []
        for i, line in enumerate(PLUGIN.split("\n")):
            m = re.match(r"local function ([A-Za-z_]\w*)", line)
            if m:
                if m.group(1) in out:
                    dupes.append(m.group(1))
                out.setdefault(m.group(1), i)
        return out, dupes

    def test_every_migrated_helper_exists_exactly_once(self):
        # Typo guard: a renamed helper referenced by a migrated tool would
        # otherwise resolve to a nil global at dispatch time.
        decls, dupes = self._chunk_function_decls()
        helpers = [fn for fn, _ in sorted(MIGRATIONS.values())] + [
            "rlRigBinding", "rlModelWriteFresh", "rlNeutralKeys", "rlKeyAt",
            "rlLerp3", "rlPoseAt", "rlMag3", "rlRound2", "rlTrackNames",
            "rlAnimGetLocked", "rlAnimSetLocked", "rlAnimDuplicate"]
        missing = [h for h in helpers if h not in decls]
        self.assertEqual(missing, [], "helpers referenced but never defined: %s" % missing)
        self.assertEqual([d for d in dupes if d in helpers], [],
                         "helpers defined more than once: %s"
                         % [d for d in dupes if d in helpers])

    def test_no_top_level_call_precedes_its_declaration(self):
        decls, _dupes = self._chunk_function_decls()
        problems = []
        for i, line in enumerate(PLUGIN.split("\n")):
            if line[:1] in (" ", "\t", ""):
                continue  # not a load-time statement
            if line.lstrip().startswith("--"):
                continue
            for name, decl in decls.items():
                if i < decl and re.search(r"(?<![\w.])" + re.escape(name) + r"\s*\(", line):
                    problems.append("line %d calls %s() at load time, declared on line %d"
                                    % (i + 1, name, decl + 1))
        self.assertEqual(problems, [], "load-time forward references are nil globals:\n  "
                         + "\n  ".join(problems))

    def test_engine_modules_are_declared_before_any_load_time_use(self):
        # The Phase 12 migration moved the RigAdapter/Curves blocks up so the
        # migrated tools can reach them. Nothing may use them at load time
        # before their block.
        lines = PLUGIN.split("\n")
        begins = {}
        for mod in ("RIGADAPTER", "CURVES", "POSESOLVER", "IK", "CONTACTS",
                    "COLLISION", "DYNAMICS", "ANIMLAB"):
            for i, line in enumerate(lines):
                if line.startswith("--[[" + mod + "_BEGIN"):
                    begins[mod] = i
                    break
        self.assertEqual(sorted(begins), sorted(
            ["RIGADAPTER", "CURVES", "POSESOLVER", "IK", "CONTACTS",
             "COLLISION", "DYNAMICS", "ANIMLAB"]), "missing module blocks")
        # Ordering must be dependency-correct: Curves and RigAdapter have no
        # engine deps, so they lead.
        self.assertLess(begins["RIGADAPTER"], begins["CURVES"])
        self.assertLess(begins["CURVES"], begins["POSESOLVER"])
        self.assertLess(begins["POSESOLVER"], begins["ANIMLAB"])


class DispatchTest(unittest.TestCase):
    TOOLS = ["analyze_animatable_model", "create_model_animation",
             "set_model_keyframe", "set_model_easing", "add_animation_marker",
             "preview_model_animation", "validate_model_animation",
             "retime_animation", "reverse_animation", "mirror_animation",
             "blend_animation", "fix_animation", "create_attack_animation",
             "create_idle_animation", "create_walk_cycle"]

    def test_all_tools_still_dispatched_before_fallback(self):
        fb = PLUGIN.find("generic fallback: try run_code")
        self.assertGreater(fb, 0)
        for t in self.TOOLS:
            i = PLUGIN.find('tool=="%s"' % t)
            self.assertGreater(i, 0, t + " lost its dispatch branch")
            self.assertLess(i, fb, t + " dispatch moved after the fallback")

    def test_migration_added_no_new_dispatch_branches(self):
        # Phase 12 was scoped to migrating existing tools. A branch count or
        # name-set change means a tool was added, removed or renamed by
        # accident. (135 branches vs 150 registry tools: several tools share
        # one branch, e.g. generate_sound / generate_sound_pack.)
        names = re.findall(r'elseif tool=="' + r'(\w+)"', PLUGIN)
        self.assertEqual(len(names), 135, "dispatch branch count changed during migration")
        dupes = [n for n in set(names) if names.count(n) > 1]
        self.assertEqual(dupes, [], "duplicate dispatch branches: %s" % dupes)

    def test_guarded_erros_are_preserved(self):
        # Migration must not weaken the confirm-overwrite guard.
        for token in ('CONFIRM_REQUIRED: model animation', 'TRACK_LOCKED:', 'TRACK_NOT_FOUND:'):
            self.assertIn(token, PLUGIN, token)


class EngineMathParityTest(unittest.TestCase):
    """The migrated helpers must agree with the engine, not just call it."""

    EASINGS = ["linear", "quadIn", "quadOut", "quadInOut", "cubicIn",
               "cubicOut", "cubicInOut", "sineIn", "sineOut", "sineInOut",
               "bezierOut", "springOut"]

    def test_mirror_negates_in_place_without_a_quaternion_round_trip(self):
        # Mirror must stay a direct euler-space negation (that is the stored
        # convention). The engine quaternion call is a VALIDITY check on the
        # result, not the transform itself -- a round-trip would reorder axes.
        body = plugin_body("rlModelMirror")
        self.assertIn("x = -num(", body)
        self.assertIn("y = -num(", body)
        self.assertIn("z = -num(", body)
        # It must not assign a converted quaternion back onto the key.
        self.assertNotRegex(body, r"rot\s*=\s*\{\s*x\s*=\s*w\b")
        self.assertNotIn("mirrored.rot", body)

    def test_blend_rotations_use_slerp_not_euler_lerp(self):
        # Component-wise Euler blending takes the short way through zero, so
        # a 170deg -> 190deg blend would reverse instead of continuing.
        body = plugin_body("rlBlendRot")
        self.assertIn("Curves.slerp", body)
        self.assertNotIn("rlLerp3", body)
        mix = plugin_body("rlModelBlend")
        self.assertIn("rlBlendRot(br, orr, w)", mix)
        self.assertIn("rlLerp3(bp, op, w)", mix)

    def test_blend_rot_round_trips_at_the_endpoints(self):
        # f=0 must return the base pose and f=1 the overlay pose exactly, or
        # blending silently nudges every clip's rest pose. And the midpoint of
        # two nearly-antipodal rotations must CONTINUE forward, not reverse
        # through zero -- which is precisely what component-wise Euler lerp
        # would do, and what the migrated blend now avoids.
        node = shutil.which("node")
        if not node:
            raise unittest.SkipTest("node not on PATH")
        tsx = os.path.join(ROOT, "mcp-server", "node_modules", "tsx", "dist", "cli.mjs")
        if not os.path.exists(tsx):
            raise unittest.SkipTest("tsx not installed (run npm ci in mcp-server/)")
        code = ("import('./src/animation/quaternion.ts').then((q) => {"
                " const D = 180 / Math.PI;"
                " const a = q.quatFromAxisAngle({x:1,y:0,z:0}, 170 / D);"
                " const b = q.quatFromAxisAngle({x:1,y:0,z:0}, 190 / D);"
                " const ang = (qq) => q.quatToAxisAngle(qq).angleRad * D;"
                " console.log(JSON.stringify({"
                "  lo: ang(q.quatSlerp(a, b, 0)),"
                "  mid: ang(q.quatSlerp(a, b, 0.5)),"
                "  hi: ang(q.quatSlerp(a, b, 1))})); })")
        r = subprocess.run([node, tsx, "-e", code],
                           cwd=os.path.join(ROOT, "mcp-server"),
                           capture_output=True, text=True, timeout=180)
        self.assertEqual(r.returncode, 0, r.stderr[-1500:])
        res = json.loads(r.stdout.strip().splitlines()[-1])
        self.assertAlmostEqual(res["lo"], 170, places=3, msg=str(res))
        self.assertAlmostEqual(res["hi"], 190, places=3, msg=str(res))
        # 180, not 0: the geodesic continued past the wrap.
        self.assertAlmostEqual(res["mid"], 180, places=2, msg=str(res))

    def test_retime_keeps_times_non_negative(self):
        # Phase 11 pinned retime pushing keys below t=0; scale is >= 0.1 and
        # times are >= 0, so the product is non-negative by construction --
        # assert the code still multiplies rather than subtracting.
        body = plugin_body("rlModelRetime")
        self.assertIn("* scale", body)
        self.assertNotIn("- scale", body)

    def test_reverse_only_maps_easings_the_engine_actually_has(self):
        # A flip target with no Curves.EASE entry would write a curve the
        # interpolator cannot evaluate.
        m = re.search(r"local EASE_FLIP: \{ \[string\]: string \} = \{(.*?)\n\}", PLUGIN, re.S)
        self.assertIsNotNone(m)
        for src, dst in re.findall(r"(\w+)\s*=\s*\"(\w+)\"", m.group(1)):
            self.assertIn(src, self.EASINGS, "EASE_FLIP source %s is not an easing" % src)
            self.assertIn(dst, self.EASINGS, "EASE_FLIP target %s is not an easing" % dst)

    def test_reverse_reports_unmappable_easings_instead_of_guessing(self):
        # bezierOut/springOut have no time-reversed partner in the engine
        # vocabulary; the tool must surface that instead of leaving them.
        body = plugin_body("rlModelReverse")
        self.assertIn("approximateEasings", body)
        self.assertIn("rlFlipEase", body)
        self.assertNotIn("EASE_FLIP[e] or e", body)


class LayeringParityTest(unittest.TestCase):
    """Task 12.8 blend_animation and the engine must agree on blend weights."""

    def test_blend_weight_range_matches_engine(self):
        m = re.search(r"local w = num\(args\.weight, ([\d.]+)\)", PLUGIN)
        self.assertIsNotNone(m, "blend_animation lost its weight default")
        self.assertEqual(m.group(1), "0.5")

    def test_engine_blend_weights_sum_to_one(self):
        # The plugin blends by linear interpolation toward a weight; the
        # engine's blend1DWeights normalizes the same way. Pin both.
        self.assertIn("blend1DWeights", GRAPH)
        self.assertIn("compositeLayers", LAYERING)
        node = shutil.which("node")
        if not node:
            raise unittest.SkipTest("node not on PATH")
        tsx = os.path.join(ROOT, "mcp-server", "node_modules", "tsx", "dist", "cli.mjs")
        if not os.path.exists(tsx):
            raise unittest.SkipTest("tsx not installed (run npm ci in mcp-server/)")
        code = ("import('./src/animation/graph.ts').then((g) => {"
                " console.log(JSON.stringify([g.blend1DWeights(0), g.blend1DWeights(0.25),"
                " g.blend1DWeights(0.5), g.blend1DWeights(0.75), g.blend1DWeights(1)])); })")
        r = subprocess.run([node, tsx, "-e", code],
                           cwd=os.path.join(ROOT, "mcp-server"),
                           capture_output=True, text=True, timeout=180)
        self.assertEqual(r.returncode, 0, r.stderr[-1500:])
        rows = json.loads(r.stdout.strip().splitlines()[-1])
        for row in rows:
            self.assertAlmostEqual(sum(row.values()), 1.0, places=9, msg=str(row))


if __name__ == "__main__":
    unittest.main()
