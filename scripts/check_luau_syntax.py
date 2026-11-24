#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# scripts/check_luau_syntax.py - catch Luau *syntax* errors before Studio does.
#
# Why this exists: scripts/check_luau_blocks.py only balances keywords
# (function/if/for ... end) and counts chunk locals. It is blind to type
# annotations and to unbalanced braces, so it printed
#
#     OK   studio-plugin/RoLink.lua (blocks balanced, lines <= 900)
#
# for a 2.11.0 plugin that Studio could not load at all. Three fatal errors
# shipped in that file:
#
#   660   ...): (number -> number)      -> "Expected ')' (to close '(' at
#                                          column 78), got '-'" (the live bug)
#   1541  Motion.TBL: { [string]: boolean } = {
#                                       -> a type annotation on a *field*
#                                          assignment, which Luau forbids
#   6581  result = { ... note = (... or "...")   with no closing `}`
#                                       -> the whole elseif chain below it was
#                                          swallowed as table fields, so the
#                                          reported error landed ~7000 lines away
#
# A user could not tell any of this from the in-Studio message, and the guard
# said OK. This script checks the three shapes above, and — when a real Luau
# parser is installed — also asks that parser directly.
#
# Usage:
#   python3 scripts/check_luau_syntax.py [file ...]
#
#   If `stylua` or `luau` is on PATH (or STYLUA=/path/to/stylua is set) the real
#   parser is run as well; otherwise the static checks run alone.
#
# Exit 0 when every file passes, 1 otherwise.
import os
import re
import shutil
import subprocess
import sys

DEFAULT_FILES = ["studio-plugin/RoLink.lua"]

# `: (T -> U)` - parentheses wrapping a whole function type. `->` must sit at
# the top level of a type; inside `(...)` the parser expects a type *list*.
_PAREN_FN_TYPE = re.compile(r"\(\s*[^()]*?->[^()]*?\)")

# `Name.Field: T = ...` - annotation on a field assignment. Luau allows
# `local x: T` and params/returns, not `a.b: T = ...`.
#
# The *type* must be a table type (`{...}`) or a bare type name, immediately
# followed by `=`. Requiring that is what keeps method calls such as
# `btn.Click:Connect(function() ... end)` — of which this plugin has hundreds —
# from matching: there the colon is followed by `Name(`.
_ANNOTATED_FIELD_ASSIGN = re.compile(
    r"^[ \t]*(?P<target>[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+)"
    r"[ \t]*:[ \t]*(?:\{[^{}\n]*\}|[A-Za-z_][\w.]*)"
    r"[ \t]*=(?!=)"
)

_KW_AFTER_COLON = {"local", "function", "return", "elseif", "if", "while",
                   "for", "until", "then", "do", "and", "or", "not", "end"}


def _blank_noise(src):
    """Copy of `src` with comments and string bodies blanked out.

    Keeps every byte offset and newline in place so reported line/column
    numbers match the original file. Handles line comments, short strings with
    escapes, and long strings/comments ([[..]], [==[..]==]).
    """
    out = list(src)
    i, n = 0, len(src)

    def blank(a, b):
        for k in range(a, min(b, n)):
            if out[k] != "\n":
                out[k] = " "

    while i < n:
        c = src[i]
        if c == "-" and src.startswith("--", i):
            m = re.match(r"--(\[=*\[)", src[i:])
            if m:                                   # long comment
                close = "]" + m.group(1)[1:]
                j = src.find(close, i + m.end())
                j = n if j < 0 else j + len(close)
            else:                                   # line comment
                j = src.find("\n", i)
                j = n if j < 0 else j
            blank(i, j)
            i = j
        elif c in "\"'":
            j = i + 1
            while j < n:
                if src[j] == "\\":
                    j += 2
                    continue
                if src[j] == c:
                    j += 1
                    break
                if src[j] == "\n":                  # unterminated: stop at EOL
                    break
                j += 1
            blank(i + 1, j - 1)
            i = j
        elif c == "[":
            m = re.match(r"\[(=*)\[", src[i:])
            if m:                                   # long string
                close = "]" + m.group(1) + "]"
                j = src.find(close, i + m.end())
                j = n if j < 0 else j + len(close)
                blank(i + len(m.group(0)), j - len(close))
                i = j
            else:
                i += 1
        else:
            i += 1
    return "".join(out)


