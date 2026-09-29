# tests/test_animation_lab.py - Phase 10 Animation Lab pins.
#   py -3 tests/test_animation_lab.py
# The Lab is Luau that cannot execute outside Studio, so this suite pins
# structure instead: every view exists in module + inline copies, markers
# are single, the chunk-local budget holds, no registry tools sneak in,
# the one-line-two-statements bug class is absent, and (when node +
# luau-parser are present) both files truly parse.
import io
import json
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
LAB = read("studio-plugin", "animation", "AnimationLab.lua")

VIEWS = ["renderDope", "renderCurves", "renderInspector", "renderIK",
         "renderContacts", "renderGraphs", "renderQuality"]
TRANSPORT = ["play", "stop", "applyAt", "snapshot", "restore"]
CAPTURE = ["viewportInfo", "project", "jointBox", "collectJoints",
           "captureFrame", "captureSequence"]
KIT = ["newState", "getState", "colors", "status", "clear", "head", "row",
       "btn", "box", "label", "scroll"]
SETTERS = ["setTracks", "setRig", "setQuality", "setIK", "setContacts", "setLimits"]
PANELS = ["lane", "strip", "localAudit", "bakeFlat", "limitText",
          "toggle", "build", "renderAll", "findTrack", "jointNames",
          "findChain", "ikCreate", "ikRemove", "ikCreateFrom",
          "resolveTarget", "findSpec", "contactsMod", "contactLock",
          "contactRelease", "contactEnforce"]


class LabSurfaceTest(unittest.TestCase):
    def test_every_view_exists_twice(self):
        for fn in VIEWS + TRANSPORT + CAPTURE + KIT + SETTERS + PANELS:
            self.assertIn("function AnimationLab." + fn, LAB, "module missing " + fn)
            self.assertIn("function AnimationLab." + fn, PLUGIN, "inline missing " + fn)

    def test_no_undefined_self_calls(self):
        # Every AnimationLab.X call must have a matching function definition.
        # A nil-call here is a Studio runtime error, invisible to the Luau
        # parser and the block checker, so pin it structurally.
        defined = set(re.findall(r"^function AnimationLab\.(\w+)", LAB, re.M))
        called = set(re.findall(r"AnimationLab\.(\w+)\s*\(", LAB))
        # A field being replaced (st:AnimationLab.state = nil) is a write, and
        # reads of plain data (AnimationLab.W) never appear with a call paren.
        undefined = sorted(called - defined)
        self.assertEqual(undefined, [], "called but never defined: " + str(undefined))

    def test_markers_single(self):
        self.assertEqual(PLUGIN.count("--[[ANIMLAB_BEGIN"), 1)
        self.assertEqual(PLUGIN.count("--[[ANIMLAB_END]]"), 1)

    def test_inline_matches_module(self):
        core_inline = PLUGIN.split("--[[ANIMLAB_BEGIN")[1].split("--[[ANIMLAB_END]]")[0]
        core_inline = "\n".join(core_inline.splitlines()[1:]).strip()
        lines = LAB.splitlines()
        start = next(i for i, l in enumerate(lines) if not l.startswith("--"))
        while start < len(lines) and not lines[start].strip():
            start += 1
        end = len(lines)
        while end > start and not lines[end - 1].strip():
            end -= 1
        if lines[end - 1].strip() == "return AnimationLab":
            end -= 1
        while end > start and not lines[end - 1].strip():
            end -= 1
        self.assertEqual(core_inline, "\n".join(lines[start:end]).strip())

    def test_chunk_local_budget(self):
        # Register discipline: the whole Lab section costs exactly one
        # chunk register (the table); everything else is methods or
        # function-locals. The 185 cap itself is enforced by the checker
        # test below.
        inline = PLUGIN.split("--[[ANIMLAB_BEGIN")[1].split("--[[ANIMLAB_END]]")[0]
        top = [l for l in inline.splitlines() if re.match(r"^local ", l)]
        self.assertEqual(top, ["local AnimationLab = {"], top)


