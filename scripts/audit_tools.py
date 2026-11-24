#!/usr/bin/env python3
# scripts/audit_tools.py - RoLink Tool Audit (existence is not execution).
#   py -3 scripts/audit_tools.py [--json-only]
# For every tool in catalog/tools.json, proves the full chain statically:
#   zod schema -> terminal envelope path -> plugin branch -> prompt -> sample
# Classification:
#   verified - full chain, real Studio branch (or deterministic local handler)
#   partial  - exists but the plugin branch is a mock/stub, or prompt/sample thin
#   failing  - missing schema/plugin/prompt, or handler can still return bare
#              {queued:true} as a terminal result
# Writes generated/tool-quarantine.json (failing + partial lists the prompts
# and bridge banner can surface) and prints the human report. Exit code =
# number of failing tools (0 = all clear).
import io, os, sys, json, re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def read(*parts):
    with io.open(os.path.join(ROOT, *parts), encoding="utf-8", errors="replace") as f:
        return f.read()


def handler_segment(registry_ts, name):
    """Text from this tool's definition to the next tool's definition."""
    idx = registry_ts.find(f'name: "{name}"')
    if idx < 0:
        return ""
    nxt = registry_ts.find('{ name: "', idx + 10)
    return registry_ts[idx:nxt if nxt > 0 else len(registry_ts)]


def plugin_lines(plugin, name):
    return [ln for ln in plugin.splitlines() if f'"{name}"' in ln]


# Success-shaped output that was never derived from anything.
# The 2.10.0 truth pass removed 15 of these from the bridge; the TypeScript
# mirror kept several, because the old audit only knew how to spot a literal
# `queued:true`. These are the patterns that let `simulate_economy` return
# Math.random(), `export_project` return a truncated archive, and `rollback`
# return {rolledBack:[...]} without a captured snapshot.
_FABRICATION_PATTERNS = [
    # Randomness standing in for a computed result.
    (re.compile(r"Math\.random\(\)"), "fabricated number (Math.random stands in for a result)"),
    # Success-shaped output built from a literal, with no branch that could
    # make it false. `rolledBack: undone ? steps : 0` is honest; a bare
    # `imported: true` in a payload is not.
    (re.compile(r"\b(testsPassed|imported|exported|rolledBack|ddaApplied)\s*:\s*true\b(?!\s*[?:])"),
     "hard-coded success flag"),
    # Truncating the archive the caller is told is complete.
    (re.compile(r"toString\(\"base64\"\)\.slice\("), "archive truncated then reported as exported"),
]
# A handler that legitimately uses randomness (e.g. id minting) is fine; only
# flag it when the value flows into the returned payload AND the handler does no
# real work (no queue call, no store read).
_REAL_WORK = ("studioQueueAndWait", "queueAndWait", "waitForResult", "commandQueue",
              "rollbackManager", "database", "readFile", "searchAssets",
              "perfTracker", "teamLog", "buildContext")


def _fabricated_receipt(seg):
    """Return a problem string when a handler fakes its own output, else ''."""
    if not seg:
        return ""
    does_real_work = any(tok in seg for tok in _REAL_WORK)
    for rx, why in _FABRICATION_PATTERNS:
        if not rx.search(seg):
            continue
        # An id mint (executionId, snapshotId) and a handler that demonstrably
        # does real work both make the match explicable rather than suspicious.
        if "Math.random" in why and does_real_work:
            continue
        if "hard-coded success flag" in why:
            # A handler with a real failure path (catch / isError / ok:false)
            # only emits the success flag after validation passed, which is the
            # behaviour we want. Flag only unconditional success.
            has_failure_path = any(t in seg for t in ("isError", "catch", "ok:false", "ok: false", "status:\"error\""))
            if does_real_work or has_failure_path:
                continue
        return "possible fabricated receipt (%s)" % why
    return ""


