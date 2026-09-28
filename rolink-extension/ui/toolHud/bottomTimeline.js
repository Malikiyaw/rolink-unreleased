// SPDX-License-Identifier: GPL-3.0-or-later
// ui/toolHud/bottomTimeline.js — P2 Bottom Timeline (1000x Tool Visibility).
//
// Vanilla JS, no build step. Subscribes to window.RolinkToolEvents and
// renders the tool sequence as a horizontal filmstrip: oldest → newest,
// block width ∝ duration, color = category. Hover scrubs (event snapshot
// tooltip); per-block and replay-all buttons re-run tools through the
// agent loop via window.ROLINK.replayTool (exposed by main.js).
//
// Collapsed to a thin strip by default (persisted); the agent loop never
// blocks on it. Exposes window.RolinkTimeline { mount, unmount, toggle,
// isOpen, orderEvents, blockWidth, summarizeArgs } — pure helpers are
// unit-tested in tests/bottomTimeline.test.js.
(function (root) {
  "use strict";

  var TL_ID = "rl-timeline";
  var HOST_ID = "rl-dock-host";
  var STORE_KEY = "rl-timeline-open";
  var MAX_BLOCKS = 30;
  var MIN_W = 44, MAX_W = 160;
  var REPLAY_GAP_MS = 800;
  var TERMINAL = { success: 1, error: 1, timeout: 1, cancelled: 1, stale: 1 };

  // ── pure helpers (no DOM) ──────────────────────────────────────────
  function orderEvents(events) {
    return (events || []).slice().sort(function (a, b) {
      return (a.startTime || 0) - (b.startTime || 0);
    });
  }

  // Width ∝ duration relative to the longest block in view.
  // Missing/zero durations (queued) get the minimum width; running blocks
  // get a fixed mid width (their bar animates via CSS).
  function blockWidth(ev, maxDurationMs) {
    if (!ev || ev.status === "running" || ev.status === "queued" || ev.status === "waiting") return 64;
    var d = typeof ev.durationMs === "number" ? Math.max(0, ev.durationMs) : 0;
    var max = typeof maxDurationMs === "number" && maxDurationMs > 0 ? maxDurationMs : Math.max(d, 1);
    var w = MIN_W + ((MAX_W - MIN_W) * Math.min(1, d / max));
    return Math.round(w);
  }

  function summarizeArgs(args, maxPairs) {
    if (!args || typeof args !== "object") return "";
    var keys = Object.keys(args).slice(0, maxPairs || 3);
    return keys.map(function (k) {
      var v = args[k];
      var s = typeof v === "string" ? v : JSON.stringify(v);
      if (s == null) s = "";
      if (s.length > 60) s = s.slice(0, 59) + "…";
      return k + ": " + s;
    }).join("  ·  ");
  }

  function entryFor(name) {
    try {
      var reg = root && root.ROLINK_TOOL_REGISTRY;
      if (reg && typeof reg.entryFor === "function") return reg.entryFor(name);
    } catch (e) {}
    return { name: name, category: "tool", color: "#94A3B8", icon: "wrench", preview: "json" };
  }

  // ── tiny DOM helpers ───────────────────────────────────────────────
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
  function formatDuration(ms) {
    if (ms == null || isNaN(ms)) return "…";
    ms = Math.max(0, ms | 0);
    if (ms < 1000) return ms + "ms";
    var s = ms / 1000;
    if (s < 60) return (Math.round(s * 10) / 10) + "s";
    return ((s / 60) | 0) + "m" + (((s % 60) | 0) ? " " + ((s % 60) | 0) + "s" : "");
  }
  function reducedMotion() {
    try {
      return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch (e) { return false; }
  }

  // ── state ──────────────────────────────────────────────────────────
  var mounted = false;
  var open = false; // collapsed strip by default (persisted override)
  var follow = true;
  var isReplaying = false;
  var tlEl = null, stripEl = null, tipEl = null, toastEl = null;
  var lastEl = null, countEl = null, followBtn = null;
  var blocks = new Map(); // event id -> { ev, el }
  var busUnsub = null;
  var rootObserver = null;

  function bus() {
    try { return root && (root.RolinkToolEvents || root.ToolEventBus); } catch (e) { return null; }
  }
  // P4: hidden categories vanish from the filmstrip but stay tracked
  // (replay-all still sees them; unhiding re-renders via rebuild()).
  function tlCatHidden(ev) {
    try {
      var reg = root && root.ROLINK_TOOL_REGISTRY;
      if (reg && typeof reg.isHidden === "function" && typeof reg.entryFor === "function") {
        return reg.isHidden(reg.entryFor(ev.tool).category);
      }
    } catch (e) {}
    return false;
  }
  function rebuild() {
    if (!mounted || !tlEl) return;
    var film = tlEl.querySelector("#rl-tl-film");
    if (!film) return;
    film.innerHTML = "";
    var seq = orderEvents(Array.from(blocks.values()).map(function (s) { return s.ev; }));
    for (var i = 0; i < seq.length; i++) {
      var slot = blocks.get(seq[i].id);
      if (slot && !tlCatHidden(seq[i])) film.appendChild(slot.el);
    }
    relayout();
    updateStrip();
  }
  function replayFn() {
    try { return root && root.ROLINK && typeof root.ROLINK.replayTool === "function" ? root.ROLINK.replayTool : null; } catch (e) { return null; }
  }
  function sessionStarted() {
    try {
      var st = root && root.ROLINK && typeof root.ROLINK.status === "function" ? root.ROLINK.status() : null;
      return !!(st && (st.started || st.running));
    } catch (e) { return false; }
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
    if (document.getElementById(TL_ID)) { mounted = true; wireBus(); return true; }

    tlEl = mk("div", "rl-timeline rl-collapsed");
    tlEl.id = TL_ID;
    tlEl.innerHTML =
      '<div class="rl-tl-strip" id="rl-tl-strip">' +
        '<span class="rl-tl-dot"></span>' +
        '<span class="rl-tl-title">Timeline</span>' +
        '<span class="rl-tl-last" id="rl-tl-last">no tools yet</span>' +
        '<span class="rl-tl-count" id="rl-tl-count"></span>' +
        '<button class="rl-tl-btn" id="rl-tl-replay" title="Re-run this sequence (oldest first)">↻</button>' +
        '<button class="rl-tl-btn" id="rl-tl-toggle" title="Expand timeline">▲</button>' +
      "</div>" +
      '<div class="rl-tl-body">' +
        '<div class="rl-tl-head">' +
          '<span class="rl-tl-h-title">Tool sequence</span>' +
          '<span class="rl-tl-h-sub">width ∝ duration · hover to scrub</span>' +
          '<button class="rl-tl-btn" id="rl-tl-follow" title="Follow live (auto-scroll to newest)">⬇</button>' +
          '<button class="rl-tl-btn" id="rl-tl-clear" title="Clear timeline view">⌫</button>' +
        "</div>" +
        '<div class="rl-tl-film" id="rl-tl-film"></div>' +
      "</div>" +
      '<div class="rl-tl-tip" id="rl-tl-tip" style="display:none"></div>' +
      '<div class="rl-tl-toast" id="rl-tl-toast" style="display:none"></div>';
    h.appendChild(tlEl);

    stripEl = tlEl.querySelector("#rl-tl-strip");
    lastEl = tlEl.querySelector("#rl-tl-last");
    countEl = tlEl.querySelector("#rl-tl-count");
    tipEl = tlEl.querySelector("#rl-tl-tip");
    toastEl = tlEl.querySelector("#rl-tl-toast");
    followBtn = tlEl.querySelector("#rl-tl-follow");

    stripEl.addEventListener("click", function (e) {
      if (e.target && e.target.closest && e.target.closest("#rl-tl-replay")) return;
      e.stopPropagation();
      toggle();
    });
    tlEl.querySelector("#rl-tl-toggle").addEventListener("click", function (e) { e.stopPropagation(); toggle(); });
    tlEl.querySelector("#rl-tl-replay").addEventListener("click", function (e) { e.stopPropagation(); replayAll(); });
    followBtn.addEventListener("click", function (e) { e.stopPropagation(); setFollow(!follow); });
    tlEl.querySelector("#rl-tl-clear").addEventListener("click", function (e) { e.stopPropagation(); clearView(); });

    var film = tlEl.querySelector("#rl-tl-film");
    film.addEventListener("scroll", function () {
      // Manual scrub disengages follow; re-engage via the follow button.
      if (!mounted || follow === false) return;
      try {
        if (film.scrollLeft + film.clientWidth < film.scrollWidth - 24) setFollow(false, true);
      } catch (e) {}
    });

    restoreOpen();
    applyOpen();
    setFollow(true, true);
    wireBus();
    // P4: category toggles — rebuild the filmstrip when options change.
    try {
      var reg = root && root.ROLINK_TOOL_REGISTRY;
      if (reg) {
        if (typeof reg.readHiddenCats === "function") {
          reg.readHiddenCats(function () { rebuild(); });
        }
        if (typeof reg.onHiddenChange === "function") {
          reg.onHiddenChange(function () { rebuild(); });
        }
      }
    } catch (e) {}
    try {
      var b = bus();
      if (b && typeof b.recent === "function") {
        var evts = orderEvents(b.recent(50));
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

  function unmount() {
    try { if (busUnsub) busUnsub(); } catch (e) {}
    busUnsub = null;
    try { if (rootObserver) rootObserver.disconnect(); } catch (e) {}
    rootObserver = null;
    try { var n = document.getElementById(TL_ID); if (n && n.parentNode) n.parentNode.removeChild(n); } catch (e) {}
    tlEl = stripEl = tipEl = toastEl = lastEl = countEl = followBtn = null;
    blocks.clear();
    mounted = false;
  }

  // ── open / follow ──────────────────────────────────────────────────
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
      if (!tlEl) return;
      tlEl.classList.toggle("rl-collapsed", !open);
      var t = tlEl.querySelector("#rl-tl-toggle");
      if (t) { t.textContent = open ? "▼" : "▲"; t.title = open ? "Collapse timeline" : "Expand timeline"; }
    } catch (e) {}
  }
  function toggle(force) {
    open = typeof force === "boolean" ? force : !open;
    applyOpen();
    persistOpen();
    return open;
  }
  function isOpen() { return mounted && open; }
  function setFollow(v, silent) {
    follow = !!v;
    try {
      if (followBtn) {
        followBtn.classList.toggle("off", !follow);
        followBtn.title = follow ? "Follow live — auto-scroll (on)" : "Follow live — paused (off)";
      }
      if (follow && !silent) {
        var film = tlEl && tlEl.querySelector("#rl-tl-film");
        if (film) film.scrollLeft = film.scrollWidth;
      }
    } catch (e) {}
  }

  function clearView() {
    try {
      blocks.forEach(function (slot) {
        try { if (slot.el.parentNode) slot.el.parentNode.removeChild(slot.el); } catch (e) {}
      });
    } catch (e) {}
    blocks.clear();
    updateStrip();
  }

  // ── feed ───────────────────────────────────────────────────────────
  function wireBus() {
    if (busUnsub) return;
    try {
      var b = bus();
      if (b && typeof b.subscribe === "function") busUnsub = b.subscribe(function (ev) { onEvent(ev); });
    } catch (e) {}
  }

  function maxDuration() {
    var m = 0;
    blocks.forEach(function (s) {
      if (typeof s.ev.durationMs === "number" && s.ev.durationMs > m) m = s.ev.durationMs;
    });
    return m;
  }

  function onEvent(ev, silent) {
    if (!ev || !ev.id || !mounted) return;
    var slot = blocks.get(ev.id);
    if (slot) {
      slot.ev = ev;
      paintBlock(slot);
      relayout();
    } else {
      var el = buildBlock(ev);
      blocks.set(ev.id, { ev: ev, el: el });
      if (!tlCatHidden(ev)) {
        // Chronological insert: find first block with a later startTime.
        var film = tlEl.querySelector("#rl-tl-film");
        var ids = Array.from(blocks.keys());
        var placed = false;
        for (var i = 0; i < ids.length; i++) {
          var o = blocks.get(ids[i]);
          if (o && o.el !== el && (o.ev.startTime || 0) > (ev.startTime || 0) && o.el.parentNode === film) {
            film.insertBefore(el, o.el);
            placed = true;
            break;
          }
        }
        if (!placed && film) film.appendChild(el);
      }
      while (blocks.size > MAX_BLOCKS) {
        // Evict the oldest by startTime.
        var oldest = null, oldestT = Infinity;
        blocks.forEach(function (s, id) {
          var t = s.ev.startTime || 0;
          if (t < oldestT) { oldestT = t; oldest = id; }
        });
        if (oldest == null) break;
        var ds = blocks.get(oldest);
        try { if (ds.el.parentNode) ds.el.parentNode.removeChild(ds.el); } catch (e) {}
        blocks.delete(oldest);
      }
      relayout();
    }
    updateStrip();
    if (follow && !silent) {
      try {
        var f = tlEl.querySelector("#rl-tl-film");
        if (f) f.scrollLeft = f.scrollWidth;
      } catch (e) {}
    }
    if (!reducedMotion() && !silent && ev.status === "error") {
      try {
        var s2 = blocks.get(ev.id);
        if (s2) {
          s2.el.classList.remove("rl-tl-shake");
          void s2.el.offsetWidth;
          s2.el.classList.add("rl-tl-shake");
        }
      } catch (e) {}
    }
  }

  function relayout() {
    var m = maxDuration();
    blocks.forEach(function (slot) {
      try { slot.el.style.width = blockWidth(slot.ev, m) + "px"; } catch (e) {}
    });
  }

  function updateStrip() {
    try {
      var n = blocks.size;
      var latest = null;
      blocks.forEach(function (s) {
        if (!latest || (s.ev.startTime || 0) > (latest.startTime || 0)) latest = s.ev;
      });
      if (countEl) countEl.textContent = n ? n + " tool" + (n === 1 ? "" : "s") : "";
      if (lastEl) {
        lastEl.textContent = latest
          ? latest.tool + " · " + (latest.status || "?") + (typeof latest.durationMs === "number" ? " · " + formatDuration(latest.durationMs) : "")
          : "no tools yet";
        lastEl.setAttribute("data-s", latest ? latest.status : "");
      }
      var dot = tlEl && tlEl.querySelector(".rl-tl-dot");
      if (dot) {
        var running = false;
        blocks.forEach(function (s) { if (s.ev.status === "running" || s.ev.status === "queued") running = true; });
        dot.setAttribute("data-live", running ? "1" : "0");
      }
    } catch (e) {}
  }

  // ── blocks + scrub tooltip ─────────────────────────────────────────
  function buildBlock(ev) {
    var meta = entryFor(ev.tool);
    var b = mk("button", "rl-tl-block");
    b.type = "button";
    b.setAttribute("data-id", ev.id);
    b.setAttribute("data-status", ev.status || "queued");
    b.style.setProperty("--cat", meta.color);
    b.title = "";
    paintBlock({ ev: ev, el: b });
    b.addEventListener("mouseenter", function () { showTip(b, ev); });
    b.addEventListener("mouseleave", function () { hideTip(); });
    b.addEventListener("focus", function () { showTip(b, blocks.get(ev.id) ? blocks.get(ev.id).ev : ev); });
    b.addEventListener("blur", function () { hideTip(); });
    b.addEventListener("click", function (e) {
      e.stopPropagation();
      replayOne(blocks.get(ev.id) ? blocks.get(ev.id).ev : ev, b);
    });
    return b;
  }

  function paintBlock(slot) {
    var ev = slot.ev, b = slot.el;
    var meta = entryFor(ev.tool);
    try {
      b.setAttribute("data-status", ev.status || "queued");
      b.style.setProperty("--cat", meta.color);
      b.style.width = blockWidth(ev, maxDuration()) + "px";
      b.innerHTML =
        '<span class="rl-tl-bname">' + esc(ev.tool) + "</span>" +
        '<span class="rl-tl-bdur">' +
          (ev.status === "running" ? "…" : esc(formatDuration(ev.durationMs))) +
        "</span>" +
        '<span class="rl-tl-replay" title="Re-run ' + esc(ev.tool) + '">↻</span>';
    } catch (e) {}
  }

  function tipHtml(ev) {
    var meta = entryFor(ev.tool);
    var res = ev.result == null ? "" : (typeof ev.result === "string" ? ev.result : JSON.stringify(ev.result));
    if (res && res.length > 200) res = res.slice(0, 199) + "…";
    return '<div class="rl-tl-tip-t"><span class="rl-tl-tip-dot" style="--cat:' + esc(meta.color) + '"></span>' +
      "<b>" + esc(ev.tool) + "</b><span>" + esc(meta.category) + " · " + esc(ev.status || "?") + "</span></div>" +
      '<div class="rl-tl-tip-args">' + esc(summarizeArgs(ev.args) || "—") + "</div>" +
      '<div class="rl-tl-tip-res">' + esc(res || (TERMINAL[ev.status] ? "—" : "running…")) + "</div>" +
      '<div class="rl-tl-tip-foot">' + esc(formatDuration(ev.durationMs)) + " · click block to re-run</div>";
  }

  function showTip(anchor, ev) {
    if (!tipEl || !anchor) return;
    try {
      tipEl.innerHTML = tipHtml(ev);
      tipEl.style.display = "";
      var hostRect = tlEl.getBoundingClientRect();
      var r = anchor.getBoundingClientRect();
      var x = Math.min(
        Math.max(8, r.left - hostRect.left + r.width / 2 - 130),
        Math.max(8, hostRect.width - 268)
      );
      tipEl.style.left = x + "px";
      tipEl.style.bottom = "100%";
      tipEl.style.top = "auto";
    } catch (e) {}
  }
  function hideTip() {
    try { if (tipEl) tipEl.style.display = "none"; } catch (e) {}
  }

  function toast(msg) {
    try {
      if (!toastEl) return;
      toastEl.textContent = String(msg);
      toastEl.style.display = "";
      setTimeout(function () { try { toastEl.style.display = "none"; } catch (e) {} }, 2400);
    } catch (e) {}
  }

  // ── replay ─────────────────────────────────────────────────────────
  function replayOne(ev, anchor) {
    if (!ev) return Promise.resolve(false);
    var fn = replayFn();
    if (!fn) { toast("Replay needs the agent — reload the page"); return Promise.resolve(false); }
    if (!sessionStarted()) { toast("Click Start first, then replay"); return Promise.resolve(false); }
    if (isReplaying) { toast("Replay already running…"); return Promise.resolve(false); }
    toast("Re-running " + ev.tool + "…");
    try {
      var r = fn(ev.tool, ev.args || {});
      if (r && typeof r.then === "function") {
        return r.then(function () { toast("✓ " + ev.tool + " done"); return true; },
          function (e) { toast("✗ " + ev.tool + ": " + String((e && e.message) || e).slice(0, 80)); return false; });
      }
      return Promise.resolve(true);
    } catch (e) {
      toast("✗ replay failed");
      return Promise.resolve(false);
    }
  }

  function replayAll() {
    var fn = replayFn();
    if (!fn) { toast("Replay needs the agent — reload the page"); return Promise.resolve(); }
    if (!sessionStarted()) { toast("Click Start first, then replay"); return Promise.resolve(); }
    if (isReplaying) { toast("Replay already running…"); return Promise.resolve(); }
    var seq = orderEvents(Array.from(blocks.values()).map(function (s) { return s.ev; }));
    if (!seq.length) { toast("Nothing to replay yet"); return Promise.resolve(); }
    isReplaying = true;
    setOpen(true);
    toast("Re-running " + seq.length + " tools…");
    var i = 0;
    function next() {
      if (i >= seq.length) {
        isReplaying = false;
        toast("✓ sequence done (" + seq.length + ")");
        return Promise.resolve();
      }
      var ev = seq[i++];
      toast("[" + i + "/" + seq.length + "] " + ev.tool + "…");
      var p;
      try { p = Promise.resolve(fn(ev.tool, ev.args || {})); }
      catch (e) { p = Promise.resolve(); }
      return p.then(function () {
        return new Promise(function (res) { setTimeout(res, REPLAY_GAP_MS); });
      }).then(next);
    }
    return next().catch(function () { isReplaying = false; });
  }

  // ── boot ───────────────────────────────────────────────────────────
  function boot() {
    if (typeof document === "undefined") return;
    try {
      if (!mount()) observeRoot();
    } catch (e) {}
  }

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", boot);
    } else {
      boot();
    }
    setTimeout(function () { try { if (!mounted) mount(); } catch (e) {} }, 3000);
  }

  var api = {
    mount: mount,
    unmount: unmount,
    clearView: clearView,
    toggle: toggle,
    isOpen: isOpen,
    replayAll: replayAll,
    orderEvents: orderEvents,
    blockWidth: blockWidth,
    summarizeArgs: summarizeArgs
  };
  if (root) root.RolinkTimeline = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
