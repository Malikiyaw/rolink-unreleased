# Changelog

## [Unreleased]

### Animation Engine v3 (phases 1-12)

- New deterministic animation engine shared by the MCP server and the Studio
  plugin: rig analysis, semantic skeletons, intent->plan timing, pose
  generation, curves, IK, contacts, collision, dynamics, layering, graph,
  critic and repair.
- `analyze_animatable_model`, `create_model_animation`, `set_model_keyframe`,
  `set_model_easing`, `validate_model_animation`, `preview_model_animation`,
  `fix_animation`, `blend_animation`, `retime`/`reverse`/`mirror_animation`
  and the attack/idle/walk scaffolds now run on that engine instead of their own
  math, so there is one code path per concern.
- Fixed: `blend_animation` no longer lerps Euler angles directly (rotations go
  through quaternion slerp), `reverse_animation` no longer silently leaves
  `bezierOut`/`springOut` unflipped, and `set_model_keyframe` rejects joints
  with no writable channel instead of accepting keys that do nothing.
- Removed the plugin's duplicate easing table and joint classifier.
- Registry gained a backward-compat shim: legacy `animation`/`easing`
  argument spellings and bare easing names (`quad`, `easeInOut`) still resolve.
- Removed the narrative build panel from the extension.
- Benchmark suite + memory-leak detection for the animation engine.

## [2.7.0] - 2026-09-26

### Plugin load fix: chunk-local register cap

- Fixed the plugin failing to load at all (`Out of local registers ... exceeded limit 200` on the last chunk line, so no toolbar, no `loaded` banner, `plugin_status` never-polled): the file held ~200 chunk-scope locals (every top-level `local function` keeps a register to end-of-file). Motion/cutscene helpers now live on `Motion.*`/`Cutscene.*` tables, one-shot chunk temps use `do/end` blocks, subdivision counts are inline — ~35 registers freed with zero behavior change (all dispatcher spells and pinned declarations untouched).
- `scripts/check_luau_blocks.py` now also counts chunk-scope locals (`--max-locals`, default 185) so the next approach trips CI instead of Studio.
- Plugin reinstall required: quit Studio fully, reinstall `studio-plugin/RoLink.lua`, reopen (expect `RoLink 2.7.0 loaded [repo copy]` + toolbar button).

### Preflight: scan-then-delete no longer needs confirmation

- `broad-destroy` now requires the `:Destroy()` to sit inside a `for`/`while`/`repeat` body (plus a `GetDescendants`/`GetChildren` scan, `ClearAllChildren`, or root destroy). Scanning the tree and deleting one resolved target outside any loop is a single undoable delete — it reports `targeted-destroy` (MEDIUM) and runs without `confirm:true`. Real wipes (`for ... GetDescendants() do :Destroy() end`, guarded or not) still gate. Bridge and Node analyzers kept in sync.
- Confirm rejections and failed tool results now log their full (untruncated, capped) text to `bridge_debug.log` file-only, so a terminal screenshot is never the only record of what fired.

### Realistic animation: easing, metrics, scaffolds

- New easings `bezierOut` (overshoot) and `springOut` (settle), per-pose easing overrides, deeper subdivision on long eased segments, and arc lift so swings bow outward instead of chord-cutting through the body. Budgets unchanged (200 keyframes, 64 poses each, 1024 total).
- `preview_motion_animation` now reports per-part peak velocity (`peakVelocity`) and loop-seam drift (`loopSeam`, `loopSeamWorst`); `validate_motion_animation` warns `LOOP_SEAM` on looped controllers that would pop. Attack scaffolds bake overshoot/settle keys; idle/walk use sine cycling.
- Prompts teach the realism recipe (block extremes, slow-in/out, overshoot strikes, planted holds, close loops) across `create_animation_track`, motion, and preview/validate outputs.
- Plugin reinstall required: quit Studio fully, reinstall `studio-plugin/RoLink.lua`, reopen (expect `RoLink 2.7.0 loaded [repo copy]`).

### Cinematic cutscenes: real camera, lifecycle tools

- `create_cutscene` now builds eased per-frame camera tweens (12 easings incl. `bezierOut`/`springOut`), `cut|fade` transitions, per-shot FOV, bounded shake, static `hold` snaps, letterbox bars, time-synced subtitles, audio cues, and a skippable auto-play Play-time LocalScript. New lifecycle tools `preview_cutscene` (numeric timeline), `validate_cutscene` (error codes + `LOOP_SEAM`), `remove_cutscene` (confirm-gated). Catalog 147 → 150 tools.
- Plugin reinstall required (same step as above).

### Brick-by-brick modeling: anchored courses
- `place_parts` learned `origin` (anchor on a verified part, offsets build off it), `y` (course height), `snap` (grid-size X/Z rounding, Y stays level), and `prefix` (names parts `prefix_1..N` for exact follow-ups). Results add `origin/base/paths/floaters/originTop`: `floaters[]` flags detached parts, `originTop` is the stacking height for the next course.
- Prompts teach the course protocol: foundation with prefix → verify paths → anchor next course on origin at `originTop` → fix floaters before stacking → snapshot per layer. Never absolute coordinates from memory.
- Plugin reinstall required (same step as above).

## [2.6.0] - 2026-09-25

### Roblox motion + separate Blender MCP

- Added seven real Roblox motion tools: `create_motion_animation`, animation inspect/validate/preview/remove, and effect inspect/remove alongside the upgraded `create_motion_effect`. Motion animation now builds a native Motor6D pose hierarchy and a real Edit/Play controller; effects persist validated configs and execute bounded runtime Scripts. Every result reports verified paths/data and never claims Edit rendered pixels.
- Added the opt-in `mcp-for-blender` preset and `blender/*` namespace. The bridge preserves exact upstream tool names for dispatch, keeps image results intact, exposes secret-free health metadata, and never lets Blender replace a Roblox-owned command.
- Added reachable extension settings, preset UI, namespace-aware command validation, and fake-server routing/health/image tests. The shipped config remains Roblox-only; Blender is never added until the user clicks Add.

Tool-truth fixes from live reports (plugin reinstall required — same 2.6.0
versions, reinstall `studio-plugin/RoLink.lua` with Studio fully quit).

- **`execute_luau` returns values again**: result is now
  `{executed, returned, hasReturn, output, preview}` with the preview labeled
  input-only; `print()` is captured into `output`. New `loadstring` → `load`
  → ModuleScript-harness fallback so a disabled loader no longer silently
  fails. Extension renders `executed/returned` instead of raw preview JSON.
- **Exact-first path resolution**: `get_instances` no longer falls back to the
  whole Workspace on a miss (reports `not_found` + siblings); every resolver
  matches exact segments first, supports `Name[2]` duplicates, and reports
  `matchedPath`. New `inspect_keyframe_track` + `get_animation_info{numeric}`
  dump per-keyframe pose positions (studs) and rotations (degrees).
- **`search_asset` is live and honest**: the retired catalog endpoint was
  replaced with Roblox's current public v2 Creator Store search API in the
  bridge and Node path. It returns real `{id,name,description,creator,assetType,url}`
  rows, handles an empty result as `{assets: [], note: "no matches"}`, and
  reports `asset_search_unavailable` on network/API failure without ever
  fabricating IDs. The Studio branch is only an honest pointer to the bridge.
- **`playtest_scenario` sees prints**: the observation window captured only
  errors/warnings, so `expect` on printed lines always failed — it now
  captures full Output (`lines[]`) and returns a real `playState`.
- **RAW markers + error hygiene**: the extension parser now attaches
  `###RAW:<field>###` blocks (and infers a generic `###RAW###` field) to the
  parsed call, rejects an unterminated block/JSON Luau block, and normalizes
  case/spacing/dash marker variants through bridge/plugin/sandbox paths;
  internal `sabuiltin_*` prefixes are scrubbed from user-facing not-found
  errors.
- **Crash fixes**: `rlAnimGetLocked` was defined after its callers (nil call on
  every set-keyframe/set-easing); clip-twin helpers likewise — definitions
  moved above first use. `validate_model_animation` scoping clarified
  (model store only; KeyframeSequence tracks use the numeric inspector).
- **Path walks keep legacy fall-through**: exact-first slash/dot walks with
  `Name[2]` disambiguation, but a failed walk still falls through to the
  full-string scan so dotted names (`My.Part`) resolve; prompts, generated
  mirrors, and the extension copy updated for the new result shapes, RAW
  rules, numeric inspection, validator scope, and the live search_asset contract.
- **Dead builders revived**: `execute_luau` reports which loader ran
  (`loadstring`/`load`/`harness`, unique harness names per call) and fails
  distinctly when all three are dead; `create_instance` / `set_properties` /
  `set_ui_property` / model-table / lighting / emitter paths now coerce JSON
  arrays to `Vector3`/`Color3` (`[11,3,4]`, `[150,95,45]` RGB), `"x,y,z"`
  strings, and enum names — returning per-key `applied`/`failed` and erroring
  on total failure instead of fake success. Listings carry `count` and
  `truncated` flags. **Reinstall the plugin: none of this is live in Studio
  until `RoLink.lua` is reinstalled with Studio fully quit.**
