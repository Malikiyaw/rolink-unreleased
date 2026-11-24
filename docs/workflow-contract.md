# RoLink workflow contract

`bridge.py` cites this document at two points (`catalog` loading and tool
routing) as the authority for how a tool call becomes an effect. This file
describes the contract the code actually implements, so the two can be kept in
sync.

## The chain

```
AI chat page
  → rolink-extension (content script + service worker)
  → bridge.py            ws://127.0.0.1:17613            (WebSocket, JSON frames)
  → Studio plugin        http://127.0.0.1:3001/queue/*   (poll, 200 ms)
  → Roblox Studio
```

A second path exists for Roblox-native tools that Studio's built-in MCP server
already exposes: the bridge spawns each `config.json` server as a stdio child
(`MCPManager`) and routes to it directly. Tool calls never take both paths.

## Routing precedence

For a tool name, in order:

1. **Bridge-local handler** (`LOCAL_HANDLERS`, `_LOCAL_EXTRA_DESC`). Answered in
   this process, deterministically, even with Studio offline. Examples:
   `get_studio_state`, `search_asset`, `get_memory`, `update_memory`,
   `get_model_graph`.
2. **Batch fan-out** (`batch_queue`, `run_task`, `migrate_system`). Orchestrates
   other tools; never leaves the bridge as a single call.
3. **Studio queue** (`STUDIO_QUEUE_TOOLS`). Enqueued for the plugin. This is the
   only path that mutates the place through RoLink's own catalogue.
4. **StudioMCP / addons** (`STUDIO_ROUTED_TOOLS`, `provider:"roblox"`). Native
   Roblox tools and any `config.json` addon namespace (`blender/...`).

`_TOOL_ALIASES` normalises model spellings (`run_code` → `execute_luau`) **only**
to choose the queue route. The original name is preserved on the StudioMCP path
so `list_commands` and friends never break.

## Execution truth

Every tool call resolves to a terminal envelope — never a bare `{queued:true}`:

```json
{
  "ok": true,
  "tool": "execute_luau",
  "executionId": "rl_...",
  "status": "success",
  "durationMs": 42,
  "result": { },
  "verification": { "checked": true, "passed": true },
  "preflight": { "syntax": "ok", "risk": "LOW" }
}
```

Allowed terminal statuses (`shared/protocol.ts` `ExecutionStatus`): `success`,
`error`, `timeout`, `confirm_required`. Lifecycle states (`queued`, `claimed`,
`running`) are signals only — the AI may not treat them as done.

Rules the code enforces:

- A value that could not be measured is `null`, never a guess. See the tri-state
  `positioned`/`anchored`/`instanceCount` on `import_distinctus_build`.
- A write that could not be read back reports `verified: false`, not success.
- Tools with no real implementation return an explicit `unsupported:` error
  naming an alternative; they never return a success-shaped stub.
- `scripts/audit_tools.py` fails the build when a handler can return
  `queued:true`, `Math.random()` results, a hard-coded success flag, or a
  truncated payload.

## Risk gate

`execute_luau` and `run_in_sandbox` run a static preflight before dispatch:

- unparseable Luau is rejected as `validation_error` (offline, no Studio round
  trip);
- non-undoable operations (DataStore writes, HTTP, broad destroy) require
  `confirm: true` and return `confirm_required` otherwise.

The gate is implemented twice — `bridge.py::_luau_risk` and
`mcp-server/src/security/preflight.ts::analyzeRisk` — and the two are pinned to
agree by `mcp-server/tests/preflightParity.test.ts`. Adding a detector to one
side without the other fails CI.

## Browser-origin guard

The bridge listens on loopback, which every page in the user's browser can
reach, so the transport is authenticated:

- `Origin` is checked against the provider allowlist. Page JavaScript cannot
  forge or suppress `Origin`, which is what makes this decisive. Requests with
  no `Origin` are non-browser clients (the Studio plugin's `HttpService`, curl,
  tests) and are allowed.
- Browser-extension origins are matched by scheme, not value, because they are
  minted per install.
- The queue HTTP server sends no CORS headers, so a page cannot read responses.
- `add_server` writes a spawn spec that `Popen` later executes, so it requires an
  explicit `confirm` from the settings page and refuses shell metacharacters.

See `tests/test_bridge_auth.py` — these are the tests that must never regress.

## The tool catalogue

`catalog/tools.json` is the product file. Everything else is generated from the
TypeScript registry:

| Artifact | Generator |
| --- | --- |
| `generated/tool-prompts.json` | `scripts/generate-tool-prompts.ts` |
| `rolink-extension/core/tool-prompts.js` | `scripts/generate-tool-prompts.ts` |
| `rolink-extension/core/persona-lines.js` | `scripts/generate-tool-prompts.ts` |
| `generated/code-fields.json` | `scripts/generate-code-fields.ts` |
| `rolink-extension/core/code-fields.js` | `scripts/emit-code-fields.js` |
| `rolink-extension/ui/toolHud/toolRegistry.js` | `scripts/emit-tool-registry.js` |

`tests/test_catalog_drift.py` and the CI "Generated artifacts are in sync" job
fail when any of them disagrees with the catalogue.