def load_catalog():
    """The catalogue is a product file (catalog/tools.json).

    It used to be tests/__registry__.json, which made a test fixture the runtime
    source of truth. The legacy path stays as a fallback for old checkouts.
    """
    for rel in (("catalog", "tools.json"), ("tests", "__registry__.json")):
        path = os.path.join(ROOT, *rel)
        if os.path.exists(path):
            raw = json.load(io.open(path, encoding="utf-8"))
            if isinstance(raw, dict):
                raw = raw.get("tools") or []
            return raw
    raise SystemExit("audit: no catalog found (catalog/tools.json)")


def main():
    registry = load_catalog()
    prompts = json.load(io.open(os.path.join(ROOT, "generated", "tool-prompts.json"),
                                encoding="utf-8")).get("prompts", {})
    try:
        samples = json.load(io.open(os.path.join(ROOT, "tests", "tool-samples.json"), encoding="utf-8"))
    except Exception:
        samples = {}
    registry_ts = read("mcp-server", "src", "tools", "registry.ts")
    plugin = read("studio-plugin", "RoLink.lua")
    import glob
    fixtures = {os.path.splitext(os.path.basename(p))[0]
                for p in glob.glob(os.path.join(ROOT, "rolink-extension", "core",
                                                "__fixtures__", "tool-calls", "*.txt"))}

    verified, partial, failing = [], [], {}
    for name in registry:
        problems = []
        partial_notes = []
        seg = handler_segment(registry_ts, name)
        if f'name: "{name}"' not in registry_ts:
            problems.append("no zod schema/handler")
        elif "queued:true" in seg.replace(" ", "") and "studioQueueAndWait" not in seg \
                and "waitForResult" not in seg:
            problems.append("handler can return bare queued:true")
        else:
            fabricated = _fabricated_receipt(seg)
            if fabricated:
                problems.append(fabricated)
        if not plugin_lines(plugin, name):
            problems.append("no plugin branch")
        if_mock = any("mock" in ln.lower() for ln in plugin_lines(plugin, name))
        if if_mock:
            partial_notes.append("plugin branch is a mock/stub")
        if_unsupported = any("unsupported" in ln.lower() for ln in plugin_lines(plugin, name))
        if if_unsupported:
            partial_notes.append("plugin branch explicitly unsupported (honest error)")
        p = prompts.get(name)
        if not p:
            problems.append("no prompt")
        elif not all((p.get(f) or "").strip() for f in ("when_to_use", "args_guide", "example_call", "pitfalls")):
            partial_notes.append("thin prompt (empty field)")
        if name not in samples and name not in fixtures:
            partial_notes.append("no sample/fixture")
        if problems:
            failing[name] = problems
        elif partial_notes:
            partial.append({"tool": name, "notes": partial_notes})
        else:
            # Local deterministic handlers (no queue) count as verified: nothing
            # async to lie about. Queue paths verified via envelope helpers.
            verified.append(name)

    total = len(registry)
    print("RoLink Tool Audit")
    print("------------------------")
    print(f"\n{total} registered\n")
    print(f"[ok] {len(verified)} fully verified")
    print(f"[partial] {len(partial)} partial")
    print(f"[fail] {len(failing)} failing")
    if failing:
        print("\nFailures:")
        for name, probs in failing.items():
            print(f"[fail] {name} -- {'; '.join(probs)}")
    if partial:
        print("\nPartial:")
        for e in partial[:20]:
            print(f"[partial] {e['tool']} -- {'; '.join(e['notes'])}")
        if len(partial) > 20:
            print(f"  ... and {len(partial) - 20} more")

    gen_dir = os.path.join(ROOT, "generated")
    os.makedirs(gen_dir, exist_ok=True)
    with io.open(os.path.join(gen_dir, "tool-quarantine.json"), "w", encoding="utf-8") as f:
        json.dump({"verified": len(verified), "partial": [e["tool"] for e in partial],
                   "failing": sorted(failing),
                   "note": "failing/partial tools stay listed but prompts should steer the model to verified alternatives until fixed"},
                  f, indent=2)
    return len(failing)


if __name__ == "__main__":
    sys.exit(main())