- **Honest stubs**: `apply_material` is now real (path/region required, paints
  up to 200 BaseParts through the same coercion, returns
  `painted/of/truncated` plus per-part `failed`); `diff_snapshots`,
  `get_performance_stats`, and `explain_code` fail explicitly as `unsupported`
  with a working alternative instead of mock success. The audit tracks
  `unsupported` branches as partial so the quarantine stays truthful, and the
  extension appends a fix-the-failed-keys nudge whenever a result carries a
  non-empty `failed` map.
- **Stale-install defense**: `install-plugin.bat` now refuses while Studio
  runs, purges duplicate strays, byte-verifies the copy (`INSTALL OK`),
  and warns on multiple copies; the bridge read-only compares the installed
  `RoLink.lua` against this folder (missing/duplicate/byte-differing) at
  boot and inside `plugin_status` (`installed_plugin` + `install_note`),
  and the plugin banner carries a `[repo copy]` tag. README has a plugin
  troubleshooting box.
- **`import_asset` is now a real, verified insert**: the plugin validates the
  numeric ID, loads the actual Creator Store object, strips executable
  LuaSourceContainer/PackageLink descendants before parenting, returns the
  inserted path, and cancels late mutation after a tool timeout. Node waits
  for a terminal `import_asset` result, propagates `projectId`, rejects stale
  fake-success results, and can use StudioMCP's native type-aware insert when
  the queue is unavailable. Search rows now expose script/price metadata.
- **Node build/runtime repaired**: the TypeScript build now emits a consistent
  ESM tree for the shared protocol, `npm start` points at the actual compiled
  entrypoint, generator scripts use repository-root paths, and the HTTP
  asset-search endpoint was verified end-to-end.
- **Terrain and DataStore go real**: `generate_terrain` builds a base slab
  plus seeded hills (`size` 64–2048, new optional `material`); 
  `set_terrain_region` fills a validated min/max box (capped, `Air` clears);
  `get_datastore_value` / `set_datastore_value` attempt real reads/writes
  with `found` flags and fast `datastore_unavailable` errors instead of mock
  receipts. Quarantine updated (`get_datastore_value` verified).
- **`place_parts` honors pattern/count**: grid/circle/line layouts with
  `spacing`, optional `size`/`material` (new schema fields), stray-free
  partial placement with per-part `failed`, total failure errors.
- **Hotfix: plugin failed to load** (`Cannot use '...' outside of a vararg
  function`): the `print()` capture called the original through a nested
  non-vararg closure referencing `...` — a compile error that killed the
  whole plugin at load. Capture now packs varargs once (`table.pack`) and
  unpacks from the upvalue; the file was swept for the same mistake (other
  `...` uses are directly inside vararg bodies and legal) with a regression
  pin. **Reinstall again — Studio caches the broken copy until a full
  restart + reinstall.**
- **Hotfix: `Expected 'end' (to close 'else' at line 3031), got 'elseif'`**
  (root cause found via Studio's own logs — the compile error was real, not
  a stale install): Studio's Luau parser loses block tracking on physical
  lines past ~1KB. Three dispatcher branches (`generate_terrain`,
  `set_terrain_region`, `place_parts`, `apply_material`) were single lines
  of 1,103–1,654 chars; the parser recovered on the NEXT branch and blamed
  it. All four are now short, multi-line functions (`buildTerrain`,
  `fillTerrainRegion`, `placePatternParts`, `paintMaterial`) and the longest
  line in the file is 761 chars. `scripts/check_luau_blocks.py` (grammar
  aware: skips strings/comments, handles if-expressions, for/while `do`,
  repeat/until) plus a 900-char line cap now guard the file in CI, and
  `test_luau_blocks_and_line_cap` runs it on every test pass.
- **`batch_queue` is deadline-bounded**: sub-calls previously each received
  the full batch timeout, so a 10-step batch could outrun the extension's
  listen window while Studio kept executing orphaned "failed" steps. Each
  step now shares a ≤115s budget; unrun steps stop honestly as timeout, and
  prompts document the budget plus atomic hash verification.

### Tooling coverage and Blender test repair

- **147 tools, 147 prompts**: the generated tool-prompt and code-field mirrors
  were regenerated from 140 to 147 tools. Seven motion tools
  (`create_motion_animation`, `inspect_motion_animation`,
  `validate_motion_animation`, `preview_motion_animation`,
  `remove_motion_animation`, `inspect_motion_effect`, `remove_motion_effect`)
  had no prompt in any generated artifact, so `bridge.py` advertised them with
  no parameter guidance at all — including the hard-required `confirm: true`
  for the two `remove_*` tools. The stale `create_motion_effect` prompt was
  also replaced, and its missing `name` code-field (which broke
  `###RAW:<field>###` for that argument) was restored.
- **Full audit coverage**: all 147 tools now report `verified` (144 verified,
  3 partial, 0 failing) in `generated/tool-quarantine.json`, and
  `scripts/audit_tools.py` exits 0.
- **Blender MCP test suite repaired**: 8 assertions had drifted from the
  preset's current `--python 3.11` args, 4-key env, and 7-key written spec.
  Expectations are now derived from the preset registry with one deliberate
  literal pin, and the suite no longer spawns a real `uvx` process.
- **Sample coverage**: seven sample calls were added to
  `tests/tool-samples.json` so every catalog tool has one.
- **Known pre-existing issue, not fixed here**:
  `tests/test_bridge_catalog.py::test_single_ownership_on_collision` fails
  because `bridge.py`'s catalog-wins override only applies to the
  `None`/`local`/`roblox` server ids. Left as-is deliberately — it is a
  collision-policy decision, not a test to weaken.

## [2.5.0] - 2026-09-24

Model animation + provider honesty. 140 tools.

- **Model animation (beta)**: tools 125–140 — `analyze_animatable_model` (any-rig hierarchy graph: humanoids, cannons, doors, vehicles), `create_model_animation` (ReplicatedStorage store, confirm-gated overwrite), `set_model_keyframe` / `set_model_easing`, `add_animation_marker` (gameplay event bindings), `preview_model_animation` (numeric samples, never pixels — Studio exposes no pixel capture to plugins), `validate_model_animation` (spikes, jumps, loop mismatch, orphan events with fixes), composites `retime` / `reverse` / `mirror` / `blend` / `fix`, generators `create_attack_animation` / `create_idle_animation` / `create_walk_cycle`, `set_track_lock`. In-Studio timeline editor (beta): RoLink toolbar button `Anim` opens a Moon-style dock widget (title strip, menu row, rig tree, track dots + locks, frame ruler, keyframe + marker lanes, playhead, inspector, transport with Edit-only playback that restores originals) reading the same store as the chat tools.
- **Provider statuses**: Claude and Dola are marked work-in-progress (not usable yet — use DeepSeek, ChatGPT, or another supported chat); Arena Agent Mode is marked work-in-progress (use Direct mode for now, supervised, never votes).
- **Bridge**: prefix-boosted unknown-tool suggestions, honest long-start feedback on agent pages, send-stage diagnostics on Arena Agent.
- Audit/completeness suites pin 140 tools, 0 failing.

## [2.4.0] - 2026-09-23

Execution truth, two new providers (10 → 12), Dola/HF hardening.

- **Pi rejected**: `pi.ai` was evaluated and dropped before release —
  Inflection's abuse filters escalated from a one-minute throttle to a full
  account ban during normal bootstrap traffic. Do not use RoLink on `pi.ai`.
- **Account-restriction classifier stays in core** (`RL.isRestricted`): any
  provider can throttle an account. A ToS/throttle notice is terminal —
  no de-escalation, no retry, no nudge (every further send extends the
  wait), with a wait-it-out banner on all four response paths.
- **Proof-gated session start**: `A.started` only flips green after a
  `list_commands` round actually executed; a chatty "I'm ready" gets one
  `proveIt` nudge, then an honest banner — never a phantom "Agent active".
- **Stuck-input guard**: an idle bar force-clears any composer lock our code
  set (typed-but-mute input seen live on Dola); never fires while a loop or
  bootstrap owns the lock.
- **No-turn banner**: a send that lands but gets no answer reports honestly
  instead of muting.
- **HF Chat placeholder teach-back**: literal `command_name` placeholders are
  caught and answered with the correct call instead of being run.
- **`proveIt` restored**: the key had been nested inside `parseError`'s notes,
  so `RL.FEEDBACK.proveIt` was undefined and the proof round threw. Hoisted to
  top-level `FEEDBACK` (call site unchanged).
- **Agent Mode phantom-turn guard**: the flat prose strategy now skips
  containers holding a code block — inline code words (`` `list_commands` ``)
  no longer inflate discovery counts; code-bearing turns come from the
  shaped/gated code strategy only.
- **Contract suites revived**: `test-agent.js` (TDZ crash) and `test-arena.js`
  selector engine were repaired so both run green; stub-DOM fidelity fixes
  (parentElement, classList, case-insensitive attribute selectors, per-fixture
  clock) back every pin above.

- **Dola support** (`dola.com`): generic-factory provider with layered
  composer discovery, mode-chip/disabled-send guards (never click a greyed
  send or a mode chip), native skill/task drift rules (RoLink JSON only),
  and the anchored-card bar pattern from the HF fix. Text-only until a live
  image pass. Marked unstable pending live validation.

