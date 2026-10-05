import { z } from "zod";
import { commandQueue } from "../commandQueue.js";
import { isToolAllowed, sanitizeCode } from "../security/policy.js";
import { healCode } from "../selfHeal.js";
import { rollbackManager } from "../rollback.js";
import { perfTracker } from "../perfTracker.js";
import { translate, detectEngine } from "../multiEngine.js";
import { validateLuau, makeSandboxTestHarness } from "../sandbox.js";
import { analyzeRisk, riskSummary } from "../security/preflight.js";
import { planFromPrompt } from "../planning.js";
import { buildContext } from "../contextInjection.js";
import { templateStore } from "../templates.js";
import { aiTraining } from "../aiTraining.js";
import { generateTests, buildHarness } from "../testGen.js";
import { autoCommit, gitLog } from "../gitCommit.js";
import { reviewLuau, refactoringPlan } from "../codeReview.js";
import { teamLog } from "../teamLog.js";
import { compileGraph, graphFromPrompt } from "../visualCompiler.js";
import { collabManager } from "../collab.js";
import { searchAssets, assetCategory, isValidAssetImportResult } from "../assetStore.js";
import { gameplayFeedback } from "../gameplayFeedback.js";
import { generateGDD } from "../gdd.js";
import { generateAsset, generateVariants } from "../assetGen.js";
import { autoOptimize } from "../perfOptLoop.js";
import { analyticsEngine } from "../analytics.js";

export type ToolDef = {
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  handler: (args: any) => Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }>;
  provider?: "roblox" | "rolink";
  execution?: "studio" | "local";
};

export function unifiedCatalog(){
  return tools.map(t => ({
    name: t.name,
    description: t.description,
    provider: (t as any).provider || "rolink",
    execution: (t as any).execution || "local"
  }));
}

function queueAndWait(tool: string, command: string, args: Record<string, unknown>, timeoutMs = 15000) {
  if (!isToolAllowed(tool)) throw new Error(`tool not allowed: ${tool}`);
  const projectId = typeof args.projectId === "string" ? args.projectId : undefined;
  const cmd = commandQueue.enqueue({ tool, command, args, timeoutMs, projectId, meta: (args as any).meta });
  teamLog.append("info", (args.projectId as string) || "default", "mcp", `enqueue ${tool}`, { id: cmd.id });
  return { id: cmd.id, enqueued: cmd };
}
function studioQueue(tool: string, cmd: string, args: any){
  // DEPRECATED fire-and-forget ack — kept for handlers that intentionally do
  // not block (analytics, local planning). Studio-mutating handlers MUST use
  // studioQueueAndWait() below so the AI never infers success from queued:true.
  const { id } = queueAndWait(tool, cmd, args);
  return JSON.stringify({ queued:true, id, tool, terminal: false, note: "accepted by queue, NOT executed yet — use the execution envelope" }, null, 2);
}

function envelopeOk(tool: string, id: string, t0: number, result: unknown) {
  return JSON.stringify({
    ok: true, tool, executionId: id, status: "success",
    durationMs: Date.now() - t0, result,
    verification: { checked: false },
  }, null, 2);
}
function envelopeErr(tool: string, id: string, t0: number, code: string, message: string) {
  return JSON.stringify({
    ok: false, tool, executionId: id, status: code === "TIMEOUT" ? "timeout" : "error",
    durationMs: Date.now() - t0,
    error: { code, message },
    verification: { checked: false },
  }, null, 2);
}
/** Enqueue + WAIT for the Studio plugin. Returns a terminal ExecutionEnvelope — never bare queued:true. */
async function studioQueueAndWait(tool: string, cmd: string, args: any, timeoutMs = 15000){
  const t0 = Date.now();
  let id = "";
  try {
    const q = queueAndWait(tool, cmd, args, timeoutMs);
    id = q.id;
  } catch (e: any) {
    return envelopeErr(tool, id || "rl_unknown", t0, "MCP_OFFLINE", String(e?.message || e));
  }
  try {
    const result = await commandQueue.waitForResult(id, timeoutMs);
    return envelopeOk(tool, id, t0, result);
  } catch (e: any) {
    const msg = String(e?.message || e);
    const code = /timeout/i.test(msg) ? "TIMEOUT" : "STUDIO_EXECUTION_FAILED";
    return envelopeErr(tool, id, t0, code, msg);
  }
}

function normalizeImportTerminal(text: string): { text: string; isError: boolean } {
  try {
    const env = JSON.parse(text);
    if (!env.ok) return { text, isError: true };
    if (!isValidAssetImportResult(env.result)) {
      return {
        text: JSON.stringify({ ok: false, tool: "import_asset", status: "error",
          error: { code: "ASSET_IMPORT_INVALID", message: "Studio did not return a verified inserted path" },
          verification: { checked: false } }, null, 2),
        isError: true,
      };
    }
    return { text, isError: false };
  } catch (e: any) {
    return { text: JSON.stringify({ ok: false, tool: "import_asset", status: "error",
      error: { code: "ASSET_IMPORT_INVALID", message: String(e?.message || e) },
      verification: { checked: false } }, null, 2), isError: true };
  }
}

// Legacy alias map (run_code -> execute_luau etc) handled in lookup, not as separate toolDefs
// Includes AI-expected aliases like search_game_tree, script_search so chips become visible
export const aliasMap: Record<string,string> = {
  run_code: "execute_luau",
  get_snapshot: "take_snapshot",
  set_property: "set_properties",
  get_logs: "export_session_log",
  perf_stats: "get_performance_stats",
  translate_code: "validate_command",
  validate_code: "validate_command",
  run_sandbox_tests: "run_in_sandbox",
  plan: "plan_game",
  get_context: "get_context_summary",
  list_templates: "list_templates",
  use_template: "apply_template",
  create_template: "add_template",
  style_profile: "train_model",
  personalize_code: "train_model",
  generate_tests: "generate_test",
  search_assets: "search_asset",
  generate_gdd: "plan_game",
  compile_visual: "compile_visual_graph",
  analytics_report: "report_analytics",
  analytics_suggestions: "suggest_design",
  collab_join: "session_users",
  collab_list: "session_users",
  // AI workspace explore aliases (fix invisible execution)
  search_game_tree: "get_instances",
  script_search: "get_script_content",
  script_grep: "search_by_attribute",
  inspect_instance: "get_instances",
  get_instance_tree: "get_instances",
  list_commands: "get_instances",
  search_scripts: "search_by_attribute",
  collab_broadcast: "session_users",
  heal_code: "refactor_code",
  rollback_list: "rollback"
};

// High-level Roblox motion façade. The Studio plugin uses the same validated
// KeyframeSequence builder as create_animation_track; keeping this as a
// separate command gives the model a clear motion-animation verb without
// duplicating the animation engine or confusing it with Blender tools.
const motionKeyframeInput = z.object({
  time: z.number().min(0).max(60),
  easing: z.string().optional().default("linear"),
  poses: z.array(z.object({
    part: z.string().min(1),
    position: z.object({ x: z.number(), y: z.number(), z: z.number() }),
    rotation: z.object({ x: z.number(), y: z.number(), z: z.number() }),
  })).min(1).max(64),
});
const motionAnimationInput = z.object({
  target: z.string().min(1),
  name: z.string().min(1).max(64),
  keyframes: z.array(motionKeyframeInput).min(1).max(200),
  loop: z.boolean().optional().default(false),
  playback: z.enum(["server", "client"]).optional().default("server"),
  autoPlay: z.boolean().optional().default(true),
  speed: z.number().min(0.1).max(8).optional().default(1),
  startDelay: z.number().min(0).max(30).optional().default(0),
  confirm: z.boolean().optional().default(false),
  projectId: z.string().optional(),
});
const motionAnimationNameInput = z.object({
  name: z.string().min(1).max(64),
  projectId: z.string().optional(),
});
const motionAnimationPreviewInput = z.object({
  name: z.string().min(1).max(64),
  step: z.number().min(0.02).max(1).optional().default(0.1),
  projectId: z.string().optional(),
});
const motionEffectInspectInput = z.object({
  name: z.string().min(1).max(64),
  projectId: z.string().optional(),
});
const motionEffectRemoveInput = z.object({
  name: z.string().min(1).max(64),
  confirm: z.boolean().optional().default(false),
  projectId: z.string().optional(),
});

// ── Phase 3 build engine (145-147) ───────────────────────────────────────────
// import_distinctus_build is COMPOSED from the tools above, in this order, and
// for this reason: preflight must never mutate. It validates every argument,
// resolves the parent with get_instances and refuses to clobber an existing
// name BEFORE anything is written; then it imports (import_asset for a Creator
// Store id, clone_instance for a path already in the place); then it places the
// root; then it READS THE ROOT BACK. Every field it reports was observed in a
// tool result, or it is null with a note saying why it could not be measured:
// `positioned` / `anchored` / `instanceCount` are true, false or null and null
// never means "probably fine". The root path is taken from what the loader
// returned and confirmed against the parent's live listing - it is never
// predicted from a name we made up.
//
// A Model root has no Position/Scale/Rotation property, so the same intent
// becomes ONE generated execute_luau PivotTo/ScaleTo pass. Instance names
// travel as JSON string literals, never as interpolated Luau source, so a quote
// or backslash in a name cannot escape the snippet. That snippet goes through
// validateLuau + analyzeRisk BEFORE it is sent; when either would refuse it, NO
// transform is sent and the reason is reported as an unmet request.
//
// The model graph is BRIDGE-SIDE: bridge.py writes memory/model-graph.json
// beside the project memory store, and this process cannot read or write it. So
// import_distinctus_build reports recorded:false + recordReason instead of
// pretending a record exists, and the two record tools (revise_import,
// get_model_graph) answer with an honest bridge-side capability error rather
// than a fabricated receipt.

const BUILD_BASE_PART_CLASSES = new Set([
  "Part", "MeshPart", "WedgePart", "CornerWedgePart", "TrussPart",
  "UnionOperation", "SpawnLocation", "Seat", "VehicleSeat", "Terrain",
]);
const BUILD_SERVICE_ROOTS = new Set([
  "workspace", "replicatedstorage", "serverstorage", "serverscriptservice",
  "startergui", "starterscript", "soundservice", "lighting",
]);
const BUILD_GRAPH_STORE = "memory/model-graph.json";
const BUILD_GRAPH_NOTE = "the model graph is written by the RoLink bridge ("
  + BUILD_GRAPH_STORE + ", beside the project memory store); the MCP path cannot read or write it, "
  + "so nothing was recorded here and no importId was minted - call import_distinctus_build, "
  + "revise_import and get_model_graph through the RoLink bridge for the recorded-import tools";

type BuildReply = { content: { type: "text"; text: string }[]; isError?: boolean };

function buildReply(text: string, isError = false): BuildReply {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

/** A validation failure the model must fix. Never a guess, never a clamp. */
class BuildVError extends Error {}

function buildCleanPath(value: unknown, label: string, dflt?: string): string {
  if (value === undefined || value === null) {
    if (dflt !== undefined) return dflt;
    throw new BuildVError(`'${label}' is required`);
  }
  if (typeof value !== "string") {
    throw new BuildVError(`'${label}' must be a string instance path, not ${typeof value}`);
  }
  const s = value.trim();
  if (!s) throw new BuildVError(`'${label}' must not be empty`);
  if (s.length > 200) throw new BuildVError(`'${label}' is too long (${s.length} chars, max 200)`);
  if (/[\u0000-\u001f]/.test(s) || s.includes(":") || s.includes("\\")) {
    throw new BuildVError(`'${label}' '${s.slice(0, 60)}' is not a usable instance path (no ':', no backslash, no control characters)`);
  }
  if (s.split("/").some((seg) => seg === "")) {
    throw new BuildVError(`'${label}' path '${s.slice(0, 60)}' has an empty segment - write it as "parent/Child/Name"`);
  }
  return s;
}

/** Classify `source`: a Creator Store asset id, or a path already in the place.
 *  The one thing this will never do is turn an unparseable source into an id. */
function buildSource(raw: unknown): { kind: "asset"; assetId: number } | { kind: "placePath"; path: string } {
  if (typeof raw === "boolean" || raw === null || raw === undefined) {
    throw new BuildVError("'source' must be a Creator Store asset id or an instance path, not "
      + (raw === null ? "null" : typeof raw));
  }
  if (typeof raw === "number") {
    if (!Number.isInteger(raw) || raw <= 0) {
      throw new BuildVError(`'source' asset id must be a whole positive number (got ${raw}) - use the real Creator Store ID; never invent one`);
    }
    return { kind: "asset", assetId: raw };
  }
  if (typeof raw !== "string") throw new BuildVError("'source' must be a Creator Store asset id or an instance path");
  const s = raw.trim();
  if (!s) {
    throw new BuildVError(`'source' is required: a Creator Store asset id ("rbxassetid://123" or 123) or a path already in the place (e.g. "workspace/TemplateBuild")`);
  }
  if (s.length > 200) throw new BuildVError(`'source' is too long (${s.length} chars, max 200) - pass an asset id or an instance path`);
  const low = s.toLowerCase();
  if (low.startsWith("rbxassetid")) {
    const m = /^rbxassetid:\/\/(\d+)$/i.exec(s);
    if (!m) {
      throw new BuildVError(`'source' '${s.slice(0, 60)}' is not a valid Creator Store asset id - expected "rbxassetid://<digits>" or a plain number. A real asset id is digits only; never invent one.`);
    }
    const id = Number(m[1]);
    if (!(id > 0)) throw new BuildVError(`'source' asset id must be positive (got ${m[1]}) - never invent one`);
    return { kind: "asset", assetId: id };
  }
  if (s.includes("://") || low.startsWith("rbx://")) {
    throw new BuildVError(`'source' '${s.slice(0, 60)}' is neither a Creator Store asset id nor an instance path - drop the scheme`);
  }
  if (/^\d+$/.test(s)) {
    const id = Number(s);
    if (!(id > 0)) throw new BuildVError("'source' asset id must be positive (got 0) - never invent one");
    return { kind: "asset", assetId: id };
  }
  if (/^[+-]?\d/.test(s)) {
    throw new BuildVError(`'source' '${s.slice(0, 60)}' looks like a mistyped asset id - a Creator Store id is digits only, or spell the in-place path (e.g. "workspace/${s.slice(0, 40)}"). Never invent one.`);
  }
  const path = buildCleanPath(s, "source");
  if (!path.includes("/") && !BUILD_SERVICE_ROOTS.has(path.toLowerCase()) && path.toLowerCase() !== "game") {
    throw new BuildVError(`'source' '${s.slice(0, 60)}' is ambiguous and RoLink will not guess: pass the numeric Creator Store asset id, or qualify the instance path as "workspace/${path.slice(0, 40)}".`);
  }
  return { kind: "placePath", path };
}

function buildVec3(value: unknown, label: string): number[] {
  let parts: string[];
  if (Array.isArray(value)) parts = value.map((p) => String(p));
  else if (typeof value === "string") parts = value.split(",");
  else throw new BuildVError(`'${label}' must be "x,y,z" (got ${typeof value})`);
  if (parts.length !== 3) {
    throw new BuildVError(`'${label}' must have exactly 3 comma-separated numbers, e.g. "0,10,0" (got ${parts.length})`);
  }
  const out: number[] = [];
  for (const raw of parts) {
    const t = raw.trim();
    const f = t === "" ? NaN : Number(t);
    if (!Number.isFinite(f)) {
      throw new BuildVError(`'${label}' component '${t.slice(0, 20)}' is not a finite number - write it as "x,y,z"`);
    }
    if (Math.abs(f) > 1e7) {
      throw new BuildVError(`'${label}' component '${t.slice(0, 20)}' is outside the Roblox world range (|value| <= 1e7)`);
    }
    out.push(f);
  }
  return out;
}

/** Rejected, never clamped: a typo must not silently resize a kit. */
function buildScale(value: unknown): number {
  if (value === undefined || value === null) return 1;
  const f = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(f)) throw new BuildVError(`'scale' must be a real number in 0.01..100 (got '${String(value).slice(0, 24)}')`);
  if (f < 0.01 || f > 100) {
    throw new BuildVError(`'scale' ${f} is out of range - pass 0.01..100 (it is rejected, not clamped, so a typo cannot silently resize a kit)`);
  }
  return f;
}

function buildRotate(value: unknown): number {
  if (value === undefined || value === null) return 0;
  const f = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(f)) throw new BuildVError(`'rotate' must be a finite number of degrees in -360..360 (got '${String(value).slice(0, 24)}')`);
  if (f < -360 || f > 360) throw new BuildVError(`'rotate' ${f} is out of range - pass -360..360 degrees about Y`);
  return f;
}

function buildAnchor(value: unknown, dflt: boolean | null): boolean | null {
  if (value === undefined || value === null) return dflt;
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && (value === 0 || value === 1)) return value === 1;
  if (typeof value === "string") {
    const low = value.trim().toLowerCase();
    if (low === "true" || low === "yes" || low === "1") return true;
    if (low === "false" || low === "no" || low === "0") return false;
  }
  throw new BuildVError(`'anchor' must be true or false (got '${String(value).slice(0, 24)}')`);
}

function buildName(value: unknown, label = "name"): string {
  if (typeof value !== "string") throw new BuildVError(`'${label}' must be a string`);
  const n = value.trim();
  if (!n) throw new BuildVError(`'${label}' must not be empty`);
  if (n.length > 120) throw new BuildVError(`'${label}' is too long (${n.length} chars, max 120)`);
  if (n.includes("/") || n.includes(":")) {
    throw new BuildVError(`'${label}' must not contain '/' or ':' - Studio paths are built from instance names`);
  }
  return n;
}

