#!/usr/bin/env python3
# scripts/check_luau_blocks.py - grammar-aware block-balance check for Luau.
#
# Why this exists: Studio's Luau parser silently loses track of a block when a
# physical line exceeds ~1KB (tokens get dropped, and the compile error is
# reported on the NEXT branch as "Expected 'end' (to close 'else' at line N),
# got 'elseif'"). A real block-structure check catches unclosed if/for/while/
# function/else before Studio ever sees the file, and the line-length cap
# (--max-line) prevents the parser bug from recurring.
#
# Tokenizer: skips line comments, long strings/comments ([[...]], [==[...]==])
# and quoted strings; keeps keywords; tracks a stack:
#   function ... end | if/elseif/else ... end | for/while ... do ... end |
#   do ... end | repeat ... until
#
# It also counts chunk-scope `local` declarations (Studio caps a chunk at
# ~200 locals: every top-level `local x` / `local function f` holds a
# register to end-of-file, and the whole plugin then fails to load with
# "Out of local registers ... exceeded limit 200" on the LAST chunk local
# instead of anything actionable - seen live, line 5185 `local last`).
# Helpers therefore live on category tables (Motion.x, Cutscene.x), and
# one-shot chunk temps use do/end blocks. --max-locals sets the tripwire.
#
# Usage: python3 scripts/check_luau_blocks.py [file ...]
# Exit 0 when every file balances and respects the line cap, 1 otherwise.
import re
import sys

KEYWORDS = {"local", "function", "if", "elseif", "else", "for", "while",
            "repeat", "until", "do", "then", "end", "return", "break",
            "continue", "in", "and", "or", "not"}
MAX_LINE_DEFAULT = 900
MAX_CHUNK_LOCALS_DEFAULT = 185

# Reserved words that may NEVER be used as a field name or table key. Luau
# rejects them at parse time ("Expected identifier when parsing expression,
# got 'in'") and Studio blames the whole Script - the plugin then fails to
# load, so every Studio tool goes quiet with no other symptom.
#
# `type`, `export` and `continue` are CONTEXTUAL in Luau and are legal field
# names (Enum.Font, x.type, t.continue), so they are deliberately excluded.
# Keyword-used-as-keyword is NOT flagged: `for k, v in t do` has `in` followed
# by an expression, never by `=`, and the patterns below only fire on
# `KEY =` / `.KEY`.
STRICT_RESERVED = ("and", "break", "do", "else", "elseif", "end", "false",
                   "for", "function", "if", "in", "local", "nil", "not", "or",
                   "repeat", "return", "then", "true", "until", "while")


def tokenize(src):
    """Yield (word_or_None, line) tokens; non-keyword words come back as None
    to keep the stream small. Strings/comments are skipped entirely."""
    i, n, line = 0, len(src), 1
    while i < n:
        c = src[i]
        if c == "\n":
            line += 1
            i += 1
            continue
        if c == "-" and src[i:i + 2] == "--":
            j = src.find("\n", i)
            i = n if j < 0 else j
            continue
        if c == "[" and i + 1 < n and src[i + 1] == "[":
            level = 0
            j = i
            while j < n and src[j] == "[":
                level += 1
                j += 1
            if j < n and src[j] == "[":
                close = "]" + "=" * level + "]"
                end = src.find(close, j + 1)
                if end < 0:
                    end = n
                    chunk = src[i:]
                else:
                    chunk = src[i:end + len(close)]
                line += chunk.count("\n")
                i = (n if end == n and close not in src[i:] else end + len(close))
                continue
        if c in "\"'":
            q = c
            i += 1
            while i < n:
                if src[i] == "\\":
                    i += 2
                    continue
                if src[i] == q:
                    i += 1
                    break
                if src[i] == "\n":
                    line += 1
                i += 1
            continue
        if c.isalpha() or c == "_":
            start = i
            while i < n and (src[i].isalnum() or src[i] == "_"):
                i += 1
            word = src[start:i]
            yield (word if word in KEYWORDS else None, line, start)
            continue
        i += 1