- **RoLink bar sits above the chat on HF Chat**: chat-ui lays the composer
  out as a horizontal flex row, so the generic in-flow mount landed the bar
  beside the input. HF Chat now uses the anchored pattern (Kimi/Qwen
  precedent): no in-flow mount into Svelte-reconciled DOM, the bar hugs the
  rounded composer card at full width via `barAnchor()` with a cached,
  geometry-read (never class-name) card lookup. Stub-DOM anchor tests pin
  card-not-row selection and teardown degradation.

- **HF Chat support** (`huggingface.co/chat`): generic-factory provider with
  layered composer discovery, streaming-chrome exclusion, login + model-variance
  rules (small models mangle the protocol — ask to switch models, never shrink
  commands), text-only until a live image pass. Marked unstable pending live
  validation.
- **Every tool returns the truth**: terminal ExecutionEnvelopes
  (`status success|error|timeout`, `executionId`, `durationMs`) on both the
  bridge and Node paths — `queued:true` is never a result. Failed queue
  commands are terminal (fixed an infinite error re-claim that starved the queue).
- **`execute_luau` preflight**: risk levels (LOW/MEDIUM/HIGH), scope
  estimates, and a `confirm:true` gate for non-undoable operations
  (DataStore writes, HTTP, broad destroy).
- **Atomic batches**: `batch_queue{mode:atomic}` snapshots first, rolls back
  succeeded Studio steps on failure, and verifies the tree hash
  (`partialCommitAllowed:false`).
- **New tools 120-124**: `scan_errors` (Output triage), `inspect_ui`
  (rects for overlap reasoning), `screenshot_studio` (schematic SVG scene
  map — Studio exposes no pixel capture to plugins), `playtest_scenario`
  (snapshot → ticks → Output check), `migrate_system` (plan by default,
  atomic apply only with `confirm:true`).
- **Studio truth + memory**: `get_studio_state` (connectivity, playState,
  selection, versions, pending) and structured project memory
  (`get_memory`/`update_memory`, 10 sections, pull-one-per-task).
- **Narrative build HUD**: in-page panel narrating goal, phases, batch
  progress, and the current tool (subscribes to the ToolEvent bus).
- **Tool audit**: `scripts/audit_tools.py` proves schema → envelope →
  plugin → prompt → sample per tool and writes
  `generated/tool-quarantine.json` (current: 119 verified, 5 partial
  mocks, 0 failing).

## [2.3.0] - 2026-09-22

New provider, hardening, and cleanup.

- **Claude support** (`claude.ai`): generic-factory provider with layered
  composer discovery, extended-thinking exclusion, chat-only command rules,
  and usage-cap economy notes. Marked unstable pending live validation.
- **Injection-skepticism refusals**: replies that refuse the mechanism now
  classify as their own kind (never terminal text). One user-voiced
  de-escalation with a falsifiable test and a genuine opt-out; a second
  refusal ends with clear guidance instead of a silent death.
- **Condensed user-voiced prompt** for sensitive models (no catalog dump -
  the live `list_commands` output carries it) plus an opt-in two-step
  bootstrap (small opener first, full prompt only on compliance).
- **Background robustness**: bounded waits exclude hidden-tab time, and the
  Paused bar reads "Studio keeps working" while a tool is in flight. Tool
  execution itself was already background-safe (desktop bridge process).
- **Arena Agent Mode (supervised)**: `/agent` provider reading settled
  output, orchestration awareness, human vote-gate parking (never votes),
  orphan-command adoption, A/B and thought-block handling, and a bar that
  survives composer teardowns. Direct mode got layered editor discovery.
- **Removed**: the Ko-fi tip button (toolbar popup) and the Setup + bridge
  notification cards; Discord invite rotated.
- **Studio plugin**: sandbox exposes standard builtins (`pcall`, `require`,
  …), wall-clock deadline stops hung snippets wedging the queue, and runtime
  errors name the offending source line.

## [2.2.3] - 2026-09-21

Missing bar fix: inject on bare `deepseek.com`.

- Content scripts only matched `chat.deepseek.com`, while host permissions
  already covered bare `deepseek.com` — pages served there got zero
  injection (no bar, no chip). Both the manifest entry and background
  status coverage now include it. A regression test pins the match set.

## [2.2.2] - 2026-09-21

Critical DeepSeek fix: the Start chip is back.

- **Root cause**: 2.2.1's send-button fallback called itself (`findSendBtn`
  → `findSendBtn`) — infinite recursion crashed the content script on sight,
  so no bar ever mounted and the extension card showed Errors.
- The fallback now queries the DOM as intended; a regression test pins it.

## [2.2.1] - 2026-09-21

DeepSeek v4.1 composer support + count sync.

- **Start works on the redesigned composer**: send-button lookup falls back
  past `.ds-button--primary` to a labelled send button (never the model
  picker or Direct dropdown), and unrecognized model pickers are treated
  like the unified model instead of blocking Start.
- **Clear blocker message**: a stuck-on Smart Search now says so instead of
  a dead-end "mode not ready".
- Count labels synced to the 119-tool catalog across bridge, plugin,
  extension, and installer.

## [2.2.0] - 2026-09-21

Public GitHub release: 119-tool catalog.

- Cinematics: `create_cutscene`, `create_dialogue`, `create_motion_effect`,
  `create_vfx` (real viewport effects) with runtime snippets for Play.
- Editor round-trip: `export_animation_clip` (curve-data twin) and
  `publish_animation` (prepare → human publish → register asset ID).
- Realistic motion: per-keyframe easing bakes interpolated frames.
- Hardening: Edit-only honesty, single-flight queue, marker stripping,
  `get_all_properties` safe reads, batch cap 10, version-mismatch warnings.

## [2.1.18] - 2026-09-21

119 tools: clip export + publish workflow for the editor round-trip.

- **New tools 118-119**: `export_animation_clip` (AnimationClip twin with
  per-part curve data for editor round-trips + read-back) and
  `publish_animation` (prepare validates + refreshes the twin with human
  publish steps; register caches a published asset ID for play/info).
  Publishing stays human-only (auth); invented IDs are rejected.
- **`get_animation_info` round-trip**: responses include `clip` +
  `clipCurves` when a twin exists, so post-editor tweaks are visible.
- Registry, prompts, code-fields, HUD registry, bridge routing, and plugin
  branches updated across all layers.

## [2.1.17] - 2026-09-21

117 tools: tip panels removed, cinematics added, properties/batch fixed.

- **Tip panels removed**: the in-page menu no longer shows Free Support /
  Robux / Ko-fi sections (constants, handlers, and styles removed).
- **New tools 114-117**: `create_cutscene` (camera shots + runtimeSnippet),
  `create_dialogue` (NPC lines + ProximityPrompt), `create_motion_effect`
  (tween/shake/fov/pulse setup + snippet), `create_vfx` (real viewport
  particles/fire/smoke/sparkles/beam/light). Registry, prompts,
  code-fields, HUD registry, bridge routing, and plugin branches updated.
- **Realistic animation**: per-keyframe `easing` bakes interpolated frames;
  non-decreasing times enforced.
