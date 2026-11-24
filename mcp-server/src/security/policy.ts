// default-deny policy, allowlist handlers only — now allow all 119 canonical + legacy aliases for fully functional
export const ALLOWED_TOOLS = new Set([
  // Core 1-7
  "get_instances","create_instance","set_properties","set_property","delete_instance","clone_instance","move_instance","find_instance",
  // Script 8-15
  "execute_luau","run_code","get_script_content","set_script_content","create_module","run_function","add_event_handler","remove_event_handler","get_global_variables",
  // Snapshot 16-18
  "take_snapshot","get_snapshot","rollback","diff_snapshots","undo",
  // Sandbox 19-22
  "run_in_sandbox","run_sandbox_tests","confirm_sandbox_apply","discard_sandbox","simulate_ticks",
  // Context 23-28
  "get_context_summary","get_context","get_function_signatures","get_property_value","get_property","get_all_properties","search_by_attribute","get_referenced_instances",
  // Dependency 29-33
  "resolve_path","ensure_path","get_dependency_graph","suggest_ordering","validate_command",
  // Perf 34-37
  "get_performance_stats","perf_stats","analyze_performance","set_performance_threshold","get_memory_usage",
  // Terrain 38-42
  "generate_terrain","set_terrain_region","place_parts","create_model_from_table","apply_material",
  // GUI 43-46
  "create_ui","set_ui_property","get_ui_tree","bind_ui_click",
  // Animation 47-50 + motion controllers
  "create_animation_track","create_motion_animation","inspect_motion_animation","validate_motion_animation","preview_motion_animation","remove_motion_animation","play_animation","create_motion_effect","inspect_motion_effect","remove_motion_effect","set_lighting","add_particle_emitter",
  // DataStore 51-53
  "setup_datastore","get_datastore_value","set_datastore_value",
  // Team 54-60
  "export_session_log","get_logs","replay_session","list_sessions","compare_sessions","list_templates","use_template","create_template","apply_template","add_template",
  // Misc 61-64
  "get_time","send_notification","batch_queue","cancel_command",
  // S-Series 65-111 + aliases
  "train_model","style_profile","personalize_code","compile_visual_graph","compile_visual","visual_from_prompt","generate_test","generate_tests","run_tests",
  "session_users","collab_join","collab_list","collab_broadcast",
  "search_asset","search_assets","import_asset",
  "report_metrics","get_metrics","git_commit","git_log","git_rollback",
  "predict_bug","plan_game","generate_gdd","plan","execute_plan",
  "review_code","refactor_code","heal_code","rollback_list",
  "generate_asset","generate_asset_variants","optimize_performance","optimize_perf",
  "report_analytics","get_analytics","suggest_design","analytics_report","analytics_suggestions",
  "list_plugins","load_plugin",
  "set_breakpoint","remove_breakpoint","watch_variable","step_through","continue_execution",
  "generate_level","get_projects","switch_project","create_project","get_suggestions","run_playtest",
  "export_project","import_project","generate_quest","simulate_economy","suggest_balance",
  "explain_code","learning_mode","adjust_difficulty","set_difficulty_profile","generate_sound","generate_sound_pack","play_sound",
  // Workspace explore aliases that AI emits
  "search_game_tree","script_search","script_grep","inspect_instance","get_instance_tree","list_commands","search_scripts",
  // Legacy
  "translate_code","validate_code",
]);

/**
 * Default-deny, as this file's header always claimed.
 *
 * The previous implementation returned true for ANY string matching
 * /^[a-z_]+$/, which is every tool name that could ever be sent - the allowlist
 * above was decorative and an unknown tool reached the Studio queue. Tools are
 * now allowed when they are either on the allowlist or actually registered in
 * the catalogue, which is the real definition of "a tool RoLink implements".
 */
export function isToolAllowed(tool: string): boolean {
  const name = String(tool || "");
  if (!name) return false;
  if (ALLOWED_TOOLS.has(name)) return true;
  // Registered catalogue tools are allowed even when the literal list above
  // has not caught up (the list is hand-maintained).
  return Object.prototype.hasOwnProperty.call(REGISTERED_TOOLS, name);
}

/**
 * Registry-backed membership. Populated by registry.ts at import time so this
 * module keeps no second copy of the tool list.
 */
const REGISTERED_TOOLS: Record<string, true> = Object.create(null);

export function registerKnownTools(names: Iterable<string>): void {
  for (const n of names) REGISTERED_TOOLS[n] = true;
}

export function knownToolCount(): number {
  return Object.keys(REGISTERED_TOOLS).length;
}

export function sanitizeCode(code: string): string {
  if (code.length > 50000) throw new Error("code too large (max 50k)");
  // block dangerous filesystem / os
  const blocked = [/os\.execute/i, /io\.popen/i, /require\s*\(\s*["']http/i];
  for (const re of blocked) if (re.test(code)) throw new Error(`blocked pattern ${re}`);
  return code;
}
