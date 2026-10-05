import express from "express";
import cors from "cors";
import { commandQueue } from "./commandQueue.js";
import { tools, aliasMap } from "./tools/registry.js";
import { toolPrompts, getToolPrompt } from "./tools/toolPrompts.js";
import { PROTOCOL_VERSION } from "../../shared/protocol.js";
import { rollbackManager } from "./rollback.js";
import { perfTracker } from "./perfTracker.js";
import { healCode, shouldAutoHeal } from "./selfHeal.js";
import { teamLog } from "./teamLog.js";
import { commandQueue as cq } from "./commandQueue.js";
import { validateLuau } from "./sandbox.js";
import { planFromPrompt } from "./planning.js";
import { reviewLuau, refactoringPlan } from "./codeReview.js";
import { templateStore } from "./templates.js";
import { buildContext } from "./contextInjection.js";
import { aiTraining } from "./aiTraining.js";
import { collabManager } from "./collab.js";
import { searchAssets, importInstruction, assetCategory, isValidAssetImportResult } from "./assetStore.js";
import { gameplayFeedback } from "./gameplayFeedback.js";
import { generateGDD } from "./gdd.js";
import { generateAsset, generateVariants } from "./assetGen.js";
import { autoOptimize } from "./perfOptLoop.js";
import { analyticsEngine } from "./analytics.js";
import { compileGraph, graphFromPrompt } from "./visualCompiler.js";

const PORT = Number(process.env.MCP_PORT ?? 3001);
const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const startTime = Date.now();

let explainer: any = null;
let ddaEngine: any = null;
let soundGen: any = null;
async function loadOptional() {
  try { explainer = await import("./explainer.js"); } catch {}
  try { ddaEngine = await import("./ddaEngine.js"); } catch {}
  try { soundGen = await import("./soundGenerator.js"); } catch {}
}
loadOptional();

app.get("/health", (_req, res) => {
  res.json({ ok: true, version: PROTOCOL_VERSION, uptime: Math.floor((Date.now() - startTime) / 1000), queueDepth: commandQueue.status().depth, tools: tools.length });
});

app.post("/queue/enqueue", (req, res) => {
  const { tool, command, args, priority, timeoutMs, projectId } = req.body ?? {};
  if (!tool || !command) return res.status(400).json({ error: "tool and command required" });
  if (tool === "run_code" && typeof command === "string") {
    const v = validateLuau(command);
    if (!v.ok) return res.status(400).json({ ok:false, error:"sandbox blocked", details:v.errors });
  }
  try {
    const cmd = commandQueue.enqueue({ tool, command, args, priority, timeoutMs, projectId });
    teamLog.append("info", projectId || "default", "mcp", `enqueue ${tool}`, { id: cmd.id });
    rollbackManager.push({ id: cmd.id, projectId: projectId || "default", timestamp: Date.now(), tool, command: String(command).slice(0,5000) });
    collabManager.broadcast(projectId || "default", "enqueue", { tool, id: cmd.id }, "mcp");
    console.log(`[enqueue] ${tool} id=${cmd.id} prio=${priority}`);
    res.json({ ok: true, id: cmd.id, queued: cmd });
  } catch (e: any) { res.status(503).json({ ok: false, error: e.message }); }
});

app.get("/queue/next", (req, res) => {
  const projectId = req.query.projectId as string | undefined;
  const cmd = commandQueue.next(projectId);
  if (!cmd) return res.json({ ok: true, command: null });
  teamLog.append("info", (cmd.projectId || "default"), "plugin", "claimed", { id: cmd.id, tool: cmd.tool });
  res.json({ ok: true, command: cmd });
});

