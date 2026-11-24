# Contributing to RoLink

RoLink ships a Python bridge, a TypeScript MCP server, a browser extension and a
Luau Studio plugin. The repo has **no build step for the extension** — it is
loaded unpacked — which makes it easy to forget that several files are
generated. Please read the generated-files section before opening a PR.

## Prerequisites

| Tool | Version | Needed for |
| --- | --- | --- |
| Python | 3.9+ | the bridge and the whole test suite |
| Node | 18+ | `mcp-server/`, generators, extension self-tests |

## First-time setup

```bash
python -m pip install -r requirements-dev.txt
cd mcp-server && npm ci && cd ..
```

## The six commands to run before every PR

These are exactly what CI runs. If all six are green locally, CI will agree.

```bash
# 1. Python tests (375+ tests: bridge, queue, plugin branches, drift guards)
python -m pytest tests/ -q

# 2. TypeScript typecheck + unit tests
cd mcp-server
./node_modules/.bin/tsc -p tsconfig.json --noEmit
./node_modules/.bin/vitest run
cd ..

# 3. Extension self-tests and JS syntax
node rolink-extension/test-parser.js
node rolink-extension/test-agent.js
bash scripts/check_syntax.sh

# 4. Luau plugin guard (block balance + 900-char line cap)
python scripts/check_luau_blocks.py

# 5. Tool audit — must report 0 failing
python scripts/audit_tools.py

# 6. Generated artifacts + versions
node scripts/emit-tool-registry.js --check
python scripts/check_versions.py
```

## Generated files — do not edit by hand

The tool catalogue exists in several places. Only
`mcp-server/src/tools/registry.ts` (the implementation) and
`catalog/tools.json` (the product catalogue) are hand-written. After changing
either, regenerate:

```bash
npx --prefix mcp-server tsx scripts/generate-tool-prompts.ts   # prompts + persona lines
npx --prefix mcp-server tsx scripts/generate-code-fields.ts    # code-fields json
node scripts/emit-code-fields.js                               # code-fields js
node scripts/emit-tool-registry.js                             # HUD tool list
```

Commit the regenerated files in the same commit. CI runs the generators and
fails on any diff, because generated artifacts drifting silently is a bug this
project has actually shipped (`retarget_animation` was implemented in the plugin
yet invisible to the model for a whole release).

If you add a **new tool**, you must touch:

1. `mcp-server/src/tools/registry.ts` — schema + handler.
2. `mcp-server/src/tools/toolPrompts.ts` — a real prompt (`when_to_use`,
   `args_guide`, `example_call`, `output`, `pitfalls`); the generator throws if
   one is missing.
3. `catalog/tools.json` — add the name (the drift test enforces this).
4. `studio-plugin/RoLink.lua` — the plugin branch, or an explicit
   `unsupported:` error.
5. `tests/tool-samples.json` — a sample call.

Then run all the generators above.

## Honesty rules (these are enforced, not stylistic)

This project had a class of bug where a tool returned a success-shaped result
for work it never did: `run_tests` answering `testsPassed:true`,
`simulate_economy` returning `Math.random()`, `rollback` certifying an undo with
no snapshot. Do not reintroduce it.

- Every tool call resolves to a terminal envelope (`docs/workflow-contract.md`).
- A value you could not measure is `null` — never a guess, never a default that
  reads like a real measurement.
- No implementation yet? Return `unsupported:` naming a real alternative.
- `scripts/audit_tools.py` fails on `queued:true`, `Math.random()` results,
  hard-coded success flags and truncated payloads. Run it before pushing.

## Security-sensitive areas

Changes here need a test that fails without the fix:

- `bridge.py` origin guard / token (`tests/test_bridge_auth.py`)
- `bridge.py::config_add_server` — it writes a spec that `Popen` executes
- `bridge.py::_luau_risk` **and** `mcp-server/src/security/preflight.ts` — the
  two are pinned to agree by `mcp-server/tests/preflightParity.test.ts`; add
  detectors to both.
- `studio-plugin` sandbox: `applyEnv` must fail closed when `setfenv` is
  unavailable.

## Versioning

`VERSION` is the single source. `python scripts/check_versions.py` verifies that
`bridge.py`, `rolink-extension/manifest.json`, `mcp-server/package.json` and
`studio-plugin/RoLink.lua` all match it. Update all of them together.