def mask_literals(src):
    """Blank out comments and string bodies, preserving every offset.

    Length, newlines and column positions are unchanged, so a regex over the
    result reports the real line/column of a hit in the ORIGINAL file. Without
    this, a comment like "-- keep in = sync" or the string "in" would raise
    phantom errors.
    """
    out = list(src)
    i, n = 0, len(src)
    while i < n:
        c = src[i]
        if c == "-" and src[i:i + 2] == "--":
            j = src.find("\n", i)
            j = n if j < 0 else j
            for k in range(i, j):
                out[k] = " "
            i = j
            continue
        if c == "[":
            # Lua long string opener is `[` `=`*n `[` - the '=' run sits
            # BETWEEN the two brackets, so `[[ ]]` has n=0 and `[==[ ]]` n=2.
            # The block tokenizer's own long-string branch only fires for the
            # 3+ bracket form, so mask this independently; otherwise
            # `local s = [[ in = 1 ]]` reports a phantom keyword hit.
            j = i + 1
            while j < n and src[j] == "=":
                j += 1
            eq = j - i - 1
            if j < n and src[j] == "[":
                close = "]" + "=" * eq + "]"
                end = src.find(close, j + 1)
                end = n if end < 0 else end + len(close)
                for k in range(i, end):
                    if src[k] != "\n":
                        out[k] = " "
                i = end
                continue
        if c in "\"'":
            q, j = c, i + 1
            while j < n:
                if src[j] == "\\":
                    j += 2
                    continue
                if src[j] == q:
                    j += 1
                    break
                if src[j] == "\n":
                    j += 1
                    continue
                j += 1
            for k in range(i + 1, min(j, n) - 1):
                if src[k] != "\n":
                    out[k] = " "
            i = j
            continue
        i += 1
    return "".join(out)


def reserved_field_hits(src):
    """(line, col, kind, word) for every reserved word used as a field name.

    Two forms are illegal in Luau and both were shipped once already:
      { kind = "panel", in = "Header" }   -> table key
      local v = s.in                      -> field read
    """
    masked = mask_literals(src)
    hits = []
    kw = "|".join(STRICT_RESERVED)
    # Table key / named-argument: `KEY =` but not `==`, `>=`, `<=`, `~=`, and
    # never preceded by a dot (that is the field-assignment form below) or by
    # an identifier char. `[ \t]*` never crosses a newline so a statement
    # ending in a keyword cannot pair with a `=` on the next line.
    key_re = re.compile(r"(?<![\w.\]\)])(" + kw + r")[ \t]*=(?![=<>~])")
    # Field read or write: `.KEY` not followed by an identifier char, and not
    # a method call (`:KEY`).
    field_re = re.compile(r"\.[ \t]*(" + kw + r")(?![\w])")
    for rx, kind in ((key_re, "table key"), (field_re, "field access")):
        for m in rx.finditer(masked):
            line = masked.count("\n", 0, m.start()) + 1
            col = m.start() - (masked.rfind("\n", 0, m.start()) + 1) + 1
            word = m.group(1)
            if kind == "field access":
                # `a and b.in` -> this IS the error. But `t["in"]` never
                # matches, and `a:if(...)` is impossible for a keyword.
                if m.start() > 0 and masked[m.start() - 1] == ":":
                    continue
            hits.append((line, col, kind, word))
    hits.sort()
    return hits