app.post("/queue/result", (req, res) => {
  const { id, result, error, timings, snapshot } = req.body ?? {};
  if (!id) return res.status(400).json({ error: "id required" });
  const cmd = commandQueue.complete(id, result, error);
  if (!cmd) return res.status(404).json({ error: "not found" });
  const elapsed = timings?.elapsed ? Math.round(Number(timings.elapsed)*1000) : 0;
  const success = !error;
  perfTracker.record({ id, tool: cmd.tool, elapsedMs: elapsed || 0, timestamp: Date.now(), projectId: cmd.projectId || "default", success });
  teamLog.append(success ? "info" : "error", cmd.projectId || "default", "plugin", success ? `done ${cmd.tool}` : `failed ${cmd.tool}`, { id, error, elapsedMs: elapsed });
  collabManager.broadcast(cmd.projectId || "default", "result", { id, success, tool: cmd.tool }, "plugin");
  if (timings) console.log(`[result] ${id} tool=${cmd.tool} elapsed=${elapsed}ms success=${success}`);
  if (snapshot) console.log(`[snapshot] ${id} len=${JSON.stringify(snapshot).length}`);
  if (error) console.warn(`[error] ${id}: ${String(error).slice(0,400)}`);
  let healed: any = null;
  if (error && shouldAutoHeal(String(error))) {
    const hr = healCode(cmd.command, String(error));
    if (hr.healed && hr.fixed) {
      const newCmd = commandQueue.enqueue({ tool: cmd.tool, command: hr.fixed, args: { ...cmd.args, healedFrom: id }, priority: 9, projectId: cmd.projectId, meta: cmd.meta });
      teamLog.append("info", cmd.projectId || "default", "heal", `auto-healed ${id} -> ${newCmd.id}`, hr);
      healed = { healed:true, newId: newCmd.id, reason: hr.reason };
      console.log(`[heal] ${id} -> ${newCmd.id} reason=${hr.reason}`);
    }
  }
  res.json({ ok: true, updated: cmd, perf: { elapsedMs: elapsed, success }, healed });
});

app.get("/queue/status", (req, res) => { const projectId = req.query.projectId as string | undefined; res.json({ ok: true, ...commandQueue.status(projectId) }); });
app.get("/queue/wait/:id", async (req, res) => {
  const timeout = Number(req.query.timeout ?? 15000);
  try { const result = await commandQueue.waitForResult(req.params.id, timeout); res.json({ ok: true, result }); } catch (e: any) { res.status(504).json({ ok: false, error: e.message }); }
});
app.get("/logs", (req, res) => { const projectId = req.query.projectId as string | undefined; const limit = Number(req.query.limit ?? 50); const logs = teamLog.query({ projectId, limit }); res.json({ ok:true, logs }); });
app.get("/tools", (_req, res) => { res.json({ ok: true, tools: tools.map(t => ({ name: t.name, description: t.description, provider: (t as any).provider||"rolink", execution: (t as any).execution||"local", hasPrompt: t.name in toolPrompts })), aliases: aliasMap, total: tools.length, prompts: Object.keys(toolPrompts).length }); });
// Per-tool master prompts (lazy serving: extension fetches on demand, never bundled bulk).
app.get("/tools/prompts", (_req, res) => { res.json({ ok: true, count: Object.keys(toolPrompts).length, tools: Object.keys(toolPrompts) }); });
app.get("/tools/:name/prompt", (req, res) => {
  const p = getToolPrompt(req.params.name);
  if (!p) return res.status(404).json({ ok: false, error: `no master prompt for: ${req.params.name}` });
  res.json({ ok: true, tool: req.params.name, prompt: p });
});
app.post("/tools/call", async (req, res) => {
  let { name, arguments: args } = req.body ?? {};
  let tool = tools.find(t => t.name === name);
  if (!tool && aliasMap[name]) {
    const canonical = aliasMap[name];
    tool = tools.find(t => t.name === canonical);
    if (tool) name = canonical;
  }
  if (!tool) return res.status(404).json({ error: `tool not found: ${name}`, aliases: Object.keys(aliasMap).slice(0,20) });
  try { const parsed = tool.inputSchema.parse(args ?? {}); const out = await tool.handler(parsed); res.json({ ok: true, tool: name, ...out }); } catch (e: any) { res.status(400).json({ ok: false, error: e.message, isError: true }); }
});

