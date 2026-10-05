// SPDX-License-Identifier: GPL-3.0-or-later
// ui/toolHud/toolRegistry.js — P0 visual identity for the full RoLink catalog.
//
// Category comes from config.js toolCategory() (extended in P0 to cover
// the full registry). Colors/icons/preview-kinds are fixed per category
// so P1 (SideDock/Timeline) and P3 (Studio HUD) share one source of truth.
// No build step: plain script, loaded via manifest.json after
// core/tool-events.js. Also requireable from node tests.
(function (root) {
  "use strict";

  // Full catalogue (kept in sync with tests/__registry__.json).
  var TOOL_NAMES = [
    "get_instances", "create_instance", "set_properties", "delete_instance",
    "clone_instance", "move_instance", "find_instance", "execute_luau",
    "get_script_content", "set_script_content", "create_module", "run_function",
    "add_event_handler", "remove_event_handler", "get_global_variables",
    "take_snapshot", "rollback", "diff_snapshots", "run_in_sandbox",
    "confirm_sandbox_apply", "discard_sandbox", "simulate_ticks",
    "get_context_summary", "get_function_signatures", "get_property_value",
    "get_all_properties", "search_by_attribute", "get_referenced_instances",
    "resolve_path", "ensure_path", "get_dependency_graph", "suggest_ordering",
    "validate_command", "get_performance_stats", "analyze_performance",
    "set_performance_threshold", "get_memory_usage", "generate_terrain",
    "set_terrain_region", "place_parts", "create_model_from_table",
    "apply_material", "create_ui", "set_ui_property", "get_ui_tree",
    "bind_ui_click", "create_animation_track", "play_animation", "set_lighting",
    "add_particle_emitter", "setup_datastore", "get_datastore_value",
    "set_datastore_value", "export_session_log", "replay_session",
    "list_sessions", "compare_sessions", "list_templates", "apply_template",
    "add_template", "get_time", "send_notification", "batch_queue",
    "cancel_command", "train_model", "compile_visual_graph", "generate_test",
    "run_tests", "session_users", "search_asset", "import_asset",
    "report_metrics", "get_metrics", "git_commit", "git_log", "git_rollback",
    "predict_bug", "plan_game", "execute_plan", "review_code", "refactor_code",
    "generate_asset", "optimize_performance", "report_analytics",
    "get_analytics", "suggest_design", "list_plugins", "load_plugin",
    "set_breakpoint", "remove_breakpoint", "watch_variable", "step_through",
    "continue_execution", "generate_level", "get_projects", "switch_project",
    "create_project", "get_suggestions", "run_playtest", "export_project",
    "import_project", "generate_quest", "simulate_economy", "suggest_balance",
    "explain_code", "learning_mode", "adjust_difficulty",
    "set_difficulty_profile", "generate_sound", "generate_sound_pack",
    "play_sound", "get_animation_info", "delete_animation",
    "create_cutscene", "create_dialogue", "preview_cutscene",
    "validate_cutscene", "remove_cutscene", "create_motion_effect",
    "inspect_motion_effect", "remove_motion_effect", "create_vfx",
    "export_animation_clip", "publish_animation",
    "scan_errors", "inspect_ui",
    "screenshot_studio", "playtest_scenario", "migrate_system",
    "create_motion_animation", "inspect_motion_animation", "validate_motion_animation",
    "preview_motion_animation", "remove_motion_animation",
    "analyze_animatable_model", "create_model_animation",
    "set_model_keyframe", "set_model_easing", "add_animation_marker",
    "preview_model_animation", "validate_model_animation",
    "retime_animation", "reverse_animation", "mirror_animation",
    "blend_animation", "fix_animation", "create_attack_animation",
    "create_idle_animation", "create_walk_cycle",
    "set_track_lock"
  ];

  var CATEGORY_STYLE = {
    read:     { color: "#5B8DEF", icon: "search",  preview: "table" },
    edit:     { color: "#FFB800", icon: "code",    preview: "diff" },
    inspect:  { color: "#00E5FF", icon: "cube",    preview: "ghost" },
    generate: { color: "#FF6B35", icon: "wand",    preview: "thumbnail" },
    asset:    { color: "#F472B6", icon: "package", preview: "thumbnail" },
    visual:   { color: "#A855F7", icon: "palette", preview: "preview" },
    test:     { color: "#00FF88", icon: "play",    preview: "log" },
    tool:     { color: "#94A3B8", icon: "wrench",  preview: "json" }
  };

  // P4 icon audit: per-tool glyph overrides where the category glyph
  // misleads (text-safe unicode only — no emoji-font dependency).
  // Everything else falls back to its category icon; iconFor() guarantees
  // every catalog tool resolves a non-empty glyph.
  var ICON_OVERRIDES = {
    execute_luau: "➤", set_script_content: "✎", get_script_content: "⎙",
    create_module: "▦", run_function: "➤",
    get_instances: "☰", create_instance: "✚", delete_instance: "✖",
    clone_instance: "⧉", move_instance: "⇄",
    take_snapshot: "●", rollback: "↻", diff_snapshots: "⇄",
    set_breakpoint: "●", remove_breakpoint: "○", watch_variable: "◉",
    step_through: "➤",
    run_tests: "✓", run_playtest: "⏵", generate_test: "✓",
    generate_terrain: "▲", generate_level: "⬢", generate_quest: "★",
    generate_sound: "♪", generate_sound_pack: "♫", play_sound: "♪",
    send_notification: "◉", set_lighting: "☼",
    search_asset: "⌕", import_asset: "⇩", apply_material: "⬣",
    git_commit: "⎘", git_log: "☰", git_rollback: "↻",
    batch_queue: "☰", cancel_command: "✖",
    create_cutscene: "▷", create_dialogue: "❝", preview_cutscene: "▷",
    validate_cutscene: "✓", remove_cutscene: "×", create_motion_effect: "〜",
    inspect_motion_effect: "⌕", remove_motion_effect: "×", create_motion_animation: "◆",
    inspect_motion_animation: "⌕", validate_motion_animation: "✓", preview_motion_animation: "▷",
    remove_motion_animation: "×", create_vfx: "✦",
    export_animation_clip: "◫", publish_animation: "⇪",
    get_time: "◷", train_model: "◍", plan_game: "⚑",
    compile_visual_graph: "◈", review_code: "»", explain_code: "?",
    optimize_performance: "▲", simulate_economy: "◔"
  };

  function iconFor(name) {
    if (Object.prototype.hasOwnProperty.call(ICON_OVERRIDES, name)) return ICON_OVERRIDES[name];
    return (CATEGORY_STYLE[categoryOf(name)] || CATEGORY_STYLE.tool).icon;
  }

  function categoryOf(name) {
    try {
      var bus = root && (root.RolinkToolEvents || root.ToolEventBus);
      if (bus && typeof bus.categoryOf === "function") return bus.categoryOf(name);
    } catch (e) {}
    return "tool";
  }

  function entryFor(name) {
    var cat = categoryOf(name);
    var style = CATEGORY_STYLE[cat] || CATEGORY_STYLE.tool;
    return { name: name, category: cat, color: style.color, icon: iconFor(name), preview: style.preview };
  }

  function buildRegistry() {
    var reg = {};
    for (var i = 0; i < TOOL_NAMES.length; i++) reg[TOOL_NAMES[i]] = entryFor(TOOL_NAMES[i]);
    return reg;
  }

  // P4: hidden-category store (chrome.storage.local `rl-hidden-cats`).
  // Dock/Timeline consult isHidden(); options page writes via setHidden().
  // Node/test contexts (no chrome) degrade to "nothing hidden".
  var HIDDEN_CATS_KEY = "rl-hidden-cats";
  var hiddenCats = {};
  var hiddenLoaded = false;
  var hiddenSubs = [];

  function readHiddenCats(cb) {
    try {
      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get([HIDDEN_CATS_KEY], function (r) {
          try {
            var arr = r && r[HIDDEN_CATS_KEY];
            hiddenCats = {};
            if (Array.isArray(arr)) {
              for (var i = 0; i < arr.length; i++) hiddenCats[String(arr[i])] = true;
            }
            hiddenLoaded = true;
            notifyHidden();
            if (cb) cb(hiddenCats);
          } catch (e) { if (cb) cb(hiddenCats); }
        });
        return;
      }
    } catch (e) {}
    hiddenLoaded = true;
    if (cb) cb(hiddenCats);
  }

  function notifyHidden() {
    for (var i = 0; i < hiddenSubs.length; i++) {
      try { hiddenSubs[i](hiddenCats); } catch (e) {}
    }
  }

  function onHiddenChange(fn) {
    if (typeof fn !== "function") return function () {};
    hiddenSubs.push(fn);
    return function () {
      var i = hiddenSubs.indexOf(fn);
      if (i >= 0) hiddenSubs.splice(i, 1);
    };
  }

  function isHidden(cat) {
    return !!hiddenCats[String(cat || "")];
  }

  function setHidden(arr, cb) {
    hiddenCats = {};
    var list = [];
    for (var i = 0; i < (arr || []).length; i++) {
      var c = String(arr[i]);
      hiddenCats[c] = true;
      list.push(c);
    }
    hiddenLoaded = true;
    notifyHidden();
    try {
      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
        var o = {};
        o[HIDDEN_CATS_KEY] = list;
        chrome.storage.local.set(o, function () { if (cb) cb(); });
        return;
      }
    } catch (e) {}
    if (cb) cb();
  }

  try {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener(function (changes, area) {
        try {
          if (area === "local" && changes && changes[HIDDEN_CATS_KEY]) {
            var v = changes[HIDDEN_CATS_KEY].newValue;
            hiddenCats = {};
            if (Array.isArray(v)) {
              for (var i = 0; i < v.length; i++) hiddenCats[String(v[i])] = true;
            }
            hiddenLoaded = true;
            notifyHidden();
          }
        } catch (e) {}
      });
    }
  } catch (e) {}

  var api = {
    TOOL_NAMES: TOOL_NAMES,
    TOOL_COUNT: TOOL_NAMES.length,
    CATEGORY_STYLE: CATEGORY_STYLE,
    CATEGORY_ORDER: ["read", "edit", "inspect", "generate", "asset", "visual", "test", "tool"],
    ICON_OVERRIDES: ICON_OVERRIDES,
    HIDDEN_CATS_KEY: HIDDEN_CATS_KEY,
    entryFor: entryFor,
    iconFor: iconFor,
    buildRegistry: buildRegistry,
    registry: buildRegistry(),
    readHiddenCats: readHiddenCats,
    onHiddenChange: onHiddenChange,
    isHidden: isHidden,
    setHidden: setHidden,
    hiddenLoaded: function () { return hiddenLoaded; }
  };

  if (root) root.ROLINK_TOOL_REGISTRY = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
