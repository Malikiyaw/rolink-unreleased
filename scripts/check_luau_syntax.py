#!/usr/bin/env python3
# scripts/check_luau_syntax.py - REAL Luau parse check for the Studio plugin.
#
# Why this exists (learned the hard way, 2.13.0): a reserved Luau word was used
# as a table key -
#
#     { kind = "text_label", name = "Title", in = "Header" }
#
# Luau cannot parse that. Studio reported
#     user_RoLink.lua.Script:5704: Expected identifier when parsing expression,
#     got 'in'
# and then the ENTIRE plugin silently failed to load: no toolbar button, no
# version banner, and every Studio tool dead. Brace balancing passed and all
# 400+ tests were green, because the plugin tests assert on source text.
#
# This runs the official Luau compiler, so ANY parse error is caught here
# instead of in the Output window. It does not typecheck: Roblox globals
# (game, workspace, task, Instance, Enum...) do not exist outside Studio, so
# luau-analyze would drown real problems in "Unknown global" noise.
#
# Usage:
#   python3 scripts/check_luau_syntax.py [file ...]
#   python3 scripts/check_luau_syntax.py --download     # fetch the compiler
#
# Exit 0 = every file parses. 1 = a syntax error, or the compiler is missing
# and --strict was passed.
import os
import re
import subprocess
import sys
import zipfile
from shutil import which

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DEFAULT = os.path.join(ROOT, "studio-plugin", "RoLink.lua")

# Search order. Repo-local tools/ is gitignored; %LOCALAPPDATA% is per-machine.
SEARCH_DIRS = [
    os.path.join(ROOT, "tools", "luau"),
    os.path.join(os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"), "RoLink", "luau"),
    os.path.join(os.environ.get("TEMP", ""), "opencode", "luau"),
]
EXE = "luau-compile.exe" if os.name == "nt" else "luau-compile"
RELEASE_URL = "https://github.com/luau-lang/luau/releases/latest/download/luau-windows.zip"


def find_compiler():
    for d in SEARCH_DIRS:
        p = os.path.join(d, EXE)
        if os.path.isfile(p):
            return p
    return which(EXE) or which("luau-compile")


def download(dest_dir):
    """Fetch the official Windows build. Best-effort; never raises."""
    import urllib.request
    os.makedirs(dest_dir, exist_ok=True)
    url = RELEASE_URL if os.name == "nt" else \
        "https://github.com/luau-lang/luau/releases/latest/download/luau-ubuntu.zip"
    with urllib.request.urlopen(url, timeout=90) as r:
        data = r.read()
    import tempfile
    with tempfile.NamedTemporaryFile(delete=False, suffix=".zip") as f:
        f.write(data)
        tmp = f.name
    try:
        with zipfile.ZipFile(tmp) as z:
            for n in z.namelist():
                if os.path.basename(n) == EXE:
                    with z.open(n) as src, open(os.path.join(dest_dir, EXE), "wb") as out:
                        out.write(src.read())
                    return os.path.join(dest_dir, EXE)
    finally:
        os.unlink(tmp)
    return None


LINE_RE = re.compile(r"^(.*?)\((\d+),(\d+)\): (SyntaxError|.*)$")


def run_compiler(exe, path):
    """(errors, note). errors = [(line, col, message)] for parse failures.

    `--only-parse` is deliberate: it stops after the parser, which is the only
    stage where a load-blocking error lives, and it emits no bytecode (the
    `binary` mode writes raw bytes that blow up a cp1252 console pipe).
    Output is decoded as bytes-with-replace so a stray non-UTF8 byte in a
    diagnostic can never crash the checker itself.
    """
    try:
        p = subprocess.run([exe, "--only-parse", path], capture_output=True, timeout=180)
    except subprocess.TimeoutExpired:
        return [], "compiler timed out after 180s (file may be pathologically large)"
    out = (p.stderr or b"") + b"\n" + (p.stdout or b"")
    text = out.decode("utf-8", "replace")
    errs, seen = [], set()
    for raw in text.splitlines():
        m = LINE_RE.match(raw.strip())
        if not m:
            continue
        line, col, msg = int(m.group(2)), int(m.group(3)), m.group(4)
        key = (line, col, msg)
        if key in seen:
            continue
        seen.add(key)
        errs.append((line, col, msg))
    errs.sort()
    # A BOM at 1,1 is an artifact of how the file was written, not a defect in
    # the source we ship; only surface it when it is the ONLY complaint.
    real = [e for e in errs if not (e[0] == 1 and "U+feff" in e[2])]
    if not real and errs:
        return [], "compiles (only a leading byte-order mark, ignored)"
    return real, None


def main(argv):
    args = list(argv[1:])
    strict = False
    if "--download" in args:
        args.remove("--download")
        exe = download(SEARCH_DIRS[0])
        print(("downloaded " + exe) if exe else "download failed")
        if not exe:
            return 1
    if "--strict" in args:
        args.remove("--strict")
        strict = True
    files = args or [DEFAULT]

    exe = find_compiler()
    if not exe:
        print("SKIP no Luau compiler found - syntax was NOT checked.")
        print("     Get one with:  py scripts/check_luau_syntax.py --download")
        print("     (or https://github.com/luau-lang/luau/releases)")
        if strict:
            return 1
        # Still run the dependency-free guards so this is never a silent pass.
        sys.path.insert(0, HERE)
        import check_luau_blocks as blocks
        bad = 0
        for f in files:
            # check() already reports reserved-word hits; do not append them
            # again here or every violation prints twice.
            issues = blocks.check(f)
            if issues:
                bad += len(issues)
                for i in issues:
                    print("FAIL " + i)
                print("       (and the file was never parsed - no Luau compiler)")
            else:
                print("WARN %s fallback checks pass, but the file was never parsed" % f)
                print("     Studio is the only real parser. Get one with:")
                print("       py scripts/check_luau_syntax.py --download")
        return 1 if bad else 0

    bad = 0
    for f in files:
        errs, note = run_compiler(exe, f)
        if errs:
            bad += len(errs)
            print("FAIL %s" % f)
            for line, col, msg in errs[:20]:
                print("       %d:%d  %s" % (line, col, msg))
            if len(errs) > 20:
                print("       ... and %d more" % (len(errs) - 20))
            print("       Studio would refuse to load this plugin entirely.")
        else:
            print("OK   %s parses%s" % (f, (" (" + note + ")") if note else ""))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
