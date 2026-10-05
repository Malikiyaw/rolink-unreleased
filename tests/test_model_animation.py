# tests/test_model_animation.py - Phase 1 engine + Phase 3 dock widget.
#   py -3 tests/test_model_animation.py
# Static pins (no Studio): the widget must exist, reuse the rl* engine
# (chat/UI parity), guard Play mode, restore originals, and never
# reintroduce HUD markers or break the poll path.
import io, os, re, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


def read(*parts):
    with io.open(os.path.join(ROOT, *parts), encoding="utf-8", errors="replace") as f:
        return f.read()


ENGINE_FNS = ["rlAnimRoot", "rlAnimFolder", "rlAnimRead", "rlAnimWrite",
              "rlJointKind", "rlModelAnalyze", "rlModelCreate", "rlPoseNum",
              "rlModelSetKey", "rlModelSetEase", "rlModelAddMarker",
              "rlLerp3", "rlPoseAt", "rlMag3", "rlRound2", "rlTrackNames",
              "rlModelPreview", "rlModelValidate", "rlAnimDuplicate",
              "rlModelRetime", "rlModelReverse", "rlMirrorTrackName",
              "rlModelMirror", "rlModelBlend", "rlModelFix",
              "rlModelWriteFresh", "rlNeutralKeys", "rlKeyAt",
              "rlModelAttack", "rlModelIdle", "rlModelWalk"]

TOOLS = ["analyze_animatable_model", "create_model_animation",
         "set_model_keyframe", "set_model_easing", "add_animation_marker",
         "preview_model_animation", "validate_model_animation",
         "retime_animation", "reverse_animation", "mirror_animation",
         "blend_animation", "fix_animation", "create_attack_animation",
         "create_idle_animation", "create_walk_cycle"]


class ModelAnimationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.plugin = read("studio-plugin", "RoLink.lua")

    def test_engine_functions_defined_once(self):
        for f in ENGINE_FNS:
            self.assertEqual(len(re.findall(r"local function " + f + r"\b", self.plugin)), 1,
                             f + " must be defined exactly once")

    def test_dispatch_branches_before_fallback(self):
        fb = self.plugin.find("generic fallback: try run_code")
        self.assertGreater(fb, 0)
        for n in TOOLS:
            i = self.plugin.find('tool=="%s"' % n)
            self.assertGreater(i, 0, n + " branch missing")
            self.assertLess(i, fb, n + " branch must precede the generic fallback")

    def test_confirm_gate_on_overwrite(self):
        self.assertIn("CONFIRM_REQUIRED", self.plugin)

    def test_easing_reuses_shared_resolver(self):
        seg = self.plugin[self.plugin.find("rlModelSetKey"):self.plugin.find("rlModelSetKey") + 3000]
        self.assertIn("resolveEasing", seg)
        self.assertIn("EASE_LIST", self.plugin)

    def test_widget_exists_and_toggles(self):
        for s in ("CreateDockWidgetPluginGui", "RoLinkModelAnim",
                  '"Anim"', "rlBuildAnimWidget", "rlAnimPlay", "rlAnimStop",
                  "rlAnimRenderTimeline", "rlAnimRenderRig"):
            self.assertIn(s, self.plugin, "widget missing: " + s)

    def test_widget_reuses_engine(self):
        seg = self.plugin[self.plugin.find("dock widget"):]
        for f in ("rlModelAnalyze", "rlModelCreate", "rlModelSetKey",
                  "rlModelValidate", "rlAnimRead", "rlAnimWrite", "rlPoseAt"):
            self.assertIn(f, seg, "widget bypasses engine: " + f)

    def test_playback_guards_and_restores(self):
        seg = self.plugin[self.plugin.find("local function rlAnimPlay"):]
        seg = seg[:seg.find("local function rlAnimStop") + 4000]
        self.assertIn("IsRunning", seg, "Edit-only guard missing")
        self.assertIn("rlAnimRestore", seg, "originals never restored")
        self.assertIn("SetWaypoint", seg, "no undo waypoint")

    def test_no_hud_markers(self):
        for m in ("Visualizer", "VHud", "VLog", "VStats", "hudBtn",
                  "hologram", "RoLinkHUD"):
            self.assertNotIn(m, self.plugin, "HUD remnant: " + m)

    def test_poll_path_intact(self):
        for s in ("local function poll()", "pcall(executeCommand",
                  "reportResult(cmd.id, result, err, elapsed",
                  "local function executeCommand", "/queue/next", "/queue/result"):
            self.assertIn(s, self.plugin, "poll path broken: " + s)

    def test_no_block_open_semicolon_paren(self):
        # Studio 2026-09: a statement starting with ";(" directly after
        # then/do/else fails the whole plugin ("Expected identifier ...,
        # got ';'") while mid-block instances parse. Ban the position.
        lines = self.plugin.splitlines()
        bad = []
        for i, ln in enumerate(lines):
            if re.match(r"^\s*;\s*\(", ln):
                prev = ""
                for j in range(i - 1, -1, -1):
                    s = lines[j].strip()
                    if s and not s.startswith("--"):
                        prev = s
                        break
                if re.search(r"\b(then|do|else|repeat)\s*$", prev):
                    bad.append("line %d after %r" % (i + 1, prev[-60:]))
        self.assertEqual(bad, [], "block-open ;( : " + "; ".join(bad))

    def test_no_mock_tool_branches(self):
        for n in TOOLS:
            lines = [ln for ln in self.plugin.splitlines() if '"%s"' % n in ln]
            self.assertTrue(lines, n + " branch missing")
            self.assertFalse(any("mock" in ln.lower() for ln in lines),
                             n + " looks like a mock")

    def test_track_lock_chain(self):
        for f in ("rlAnimGetLocked", "rlAnimSetLocked", "rlModelTrackLock"):
            self.assertEqual(len(re.findall(r"local function " + f + r"\b", self.plugin)), 1,
                             f + " must be defined exactly once")
        self.assertIn('tool=="set_track_lock"', self.plugin)
        seg = self.plugin[self.plugin.find("local function rlModelSetKey"):]
        seg = seg[:seg.find("local function rlModelSetEase") + 2000]
        self.assertIn("TRACK_LOCKED", seg, "set_keyframe must refuse locked tracks")
        self.assertIn("RL_ANIM_COLORS", self.plugin, "palette table missing")

    def test_moon_layout_elements(self):
        seg = self.plugin[self.plugin.find("dock widget"):]
        for s in ("rlAnimUI.titleLbl", "menuLoad", "menuAnalyze",
                  "menuValidate", "menuPlay", "rlAnimUI.ruler",
                  "rlAnimUI.trackList", "rlAnimUI.playhead",
                  "rlAnimRenderTracks", "rlAnimLoadAll"):
            self.assertIn(s, seg, "layout element missing: " + s)

    def test_menu_buttons_do_real_work(self):
        seg = self.plugin[self.plugin.find("local function rlBuildAnimWidget"):]
        self.assertIn("pcall(rlAnimLoadAll)", seg)
        self.assertIn("pcall(rlAnimRenderRig)", seg)
        self.assertIn("pcall(rlAnimPlay)", seg)

    def test_builder_name_matches_call_site(self):
        import re as _re
        defs = set(_re.findall(r"local function (rl\w*Anim\w*Widget)\(\)", self.plugin))
        calls = set(_re.findall(r"pcall\((rl\w*Anim\w*Widget)\)", self.plugin))
        self.assertTrue(defs, "widget builder definition missing")
        self.assertEqual(calls, defs, "call site %s != definition %s" % (calls, defs))

    def test_widget_diagnostics_are_loud(self):
        self.assertIn("editor build failed", self.plugin)
        self.assertIn("animation editor ", self.plugin)
        self.assertIn("did not build", self.plugin)
        self.assertIn("anim build 6", self.plugin)

    def test_composites_share_helpers(self):
        seg = self.plugin[self.plugin.find("composites + generators"):]
        for f in ("rlAnimDuplicate", "rlAnimWrite", "rlAnimRead",
                  "rlPoseAt", "rlLerp3", "rlModelValidate"):
            self.assertIn(f, seg, "composite duplicates logic: " + f)

    def test_generators_share_scaffold_writer(self):
        seg = self.plugin[self.plugin.find("composites + generators"):]
        for f in ("rlModelWriteFresh", "rlModelAttack", "rlModelIdle", "rlModelWalk"):
            self.assertIn(f, seg, "generator missing: " + f)


if __name__ == "__main__":
    unittest.main()