- **`get_all_properties` fixed**: curated safe reads + attributes instead of
  `pairs(instance)` (invalid argument #1); misses carry sibling hints.
- **Batch discipline**: cap 10, stops at first stuck failure, single-command
  guidance in prompts.

## [2.1.16] - 2026-09-21

Extension startup fix: `RL is not defined` is gone.

- Root cause: unescaped backticks in a prompt rule inside the
  `config.js` template literal broke parsing, so `RL` never defined and
  Start failed. All literal backticks in prompt text are now escaped.
- Versions re-synced across bridge/plugin/extension.

## [2.1.15] - 2026-09-21

Marker leak + stale read + harness. Every write/exec tool strips leaked
transport markers so a file never holds a leading `#`; `get_script_content`
returns bytes/rev to detect staleness; the compiler harness no longer
appends `return true` (which turned `return {...}` into `Expected eof`)
and is only used for real `require()` snippets; Client-targeted
execute_luau in the queue path warns `LocalPlayer is nil`; bridge
queue/next carries bridge_version for mismatch warnings; file writes
guard 100k and multi-edit in Play is `play_gated`.

## [2.1.14] - 2026-09-21

Error honesty + track-to-Animation + single-flight queue.

- **No more require_failed spam**: only the module loader may use that
  prefix; plain Luau errors (e.g. LocalPlayer nil, LoadAnimation misuse)
  surface verbatim. Harness failures split into `compiler_error` vs
  `require_failed`, both with code heads.
- **Animation chain fixed**: `create_animation_track` returns
  `runtimeSnippet`; `play_animation` accepts hash, rbxassetid, or
  KeyframeSequence path (auto-registers via KeyframeSequenceProvider) and
  never passes a KeyframeSequence to LoadAnimation. Play returns
  `playable:false` + snippet for a real Script.
- **No 2-claim stall**: plugin single-flight (`__RL_BUSY`) + bridge
  `queue_take` backstop; every execution reports exactly once;
  `set_script_content` over 100k fails fast with a chunk hint; timeouts
  name in_flight tools.

## [2.1.13] - 2026-09-21

Yield + Play honesty + require context.

- **Yield-transparent execution**: `runBudgeted` no longer busy-resumes a
  coroutine, so `task.wait()` snippets work (`0.2s` false
  `Cannot call task.wait on a thread that is already 'waiting'` is gone).
  `poll()` already runs in `task.spawn`, so yields propagate normally; the
  instruction hook budgets the current thread only where supported.
- **Play render honesty**: the plugin runs in the Edit DataModel only.
  `play_animation` in Edit returns `rendered:false`; in Play it returns
  `playable:false` with the stop-Play-then-verify steps instead of a bare
  success the user cannot see. `execute_luau` with a non-Edit datamodel
  notes the Edit-only queue path. Prompts updated to match.
- **Require context**: the ModuleScript harness is parented before
  `require()`, always destroyed, and `Requested module ...` wrappers are
  unwrapped to `require_failed: <inner> [code: ...]`; `run_function`
  misses keep sibling hints.

## [2.1.12] - 2026-09-21

Execution hardening: every code tool works on real Studio Luau again.

- **Nil-call fix**: `debug.sethook` does not exist in Roblox Luau, so 2.1.11
  threw `attempt to call a nil value` on all `sandboxRun` tools
  (`execute_luau`, `run_in_sandbox`, `refactor_code`, `compile_visual_graph`,
  `generate_asset`, `generate_level`, `import_asset`, generic fallback).
  The plugin now feature-detects (`HAS_SETHOOK`/`HAS_SETFENV`) and falls back
  to a plain resume loop; the hook budget still applies where supported.
- **No more hangs**: yield-less `while true` loops are rejected fast as
  validation errors in the plugin (`riskyLoop`), bridge preflight, and
  `mcp-server validateLuau`, instead of wedging the poll task.
- **Honest errors**: hung claims while the plugin still polls now return
  `stuck-execution` (call `plugin_status`, do not resend) instead of false
  `plugin_offline` reinstall steps; dead pollers still say `plugin_offline`.
- **Keyframe reads by path**: `get_animation_info` accepts `path`
  (e.g. `Workspace/RoLinkAnimations/HelloWave`) and returns indexed
  keyframes, so duplicate `Keyframe` names no longer force raw Lua dumps.
- **`simulate_ticks` capped** at 10s to stay under queue timeouts.

## [2.1.11] - 2026-09-20

Bounded execution: synchronous Luau runs on a coroutine under an instruction
step-hook (~10M instructions). Infinite loops die in seconds with
"budget exceeded" instead of wedging the poll task forever; yields resume
normally. Prompt rule: snippets must terminate, frame animation belongs to
create_animation_track + play_animation.

## [2.1.10] - 2026-09-20

Dot-path resolution: `findByPath` walks dot-separated paths
(`game.Workspace.Rig`) after slash paths and before legacy exact-name scan,
so both spellings resolve and dotted names (`My.Part`) still work. Every
path-taking tool is fixed at once; misses still list real siblings.

## [2.1.9] - 2026-09-20

One name, one owner; no starvation; no ghost replay.

- **Single ownership**: colliding names (Studio-native vs ours) list exactly
  one entry whose params match the backend that will execute it (ours while
  the plugin polls, Studio's otherwise). List and execute agree by
  construction; a test pins the rule.
- **Timeout-cancel**: timed-out waits retire the command, so ghosts never
  replay and fresh calls stop starving behind dead ones.
- **Unfiltered plugin polls**: project-scoped starvation (pending, never
  claimed, zero errors) is impossible now.
- **`plugin_status` verdict**: healthy / executing / routing-stall /
  stuck-execution / no-plugin / plugin-stale / no-queue, plus per-project
  pending. The prompt follows the verdict instead of theorizing.

## [2.1.8] - 2026-09-20

No dead ends: every search spelling now executes natively.

- **Native search tools**: `script_search`/`script_grep` do real full-text
  search across Script sources (`path:line` hits); `search_game_tree` does
  real name/class/attribute search. Previously they aliased to path-taking
  tools whose args they don't carry, so every call died with bare "not found".
  `search_scripts` maps to the native search. Registry stays 113; the three
  ride the queue + advertisement as extras.
- **Unknown-name guard covers the extras** (no repeat of the exclusion bug).
- **Timeout text carries its own diagnosis**: pending count + oldest claim
  age, so model and user see the jam without a follow-up call.

## [2.1.7] - 2026-09-20

Stuck-execution visibility: polls flowing with zero answers now names the
cause instead of burning timeouts. `plugin_status` reports `in_flight` +
`oldest_claim_age_s`; the plugin warns in Studio Output when one execution
passes 30s (probable infinite loop); the prompt forbids resending hung code
and says plainly a hung loop needs a Studio restart.

## [2.1.6] - 2026-09-20

No silent staleness: a polling plugin with no `?pv=` version is now called
out immediately (ACTION banner: reinstall + full Studio restart), the popup
flags version mismatch with the update step, and `plugin_status` reports a
`stale` bit. Pre-2.1.5 plugins can no longer fail cryptically.

## [2.1.5] - 2026-09-20

Plugin-not-answering, end to end.

- **Sandbox parity**: datatype globals the model uses (`Vector3`, `CFrame`,
  `Color3`, `UDim2`, `BrickColor`, `TweenInfo`, `utf8`, `bit32`, ...) added;
  sandbox errors quote the offending code head.
- **Version handshake**: polls carry `?pv=`; bridge logs VERSION MISMATCH
  when plugin and bridge came from different zips.
- **`plugin_status` instant tool** (bridge built-in, registry stays 113):
  queue/plugin/version/pending state in milliseconds; prompt preflight rule
  sends the model there first instead of hammering timeouts.
- **Two not-answering messages**: never-polled (install steps) vs stale poll
  (Studio closed?). Popup shows plugin state.
- **Installer**: warns loudly if Studio is running (old plugin stays in
  memory until full quit), cleans stray copies.

## [2.1.4] - 2026-09-20

Speed + character fixes; no failure class may spin past seconds anymore.

- **Queue hygiene**: claim expiry 60s -> 25s, settled commands swept after
  5 min, queue waits capped at 60s.
- **Circuit breaker**: 2 consecutive queue timeouts fail fast with
  `plugin_offline` until a fresh plugin poll arrives.
- **Fast unknown names**: garbage spellings get an instant
  `validation_error` with did-you-mean suggestions (stdlib difflib) instead
  of any network wait; extension refetches once on an empty catalog rather
  than firing blind.
- **Character discovery**: `play_animation` misses name real rigs with
  Humanoids; hint trigger is case-insensitive; Edit-mode playback reports
  `rendered: false` honestly instead of bare success.

## [2.1.3] - 2026-09-20

Execution correctness for the queue path.

- **Code payload**: code-carrying tools (`execute_luau`, `run_in_sandbox`,
  `refactor_code`) now send the code itself as the queue command (Node's
  convention, which the plugin executes) instead of the tool name.
- **Path resolution**: the plugin walks slash paths segment by segment
  (`Workspace/ProofCube` works); "not found" errors now list up to 8 sibling
  instances so the model self-corrects.
- **Single-copy guard**: the installer removes stray duplicate plugin files
  that would fight over queue claims.
- Alias added: `run_sandbox_tests` -> `run_in_sandbox`.

## [2.1.2] - 2026-09-20

HUD removal: the in-Studio hologram overlay is gone. Its per-execution chips
stacked without cleanup, and its unguarded claim hook could abort a poll so
claimed commands were never reported (bridge timeouts). The bridge terminal is
now the display: per-call lines plus plugin-reported execution time.
`studio-plugin/RoLink.lua` keeps the toolbar toggle button, dispatcher,
polling, and result reporting; Studio Output still logs each execution.

## [2.1.1] - 2026-09-20

Listing fix: `list_commands` (and the boot chip + periodic reminder) scoped the
default `roblox` view to `server === "roblox"` only, hiding the 111 padded
`server: "local"` catalog tools — the model saw 27 of 139. The default scope
now includes both; explicit `{"server": "<id>"}` filtering is unchanged.
No bridge changes; extension only.

## [2.1.0] - 2026-09-20

Third-party MCP path: all 113 registry tools now execute, not just list.

- **Embedded Studio queue** (`bridge.py`, stdlib only, `:3001`, API-compatible
  with `mcp-server`): the Studio plugin polls `/queue/next` and posts
  `/queue/result`; the bridge enqueues registry calls and waits. No Node needed.
- **Plugin packaging**: `studio-plugin/RoLink.lua` + `install-plugin.bat`,
  README step 2b (incl. the one-line `HttpEnabled` command-bar step).
- **Smart routing**: Studio-native spellings alias to registry names for the
  queue route only; the StudioMCP path always keeps the original spelling, so
  `list_commands` and friends can never break. Plugin absent = instant
  `plugin_offline` guidance (no burnt timeouts); port busy = loud warning.
- **Proof**: `tests/test_queue.py` (9: HTTP shapes, simulated-plugin
  round-trip, alias + offline paths) and `tests/test_tool_completeness.py`
  (5: every tool in registry.ts, RoLink.lua, prompts, samples/fixtures).

## [2.0.0] - 2026-09-20

Reboot on the free-edition codebase: the 1.5.5 foundation plus the full 113-tool
catalog (`mcp-server/`, `shared/`, `studio-plugin/`, `generated/`). The bridge
routes local tools offline (`get_time`, `validate_command`, `batch_queue`, ...),
pads `list_tools` to all 113 with param guidance, and pre-flights Luau before
sending it to Studio. The system prompt carries the grouped 113-tool catalog.
Every legacy free-edition identifier is now `RoLink` / `RL_*`
(`RL_BRIDGE_PORT`, markers `⟦RL-SYS⟧`); old env vars still work as fallbacks.

## [1.5.5] - 2026-09-10

### Fixed
- **DeepSeek: the agent starts again on DeepSeek's new unified model.**
  DeepSeek merged Instant, Expert and Vision into a single model and removed
  the model picker from the chat box. RoLink waited for one of those tabs
  to be selected before starting, so "Start Roblox agent" stopped with
  "DeepSeek mode not ready". A chat box with no model picker is now recognised
  as the unified model: RoLink switches Search off as before, leaves
  DeepThink on, and starts.
- **DeepSeek: screenshots work on every chat.** Images used to need the Vision
  tab, which no longer exists, so `screen_capture` was refused. The unified
  model reads images, and RoLink now sends them - one capture or several
  in a row. Older conversations still marked Instant or Expert stay text-only.

## [1.5.4] - 2026-09-06

### Fixed
- **ChatGPT: the RoLink bar is back where it belongs, above the composer.**
  ChatGPT redesigned its input box and renamed the layout slots it is built
  from: the full-width row across the top used to be called `header` and is now
  called `eyebrow`. RoLink still asked for `header`, a name that no longer
  exists, so the browser invented a place for the bar instead - it landed in a
  stray strip at the bottom right of the composer, and the text field itself was
  squeezed to zero width in the process. The bar now claims the correct row, and
  it also reads the layout live rather than trusting a fixed name, so the next
  time ChatGPT renames its slots the bar will follow instead of breaking.

### Changed
- **ChatGPT: replies are read straight from the page again.** The same redesign
  replaced the code-block editor that used to render each line separately and
  cut long lines off around 2000 characters - the cause of the truncated
  commands fixed in 1.5.1. Code blocks are now plain text with real line breaks,
  and a 400-line block reads back whole. The workaround stays in place for
  anyone still on the old interface.

## [1.5.3] - 2026-08-22

### Changed
- **Kimi moved to kimi.ai.** Kimi's old address, `kimi.com`, now asks for a
  Chinese phone number to sign in, which locked most people out. Kimi runs on
  `kimi.ai` from now on - the extension only activates there. The page itself is
  unchanged, so nothing about using Kimi with RoLink is different: open
  https://www.kimi.ai, the bar appears above the input box as before. If you had
  Kimi tabs open on the old address, reopen them on the new one.
- **DeepSeek: the Instant model is now allowed to run the agent.** Starting a
  session forced the Expert tab and, worse, the readiness gate only ever accepted
  Expert or Vision - so picking Instant left "Start Roblox agent" spinning
  forever with no explanation. Instant is now respected like Vision: pick it
  before starting and the session runs on it. It is much faster than Expert, at
  the cost of the reasoning pass. Images stay disabled on Instant exactly as they
  are on Expert - the Vision tab is still the only one that can see screenshots,
  so `screen_capture` is not offered to the model on the other two.

### Fixed
- **DeepSeek: a reply written in DeepSeek's own tool-call markup no longer kills
  the turn.** DeepSeek sometimes answers with its internal DSML invoke tags
  instead of a RoLink command. That format carries none of the markers
  RoLink looks for, so nothing recognised it as a command attempt: the tool
  never ran, the raw tags were left on screen, and the agent silently stopped
  with the user waiting on a dead turn. It is now detected, the markup is hidden
  behind a tool chip like any other command, and DeepSeek is told the format is
  unreadable so it rewrites the call properly. The chip shows the usual spinner
  while the model is still writing, then settles red as "wrong format".
- **ChatGPT: the RoLink bar no longer collides with the composer's rounded
  corners.** The composer card is rounded by 28px and the bar sits flush against
  its top edge, so the Discord button's corner fell outside the rounded shape and
  was sliced off by the card. Both ends of the bar are inset to clear the curve.

## [1.5.2] - 2026-08-14

### Added
- **ChatGPT: the operating instructions are now re-stated periodically.** ChatGPT
  summarises its own context mid-session, and the part it drops first is the
  *mechanism* - that an extension reads its replies and really runs them. It
  would then answer "I can't invoke those commands in this session" while the
  extension sat there, ready. The full instructions are now re-sent
  automatically, riding along on a tool result so they cost no extra message and
  stay hidden from you (they appear as a "Reminder" chip). A tool result is
  never shortened to make room: if the pair would not fit, the reminder simply
  waits for the next one. ChatGPT only - no other provider needs it.
- **ChatGPT: an image you send is now treated as reference material.** Unless you
  explicitly ask for a picture, ChatGPT used to answer a screenshot or a mockup
  by *generating a new image* instead of doing the work it was meant to
  illustrate - and its image tool cannot reach your place anyway.

### Fixed
- **ChatGPT: you can chat normally again without starting an agent.** On a blank
  ChatGPT tab the extension refused to let a message send until you clicked
  "Start Roblox agent". Every other provider only suggests it; ChatGPT was the
  odd one out.
- **A finished command is no longer stranded as "not run".** After a long reply
  (seen on Qwen writing for 400s and more) the loop could give up while the model
  was still going; eight seconds later the completed command was written off for
  good. That window is now three minutes, so the command actually runs.
- **A clear message when RoLink is updated while a tab is open.** Chrome
  updates extensions underneath open tabs, which leaves the page running a
  version that no longer exists. RoLink reported this as "the bridge stopped
  on your PC - run start.bat", sending you to fix something that was never
  broken. It now says plainly that the page needs reloading, and offers a Reload
  button - your bridge and Studio are untouched.
- **The AI no longer claims your bridge is offline without checking.** After one
  momentary outage it would keep repeating "Roblox is offline" from memory, even
  once everything was back. It must now actually run a command before saying so.

## [1.5.1] - 2026-08-13

### Added
- **ChatGPT support (chatgpt.com).** RoLink now runs on ChatGPT as an
  eighth provider. Image input is deliberately disabled there: ChatGPT's free
  tier caps files/images on a separate quota from messages, so vision would
  work only part of the day. Reasoning mode ("Analyser") and the model picker
  are left entirely to you.

### Fixed
- **Meta AI: fixed large commands failing with "bad JSON".** Meta renders a
  ```json block as an interactive viewer whose default *Tree* view does not
  merely decorate the JSON - it **abridges** it: a large array or object is
  replaced by a summary placeholder. A 19103-character `multi_edit` was present
  in the page as 223 characters ending in `"edits":[1 item]`, so RoLink sent
  the parser a truncated object and the command came back as a parse error every
  time. This is also why the tool chip's token counter climbed while the reply
  streamed and then **collapsed to about 44 tokens** the moment the block
  finished rendering - the counter was faithfully reporting what could be read.
  Command blocks are now switched to the viewer's *Raw* tab, which holds the
  verbatim source; the 19103-character payload is read whole.
- **Clearer diagnosis when Roblox refuses to parse Luau.** "Failed to parse
  command code" is Studio's generic parse rejection, but RoLink always
  answered it with "your code block was empty or the marker was wrong". When a
  full code string *had* been sent, that advice pointed the model at a problem
  that did not exist, so it re-sent the same payload and failed again. The hint
  now only mentions the `###LUA###` markers when the code really was empty, and
  otherwise reports how many characters were sent and names the real causes -
  invalid syntax, or code too large/complex for the parser. (Measured live: a
  `return 1+1+1+…` chain ran at 1006 characters and was rejected at 2006.)
- **ChatGPT: fixed most tool calls failing outright.** ChatGPT renders code
  blocks with CodeMirror, which puts one element per line and **no newline
  characters at all** in the page. Reading a reply the usual way therefore
  returned the whole script glued onto a single line, so a perfectly valid
  command came back as "Failed to parse command code / your code block was
  empty", and the calls that did run reported every Luau error on line 1.
  Replies are now read with the line structure preserved.
- **ChatGPT: fixed long commands being executed truncated.** Beyond roughly
  2000-4000 characters, CodeMirror only renders *part* of a long line and the
  rendered text then stays frozen while the model keeps writing - the tool
  chip's token counter would climb, drop back to about 500 tokens, freeze
  there, and the command would run cut off. Measured live: a 21273-character
  command of which the page exposed 4049. RoLink now reads the editor's
  real document instead of the rendered page, through a new MAIN-world tap
  (`providers/chatgpt-cm.js`), the same approach already used for Qwen's
  Monaco editor. A 5.3k-token `multi_edit` now applies whole.
- **ChatGPT: fixed the raw command staying visible.** When the model writes a
  command without wrapping it in a code fence, ChatGPT splits it into dozens of
  sibling paragraphs (68 of them for a 208-line script) and only the first one
  carried the marker, so the rest of the script stayed on screen. The whole
  marker-to-marker range is now hidden, including while it streams.
- **Fixed the agent dying silently when the model called a tool the
  function-calling way.** A reply like
  `{"toolName": "get_studio_state", "studio_id": "…"}` names a real tool but
  uses the wrong key, so nothing recognised it as a command: the turn was
  finalised as a plain-text answer and the loop simply ended, leaving the agent
  looking frozen (seen on ChatGPT in a long session). RoLink now spots a
  known tool named under `toolName` / `tool` / `name` / `function` / `action`
  and asks the model to rewrite it with the proper envelope, exactly as it
  already did for a missing `###LUA###` opener or bare parameters. Prose that
  merely mentions a tool name is not affected - the check requires a tool that
  is really in the catalogue.
- **Fixed the "Agent is working…" cover hanging past the composer on the first
  send.** Injecting the system prompt grows the composer, the page gains a
  scrollbar and the content column narrows, so the composer slides sideways -
  and a site that animates that move updates its layout after the cover has
  already been placed, leaving it a frame behind (28px past the card's right
  edge on ChatGPT). The cover is now clamped to the composer card, so a stale
  measurement can never be seen. Only the first send was affected, because the
  composer stops moving once it is docked at the bottom.

## [1.5.0] - 2026-07-30

### Fixed
- **Backgrounding the AI tab no longer strands a pending command as a grey
  "not run".** `waitForResponse` now parks entirely while the tab is hidden and
  shifts every internal deadline (inactivity timeout, warm-up, text-stability,
  etc.) forward by the parked duration, instead of letting them keep ticking
  off-screen. `waitVisible` switched from polling to listening for
  `visibilitychange` - Chrome clamps chained background timers to one tick per
  minute after 5 minutes hidden, which used to delay the resume by up to a
  minute. The bar now shows a **Paused** state while parked, and a genuinely
  empty reply from the site now shows a banner instead of ending the loop
  silently.
- **Gemini: fixed the page freezing (nothing clickable) on a large tool
  result.** Gemini's composer inserts text line by line, synchronously, on the
  main thread - a 2599-line `http_get` result froze the page for about a
  minute. Outgoing text is now capped (120k chars / 1200 lines, head and tail
  kept) and the insert yields to the browser every 120 lines.
- **Gemini: fixed the system prompt occasionally never leaving the composer on
  Start.** The wedged-stop-button detector latches for 2 seconds from the
  first time it sees a stop button, so the single recovery attempt at boot -
  the very first sighting - was refused by its own guard. It now retries
  across that window and retypes as a last resort.
- **Kimi: fixed the model picker opening and closing in a loop.** Kimi's K3
  update removed the model (K2.6) the default-model routine used to select,
  so it kept hunting for a row that no longer exists. It now only acts when
  the current model is **K3 Swarm** (matched by name, any UI language) and
  gives up after a few tries instead of looping. The native-agent warning
  guard was equally broken by the same update and now reads the model label
  at its new location.
- **Degraded mode (Roblox Studio closed, running on an addon server only)
  starts much faster.** The tool catalogue request blocks until timeout when
  Roblox is down, and the boot sequence called it three times in a row. Added
  a 30s cache on the catalogue and cut the request timeout from 25s to 10s.

## [1.4.9] - 2026-07-24

### Added
- **Popup: new Settings button.** Opens the same Switch AI / support panel
  as the in-page bar, without needing an already-started conversation. The
  footer text no longer singles out chat.deepseek.com - it now points to
  "a supported AI" since seven providers are supported.
- **Bridge: auto-recovers its own port on relaunch.** Relaunching `start.bat`
  while a previous Bridge was still holding port 17613 (window closed with
  the X, a crash, a double launch) used to crash with a cryptic, sometimes
  localized `OSError [WinError 10048]`. The Bridge now detects and kills a
  leftover Bridge process it can positively identify (by command line, never
  by process name alone) before binding, and falls through to a clear,
  actionable message - with the exact `netstat`/`taskkill` commands and the
  `RL_BRIDGE_PORT` override - if the port is held by something else.

### Fixed
- **The agent could parse/execute commands while its AI tab was backgrounded
  or the window minimized.** Background tabs throttle rendering and timers,
  which made DOM reads unreliable and could send duplicate feedback or run a
  tool blind (observed live: GLM kept running `execute_luau` while minimized).
  The agent loop, the tool-dispatch step, and the auto-resume watchdog now
  all gate on `document.visibilityState` and park - with no time limit -
  until the AI tab is the foreground tab again, then resume exactly where
  they left off. Working with Roblox Studio focused while the AI tab stays
  the active tab in its own window is unaffected; this only pauses execution
  while that tab is truly backgrounded or its window minimized.

## [1.4.8] - 2026-07-22

### Added
- **macOS and Linux support for the Bridge.** A new self-contained
  `MacOS_Start.command` launcher (double-click in Finder - no Terminal
  knowledge needed) finds Python 3.9+, installs `websockets` if missing,
  frees a previous Bridge still holding the port, and runs `bridge.py`,
  mirroring what `start.bat` already does on Windows. `launch_studio_mcp.py`
  now also locates Roblox Studio's MCP binary inside the macOS app bundle
  (`RobloxStudio.app/Contents/MacOS/StudioMCP`), with a `RL_STUDIO_MCP_PATH`
  override for non-standard installs.
- **DeepSeek: outgoing messages are now truncated to fit its input limit.**
  DeepSeek's composer silently refuses to send past 163840 characters
  (validated live), which could wedge the agent in the input box after a
  large tool result (a big `http_get` / `get_page_text` / Luau dump). Long
  results are now truncated to a safe margin below that limit, keeping both
  the start and the end of the content, the same approach already used for
  Qwen and Arena.

## [1.4.7] - 2026-07-21

### Fixed
- **Qwen: a tool could show a green "done" check while it never ran and returned
  no result** (seen rarely with repeated `multi_edit` / `execute_luau` calls, with
  no Stop or regenerate involved). Qwen virtualizes its message list, so the
  off-DOM "already executed" record was keyed on the positional turn index, and
  two turns that shared the same 60-character command prefix could collide on the
  same index. That false positive made the auto-resume watchdog skip the fresh
  command (so it never ran, no result was injected) while the chip was still
  painted a green check. The dedupe now keys on Qwen's stable per-turn id
  (`chat-response-message-<uuid>`, exposed as `itemKey`) instead of the index, so
  the collision cannot happen.
- **Qwen: the RoLink bar covered the "Expand more models" submenu.** That
  fly-out is a separate body-portalled `.ant-dropdown` at a low z-index, not the
  main model dropdown, so the bar drew on top of it. Raised just that dropdown
  above the bar (scoped so other Ant menus and tooltips are untouched).

### Added
- **Per-model image support on Qwen.** Qwen offers both multimodal and text-only
  models, switchable mid-conversation, and image input only works on the
  multimodal ones. `screen_capture` and image input are now enabled only on a
  vision-capable model (Qwen3.7-Plus, Qwen3.6-Plus, Qwen3.6-27B, Qwen3.8-Max-Preview)
  and correctly withheld on a text-only one (Qwen3.7-Max, Qwen3.6-Max-Preview),
  read from the selected model and updated when you switch models.
- **Image support on DeepSeek's Vision model.** DeepSeek forces its Expert model
  for the agent, but if you choose the Vision tab that choice is now respected and
  `screen_capture` plus image input are enabled for it. Selecting Vision is
  detected reliably, including after switching conversations. Image attachment was
  also fixed: it used to stage the same image multiple times and never send,
  because the upload went through a paste that only made a local preview and never
  uploaded the file. It now uses DeepSeek's real file upload and sends once the
  upload completes.

## [1.4.6] - 2026-07-19

### Fixed
- **Kimi's login and "priority queue" popups were covered by the RoLink
  bar**: both render as full-screen fixed masks (`.login-modal-mask` and
  `.modal-mask`) rather than a standard `[role="dialog"]`, so the generic
  overlay probe used by other providers never caught them. The anchored bar
  (a full-width fixed element hugging the composer) and the "unstable"
  warning pill sat on top of the mask and could intercept clicks meant for
  its buttons (e.g. "Continue with Google"). Added a Kimi-specific
  `overlayBlocking()` that detects both mask classes by real visibility; the
  core already hides the whole bar while it reports true, and restores it the
  instant the mask clears.

### Added
- **Kimi now defaults fresh chats to K2.6**: Kimi lands new chats on K3,
  which is flagged unstable here and easy to miss switching away from. A
  brand new or emptied chat now picks K2.6 automatically, once; a deliberate
  manual switch to K3 on that same chat is left alone.

## [1.4.5] - 2026-07-18

### Fixed
- **DeepSeek re-executed old tool commands when scrolling up in a long
  conversation**: DeepSeek virtualizes its message list, so scrolling up makes
  an OLD command turn the last *rendered* assistant turn - its injected result
  sits below the fold (unrendered), the in-memory "already executed" record is
  empty after a page reload, and the node change makes generation detection
  flicker true, refreshing the auto-resume watchdog's freshness clock. The
  watchdog then re-fired the historical tool. Three-layer fix (validated live):
  - The off-DOM executed/halted dedupe maps now key on a virtualization-stable
    per-turn id (`itemKey`, DeepSeek's `data-virtual-list-item-key`) instead of
    the positional assistant index, which collides across scroll windows.
  - The watchdog skips any command turn whose stable id is below the session's
    high-water mark (`A.maxTurnId`) - a scrolled-back old turn can never resume,
    even right after a reload (`resume.skipOld` in the diag ring).
  - The watchdog also skips a command turn whose injected result is rendered
    right below it (settled history), a provider-generic guard.
- **Gemini stranded a tool result in the composer ("Message could not be
  sent")**: after a generation ends, Gemini's action button can stay WEDGED on
  the stop icon instead of reverting to the send arrow. The loop's generation
  *detection* already tolerates this (WEDGE_MS), so the tool ran, but the *send*
  waited for an `arrow_upward` button that never appeared - four retries failed
  and the injected result sat unsent in the composer. `typeAndSend` now resets a
  frozen stop button (clicking it, guarded by the same not-actually-generating
  check) so the send button reappears, then sends (validated live). The native
  stop-click hook now ignores non-trusted (programmatic) clicks, so this
  un-wedge click is never mistaken for the user halting the agent - otherwise
  the next legitimate command was wrongly marked "stopped".

## [1.4.4] - 2026-07-16

### Fixed
- **Qwen fired tool commands mid-stream ("Bad JSON" while Qwen was still
  writing)**: Qwen's frontend update (fe 0.2.73) now emits `status:"finished"`
  in its SSE stream ~12s before the stream actually closes. The network tap
  treated that as the turn's end, so a still-incomplete command (e.g. an
  unclosed `###LUA###` block) was extracted and sent, and the loop's premature
  "unclosed" feedback was injected while the model kept writing. Fixed by no
  longer treating `status:"finished"` as done, and by having generation
  detection check the DOM stop button first (validated live: it now tracks the
  real stream end closely, unlike its old ~6s lag).

### Changed
- **Removed the "⚠ unstable" badge on Qwen's Auto/Think modes**: those modes
  used to make Qwen claim a tool "does not exist" without even trying it. The
  extension never force-switches Qwen's mode, so Auto (Qwen's own default) is
  left untouched.

## [1.4.3] - 2026-07-15

Adds a seventh AI provider (Meta AI) and fixes a Qwen tool-turn regression, plus
further Studio-port recovery hardening and a friendlier system prompt.

### Added
- **Meta AI (www.meta.ai) as a provider**: full RoLink support on Meta AI -
  new `providers/meta.js`, manifest content script + host permissions, and the
  provider switcher entry. Handles Meta's React DOM: reasoning ("Réflexion")
  chain-of-thought is excluded from the read text, the interactive JSON viewer
  and collapsible code blocks are masked so a streamed command never flashes, and
  the composer card is fully covered while typing. Meta AI accepts very large
  prompts, so no Qwen-style send cap is needed.

### Fixed
- **Qwen tool result took ~30s to inject on every tool turn**: Qwen dropped the
  assistant turn's own `id`, so `lastAssistantId()` returned null and the core
  fell back to the virtualized flat count, waiting the full ~30s NO_TURN_GRACE
  each turn. It now reads the stable `chat-response-message-<uuid>` descendant
  (with the old id kept as a fallback).
- **Qwen refused oversized messages**: a large tool result past Qwen's 131072
  character composer cap silently wedged the loop in the input box. Outgoing text
  is now truncated to a safe margin, keeping the head and tail and marking the gap
  so the model does not re-run the command.

### Changed
- **Friendlier, less restrictive system prompt**: the "do not use native tools"
  wording is reframed as a technical note (the site's own sandbox cannot reach the
  user's Studio) rather than a hard prohibition, with an explicit "you can act
  directly in the user's project" section. Reduces provider refusals.
- **Studio-port recovery hardening**: PID-based reclaim of leftover `StudioMCP`
  zombies and clearer, de-duplicated action banners on top of the 1.4.2 port
  hijack recovery.

## [1.4.2] - 2026-07-13

Follow-up robustness fixes for the Studio-connection failures the 1.4.1 work
did not cover: a rare "0 tools that survives every restart" deadlock, and a
third-party app silently hijacking Studio's MCP port.

### Fixed
- **A third-party app (e.g. ropilot) hijacking Studio's MCP port**: whichever
  program binds Studio's MCP port (13469) FIRST wins it, and if that is not
  Studio, `StudioMCP.exe` connects to the wrong host - the handshake succeeds
  but no tools ever appear. A PC reboot never helps because the offending app
  restarts with Windows and can grab the port before Studio again. The existing
  one-shot port check at boot could miss it. The bridge now detects the hijack
  from an unmistakable, timing-independent signal - `StudioMCP.exe` reporting it
  cannot parse the host's messages on that port - then kills the offending
  process (by port owner, with a fallback that kills the known squatter by
  name), restarts the proxy, and tells the user which app to uninstall or remove
  from Windows startup so it stops coming back. It never stays silent: if it
  cannot identify or kill the squatter it prints how to find it by hand.
- **`_port_owner` was IPv4-only**: the internal port-owner probe ran
  `netstat -p TCP`, so a squatter listening on IPv6 loopback was invisible to
  it; it now scans TCP and TCPv6.
- **A missing custom-MCP command (e.g. `uvx` not installed) looked like an
  endless silent restart loop**: when a configured server's command could not
  be found on PATH, the process never started, so there was no exit code and no
  stderr, and the crash-loop banner printed "the server printed no error output
  before dying". The bridge now catches the launch failure and names the real
  cause ("command not found: 'uvx' ...") both on the first attempt and in the
  crash-loop banner, while auto-restart keeps retrying in case the dependency
  is installed later.

### Changed
- After killing a port squatter, the "toggle Studio's MCP server OFF/ON"
  instruction now prints IMMEDIATELY (right after the kill) instead of only
  after the ~48s server-launch grace loop - so the user acts within seconds
  instead of staring at a seemingly-idle terminal for a minute. Toggling early
  also lets the grace loop pick up the tools and go green right away.
- **0 tools that no restart could fix**: if a `StudioMCP.exe` from a crashed
  session kept listening on Studio's MCP port (13469), reopening Studio made
  its MCP plugin do its one-shot registration against that *zombie* process.
  Because a Studio window was now running, both existing cleanups skipped it
  (the orphan-killer only acts when no Studio runs; the port check treats any
  Roblox-path owner as legitimate), so our fresh proxy could never own the
  port - 0 tools forever, unfixable by restarting Studio or the bridge in any
  order. The bridge now identifies the port owner by process ID: a
  `StudioMCP.exe` holding the port that this bridge did not launch (outside our
  own process tree) is a leftover by definition, so it is killed and the proxy
  restarted - at boot and again in the live watcher if the catalogue stays
  empty with Studio open. It then tells the user the one action that finishes
  recovery: open Assistant Settings > MCP Servers so Studio re-registers. If
  the process tree can't be read, nothing is killed (a healthy connection is
  never put at risk).
- The extension now tells non-technical users to "Run start.bat" instead of
  "Run python bridge.py" / "Run the RoLink bridge" in the offline panel,
  popup, and startup banner, matching the one-click launcher the README ships.

## [1.4.1] - 2026-07-11

Robustness release focused on the Roblox Studio connection lifecycle. Every
fix below was reproduced and validated live against a real Studio + Blender
setup, including the Roblox-side bugs reported on the devforum (StudioMCP
stale-pipe disconnects, MCP toggle turning off after a Studio update).

### Fixed
- **Phantom "Studio connected" state**: leftover `StudioMCP.exe` processes
  from a previous session or a Studio crash kept answering the bridge as if a
  Studio were attached, so the terminal and the extension showed green with
  Studio fully closed. The bridge now kills orphaned `StudioMCP.exe` at boot
  (only when no real Studio window exists, so a live connection can never be
  hit), and the boot banner re-confirms a positive probe before announcing a
  connection.
- **Status dot stuck green with Studio closed**: when StudioMCP advertised an
  empty tool catalogue (Studio closed at launch), the connectivity probe
  returned "unknown" instead of "disconnected", and the extension's
  don't-degrade-on-unknown rule kept the dot green forever. An alive Roblox
  proxy with an empty catalogue is now an authoritative "not connected".
- **Studio opened after the bridge was never detected** (yellow until a full
  bridge restart): two combined causes. (1) Nothing ever re-asked for the
  tool catalogue once the launch-time retry window expired - the watcher now
  re-polls `tools/list` while the catalogue is empty, so a late-attaching
  Studio is picked up within seconds. (2) Studio's MCP plugin registers with
  the MCP channel exactly ONCE (late in Studio's boot, or when the Assistant
  Settings > MCP Servers panel is opened/toggled) and never retries; the
  bridge's own recovery restarts could kill the MCP listener at that exact
  moment, permanently orphaning the plugin. The bridge no longer restarts the
  Roblox proxy while a Studio window is running, and both the terminal and
  the extension now say the one thing that actually fixes an orphaned
  plugin: open Assistant Settings > MCP Servers in Studio (validated three
  times live; a proxy-side restart provably cannot repair it).
- **Watcher crash silently disabling all Studio monitoring**: an unbound
  variable in the place-churn detector could kill the background watcher
  right after a reconnect, silently stopping every status update until the
  next bridge restart. Fixed, and both watchers are now supervised: a crash
  is logged in red and the watcher restarts itself in 5 seconds.
- Boot/connection messages no longer blame the merged multi-server tool count
  on Roblox ("49 tools loaded but NO Roblox Studio connected" when 22 of
  those were Blender's): every Roblox-specific message now uses the
  Roblox-only count.

### Added
- **Fast startup with addon servers**: MCP servers now launch in parallel and
  the extension-facing socket opens immediately, so a slow or absent Roblox
  Studio no longer delays Blender (or any addon) by up to a minute. The
  Roblox diagnostic continues in the background and the bridge pushes status
  updates to already-connected extensions as servers come up - previously an
  extension that connected early could keep a stale "addon offline" snapshot
  forever (greyed Start button instead of the orange degraded start).
- **Self-healing for Roblox's own disconnect bugs**: sustained loss of the
  Studio connection (stale named-pipe state, periodic silent disconnects)
  now auto-restarts the Roblox proxy - but only when no Studio window is
  running, where it is safe and effective.
- **Studio-update detection**: when a disconnect coincides with a new Studio
  version folder appearing, the terminal says Studio likely turned its MCP
  toggle off after updating (a known Roblox bug) and points at the exact
  setting, instead of retrying a recovery that cannot work.
- Extension messages distinguish "Roblox Studio is not running" from "Studio
  is running but not connected" (new `studio_proc` status field), each with
  its own corrective step.
- Terminal spinner during slow startup phases (server launch, Studio
  attach), so the console never looks frozen; only one spinner animates at a
  time.
- start.bat hardening: refuses to run from an unextracted ZIP, handles
  missing winget, rescans install folders after a winget install (PATH not
  refreshed), prints the Python version and the bridge's exit code on
  screen, and logs the Windows build - so a single screenshot of the
  terminal carries enough context for support.

## [1.4.0] - 2026-07-08

### Added
- Multi-MCP addon servers (experimental): a new "MCP servers" section in the
  panel menu lets you add or remove additional MCP servers (Blender,
  Sketchfab, or any local MCP command) alongside the always-primary Roblox
  Studio connection. The bridge rewrites `config.json` and restarts itself to
  load a change; Roblox stays protected from edits/removal and its status dot
  is scoped to Roblox alone so an addon going down never misrepresents the
  primary connection. New `list_mcp_servers` command and a `server` param on
  `list_commands` let the model discover and use addon tool sets on demand.
  When Roblox is down but an addon server is alive, the panel now offers a
  degraded start instead of refusing to start at all.
- Vision support (screen_capture / other tool-returned images) enabled for
  Arena, Gemini, GLM, Kimi and Qwen, each with a real "upload finished" signal
  before sending instead of trusting the first local preview, fixing several
  silent-attachment-drop and duplicate-attachment-on-retry bugs. A tool from
  any connected server that returns an image now gets the camera chip and is
  remembered for future calls, even for a custom MCP server whose name gives
  no hint it returns images.
- Parser: a JSON command cut off by the model's own output limit, missing
  only its trailing closing brackets, is now auto-completed and executed
  instead of failing with a parse error and forcing a full retry turn.
  Strictly refuses to salvage anything where real content (not just closers)
  was cut off.
- Per-reason parse-error feedback (cut off, bad JSON, missing ###LUA###
  opener, wrong envelope) instead of one generic "bad JSON" message, so the
  model fixes the actual problem instead of guessing.

### Fixed
- DeepSeek: a command's chip could show green "done" while DeepSeek was still
  streaming the reply, on back-to-back calls to the same tool. Caused by
  DeepSeek's list virtualization defeating the turn-count identity guard;
  fixed with a stable per-turn id.
- GLM: new "scroll to bottom" buttons were mistaken for the Stop button and
  permanently latched generation state to "busy." Raw command JSON could leak
  into the visible reply when nested inside a paragraph. An image filename
  could corrupt result-chip detection.
- Kimi: added detection of Kimi's own native "Agent" mode, which conflicts
  with RoLink's command protocol; Start is disabled with a warning until
  it's turned off. Fixed the hidden file-upload input not existing until the
  "+" menu is opened, raw command text leaking when nested/oversized, and
  normal model prose containing "try again" being misread as a site error.
- Qwen: same "try again" false-busy fix as Kimi. A/B "carousel" comparison
  turns (where the composer disappears mid-carousel) now auto-resolve to
  Response 1 once both candidates finish, instead of stalling or misreading a
  candidate as a truncated command.
- Arena: send is now confirmed until the composer actually clears instead of
  trusting a single click, preventing stranded messages/attachments; the chip
  now anchors below the reply text instead of floating above it.
- A command turn abandoned mid-stream (reload, or superseded by a
  regenerate) no longer shows a false green checkmark; it now shows a
  neutral "not run" state instead.
- A tool's own in-body error (e.g. "Output of '...': Error executing code...")
  now settles the chip red instead of green, even when the tool didn't use
  RoLink's own ERROR wrapper.
- Regenerating a stopped command no longer briefly re-shows the old call's
  chip before the new one streams in.

### Changed
- The version number next to the RoLink name in the panel is now small,
  plain text instead of a bordered green badge.
- System prompt updated to cover multiple MCP servers: the model must call
  `list_mcp_servers` before assuming something outside Roblox is unsupported,
  and the tool list is no longer inlined in the prompt (fetched on demand via
  `list_commands`).

## [1.3.9] - 2026-07-04

### Fixed
- Bridge: kill the full process tree on restart instead of just the wrapper
  process, which used to leave orphaned StudioMCP.exe instances behind that
  fought the next launch and caused seemingly random "Studio looks connected
  but nothing responds" failures.
- Bridge: a dead MCP server is now auto-restarted by a background watchdog
  instead of waiting for the next tool call to notice.
- Bridge: a tool call that hits one of Studio's own brief connection blips now
  retries once instead of surfacing a spurious "Studio not connected" error.
- Extension: the status bar no longer shows a falsely healthy "N tools" label
  when the agent is active but Studio, the place, or the bridge itself isn't
  actually usable, it now names the real blocker (open a place / enable the
  MCP server / bridge offline).
- Cross-provider: DeepSeek, Gemini, Kimi, GLM and Qwen composer menus, model
  pickers and tooltips (including GLM's search hover card and Kimi's model
  popover) no longer render clipped or hidden behind RoLink's own
  bar/pill/cover.
- Cross-provider: a thinking model quoting command JSON in its own reasoning
  area no longer makes the tool chip flap between done/run/done (Gemini, Kimi,
  GLM and Qwen).
- The "Agent is working" composer cover now blocks clicks into the composer
  underneath it instead of letting them through, and can no longer balloon
  past the composer's visible band or drag itself off position when a site
  recreates its editor node mid-session (seen on Kimi).
- A command chip could briefly flash or restart its spinner when revisiting a
  past turn; it now settles to done correctly instead.
- DeepSeek: the raw system-prompt turn no longer flashes for a frame before
  being hidden.
- Gemini: "New chat" no longer gets stuck on "Agent active" from a reused
  previous conversation URL.
- Kimi: reasoning is read separately from the actual reply, so a command
  drafted while the model is still "thinking" is no longer detected or
  executed; input can no longer be typed mid-run after the editor node is
  recreated.
- Arena: unsupported-mode gate now also covers Web Search and Generate Image,
  and chip alignment is fixed when a command turn renders as an A/B
  model-comparison carousel.
- Bridge: a long-running tool call no longer starves the connection's ping
  handling and trips the half-open-socket watchdog.

### Changed
- Bridge and installer logs moved to `logs/bridge_debug.log` and
  `logs/start.log`; the console now only shows what a user actually needs to
  read, full detail still lands in the log files.
- `start.bat` now detects and explains a double launch instead of silently
  replacing the previous instance, and warns clearly if port 17613 stays held
  after trying to free it.
- Removed remaining em dashes from user-visible strings.
- Removed remaining em dashes from user-visible strings.

## [1.3.3] - 2026-06-24

### Fixed
- Bridge no longer depends on Roblox's `mcp.bat`, which hard-coded a single
  Studio version path and broke (0 tools / "Bridge or Studio offline") once
  Studio auto-updated and that version folder was removed. A new
  `launch_studio_mcp.py` finds the newest installed `StudioMCP.exe` and launches
  it directly.
- `bridge.py` now runs a `.py` MCP command with the same Python interpreter as
  the bridge, so it works on installs where only the `py` launcher exists.

## [1.0.0] - 2026-06-09

### Added
- Initial public release of RoLink Free
- Browser extension for Chrome and Edge (DeepSeek chat integration)
- Local Python bridge (`bridge.py` + `start.bat`) for Roblox Studio communication
- Built-in MCP server support (no plugin required - activate directly in Roblox Studio)
- Read and edit Luau scripts directly from DeepSeek chat
- Run Luau code in real time inside Roblox Studio
- Inspect game tree and instances
- Generate meshes, materials, and models
- Browse and insert assets from the Creator Store
- Control play-testing from chat
- Panel status indicator (green / yellow / grey)
- Auto kill port 17613 on start to avoid conflicts
- Ko-fi support link with Robux tip passes in the extension panel
- Setup tutorial video on YouTube
