/**
 * RoLink Wire Protocol v2 — shared between extension, bridge, MCP, plugin
 * Snake_case WireMethod, id-correlated JSON frames
 *
 * v2 adds the ExecutionEnvelope: every Studio tool MUST resolve to a
 * terminal envelope (success/error/timeout), never a bare {queued:true}.
 * queued/claimed/running are lifecycle signals only; the AI may only treat
 * status==="success"|"verified" as done.
 */
export const PROTOCOL_VERSION = 2;

export type Role = "extension" | "plugin" | "mcp";

export type WireMethod =
  | "hello"
  | "enqueue_command"
  | "poll_next"
  | "command_result"
  | "heartbeat"
  | "error"
  | "call_tool"
  | "tool_result"
  | "tool_event"
  | "list_tools"
  | "studio_status";

export interface WireFrame {
  v: number; // protocol version
  id: string; // uuid correlation
  method: WireMethod;
  role?: Role;
  token?: string;
  payload?: unknown;
  ts?: number;
}

export interface ToolEventMeta {
  eventId?: string; // queue command id (minted at enqueue)
  category?: ToolCategory; // HUD color/icon family
  sessionId?: string | null;
}

export interface EnqueuePayload {
  command: string; // Luau code or DSL
  tool: string; // e.g., "create_instance", "run_code"
  args?: Record<string, unknown>;
  priority?: number; // 0-10
  timeoutMs?: number;
  projectId?: string;
  meta?: ToolEventMeta; // P3: Studio HUD correlation (optional, server fills defaults)
}

export interface QueuedCommand extends EnqueuePayload {
  id: string;
  /** Execution id (rl_*) — identical to id, exposed to the AI as executionId. */
  executionId?: string;
  status: "queued" | "claimed" | "running" | "done" | "failed";
  attempts: number;
  createdAt: number;
  claimedAt?: number;
  startedAt?: number;
  endedAt?: number;
  result?: unknown;
  error?: string;
}

/** Terminal execution states the AI is allowed to trust. */
export type ExecutionStatus =
  | "success"
  | "error"
  | "timeout"
  | "confirm_required";

export type ErrorCode =
  | "VALIDATION"
  | "STUDIO_EXECUTION_FAILED"
  | "PLUGIN_OFFLINE"
  | "STUCK_EXECUTION"
  | "TIMEOUT"
  | "VERIFY_FAILED"
  | "TX_ROLLBACK"
  | "CONFIRM_REQUIRED"
  | "MCP_OFFLINE"
  | "STUDIO_OFFLINE";

/**
 * ExecutionEnvelope — the ONLY success signal the AI may trust.
 * Transport: JSON string inside MCP content[].text and inside bridge
 * tool_result {ok,text}. `text` remains the human/AI-readable payload;
 * the envelope fields are duplicated top-level on bridge frames for
 * cheap access (executionId, status, durationMs).
 */
export interface ExecutionEnvelope {
  ok: boolean;
  tool: string;
  executionId: string;
  status: ExecutionStatus | "success" | "error" | "timeout";
  durationMs: number;
  result?: unknown;
  verification?: { checked: boolean; passed?: boolean; detail?: string };
  preflight?: { syntax: string; risk: string; notes?: string[] };
  error?: { code: ErrorCode | string; message: string };
}

export function makeExecutionEnvelope(
  tool: string,
  executionId: string,
  status: ExecutionEnvelope["status"],
  durationMs: number,
  result?: unknown,
  error?: ExecutionEnvelope["error"],
): ExecutionEnvelope {
  return {
    ok: status === "success",
    tool,
    executionId,
    status,
    durationMs,
    ...(result !== undefined ? { result } : {}),
    verification: { checked: false },
    ...(error ? { error } : {}),
  };
}

export interface HealthResponse {
  ok: boolean;
  version: number;
  uptime: number;
  queueDepth: number;
  wsClients: number;
}

export function makeId(): string {
  return `rl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

export type BridgeState =
  | "BRIDGE_OFFLINE"
  | "MCP_OFFLINE"
  | "STUDIO_OFFLINE"
  | "STUDIO_NO_PLACE"
  | "STUDIO_READY";

export interface CallToolFrame {
  type: "call_tool";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  timeout?: number;
  sessionId?: string;
  turnId?: string;
}

export interface ToolResultFrame {
  type: "tool_result";
  id: string;
  ok: boolean;
  kind?: string;
  text?: string;
  error?: string;
  images?: Array<{data:string,mimeType:string}>;
}

export function isValidFrame(o: unknown): o is WireFrame {
  if (!o || typeof o !== "object") return false;
  const f = o as WireFrame;
  return typeof f.v === "number" && typeof f.id === "string" && typeof f.method === "string";
}

export function makeExecutionId(): string {
  return `rl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,9)}`;
}

// Unified tool catalogue entry (provider abstraction for AI)
export interface UnifiedToolEntry {
  name: string;
  description: string;
  provider: "roblox" | "rolink";
  execution: "studio" | "local";
}

// ── P0 ToolEvent spine ──────────────────────────────────────────────
// Emitted by the extension (parser → queued, execution → running →
// terminal) and re-broadcast by bridge.py to all connected tabs.
// UI (SideDock / Timeline / Studio HUD) subscribes; the agent loop
// never blocks on it. Category reuses the extension's 8 toolCategory()
// values so prompts, registry and HUD stay in sync.
export type ToolStatus =
  | "queued"
  | "running"
  | "success"
  | "error"
  | "waiting"
  | "timeout"
  | "cancelled"
  | "stale";

export type ToolCategory =
  | "read"
  | "edit"
  | "inspect"
  | "generate"
  | "asset"
  | "visual"
  | "test"
  | "tool";

export interface ToolEvent {
  id: string;
  tool: string;
  category: ToolCategory;
  status: ToolStatus;
  args: Record<string, unknown>;
  result?: unknown;
  startTime: number;
  durationMs?: number;
  previewUrl?: string;
  codeDiff?: { before: string; after: string };
  sessionId?: string | null;
  turnId?: string | null;
}

export interface ToolEventFrame {
  type: "tool_event";
  id: string;
  event: ToolEvent;
}
