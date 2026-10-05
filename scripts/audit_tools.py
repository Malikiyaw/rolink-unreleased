#!/usr/bin/env python3
# scripts/audit_tools.py - RoLink Tool Audit (existence is not execution).
#   py -3 scripts/audit_tools.py [--json-only]
# For every tool in tests/__registry__.json, proves the full chain statically:
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


def main():
    registry = json.load(io.open(os.path.join(ROOT, "tests", "__registry__.json"), encoding="utf-8"))
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