def _line_of(src, offset):
    return src.count("\n", 0, offset) + 1


def _col_of(src, offset):
    return offset - (src.rfind("\n", 0, offset) + 1) + 1


def check_source(src, name="<input>"):
    """Return a list of `name:line:col: message` strings. Empty means clean."""
    issues = []
    clean = _blank_noise(src)

    # 1. Parenthesised function types.
    for m in _PAREN_FN_TYPE.finditer(clean):
        line, col = _line_of(src, m.start()), _col_of(src, m.start())
        issues.append(
            "%s:%d:%d: parenthesised function type %r - `->` cannot sit inside "
            "`(...)`; write `(number) -> number`, not `(number -> number)`"
            % (name, line, col, " ".join(src[m.start():m.end()].split())))

    # 2. Type annotation on a field assignment.
    for idx, text in enumerate(clean.split("\n"), start=1):
        m = _ANNOTATED_FIELD_ASSIGN.match(text)
        if not m:
            continue
        head = m.group("target")
        if head.split(".")[0] in _KW_AFTER_COLON:
            continue
        issues.append(
            "%s:%d:1: type annotation on field assignment `%s` - Luau only "
            "allows `: T` on local declarations and function signatures; "
            "annotate the table's type separately or drop the annotation"
            % (name, idx, head))

    # 3. Unbalanced braces. Studio reports this thousands of lines away, so the
    #    opening line is recorded and reported instead.
    stack = []
    for off, ch in enumerate(clean):
        if ch == "{":
            stack.append(off)
        elif ch == "}":
            if stack:
                stack.pop()
            else:
                issues.append("%s:%d:%d: `}` with no matching `{`"
                              % (name, _line_of(src, off), _col_of(src, off)))
    for off in stack:
        issues.append(
            "%s:%d:%d: `{` is never closed - Studio reports this far below the "
            "real cause (a following `elseif` inside a table literal)"
            % (name, _line_of(src, off), _col_of(src, off)))

    # 4. Indexing a `local function` (a SEMANTIC error, not a syntax one).
    #    `local function f() end` makes f a function VALUE; `f.x = 1` then
    #    raises "attempt to index function with 'x'" AT RUNTIME. The plugin
    #    shipped exactly that (``rlSeamScore.bridgeThreshold = 50``) at chunk
    #    scope, so the chunk aborted and Studio loaded no plugin at all.
    #    No parser can see this - `stylua --check` accepts it happily - which
    #    is why it lives here rather than in check_luau_blocks.py.
    issues.extend(_function_index_issues(clean, src, name))

    return issues


# `local function NAME` declares a function VALUE. Luau never lets you index
# one, so any `NAME.field` / `NAME[...]` is a runtime error the moment it runs.
_LOCAL_FUNCTION = re.compile(r"^[ \t]*local[ \t]+function[ \t]+([A-Za-z_]\w*)")
# A later `local NAME = ...` in an enclosing/enclosing-visible scope rebinds the
# name (usually to a table), which makes the indexing legal. Only compare names
# at the same indentation depth or shallower, to stay conservative.
_LOCAL_REBIND = re.compile(r"^([ \t]*)local[ \t]+([A-Za-z_]\w*)[ \t]*=(?!=)")