// Phase B direct
app.post("/plan", (req,res)=> { const p = planFromPrompt(req.body?.prompt || ""); teamLog.append("info", req.body?.projectId||"default", "ai", "plan", { prompt: req.body?.prompt, steps: p.steps.length }); res.json({ ok:true, plan: p }); });
app.post("/review", (req,res)=> { const r = reviewLuau(req.body?.code || ""); const plan = refactoringPlan(req.body?.code || ""); res.json({ ok:true, ...r, refactoringPlan: plan }); });
app.get("/templates", (req,res)=>{ const cat = req.query.category as string|undefined; res.json({ ok:true, templates: templateStore.list(cat) }); });
app.post("/templates/use", (req,res)=>{ const t = templateStore.get(req.body?.id); if (!t) return res.status(404).json({ ok:false, error:"not found" }); if (t.code) cq.enqueue({ tool:"run_code", command:t.code, args:{ templateId:t.id } }); for (const i of t.instances||[]) cq.enqueue({ tool:"create_instance", command:`Instance.new("${i.className}")`, args:i as any }); res.json({ ok:true, template:t }); });
app.get("/context", (req,res)=>{ const ctx = buildContext({ projectId: req.query.projectId as string || "default", snapshot: req.query.snapshot as string || "" }); res.json({ ok:true, context: ctx }); });
app.get("/style", (req,res)=>{ const p = aiTraining.profile(req.query.projectId as string || "default"); res.json({ ok:true, profile:p }); });
app.get("/perf", (req,res)=>{ const pid = req.query.projectId as string|undefined; res.json({ ok:true, stats: perfTracker.stats(pid), recent: perfTracker.recent(20, pid) }); });
app.get("/rollback", (req,res)=>{ const pid = req.query.projectId as string || "default"; res.json({ ok:true, history: rollbackManager.list(pid, Number(req.query.limit||20)) }); });
app.post("/rollback", (req,res)=>{ const pid = req.body?.projectId || "default"; const steps = Number(req.body?.steps || 1); const entries = rollbackManager.rollback(pid, steps); if (entries.length) cq.enqueue({ tool:"undo", command:"--rollback", args:{ steps: entries.length, projectId: pid } }); res.json({ ok:true, rolledBack: entries }); });

// Phase C
app.post("/visual/compile", (req,res)=>{ const r=compileGraph(req.body?.graph); if(!r.warnings.length) cq.enqueue({ tool:"run_code", command:r.luau, args:{ visual:true, projectId: req.body?.projectId||"default" }}); res.json({ ok:true, ...r }); });
app.post("/visual/from-prompt", (req,res)=>{ const g=graphFromPrompt(req.body?.prompt||""); const c=compileGraph(g); res.json({ ok:true, graph:g, compiled:c }); });
app.get("/collab/list", (req,res)=> res.json({ ok:true, clients: collabManager.list(req.query.projectId as string||"default"), count: collabManager.count(req.query.projectId as string||"default") }));
app.post("/collab/join", (req,res)=>{ const c=collabManager.join(req.body?.projectId||"default", req.body?.clientId, req.body?.role||"ai"); res.json({ ok:true, client:c }); });
app.post("/collab/broadcast", (req,res)=>{ const b=collabManager.broadcast(req.body?.projectId||"default", req.body?.event||"msg", req.body?.data, req.body?.from||"ai"); res.json({ ok:true, broadcast:b }); });
app.get("/collab/history", (req,res)=> res.json({ ok:true, history: collabManager.recent(req.query.projectId as string||"default", Number(req.query.limit||20)) }));
app.get("/assets/search", async (req,res)=>{
  const kw=String(req.query.keyword ?? req.query.q ?? "").trim();
  if(!kw || kw.length > 64) return res.status(400).json({ ok:false, error:"asset_search_invalid: keyword must be 1-64 characters (e.g. ?keyword=medieval+sword)" });
  const lim=Number(req.query.limit ?? 8);
  const cat=req.query.category as string|undefined;
  try{ const r=await searchAssets(kw, lim, cat); res.json({ ok:true, keyword:kw, category:assetCategory(cat), count:r.length, assets:r, source:"roblox-catalog", ...(r.length ? {} : { note:"no matches" }) }); }
  catch(e:any){ const msg=String(e?.message||e); const invalid=msg.startsWith("asset_search_invalid"); res.status(invalid ? 400 : 503).json({ ok:false, error:msg, errorCode:invalid ? "ASSET_SEARCH_INVALID" : "ASSET_SEARCH_UNAVAILABLE", assets:[] }); }
});
app.post("/assets/import", async (req,res)=>{
  try {
    const assetId = Number(req.body?.assetId);
    const parent = req.body?.parent || "workspace";
    // Keep validation in one place; execution still goes through the real
    // plugin import_asset branch, not a fire-and-forget run_code queue item.
    importInstruction(assetId, parent);
    const projectId = req.body?.projectId || "default";
    const timeoutMs = 45000;
    const cmd = commandQueue.enqueue({
      tool: "import_asset", command: "--import", timeoutMs, projectId,
      args: { assetId, assetName:req.body?.assetName, assetType:req.body?.assetType, parent, projectId },
    });
    const result = await commandQueue.waitForResult(cmd.id, timeoutMs);
    if (!isValidAssetImportResult(result)) {
      return res.status(502).json({ ok:false, tool:"import_asset", error:"Studio did not return a verified inserted path", result });
    }
    res.json({ ok:true, tool:"import_asset", executionId:cmd.id, status:"success", result, verification:{checked:true} });
  } catch(e:any) {
    const msg = String(e?.message || e);
    const timeout = /timeout/i.test(msg);
    res.status(timeout ? 504 : 400).json({ ok:false, tool:"import_asset", error:msg, errorCode:timeout ? "TIMEOUT" : "ASSET_IMPORT_INVALID" });
  }
});
app.post("/metrics", (req,res)=>{ const m=gameplayFeedback.ingest({ projectId: req.body?.projectId||"default", timestamp: Date.now(), deathsPerMinute: req.body?.deathsPerMinute, avgFPS: req.body?.avgFPS, killDeathRatio: req.body?.killDeathRatio, completionTimeSec: req.body?.completionTimeSec, coinsPerMin: req.body?.coinsPerMin, activePlayers: req.body?.activePlayers }); res.json({ ok:true, ...m }); });
app.get("/metrics", (req,res)=> res.json({ ok:true, recent: gameplayFeedback.recent(req.query.projectId as string||"default", Number(req.query.limit||20)) }));
app.post("/gdd", (req,res)=>{ const g=generateGDD(req.body?.prompt||""); teamLog.append("info", req.body?.projectId||"default","ai","gdd",{ title:g.title, genre:g.genre }); res.json({ ok:true, gdd:g }); });
app.post("/asset/gen", async (req,res)=>{ const r=await generateAsset(req.body?.prompt||"crate", req.body?.kind||"model"); if(r.ok) cq.enqueue({ tool:"run_code", command:r.code, args:{ prompt: req.body?.prompt, projectId: req.body?.projectId||"default" }}); res.json({ ok:true, asset:r }); });
app.post("/asset/gen-pack", async (req,res)=>{ const r=await generateVariants(req.body?.prompt||"crate", Number(req.body?.count||3), req.body?.kind||"model"); res.json({ ok:true, variants:r }); });
app.post("/perf/optimize", (req,res)=>{ const r=autoOptimize(req.body?.snapshot, req.body?.projectId||"default"); res.json({ ok:true, optimization:r }); });
app.get("/analytics/report", (req,res)=> res.json({ ok:true, report: analyticsEngine.report(req.query.projectId as string||"default") }));
app.get("/analytics/suggestions", (req,res)=> res.json({ ok:true, suggestions: analyticsEngine.suggest(req.query.projectId as string||"default") }));