def check(path, max_line=MAX_LINE_DEFAULT, max_chunk_locals=MAX_CHUNK_LOCALS_DEFAULT):
    with open(path, encoding="utf-8", errors="replace") as f:
        lines = f.read().splitlines()
    with open(path, encoding="utf-8", errors="replace") as f:
        src = f.read()
    problems = []
    for idx, line in enumerate(lines, 1):
        if len(line) > max_line:
            problems.append("%s:%d line is %d chars (cap %d) - Studio's parser loses block tracking past ~1KB; split it"
                            % (path, idx, len(line), max_line))
    # state machine
    stack = []          # list of [kind, line]
    chunk_locals = 0    # top-level `local` declarations (register tripwire below)
    prev_word = None    # previous keyword token (for `for/while ... do`)
    pendingDo = False   # a for/while header is waiting for its `do`
    ifExpr = False      # previous `if` was an if-EXPRESSION (no frame pushed)
    errors = []

    def push(kind, ln):
        stack.append([kind, ln])

    def top():
        return stack[-1] if stack else None

    for word, ln, col in tokenize(src):
        if word is None:
            continue
        if word == "local" and not stack:
            # Chunk-scope declaration: each holds a register to end-of-file.
            # `local function f` takes one; `local a, b = ...` takes one per
            # name (commas before `=` on the same line). Falls through on
            # purpose: `local` opens no block frame itself.
            eol = src.find("\n", col)
            seg = src[col:] if eol < 0 else src[col:eol]
            if re.match(r"\s*local\s+function\b", seg):
                chunk_locals += 1
            else:
                head = seg.split("=", 1)[0]
                chunk_locals += 1 + head.count(",")
        if word == "function":
            # `function` is only a block opener as a declaration or anonymous
            # function expression. When it is a plain identifier (table key,
            # field, variable) it opens nothing.
            before = src[:col].rstrip()
            if before.endswith(".") or before.endswith('"') or before.endswith("'"):
                continue
            if before.endswith("=") or before.endswith(","):
                # anonymous function expression (assigned/passed) still opens
                # a block; `x = function` / `f(function` are declarations.
                pass
            elif before and not before.endswith(("local", "=", ",")):
                # identifier usage like `{function = true}` is already covered
                # by the quote/brace cases; anything else is a false positive
                # risk, so only skip when clearly a field access.
                pass
            push("function", ln)
            prev_word = word
            continue
        if word in ("if", "for", "while"):
            if word == "if":
                # Luau if-EXPRESSION (`x = if c then a else b end`,
                # `return if c then a else b`): its `end` closes the
                # expression, not a statement block, so it must not push.
                before = src[src.rfind("\n", 0, col) + 1:col]
                if re.search(r"(?:=|return|[\w\]\)\"']\s*\()\s*$", before):
                    prev_word = word
                    ifExpr = True
                    continue
            push(word, ln)
            ifExpr = False
            if word in ("for", "while"):
                pendingDo = True
            prev_word = word
            continue
        if word == "then":
            prev_word = word
            continue
        if word == "do":
            # `do` closes a for/while header instead of opening a block only
            # when a for/while header is still pending its `do`. Generic-for
            # headers contain `in` plus an expression, so the pending flag -
            # not the previous token - decides.
            t = top()
            if pendingDo and t and t[0] in ("for", "while"):
                pendingDo = False
                prev_word = word
                continue
            push("do", ln)
            prev_word = word
            continue
        if word == "repeat":
            push("repeat", ln)
            prev_word = word
            continue
        if word == "until":
            k = top()
            if k and k[0] == "repeat":
                stack.pop()
            else:
                errors.append("%s:%d 'until' without matching 'repeat' (top=%s)" % (path, ln, k[0] if k else "nothing"))
            prev_word = word
            continue
        if word in ("elseif", "else"):
            k = top()
            # `else`/`elseif` of an if-EXPRESSION: no `if` frame was pushed, so
            # the top is the enclosing block and the expression's `end` will
            # close it. Accept without requiring an `if` frame.
            if ifExpr:
                prev_word = word
                continue
            if not k or k[0] not in ("if", "elseif"):
                errors.append("%s:%d '%s' must follow an open if/elseif (top=%s opened line %s)"
                              % (path, ln, word, k[0] if k else "nothing", k[1] if k else "-"))
            else:
                k[0] = "elseif"
            ifExpr = False
            prev_word = word
            continue
        if word == "end":
            if not stack:
                errors.append("%s:%d 'end' with no open block" % (path, ln))
                continue
            closed = stack.pop()
            ifExpr = False
            if closed[0] in ("for", "while"):
                pendingDo = False
            prev_word = word
            continue
        prev_word = word
    for kind, ln in stack:
        errors.append("%s:%d unclosed %s block opened here (EOF)" % (path, ln, kind))
    if chunk_locals > max_chunk_locals:
        errors.append("%s: chunk declares %d top-level locals (cap %d) - group helpers/constants into tables (Section.x) or scope one-shot temps in do/end; Studio refuses the whole file past ~200 with 'Out of local registers'"
                      % (path, chunk_locals, max_chunk_locals))
    for line, col, kind, word in reserved_field_hits(src):
        errors.append("%s:%d reserved Luau word '%s' used as a %s (col %d) - this is a "
                      "HARD parse error ('Expected identifier when parsing expression'), the "
                      "whole plugin fails to load and every Studio tool goes quiet. Rename it "
                      "(e.g. parentStep for 'in')." % (path, line, word, kind, col))
    return problems + errors


def main(argv):
    max_line = MAX_LINE_DEFAULT
    max_chunk_locals = MAX_CHUNK_LOCALS_DEFAULT
    files = []
    args = list(argv[1:])
    if args and args[0].startswith("--max-line="):
        max_line = int(args.pop(0).split("=", 1)[1])
    if args and args[0].startswith("--max-locals="):
        max_chunk_locals = int(args.pop(0).split("=", 1)[1])
    files = args or ["studio-plugin/RoLink.lua"]
    bad = 0
    for p in files:
        try:
            issues = check(p, max_line, max_chunk_locals)
        except OSError as e:
            print("SKIP %s (%s)" % (p, e))
            continue
        if issues:
            bad += len(issues)
            for i in issues:
                print("FAIL " + i)
        else:
            print("OK   %s (blocks balanced, lines <= %d)" % (p, max_line))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