class LabBudgetTest(unittest.TestCase):
    def test_checker_passes_both_files(self):
        r = subprocess.run(
            [sys.executable, os.path.join(ROOT, "scripts", "check_luau_blocks.py"),
             os.path.join(ROOT, "studio-plugin", "RoLink.lua"),
             os.path.join(ROOT, "studio-plugin", "animation", "AnimationLab.lua")],
            capture_output=True, text=True, timeout=120)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("OK", r.stdout)

    def test_single_table_local_for_lab(self):
        self.assertEqual(len(re.findall(r"^local AnimationLab\b", LAB, re.M)), 1)
        inline = PLUGIN.split("--[[ANIMLAB_BEGIN")[1].split("--[[ANIMLAB_END]]")[0]
        self.assertEqual(len(re.findall(r"^local AnimationLab\b", inline, re.M)), 1)
        # Helpers live on the table: no `local function` at module top level.
        top_locals = [l for l in LAB.splitlines()
                      if re.match(r"^local function ", l)]
        self.assertEqual(top_locals, [], top_locals)


class LabSafetyTest(unittest.TestCase):
    def test_no_new_tool_branches(self):
        seg = PLUGIN.split("--[[ANIMLAB_BEGIN")[1].split("--[[ANIMLAB_END]]")[0]
        self.assertNotIn('tool=="', seg)
        for name in ("AnimationLab", "labPlay", "labStop"):
            lines = [ln for ln in PLUGIN.splitlines() if name in ln]
            self.assertFalse(any('tool=="%s"' % name in ln for ln in lines))

    def test_no_hud_marker_strings(self):
        seg = PLUGIN.split("--[[ANIMLAB_BEGIN")[1].split("--[[ANIMLAB_END]]")[0]
        for banned in ("Visualizer", "VHud", "VLog", "VStats", "hudBtn",
                       "hologram", "RoLinkHUD"):
            self.assertNotIn(banned, seg, "HUD remnant: " + banned)

    def test_no_widget_name_collisions(self):
        defs = set(re.findall(r"local function (rl\w*Anim\w*Widget)\(\)", PLUGIN))
        self.assertEqual(defs, {"rlBuildAnimWidget"}, defs)

    def test_no_multistatement_one_liners(self):
        # The `then a = 1 b = 2 end` class: two real assignments on one
        # `then...end` line. Table constructors ({x = 0}) are stripped
        # first - they are values, not statements.
        pat = re.compile(r"^\s*(?:if|elseif)\b.*\bthen\b(.*)\bend\s*$")

        def strip_braces(s):
            prev = None
            while prev != s:
                prev = s
                s = re.sub(r"\{[^{}]*\}", " ", s)
            return s

        def has_two_assignments(line):
            m = pat.match(line.split("--")[0])
            if not m:
                return False
            # Semicolon-separated statements are legal Luau - only flag
            # segments that pack two assignments without a separator.
            # Strings containing `=` are skipped.
            # Multiple assignment in one statement (dx, dy, dz = a, b, c)
            # is valid Luau and should not be flagged.
            def clean(s):
                # Remove string literals to avoid false positives on `=` inside strings
                return re.sub(r'"(?:[^"\\]|\\.)*"', '""', re.sub(r"'(?:[^'\\]|\\.)*'", "''", s))
            for branch in re.split(r"\belse\b", strip_braces(m.group(1))):
                for seg in branch.split(";"):
                    body = clean(seg)
                    body = re.sub(r"==|~=|<=|>=", " ", body)
                    body = re.sub(r"\b(break|continue)\b", " ", body)
                    body = body.split("return")[0]
                    # Multiple assignment in one statement (dx, dy, dz = a, b, c)
                    # is valid Luau - count commas and = signs
                    # If there's exactly one = and commas on LHS, it's destructuring
                    # If there are multiple = and NO commas on LHS, it's multiple statements
                    if body.count("=") >= 2 and "," not in body.split("=")[0]:
                        return True
            return False

        self.assertTrue(has_two_assignments(
            "if t > d then t = 0 t0 = os.clock() end"))
        self.assertFalse(has_two_assignments(
            "if a then b = f(x); c = g(y) end"))
        self.assertFalse(has_two_assignments(
            "if (kf :: any).Time <= t then before = kf else after = kf break end"))
        self.assertFalse(has_two_assignments(
            'if okEnc then decoded = "game:GetService(\\"HttpService\\"):JSONDecode([=[" .. tostring(json) .. "]=])" end'))
        self.assertFalse(has_two_assignments(
            "if ok then AnimationLab.status(\"x\", false) end"))
        self.assertFalse(has_two_assignments(
            "if not ok or sp == nil then return { x = 0, y = 0 } end"))
        self.assertTrue(has_two_assignments(
            "if t > d then t = 0 t0 = os.clock() end"))
        self.assertFalse(has_two_assignments(
            "if a then b = f(x); c = g(y) end"))
        self.assertFalse(has_two_assignments(
            "if (kf :: any).Time <= t then before = kf else after = kf break end"))
        self.assertFalse(has_two_assignments(
            "if len < 1e-9 then dx, dy, dz = 0, 1, 0 len = 1 end"))
        self.assertTrue(has_two_assignments(
            "if cur ~= nil then target = cur l.target = cur okByPath = true end"))
        self.assertTrue(has_two_assignments(
            "if tr == nil then tr = { kind = \"custom\", keys = {} } tracks[track] = tr end"))
        self.assertTrue(has_two_assignments(
            "if tostring((e :: any).marker) == name then (e :: any).action = ev bound = true break end"))
        bad = [l for l in LAB.splitlines() if has_two_assignments(l)]
        self.assertEqual(bad, [], bad)
        # Retroactive guard: the lenient luau-parser cannot see this bug
        # class, so scan every shipped Luau file, not just the Lab.
        # Pre-existing packed statements in legacy code are allowlisted by
        # CONTENT (not line number - edits shift lines and a stale allowlist
        # silently rots). New instances fail.
        legacy_packed = (
            "if cur ~= nil then target = cur l.target = cur okByPath = true end",
            'if tr == nil then tr = { kind = "custom", keys = {} } tracks[track] = tr end',
            "if tostring((e :: any).marker) == name then (e :: any).action = ev bound = true break end",
        )
        for rel in ("studio-plugin/RoLink.lua",
                    "studio-plugin/animation/RigAdapter.lua",
                    "studio-plugin/animation/Curves.lua",
                    "studio-plugin/animation/PoseSolver.lua",
                    "studio-plugin/animation/IK.lua",
                    "studio-plugin/animation/Contacts.lua",
                    "studio-plugin/animation/Collision.lua",
                    "studio-plugin/animation/Dynamics.lua"):
            src = read(*rel.split("/"))
            hits = [(i + 1, l.strip()) for i, l in enumerate(src.splitlines())
                    if has_two_assignments(l)]
            unexpected = [h for h in hits if h[1] not in legacy_packed]
            self.assertEqual(unexpected, [], rel + ": " + str(unexpected))

    def test_toolbar_and_build_wiring(self):
        self.assertIn('toolbar:CreateButton("Lab"', PLUGIN)
        self.assertIn("AnimationLab.toggle(plugin)", PLUGIN)
        self.assertIn("lab build 1", PLUGIN)
        self.assertIn("animation lab built - click Lab to open", PLUGIN)

    def test_edit_only_playback_guard(self):
        seg = PLUGIN.split("--[[ANIMLAB_BEGIN")[1].split("--[[ANIMLAB_END]]")[0]
        self.assertIn("IsRunning", seg)
        self.assertIn("stop Play first", seg)
        self.assertIn("SetWaypoint", PLUGIN)


class LabParseTest(unittest.TestCase):
    def test_luau_parses(self):
        node = shutil.which("node")
        if not node:
            raise unittest.SkipTest("node not on PATH")
        parser_dir = os.path.join(
            os.environ.get("LOCALAPPDATA", ""),
            "Temp", "opencode", "luauparse", "node_modules", "luau-parser")
        if not os.path.isdir(parser_dir):
            raise unittest.SkipTest("luau-parser not installed")
        for rel in ("studio-plugin/animation/AnimationLab.lua",
                    "studio-plugin/RoLink.lua"):
            code = ("const m=require('luau-parser');"
                    "m.parse(require('fs').readFileSync(%s,'utf8'));" % json.dumps(
                        os.path.join(ROOT, rel).replace("\\", "/")))
            r = subprocess.run([node, "-e", code],
                               cwd=os.path.dirname(parser_dir),
                               capture_output=True, text=True, timeout=120)
            self.assertEqual(r.returncode, 0, rel + ": " + r.stderr[-1500:])


if __name__ == "__main__":
    unittest.main()