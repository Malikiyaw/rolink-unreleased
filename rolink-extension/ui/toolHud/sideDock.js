// SPDX-License-Identifier: GPL-3.0-or-later
// ui/toolHud/sideDock.js — P1 Side Dock (1000x Tool Visibility).
//
// Vanilla JS, no build step. Subscribes to window.RolinkToolEvents and
// renders the live tool feed in a glassmorphic right dock + a Ctrl+K
// command palette over all 119 tools. Mounts into #rl-root when main.js
// creates it (falls back to its own host). Never blocks the agent loop:
// every handler is guarded and the dock degrades to a tool browser when
// the bus is absent.
//
// Exposes window.RolinkSideDock { mount, unmount, toggle, isOpen,
// filterTools, formatDuration, statusClass, fuzzyMatch } — the pure
// helpers are unit-tested in tests/tool-events.test.js style P1 suite.
(function (root) {
  "use strict";

  var DOCK_ID = "rl-dock";
  var TAB_ID = "rl-dock-tab";
  var HOST_ID = "rl-dock-host";
  var STORE_KEY = "rl-dock-open";
  var MAX_ROWS = 50;
  var TERMINAL = { success: 1, error: 1, timeout: 1, cancelled: 1, stale: 1 };

  // ── pure helpers (no DOM) ──────────────────────────────────────────
  function statusClass(status) {
    switch (String(status || "")) {
      case "queued": return "q";
      case "running": return "run";
      case "success": return "ok";
      case "error": return "err";
      case "timeout": return "tmo";
      case "cancelled": return "can";
      case "stale": return "stale";
      case "waiting": return "wait";
      default: return "q";
    }
  }

  function formatDuration(ms) {
    if (ms == null || isNaN(ms)) return "";
    ms = Math.max(0, ms | 0);
    if (ms < 1000) return ms + "ms";
    var s = ms / 1000;
    if (s < 60) return (Math.round(s * 10) / 10) + "s";
    return ((s / 60) | 0) + "m" + (((s % 60) | 0) ? " " + ((s % 60) | 0) + "s" : "");
  }

  // Subsequence fuzzy match: "gm" matches "generate_mesh".
  function fuzzyMatch(query, target) {
    query = String(query || "").toLowerCase().replace(/\s+/g, "");
    target = String(target || "").toLowerCase();
    if (!query) return true;
    var j = 0;
    for (var i = 0; i < target.length && j < query.length; i++) {
      if (target[i] === query[j]) j++;
    }
    return j === query.length;
  }

  function toolNames() {
    try {
      var reg = root && root.ROLINK_TOOL_REGISTRY;
      if (reg && Array.isArray(reg.TOOL_NAMES)) return reg.TOOL_NAMES;
    } catch (e) {}
    return [];
  }

  function entryFor(name) {
    try {
      var reg = root && root.ROLINK_TOOL_REGISTRY;
      if (reg && typeof reg.entryFor === "function") return reg.entryFor(name);
    } catch (e) {}
    return { name: name, category: "tool", color: "#94A3B8", icon: "wrench", preview: "json" };
  }

  function filterTools(query, names) {
    names = names || toolNames();
    if (!query) return names.slice();
    var out = [], i, n;
    // Exact substring hits first, then fuzzy.
    for (i = 0; i < names.length; i++) {
      n = names[i];
      if (n.toLowerCase().indexOf(String(query).toLowerCase()) >= 0) out.push(n);
    }
    for (i = 0; i < names.length; i++) {
      n = names[i];
      if (out.indexOf(n) < 0 && fuzzyMatch(query, n)) out.push(n);
    }
    return out;
  }

  // ── tiny DOM helpers (main.js parity) ──────────────────────────────
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function mk(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function reducedMotion() {
    try {
      return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch (e) { return false; }
  }
  function shortStr(s, n) {
    s = String(s == null ? "" : s);
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  }

  // ── state ──────────────────────────────────────────────────────────
  var mounted = false;
  var open = true;
  var autoOpened = false;
  var dockEl = null, listEl = null, headEl = null, countEl = null, runEl = null;
  var tabEl = null, paletteEl = null, paletteInput = null, paletteList = null;
  var toastEl = null;
  var rows = new Map(); // event id -> { ev, row }
  var order = [];       // ids, newest first
  var busUnsub = null;
  var rootObserver = null;

  function bus() {
    try { return root && (root.RolinkToolEvents || root.ToolEventBus); } catch (e) { return null; }
  }
  function registry() {
    try { return root && root.ROLINK_TOOL_REGISTRY; } catch (e) { return null; }
  }
  // P4: category toggles (options page → chrome.storage). Hidden categories
  // vanish from the feed but events are still tracked (counters stay true).
  function catHidden(cat) {
    try {
      var reg = registry();
      if (reg && typeof reg.isHidden === "function") return reg.isHidden(cat);
    } catch (e) {}
    return false;
  }

  function runningCount() {
    var n = 0;
    rows.forEach(function (r) {
      if (r.ev.status === "running" || r.ev.status === "queued") n++;
    });
    return n;
  }

  // ── mount ──────────────────────────────────────────────────────────
  function host() {
    var r = null;
    try { r = document.getElementById("rl-root"); } catch (e) {}
    if (r) return r;
    var h = null;
    try { h = document.getElementById(HOST_ID); } catch (e) {}
    if (!h && typeof document !== "undefined" && document.body) {
      h = mk("div", "");
      h.id = HOST_ID;
      document.body.appendChild(h);
    }
    return h;
  }

  function mount() {
    if (mounted || typeof document === "undefined") return false;
    var h = host();
    if (!h) return false;
    if (document.getElementById(DOCK_ID)) { mounted = true; wireBus(); return true; }

    // Collapsed edge tab (always visible toggle).
    tabEl = mk("button", "rl-dock-tab");
    tabEl.id = TAB_ID;
    tabEl.type = "button";
    tabEl.title = "RoLink tools — toggle Side Dock (Ctrl+K for palette)";
    tabEl.setAttribute("aria-label", "Toggle RoLink Side Dock");
    tabEl.innerHTML = '<span class="rl-dock-tab-dot"></span><span class="rl-dock-tab-n">0</span>';
    tabEl.addEventListener("click", function (e) { e.stopPropagation(); toggle(); });
    h.appendChild(tabEl);

    // Dock panel.
    dockEl = mk("div", "rl-dock");
    dockEl.id = DOCK_ID;
    dockEl.innerHTML =
      '<div class="rl-dock-head">' +
        '<span class="rl-dock-dot"></span>' +
        '<span class="rl-dock-title">RoLink</span>' +
        '<span class="rl-dock-sub"><span id="rl-dock-tools-n">119</span> tools</span>' +
        '<span class="rl-dock-run" id="rl-dock-run" style="display:none"><span class="rl-spinner"></span><span id="rl-dock-run-n">0</span> running</span>' +
        '<span class="rl-dock-count" id="rl-dock-count"></span>' +
        '<button class="rl-dock-btn" id="rl-dock-pal" title="Command palette (Ctrl+K)">⌘K</button>' +
        '<button class="rl-dock-btn" id="rl-dock-x" title="Collapse dock">›</button>' +
      "</div>" +
      '<div class="rl-dock-search"><input id="rl-dock-q" type="text" placeholder="Filter events…" autocomplete="off" spellcheck="false" /></div>' +
      '<div class="rl-dock-list" id="rl-dock-list"></div>' +
      '<div class="rl-dock-toast" id="rl-dock-toast" style="display:none"></div>';
    h.appendChild(dockEl);

    headEl = dockEl.querySelector(".rl-dock-head");
    listEl = dockEl.querySelector("#rl-dock-list");
    countEl = dockEl.querySelector("#rl-dock-count");
    runEl = dockEl.querySelector("#rl-dock-run");
    toastEl = dockEl.querySelector("#rl-dock-toast");
    try {
      var tn = dockEl.querySelector("#rl-dock-tools-n");
      if (tn) tn.textContent = String(toolNames().length || 119);
    } catch (e) {}

    dockEl.querySelector("#rl-dock-x").addEventListener("click", function (e) { e.stopPropagation(); setOpen(false); });
    dockEl.querySelector("#rl-dock-pal").addEventListener("click", function (e) { e.stopPropagation(); openPalette(); });
    var q = dockEl.querySelector("#rl-dock-q");
    q.addEventListener("input", function () { renderList(q.value); });
    q.addEventListener("keydown", function (e) { e.stopPropagation(); });

    buildPalette(h);
    restoreOpen();
    applyOpen();
    wireBus();
    // P4: category toggles — refresh the feed when options change.
    try {
      var reg = registry();
      if (reg) {
        if (typeof reg.readHiddenCats === "function") {
          reg.readHiddenCats(function () { renderList(currentQuery()); });
        }
        if (typeof reg.onHiddenChange === "function") {
          reg.onHiddenChange(function () { renderList(currentQuery()); });
        }
      }
    } catch (e) {}
    // Replay anything already in the bus ring (bridge events that arrived
    // before mount, e.g. on reload with a running session).
    try {
      var b = bus();
      if (b && typeof b.recent === "function") {
        var evts = b.recent(50) || [];
        for (var i = 0; i < evts.length; i++) onEvent(evts[i], true);
      }
    } catch (e) {}
    mounted = true;
    return true;
  }

  function observeRoot() {
    if (mounted || typeof MutationObserver === "undefined") return;
    try {
      rootObserver = new MutationObserver(function () {
        if (document.getElementById("rl-root") && mount() && rootObserver) {
          rootObserver.disconnect();
          rootObserver = null;
        }
      });
      rootObserver.observe(document.documentElement, { childList: true, subtree: false });
    } catch (e) {}
  }

  // Fresh-session reset: drop all rows so stale history from prior sessions
  // stops masquerading as current failures. Ring buffer is cleared by the
  // caller (bus.clear); this clears rendered state. Mount state untouched.
  function clearView() {
    try {
      rows.forEach(function (slot) {
        try { if (slot.row && slot.row.parentNode) slot.row.parentNode.removeChild(slot.row); } catch (e) {}
      });
    } catch (e) {}
    rows.clear(); order = [];
    try { updateHeader(); } catch (e) {}
  }

  function unmount() {    try { if (busUnsub) busUnsub(); } catch (e) {}
    busUnsub = null;
    try { if (rootObserver) rootObserver.disconnect(); } catch (e) {}
    rootObserver = null;
    ["rl-dock", "rl-dock-tab", "rl-dock-pal-ov", HOST_ID].forEach(function (id) {
      try { var n = document.getElementById(id); if (n && n.parentNode) n.parentNode.removeChild(n); } catch (e) {}
    });
    dockEl = listEl = headEl = countEl = runEl = tabEl = paletteEl = null;
    rows.clear(); order = [];
    mounted = false;
  }

  // ── open / collapse ────────────────────────────────────────────────
  function restoreOpen() {
    try {
      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get([STORE_KEY], function (r) {
          if (chrome.runtime && chrome.runtime.lastError) return;
          if (r && typeof r[STORE_KEY] === "boolean") { open = r[STORE_KEY]; applyOpen(); }
        });
      }
    } catch (e) {}
  }
  function persistOpen() {
    try {
      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
        var o = {}; o[STORE_KEY] = open;
        chrome.storage.local.set(o, function () {});
      }
    } catch (e) {}
  }
  function applyOpen() {
    try {
      if (dockEl) dockEl.classList.toggle("rl-closed", !open);
      if (tabEl) tabEl.classList.toggle("rl-hidden", open);
    } catch (e) {}
  }
  function setOpen(v) {
    open = !!v;
    if (open) autoOpened = true;
    applyOpen();
    persistOpen();
  }
  function toggle(force) {
    setOpen(typeof force === "boolean" ? force : !open);
    return open;
  }
  function isOpen() { return mounted && open; }

  // ── event feed ─────────────────────────────────────────────────────
  function wireBus() {
    if (busUnsub) return;
    try {
      var b = bus();
      if (b && typeof b.subscribe === "function") busUnsub = b.subscribe(function (ev) { onEvent(ev); });
    } catch (e) {}
  }

  function onEvent(ev, silent) {
    if (!ev || !ev.id || !mounted) return;
    var slot = rows.get(ev.id);
    if (slot) {
      slot.ev = ev;
      updateRow(slot);
    } else {
      var row = buildRow(ev);
      rows.set(ev.id, { ev: ev, row: row });
      order.unshift(ev.id);
      while (order.length > MAX_ROWS) {
        var drop = order.pop();
        var ds = rows.get(drop);
        if (ds && ds.row.parentNode === listEl) listEl.removeChild(ds.row);
        rows.delete(drop);
      }
      if (listEl) {
        applyFilter(row, currentQuery());
        // Hidden-category rows stay tracked but detached until unhidden
        // (renderList re-attaches them in order).
        if (!catHidden(row.getAttribute("data-category"))) {
          listEl.insertBefore(row, listEl.firstChild);
        }
        if (!reducedMotion()) row.classList.add("rl-dock-in");
      }
    }
    updateHeader();
    // First live event auto-expands a collapsed dock (once per page).
    if (!silent && !open && !autoOpened && (ev.status === "running" || ev.status === "queued")) {
      setOpen(true);
    }
    if (!silent && TERMINAL[ev.status]) celebrate(ev);
  }

  function currentQuery() {
    try {
      var q = dockEl && dockEl.querySelector("#rl-dock-q");
      return q ? q.value : "";
    } catch (e) { return ""; }
  }

  function updateHeader() {
    try {
      var rc = runningCount();
      if (countEl) countEl.textContent = rows.size ? rows.size + " event" + (rows.size === 1 ? "" : "s") : "";
      if (runEl) {
        runEl.style.display = rc ? "" : "none";
        var n = document.getElementById("rl-dock-run-n");
        if (n) n.textContent = String(rc);
      }
      if (headEl) headEl.setAttribute("data-running", rc ? "1" : "0");
      if (tabEl) {
        var t = tabEl.querySelector(".rl-dock-tab-n");
        if (t) t.textContent = String(rc || rows.size);
        tabEl.classList.toggle("rl-live", rc > 0);
      }
    } catch (e) {}
  }

  function renderList(query) {
    if (!listEl) return;
    // Re-attach visible rows newest-first (cheap for ≤50 rows), so
    // unhidden categories reappear in order.
    for (var i = order.length - 1; i >= 0; i--) {
      var slot = rows.get(order[i]);
      if (!slot) continue;
      applyFilter(slot.row, query);
      if (slot.row.style.display !== "none" && !catHidden(slot.row.getAttribute("data-category"))) {
        if (slot.row.parentNode !== listEl) listEl.insertBefore(slot.row, listEl.firstChild);
      } else if (slot.row.parentNode === listEl && catHidden(slot.row.getAttribute("data-category"))) {
        listEl.removeChild(slot.row);
      }
    }
  }

  function applyFilter(row, query) {
    try {
      if (catHidden(row.getAttribute("data-category"))) { row.style.display = "none"; return; }
      if (!query) { row.style.display = ""; return; }
      var hay = (row.getAttribute("data-search") || "").toLowerCase();
      row.style.display = hay.indexOf(String(query).toLowerCase()) >= 0 ? "" : "none";
    } catch (e) {}
  }

  function iconGlyph(icon) {
    // Category keys map to glyphs; P4 per-tool overrides arrive as literal
    // glyphs already and pass straight through.
    var m = {
      cube: "▣", code: "⌨", search: "⌕", wand: "✦", play: "▶",
      package: "📦", palette: "🎨", check: "✓", wrench: "🛠"
    };
    if (m[icon]) return m[icon];
    return icon || "•";
  }

  function buildRow(ev) {
    var meta = entryFor(ev.tool);
    var row = mk("div", "rl-dock-row");
    row.setAttribute("data-id", ev.id);
    row.setAttribute("data-status", ev.status || "queued");
    row.setAttribute("data-category", meta.category);
    row.style.setProperty("--cat", meta.color);
    row.setAttribute("data-search", (ev.tool + " " + meta.category + " " + (ev.status || "")).toLowerCase());
    row.innerHTML =
      '<div class="rl-dock-row-head">' +
        '<span class="rl-dock-ico">' + esc(iconGlyph(meta.icon)) + "</span>" +
        '<span class="rl-dock-name">' + esc(ev.tool) + "</span>" +
        '<span class="rl-dock-dot" data-s="' + esc(statusClass(ev.status)) + '"></span>' +
        '<span class="rl-dock-dur">' + esc(formatDuration(ev.durationMs)) + "</span>" +
        '<span class="rl-dock-chev">▾</span>' +
      "</div>" +
      '<div class="rl-dock-row-body" style="display:none"></div>';
    row.querySelector(".rl-dock-row-head").addEventListener("click", function (e) {
      e.stopPropagation();
      toggleRow(row, rows.get(ev.id));
    });
    fillBody(row, rows.get(ev.id) ? rows.get(ev.id).ev : ev);
    return row;
  }

  function updateRow(slot) {
    var row = slot.row, ev = slot.ev;
    var meta = entryFor(ev.tool);
    try {
      row.setAttribute("data-status", ev.status || "queued");
      row.setAttribute("data-category", meta.category);
      row.style.setProperty("--cat", meta.color);
      row.setAttribute("data-search", (ev.tool + " " + meta.category + " " + (ev.status || "")).toLowerCase());
      var dot = row.querySelector(".rl-dock-dot");
      if (dot) dot.setAttribute("data-s", statusClass(ev.status));
      var dur = row.querySelector(".rl-dock-dur");
      if (dur) dur.textContent = formatDuration(ev.durationMs);
      var body = row.querySelector(".rl-dock-row-body");
      if (body && body.style.display !== "none") fillBody(row, ev);
    } catch (e) {}
  }

  function toggleRow(row, slot) {
    try {
      var body = row.querySelector(".rl-dock-row-body");
      var openRow = body.style.display !== "none";
      body.style.display = openRow ? "none" : "";
      row.classList.toggle("rl-open", !openRow);
      if (!openRow && slot) fillBody(row, slot.ev);
    } catch (e) {}
  }

  function codeDiffHtml(ev) {
    if (!ev.codeDiff || typeof ev.codeDiff !== "object") return "";
    return '<div class="rl-dock-sec"><div class="rl-dock-sec-t">diff</div>' +
      '<pre class="rl-dock-diff del">' + esc(shortStr(ev.codeDiff.before, 2000)) + "</pre>" +
      '<pre class="rl-dock-diff add">' + esc(shortStr(ev.codeDiff.after, 2000)) + "</pre></div>";
  }

  function previewHtml(ev) {
    if (!ev.previewUrl || typeof ev.previewUrl !== "string") return "";
    return '<div class="rl-dock-sec"><div class="rl-dock-sec-t">preview</div>' +
      '<img class="rl-dock-thumb" src="' + esc(ev.previewUrl) + '" alt="tool preview" loading="lazy" /></div>';
  }

  function fillBody(row, ev) {
    if (!ev) return;
    try {
      var body = row.querySelector(".rl-dock-row-body");
      var args = ev.args && typeof ev.args === "object" ? ev.args : {};
      var keys = Object.keys(args);
      var argRows = keys.slice(0, 6).map(function (k) {
        return '<div class="rl-dock-kv"><span>' + esc(k) + "</span><span>" +
          esc(shortStr(typeof args[k] === "string" ? args[k] : JSON.stringify(args[k]), 120)) + "</span></div>";
      }).join("");
      if (keys.length > 6) argRows += '<div class="rl-dock-more">+' + (keys.length - 6) + " more</div>";
      var res = ev.result == null ? "" : (typeof ev.result === "string" ? ev.result : JSON.stringify(ev.result, null, 2));
      body.innerHTML =
        '<div class="rl-dock-sec"><div class="rl-dock-sec-t">args</div>' +
          (argRows || '<div class="rl-dock-empty">—</div>') + "</div>" +
        codeDiffHtml(ev) + previewHtml(ev) +
        '<div class="rl-dock-sec"><div class="rl-dock-sec-t">result</div>' +
          (res ? '<pre class="rl-dock-pre">' + esc(shortStr(res, 4000)) + "</pre>"
               : '<div class="rl-dock-empty">' + (TERMINAL[ev.status] ? "—" : "running…") + "</div>") + "</div>";
    } catch (e) {}
  }

  // ── celebrate: confetti on success, shake on error ─────────────────
  function celebrate(ev) {
    if (reducedMotion() || !dockEl) return;
    try {
      var slot = rows.get(ev.id);
      if (!slot) return;
      if (ev.status === "success") confettiBurst(slot.row);
      else if (ev.status === "error" || ev.status === "timeout") {
        slot.row.classList.remove("rl-dock-shake");
        void slot.row.offsetWidth;
        slot.row.classList.add("rl-dock-shake");
        setTimeout(function () { try { slot.row.classList.remove("rl-dock-shake"); } catch (e) {} }, 500);
      }
    } catch (e) {}
  }

  function confettiBurst(anchor) {
    try {
      var hostEl = anchor || dockEl;
      var colors = ["#00E5FF", "#A855F7", "#FFB800", "#FF6B35", "#00FF88", "#5B8DEF"];
      for (var i = 0; i < 12; i++) {
        (function (i) {
          var p = mk("span", "rl-dock-confetti");
          p.style.background = colors[i % colors.length];
          hostEl.appendChild(p);
          var dx = (Math.random() - 0.5) * 120;
          var dy = -30 - Math.random() * 70;
          if (p.animate) {
            p.animate(
              [{ transform: "translate(0,0) rotate(0deg)", opacity: 1 },
               { transform: "translate(" + dx + "px," + dy + "px) rotate(" + (Math.random() * 360) + "deg)", opacity: 0 }],
              { duration: 600 + Math.random() * 400, easing: "cubic-bezier(.2,.7,.3,1)" }
            ).onfinish = function () { try { p.remove(); } catch (e) {} };
          } else {
            setTimeout(function () { try { p.remove(); } catch (e) {} }, 900);
          }
        })(i);
      }
      setTimeout(function () {
        try {
          var left = hostEl.querySelectorAll(".rl-dock-confetti");
          for (var i = 0; i < left.length; i++) left[i].remove();
        } catch (e) {}
      }, 1500);
    } catch (e) {}
  }

  function toast(msg) {
    try {
      if (!toastEl) return;
      toastEl.textContent = String(msg);
      toastEl.style.display = "";
      setTimeout(function () { try { toastEl.style.display = "none"; } catch (e) {} }, 2200);
    } catch (e) {}
  }

  // ── command palette (Ctrl+K over all 119) ──────────────────────────
  function buildPalette(h) {
    paletteEl = mk("div", "rl-dock-pal-ov");
    paletteEl.id = "rl-dock-pal-ov";
    paletteEl.style.display = "none";
    paletteEl.innerHTML =
      '<div class="rl-dock-pal">' +
        '<input id="rl-dock-pal-q" type="text" placeholder="Type a tool — mesh, script, terrain… (Enter copies template)" autocomplete="off" spellcheck="false" />' +
        '<div class="rl-dock-pal-list" id="rl-dock-pal-list"></div>' +
      "</div>";
    h.appendChild(paletteEl);
    paletteInput = paletteEl.querySelector("#rl-dock-pal-q");
    paletteList = paletteEl.querySelector("#rl-dock-pal-list");
    paletteInput.addEventListener("input", function () { renderPalette(paletteInput.value); });
    paletteInput.addEventListener("keydown", function (e) {
      e.stopPropagation();
      if (e.key === "Escape") closePalette();
      else if (e.key === "Enter") {
        var first = paletteList && paletteList.querySelector("[data-tool]");
        if (first) copyTemplate(first.getAttribute("data-tool"));
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        movePalSel(e.key === "ArrowDown" ? 1 : -1);
      }
    });
    paletteEl.addEventListener("click", function (e) {
      if (e.target === paletteEl) closePalette();
      else {
        var t = e.target && e.target.closest ? e.target.closest("[data-tool]") : null;
        if (t) copyTemplate(t.getAttribute("data-tool"));
      }
    });
    renderPalette("");
  }

  // P4: palette groups hits by category (fixed order) with headers, counts
  // and per-tool preview-kind tags. First hit overall keeps .rl-sel.
  function paletteOrder() {
    try {
      var reg = root && root.ROLINK_TOOL_REGISTRY;
      if (reg && Array.isArray(reg.CATEGORY_ORDER)) return reg.CATEGORY_ORDER;
    } catch (e) {}
    return ["read", "edit", "inspect", "generate", "asset", "visual", "test", "tool"];
  }
  function renderPalette(query) {
    if (!paletteList) return;
    var names = filterTools(query);
    var groups = {};
    var i, n;
    for (i = 0; i < names.length; i++) {
      n = names[i];
      var c = entryFor(n).category;
      if (!groups[c]) groups[c] = [];
      if (groups[c].length < 12) groups[c].push(n);
    }
    var html = "", first = true;
    var order = paletteOrder();
    for (var g = 0; g < order.length; g++) {
      var arr = groups[order[g]];
      if (!arr || !arr.length) continue;
      html += '<div class="rl-dock-pal-cat-h">' + esc(order[g]) +
        ' <span class="rl-dock-pal-n">' + arr.length + "</span></div>";
      for (i = 0; i < arr.length; i++) {
        var m = entryFor(arr[i]);
        html += '<button type="button" class="rl-dock-pal-item' + (first ? " rl-sel" : "") + '" data-tool="' + esc(arr[i]) + '">' +
          '<span class="rl-dock-ico" style="--cat:' + esc(m.color) + '">' + esc(iconGlyph(m.icon)) + "</span>" +
          '<span class="rl-dock-pal-name">' + esc(arr[i]) + "</span>" +
          '<span class="rl-dock-pal-prev">' + esc(m.preview) + "</span></button>";
        first = false;
      }
    }
    paletteList.innerHTML = html || '<div class="rl-dock-empty">No tools match.</div>';
  }

  function movePalSel(dir) {
    try {
      var items = paletteList.querySelectorAll("[data-tool]");
      if (!items.length) return;
      var idx = -1;
      for (var i = 0; i < items.length; i++) {
        if (items[i].classList.contains("rl-sel")) { idx = i; break; }
      }
      if (idx >= 0) items[idx].classList.remove("rl-sel");
      idx = (idx + dir + items.length) % items.length;
      items[idx].classList.add("rl-sel");
      items[idx].scrollIntoView({ block: "nearest" });
    } catch (e) {}
  }

  function copyTemplate(name) {
    var tpl = '###MCP_TOOL###\n{"tool":"' + name + '","args":{}}';
    function done() { toast("Template copied: " + name); closePalette(); }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(tpl).then(done, function () { fallbackCopy(tpl); done(); });
      } else { fallbackCopy(tpl); done(); }
    } catch (e) { try { fallbackCopy(tpl); } catch (e2) {} done(); }
  }

  function fallbackCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch (e) {}
    document.body.removeChild(ta);
  }

  function openPalette() {
    if (!mounted && !mount()) return;
    setOpen(true);
    if (paletteEl) paletteEl.style.display = "";
    renderPalette("");
    setTimeout(function () { try { paletteInput.focus(); } catch (e) {} }, 30);
  }
  function closePalette() {
    try { if (paletteEl) paletteEl.style.display = "none"; } catch (e) {}
  }
  function paletteOpen() {
    try { return !!paletteEl && paletteEl.style.display !== "none"; } catch (e) { return false; }
  }

  // ── global keys ────────────────────────────────────────────────────
  function onKey(e) {
    try {
      if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === "k") {
        e.preventDefault();
        if (!mounted && !mount()) return;
        if (paletteOpen()) closePalette();
        else openPalette();
      } else if (e.key === "Escape" && paletteOpen()) {
        closePalette();
      }
    } catch (err) {}
  }

  // ── boot ───────────────────────────────────────────────────────────
  function boot() {
    if (typeof document === "undefined") return;
    try {
      if (!mount()) observeRoot();
      document.addEventListener("keydown", onKey, true);
    } catch (e) {}
  }

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", boot);
    } else {
      boot();
    }
    // Late retry: main.js creates #rl-root after providers settle.
    setTimeout(function () { try { if (!mounted) mount(); } catch (e) {} }, 3000);
  }

  var api = {
    mount: mount,
    unmount: unmount,
    clearView: clearView,
    toggle: toggle,
    isOpen: isOpen,
    openPalette: openPalette,
    closePalette: closePalette,
    filterTools: filterTools,
    formatDuration: formatDuration,
    statusClass: statusClass,
    fuzzyMatch: fuzzyMatch
  };
  if (root) root.RolinkSideDock = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
