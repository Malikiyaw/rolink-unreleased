// SPDX-License-Identifier: GPL-3.0-or-later
// ui/build-panel.js — Narrative build HUD ("explain exactly what you're doing").
//
// Vanilla JS, no build step. Subscribes to window.RolinkToolEvents (loads
// AFTER core/tool-events.js, BEFORE core/main.js per manifest.json) and
// renders a small fixed card: goal header, phase checklist derived from tool
// categories, batch progress bar, and the current tool + target. Never blocks
// the agent loop: every handler is guarded, rendering is throttled to one
// DOM write per event, and the whole panel degrades to hidden when the bus
// or DOM is absent.
//
// Exposes window.RolinkBuildPanel { setGoal, notifyLoopStart, reset, phaseOf }.
// Pure helpers (phaseOf, shortArgs) are testable without a DOM.
(function (root) {
  "use strict";

  var PANEL_ID = "rl-build-panel";
  var MAX_FEED = 8;

  // Category -> narrative phase. Mirrors core/tool-events.js categoryOf().
  var PHASES = ["Inspecting project", "Creating architecture", "Writing scripts",
                "Generating content", "Polishing visuals", "Testing"];
  function phaseOf(tool, category) {
    var t = String(tool || "");
    if (/set_script_content|create_module|get_script_content/.test(t)) return "Writing scripts";
    switch (String(category || "")) {
      case "read": case "inspect": return "Inspecting project";
      case "edit": return "Creating architecture";
      case "generate": case "asset": return "Generating content";
      case "visual": return "Polishing visuals";
      case "test": return "Testing";
      default: return "Creating architecture";
    }
  }

  function shortArgs(tool, args) {
    try {
      args = args || {};
      var target = args.path || args.parent || args.characterPath || args.root ||
                   args.scenario || args.system || args.name || args.className || "";
      var s = tool + (target ? "  " + String(target).slice(0, 48) : "");
      return s.slice(0, 64);
    } catch (e) { return String(tool || ""); }
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  var state = { goal: "", done: {}, current: null, progress: null, started: false };

  function ensurePanel() {
    try {
      var doc = root.document;
      if (!doc || !doc.body) return null;
      var el = doc.getElementById(PANEL_ID);
      if (el) return el;
      el = doc.createElement("div");
      el.id = PANEL_ID;
      el.setAttribute("data-rolink", "build-panel");
      doc.body.appendChild(el);
      return el;
    } catch (e) { return null; }
  }

  function batchProgress(ev) {
    // Batch/atomic envelopes report {batched, succeeded} inside result text.
    try {
      var raw = ev.result || (ev.args && ev.args.text) || "";
      var m = /"batched"\s*:\s*(\d+)[\s\S]{0,200}?"succeeded"\s*:\s*(\d+)/.exec(String(raw));
      if (m) return { done: parseInt(m[2], 10), total: parseInt(m[1], 10) };
      if (ev.tool === "batch_queue" && ev.status === "running") return { done: 0, total: 1 };
    } catch (e) {}
    return null;
  }

  function render() {
    var el = ensurePanel();
    if (!el) return;
    try {
      var cur = state.current;
      var rows = PHASES.map(function (p) {
        var cls = "rl-bp-todo", mark = "○";
        if (state.done[p]) { cls = "rl-bp-done"; mark = "✓"; }
        else if (cur && cur.phase === p && !/success|error|timeout|cancelled|stale/.test(cur.status || "")) {
          cls = "rl-bp-cur"; mark = "●";
        }
        var bar = "";
        if (cls === "rl-bp-cur" && state.progress && state.progress.total > 1) {
          var pct = Math.round(100 * state.progress.done / state.progress.total);
          bar = '<span class="rl-bp-bar"><span style="width:' + pct + '%"></span></span>';
        } else if (cls === "rl-bp-cur") {
          bar = '<span class="rl-bp-bar rl-bp-pulse"><span></span></span>';
        }
        return '<div class="rl-bp-row ' + cls + '"><span class="rl-bp-mark">' + mark +
               '</span><span>' + esc(p) + '</span>' + bar + '</div>';
      }).join("");
      var now = cur
        ? '<div class="rl-bp-now">Current: ' + esc(shortArgs(cur.tool, cur.args)) + '</div>'
        : '<div class="rl-bp-now rl-bp-idle">Idle — start a session to build.</div>';
      el.innerHTML =
        '<div class="rl-bp-head">RoLink</div>' +
        '<div class="rl-bp-goal">' + esc(state.goal || "Working in Studio") + '</div>' +
        rows + now;
    } catch (e) {}
  }

  function onEvent(ev) {
    try {
      if (!ev) return;
      var terminal = /success|error|timeout|cancelled|stale/.test(ev.status || "");
      var phase = phaseOf(ev.tool, ev.category);
      if (terminal) {
        state.done[phase] = true;
        if (state.current && state.current.id === ev.id) {
          state.current = null;
          state.progress = null;
        }
      } else {
        state.current = { id: ev.id, tool: ev.tool, args: ev.args, phase: phase, status: ev.status };
        var bp = batchProgress(ev);
        if (bp) state.progress = bp;
      }
      render();
    } catch (e) {}
  }

  function sniffGoal() {
    // Best-effort: last user-authored message in common provider DOMs.
    // Providers with their own shape can call setGoal() instead (main.js does).
    try {
      var doc = root.document;
      if (!doc) return "";
      var sels = ['[data-message-author-role="user"]', "[data-testid='user-message']",
                  ".user-message", '[class*="user-bubble"]', ".message-user"];
      for (var i = 0; i < sels.length; i++) {
        var nodes = doc.querySelectorAll(sels[i]);
        if (nodes && nodes.length) {
          var t = (nodes[nodes.length - 1].innerText || "").trim().replace(/\s+/g, " ");
          if (t) return t.slice(0, 90);
        }
      }
    } catch (e) {}
    return "";
  }

  var api = {
    phaseOf: phaseOf,
    shortArgs: shortArgs,
    setGoal: function (t) {
      state.goal = String(t || "").slice(0, 90);
      state.started = true;
      render();
    },
    notifyLoopStart: function () {
      state.done = {};
      state.current = null;
      state.progress = null;
      if (!state.goal) state.goal = sniffGoal();
      state.started = true;
      render();
    },
    reset: function () {
      state.goal = "";
      state.done = {};
      state.current = null;
      state.progress = null;
      state.started = false;
      try {
        var el = root.document && root.document.getElementById(PANEL_ID);
        if (el) el.innerHTML = "";
      } catch (e) {}
    }
  };

  if (root) root.RolinkBuildPanel = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;

  // Subscribe when the bus exists (it loads before us per manifest order).
  try {
    var bus = (root && (root.RolinkToolEvents || root.ToolEventBus)) || null;
    if (bus && typeof bus.subscribe === "function") bus.subscribe(onEvent);
    else if (typeof root !== "undefined" && root.addEventListener) {
      // Late-bus fallback: the bus postMessages ROLINK_TOOL_EVENT anyway.
      root.addEventListener("message", function (m) {
        try {
          if (m && m.data && m.data.type === "ROLINK_TOOL_EVENT" && m.data.event) onEvent(m.data.event);
        } catch (e) {}
      });
    }
  } catch (e) {}
})(typeof window !== "undefined" ? window : globalThis);
