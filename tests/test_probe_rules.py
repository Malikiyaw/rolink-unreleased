"""Guards the two probe defects that cost this project five Studio runs.

1. PAREN TRUNCATION
   `local _, y, _ = ((expr):Method())` looks like it unpacks three values.
   It does not: surrounding the call in parentheses truncates it to one
   return, so `y` receives the FIRST value and the third is nil. The v5
   probe died on `invalid argument #1 to 'deg' (number expected, got nil)`
   for exactly this reason.

2. SETTLING BEFORE REPLICATION FINISHES
   `Workspace.Rig_A` replicates as a shell first: 3 children, 0 parts, 0
   joints. Around two seconds later it has 19 children, 16 parts and 15
   joints. An instant scan reports "no rig"; a probe that caches the Model
   from WaitForChild can keep a stale reference and never see the body.
   The probe must re-resolve by name and wait for parts to appear.

Both are static properties of the probe sources, so they are checked here
rather than in Studio.
"""
import os
import re
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROBES = os.path.join(ROOT, "docs", "probes")


def _probe_files():
    if not os.path.isdir(PROBES):
        return []
    return [
        os.path.join(PROBES, name)
        for name in sorted(os.listdir(PROBES))
        if name.endswith(".lua") and "broken" not in name
    ]


def _read(path):
    with open(path, "r", encoding="utf-8") as handle:
        return handle.read()


def _code_lines(text):
    """Source lines with comments stripped, so prose about a bug is not a hit."""
    out = []
    for line in text.splitlines():
        stripped = line.lstrip()
        if stripped.startswith("--"):
            continue
        out.append(line.split("--")[0] if "--" in line else line)
    return out


class TestProbeParenTruncation(unittest.TestCase):
    """No probe may unpack a multi-return call through parentheses."""

    # `((anything):Method(` or `((expr)):` - the wrapper that truncates.
    WRAPPED_CALL = re.compile(r"\(\s*\([^()]*\)\s*:")
    # `local _, x, _ = (` at the start of an unpacking assignment.
    UNPACK_FROM_PAREN = re.compile(r"local\s+[^=]*=\s*\(")

    def test_probe_files_found(self):
        self.assertTrue(_probe_files(), "no probe sources to check in docs/probes")

    def test_no_paren_wrapped_multireturn_call(self):
        for path in _probe_files():
            for number, line in enumerate(_code_lines(_read(path)), start=1):
                with self.subTest(probe=os.path.basename(path), line=number):
                    self.assertIsNone(
                        self.WRAPPED_CALL.search(line),
                        "%s:%d wraps a call in parentheses, which truncates "
                        "multiple returns to one value: %s"
                        % (os.path.basename(path), number, line.strip()),
                    )

    def test_yaw_helper_present_when_euler_unpacked(self):
        """A probe reading Euler angles must do it through a plain helper."""
        for path in _probe_files():
            text = "\n".join(_code_lines(_read(path)))
            if "ToEulerAnglesYXZ" not in text:
                continue
            with self.subTest(probe=os.path.basename(path)):
                self.assertRegex(
                    text,
                    r"local\s+_\s*,\s*\w+\s*,\s*_\s*=\s*\w+\.?[\w]*:ToEulerAnglesYXZ\(\)",
                    "%s reads Euler angles without the plain 3-value unpack; "
                    "use a helper that does `local _, y, _ = cf:ToEulerAnglesYXZ()`"
                    % os.path.basename(path),
                )


class TestProbeWaitsForReplication(unittest.TestCase):
    """A probe must not treat an early, part-less snapshot as the final rig."""

    def test_probe_declares_a_parts_threshold(self):
        sources = _probe_files()
        self.assertTrue(sources, "no probe sources to check in docs/probes")
        holders = [p for p in sources if "MIN_PARTS" in _read(p)]
        self.assertTrue(
            holders,
            "no probe defines MIN_PARTS; a probe must require a minimum part "
            "count before treating the rig as ready (the rig replicates as a "
            "0-part shell first)",
        )

    def test_probe_re_resolves_rig_by_name(self):
        for path in _probe_files():
            text = _read(path)
            if "MIN_PARTS" not in text:
                continue
            with self.subTest(probe=os.path.basename(path)):
                self.assertIn(
                    "Workspace:FindFirstChild",
                    text,
                    "%s must re-resolve the rig with Workspace:FindFirstChild "
                    "inside its wait loop, not cache it once" % os.path.basename(path),
                )

    def test_probe_is_not_named_as_a_server_script(self):
        """Animation evaluates client-side; a probe is a LocalScript."""
        for path in _probe_files():
            with self.subTest(probe=os.path.basename(path)):
                self.assertFalse(
                    path.endswith(".server.lua"),
                    "%s is named .server.lua but animation must be probed from "
                    "a LocalScript (AnimationTrack.Length is 0 on the server)"
                    % os.path.basename(path),
                )


if __name__ == "__main__":
    unittest.main()
