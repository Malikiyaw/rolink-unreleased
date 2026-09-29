import { makeId, type QueuedCommand, type EnqueuePayload, type ToolCategory } from "../../shared/protocol.js";

const MAX_QUEUE = 200;
const CLAIM_TIMEOUT_MS = 30000;

// P3: Studio HUD category mirror. Coarse port of
// rolink-extension/core/config.js toolCategory() — the extension sends the
// authoritative category with bus events; the plugin falls back to this
// mapping for queue-originated visuals. Keep the 8 canonical names.
export function categoryOfTool(name: string): ToolCategory {
  const n = (name || "").toLowerCase();
  if (/^(take_snapshot|get_snapshot|rollback|diff_snapshots|get_instances|find_instance|list_commands)$/.test(n)) return "inspect";
  if (/^(execute_luau|run_code|set_script_content|create_module|multi_edit|create_instance|set_properties|set_property|delete_instance|clone_instance|move_instance|run_function|add_event_handler|remove_event_handler|ensure_path|resolve_path|place_parts|create_model_from_table|set_terrain_region|set_ui_property|bind_ui_click|set_datastore_value|setup_datastore|create_project|import_project|switch_project|set_breakpoint|remove_breakpoint|apply_template|add_template|refactor_code|load_plugin|git_commit|git_rollback|adjust_difficulty|set_difficulty_profile|migrate_system)$/.test(n)) return "edit";
  if (/script_search|script_grep|search_game_tree|inspect_instance|get_script_content|get_context_summary|get_function_signatures|get_property_value|get_all_properties|search_by_attribute|get_referenced_instances|get_global_variables|get_dependency_graph|get_ui_tree|get_datastore_value|get_projects|get_suggestions|get_analytics|get_metrics|get_memory_usage|get_performance_stats|get_time|scan_errors|get_studio_state|get_memory|update_memory|list_templates|list_plugins|list_sessions|git_log|explain_code|validate_command|suggest_|search_scripts|get_instance_tree|list_roblox_studios|export_session_log|replay_session|compare_sessions|session_users|report_metrics|report_analytics|predict_bug|review_code|export_project/.test(n)) return "read";
  if (/generate_|compile_visual_graph/.test(n)) return "generate";
  if (/search_asset|import_asset|apply_material/.test(n)) return "asset";
  if (/create_ui|inspect_ui|screenshot_studio|create_animation_track|create_motion_animation|inspect_motion_animation|validate_motion_animation|preview_motion_animation|remove_motion_animation|create_motion_effect|inspect_motion_effect|remove_motion_effect|play_animation|analyze_animatable_model|create_model_animation|set_model_keyframe|set_model_easing|add_animation_marker|preview_model_animation|validate_model_animation|retime_animation|reverse_animation|mirror_animation|blend_animation|fix_animation|create_attack_animation|create_idle_animation|create_walk_cycle|set_track_lock|set_lighting|add_particle_emitter|play_sound|send_notification/.test(n)) return "visual";
  if (/run_tests|simulate|run_sandbox_tests|playtest|run_playtest|confirm_sandbox_apply|discard_sandbox|step_through|continue_execution|watch_variable|analyze_performance|set_performance_threshold|optimize_performance/.test(n)) return "test";
  return "tool";
}