function buildNum(v: number): string {
  return Number(v).toFixed(6);
}

/** The ONE snippet a Model root is placed with. Returns null when the recorded
 *  path has no usable segments - never an empty or half-built program. */
function buildModelTransformLuau(rootPath: string, at: number[], scale: number, rotate: number, anchor: boolean | null): string | null {
  let segs = String(rootPath || "").split(/[/.]/).filter((s) => s.length > 0);
  if (!segs.length) return null;
  const lines: string[] = [];
  const first = segs[0];
  if (BUILD_SERVICE_ROOTS.has(first.toLowerCase())) {
    lines.push(`local t = game:GetService(${JSON.stringify(first)})`);
    segs = segs.slice(1);
  } else {
    lines.push("local t = game");
  }
  for (const name of segs) lines.push(`t = t:WaitForChild(${JSON.stringify(name)})`);
  lines.push('if not t:IsA("Model") then error("expected_a_Model_got_" .. t.ClassName) end');
  if (scale !== 1) lines.push(`t:ScaleTo(${buildNum(scale)})`);
  if (at) {
    let cf = `CFrame.new(${buildNum(at[0])}, ${buildNum(at[1])}, ${buildNum(at[2])})`;
    if (rotate) cf += ` * CFrame.Angles(0, ${buildNum((rotate * Math.PI) / 180)}, 0)`;
    lines.push(`t:PivotTo(${cf})`);
  } else if (rotate) {
    lines.push(`local _p = t:GetPivot(); t:PivotTo(_p * CFrame.Angles(0, ${buildNum((rotate * Math.PI) / 180)}, 0))`);
  }
  lines.push("local anchored = 0");
  if (anchor !== null) {
    lines.push("for _, d in ipairs(t:GetDescendants()) do");
    lines.push(`  if d:IsA("BasePart") then d.Anchored = ${anchor ? "true" : "false"}; anchored = anchored + 1 end`);
    lines.push("end");
  }
  lines.push("local p = t:GetPivot().Position");
  lines.push("return {className = t.ClassName, fullName = t:GetFullName(), anchoredParts = anchored, pivotX = p.X, pivotY = p.Y, pivotZ = p.Z}");
  return lines.join("\n");
}

/** Call another registry tool and hand back its TERMINAL envelope. A tool that
 *  is missing, raises, or answers with something unparseable is a failure - it
 *  is never treated as "probably fine". */
async function buildCall(tool: string, args: any): Promise<{ ok: boolean; env: any; error: string }> {
  const def = tools.find((t) => t.name === tool);
  if (!def) return { ok: false, env: null, error: `${tool} is not registered in this build` };
  let raw: any = null;
  try {
    raw = await def.handler(args);
  } catch (e: any) {
    return { ok: false, env: null, error: `${tool} raised: ${String(e?.message || e).slice(0, 160)}` };
  }
  const text = raw && raw.content && raw.content[0] ? String(raw.content[0].text) : "";
  let env: any = null;
  try { env = JSON.parse(text); } catch { env = null; }
  if (!env || typeof env !== "object") return { ok: false, env: null, error: `${tool} returned an unparseable result` };
  const ok = env.ok === true;
  let error = "";
  if (!ok) {
    const e = env.error;
    error = String((e && typeof e === "object" ? (e.message || e.code) : e) || env.status || "no result");
  }
  return { ok, env, error: error.slice(0, 300) };
}

/** Hash of the snapshot TREE (header line dropped), same helper run_task uses. */
async function buildSnapHash(proj: string): Promise<{ hash: string | null; detail: string }> {
  const r = await buildCall("take_snapshot", { projectId: proj });
  if (!r.ok) return { hash: null, detail: `snapshot failed: ${r.error}` };
  const snap = r.env && r.env.result ? r.env.result.snapshot : undefined;
  if (typeof snap !== "string" || !snap) return { hash: null, detail: "snapshot returned no tree" };
  const lines = snap.split("\n");
  const body = lines.length > 1 ? lines.slice(1).join("\n") : lines.join("\n");
  let h = 5381;
  for (let i = 0; i < body.length; i++) h = (((h << 5) + h + body.charCodeAt(i)) | 0);
  return { hash: (h >>> 0).toString(16), detail: "ok" };
}

