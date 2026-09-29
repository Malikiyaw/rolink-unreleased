# SPDX-License-Identifier: GPL-3.0-or-later
# tests/test_luau_static.py - static guards for the Studio plugin source.
#
# Why this file exists: on 2.13.0 a Luau RESERVED WORD was used as a table key
# (`{ kind = "text_label", in = "Header" }`). Luau cannot parse it, so Studio
# refused to load the plugin at all and the only symptom was one line in the
# Output window. The brace-balance checker passed, and every plugin test was a
# string grep - so 408 green tests shipped a plugin that could not load.
#
# These tests pin the check that now catches that class of bug without Studio.
#
# Run: py -m unittest tests.test_luau_static -v
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "scripts"))

import check_luau_blocks as luau
import check_luau_syntax as syntax

PLUGIN = os.path.join(ROOT, "studio-plugin", "RoLink.lua")

# Legal Luau that a naive "is a keyword near an = sign" scan would false-fire
# on. Every one of these shipped in real Roblox code.
LEGAL = """
-- a comment mentioning in = sync and not = a key
for k, v in pairs(t) do print(k, v) end
for i = 1, 10 do acc += i end
while a < b do a += 1 end
repeat a -= 1 until a <= 0
local a = { type = 1, ["in"] = 2, x = 3 }
local b = a.in2
local c = a["in"]
local d = a["type"]
if x == 1 and y ~= 2 then return end
if x >= 1 or y <= 2 then return end
local s = "in = still not a key"
local t = 'end = nope'
local kind = "text_label"
do
  local inner = 1
  inner += 1
end
local function f(x)
  return x
end
return f(1)
"""

# Each of these is a hard Luau parse error.
ILLEGAL = [
    ('local D = { a = { in = "Header" } }', "table key", "in"),
    ('local D = { if = 1 }', "table key", "if"),
    ('local D = { else = 1 }', "table key", "else"),
    ('local D = { end = 1 }', "table key", "end"),
    ('local D = { nil = 1 }', "table key", "nil"),
    ('local D = { true = 1 }', "table key", "true"),
    ('local v = t.in', "field access", "in"),
    ('local v = t.end', "field access", "end"),
    ('t.in = 5', "field access", "in"),
    ('local D = { while = 1 }', "table key", "while"),
    ('local D = { function = 1 }', "table key", "function"),
    ('local D = { local = 1 }', "table key", "local"),
]


class ReservedWordTest(unittest.TestCase):
    """The exact bug that broke 2.13.0."""

    def test_catches_every_illegal_shape(self):
        for src, kind, word in ILLEGAL:
            hits = luau.reserved_field_hits(src)
            self.assertTrue(hits, "MISSED: %r" % src)
            self.assertIn((kind, word), [(h[2], h[3]) for h in hits], src)

    def test_no_false_positives_on_legal_luau(self):
        self.assertEqual(luau.reserved_field_hits(LEGAL), [],
                         "legal Luau must stay clean")

    def test_reported_line_is_the_real_line(self):
        src = "local a = 1\nlocal b = 2\nlocal D = { in = 1 }\n"
        hits = luau.reserved_field_hits(src)
        self.assertEqual(len(hits), 1)
        self.assertEqual(hits[0][0], 3)

    def test_strings_and_comments_cannot_trigger_it(self):
        for src in ('local s = "in = 1"', "-- in = 1", 'local s = [[ in = 1 ]]',
                    'local s = [==[ end = 2 ]==]'):
            self.assertEqual(luau.reserved_field_hits(src), [], src)

    def test_mask_preserves_geometry(self):
        src = 'local a = "xx"\nlocal in = 1\n'
        masked = luau.mask_literals(src)
        self.assertEqual(len(masked), len(src))
        self.assertEqual(masked.count("\n"), src.count("\n"))
        self.assertIn("local in = 1", masked)

    def test_contextual_words_are_allowed_as_fields(self):
        """type/export/continue are legal field names in Luau - flagging them
        would make the checker useless through false alarms."""
        for src in ("local t = { type = 1 }", "local v = x.type",
                    "local t = { export = 1 }", "local t = { continue = 1 }"):
            self.assertEqual(luau.reserved_field_hits(src), [], src)


