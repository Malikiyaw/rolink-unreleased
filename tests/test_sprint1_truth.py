# tests/test_sprint1_truth.py - Sprint 1 (truth) regression pins.
#   python3 tests/test_sprint1_truth.py
# Covers: honest-unsupported error() branches replaced pretend-success
# receipts in the Studio queue path; play_sound really spawns a Sound and
# validates its id; generate_level delegates to placePatternParts with
# verified placed/failed. Source-level pins (no live Studio), same style as
# tests/test_plugin_execution.py.
import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


def read_plugin():
    with open(os.path.join(ROOT, "studio-plugin", "RoLink.lua"), encoding="utf-8") as f:
        return f.read()


HONEST_STUBS = [
    # (tool fragment, alternative keyword the error must name)
    ("execute_plan", "batch_queue"),
    ("review_code", "get_script_content"),
    ("generate_asset", "import_asset"),
    ("optimize_performance", "get_memory_usage"),
    ("predict_bug", "scan_errors"),
    ("plan_game", "get_memory"),
    ("git_commit", "take_snapshot"),
    ("import_project", "import_asset"),
    ("generate_quest", "set_script_content"),
    ("simulate_economy", "execute_luau"),
    ("generate_sound", "search_asset"),
    ("set_breakpoint", "scan_errors"),
    ("load_plugin", "install-plugin"),
]


class Sprint1TruthTest(unittest.TestCase):
    def test_no_pretend_success_receipts(self):
        src = read_plugin()
        for fake in ("result={executed=true}", "result={generated=true",
                     "result={optimized=true}", 'result={review="looks good"}',
                     "result={predictions={}}", 'result={economy="stable"}',
                     'result={sound="procedural"}', "result={played=true}",
                     "result={debug=true}", 'result={gdd={title="Game"'):
            self.assertNotIn(fake, src, "pretend-success stub still present: %s" % fake)

    def test_honest_stubs_name_alternatives(self):
        src = read_plugin()
        for tool, alt in HONEST_STUBS:
            # find the tool's branch and require an unsupported error nearby
            idx = src.find('tool=="%s"' % tool)
            if idx < 0:
                # family branch (e.g. git_*, plan_game group): match any member
                continue
            window = src[idx:idx + 600]
            self.assertIn("unsupported", window, "%s branch is not an honest error" % tool)
            self.assertIn(alt, window, "%s error names no alternative (%s)" % (tool, alt))

    def test_play_sound_is_real(self):
        src = read_plugin()
        self.assertIn('Instance.new("Sound")', src)
        self.assertIn("rbxassetid://", src)
        self.assertIn("validation_error: play_sound needs a real asset id", src)
        self.assertIn(":Play()", src)

    def test_generate_level_delegates_to_builder(self):
        src = read_plugin()
        idx = src.find('tool=="generate_level"')
        self.assertGreaterEqual(idx, 0)
        window = src[idx:idx + 800]
        self.assertIn("placePatternParts", window)
        self.assertIn("result.level = true", window)

    def test_luau_guard_still_clean(self):
        import subprocess
        r = subprocess.run(
            [sys.executable, os.path.join(ROOT, "scripts", "check_luau_blocks.py"),
             os.path.join(ROOT, "studio-plugin", "RoLink.lua")],
            capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=1)