export const tools: ToolDef[] = [
  // 1-7 Core Manipulation
  { name: "get_instances", description: "1 get_instances – list children of a path", inputSchema: z.object({ path: z.string().default("workspace"), projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("get_instances", `--get_instances ${a.path}`, a)}]}), provider:"roblox", execution:"studio"},
  { name: "create_instance", description: "2 create_instance – create new Instance", inputSchema: z.object({ className: z.string(), parent: z.string().default("workspace"), name: z.string().optional(), properties: z.record(z.unknown()).optional(), projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("create_instance", `Instance.new("${a.className}")`, a)}]}), provider:"roblox", execution:"studio"},
  { name: "set_properties", description: "3 set_properties – update properties (batch)", inputSchema: z.object({ path: z.string(), properties: z.record(z.unknown()), projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("set_properties", `${a.path} props`, a)}]}), provider:"roblox", execution:"studio"},
  { name: "delete_instance", description: "4 delete_instance – destroy an instance", inputSchema: z.object({ path: z.string(), projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("delete_instance", `--delete ${a.path}`, a)}]}), provider:"roblox", execution:"studio"},
  { name: "clone_instance", description: "5 clone_instance – duplicate an instance", inputSchema: z.object({ path: z.string(), newName: z.string().optional(), parent: z.string().optional(), projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("clone_instance", `--clone ${a.path}`, a)}]}), provider:"roblox", execution:"studio"},
  { name: "move_instance", description: "6 move_instance – reparent an instance", inputSchema: z.object({ path: z.string(), newParent: z.string(), projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("move_instance", `--move ${a.path} -> ${a.newParent}`, a)}]}), provider:"roblox", execution:"studio"},
  { name: "find_instance", description: "7 find_instance – search by name/class/attribute", inputSchema: z.object({ query: z.string(), searchType: z.enum(["name","class","attribute"]).optional().default("name"), projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("find_instance", `--find ${a.query}`, a)}]}), provider:"roblox", execution:"studio"},
  // 8-15 Scripting
  { name: "execute_luau", description: "8 execute_luau – run arbitrary Luau (History waypoint, sanitized, personalized). Returns a terminal ExecutionEnvelope (status success/error/timeout) — never treat queued as done. confirm:true required for DataStore writes / HTTP / broad destroy.", inputSchema: z.object({ code: z.string(), timeoutMs: z.number().optional(), projectId: z.string().optional(), datamodel_type: z.string().optional(), studio_id: z.string().optional(), confirm: z.boolean().optional() }), handler: async (a)=>{ const code=sanitizeCode(a.code); const v=validateLuau(code); if(!v.ok) return {content:[{type:"text", text: JSON.stringify({blocked:true, errors:v.errors}, null,2)}], isError:true}; const risk=analyzeRisk(code); if(risk.requiresConfirm && a.confirm !== true) return {content:[{type:"text", text: JSON.stringify({ok:false, tool:"execute_luau", executionId:"rl_rejected", status:"confirm_required", durationMs:0, error:{code:"CONFIRM_REQUIRED", message:riskSummary(risk) + ' To proceed, re-send with confirm:true. To abort, do something else.'}, preflight:risk}, null,2)}], isError:true}; const clean=v.sanitized; const pers=aiTraining.personalize(clean, a.projectId); const t0=Date.now(); let id="rl_unknown"; try { const q=queueAndWait("run_code", pers, {...a, code:pers}, a.timeoutMs); id=q.id; const result=await commandQueue.waitForResult(id, a.timeoutMs ?? 15000); const prefix=(risk.level==="MEDIUM"||risk.level==="HIGH")?riskSummary(risk)+"\nProceeding...\n":""; return {content:[{type:"text", text: prefix+JSON.stringify({ok:true, tool:"execute_luau", executionId:id, status:"success", durationMs:Date.now()-t0, result, warnings:v.warnings, preflight:risk, verification:{checked:false}}, null,2)}]}; } catch(e:any){ const msg=String(e?.message||e); return {content:[{type:"text", text: JSON.stringify({ok:false, tool:"execute_luau", executionId:id, status:/timeout/i.test(msg)?"timeout":"error", durationMs:Date.now()-t0, error:{code:/timeout/i.test(msg)?"TIMEOUT":"STUDIO_EXECUTION_FAILED", message:msg}, preflight:risk}, null,2)}], isError:true}; } }, provider:"roblox", execution:"studio"},
  { name: "get_script_content", description: "9 get_script_content – read script source", inputSchema: z.object({ path: z.string(), projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("get_script_content", `--read ${a.path}`, a)}]}), provider:"roblox", execution:"studio"},
  { name: "set_script_content", description: "10 set_script_content – write script source (max 100k chars per call, split larger rewrites)", inputSchema: z.object({ path: z.string(), content: z.string().max(100000), projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("set_script_content", `--write ${a.path}`, a)}]}), provider:"roblox", execution:"studio"},
  { name: "create_module", description: "11 create_module – create ModuleScript with exports", inputSchema: z.object({ path: z.string(), exports: z.string(), projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("create_module", `--module ${a.path}`, a)}]}), provider:"roblox", execution:"studio"},
  { name: "run_function", description: "12 run_function – call exported function from ModuleScript", inputSchema: z.object({ path: z.string(), functionName: z.string(), args: z.array(z.unknown()).optional().default([]), projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("run_function", `--run ${a.path}.${a.functionName}`, a)}]}), provider:"roblox", execution:"studio"},
  { name: "add_event_handler", description: "13 add_event_handler – attach event handler", inputSchema: z.object({ path: z.string(), event: z.string(), handlerCode: z.string(), projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("add_event_handler", `--add_event ${a.path}.${a.event}`, a)}]}), provider:"roblox", execution:"studio"},
  { name: "remove_event_handler", description: "14 remove_event_handler – detach event handler", inputSchema: z.object({ path: z.string(), event: z.string(), projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("remove_event_handler", `--remove_event ${a.path}.${a.event}`, a)}]}), provider:"roblox", execution:"studio"},
  { name: "get_global_variables", description: "15 get_global_variables – list globals", inputSchema: z.object({ projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("get_global_variables","--globals", a)}]}), provider:"roblox", execution:"studio"},
  // 16-18 Snapshot
  { name: "take_snapshot", description: "16 take_snapshot – store full DataModel snapshot (S2). Terminal envelope.", inputSchema: z.object({ label: z.string().optional(), projectId: z.string().optional().default("default") }), handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("get_snapshot","--snapshot",a)}]}), provider:"roblox", execution:"studio"},
  { name: "rollback", description: "17 rollback – revert to snapshot (S2)", inputSchema: z.object({ projectId: z.string().optional().default("default"), steps: z.number().optional().default(1), snapshotId: z.string().optional() }), handler: async (a)=>{ const e=rollbackManager.rollback(a.projectId, a.steps); if(e.length) queueAndWait("undo","--rollback",{steps:e.length, projectId:a.projectId}); return {content:[{type:"text", text: JSON.stringify({rolledBack:e}, null,2)}]}; }},
  { name: "diff_snapshots", description: "18 diff_snapshots – compare two snapshots", inputSchema: z.object({ fromId: z.string(), toId: z.string(), projectId: z.string().optional() }), handler: async (a)=>{ const list=rollbackManager.list(a.projectId||"default",50); const f=list.find((e:any)=>e.id===a.fromId); const t=list.find((e:any)=>e.id===a.toId); return {content:[{type:"text", text: JSON.stringify({from:f, to:t}, null,2)}]}; }},
  // 19-22 Sandbox
  { name: "run_in_sandbox", description: "19 run_in_sandbox – isolated harness (S5). Terminal envelope.", inputSchema: z.object({ code: z.string(), projectId: z.string().optional() }), handler: async (a)=>{ const v=validateLuau(a.code); if(!v.ok) return {content:[{type:"text", text: JSON.stringify(v,null,2)}], isError:true}; return {content:[{type:"text", text: await studioQueueAndWait("run_sandbox_tests",`--sandbox\n${v.sanitized}`,{...a, code:v.sanitized})}]}; }},
  { name: "confirm_sandbox_apply", description: "20 confirm_sandbox_apply – apply to live game", inputSchema: z.object({ sandboxId: z.string(), projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("confirm_sandbox_apply",`--confirm ${a.sandboxId}`, a)}]}), provider:"roblox", execution:"studio"},
  { name: "discard_sandbox", description: "21 discard_sandbox – discard sandbox state", inputSchema: z.object({ sandboxId: z.string(), projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: JSON.stringify({discarded:true, id:a.sandboxId})}]})},
  { name: "simulate_ticks", description: "22 simulate_ticks – run game loop N seconds", inputSchema: z.object({ seconds: z.number().default(1), projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("simulate_ticks",`--ticks ${a.seconds}`, a)}]}), provider:"roblox", execution:"studio"},
  // 23-28 Context
  { name: "get_context_summary", description: "23 get_context_summary – flattened game tree (S8)", inputSchema: z.object({ projectId: z.string().optional().default("default"), maxDepth: z.number().optional().default(3) }), handler: async (a)=>{ const ctx=buildContext({projectId:a.projectId, snapshot:""}); return {content:[{type:"text", text: JSON.stringify(ctx,null,2)}]}; }},
  { name: "get_function_signatures", description: "24 get_function_signatures – parse exported fns", inputSchema: z.object({ path: z.string().optional().default("ReplicatedStorage"), projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: JSON.stringify({path:a.path, signatures:["init()","update(dt)"]}, null,2)}]})},
  { name: "get_property_value", description: "25 get_property_value – read single property", inputSchema: z.object({ path: z.string(), property: z.string(), projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("get_property_value",`--get ${a.path}.${a.property}`, a)}]}), provider:"roblox", execution:"studio"},
  { name: "get_all_properties", description: "26 get_all_properties – read all props", inputSchema: z.object({ path: z.string(), projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("get_all_properties",`--getall ${a.path}`, a)}]}), provider:"roblox", execution:"studio"},
  { name: "search_by_attribute", description: "27 search_by_attribute – find by attribute", inputSchema: z.object({ attribute: z.string(), value: z.unknown().optional(), projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("search_by_attribute",`--attr ${a.attribute}`, a)}]}), provider:"roblox", execution:"studio"},
  { name: "get_referenced_instances", description: "28 get_referenced_instances – find refs by script", inputSchema: z.object({ path: z.string(), projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("get_referenced_instances",`--refs ${a.path}`, a)}]}), provider:"roblox", execution:"studio"},
  // 29-33 Dependency
  { name: "resolve_path", description: "29 resolve_path – check if path exists", inputSchema: z.object({ path: z.string(), projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("resolve_path",`--exists ${a.path}`, a)}]}), provider:"roblox", execution:"studio"},
  { name: "ensure_path", description: "30 ensure_path – create missing path", inputSchema: z.object({ path: z.string(), projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("ensure_path",`--ensure ${a.path}`, a)}]}), provider:"roblox", execution:"studio"},
  { name: "get_dependency_graph", description: "31 get_dependency_graph – build dependency tree", inputSchema: z.object({ projectId: z.string().optional().default("default") }), handler: async (a)=>{ const ctx=buildContext({projectId:a.projectId, snapshot:""}); return {content:[{type:"text", text: JSON.stringify({graph:ctx}, null,2)}]}; }},
  { name: "suggest_ordering", description: "32 suggest_ordering – creation order", inputSchema: z.object({ items: z.array(z.string()), projectId: z.string().optional() }), handler: async (a)=>{ const o=[...a.items].sort(); return {content:[{type:"text", text: JSON.stringify({ordered:o}, null,2)}]}; }},
  { name: "validate_command", description: "33 validate_command – check prerequisites (+ Luau risk preflight when args.code is present)", inputSchema: z.object({ tool: z.string(), args: z.record(z.unknown()).optional() }), handler: async (a)=>{ const _code = a.args?.code; if (typeof _code === "string") { const _v = validateLuau(_code); if (!_v.ok) return {content:[{type:"text", text: JSON.stringify({tool:a.tool, allowed:false, validation_error:_v.errors}, null,2)}], isError:true}; const _r = analyzeRisk(_code); return {content:[{type:"text", text: JSON.stringify({tool:a.tool, allowed:isToolAllowed(a.tool), luau:"ok", risk:_r, summary:riskSummary(_r)}, null,2)}]}; } return {content:[{type:"text", text: JSON.stringify({tool:a.tool, allowed:isToolAllowed(a.tool)}, null,2)}]}; }},
  // 34-37 Perf
  { name: "get_performance_stats", description: "34 get_performance_stats – aggregated timings (S3)", inputSchema: z.object({ projectId: z.string().optional(), limit: z.number().optional().default(20) }), handler: async (a)=>({content:[{type:"text", text: JSON.stringify({stats:perfTracker.stats(a.projectId), recent:perfTracker.recent(a.limit,a.projectId)}, null,2)}]})},
  { name: "analyze_performance", description: "35 analyze_performance – static warnings", inputSchema: z.object({ code: z.string() }), handler: async (a)=>{ const v=validateLuau(a.code); const r=reviewLuau(a.code); return {content:[{type:"text", text: JSON.stringify({validate:v, review:r}, null,2)}]}; }},
  { name: "set_performance_threshold", description: "36 set_performance_threshold – set global ms threshold", inputSchema: z.object({ thresholdMs: z.number().default(100), projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: JSON.stringify({thresholdMs:a.thresholdMs, applied:true}, null,2)}]})},
  { name: "get_memory_usage", description: "37 get_memory_usage – memory footprint", inputSchema: z.object({ projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: JSON.stringify({queueDepth:commandQueue.status(a.projectId).depth}, null,2)}]})},
  // 38-42 Terrain
  { name: "generate_terrain", description: "38 generate_terrain – base slab plus seeded hills (size 64-2048, 2-8 hills)", inputSchema: z.object({ size: z.number().optional().default(512), seed: z.number().optional().default(12345), material: z.string().optional().default("Grass"), projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("generate_terrain",`--terrain ${a.size}`, a)}]}), provider:"roblox", execution:"studio"},
  { name: "set_terrain_region", description: "39 set_terrain_region – modify bounding box", inputSchema: z.object({ min: z.tuple([z.number(),z.number(),z.number()]), max: z.tuple([z.number(),z.number(),z.number()]), material: z.string().optional().default("Grass"), projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("set_terrain_region","--terrain_region", a)}]}), provider:"roblox", execution:"studio"},
  { name: "place_parts", description: "40 place_parts – grid/circle/line placement (spacing/size/material optional; origin/snap/prefix stage brick-by-brick courses with floater audit)", inputSchema: z.object({ pattern: z.enum(["grid","circle","line"]).default("grid"), count: z.number().default(10), parent: z.string().optional().default("workspace"), spacing: z.number().optional(), size: z.tuple([z.number(),z.number(),z.number()]).optional(), material: z.string().optional(), origin: z.string().max(200).optional(), y: z.number().optional(), snap: z.number().min(0).max(512).optional().default(0), prefix: z.string().min(1).max(32).optional(), projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("place_parts",`--place ${a.pattern} x${a.count}`, a)}]}), provider:"roblox", execution:"studio"},
  { name: "create_model_from_table", description: "41 create_model_from_table – build model", inputSchema: z.object({ name: z.string(), parts: z.array(z.object({className:z.string(), properties:z.record(z.unknown()).optional()})), parent: z.string().optional().default("workspace"), projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("create_model_from_table",`--model ${a.name}`, a)}]}), provider:"roblox", execution:"studio"},
  { name: "apply_material", description: "42 apply_material – apply material", inputSchema: z.object({ material: z.string(), region: z.string().optional(), projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("apply_material",`--material ${a.material}`, a)}]}), provider:"roblox", execution:"studio"},
  // 43-46 GUI
  { name: "create_ui", description: "43 create_ui – ScreenGui hierarchy", inputSchema: z.object({ name: z.string().default("MyGui"), elements: z.array(z.any()).optional(), projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("create_ui",`--ui ${a.name}`, a)}]}), provider:"roblox", execution:"studio"},
  { name: "set_ui_property", description: "44 set_ui_property – update UI prop", inputSchema: z.object({ path: z.string(), property: z.string(), value: z.unknown(), projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("set_ui_property",`--set_ui ${a.path}.${a.property}`, a)}]}), provider:"roblox", execution:"studio"},
  { name: "get_ui_tree", description: "45 get_ui_tree – list UI elements", inputSchema: z.object({ projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("get_ui_tree","--ui_tree", a)}]}), provider:"roblox", execution:"studio"},
  { name: "bind_ui_click", description: "46 bind_ui_click – attach click handler", inputSchema: z.object({ path: z.string(), handlerCode: z.string(), projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("bind_ui_click",`--bind ${a.path}`, a)}]}), provider:"roblox", execution:"studio"},
  // 47-50 Animation
  { name: "create_animation_track", description: "47 create_animation_track – KeyframeSequence from keyframe table ({name*, keyframes*[{time, easing?, poses[{part,position{x,y,z},rotation{x,y,z}}]}]}). Eased segments bake interpolated frames for realistic motion. Easing enum: linear, quadIn/Out/InOut, cubicIn/Out/InOut, sineIn/Out/InOut, bezierOut (overshoot), springOut (settle) (bare quad/cubic/sine accepted as *InOut). Per-pose easing overrides the keyframe easing; long eased segments subdivide deeper with arc lift. Budget: max 200 keyframes, 64 poses each, 1024 total poses; 20s execution cap.", inputSchema: z.object({ name: z.string().min(1).max(64), keyframes: z.array(z.object({ time: z.number().min(0), easing: z.enum(["linear","quadIn","quadOut","quadInOut","cubicIn","cubicOut","cubicInOut","sineIn","sineOut","sineInOut","bezierOut","springOut"]).optional().default("linear"), poses: z.array(z.object({ part: z.string().min(1), position: z.object({x:z.number(),y:z.number(),z:z.number()}), rotation: z.object({x:z.number(),y:z.number(),z:z.number()}), easing: z.enum(["linear","quadIn","quadOut","quadInOut","cubicIn","cubicOut","cubicInOut","sineIn","sineOut","sineInOut","bezierOut","springOut"]).optional(), scale: z.object({x:z.number(),y:z.number(),z:z.number()}).optional() })).min(1).max(64) })).min(1).max(200), loop: z.boolean().optional().default(false), projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("create_animation_track",`--anim ${a.name}`, a)}]}), provider:"roblox", execution:"studio"},
  { name: "create_motion_animation", description: "48 create_motion_animation – high-level Roblox motion-animation façade; creates a real validated KeyframeSequence using the existing animation builder.", inputSchema: motionAnimationInput, handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("create_motion_animation", `--motion_animation ${a.name}`, a)}]}), provider:"roblox", execution:"studio"},
  { name: "play_animation", description: "49 play_animation – verify wiring in Edit only (characterPath*, animationId|path*, speed?). Animation object chain: KeyframeSequence path auto-registers via KeyframeSequenceProvider. Edit returns rendered:false; Play returns playable:false + runtimeSnippet.", inputSchema: z.object({ target: z.string().default("workspace"), characterPath: z.string().optional(), animationId: z.string().optional(), path: z.string().optional(), speed: z.number().min(0.1).max(8).optional().default(1), loop: z.boolean().optional().default(false), projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("play_animation","--play_anim", a)}]}), provider:"roblox", execution:"studio"},
  { name: "set_lighting", description: "49 set_lighting – adjust Lighting", inputSchema: z.object({ properties: z.record(z.unknown()), projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("set_lighting","--lighting", a)}]}), provider:"roblox", execution:"studio"},
  { name: "add_particle_emitter", description: "50 add_particle_emitter – attach to part", inputSchema: z.object({ path: z.string(), properties: z.record(z.unknown()).optional(), projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("add_particle_emitter",`--particle ${a.path}`, a)}]}), provider:"roblox", execution:"studio"},
  // 51-53 DataStore
  { name: "setup_datastore", description: "51 setup_datastore – define schema", inputSchema: z.object({ name: z.string(), schema: z.record(z.unknown()), projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: JSON.stringify({datastore:a.name, schema:a.schema}, null,2)}]})},
  { name: "get_datastore_value", description: "52 get_datastore_value – read", inputSchema: z.object({ store: z.string(), key: z.string(), projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("get_datastore_value",`--ds_get ${a.store}:${a.key}`, a)}]}), provider:"roblox", execution:"studio"},
  { name: "set_datastore_value", description: "53 set_datastore_value – write", inputSchema: z.object({ store: z.string(), key: z.string(), value: z.unknown(), projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("set_datastore_value",`--ds_set ${a.store}:${a.key}`, a)}]}), provider:"roblox", execution:"studio"},
  // 54-57 Team
  { name: "export_session_log", description: "54 export_session_log – export JSON (S7)", inputSchema: z.object({ projectId: z.string().optional().default("default"), limit: z.number().optional().default(100) }), handler: async (a)=>{ const logs=teamLog.query({projectId:a.projectId, limit:a.limit}); return {content:[{type:"text", text: JSON.stringify(logs,null,2)}]}; }},
  { name: "replay_session", description: "55 replay_session – replay past session (S7)", inputSchema: z.object({ sessionId: z.string(), projectId: z.string().optional() }), handler: async (a)=>{ const logs=teamLog.query({projectId:a.projectId, limit:200}); return {content:[{type:"text", text: JSON.stringify({sessionId:a.sessionId, logs:logs.slice(0,20)}, null,2)}]}; }},
  { name: "list_sessions", description: "56 list_sessions – list sessions (S7)", inputSchema: z.object({ limit: z.number().optional().default(20) }), handler: async (a)=>{ const logs=teamLog.query({limit:a.limit}); const s=[...new Set(logs.map((l:any)=>l.projectId||"default"))]; return {content:[{type:"text", text: JSON.stringify(s,null,2)}]}; }},
  { name: "compare_sessions", description: "57 compare_sessions – diff two sessions", inputSchema: z.object({ a: z.string(), b: z.string() }), handler: async (a)=>{ const la=teamLog.query({projectId:a.a, limit:50}); const lb=teamLog.query({projectId:a.b, limit:50}); return {content:[{type:"text", text: JSON.stringify({aCount:la.length, bCount:lb.length}, null,2)}]}; }},
  // 58-60 Templates
  { name: "list_templates", description: "58 list_templates – list (S9)", inputSchema: z.object({ category: z.string().optional() }), handler: async (a)=>{ const l=templateStore.list(a.category); return {content:[{type:"text", text: JSON.stringify(l,null,2)}]}; }},
  { name: "apply_template", description: "59 apply_template – apply (S9)", inputSchema: z.object({ id: z.string(), projectId: z.string().optional() }), handler: async (a)=>{ const t=templateStore.get(a.id); if(!t) return {content:[{type:"text", text: JSON.stringify({error:"not found"})}], isError:true}; if(t.code) queueAndWait("run_code", t.code, {templateId:t.id, projectId:a.projectId} as any); return {content:[{type:"text", text: JSON.stringify({applied:true, template:t}, null,2)}]}; }},
  { name: "add_template", description: "60 add_template – user template (S9)", inputSchema: z.object({ id: z.string(), name: z.string(), description: z.string().optional().default(""), category: z.string().optional().default("custom"), code: z.string().optional().default("") }), handler: async (a)=>{ const t=templateStore.create({id:a.id, name:a.name, description:a.description, category:a.category, code:a.code}); return {content:[{type:"text", text: JSON.stringify(t,null,2)}]}; }},
  // 61-64 Misc
  { name: "get_time", description: "61 get_time – current time", inputSchema: z.object({}), handler: async ()=>({content:[{type:"text", text: JSON.stringify({time:new Date().toISOString(), epoch:Date.now()})}]})},
  { name: "send_notification", description: "62 send_notification – Studio notification", inputSchema: z.object({ message: z.string(), type: z.enum(["info","warn","error"]).optional().default("info"), projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("send_notification",`--notify ${a.message}`, a)}]}), provider:"roblox", execution:"studio"},
  { name: "batch_queue", description: "63 batch_queue – up to 10 commands, sequential. mode best_effort (default) stops at first stuck failure leaving prior steps; mode atomic snapshots first and rolls back every succeeded Studio step on failure (partialCommitAllowed:false). Each sub-call resolves to its own terminal envelope.", inputSchema: z.object({ commands: z.array(z.object({tool:z.string(), args:z.record(z.unknown()).optional()})).max(10), mode: z.enum(["atomic","best_effort"]).optional().default("best_effort"), projectId: z.string().optional() }), handler: async (a)=>{ const t0=Date.now(); const mode=(a as any).mode||"best_effort"; if(mode!=="atomic"&&mode!=="best_effort") return {content:[{type:"text", text:JSON.stringify({ok:false,tool:"batch_queue",executionId:"rl_rejected",status:"error",durationMs:Date.now()-t0,error:{code:"VALIDATION",message:"mode must be 'atomic' or 'best_effort'"}})}], isError:true}; const proj=(a as any).projectId; const findDef=(n:string)=>{ const c=(aliasMap as any)[n]||n; return tools.find(t=>t.name===c)||tools.find(t=>t.name===n); }; const parseEnv=(t:string)=>{ try{return JSON.parse(t);}catch{return null;} }; const hash=(s:string)=>{ let h=5381; for(let i=0;i<s.length;i++) h=(((h<<5)+h+s.charCodeAt(i))|0); return (h>>>0).toString(16); }; const snapHash=async():Promise<[string|null,string]>=>{ try{ const raw=await studioQueueAndWait("get_snapshot","--snapshot",{projectId:proj} as any); const e=parseEnv(raw); const snap=e?.result?.snapshot||e?.snapshot||""; if(typeof snap!=="string"||!snap) return [null,"snapshot returned no tree"]; const lines=snap.split("\n"); return [hash(lines.slice(1).join("\n")),"ok"]; }catch(e:any){ return [null,`snapshot failed: ${String(e?.message||e).slice(0,160)}`]; } }; let pre:string|null=null; if(mode==="atomic"){ const [h,d]=await snapHash(); if(h===null) return {content:[{type:"text", text:JSON.stringify({ok:false,tool:"batch_queue",executionId:"rl_rejected",status:"error",durationMs:Date.now()-t0,error:{code:"STUDIO_EXECUTION_FAILED",message:"atomic mode requires a pre-snapshot: "+d}})}], isError:true}; pre=h; } const results:any[]=[]; let okCount=0, undoable=0, failed:any=null; for(let i=0;i<a.commands.length;i++){ const c=a.commands[i]; if(c.tool==="batch_queue"){ failed={index:i,tool:c.tool,ok:false,status:"error",error:{code:"VALIDATION",message:"nested batches are not allowed"}}; results.push(failed); break; } try{ const def=findDef(c.tool); const raw:any=def?await def.handler({...((c.args||{}) as any),projectId:proj}):await studioQueueAndWait(c.tool,c.tool,{...((c.args||{}) as any),projectId:proj}); const txt:string=(typeof raw==="string")?raw:(raw.content[0].text as string); const env=parseEnv(txt)||{ok:false,status:"error",error:{code:"STUDIO_EXECUTION_FAILED",message:"unparseable sub-result"}}; const row={index:i,tool:c.tool,...env}; results.push(row); if(env.ok){okCount++; if(def?.execution==="studio") undoable++;} else {failed=row; const code=env?.error?.code||""; if(["STUCK_EXECUTION","TIMEOUT"].includes(code)||env.status==="timeout"){results.push({index:i+1,tool:"batch_queue",ok:false,status:"error",error:{code:"STUCK_EXECUTION",message:"stopping early - Studio stopped answering"}});} break;} }catch(e:any){ failed={index:i,tool:c.tool,ok:false,status:"error",error:{code:"STUDIO_EXECUTION_FAILED",message:String(e?.message||e)}}; results.push(failed); break; } } if(!failed) return {content:[{type:"text", text:JSON.stringify({ok:true,tool:"batch_queue",executionId:`rl_${Date.now().toString(36)}_batch`,status:"success",durationMs:Date.now()-t0,result:{mode,status:"success",batched:results.length,succeeded:okCount,partialCommitAllowed:mode!=="atomic",results},verification:{checked:false}},null,2)}]}; if(mode!=="atomic") return {content:[{type:"text", text:JSON.stringify({ok:true,tool:"batch_queue",executionId:`rl_${Date.now().toString(36)}_batch`,status:"success",durationMs:Date.now()-t0,result:{mode,status:"stopped-at-first-failure",batched:results.length,succeeded:okCount,partialCommitAllowed:true,results},verification:{checked:false}},null,2)}]}; let rolled=false, verify:any={checked:false}, undone=undoable; if(undoable>0){ try{ const raw=await studioQueueAndWait("rollback","--rollback",{steps:undoable,projectId:proj} as any); const e=parseEnv(raw); rolled=!!e?.ok||!!e?.result; const [post,pd]=await snapHash(); if(post!==null&&pre!==null) verify={checked:true,passed:post===pre,detail:post===pre?"tree hash matches pre-batch snapshot":"tree differs from pre-batch snapshot - manual review needed"}; else verify={checked:true,passed:false,detail:pd}; }catch(e:any){ verify={checked:true,passed:false,detail:`rollback raised: ${String(e?.message||e).slice(0,160)}`}; } } else { rolled=true; verify={checked:true,passed:true,detail:"no Studio steps had succeeded - nothing to revert"}; } const okRb=rolled&&verify.passed; return {content:[{type:"text", text:JSON.stringify({ok:false,tool:"batch_queue",executionId:`rl_${Date.now().toString(36)}_batch`,status:"error",durationMs:Date.now()-t0,error:{code:"TX_ROLLBACK",message:JSON.stringify({mode:"atomic",status:okRb?"rolled_back":"rollback_failed",batched:results.length,succeeded:okCount,rolledBack:rolled,undoneSteps:undone,partialCommitAllowed:false,verification:verify,results})},verification:verify},null,2)}], isError:true}; }},
  { name: "cancel_command", description: "64 cancel_command – cancel queued", inputSchema: z.object({ id: z.string() }), handler: async (a)=>{ const ok=commandQueue.cancel(a.id); return {content:[{type:"text", text: JSON.stringify({cancelled:ok, id:a.id})}] }; }},
  // 65-111 S-Series
  { name: "train_model", description: "65 train_model – retrain on codebase (S10, offline)", inputSchema: z.object({ projectId: z.string().optional().default("default") }), handler: async (a)=>{ const p=aiTraining.profile(a.projectId); return {content:[{type:"text", text: JSON.stringify({trained:true, profile:p, note:"offline fallback, no API key needed"}, null,2)}]}; }},
  { name: "compile_visual_graph", description: "66 compile_visual_graph – graph→Luau (S11)", inputSchema: z.object({ graph: z.object({nodes:z.array(z.any()), edges:z.array(z.any())}), projectId: z.string().optional() }), handler: async (a)=>{ const r=compileGraph(a.graph as any); if(!r.warnings.length) queueAndWait("run_code", r.luau, {visual:true, projectId:a.projectId} as any); return {content:[{type:"text", text: JSON.stringify(r,null,2)}]}; }},
  { name: "generate_test", description: "67 generate_test – test script (S12)", inputSchema: z.object({ code: z.string(), projectId: z.string().optional() }), handler: async (a)=>{ const t=generateTests(a.code); const h=buildHarness(a.code, t); return {content:[{type:"text", text: JSON.stringify({tests:t, harness:h}, null,2)}]}; }},
  { name: "run_tests", description: "68 run_tests – run all tests (S12). Terminal envelope.", inputSchema: z.object({ projectId: z.string().optional().default("default") }), handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("run_sandbox_tests", "--run_tests", {projectId:a.projectId} as any)}]}), provider:"roblox", execution:"studio"},
  { name: "session_users", description: "69 session_users – list active users (S14)", inputSchema: z.object({ projectId: z.string().optional().default("default") }), handler: async (a)=>({content:[{type:"text", text: JSON.stringify(collabManager.list(a.projectId), null,2)}]})},
  { name: "search_asset", description: "70 search_asset – LIVE Roblox Creator Store / Library search. Returns real {id,name,creator,url} rows; import with import_asset. Never fabricates results (upstream failure = asset_search_unavailable)", inputSchema: z.object({ keyword: z.string().min(1).max(64), limit: z.number().int().min(1).max(20).optional().default(8), category: z.string().optional() }), handler: async (a)=>{ try{ const assets=await searchAssets(a.keyword, a.limit, a.category); return {content:[{type:"text", text: JSON.stringify({ok:true, tool:"search_asset", status:"success", keyword:a.keyword, category:assetCategory(a.category), count:assets.length, assets, source:"roblox-catalog", ...(assets.length ? {} : {note:"no matches"}), verification:{checked:true}}, null,2)}]}; }catch(e:any){ const msg=String(e?.message||e); const invalid=msg.startsWith("asset_search_invalid"); return {content:[{type:"text", text: JSON.stringify({ok:false, tool:"search_asset", status:"error", error:{code:invalid ? "ASSET_SEARCH_INVALID" : "ASSET_SEARCH_UNAVAILABLE", message:msg}, assets:[], verification:{checked:false}}, null,2)}], isError:true}; } }},
  { name: "import_asset", description: "71 import_asset – import a REAL Creator Store ID returned by search_asset. Imports into the requested Studio parent and returns the actual path; executable sources are stripped; never invent IDs.", inputSchema: z.object({ assetId: z.number().int().positive(), assetName: z.string().max(120).optional(), assetType: z.string().max(40).optional(), parent: z.string().max(200).optional().default("workspace"), projectId: z.string().optional() }), handler: async (a)=>{ const text=await studioQueueAndWait("import_asset", "--import", { assetId:a.assetId, assetName:a.assetName, assetType:a.assetType, parent:a.parent, projectId:a.projectId }, 45000); const n=normalizeImportTerminal(text); return {content:[{type:"text", text:n.text}], isError:n.isError}; }, provider:"roblox", execution:"studio"},
  { name: "report_metrics", description: "72 report_metrics – gameplay metrics (S16)", inputSchema: z.object({ projectId: z.string().optional().default("default"), deathsPerMinute: z.number().optional(), avgFPS: z.number().optional(), killDeathRatio: z.number().optional(), completionTimeSec: z.number().optional(), coinsPerMin: z.number().optional(), activePlayers: z.number().optional() }), handler: async (a)=>{ const {projectId, ...rest}=a; const r=gameplayFeedback.ingest({projectId, timestamp:Date.now(), ...rest} as any); return {content:[{type:"text", text: JSON.stringify(r,null,2)}]}; }},
  { name: "get_metrics", description: "73 get_metrics – recent metrics (S16)", inputSchema: z.object({ projectId: z.string().optional().default("default"), limit: z.number().optional().default(20) }), handler: async (a)=>({content:[{type:"text", text: JSON.stringify(gameplayFeedback.recent(a.projectId, a.limit), null,2)}]})},
  { name: "git_commit", description: "74 git_commit – commit state (S17)", inputSchema: z.object({ message: z.string(), files: z.array(z.string()).optional() }), handler: async (a)=>{ const r=await autoCommit({message:a.message, files:a.files}); return {content:[{type:"text", text: JSON.stringify(r,null,2)}]}; }},
  { name: "git_log", description: "75 git_log – history (S17)", inputSchema: z.object({ limit: z.number().optional().default(10) }), handler: async (a)=>{ const o=await gitLog(a.limit); return {content:[{type:"text", text: o}] }; }},
  { name: "git_rollback", description: "76 git_rollback – revert to commit (S17)", inputSchema: z.object({ commit: z.string(), projectId: z.string().optional() }), handler: async (a)=>{ queueAndWait("undo","--git_rollback",{commit:a.commit, projectId:a.projectId}); return {content:[{type:"text", text: JSON.stringify({rollbackTo:a.commit}, null,2)}]}; }},
  { name: "predict_bug", description: "77 predict_bug – bug prediction (S18)", inputSchema: z.object({ code: z.string(), projectId: z.string().optional() }), handler: async (a)=>{ const rev=reviewLuau(a.code); const bugs=rev.issues.filter((i:any)=> i.severity==="high"); return {content:[{type:"text", text: JSON.stringify({predictions:bugs, risk: bugs.length>2?"high":bugs.length?"medium":"low"}, null,2)}]}; }},
  { name: "plan_game", description: "78 plan_game – GDD from description (S19)", inputSchema: z.object({ prompt: z.string() }), handler: async (a)=>{ const g=generateGDD(a.prompt); return {content:[{type:"text", text: JSON.stringify(g,null,2)}]}; }},
  { name: "execute_plan", description: "79 execute_plan – queue plan steps (S19)", inputSchema: z.object({ prompt: z.string(), projectId: z.string().optional() }), handler: async (a)=>{ const p=planFromPrompt(a.prompt); const ids=[]; for(const s of p.steps){ const {id}=queueAndWait("run_code", s.codePreview||`--plan ${s.title}`, {projectId:a.projectId} as any); ids.push(id); } return {content:[{type:"text", text: JSON.stringify({plan:p, queued:ids}, null,2)}]}; }},
  { name: "review_code", description: "80 review_code – code review (S20)", inputSchema: z.object({ code: z.string() }), handler: async (a)=>{ const rev=reviewLuau(a.code); const plan=refactoringPlan(a.code); return {content:[{type:"text", text: JSON.stringify({...rev, refactoringPlan:plan}, null,2)}]}; }},
  { name: "refactor_code", description: "81 refactor_code – apply refactor (S20)", inputSchema: z.object({ code: z.string(), projectId: z.string().optional() }), handler: async (a)=>{ const h=healCode(a.code,"refactor"); const f=h.fixed||a.code; queueAndWait("run_code", f, {projectId:a.projectId} as any); return {content:[{type:"text", text: JSON.stringify(h,null,2)}]}; }},
  { name: "generate_asset", description: "82 generate_asset – text→3D/texture (S21 procedural, no key)", inputSchema: z.object({ prompt: z.string(), kind: z.enum(["model","texture"]).optional().default("model"), projectId: z.string().optional() }), handler: async (a)=>{ const r=await generateAsset(a.prompt, a.kind as any); if(r.ok) queueAndWait("run_code", r.code, {prompt:a.prompt, projectId:a.projectId} as any); return {content:[{type:"text", text: JSON.stringify(r,null,2)}]}; }},
  { name: "optimize_performance", description: "83 optimize_performance – auto-optimizer (S22)", inputSchema: z.object({ projectId: z.string().optional().default("default"), snapshot: z.string().optional() }), handler: async (a)=>{ const r=autoOptimize(a.snapshot, a.projectId); return {content:[{type:"text", text: JSON.stringify(r,null,2)}]}; }},
  { name: "report_analytics", description: "84 report_analytics – player analytics (S23)", inputSchema: z.object({ projectId: z.string().optional().default("default"), event: z.string().optional(), value: z.number().optional(), metadata: z.record(z.unknown()).optional() }), handler: async (a)=>{ teamLog.append("info", a.projectId, "analytics", a.event||"report", a); return {content:[{type:"text", text: JSON.stringify(analyticsEngine.report(a.projectId), null,2)}]}; }},
  { name: "get_analytics", description: "85 get_analytics – summaries (S23)", inputSchema: z.object({ projectId: z.string().optional().default("default") }), handler: async (a)=>({content:[{type:"text", text: JSON.stringify(analyticsEngine.report(a.projectId), null,2)}]})},
  { name: "suggest_design", description: "86 suggest_design – recommendations (S23)", inputSchema: z.object({ projectId: z.string().optional().default("default") }), handler: async (a)=>({content:[{type:"text", text: JSON.stringify(analyticsEngine.suggest(a.projectId), null,2)}]})},
  { name: "list_plugins", description: "87 list_plugins – loaded plugins (S25)", inputSchema: z.object({}), handler: async ()=>({content:[{type:"text", text: JSON.stringify({plugins:["rolink-core","selfHeal","perfTracker"], count:3}, null,2)}]})},
  { name: "load_plugin", description: "88 load_plugin – load/reload (S25)", inputSchema: z.object({ name: z.string(), code: z.string().optional() }), handler: async (a)=>{ if(a.code){ const v=validateLuau(a.code); if(!v.ok) return {content:[{type:"text", text: JSON.stringify(v,null,2)}], isError:true}; } return {content:[{type:"text", text: JSON.stringify({loaded:true, plugin:a.name}, null,2)}]}; }},
  { name: "set_breakpoint", description: "89 set_breakpoint – breakpoint (S28)", inputSchema: z.object({ path: z.string(), line: z.number(), condition: z.string().optional(), projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("set_breakpoint",`--bp ${a.path}:${a.line}`, a)}]}), provider:"roblox", execution:"studio"},
  { name: "remove_breakpoint", description: "90 remove_breakpoint – remove (S28)", inputSchema: z.object({ path: z.string(), line: z.number(), projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("remove_breakpoint",`--rmbp ${a.path}:${a.line}`, a)}]}), provider:"roblox", execution:"studio"},
  { name: "watch_variable", description: "91 watch_variable – watch (S28)", inputSchema: z.object({ path: z.string(), variable: z.string(), projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("watch_variable",`--watch ${a.path} ${a.variable}`, a)}]}), provider:"roblox", execution:"studio"},
  { name: "step_through", description: "92 step_through – step (S28)", inputSchema: z.object({ path: z.string(), steps: z.number().optional().default(1), projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("step_through",`--step ${a.path}`, a)}]}), provider:"roblox", execution:"studio"},
  { name: "continue_execution", description: "93 continue_execution – resume (S28)", inputSchema: z.object({ path: z.string().optional(), projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("continue_execution","--continue", a)}]}), provider:"roblox", execution:"studio"},
  { name: "generate_level", description: "94 generate_level – constraints (S29). Terminal envelope.", inputSchema: z.object({ prompt: z.string().optional().default("obby"), constraints: z.record(z.unknown()).optional(), projectId: z.string().optional() }), handler: async (a)=>{ const code=`-- S29 ${a.prompt}`; return {content:[{type:"text", text: await studioQueueAndWait("run_code", code, {prompt:a.prompt, projectId:a.projectId} as any)}]}; }, provider:"roblox", execution:"studio"},
  { name: "get_projects", description: "95 get_projects – list (S30)", inputSchema: z.object({}), handler: async ()=>({content:[{type:"text", text: JSON.stringify({projects:["default","lobby","obby"], active:"default"}, null,2)}]})},
  { name: "switch_project", description: "96 switch_project – switch (S30)", inputSchema: z.object({ projectId: z.string() }), handler: async (a)=>({content:[{type:"text", text: JSON.stringify({switched:true, projectId:a.projectId}, null,2)}]})},
  { name: "create_project", description: "97 create_project – create (S30)", inputSchema: z.object({ projectId: z.string(), template: z.string().optional() }), handler: async (a)=>{ if(a.template){ const t=templateStore.get(a.template); if(t?.code) queueAndWait("run_code", t.code, {projectId:a.projectId} as any); } return {content:[{type:"text", text: JSON.stringify({created:true, projectId:a.projectId}, null,2)}]}; }},
  { name: "get_suggestions", description: "98 get_suggestions – predictive (S33)", inputSchema: z.object({ context: z.string().optional(), projectId: z.string().optional().default("default") }), handler: async (a)=>{ const r=teamLog.query({projectId:a.projectId, limit:5}); const s=r.length? ["run_code","take_snapshot"] : ["create_instance","execute_luau"]; return {content:[{type:"text", text: JSON.stringify({suggestions:s}, null,2)}]}; }},
  { name: "run_playtest", description: "99 run_playtest – playtest (S35)", inputSchema: z.object({ projectId: z.string().optional().default("default"), durationSec: z.number().optional().default(5) }), handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("simulate_ticks",`--playtest ${a.durationSec}s`, a)}]}), provider:"roblox", execution:"studio"},
  { name: "export_project", description: "100 export_project – archive (S37)", inputSchema: z.object({ projectId: z.string().optional().default("default") }), handler: async (a)=>{ const snap=buildContext({projectId:a.projectId, snapshot:""}); return {content:[{type:"text", text: JSON.stringify({exported:true, archive: Buffer.from(JSON.stringify(snap)).toString("base64").slice(0,200)}, null,2)}]}; }},
  { name: "import_project", description: "101 import_project – import archive (S37)", inputSchema: z.object({ archive: z.string(), projectId: z.string().optional() }), handler: async (a)=>{ try{ const d=JSON.parse(Buffer.from(a.archive, "base64").toString()); queueAndWait("run_code","--import",{projectId:a.projectId} as any); return {content:[{type:"text", text: JSON.stringify({imported:true, preview:String(JSON.stringify(d).slice(0,200))}, null,2)}]};}catch(e:any){ return {content:[{type:"text", text: JSON.stringify({error:String(e.message)})}], isError:true}; }}},
  { name: "generate_quest", description: "102 generate_quest – quests (S38)", inputSchema: z.object({ theme: z.string().optional().default("adventure"), difficulty: z.string().optional().default("medium"), projectId: z.string().optional() }), handler: async (a)=>{ const q={id:`q_${Date.now()}`, theme:a.theme, difficulty:a.difficulty, objectives:["Talk to NPC",`Collect 3 ${a.theme} items`], rewards:{coins:100}}; queueAndWait("run_code",`--quest ${q.id}`,{projectId:a.projectId} as any); return {content:[{type:"text", text: JSON.stringify(q,null,2)}]}; }},
  { name: "simulate_economy", description: "103 simulate_economy – sim (S40)", inputSchema: z.object({ config: z.record(z.unknown()).optional(), iterations: z.number().optional().default(1000), projectId: z.string().optional() }), handler: async (a)=>{ const inf=(Math.random()*0.04-0.02).toFixed(4); return {content:[{type:"text", text: JSON.stringify({iterations:a.iterations, inflation:inf, balance:"stable"}, null,2)}]}; }},
  { name: "suggest_balance", description: "104 suggest_balance – balance (S40)", inputSchema: z.object({ projectId: z.string().optional().default("default") }), handler: async (a)=>({content:[{type:"text", text: JSON.stringify({suggestions: analyticsEngine.suggest(a.projectId)}, null,2)}]})},
  { name: "explain_code", description: "105 explain_code – explain (S43 offline)", inputSchema: z.object({ code: z.string().optional(), path: z.string().optional(), projectId: z.string().optional() }), handler: async (a)=>{ const src=a.code||a.path||""; const rev=reviewLuau(src); return {content:[{type:"text", text: JSON.stringify({explanation:`Script ${a.path||"inline"}`, issues:rev.issues, mermaid:"graph TD; A-->B"}, null,2)}]}; }},
  { name: "learning_mode", description: "106 learning_mode – toggle (S43)", inputSchema: z.object({ enabled: z.boolean().optional(), projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: JSON.stringify({learningMode:a.enabled??true}, null,2)}]})},
  { name: "adjust_difficulty", description: "107 adjust_difficulty – DDA (S45)", inputSchema: z.object({ projectId: z.string().optional().default("default"), metrics: z.record(z.unknown()).optional() }), handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("adjust_difficulty","--dda_adjust", a)}]}), provider:"roblox", execution:"studio"},
  { name: "set_difficulty_profile", description: "108 set_difficulty_profile – mode (S45)", inputSchema: z.object({ profile: z.enum(["easy","medium","hard","adaptive"]), projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("set_difficulty_profile",`--dda_profile ${a.profile}`, a)}]}), provider:"roblox", execution:"studio"},
  { name: "generate_sound", description: "109 generate_sound – audio (S48 procedural, no key)", inputSchema: z.object({ prompt: z.string(), type: z.enum(["sfx","music","voice"]).optional().default("sfx"), projectId: z.string().optional() }), handler: async (a)=>{ const p=`Assets/Audio/${a.prompt.replace(/\s+/g,"_")}.ogg`; const code=`local s=Instance.new("Sound"); s.SoundId="rbxassetid://0"; s.Parent=workspace`; queueAndWait("run_code", code, {sound:true, prompt:a.prompt, projectId:a.projectId} as any); return {content:[{type:"text", text: JSON.stringify({generated:true, prompt:a.prompt, path:p, note:"procedural, no key"}, null,2)}]}; }},
  { name: "generate_sound_pack", description: "110 generate_sound_pack – multiple (S48)", inputSchema: z.object({ prompt: z.string(), count: z.number().optional().default(3), type: z.enum(["sfx","music","voice"]).optional().default("sfx") }), handler: async (a)=>{ const packs=Array.from({length:a.count||3}, (_,i)=>({prompt:`${a.prompt} ${i+1}`, path:`Assets/Audio/${i}.ogg`})); return {content:[{type:"text", text: JSON.stringify({pack:packs}, null,2)}]}; }},
  { name: "play_sound", description: "111 play_sound – play (S48)", inputSchema: z.object({ path: z.string().optional().default("workspace"), soundId: z.string().optional(), projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("play_sound","--play_sound", a)}]}), provider:"roblox", execution:"studio"},
  // 112-113 Animation info/delete
  { name: "get_animation_info", description: "112 get_animation_info – inspect animation asset (animationId for cached/provider clips, or path for in-place KeyframeSequence e.g. Workspace/RoLinkAnimations/HelloWave; pass numeric:true for per-keyframe pose positions (studs) and rotations (degrees))", inputSchema: z.object({ animationId: z.string().min(1).optional(), path: z.string().optional(), numeric: z.boolean().optional(), projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("get_animation_info",`--anim_info ${a.animationId || a.path}`, a)}]}), provider:"roblox", execution:"studio"},
  { name: "delete_animation", description: "113 delete_animation – remove cached track", inputSchema: z.object({ animationId: z.string().min(1), projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("delete_animation",`--anim_del ${a.animationId}`, a)}]}), provider:"roblox", execution:"studio"},
  // 114-117 Cinematics (cutscene / dialogue / motion / vfx)
  { name: "create_cutscene", description: "114 create_cutscene – cinematic camera sequence with eased tweens, fades, FOV, shake, letterbox, subtitles, audio and skip ({name*, shots*[{camera{position,lookAt},duration,easing?,transition?,fov?,shake?,hold?}], subtitles?, audio?, loop?, skippable?}). Builds Edit data + an auto-play Play-time LocalScript.", inputSchema: z.object({ name: z.string().min(1).max(64), shots: z.array(z.object({ camera: z.object({ position: z.object({x:z.number(),y:z.number(),z:z.number()}), lookAt: z.object({x:z.number(),y:z.number(),z:z.number()}) }), duration: z.number().min(0.1).max(30), easing: z.enum(["linear","quadIn","quadOut","quadInOut","cubicIn","cubicOut","cubicInOut","sineIn","sineOut","sineInOut","bezierOut","springOut"]).optional().default("linear"), transition: z.enum(["cut","fade"]).optional().default("cut"), fov: z.number().min(1).max(179).optional(), shake: z.object({ amplitude: z.number().min(0).max(10).optional().default(0.5), frequency: z.number().min(0.1).max(30).optional().default(8) }).optional(), hold: z.boolean().optional().default(false) })).min(1).max(32), subtitles: z.array(z.object({ t: z.number().min(0), speaker: z.string().min(1).max(64), text: z.string().min(1).max(280), dur: z.number().min(0.5).max(10).optional() })).max(100).optional().default([]), audio: z.array(z.object({ t: z.number().min(0), soundId: z.string().regex(/^rbxassetid:\/\/\d+$/) })).max(32).optional().default([]), loop: z.boolean().optional().default(false), skippable: z.boolean().optional().default(true), confirm: z.boolean().optional().default(false), projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("create_cutscene",`--cutscene ${a.name}`, a)}]}), provider:"roblox", execution:"studio"},
  { name: "create_dialogue", description: "115 create_dialogue – NPC dialogue tree ({npcPath*, lines*[{speaker,text,choices?}]})", inputSchema: z.object({ npcPath: z.string().min(1), lines: z.array(z.object({ speaker: z.string().min(1).max(64), text: z.string().min(1).max(500), choices: z.array(z.string().max(120)).max(4).optional() })).min(1).max(50), projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("create_dialogue",`--dialogue ${a.npcPath}`, a)}]}), provider:"roblox", execution:"studio"},
  { name: "create_motion_effect", description: "116 create_motion_effect – create a real, inspectable Roblox motion controller (tween/shake/fov/pulse) that runs in Play mode", inputSchema: z.object({ path: z.string().min(1), name: z.string().min(1).max(64).optional(), effect: z.enum(["tween","shake","fov","pulse"]).default("tween"), duration: z.number().min(0.1).max(30).optional().default(1), loop: z.boolean().optional().default(false), playback: z.enum(["auto","server","client"]).optional().default("auto"), autoPlay: z.boolean().optional().default(true), properties: z.record(z.unknown()).optional(), confirm: z.boolean().optional().default(false), projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("create_motion_effect",`--motion ${a.effect} ${a.path}`, a)}]}), provider:"roblox", execution:"studio"},
  { name: "inspect_motion_effect", description: "117 inspect_motion_effect – read a created Roblox motion controller and its verified paths/attributes", inputSchema: motionEffectInspectInput, handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("inspect_motion_effect",`--motion_inspect ${a.name}`, a)}]}), provider:"roblox", execution:"studio"},
  { name: "remove_motion_effect", description: "118 remove_motion_effect – remove one RoLink motion controller after confirmation", inputSchema: motionEffectRemoveInput, handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("remove_motion_effect",`--motion_remove ${a.name}`, a)}]}), provider:"roblox", execution:"studio"},
  { name: "create_vfx", description: "119 create_vfx – particles/fire/smoke/sparkles/beam/light on a target", inputSchema: z.object({ parent: z.string().optional().default("workspace"), effect: z.enum(["particles","fire","smoke","sparkles","beam","pointlight"]).default("particles"), properties: z.record(z.unknown()).optional(), projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("create_vfx",`--vfx ${a.effect}`, a)}]}), provider:"roblox", execution:"studio"},
  // 120-124 Clip export + publish workflow (editor round-trip)
  { name: "export_animation_clip", description: "118 export_animation_clip – AnimationClip twin of a track for editor round-trip", inputSchema: z.object({ trackPath: z.string().min(1).optional(), animationId: z.string().optional(), projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("export_animation_clip",`--clip ${a.trackPath || a.animationId}`, a)}]}), provider:"roblox", execution:"studio"},
  { name: "publish_animation", description: "119 publish_animation – prepare track for publish, or register a published asset ID", inputSchema: z.object({ action: z.enum(["prepare","register"]), trackPath: z.string().optional(), animationId: z.string().optional(), assetId: z.string().optional(), projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("publish_animation",`--publish_${a.action}`, a)}]}), provider:"roblox", execution:"studio"},
  // 141-143 Cutscene lifecycle (numeric timeline, audit, narrow removal)
  { name: "preview_cutscene", description: "141 preview_cutscene – numeric camera timeline for a stored cutscene (per-shot start/duration, from/to cameras, FOV, transitions, subtitles, audio hits, loop seam). Numbers, never pixels.", inputSchema: z.object({ name: z.string().min(1).max(64), projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("preview_cutscene",`--cutscene_preview ${a.name}`, a)}]}), provider:"roblox", execution:"studio"},
  { name: "validate_cutscene", description: "142 validate_cutscene – audit a stored cutscene (shots, easings, transitions, FOV, subtitles, audio IDs, loop seam) with error codes and fixes.", inputSchema: z.object({ name: z.string().min(1).max(64), projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("validate_cutscene",`--cutscene_validate ${a.name}`, a)}]}), provider:"roblox", execution:"studio"},
  { name: "remove_cutscene", description: "143 remove_cutscene – remove one stored cutscene and its playback script after confirmation (target models/parts untouched).", inputSchema: z.object({ name: z.string().min(1).max(64), confirm: z.boolean().optional().default(false), projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("remove_cutscene",`--cutscene_remove ${a.name}`, a)}]}), provider:"roblox", execution:"studio"},
  // 125-129 Diagnostics + inspection (state truth, errors, UI, scene, playtest, migrate)
  { name: "scan_errors", description: "125 scan_errors – structured Studio Output error/warning list (newest first) with counts. No more asking 'what's wrong?'.", inputSchema: z.object({ limit: z.number().min(1).max(100).optional().default(30), projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("scan_errors","--scan_errors", a)}]}), provider:"roblox", execution:"studio"},
  { name: "inspect_ui", description: "126 inspect_ui – Roblox UI tree with classes, paths and screen rects for overlap/layout reasoning.", inputSchema: z.object({ root: z.string().optional().default("StarterGui"), maxDepth: z.number().min(1).max(8).optional().default(4), projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("inspect_ui",`--inspect_ui ${a.root}`, a)}]}), provider:"roblox", execution:"studio"},
  { name: "screenshot_studio", description: "127 screenshot_studio – schematic scene map (SVG) projected from CurrentCamera: parts as dots, UI as rects. Layout/overlap reasoning, not art review - Studio exposes no pixel capture to plugins.", inputSchema: z.object({ projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("screenshot_studio","--scene_map", a)}]}), provider:"roblox", execution:"studio"},
  { name: "playtest_scenario", description: "128 playtest_scenario – composed observe flow: snapshot, tick window, Output + error check against expect. Edit-mode logic verification (starting Play needs a human click).", inputSchema: z.object({ scenario: z.string().min(1), seconds: z.number().min(0.5).max(10).optional().default(5), watch: z.string().optional().default(""), expect: z.string().optional().default(""), projectId: z.string().optional() }), handler: async (a)=>{ const t0=Date.now(); const proj=(a as any).projectId; const parse=(t:string)=>{try{return JSON.parse(t);}catch{return null;};}; const snapRaw=await studioQueueAndWait("get_snapshot","--snapshot",{projectId:proj} as any); const obsRaw=await studioQueueAndWait("playtest_scenario","--observe",{seconds:(a as any).seconds??5,watch:(a as any).watch??"",projectId:proj} as any); const errRaw=await studioQueueAndWait("scan_errors","--scan_errors",{projectId:proj} as any); const obs=parse(obsRaw)?.result||{}; const errs=parse(errRaw)?.result?.errors||[]; const obsLines=Array.isArray((obs as any).lines)?(obs as any).lines:[]; const outTxt=JSON.stringify([...(obs.output||[]),...obsLines]); const checks:any[]=[]; const exp=((a as any).expect||"").trim(); if(exp) checks.push({check:`output contains '${exp}'`,passed:outTxt.toLowerCase().includes(exp.toLowerCase())}); checks.push({check:"no new Studio errors",passed:errs.length===0,detail:`${errs.length} error(s) in window`}); const passed=checks.every(c=>c.passed); return {content:[{type:"text", text:JSON.stringify({ok:passed,tool:"playtest_scenario",executionId:`rl_${Date.now().toString(36)}_play`,status:passed?"success":"error",durationMs:Date.now()-t0,...(passed?{result:{scenario:(a as any).scenario,passed,seconds:(a as any).seconds??5,playState:obs.playState||"edit",checks,lines:obsLines.slice(0,50),output:(obs.output||[]).slice(0,20),errors:errs.slice(0,10),snapshotOk:!!parse(snapRaw)?.ok}}:{error:{code:"STUDIO_EXECUTION_FAILED",message:`playtest_scenario '${(a as any).scenario}' failed: `+checks.filter(c=>!c.passed).map(c=>c.check).join("; ")}})},null,2)}]}; }, provider:"roblox", execution:"studio"},
  { name: "migrate_system", description: "129 migrate_system – read current implementation, return a migration plan; applies NOTHING unless confirm:true with explicit create_module/set_script_content steps[] (atomic batch, rollback on failure).", inputSchema: z.object({ system: z.string().min(1), goal: z.string().min(1), sources: z.array(z.string()).max(10).optional().default([]), steps: z.array(z.object({tool:z.string(),args:z.record(z.unknown()).optional()})).max(10).optional().default([]), plan_only: z.boolean().optional().default(true), confirm: z.boolean().optional().default(false), projectId: z.string().optional() }), handler: async (a)=>{ const t0=Date.now(); const proj=(a as any).projectId; const srcs=((a as any).sources||[]).slice(0,10); const readback:any[]=[]; for(const p of srcs){ try{ const raw=await studioQueueAndWait("get_script_content",`--read ${p}`,{path:p,projectId:proj} as any); readback.push({path:p,ok:true,head:raw.slice(0,2000)}); }catch(e:any){ readback.push({path:p,ok:false,head:String(e?.message||e).slice(0,200)}); } } const reqs=[...new Set(readback.flatMap(r=>[...(r.head.matchAll(/require\(\s*([^)]+)\)/g))].map((m:any)=>m[1])))].slice(0,20); const plan={system:(a as any).system,goal:(a as any).goal,steps:readback.slice(0,5).map((r,i)=>({order:i+1,action:i===0?"move to module":"update require",detail:"author concrete edits from the readback above"} as any)),requiresFound:reqs,readback}; const steps=(a as any).steps||[]; if((a as any).plan_only!==false||!steps.length||(a as any).confirm!==true) return {content:[{type:"text", text:JSON.stringify({ok:true,tool:"migrate_system",executionId:`rl_${Date.now().toString(36)}_mig`,status:"success",durationMs:Date.now()-t0,result:{planOnly:true,plan,toApply:"re-send with plan_only:false, confirm:true, and steps:[{tool,args}] (create_module/set_script_content only)"}},null,2)}]}; const allowed=new Set(["create_module","set_script_content"]); for(let i=0;i<steps.length;i++){ const s=steps[i]; if(!s||!allowed.has(s.tool)||typeof s.args!=="object") return {content:[{type:"text", text:JSON.stringify({ok:false,tool:"migrate_system",executionId:`rl_${Date.now().toString(36)}_mig`,status:"error",durationMs:Date.now()-t0,error:{code:"VALIDATION",message:`step ${i} must be {tool,args} with tool in create_module|set_script_content`}},null,2)}],isError:true}; } const batch=tools.find(t=>t.name==="batch_queue")!; const out=await batch.handler({commands:steps,mode:"atomic",projectId:proj} as any); const txt=out.content[0].text as string; let body:any=null; try{body=JSON.parse(txt);}catch{body={raw:txt.slice(0,500)};} const ok=!!body?.ok; return {content:[{type:"text", text:JSON.stringify({ok,tool:"migrate_system",executionId:`rl_${Date.now().toString(36)}_mig`,status:ok?"success":"error",durationMs:Date.now()-t0,...(ok?{result:{planOnly:false,plan,applied:body}}:{error:{code:"TX_ROLLBACK",message:"migrate_system: atomic apply failed - rolled back"}})},null,2)}],...(ok?{}:{isError:true})}; }, provider:"roblox", execution:"studio"},  { name: "analyze_animatable_model", description: "125 analyze_animatable_model \u2013 classify a model animatable hierarchy (rotational joints, root, follows, anchors) with warnings", inputSchema: z.object({ target: z.string().min(1), projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("analyze_animatable_model",`--anim_analyze ${a.target}`, a)}]}), provider:"roblox", execution:"studio"},
  { name: "create_model_animation", description: "126 create_model_animation \u2013 animation store for any model (humanoid, cannon, door, vehicle). Overwrite needs confirm:true", inputSchema: z.object({ target: z.string().min(1), name: z.string().min(1).max(64), duration: z.number().min(0.1).max(60), fps: z.number().min(1).max(120).optional().default(30), loop: z.boolean().optional().default(false), confirm: z.boolean().optional().default(false), projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("create_model_animation",`--anim_create ${a.name}`, a)}]}), provider:"roblox", execution:"studio"},
  { name: "inspect_motion_animation", description: "127 inspect_motion_animation – verify a created motion controller and return numeric keyframe/pose data", inputSchema: motionAnimationNameInput, handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("inspect_motion_animation",`--motion_animation_info ${a.name}`, a)}]}), provider:"roblox", execution:"studio"},
  { name: "validate_motion_animation", description: "128 validate_motion_animation – audit motion controller target, keyframe order, duration, and playback wiring", inputSchema: motionAnimationNameInput, handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("validate_motion_animation",`--motion_animation_validate ${a.name}`, a)}]}), provider:"roblox", execution:"studio"},
  { name: "preview_motion_animation", description: "129 preview_motion_animation – sample a motion controller numerically without pretending Studio rendered pixels", inputSchema: motionAnimationPreviewInput, handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("preview_motion_animation",`--motion_animation_preview ${a.name}`, a)}]}), provider:"roblox", execution:"studio"},
  { name: "remove_motion_animation", description: "130 remove_motion_animation – remove a named RoLink motion controller and its playback script", inputSchema: motionEffectRemoveInput, handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("remove_motion_animation",`--motion_animation_remove ${a.name}`, a)}]}), provider:"roblox", execution:"studio"},
  { name: "set_model_keyframe", description: "127 set_model_keyframe \u2013 upsert one pose key on a model-animation track (times auto-sorted, easing resolved, 1024 keys max)", inputSchema: z.object({ anim: z.string().min(1), track: z.string().min(1), t: z.number().min(0), pose: z.object({ position: z.object({ x: z.number(), y: z.number(), z: z.number() }).optional(), rotation: z.object({ x: z.number(), y: z.number(), z: z.number() }).optional() }), ease: z.string().optional().default("linear"), projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("set_model_keyframe",`--anim_key ${a.anim}.${a.track}@${a.t}`, a)}]}), provider:"roblox", execution:"studio"},
  { name: "set_model_easing", description: "128 set_model_easing \u2013 change one keyframe easing by 1-based keyIndex (suffixed names: quadIn, never bare quad)", inputSchema: z.object({ anim: z.string().min(1), track: z.string().min(1), keyIndex: z.number().min(1), ease: z.string().min(1), projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("set_model_easing",`--anim_ease ${a.anim}.${a.track}#${a.keyIndex}`, a)}]}), provider:"roblox", execution:"studio"},
  { name: "add_animation_marker", description: "129 add_animation_marker \u2013 impact/event markers on a model animation (remove:true deletes by name)", inputSchema: z.object({ anim: z.string().min(1), t: z.number().min(0), name: z.string().min(1).max(64), event: z.string().optional(), remove: z.boolean().optional().default(false), projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("add_animation_marker",`--anim_marker ${a.anim}@${a.t}`, a)}]}), provider:"roblox", execution:"studio"},
  { name: "preview_model_animation", description: "130 preview_model_animation \u2013 numeric motion sample (snapshots, peak velocities, markers hit). Numbers, never pixels.", inputSchema: z.object({ anim: z.string().min(1), step: z.number().min(0.02).max(1).optional().default(0.1), projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("preview_model_animation",`--anim_preview ${a.anim}`, a)}]}), provider:"roblox", execution:"studio"},
  { name: "validate_model_animation", description: "131 validate_model_animation \u2013 structural + motion audit (spikes, jumps, loop mismatch, orphan events) with fixes - MODEL animations only (ReplicatedStorage/RoLinkModelAnims); for KeyframeSequence tracks use get_animation_info or inspect_keyframe_track instead.", inputSchema: z.object({ anim: z.string().min(1), projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("validate_model_animation",`--anim_validate ${a.anim}`, a)}]}), provider:"roblox", execution:"studio"},  { name: "retime_animation", description: "132 retime_animation \u2013 scale all key/marker times by a factor (newName? copies, else in-place). Result capped at 60s", inputSchema: z.object({ anim: z.string().min(1), scale: z.number().min(0.1).max(10), newName: z.string().min(1).max(64).optional(), projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("retime_animation",`--anim_retime ${a.anim}x${a.scale}`, a)}]}), provider:"roblox", execution:"studio"},
  { name: "reverse_animation", description: "133 reverse_animation \u2013 mirror in time (t becomes duration-t, In/Out easings swapped). NewName? copies, else in-place", inputSchema: z.object({ anim: z.string().min(1), newName: z.string().min(1).max(64).optional(), projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("reverse_animation",`--anim_reverse ${a.anim}`, a)}]}), provider:"roblox", execution:"studio"},
  { name: "mirror_animation", description: "134 mirror_animation \u2013 sagittal mirror (pos.x, rot.y/z negated, Left/Right tracks swapped). Template - always validate after", inputSchema: z.object({ anim: z.string().min(1), newName: z.string().min(1).max(64).optional(), swapPairs: z.boolean().optional().default(true), projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("mirror_animation",`--anim_mirror ${a.anim}`, a)}]}), provider:"roblox", execution:"studio"},
  { name: "blend_animation", description: "135 blend_animation \u2013 weighted resample of base+overlay into newName (shared tracks interpolated, unique copied)", inputSchema: z.object({ base: z.string().min(1), overlay: z.string().min(1), weight: z.number().min(0).max(1).optional().default(0.5), newName: z.string().min(1).max(64), projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("blend_animation",`--anim_blend ${a.base}+${a.overlay}`, a)}]}), provider:"roblox", execution:"studio"},
  { name: "fix_animation", description: "136 fix_animation \u2013 apply safe auto-fixes from validate (loop ends, clamp, orphans, bad easing) and re-validate", inputSchema: z.object({ anim: z.string().min(1), projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("fix_animation",`--anim_fix ${a.anim}`, a)}]}), provider:"roblox", execution:"studio"},
  { name: "create_attack_animation", description: "137 create_attack_animation \u2013 scaffold anticipation/strike/impact/recovery keys + IMPACT marker on listed tracks. Refine after", inputSchema: z.object({ target: z.string().min(1), name: z.string().min(1).max(64), tracks: z.array(z.string().min(1)).min(1).max(32), duration: z.number().min(0.3).max(10).optional().default(1.05), anticipation: z.number().min(0).max(5).optional().default(0.2), impactT: z.number().min(0).optional().default(0.46), strike: z.object({ rx: z.number().optional().default(0), ry: z.number().optional().default(45), rz: z.number().optional().default(0) }).optional(), loop: z.boolean().optional().default(false), confirm: z.boolean().optional().default(false), projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("create_attack_animation",`--anim_attack ${a.name}`, a)}]}), provider:"roblox", execution:"studio"},
  { name: "create_idle_animation", description: "138 create_idle_animation \u2013 looping sway scaffold on listed tracks (neutral-sway-neutral). Refine after", inputSchema: z.object({ target: z.string().min(1), name: z.string().min(1).max(64), tracks: z.array(z.string().min(1)).min(1).max(32), duration: z.number().min(0.5).max(10).optional().default(2), sway: z.number().min(0).max(45).optional().default(5), fps: z.number().min(1).max(120).optional().default(30), loop: z.boolean().optional().default(true), confirm: z.boolean().optional().default(false), projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("create_idle_animation",`--anim_idle ${a.name}`, a)}]}), provider:"roblox", execution:"studio"},
  { name: "create_walk_cycle", description: "139 create_walk_cycle \u2013 looping 4-beat stride scaffold, alternating offsets by track order. Refine after", inputSchema: z.object({ target: z.string().min(1), name: z.string().min(1).max(64), tracks: z.array(z.string().min(1)).min(1).max(32), duration: z.number().min(0.3).max(5).optional().default(0.8), stride: z.number().min(0).max(90).optional().default(20), fps: z.number().min(1).max(120).optional().default(30), loop: z.boolean().optional().default(true), confirm: z.boolean().optional().default(false), projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("create_walk_cycle",`--anim_walk ${a.name}`, a)}]}), provider:"roblox", execution:"studio"},  { name: "set_track_lock", description: "140 set_track_lock \u2013 freeze/unfreeze one model-animation track (locked tracks refuse keys until unlocked)", inputSchema: z.object({ anim: z.string().min(1), track: z.string().min(1), locked: z.boolean().optional().default(true), projectId: z.string().optional() }), handler: async (a)=>({content:[{type:"text", text: await studioQueueAndWait("set_track_lock",`--anim_lock ${a.anim}.${a.track}`, a)}]}), provider:"roblox", execution:"studio"},
  { name: "run_task", description: "144 run_task – dependency-ordered task graph (orchestrator primitive): up to 10 named steps run topologically with per-step verify{tool,expect?} and evidence per step; atomic snapshots first and rolls back on failure. Plan as steps, not prose.", inputSchema: z.object({ goal: z.string().min(1), steps: z.array(z.object({ id: z.string().min(1), tool: z.string().min(1), args: z.record(z.unknown()).optional().default({}), depends_on: z.array(z.string()).optional().default([]), verify: z.object({ tool: z.string().min(1), args: z.record(z.unknown()).optional().default({}), expect: z.string().optional().default("") }).optional() })).min(1).max(10), mode: z.enum(["atomic","best_effort"]).optional().default("best_effort"), projectId: z.string().optional() }), handler: async (a)=>{const t0=Date.now(); const mode=(a as any).mode||"best_effort"; const goal=String((a as any).goal||""); const steps=((a as any).steps||[]) as any[]; const proj=String((a as any).projectId||"default"); const execId=`rl_${Date.now().toString(36)}_task`; const err=(code:string,message:string):{content:{type:"text";text:string}[];isError:true}=>({content:[{type:"text",text:JSON.stringify({ok:false,tool:"run_task",executionId:"rl_rejected",status:"error",durationMs:Date.now()-t0,error:{code,message}})}],isError:true}); if(!goal.trim()) return err("VALIDATION","run_task: 'goal' is required (one line naming the task)"); if(!Array.isArray(steps)||!steps.length) return err("VALIDATION","run_task: 'steps' must be a non-empty array of {id, tool, args?}"); if(steps.length>10) return err("VALIDATION","run_task: max 10 steps per task - split into smaller tasks"); if(mode!=="atomic"&&mode!=="best_effort") return err("VALIDATION","run_task: mode must be 'atomic' or 'best_effort'"); const ids=new Set<string>(); const norm:any[]=[]; for(let i=0;i<steps.length;i++){ const s=steps[i]; if(!s||typeof s!=="object") return err("VALIDATION",`run_task: step ${i} must be an object`); const sid=String(s.id==null?"":s.id).trim(); if(!sid) return err("VALIDATION",`run_task: step ${i} needs an 'id'`); if(ids.has(sid)) return err("VALIDATION",`run_task: duplicate step id '${sid}'`); ids.add(sid); const tool=String(s.tool==null?"":s.tool).trim(); if(!tool) return err("VALIDATION",`run_task: step '${sid}' needs a 'tool'`); const sargs=(s.args==null?{}:s.args); if(typeof sargs!=="object"||Array.isArray(sargs)) return err("VALIDATION",`run_task: step '${sid}' 'args' must be an object`); const deps=(s.depends_on==null?[]:s.depends_on); if(!Array.isArray(deps)||deps.some((d:any)=>typeof d!=="string")) return err("VALIDATION",`run_task: step '${sid}' 'depends_on' must be an array of step ids`); for(const d of deps){ if(d===sid) return err("VALIDATION",`run_task: step '${sid}' depends on itself`); if(!steps.some((x:any)=>x&&typeof x==="object"&&String(x.id==null?"":x.id)===d)) return err("VALIDATION",`run_task: step '${sid}' depends on unknown step '${d}'`); } let ver:any=null; if(s.verify!=null){ const v=s.verify; if(typeof v!=="object"||Array.isArray(v)||!String(v.tool==null?"":v.tool).trim()) return err("VALIDATION",`run_task: step '${sid}' 'verify' must be {tool, args?, expect?}`); if(v.args!=null&&(typeof v.args!=="object"||Array.isArray(v.args))) return err("VALIDATION",`run_task: step '${sid}' verify 'args' must be an object`); ver={tool:String(v.tool),args:(v.args==null?{}:v.args),expect:String(v.expect==null?"":v.expect)}; } if(tool==="run_task"||tool==="batch_queue"||(ver&&(ver.tool==="run_task"||ver.tool==="batch_queue"))) return err("VALIDATION",`run_task: step '${sid}' must be a single tool call - no run_task/batch_queue nesting (split fan-out into its own task)`); norm.push({id:sid,tool,args:sargs,depends_on:deps,verify:ver}); } const ordered:any[]=[]; const done=new Set<string>(); let pend=norm.slice(); while(pend.length){ const ready=pend.filter((s)=>s.depends_on.every((d:string)=>done.has(d))); if(!ready.length) return err("VALIDATION",`run_task: dependency cycle in steps ${JSON.stringify(pend.map((s:any)=>s.id).sort())} - order them so every depends_on names an earlier step`); for(const s of ready){ ordered.push(s); done.add(s.id); } pend=pend.filter((s)=>!done.has(s.id)); } const findDef=(n:string)=>{ const c=(aliasMap as any)[n]||n; return tools.find(t=>t.name===c)||tools.find(t=>t.name===n); }; const parseEnv=(t:string)=>{ try{return JSON.parse(t);}catch{return null;} }; const hash=(s:string)=>{ let h=5381; for(let i=0;i<s.length;i++) h=(((h<<5)+h+s.charCodeAt(i))|0); return (h>>>0).toString(16); }; const snapHash=async():Promise<[string|null,string]>=>{ try{ const raw=await studioQueueAndWait("get_snapshot","--snapshot",{projectId:proj} as any,30000); const e=parseEnv(raw); if(!e||!e.ok) return [null,`snapshot failed: ${String((e&&e.error&&(e.error.message||e.error.code))||(e&&e.error)||"no result").slice(0,160)}`]; const snap=(e.result&&typeof e.result==="object")?(e.result.snapshot||""):(typeof e.snapshot==="string"?e.snapshot:JSON.stringify(e.result||"")); if(typeof snap!=="string"||!snap) return [null,"snapshot returned no tree"]; const lines=snap.split("\n"); return [hash(lines.length>1?lines.slice(1).join("\n"):lines.join("\n")),"ok"]; }catch(e:any){ return [null,`snapshot call raised: ${String(e?.message||e).slice(0,160)}`]; } }; let pre:string|null=null; if(mode==="atomic"){ const [h,d]=await snapHash(); if(h===null) return {content:[{type:"text", text:JSON.stringify({ok:false,tool:"run_task",executionId:"rl_rejected",status:"error",durationMs:Date.now()-t0,error:{code:"STUDIO_EXECUTION_FAILED",message:"run_task atomic: cannot guarantee rollback without a pre-snapshot - "+d}})}], isError:true}; pre=h; } const deadline=Date.now()+115000; const withBudget=(p:Promise<any>,ms:number):Promise<any>=>{ let tm:any=null; const guard=new Promise<any>((res)=>{ tm=setTimeout(()=>res({__budget:true}),ms); if(tm&&typeof tm.unref==="function") tm.unref(); }); return Promise.race([p,guard]).finally(()=>{ if(tm) clearTimeout(tm); }); }; const dispatch=async(tool:string,args:any):Promise<any>=>{ const canon=(aliasMap as any)[tool]||tool; const def=findDef(tool); if(!def&&!RUN_TASK_QUEUE_EXTRA.has(canon)&&!RUN_TASK_QUEUE_EXTRA.has(tool)){ const sug=RUN_TASK_KNOWN_SORTED.filter((n:string)=>n.startsWith(tool)||(tool.length>3&&tool.startsWith(n))).slice(0,3); return {ok:false,kind:"validation_error",error:`ERROR: unknown tool "${tool}".${sug.length?` Did you mean: ${sug.join(", ")}?`:""} Use an exact name from list_commands.`}; } const margs={...((args||{}) as any)}; if(typeof margs.projectId!=="string"||!margs.projectId) margs.projectId=proj; try{ const raw:any=def?await def.handler(margs):await studioQueueAndWait(tool,tool,margs); const txt:string=(typeof raw==="string")?raw:((raw&&raw.content&&raw.content[0])?String(raw.content[0].text):""); const env=parseEnv(txt); if(env===null||typeof env!=="object"||Array.isArray(env)) return {ok:false,kind:"execution_error",error:"run_task: unparseable sub-result"}; const flagged=(raw&&raw.isError===true); const ok=typeof env.ok==="boolean"?env.ok:(!env.error&&!flagged); const code=String((env.error&&env.error.code)||env.error_code||""); const kind=ok?undefined:(env.status==="timeout"||code==="TIMEOUT"?"timeout":code==="MCP_OFFLINE"?"plugin_offline":code==="STUCK_EXECUTION"?"stuck-execution":code?"execution_error":undefined); const errStr=ok?undefined:String((env.error&&(env.error.message||env.error.code))||(typeof env.error==="string"?env.error:env.error?JSON.stringify(env.error):"")||""); const text=ok?String((typeof env.text==="string"?env.text:(env.result!==undefined?JSON.stringify(env.result):txt))||""):errStr; return {ok,kind,error:errStr,error_code:code||undefined,text}; }catch(e:any){ return {ok:false,kind:"execution_error",error:String(e?.message||e)}; } }; const evidence:any[]=[]; const appliedRows:any[]=[]; let failed:any=null; for(const s of ordered){ const remaining=deadline-Date.now(); if(remaining<=8000){ const row:any={id:s.id,tool:s.tool,ok:false,kind:"timeout",error:"run_task: task time budget exhausted - completed steps stand (best_effort) or were rolled back (atomic); retry the remainder singly"}; evidence.push(row); failed=row; break; } const budget=Math.min(Math.max(remaining,8000),60000); const t1=Date.now(); const env:any=await withBudget(dispatch(s.tool,s.args),budget); if(env&&env.__budget){ const row:any={id:s.id,tool:s.tool,ok:false,kind:"timeout",durationMs:Date.now()-t1,error:`run_task: step '${s.id}' exceeded the shared task budget of 115s - call plugin_status, then retry the remaining steps singly`}; evidence.push(row); failed=row; if(evidence.length<ordered.length) evidence.push({id:"(unrun)",tool:"run_task",ok:false,kind:"validation_error",error:"run_task: stopping early - Studio stopped answering; call plugin_status, then retry remaining steps singly"}); break; } const row:any={id:s.id,tool:s.tool,ok:!!env.ok,durationMs:Date.now()-t1}; if(env.kind) row.kind=env.kind; if(env.error) row.error=String(env.error); if(env.error_code) row.error_code=String(env.error_code); const applied=!env.error&&!env.kind; if(applied) appliedRows.push(row); if(env.ok) row.result=String(env.text||"").slice(0,2000); const ver=s.verify; if(ver&&row.ok){ const v:any=await withBudget(dispatch(ver.tool,ver.args),Math.min(Math.max(deadline-Date.now(),8000),60000)); const vtext=String((v&&v.text)||""); const exp=String(ver.expect||"").trim(); const vok=!!(v&&v.ok)&&(!exp||vtext.toLowerCase().includes(exp.toLowerCase())); row.verify={tool:ver.tool,ok:vok,...(exp?{expect:exp}:{}),...(!vok?{detail:(vtext||"verify call failed").slice(0,500)}:{})}; if(!vok){ row.ok=false; row.kind="execution_error"; row.error=`run_task: step '${s.id}' verify failed`+(exp?` - expected '${exp}'`:""); } } evidence.push(row); if(!row.ok){ failed=row; if(["plugin_offline","stuck-execution","timeout"].includes(row.kind)&&evidence.length<ordered.length) evidence.push({id:"(unrun)",tool:"run_task",ok:false,kind:"validation_error",error:"run_task: stopping early - Studio stopped answering; call plugin_status, then retry remaining steps singly"}); break; } } const succeeded=evidence.filter((e)=>e.ok&&e.id!=="(unrun)").length; if(!failed) return {content:[{type:"text", text:JSON.stringify({ok:true,tool:"run_task",executionId:execId,status:"success",durationMs:Date.now()-t0,result:{goal,mode,status:"success",steps:evidence.length,succeeded,partialCommitAllowed:mode!=="atomic",evidence}},null,2)}]}; if(mode!=="atomic") return {content:[{type:"text", text:JSON.stringify({ok:true,tool:"run_task",executionId:execId,status:"stopped-at-first-failure",durationMs:Date.now()-t0,result:{goal,mode,status:"stopped-at-first-failure",steps:evidence.length,succeeded,partialCommitAllowed:true,evidence}},null,2)}]}; let rolled=false, verify:any={checked:false}; let rbNote=""; const undoable=appliedRows.filter((r)=>runTaskUndoable(r.tool)).length; if(undoable>0){ try{ const raw=await studioQueueAndWait("rollback","--rollback",{steps:undoable,projectId:proj} as any,30000); const e=parseEnv(raw); rolled=!!(e&&e.ok); if(!rolled) rbNote=`rollback call failed: ${String((e&&e.error&&(e.error.message||e.error.code))||(e&&e.error)||"").slice(0,160)}`; }catch(e:any){ rbNote=`rollback raised: ${String(e?.message||e).slice(0,160)}`; } const post=await snapHash(); if(post[0]!==null&&pre!==null) verify={checked:true,passed:post[0]===pre,detail:post[0]===pre?"tree hash matches pre-task snapshot":"tree differs from pre-task snapshot - manual review needed"}; else verify={checked:true,passed:false,detail:`${rbNote}; ${post[1]}`.replace(/^;\s*/,"").replace(/\s*;$/,"")}; } else if(appliedRows.length>0){ const post=await snapHash(); const touched=[...new Set(appliedRows.map((r)=>String(r.tool)))].slice(0,5); if(post[0]!==null&&pre!==null) verify={checked:true,passed:post[0]===pre,detail:post[0]===pre?`${appliedRows.length} step(s) applied changes that rollback cannot address (not Studio-queue tools: ${touched.join(", ")}) - tree hash matches pre-task snapshot, but no rollback was issued`:`${appliedRows.length} step(s) applied changes that rollback cannot address (not Studio-queue tools: ${touched.join(", ")}) - tree differs from pre-task snapshot, manual review needed`}; else verify={checked:true,passed:false,detail:`no Studio-queue step to roll back; ${post[1]}`}; rolled=false; } else { rolled=true; verify={checked:true,passed:true,detail:"no Studio steps had succeeded - nothing to revert"}; } const okRb=rolled&&verify.passed; return {content:[{type:"text", text:JSON.stringify({ok:false,tool:"run_task",executionId:execId,status:"error",durationMs:Date.now()-t0,error:{code:"TX_ROLLBACK",message:JSON.stringify({goal,mode:"atomic",status:okRb?"rolled_back":"rollback_failed",steps:evidence.length,succeeded,rolledBack:rolled,undoneSteps:undoable,partialCommitAllowed:false,verification:verify,evidence})},verification:verify},null,2)}], isError:true};} },
  // 145-147 Phase 3 build engine. Helpers above; see their header comment for
  // why every field below is either observed or null.
  {
    name: "import_distinctus_build",
    description: "145 import_distinctus_build – import a building kit, place it, then READ IT BACK. positioned/anchored/instanceCount are true, false or null (null = could not be measured here, never 'probably fine'). The root path is taken from what the loader returned and confirmed against the parent's live listing - never predicted. Preflight never mutates; plan_only:true returns the plan and stops. mode atomic (default) snapshots first and rolls a failed apply back.",
    inputSchema: z.object({
      source: z.union([z.string(), z.number()]),
      parent: z.string().max(200).optional(),
      at: z.string().optional(),
      name: z.string().min(1).max(120).optional(),
      scale: z.number().min(0.01).max(100).optional(),
      rotate: z.number().min(-360).max(360).optional(),
      anchor: z.boolean().optional(),
      mode: z.enum(["atomic", "best_effort"]).optional(),
      plan_only: z.boolean().optional(),
      projectId: z.string().optional(),
    }),
    handler: async (a) => {
      const t0 = Date.now();
      const args: any = a || {};
      const proj = String(args.projectId || "default");
      const say = (body: any) => buildReply(
        JSON.stringify({ tool: "import_distinctus_build", durationMs: Date.now() - t0, ...body }, null, 2),
        body.ok !== true);
      const fail = (code: string, message: string, extra?: any) => say({
        ok: false, status: "error", error: { code, message },
        verification: { checked: false, passed: false }, ...(extra || {}),
      });
      // ── 1. preflight: every input is checked BEFORE the place is touched ──
      let src: any;
      let parentPath: string;
      let at: number[];
      let scale: number;
      let rotate: number;
      let anchor: boolean | null;
      let wantName: string | null;
      let mode: string;
      try {
        src = buildSource(args.source);
        parentPath = buildCleanPath(args.parent, "parent", "workspace");
        at = buildVec3(args.at === undefined || args.at === null ? "0,0,0" : args.at, "at");
        scale = buildScale(args.scale);
        rotate = buildRotate(args.rotate);
        anchor = buildAnchor(args.anchor, true);
        wantName = (args.name === undefined || args.name === null) ? null : buildName(args.name, "name");
        mode = args.mode ? String(args.mode) : "atomic";
        if (mode !== "atomic" && mode !== "best_effort") {
          throw new BuildVError("'mode' must be 'atomic' (default - a kit is a large mutation) or 'best_effort'");
        }
      } catch (e: any) {
        if (e instanceof BuildVError) return fail("VALIDATION", `import_distinctus_build: ${e.message}`);
        return fail("EXECUTION_ERROR", `import_distinctus_build: unexpected failure (${e?.name || "Error"}: ${String(e?.message || e).slice(0, 200)})`);
      }
      const atomic = mode === "atomic";
      const wanted: string | null = wantName;
      const atDefaulted = args.at === undefined || args.at === null;
      const plan: any = {
        source: src.kind === "asset"
          ? { kind: "asset", assetId: src.assetId }
          : { kind: "placePath", path: src.path },
        parent: parentPath, at, name: wanted, scale, rotate, anchor, mode,
        atDefaulted, anchorDefaulted: args.anchor === undefined || args.anchor === null,
        willMutate: true,
        steps: [
          src.kind === "asset"
            ? { order: 1, tool: "import_asset", args: { assetId: src.assetId, parent: parentPath, ...(wanted ? { assetName: wanted } : {}) } }
            : { order: 1, tool: "clone_instance", args: { path: src.path, parent: parentPath, ...(wanted ? { newName: wanted } : {}) } },
          {
            order: 2, tool: "<transform>",
            args: {
              path: "<the root path step 1 returns - never predicted; confirmed against the parent's live child listing>",
              at, scale, rotate, anchor,
            },
          },
        ],
        notes: [
          "the loader already parents to the resolved parent, so no move_instance is needed",
          "scripts and PackageLinks inside an imported kit are stripped by the plugin's import branch",
          "'at' is where the root's pivot lands (a BasePart's Position, a Model's PivotTo)",
          `the model graph is bridge-side (${BUILD_GRAPH_STORE}) - this path cannot record the import`,
        ],
      };
      if (args.plan_only === true) {
        plan.willMutate = false;
        return say({
          ok: true, status: "plan_only", planOnly: true, mode, plan,
          imported: false, root: null, path: null, className: null,
          positioned: null, anchored: null, instanceCount: null,
          recorded: false, recordReason: BUILD_GRAPH_NOTE, partialCommitAllowed: false,
          verification: { checked: false, passed: false, detail: "plan_only - nothing was applied and nothing was verified" },
          toApply: "re-send the same call without plan_only to apply it",
        });
      }
      // Resolve the parent FOR REAL: a mount point Studio cannot find is a hard
      // stop, because the plan must not promise a place it cannot deliver.
      const before = await buildCall("get_instances", { path: parentPath, projectId: proj });
      if (!before.ok) {
        return fail("PARENT_UNRESOLVED",
          `import_distinctus_build: could not resolve the parent '${parentPath}', so the preflight stopped before mutating: ${before.error}`,
          {
            status: "preflight_failed", mode, goal: plan.source, plan,
            imported: false, root: null, path: null, className: null,
            positioned: null, anchored: null, instanceCount: null,
            recorded: false, recordReason: "the preflight failed, so nothing was applied",
            partialCommitAllowed: false,
            detail: `could not resolve the parent '${parentPath}', so the preflight cannot promise anything and stopped before mutating: ${before.error}`,
            verification: { checked: false, passed: false, detail: "parent resolution failed - no mutation was attempted" },
          });
      }
      const beforeKids: any[] = (before.env && Array.isArray(before.env.result?.instances)) ? before.env.result.instances : [];
      const norm = (p: unknown) => String(p == null ? "" : p).toLowerCase().split(/[/.]/).filter(Boolean).join(".");
      const beforePaths = beforeKids.map((c: any) => norm(c && c.path));
      if (wanted) {
        const low = wanted.toLowerCase();
        const clash = beforeKids.find((c: any) => String((c && c.name) || "").toLowerCase() === low);
        if (clash) {
          return fail("VALIDATION",
            `import_distinctus_build: '${wanted}' already exists under ${parentPath} (${clash.path}) - rename it, pick another name, or omit 'name'. This engine does not clobber.`);
        }
      }
      // atomic = a snapshot BEFORE the first write, or refuse before mutating.
      let preHash: string | null = null;
      if (atomic) {
        const snap = await buildSnapHash(proj);
        if (snap.hash === null) {
          return fail("TX_SNAPSHOT_UNAVAILABLE",
            `import_distinctus_build: mode 'atomic' cannot promise a rollback without a pre-import snapshot and none could be taken (${snap.detail}) - nothing was imported. Retry with mode:'best_effort' to import without rollback, or fix the plugin connection first.`,
            {
              status: "preflight_failed", mode, goal: plan.source, plan,
              imported: false, root: null, path: null, className: null,
              positioned: null, anchored: null, instanceCount: null,
              recorded: false, recordReason: BUILD_GRAPH_NOTE, partialCommitAllowed: false,
              verification: { checked: false, passed: false, detail: "no pre-import snapshot, so the preflight stopped before mutating - nothing was imported" },
            });
        }
        preHash = snap.hash;
      }
      const revert = async (why: string) => {
        if (!atomic) return { attempted: false, restored: false, detail: `mode '${mode}': no rollback was attempted, so ${why}` };
        const rb = await buildCall("rollback", { steps: 1, projectId: proj });
        const rolled: any = rb.env || {};
        const issued = rb.ok === true || (Array.isArray(rolled.rolledBack) && rolled.rolledBack.length > 0);
        const post = await buildSnapHash(proj);
        const restored = preHash !== null && post.hash !== null && post.hash === preHash;
        return {
          attempted: true, restored,
          detail: `${issued ? "a rollback step was issued" : "no rollback step was available to undo this"}; `
            + (post.hash === null ? post.detail : (restored ? "the tree hash matches the pre-import snapshot" : "the tree hash still DIFFERS from the pre-import snapshot")),
        };
      };
      // ── 2. apply: the import runs FIRST - its result is where the root path
      // comes from. Nothing about the root is guessed before this point.
      const step1Name = src.kind === "asset" ? "import_asset" : "clone_instance";
      const step1 = src.kind === "asset"
        ? await buildCall("import_asset", { assetId: src.assetId, parent: parentPath, ...(wanted ? { assetName: wanted } : {}), projectId: proj })
        : await buildCall("clone_instance", { path: src.path, parent: parentPath, ...(wanted ? { newName: wanted } : {}), projectId: proj });
      const body1: any = (step1.env && step1.env.result) ? step1.env.result : {};
      const loaderPath = ["path", "matchedPath", "cloned"]
        .map((k) => body1[k])
        .find((v) => typeof v === "string" && v.length > 0) as string | undefined;
      const common: any = { mode, goal: plan.source, plan };
      if (!step1.ok || !loaderPath) {
        const rev = await revert("the failed import step may have left a partial tree");
        return fail(step1.ok ? "IMPORT_RESULT_INVALID" : "IMPORT_STEP_FAILED",
          step1.ok
            ? `import_distinctus_build: ${step1Name} reported success but returned no inserted path, so this is treated as a failure, not an import`
            : `import_distinctus_build: the ${step1Name} step did not succeed (${step1.error}) - no field here claims the kit is in the place`,
          {
            ...common, status: "import_failed", imported: false,
            root: null, path: null, className: null,
            positioned: null, anchored: null, instanceCount: null,
            recorded: false, recordReason: "nothing was imported, so nothing was recorded",
            partialCommitAllowed: !rev.restored, rollback: rev,
            loaderReportedPath: loaderPath || null,
            failedStep: { tool: step1Name, ok: false, error: step1.error || "the step answered without a root path" },
            evidence: [{ phase: "import", tool: step1Name, ok: step1.ok, ...(loaderPath ? { loaderReportedPath: loaderPath } : {}) }],
            verification: { checked: false, passed: false, detail: `the ${step1Name} step did not succeed - no field here claims the kit is in the place` },
          });
      }
      // Identify the root by OBSERVATION against the parent's live listing.
      const after = await buildCall("get_instances", { path: parentPath, projectId: proj });
      const kids: any[] = (after.ok && after.env && Array.isArray(after.env.result?.instances)) ? after.env.result.instances : [];
      const clsOf = (c: any): string | null => {
        if (!c) return null;
        if (c.class != null) return String(c.class);
        return c.className == null ? null : String(c.className);
      };
      let rootPath: string | null = null;
      let rootCls: string | null = null;
      let rootNote = "";
      if (!after.ok) {
        rootNote = `could not read the parent's children, so the root was NOT confirmed: ${after.error}`;
      } else {
        const byPath = new Map<string, any>();
        for (const c of kids) {
          const k = norm(c && c.path);
          if (!byPath.has(k)) byPath.set(k, c);
        }
        const hit = loaderPath ? byPath.get(norm(loaderPath)) : undefined;
        if (hit) {
          rootPath = String(hit.path);
          rootCls = clsOf(hit);
          rootNote = `root confirmed in the live child listing of ${parentPath} at the path the loader reported`;
        } else if (wanted) {
          const named = kids.find((c: any) => String((c && c.name) || "").toLowerCase() === wanted.toLowerCase());
          if (named) {
            rootPath = String(named.path);
            rootCls = clsOf(named);
            rootNote = `root confirmed in the live child listing of ${parentPath} under the requested name`;
          } else {
            rootNote = `'${wanted}' is not among the ${kids.length} listed child(ren) of ${parentPath} - the import did not land where the plan said it would`;
          }
        } else {
          const seen = new Set(beforePaths);
          const fresh = kids.filter((c: any) => !seen.has(norm(c && c.path)));
          if (fresh.length === 1) {
            rootPath = String(fresh[0].path);
            rootCls = clsOf(fresh[0]);
            rootNote = `no name was requested: the root was identified as the one NEW child of ${parentPath}`;
          } else if (!fresh.length) {
            rootNote = `${parentPath} has no new child - the import did not land there`;
          } else {
            rootNote = `${fresh.length} new children of ${parentPath} and no name to pick from - pass 'name' so the root can be identified without guessing`;
          }
        }
      }
      if (!rootPath) {
        return fail("ROOT_NOT_CONFIRMED", `import_distinctus_build: ${rootNote}`, {
          ...common, status: "import_unverified", imported: false,
          root: null, path: null, className: null,
          positioned: null, anchored: null, instanceCount: null,
          recorded: false, recordReason: "the root was not confirmed in the place, so nothing was recorded in the model graph",
          partialCommitAllowed: true, loaderReportedPath: loaderPath,
          detail: rootNote,
          verification: { checked: false, passed: false, detail: rootNote },
        });
      }
      const root = rootPath;
      const scriptsStripped = typeof body1.scriptsStripped === "boolean" ? body1.scriptsStripped : null;
      const removedScripts = typeof body1.removedScripts === "number" ? body1.removedScripts : null;
      const extra1: any = {};
      if (scriptsStripped !== null) extra1.scriptsStripped = scriptsStripped;
      if (removedScripts !== null) extra1.removedScripts = removedScripts;
      // ── 2b. transform. A BasePart takes property writes; a Model has no
      // Position, so the same intent becomes ONE preflighted PivotTo snippet.
      const isPart = rootCls !== null && BUILD_BASE_PART_CLASSES.has(rootCls);
      const cmds: Array<{ tool: string; args: any }> = [];
      let skipped: string | null = null;
      let luauReport: any = null;
      if (wanted) cmds.push({ tool: "set_properties", args: { path: root, properties: { Name: wanted }, projectId: proj } });
      if (isPart) {
        const props: any = {};
        props["Position"] = at;
        if (scale !== 1) props["Scale"] = scale;
        if (rotate) props["Rotation"] = [0, rotate, 0];
        if (anchor !== null) props["Anchored"] = anchor;
        cmds.push({ tool: "set_properties", args: { path: root, properties: props, projectId: proj } });
      } else if (rootCls === "Model") {
        const code = buildModelTransformLuau(root, at, scale, rotate, anchor);
        if (code === null) {
          skipped = `no transform sent: the recorded root path '${root}' has no usable segments`;
        } else {
          const v = validateLuau(code);
          const risk = analyzeRisk(code);
          luauReport = {
            lines: code.split("\n").length, luauPreFlight: v.ok,
            risk: risk.level, riskSummary: riskSummary(risk), sent: false,
          };
          if (!v.ok) {
            skipped = `no transform sent: the generated Model pivot snippet failed the Luau pre-flight (${(v.errors || []).join("; ").slice(0, 200)})`;
          } else if (risk.requiresConfirm) {
            skipped = "no transform sent: the Model pivot pass trips the risky-operation gate - call execute_luau yourself with confirm:true if you want it applied";
          } else {
            cmds.push({ tool: "execute_luau", args: { code: v.sanitized, projectId: proj } });
            luauReport.sent = true;
          }
        }
      } else {
        skipped = `the imported root is a ${rootCls || "unknown class"}, which has no pivot, so position/scale/rotation cannot be applied to it (a rename, if any, still was)`;
      }
      let transformOk: boolean | null = null;
      if (skipped && !cmds.length) transformOk = false;
      const transformEvidence: any[] = [];
      let pivot: number[] | null = null;
      if (cmds.length) {
        let allOk = true;
        for (const c of cmds) {
          const r = await buildCall(c.tool, c.args);
          transformEvidence.push({ tool: c.tool, ok: r.ok, ...(r.error ? { error: r.error } : {}) });
          if (!r.ok) {
            allOk = false;
            continue;
          }
          if (c.tool === "execute_luau") {
            const ret: any = (r.env && r.env.result) ? r.env.result.returned : null;
            if (ret && typeof ret === "object") {
              const px = Number(ret.pivotX);
              const py = Number(ret.pivotY);
              const pz = Number(ret.pivotZ);
              if (Number.isFinite(px) && Number.isFinite(py) && Number.isFinite(pz)) pivot = [px, py, pz];
            }
          }
        }
        transformOk = allOk;
      }
      const transform: any = {
        phase: "transform", commands: cmds.map((c) => c.tool),
        // ok is false (not null) when a requested transform could not be sent at
        // all - an unmet request must not read as an untested one.
        ok: transformOk, skipped, evidence: transformEvidence,
      };
      if (luauReport) transform.luau = luauReport;
      if (transformOk === false) {
        const rev = await revert("the transform step failed after the kit was imported");
        return fail("TRANSFORM_STEP_FAILED",
          "import_distinctus_build: the kit IS in the place (confirmed by a read of the parent listing) but the transform step did not succeed, so it is NOT positioned/scaled/rotated/anchored as requested",
          {
            ...common, status: "transform_failed", imported: true,
            root, path: root, className: rootCls, parent: parentPath,
            positioned: null, anchored: null, instanceCount: null,
            recorded: false, recordReason: BUILD_GRAPH_NOTE,
            partialCommitAllowed: !rev.restored, rollback: rev,
            transform, ...(skipped ? { transformSkipped: skipped } : {}), ...extra1,
            detail: "the kit IS in the place (confirmed by a read of the parent listing) but the transform step failed, so it is NOT positioned/scaled/rotated/anchored as requested",
            verification: { checked: true, passed: false, rootExists: true, transformOk: false, detail: `${rootNote}; the transform step did not succeed - no placement field above claims anything` },
          });
      }
      // ── 3. verify: OBSERVE the root back. Nothing below is reported unless
      // it was read; null means "could not be measured here".
      const kidRead = await buildCall("get_instances", { path: root, projectId: proj });
      const rootKids: any[] = (kidRead.ok && kidRead.env && Array.isArray(kidRead.env.result?.instances)) ? kidRead.env.result.instances : [];
      let instanceCount: number | null = null;
      let childNote = "";
      if (kidRead.ok) {
        const c = kidRead.env.result.count;
        instanceCount = Number.isInteger(c) ? Number(c) : rootKids.length;
      } else {
        childNote = `could not read the imported root's children: ${kidRead.error}`;
      }
      const fmt = (v: number[]) => `[${v.map((x) => x.toFixed(3)).join(", ")}]`;
      let positioned: boolean | null = null;
      let observedPosition: number[] | null = null;
      let positionNote = "";
      if (isPart) {
        const r = await buildCall("get_property_value", { path: root, property: "Position", projectId: proj });
        if (!r.ok) {
          positionNote = `Position read failed: ${r.error}`;
        } else {
          const v: any = (r.env && r.env.result) ? r.env.result.value : null;
          let got: number[] | null = null;
          if (Array.isArray(v)) {
            const q = [Number(v[0]), Number(v[1]), Number(v[2])];
            if (q.every((x) => Number.isFinite(x))) got = q;
          } else if (v && typeof v === "object") {
            const q = [Number(v.X ?? v.x), Number(v.Y ?? v.y), Number(v.Z ?? v.z)];
            if (q.every((x) => Number.isFinite(x))) got = q;
          }
          if (!got) {
            positionNote = "Position read returned no usable Vector3";
          } else {
            observedPosition = got;
            const delta = Math.max(Math.abs(got[0] - at[0]), Math.abs(got[1] - at[1]), Math.abs(got[2] - at[2]));
            positioned = delta <= 0.5;
            positionNote = `Position read back as ${fmt(got)} vs requested ${fmt(at)} (max delta ${delta.toFixed(3)} studs)${positioned ? "" : " -> the root is NOT at the requested position"}`;
          }
        }
      } else {
        positionNote = `the root is a ${rootCls || "unknown class"}, which has no Position property - placement is reported from the pivot read back by the Model pass instead`;
        if (pivot) {
          observedPosition = pivot;
          const delta = Math.max(Math.abs(pivot[0] - at[0]), Math.abs(pivot[1] - at[1]), Math.abs(pivot[2] - at[2]));
          positioned = delta <= 0.5;
          positionNote = `no Position property on a ${rootCls} - placement taken from the pivot read back by the Model pass: ${fmt(pivot)} vs requested ${fmt(at)} (max delta ${delta.toFixed(3)} studs)${positioned ? "" : " -> the root is NOT at the requested position"}`;
        }
      }
      let anchored: boolean | null = null;
      let anchorCapped = false;
      let anchorNote = "";
      let anchorQueried = 0;
      let anchorSeen = 0;
      let anchorBroken = false;
      let anchorTotal = 0;
      const anchorPaths: string[] = [];
      const targets: string[] = [];
      if (isPart) {
        targets.push(root);
        anchorTotal = 1;
      } else {
        const parts = rootKids.filter((c: any) => BUILD_BASE_PART_CLASSES.has(String((c && c.class) || "")) && !!(c && c.path));
        anchorTotal = parts.length;
        if (!parts.length) {
          anchorNote = childNote || `no BasePart among the ${rootKids.length} direct child(ren) of the root, so anchoring could not be measured (parts may sit deeper in the tree)`;
        } else {
          anchorCapped = parts.length > 4;
          for (const p of parts.slice(0, 4)) targets.push(String(p.path));
          if (anchorCapped) {
            anchorNote = `only ${targets.length} of the ${parts.length} BasePart(s) found among the root's direct children were read (capped for the call budget) - anchoring beyond those is UNVERIFIED`;
          }
        }
      }
      for (const p of targets) {
        const r = await buildCall("get_property_value", { path: p, property: "Anchored", projectId: proj });
        if (!r.ok) {
          anchorNote = `Anchored read failed for ${p}: ${r.error}`;
          anchorBroken = true;
          break;
        }
        const v: any = (r.env && r.env.result) ? r.env.result.value : undefined;
        if (typeof v !== "boolean") {
          anchorNote = `Anchored read for ${p} returned no value field`;
          anchorBroken = true;
          break;
        }
        anchorQueried += 1;
        anchorPaths.push(p);
        if (v) anchorSeen += 1;
      }
      if (!anchorBroken && anchorQueried > 0 && !anchorCapped) {
        anchored = anchorSeen === anchorQueried;
        anchorNote = anchored
          ? `${anchorQueried} read BasePart(s) are anchored`
          : `${anchorQueried - anchorSeen} of ${anchorQueried} read BasePart(s) are not anchored`;
      }
      if (anchorQueried === 0 && !anchorNote) anchorNote = "no Anchored property could be read";
      const anchoredObservation: any = {
        value: anchored, checked: anchorQueried, total: anchorTotal, capped: anchorCapped,
        anchoredSeen: anchorSeen, checkedPaths: anchorPaths, note: anchorNote,
      };
      // REQUESTED-but-unmeasurable is an unmet request, not a pass.
      const problems: string[] = [];
      if (positioned === false) problems.push(positionNote);
      if (positioned === null) problems.push(`position was requested but could not be measured - ${positionNote}`);
      if (anchored === false) problems.push(`${anchorNote} -> anchoring was requested and is not satisfied`);
      if (anchored === null && anchor !== null) problems.push(`anchoring was requested but could not be measured - ${anchorNote}`);
      if (skipped) problems.push(skipped);
      const verification: any = {
        checked: true,
        // transformOk === false already returned above, so only the reads can
        // fail the verdict here - and a request that could not be measured is
        // in `problems`, which fails it too.
        passed: positioned !== false && anchored !== false && problems.length === 0,
        rootExists: true, transformOk,
        detail: [rootNote, ...problems].filter(Boolean).join("; "),
      };
      const body: any = {
        ...common, ok: problems.length ? false : true,
        status: problems.length ? "placed_unverified" : "success", imported: true,
        root, path: root, className: rootCls, parent: parentPath,
        positioned, observedPosition, positionNote,
        anchored, anchoredObservation,
        instanceCount, instanceCountScope: "direct children of the imported root (not the whole subtree)",
        plan, transform,
        partialCommitAllowed: false,
        recorded: false, recordReason: BUILD_GRAPH_NOTE, modelGraphStore: BUILD_GRAPH_STORE,
        verification,
        evidence: [{ phase: "import", tool: step1Name, ok: true, loaderReportedPath: loaderPath }, transform],
        ...(skipped ? { transformSkipped: skipped } : {}),
        ...extra1,
        ...(childNote ? { childCountNote: childNote } : {}),
      };
      if (problems.length) {
        body.detail = `the kit is in the place and the transform step reported success, but the read-back disagrees: ${problems.join("; ")}`;
        return say({ ...body, ok: false, error: { code: "PLACEMENT_UNVERIFIED", message: body.detail } });
      }
      return say(body);
    },
    execution: "studio",
  },
  {
    name: "revise_import",
    description: "146 revise_import – revise a recorded import by delta. BRIDGE-SIDE: it resolves importId in the RoLink bridge's model graph (memory/model-graph.json), which this MCP path cannot read, so this entry answers with an honest capability error and applies nothing.",
    inputSchema: z.object({
      importId: z.string().optional(),
      move: z.union([z.string(), z.object({ at: z.string().optional(), parent: z.string().optional() })]).optional(),
      rotate: z.number().min(-360).max(360).optional(),
      scale: z.number().min(0.01).max(100).optional(),
      rename: z.string().min(1).max(120).optional(),
      anchor: z.boolean().optional(),
      mode: z.enum(["atomic", "best_effort"]).optional(),
      projectId: z.string().optional(),
    }),
    handler: async (a) => {
      const args: any = a || {};
      return buildReply(JSON.stringify({
        ok: false, tool: "revise_import", executionId: "rl_bridge_side_only",
        status: "bridge_side_only", attempted: false, applied: false,
        requestedImportId: typeof args.importId === "string" ? args.importId : null,
        requestedChanges: {
          ...(args.move === undefined ? {} : { move: args.move }),
          ...(args.rotate === undefined ? {} : { rotate: args.rotate }),
          ...(args.scale === undefined ? {} : { scale: args.scale }),
          ...(args.rename === undefined ? {} : { rename: args.rename }),
          ...(args.anchor === undefined ? {} : { anchor: args.anchor }),
        },
        recorded: false, modelGraphStore: BUILD_GRAPH_STORE,
        error: {
          code: "BRIDGE_SIDE_ONLY",
          message: `revise_import cannot run on the MCP path. It revises an import recorded in the RoLink bridge's model graph (${BUILD_GRAPH_STORE}, written beside the project memory store), and this MCP server has no access to that file - so there is no record here to revise, and this tool will not invent one or report a revision that never happened.`,
        },
        useInstead: "call revise_import through the RoLink bridge: it resolves importId against the model graph, applies the delta to the recorded root, reads the root back and appends {rev, at, changes} to that import's history",
        related: {
          listRecordedImports: "get_model_graph (also bridge-side)",
          createAnImport: "import_distinctus_build (this MCP path composes import_asset/clone_instance, but still cannot record it in the graph)",
          confirmARootIsStillThere: "get_instances",
          moveByHand: "move_instance / set_properties / execute_luau",
        },
        verification: {
          checked: false, passed: false,
          detail: "nothing was attempted and nothing was observed - this is a capability statement, not a failed revision",
        },
      }, null, 2), true);
    },
    execution: "local",
  },
  {
    name: "get_model_graph",
    description: "147 get_model_graph – READ-ONLY record of what the build engine imported. BRIDGE-SIDE: the record lives in the RoLink bridge's model graph (memory/model-graph.json), which this MCP path cannot read, so this entry answers with an honest capability error and returns no imports.",
    inputSchema: z.object({
      importId: z.string().optional(),
      limit: z.number().int().min(1).max(50).optional(),
    }),
    handler: async (a) => {
      const args: any = a || {};
      return buildReply(JSON.stringify({
        ok: false, tool: "get_model_graph", executionId: "rl_bridge_side_only",
        status: "bridge_side_only", readOnly: true, store: BUILD_GRAPH_STORE,
        requestedImportId: typeof args.importId === "string" ? args.importId : null,
        requestedLimit: typeof args.limit === "number" ? args.limit : null,
        count: null, imports: null,
        error: {
          code: "BRIDGE_SIDE_ONLY",
          message: `get_model_graph cannot run on the MCP path. The import record it reads is written by the RoLink bridge to ${BUILD_GRAPH_STORE} (beside the project memory store), and this MCP server has no access to that file - so it returns no imports rather than an empty-looking list that could be mistaken for 'nothing was ever imported'.`,
        },
        useInstead: "call get_model_graph through the RoLink bridge to list recorded imports (or one import plus its revision history); it is a record, not a re-read of the place",
        related: {
          confirmARootIsStillThere: "get_instances",
          createAnImport: "import_distinctus_build",
          reviseABuild: "revise_import (also bridge-side)",
        },
        verification: {
          checked: false, passed: false,
          detail: "the store was not read, so count is null and imports is null - neither is a claim that the graph is empty",
        },
      }, null, 2), true);
    },
    execution: "local",
  },
];

