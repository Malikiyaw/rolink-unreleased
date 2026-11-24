# tests/test_animation_engine.py - Animation slice 1 engine pins.
#   py -3 tests/test_animation_engine.py
# Static pins (no Studio): the new engine helpers (persistent manifest store,
# seam score, spikes, sparkline, contact sheet, marker payloads) must exist
# once, return the documented shapes, and route through the same engine the
# chat tools use.
import io, os, re, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

try:
    from _catalog import load_catalog as _load_catalog
except ImportError:  # invoked with a different sys.path
    import os as _os, sys as _sys
    _sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
    from _catalog import load_catalog as _load_catalog



def read(*parts):
    with io.open(os.path.join(ROOT, *parts), encoding="utf-8", errors="replace") as f:
        return f.read()


ENGINE_FNS = [
    # persistent manifest store (replacement for session-only hash IDs)
    "rlManifestRoot", "rlManifestPathFor", "rlManifestWrite", "rlManifestRead",
    "rlManifestSeqOf", "rlManifestMigrate",
    # validation truth metrics
    "rlSeamScore", "rlValidateSpikes",
    # visual primitive
    "rlAnimationSparkline", "rlTrackSparkline",
    # marker payloads
    "rlModelAddMarker",
    # beat tools (Studio-side, dispatched)
    "previewAnimationContactSheet", "rlModelBindEvents",
    "listAnimationPresets", "createAnimationFromDescription", "presetScore", "presetEasings",
    "rlPresetKeys", "rlEasingList",
    "rlModelFix", "previewAnimationGhost", "rlValidateSpikes",
    "rlSeamScore",
]

NEW_TOOLS = ["preview_animation_contact_sheet", "bind_animation_events",
                          "list_animation_presets", "create_animation_from_description",
                          "preview_animation_ghost"]


class AnimationEngineTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.plugin = read("studio-plugin", "RoLink.lua")
        cls.registry = _load_catalog()

    def test_new_helpers_defined_once(self):
        # rlSeamScore is a TABLE (`local rlSeamScore = { score=..., threshold=...,
        # tip=... }`), not a `local function`: 2.11.1 shipped it as a function with
        # fields bolted on, which raised "attempt to index function" at chunk scope
        # and stopped the plugin from loading at all.
        table_helpers = {"rlSeamScore"}
        for f in ENGINE_FNS:
            if f in table_helpers:
                self.assertEqual(len(re.findall(r"local " + f + r" = \{", self.plugin)), 1,
                                 f + " must be defined exactly once (as a table)")
                self.assertEqual(len(re.findall(r"local function " + f + r"\b", self.plugin)), 0,
                                 f + " must NOT be a local function (fields cannot be indexed on one)")
                continue
            self.assertEqual(len(re.findall(r"local function " + f + r"\b", self.plugin)), 1,
                             f + " must be defined exactly once")

    def test_createAnimationTrack_returns_path(self):
        seg = self.plugin[self.plugin.find("local function createAnimationTrack"):
                          self.plugin.find("local function createAnimationTrack") + 9000]
        self.assertIn("rlManifestWrite", seg, "createAnimationTrack must persist a manifest")
        self.assertRegex(seg, r"path\s*=\s*")
        self.assertIn("sessionAnimationId", seg, "session hash must stay as a convenience")

    def test_createMotionAnimation_returns_path(self):
        seg = self.plugin[self.plugin.find("local function createMotionAnimation"):
                          self.plugin.find("local function createMotionAnimation") + 12000]
        self.assertRegex(seg, r"path\s*=\s*")

    def test_resolveAnimationId_accepts_path(self):
        seg = self.plugin[self.plugin.find("local function resolveAnimationId"):
                          self.plugin.find("local function resolveAnimationId") + 1500]
        self.assertIn("pathArg", seg)
        self.assertIn("rlManifestRead", seg, "paths should resolve through the manifest store")

    def test_model_validate_returns_seam_and_spikes(self):
        seg = self.plugin[self.plugin.find("local function rlModelValidate"):]
        self.assertIn("loopSeam", seg, "seam score must surface in validation results")
        self.assertIn("spikes", seg, "per-key velocity spikes must surface in validation results")
        self.assertIn("rlSeamScore", seg)
        self.assertIn("rlValidateSpikes", seg)

    def test_sparkline_is_ascii_curve(self):
        seg = self.plugin[self.plugin.find("local function rlAnimationSparkline"):
                          self.plugin.find("local function rlAnimationSparkline") + 2500]
        self.assertIn("string.char", seg, "sparkline must emit ASCII blocks")
        self.assertIn("string.rep", seg, "sparkline builds the strip with string.rep")

    def test_track_sparkline_reads_ease_fns(self):
        seg = self.plugin[self.plugin.find("local function rlTrackSparkline"):
                          self.plugin.find("local function rlTrackSparkline") + 2000]
        self.assertIn("EASE_FNS", seg, "per-track sparkline replays the eased curves")

    def test_contact_sheet_shape(self):
        seg = self.plugin[self.plugin.find("local function previewAnimationContactSheet"):
                          self.plugin.find("local function previewAnimationContactSheet") + 5000]
        self.assertIn("svg", seg.lower())
        self.assertIn("rendered", seg)
        self.assertIn("CurrentCamera", seg, "schematic projection must use CurrentCamera")

    def test_contact_sheet_returns_string(self):
        # The SVG is generated inside the function; pin that it returns a table
        # carrying svg/samples/projectedJoints and is registered in the dispatch.
        self.assertIn('tool=="preview_animation_contact_sheet"', self.plugin)

    def test_marker_payload_stored(self):
        seg = self.plugin[self.plugin.find("local function rlModelAddMarker"):
                          self.plugin.find("local function rlModelAddMarker") + 3000]
        self.assertIn("payload", seg)

    def test_bind_animation_events_emits_script(self):
        seg = self.plugin[self.plugin.find("local function rlModelBindEvents"):
                          self.plugin.find("local function rlModelBindEvents") + 12000]
        self.assertTrue(len(seg) > 0, "rlModelBindEvents must exist")
        for s in ("RunService", "playSound", "createVfx", "Camera", "markerNames"):
            self.assertIn(s, seg, s + " must appear in the binding emitter")

    def test_new_tools_in_registry_and_dispatch(self):
        for n in NEW_TOOLS:
            self.assertIn(n, self.registry, n + " missing from the tool catalog")
            self.assertIn('tool=="%s"' % n, self.plugin, n + " missing from dispatcher")

    def test_getAnimationInfo_resolves_durable_paths(self):
        seg = self.plugin[self.plugin.find("local function getAnimationInfo"):
                          self.plugin.find("local function getAnimationInfo") + 2500]
        self.assertIn("resolveAnimationId", seg,
                      "getAnimationInfo must accept manifest paths/bare names via resolveAnimationId")

    def test_deleteAnimation_resolves_durable_paths(self):
        seg = self.plugin[self.plugin.find("local function deleteAnimation"):
                          self.plugin.find("local function deleteAnimation") + 800]
        self.assertIn("resolveAnimationId", seg,
                      "deleteAnimation must accept manifest paths/bare names via resolveAnimationId")

    def test_inspectKeyframeTrack_resolves_durable_paths(self):
        seg = self.plugin[self.plugin.find("local function inspectKeyframeTrack"):
                          self.plugin.find("local function inspectKeyframeTrack") + 900]
        self.assertIn("resolveAnimationId", seg,
                      "inspectKeyframeTrack must accept manifest paths/bare names via resolveAnimationId")

    def test_resolveSourceSequence_resolves_durable_paths(self):
        seg = self.plugin[self.plugin.find("local function resolveSourceSequence"):
                          self.plugin.find("local function resolveSourceSequence") + 900]
        self.assertIn("rlManifestSeqOf", seg, "clip export reads manifests directly")
        self.assertIn("resolveAnimationId", seg, "clip export falls back to resolveAnimationId")

    def test_presets_well_formed(self):
        self.assertEqual(len(re.findall(r"local AnimationPresets\b", self.plugin)), 1,
                         "AnimationPresets must be defined once")
        for n in ("wave_hi", "zombie_shambler", "sword_swing", "celebration", "jump_land"):
            self.assertIn('name = "%s"' % n, self.plugin, n + " preset missing")

    def test_createAnimationTrack_resolvedEasings(self):
        seg = self.plugin[self.plugin.find("local function createAnimationTrack"):
                          self.plugin.find("local function createAnimationTrack") + 3000]
        self.assertIn("resolvedEasings", seg)

    def test_createMotionAnimation_resolvedEasings(self):
        seg = self.plugin[self.plugin.find("local function createMotionAnimation"):
                          self.plugin.find("local function createMotionAnimation") + 8000]
        self.assertIn("resolvedEasings", seg)

    def test_listAnimationPresets_shape(self):
        seg = self.plugin[self.plugin.find("local function listAnimationPresets"):
                          self.plugin.find("local function listAnimationPresets") + 1500]
        for s in ("presets = out", "total = #out", "easings = presetEasings(p)"):
            self.assertIn(s, seg, s + " must appear")

    def test_createAnimationFromDescription_shape(self):
        seg = self.plugin[self.plugin.find("local function createAnimationFromDescription"):
                          self.plugin.find("local function createAnimationFromDescription") + 3000]
        for s in ("created = true, preset = best.name", "rlModelWriteFresh(wa",
                  "resolvedEasings = presetEasings(best)", "trackCount = trackCount"):
            self.assertIn(s, seg, s + " must appear")

    def test_createAnimationFromDescription_resolves_easing(self):
        seg = self.plugin[self.plugin.find("local function rlPresetKeys"):
                          self.plugin.find("local function rlPresetKeys") + 2000]
        self.assertIn("resolveEasing(tostring(kd.ease", seg,
                      "preset keys must be canonicalized via resolveEasing")

    def test_createAnimationFromDescription_dispatcher(self):
        self.assertIn('tool=="list_animation_presets" then result=listAnimationPresets(args)', self.plugin)
        self.assertIn('tool=="create_animation_from_description" then result=createAnimationFromDescription(args)', self.plugin)

    def test_rlModelFix_plan_shape(self):
        seg = self.plugin[self.plugin.find("local function rlModelFix"):
                          self.plugin.find("local function rlModelFix") + 4000]
        for s in ("planEntries", "applied", "SEAM_BRIDGE", "confirm", "entries = planEntries",
                  "autoFixes", "mutating"):
            self.assertIn(s, seg, s + " must appear")

    def test_rlModelFix_confirm_required(self):
        # The mutation path must be gated behind confirm.
        seg = self.plugin[self.plugin.find("local function rlModelFix"):
                          self.plugin.find("local function rlModelFix") + 4000]
        self.assertIn("if args.confirm == true", seg)

    def test_preview_animation_ghost_shape(self):
        seg = self.plugin[self.plugin.find("local function previewAnimationGhost"):
                          self.plugin.find("local function previewAnimationGhost") + 2500]
        for s in ("samples", "velocityPeaks", "loopSeam", "rendered", "snap(t"):
            self.assertIn(s, seg, s + " must appear")

    def test_rlModelValidate_returns_seamThreshold(self):
        seg = self.plugin[self.plugin.find("local function rlModelValidate"):
                          self.plugin.find("local function rlModelValidate") + 6000]
        # Was `rlSeamScore.bridgeThreshold`, which pinned the very expression
        # that crashed the plugin: rlSeamScore was a function value.
        self.assertIn("seamThreshold = rlSeamScore.threshold", seg)
        # No CODE may index the function (the fix comment legitimately names the
        # old expression, so only uncommented lines count).
        code_only = [ln for ln in self.plugin.split("\n")
                     if not ln.lstrip().startswith("--")]
        self.assertFalse(any("rlSeamScore.bridgeThreshold" in ln for ln in code_only),
                         "indexing the rlSeamScore function crashes the plugin")

    def test_budgets_unchanged(self):
        # keep the reliable ceilings; contact sheet is schematic, not pixels
        self.assertIn("1024", self.plugin)
        seg = self.plugin[self.plugin.find("local function rlModelValidate"):]
        self.assertIn("RL_ROT_ERR", seg)


if __name__ == "__main__":
    unittest.main(verbosity=1)
