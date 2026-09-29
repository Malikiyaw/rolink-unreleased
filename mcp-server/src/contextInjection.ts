/**
 * S8 Context Injection — builds AI prompt context from snapshot, recent logs, active scripts, and templates
 */
import { teamLog } from "./teamLog.js";
import { commandQueue } from "./commandQueue.js";

export interface ContextPack {
  systemPrompt: string;
  snapshotPreview: string;
  recentCommands: unknown[];
  recentLogs: unknown[];
  templatesHint: string;
  tokensEstimate: number;
}

export function buildContext(opts: { projectId?: string; snapshot?: string; limit?:number }): ContextPack {
  const projectId = opts.projectId || "default";
  const logs = teamLog.query({ projectId, limit: opts.limit ?? 8 });
  const queue = commandQueue.status(projectId);
  const snap = (opts.snapshot || "").slice(0, 3000) || "(no snapshot yet — run get_snapshot)";

  const systemPrompt = [
    "You are RoLink, an AI that controls Roblox Studio via MCP.",
    "Use ONLY allowed tools: create_instance, run_code, get_snapshot, set_property, undo, explain_code, etc.",
    "Always check get_snapshot before creating instances.",
    "Wrap changes with ChangeHistoryService waypoint (plugin does this).",
    "Be concise, produce Luau that passes sandbox validation.",
    `Project: ${projectId}`,
  ].join(" ");

  return {
    systemPrompt,
    snapshotPreview: snap,
    recentCommands: queue.items.slice(0, 5),
    recentLogs: logs,
    templatesHint: "Available templates: obby, leaderboard, shop — use get_templates + use_template",
    tokensEstimate: Math.ceil((systemPrompt.length + snap.length + JSON.stringify(queue.items).length) / 4),
  };
}

export function injectIntoPrompt(basePrompt: string, ctx: ContextPack): string {
  return `${ctx.systemPrompt}\n\n## Snapshot\n${ctx.snapshotPreview}\n\n## Recent queue\n${JSON.stringify(ctx.recentCommands,null,2)}\n\n## Logs\n${JSON.stringify(ctx.recentLogs,null,2)}\n\n## User request\n${basePrompt}`;
}