def _function_index_issues(clean, src, name):
    """Flag `name.field` / `name[...]` where `name` is a `local function`.

    Deliberately conservative, because the plugin reuses short names (`c`,
    `w`, `props`) as loop variables and inner locals hundreds of times. A name
    is only reported when it is unambiguous:

      * the `local function` is at the SAME indent as the indexing use (so a
        deeper inner scope such as a `for _, c in ...` is a different variable),
      * the name is never rebound by `local NAME =` anywhere in the file
        (that would usually make it a table),
      * and it is not a parameter name in that function's own signature.
    """
    lines = clean.split("\n")

    declared = {}
    for idx, text in enumerate(lines, start=1):
        m = _LOCAL_FUNCTION.match(text)
        if m:
            declared.setdefault(m.group(1), []).append(
                (idx, len(text) - len(text.lstrip(" \t"))))
    if not declared:
        return []

    # Every parameter name used by any `local function`. A name that is also a
    # parameter somewhere is too ambiguous to report (the plugin reuses `c`,
    # `w`, `props` as both function names and parameter/loop names).
    parameter_names = set()
    for text in lines:
        m = re.match(r"^[ \t]*local[ \t]+function[ \t]+[A-Za-z_]\w*\s*\(([^)]*)\)",
                     text)
        if m:
            for q in m.group(1).split(","):
                q = q.strip().split(":")[0].strip()
                if q:
                    parameter_names.add(q)

    rebound = set()
    for text in lines:
        m = _LOCAL_REBIND.match(text)
        if m:
            rebound.add(m.group(2))

    issues = []
    for base, decls in declared.items():
        if base in rebound or base in parameter_names:
            continue
        for idx, text in enumerate(lines, start=1):
            indent = len(text) - len(text.lstrip(" \t"))
            # Only the scope the function was declared in.
            if not any(idx > d and indent == di for d, di in decls):
                continue
            m = re.search(r"\b%s\b(?=[.\[])" % re.escape(base), text)
            if not m:
                continue
            issues.append(
                "%s:%d:%d: `%s` is a `local function` (declared line %d), so "
                "indexing it raises \"attempt to index function\" at RUNTIME "
                "and kills the whole chunk. Hold the fields on a table literal: "
                "`local %s = { threshold = 50, tip = function() end }` (call it "
                "via `%s.score(...)` then)"
                % (name, idx, m.start() + 1, base, decls[0][0], base, base))
    return issues


def _real_parser():
    """Path to a real Luau parser, or None. STYLUA=... wins."""
    override = os.environ.get("STYLUA")
    if override and os.path.exists(override):
        return [override, "stylua"]
    found = shutil.which("luau")
    if found:
        return [found, "luau"]
    found = shutil.which("stylua")
    if found:
        return [found, "stylua"]
    return None


def check_parse(path, parser):
    """Ask the real parser. Returns issues; [] means it parsed."""
    exe, kind = parser
    if kind == "luau":
        cmd = [exe, "--check", path]
        ok_codes = (0,)
    else:
        # `stylua --check` exits 2 on a parse error, 1 when it merely wants to
        # reformat (which is not a syntax problem).
        cmd = [exe, "--check", path]
        ok_codes = (0, 1)
    try:
        proc = subprocess.run(cmd, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, timeout=120)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return ["%s: could not run %s (%s)" % (path, os.path.basename(exe), exc)]
    if proc.returncode in ok_codes:
        return []
    detail = (proc.stderr or proc.stdout).decode("utf-8", "replace").strip()
    lines = [ln.strip(" -") for ln in detail.splitlines() if ln.strip()]
    return ["%s: %s" % (path, ln) for ln in lines[:10]] or \
           ["%s: parser exit %d" % (path, proc.returncode)]


def main(argv):
    files = argv[1:] or DEFAULT_FILES
    parser = _real_parser()
    bad = 0
    for path in files:
        try:
            with open(path, encoding="utf-8") as fh:
                src = fh.read()
        except OSError as exc:
            print("SKIP %s (%s)" % (path, exc))
            continue
        issues = check_source(src, path)
        if parser:
            issues += check_parse(path, parser)
        if issues:
            bad += len(issues)
            for i in issues:
                print("FAIL " + i)
        else:
            print("OK   %s (syntax: annotations, field assigns, braces%s)"
                  % (path, ", real parser" if parser else ""))
    if not parser:
        print("note: no `luau`/`stylua` on PATH (or set STYLUA=...) - static "
              "checks only")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