class PluginIsCleanTest(unittest.TestCase):
    """The shipped plugin must pass every static check, with no Studio."""

    def test_plugin_has_no_reserved_field_hits(self):
        with open(PLUGIN, encoding="utf-8") as f:
            hits = luau.reserved_field_hits(f.read())
        self.assertEqual(hits, [], "reserved Luau word used as a field name")

    def test_plugin_passes_full_check(self):
        self.assertEqual(luau.check(PLUGIN), [])

    def test_check_reports_reserved_words_in_check_output(self):
        """A hit must reach the CLI output, not just the helper."""
        import io
        import tempfile
        with tempfile.NamedTemporaryFile("w", suffix=".lua", delete=False,
                                         encoding="utf-8") as f:
            f.write('local D = { in = 1 }\n')
            path = f.name
        try:
            buf = io.StringIO()
            old, sys.stdout = sys.stdout, buf
            try:
                rc = luau.main(["check_luau_blocks.py", path])
            finally:
                sys.stdout = old
            self.assertEqual(rc, 1)
            self.assertIn("reserved Luau word 'in'", buf.getvalue())
        finally:
            os.unlink(path)


class RealCompilerTest(unittest.TestCase):
    """The authoritative gate, when the official Luau compiler is available.

    Skipped (never silently passed) when it is not installed - fetch it with
    `py scripts/check_luau_syntax.py --download`.
    """

    def setUp(self):
        self.exe = syntax.find_compiler()
        if not self.exe:
            self.skipTest("no luau-compile; run scripts/check_luau_syntax.py --download")

    def _write(self, body):
        fd, path = tempfile.mkstemp(suffix=".lua")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(body)
        self.addCleanup(os.unlink, path)
        return path

    def test_shipped_plugin_parses(self):
        errs, _note = syntax.run_compiler(self.exe, PLUGIN)
        self.assertEqual(errs, [], "Studio would refuse to load this plugin")

    def test_compiler_rejects_the_2_13_bug(self):
        """The real compiler, on the exact shape that shipped broken."""
        path = self._write('local D = { kind = "text_label", in = "Header" }\n')
        errs, _ = syntax.run_compiler(self.exe, path)
        self.assertTrue(errs, "luau-compile accepted a reserved word as a key")
        self.assertIn("SyntaxError", errs[0][2])
        self.assertIn("'in'", errs[0][2])

    def test_compiler_accepts_legal_luau(self):
        errs, _ = syntax.run_compiler(self.exe, self._write(LEGAL))
        self.assertEqual(errs, [], "legal Luau must parse clean")

    def test_compiler_accepts_the_renamed_field(self):
        errs, _ = syntax.run_compiler(
            self.exe, self._write('local D = { kind = "label", parentStep = "Header" }\n'))
        self.assertEqual(errs, [])

    def test_script_exit_codes(self):
        self.assertEqual(syntax.main(["x", PLUGIN]), 0)
        self.assertEqual(syntax.main(["x", self._write('local D = { in = 1 }\n')]), 1)


class NoCompilerFallbackTest(unittest.TestCase):
    """Without the compiler the script must never look like a clean pass."""

    def _hide_compiler(self):
        """Point the lookup at nothing, and ALWAYS put the originals back.

        Restoring via addCleanup matters: unittest orders classes
        alphabetically, so a leak here would silently skip every
        RealCompilerTest that runs afterwards.
        """
        orig_dirs, orig_which = syntax.SEARCH_DIRS, syntax.which
        syntax.SEARCH_DIRS = [os.path.join(ROOT, "definitely", "not", "here")]
        syntax.which = lambda *_a, **_k: None

        def restore():
            syntax.SEARCH_DIRS = orig_dirs
            syntax.which = orig_which

        self.addCleanup(restore)

    def test_missing_compiler_is_reported_not_hidden(self):
        self._hide_compiler()
        self.assertIsNone(syntax.find_compiler())

    def test_lookup_is_still_usable_afterwards(self):
        """Guards the global leak this class is capable of causing."""
        real = syntax.find_compiler()
        self._hide_compiler()
        self.assertIsNone(syntax.find_compiler())
        self.doCleanups()
        self.assertEqual(syntax.find_compiler(), real)

    def test_fallback_still_catches_reserved_words(self):
        """The dependency-free path must still catch the 2.13.0 bug."""
        import io
        self._hide_compiler()
        fd, path = tempfile.mkstemp(suffix=".lua")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write('local D = { kind = "label", in = "Header" }\n')
        self.addCleanup(os.unlink, path)
        buf = io.StringIO()
        old, sys.stdout = sys.stdout, buf
        try:
            rc = syntax.main(["x", path])
        finally:
            sys.stdout = old
        self.assertEqual(rc, 1)
        out = buf.getvalue()
        self.assertIn("reserved Luau word 'in'", out)
        self.assertIn("never parsed", out)
        # One report per violation, not two.
        self.assertEqual(out.count("reserved Luau word 'in'"), 1, out)


if __name__ == "__main__":
    unittest.main(verbosity=1)