class CommandQueue {
  private queue: QueuedCommand[] = [];
  private byId = new Map<string, QueuedCommand>();
  private pendingResults = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void; timer: NodeJS.Timeout }>();

  enqueue(payload: EnqueuePayload): QueuedCommand {
    if (this.queue.filter(c => c.status === "queued").length >= MAX_QUEUE) {
      throw new Error("503 queue full (max 200)");
    }
    const id = makeId();
    const cmd: QueuedCommand = {
      id,
      executionId: id,
      status: "queued",
      attempts: 0,
      createdAt: Date.now(),
      command: payload.command,
      tool: payload.tool,
      args: payload.args ?? {},
      priority: payload.priority ?? 5,
      timeoutMs: payload.timeoutMs ?? 15000,
      projectId: payload.projectId ?? "default",
      // P3: HUD correlation — eventId is the queue id; category defaults to
      // the local mirror unless the caller supplied an authoritative one.
      meta: {
        eventId: payload.meta?.eventId ?? id,
        category: payload.meta?.category ?? categoryOfTool(payload.tool),
        sessionId: payload.meta?.sessionId ?? null,
      },
    };
    // insert by priority descending
    let idx = this.queue.findIndex(c => c.status === "queued" && (c.priority ?? 5) < (cmd.priority ?? 5));
    if (idx === -1) this.queue.push(cmd);
    else this.queue.splice(idx, 0, cmd);
    this.byId.set(cmd.id, cmd);
    return cmd;
  }

  next(projectId?: string): QueuedCommand | null {
    // reclaim timed out claims
    const now = Date.now();
    for (const c of this.queue) {
      if ((c.status === "claimed" || (c as any).status === "running") && c.claimedAt && now - c.claimedAt > CLAIM_TIMEOUT_MS) {
        c.status = "queued";
        c.attempts += 1;
      }
    }
    const candidate = this.queue.find(c => c.status === "queued" && (!projectId || c.projectId === projectId));
    if (!candidate) return null;
    candidate.status = "claimed";
    candidate.claimedAt = now;
    (candidate as any).startedAt = now;
    candidate.attempts += 1;
    return candidate;
  }

  /** Plugin calls this when it starts executing (claimed -> running). Optional but tracked. */
  markRunning(id: string): void {
    const cmd = this.byId.get(id);
    if (cmd && cmd.status === "claimed") {
      (cmd as any).status = "running" as any;
      (cmd as any).startedAt = (cmd as any).startedAt ?? Date.now();
    }
  }

  complete(id: string, result: unknown, error?: string, timings?: { elapsed?: number }): QueuedCommand | null {
    const cmd = this.byId.get(id);
    if (!cmd) return null;
    cmd.status = error ? "failed" : "done";
    cmd.result = result;
    cmd.error = error;
    (cmd as any).endedAt = Date.now();
    if (timings?.elapsed != null) (cmd as any).elapsed = timings.elapsed;
    // resolve pending waiter if any
    const waiter = this.pendingResults.get(id);
    if (waiter) {
      clearTimeout(waiter.timer);
      if (error) waiter.reject(new Error(error));
      else waiter.resolve(result);
      this.pendingResults.delete(id);
    }
    return cmd;
  }

  get(id: string): QueuedCommand | undefined {
    return this.byId.get(id);
  }

  status(projectId?: string) {
    const filtered = projectId ? this.queue.filter(c => c.projectId === projectId) : this.queue;
    return {
      depth: filtered.filter(c => c.status === "queued").length,
      claimed: filtered.filter(c => c.status === "claimed").length,
      done: filtered.filter(c => c.status === "done").length,
      failed: filtered.filter(c => c.status === "failed").length,
      total: filtered.length,
      items: filtered.slice(-20).reverse(),
    };
  }

  waitForResult(id: string, timeoutMs: number): Promise<unknown> {
    const cmd = this.byId.get(id);
    if (!cmd) return Promise.reject(new Error("not found"));
    if (cmd.status === "done") return Promise.resolve(cmd.result);
    if (cmd.status === "failed") return Promise.reject(new Error(cmd.error));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingResults.delete(id);
        reject(new Error("timeout waiting for plugin result"));
      }, timeoutMs);
      // NodeJS Timeout needs unref in some contexts
      if (typeof (timer as any).unref === "function") (timer as any).unref();
      this.pendingResults.set(id, { resolve, reject, timer });
    });
  }

  clearDone(olderThanMs = 60000) {
    const cutoff = Date.now() - olderThanMs;
    this.queue = this.queue.filter(c => !(c.status === "done" && c.createdAt < cutoff));
    for (const [k, v] of this.byId) if (v.status === "done" && v.createdAt < cutoff) this.byId.delete(k);
  }

  cancel(id: string): boolean {
    const cmd = this.byId.get(id);
    if (!cmd) return false;
    if (cmd.status !== "queued") return false;
    cmd.status = "done" as any;
    cmd.error = "cancelled by cancel_command";
    this.queue = this.queue.filter(c => c.id !== id);
    return true;
  }
}

export const commandQueue = new CommandQueue();
setInterval(() => commandQueue.clearDone(), 60000).unref?.();