// Stubs Phase E
app.post("/explain_code", async (req, res) => {
  if (explainer?.explain_code) { const out = await explainer.explain_code(req.body?.scriptPath ?? "unknown"); return res.json({ ok: true, explanation: out }); }
  res.json({ ok: true, note: "explainer not yet implemented (Phase E)", mock: { overview: "This script handles player health.", flow: "graph TD; A-->B" } });
});
app.post("/dda/:action", async (req, res) => {
  if (ddaEngine) { if (req.params.action === "adjust") return res.json({ ok: true, result: await ddaEngine.adjust_difficulty() }); if (req.params.action === "profile") return res.json({ ok: true, result: await ddaEngine.set_difficulty_profile(req.body?.profile) }); }
  res.json({ ok: true, note: "DDA not yet implemented (Phase E)", profile: req.body?.profile ?? "adaptive" });
});
app.post("/sound/:action", async (req, res) => {
  if (soundGen) { if (req.params.action === "generate") return res.json({ ok: true, result: await soundGen.generate_sound(req.body?.prompt, req.body?.type) }); if (req.params.action === "pack") return res.json({ ok: true, result: await soundGen.generate_sound_pack(req.body?.prompt, req.body?.count) }); }
  res.json({ ok: true, note: "soundGenerator not yet implemented (Phase E)", prompt: req.body?.prompt });
});

app.listen(PORT, "127.0.0.1", () => { console.log(`[mcp-server] listening on http://127.0.0.1:${PORT} (v${PROTOCOL_VERSION}) tools=${tools.length}`); });
setInterval(async () => { if (ddaEngine?.shouldAutoAdjust?.()) { try { await ddaEngine.adjust_difficulty(); } catch (e) { console.error("[dda] auto adjust failed", e); } } }, 5 * 60 * 1000).unref?.();
if (process.argv.includes("--stdio")) { console.error("[mcp] stdio mode not yet wired, HTTP mode active"); }