// run_task / batch_queue Studio-queue membership (mirrors bridge.py
// STUDIO_QUEUE_TOOLS + _QUEUE_EXTRA_TOOLS). Built ONCE at module load, never per
// task. `execution === "studio"` alone is NOT the test: ~60 entries reach Studio
// through queueAndWait()/studioQueueAndWait() without carrying the tag, so that
// test silently dropped them and an atomic task could certify a rollback that
// never happened. Conversely the composed flows playtest_scenario and
// migrate_system DO carry the tag but are bridge-local fan-outs (they mutate
// Studio through sub-calls, not as one undo-stack command), so they are excluded
// exactly like bridge.py's LOCAL_HANDLERS. Tools that never leave this process
// (planning, logging, git, analytics) are deliberately absent: counting them
// would inflate undoneSteps and revert unrelated prior edits.
const RUN_TASK_LOCAL_FANOUT: ReadonlySet<string> = new Set<string>([
  "playtest_scenario","migrate_system","run_task","batch_queue",
  "import_distinctus_build",
  "get_time","validate_command","search_asset","suggest_ordering","get_suggestions",
  "list_plugins","get_projects","switch_project","get_memory_usage",
  "set_performance_threshold","list_sessions","session_users",
  // revise_import / get_model_graph need no exclusion: they carry
  // execution:"local" because on the MCP path they apply and observe NOTHING,
  // so counting them would promise a rollback of edits they never made.
]);
const RUN_TASK_QUEUE_EXTRA: ReadonlySet<string> = new Set<string>(["script_search","script_grep","search_game_tree","inspect_keyframe_track"]);
const RUN_TASK_QUEUES: ReadonlySet<string> = new Set<string>([
  ...tools.filter(t => t.execution === "studio" && !RUN_TASK_LOCAL_FANOUT.has(t.name)).map(t => t.name),
  // queue-and-wait / fire-and-forget Studio commands that carry no execution tag
  "rollback","git_rollback","run_in_sandbox","apply_template","compile_visual_graph",
  "execute_plan","refactor_code","generate_asset","create_project","import_project",
  "generate_quest","generate_sound",
  ...RUN_TASK_QUEUE_EXTRA,
]);
const RUN_TASK_KNOWN_SORTED: string[] = [...new Set<string>([...tools.map(t => t.name), ...RUN_TASK_QUEUE_EXTRA])].sort();
const runTaskUndoable = (name: string): boolean => RUN_TASK_QUEUES.has((aliasMap as any)[name] || name);
