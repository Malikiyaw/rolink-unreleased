// SPDX-License-Identifier: GPL-3.0-or-later
// core/tool-events.js — P0 ToolEvent spine (event bus, no UI).
//
// Publishers:
//   - parser.js  → status "queued"   (a tool block was recognized)
//   - execution.js → "running" then terminal "success"/"error"/"timeout"/
//     "cancelled"/"stale" (one execution lifecycle per rl_* id)
// Subscribers (P1+): SideDock, BottomTimeline, popup dashboard.
// The agent loop never blocks on the bus: every publish is sync,
// guarded, and drops silently when there are no subscribers.
//
// Loaded (manifest.json) BEFORE parser.js/main.js so the hooks below
// always find window.RolinkToolEvents. Also requireable from node
// tests (module.exports).
(function (root) {
  "use strict";

  var MAX_RING = 50;

  function makeToolEventId() {
    try {
      if (typeof crypto !== "undefined" && crypto.randomUUID) return "rl_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    } catch (e) {}
    return "rl_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 9);
  }

  function categoryOf(tool) {
    try {
      var fn = (root && (root.toolCategory || root.ROLINK_toolCategory)) || null;
      if (typeof fn !== "function" && typeof toolCategory === "function") fn = toolCategory;
      if (typeof fn === "function") {
        var c = fn(tool);
        if (typeof c === "string" && c) return c;
      }
    } catch (e) {}
    // Fallback mirror of config.js toolCategory (kept short on purpose —
    // config.js is the source of truth when loaded as a content script).
    var n = String(tool || "").toLowerCase();
    if (/take_snapshot|get_snapshot|rollback|get_instances|find_instance/.test(n)) return "inspect";
    if (/execute_luau|set_script|create_|delete_|clone|move_|set_properties|migrate_system/.test(n)) return "edit";
    if (/generate_|compile_visual/.test(n)) return "generate";
    if (/search_asset|import_asset|apply_material/.test(n)) return "asset";
    if (/create_ui|inspect_ui|screenshot_studio|animation|lighting|particle|play_sound|send_notification/.test(n)) return "visual";
    if (/run_tests|simulate|run_in_sandbox|playtest|step_|watch_variable|_breakpoint|continue_execution|discard_sandbox|confirm_sandbox/.test(n)) return "test";
    if (/get_|list_|search_|find_|validate_|suggest_|explain_|resolve_|ensure_|scan_errors/.test(n)) return "read";
    return "tool";
  }

  function normalizeEvent(partial) {
    var now = Date.now();
    return {
      id: partial && partial.id ? String(partial.id) : makeToolEventId(),
      tool: partial ? String(partial.tool || partial.name || "unknown") : "unknown",
      category: partial && partial.category ? partial.category : categoryOf(partial && (partial.tool || partial.name)),
      status: partial && partial.status ? partial.status : "queued",
      args: (partial && (partial.args || partial.arguments)) || {},
      result: partial ? partial.result : undefined,
      startTime: (partial && partial.startTime) || now,
      durationMs: partial ? partial.durationMs : undefined,
      previewUrl: partial ? partial.previewUrl : undefined,
      codeDiff: partial ? partial.codeDiff : undefined,
      sessionId: (partial && partial.sessionId) || null,
      turnId: (partial && partial.turnId) || null
    };
  }

  // Ring buffer: last MAX_RING events, newest last. P1 dock renders newest top.
  var ring = [];
  var subs = [];

  function publish(partial) {
    var ev;
    try {
      ev = normalizeEvent(partial || {});
    } catch (e) { return null; }
    try {
      ring.push(ev);
      while (ring.length > MAX_RING) ring.shift();
      // Fan-out to in-page subscribers (Dock/Timeline register here).
      for (var i = 0; i < subs.length; i++) {
        try { subs[i](ev); } catch (e) {}
      }
      // Cross-context: background/popup bridge listens via tabs.sendMessage
      // (relayed by background.js); content-script peers via window message.
      try {
        if (root && typeof root.postMessage === "function") {
          root.postMessage({ type: "ROLINK_TOOL_EVENT", event: ev }, "*");
        }
      } catch (e) {}
      // P0 verification: every one of the 119 tools logs here until the
      // Dock lands in P1.
      try {
        if (typeof console !== "undefined" && console.debug) {
          console.debug("[rolink.tool-event]", ev.status, ev.tool, ev.id);
        }
      } catch (e) {}
    } catch (e) { return null; }
    return ev;
  }

  function subscribe(fn) {
    if (typeof fn !== "function") return function () {};
    subs.push(fn);
    return function () {
      var i = subs.indexOf(fn);
      if (i >= 0) subs.splice(i, 1);
    };
  }

  function recent(limit) {
    var n = limit == null ? MAX_RING : Math.max(0, limit | 0);
    return ring.slice(Math.max(0, ring.length - n));
  }

  function clear() { ring.length = 0; }

  var api = {
    MAX_RING: MAX_RING,
    makeToolEventId: makeToolEventId,
    categoryOf: categoryOf,
    publish: publish,
    subscribe: subscribe,
    recent: recent,
    clear: clear
  };

  if (root) {
    root.RolinkToolEvents = api;
    // Alias used by parser/execution hooks (either name works).
    root.ToolEventBus = api;
  }
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
