// SPDX-License-Identifier: GPL-3.0-or-later
// background.js - service worker.
// Owns ONE resilient WebSocket to the local bridge (ws://127.0.0.1:PORT).
// Keeping the socket here (not in the content script) avoids https→ws mixed
// content issues and centralises reconnect / timeout logic.
//
// Contract with content.js: every sendMessage ALWAYS gets a response object,
// even when the bridge is offline. The agentic loop must never hang waiting.

const PORT = 17613;
const DEFAULT_BRIDGE_URL = `ws://127.0.0.1:${PORT}`;
// The options page persists the endpoint. Resolve it asynchronously at worker
// startup, but keep the loopback-only default so a malformed saved value can
// never turn this local bridge into a remote WebSocket client.
let BRIDGE_URL = DEFAULT_BRIDGE_URL;
function isLoopbackBridgeUrl(value) {
  try {
    const u = new URL(String(value || ""));
    return (u.protocol === "ws:" || u.protocol === "wss:") &&
      (u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "::1");
  } catch (_) { return false; }
}
try {
  chrome.storage.local.get(["bridgeUrl"], (v) => {
    if (isLoopbackBridgeUrl(v && v.bridgeUrl)) BRIDGE_URL = v.bridgeUrl;
    connect();
  });
} catch (_) { connect(); }

// Chat sites where a RoLink provider content script runs. Status pushes go
// to every tab matching these. Add the new provider's URL pattern here (and in
// manifest.json content_scripts + host_permissions) when integrating another AI.
const PROVIDER_URLS = ["https://chat.deepseek.com/*", "https://deepseek.com/*", "https://chatgpt.com/*", "https://chat.openai.com/*", "https://gemini.google.com/*", "https://www.kimi.ai/*", "https://kimi.ai/*", "https://chat.z.ai/*", "https://chat.qwen.ai/*", "https://arena.ai/*", "https://www.meta.ai/*", "https://meta.ai/*", "https://claude.ai/*", "https://huggingface.co/chat*", "https://dola.com/*", "https://www.dola.com/*"];

const RECONNECT_MIN = 1000;
const RECONNECT_MAX = 5000;
const HEARTBEAT_MS = 10000;
// If no message (incl. pong) arrives within this window while we believe we're
// connected, the socket is half-open: force a reconnect instead of letting
// pending requests slowly time out.
const STALE_SOCKET_MS = 25000;
const REQUEST_TIMEOUT_DEFAULT = 130000; // a bit above the 120s tool timeout

let ws = null;
let connected = false;
let reconnectDelay = RECONNECT_MIN;
let reconnectTimer = null;
let heartbeatTimer = null;
let lastMessageAt = 0; // timestamp of the last frame received from the bridge
let nextId = 1;
const pending = new Map(); // id -> {resolve, timer}
let toolsCache = [];
let mcpAlive = false;
let serversCache = [];
// Preset catalogue from the bridge (mcp-for-blender & co) plus the configured
// server list, so the settings page can render a "Blender" button without
// hard-coding a spawn spec in the extension. Cached on first fetch and
// refreshed whenever the bridge reconnects or a server is added/removed.
let presetsCache = [];
let mcpServersCache = [];
// true/false = a PLACE is loaded and usable in Roblox Studio; null = unknown.
// The MCP process stays alive when Studio is closed or its MCP option is off,
// so this is probed separately (bridge "studio_status").
let studioConnected = null;
// true/false = a Roblox Studio app is connected to the MCP server at all; null =
// unknown. studioApp=true with studioConnected=false means "Studio open but no
// place"; studioApp=false means "Studio closed OR its MCP option disabled".
let studioApp = null;
// true/false = a Roblox Studio WINDOW/PROCESS exists on this machine (checked
// bridge-side via tasklist); null = unknown/old bridge. Distinguishes the two
// studioApp=false sub-cases the UI must word differently: Studio genuinely not
// launched ("open Roblox Studio") vs Studio OPEN but its MCP plugin never
// registered with the bridge - the documented fix for the latter is opening
// Assistant Settings > MCP Servers inside Studio (validated live 3x), which
// "open Roblox Studio" wording completely fails to convey.
let studioProc = null;
// Catalog the bridge advertises (119 when its tests/__registry__.json loaded).
// If the live list is shorter, the bridge is old or its folder is incomplete -
// surface it instead of silently serving a stale short list (the "27 tools"
// trap: the prompt names 119+ but list_commands returns only Studio-native).
let catalogTotal = 0;
let catalogLoaded = false;
let pluginState = null;

function log(...a) {
  console.log("[rl-bg]", ...a);
}

// ── WebSocket lifecycle ─────────────────────────────────────────────────
function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  clearTimeout(reconnectTimer);
  try {
    ws = new WebSocket(BRIDGE_URL);
  } catch (e) {
    log("WebSocket ctor failed", e);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    connected = true;
    reconnectDelay = RECONNECT_MIN;
    lastMessageAt = Date.now();
    log("connected to bridge");
    startHeartbeat();
    broadcastStatus();
  };

  ws.onmessage = (ev) => {
    lastMessageAt = Date.now();
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    handleBridgeMessage(msg);
  };

  ws.onclose = () => {
    connected = false;
    mcpAlive = false;
    studioConnected = null;
    studioApp = null;
    studioProc = null;
    serversCache = [];
    // NOTE: presetsCache / mcpServersCache are deliberately NOT cleared here.
    // They describe config.json + the machine's PATH, not the socket: a dropped
    // socket does not un-install Blender, and blanking them would make the
    // settings page's "Add Blender" button disappear exactly when the user most
    // needs it (the bridge is down / mid-restart). They are re-fetched on the
    // next successful list_mcp_servers.
    catalogTotal = 0;
    catalogLoaded = false;
    pluginState = null;
    stopHeartbeat();
    failAllPending("bridge connection closed");
    broadcastStatus();
    scheduleReconnect();
  };

  ws.onerror = () => {
    // onclose will follow; nothing to do here but avoid an unhandled error.
    try { ws.close(); } catch {}
  };
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 1.7, RECONNECT_MAX);
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (connected) {
      // Half-open socket: the WS still reports OPEN but nothing comes through.
      // The pong (and every other frame) refreshes lastMessageAt; if it has
      // gone stale, drop the dead socket so onclose triggers a reconnect.
      if (lastMessageAt && Date.now() - lastMessageAt > STALE_SOCKET_MS) {
        log("socket stale, forcing reconnect");
        try { ws.close(); } catch {}
        return;
      }
      // Keeps the MV3 service worker alive AND detects a half-open socket.
      send({ type: "ping" }).catch(() => {});
      refreshStudioStatus();
    }
  }, HEARTBEAT_MS);
}

function stopHeartbeat() {
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

// Resolve once the socket is OPEN, or false after `timeout` ms.
function waitForConnection(timeout = 8000) {
  return new Promise((resolve) => {
    if (connected && ws && ws.readyState === WebSocket.OPEN) return resolve(true);
    connect(); // nudge a (re)connection - important after a worker wake-up
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (connected && ws && ws.readyState === WebSocket.OPEN) {
        clearInterval(iv);
        resolve(true);
      } else if (Date.now() - t0 > timeout) {
        clearInterval(iv);
        resolve(false);
      }
    }, 100);
  });
}

// ── request/response over the socket ────────────────────────────────────
async function send(obj, timeout = REQUEST_TIMEOUT_DEFAULT) {
  // The MV3 service worker can be suspended; the first message after a wake-up
  // arrives before the socket has re-opened. Wait for it instead of failing -
  // otherwise Kimi wrongly hears "bridge offline".
  if (!connected || !ws || ws.readyState !== WebSocket.OPEN) {
    await waitForConnection(8000);
  }
  return new Promise((resolve) => {
    if (!connected || !ws || ws.readyState !== WebSocket.OPEN) {
      resolve({ ok: false, kind: "disconnected", error: "bridge not connected" });
      return;
    }
    const id = nextId++;
    const payload = { ...obj, id };
    const timer = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        resolve({ ok: false, kind: "timeout", error: "bridge did not respond in time" });
      }
    }, timeout);
    pending.set(id, { resolve, timer });
    try {
      ws.send(JSON.stringify(payload));
    } catch (e) {
      clearTimeout(timer);
      pending.delete(id);
      resolve({ ok: false, kind: "disconnected", error: String(e) });
    }
  });
}

// Ask the bridge whether a Roblox Studio instance is actually connected to the
// MCP server. Broadcasts only on change so the UI updates promptly but quietly.
let studioProbing = false;
async function refreshStudioStatus() {
  if (studioProbing || !connected) return;
  studioProbing = true;
  try {
    const r = await send({ type: "studio_status" }, 12000);
    const v = r && r.ok && typeof r.studio === "boolean" ? r.studio : null;
    if (v !== studioConnected) {
      studioConnected = v;
      broadcastStatus();
    }
  } finally {
    studioProbing = false;
  }
}

function handleBridgeMessage(msg) {
  if ("studio" in msg && (typeof msg.studio === "boolean" || msg.studio === null)) {
    studioConnected = msg.studio;
  }
  if ("studio_app" in msg && (typeof msg.studio_app === "boolean" || msg.studio_app === null)) {
    studioApp = msg.studio_app;
  }
  if ("studio_proc" in msg && (typeof msg.studio_proc === "boolean" || msg.studio_proc === null)) {
    studioProc = msg.studio_proc;
  }
  if (msg.type === "studio_status") {
    resolvePending(msg.id, { ok: true, studio: studioConnected });
    broadcastStatus();
    return;
  }
  if (msg.type === "connected") {
    mcpAlive = !!msg.mcp_alive;
    if (Array.isArray(msg.tools)) toolsCache = msg.tools;
    if (Array.isArray(msg.servers)) serversCache = msg.servers;
    if (typeof msg.catalog_total === "number") catalogTotal = msg.catalog_total;
    if (typeof msg.catalog_loaded === "boolean") catalogLoaded = msg.catalog_loaded;
    if (msg.plugin && typeof msg.plugin === "object") pluginState = msg.plugin;
    broadcastStatus();
    return;
  }
  if (msg.type === "pong") {
    resolvePending(msg.id, { ok: true });
    return;
  }
  if (msg.type === "tools") {
    if (Array.isArray(msg.tools)) toolsCache = msg.tools;
    if (Array.isArray(msg.servers)) serversCache = msg.servers;
    mcpAlive = !!msg.mcp_alive;
    resolvePending(msg.id, { ok: true, tools: toolsCache });
    broadcastStatus();
    return;
  }
  if (msg.type === "tool_result") {
    resolvePending(msg.id, msg.ok
      ? { ok: true, text: msg.text, images: msg.images || [], tool: msg.tool, server: msg.server }
      : { ok: false, kind: msg.kind, error: msg.error, tool: msg.tool, server: msg.server });
    return;
  }
  if (msg.type === "mcp_status") {
    mcpAlive = !!msg.alive;
    if (Array.isArray(msg.tools)) toolsCache = msg.tools;
    if (Array.isArray(msg.servers)) serversCache = msg.servers;
    resolvePending(msg.id, { ok: !!msg.ok, alive: msg.alive, error: msg.error });
    broadcastStatus();
    return;
  }
  if (msg.type === "mcp_servers") {
    // Settings-page view of config.json + the preset catalogue. Not an error
    // channel: ok:false here still carries whatever the bridge could read.
    if (Array.isArray(msg.servers)) mcpServersCache = msg.servers;
    if (Array.isArray(msg.presets)) presetsCache = msg.presets;
    resolvePending(msg.id, {
      ok: !!msg.ok, error: msg.error,
      mcp_servers: mcpServersCache, presets: presetsCache,
    });
    return;
  }
  if (msg.type === "server_changed") {
    // Either path ends in a config.json change: `restarting` is true only when
    // the bridge had to restart itself (add_server / remove_server / a preset
    // it could not hot-load), false when it loaded the new server in place.
    // The content script shows a spinner only for the restart case.
    if (Array.isArray(msg.servers)) serversCache = msg.servers;
    if (msg.ok) {
      // A write landed: the cached config view is now stale, so re-read it
      // instead of letting the next page load replay pre-write state. The
      // re-read REPLACES the cache through the mcp_servers branch above, and
      // the settings page updates even if its caller does not re-render.
      send({ type: "list_mcp_servers" }, 20000).catch(() => {});
      broadcastStatus();
    }
    resolvePending(msg.id, {
      ok: !!msg.ok, error: msg.error, restarting: !!msg.restarting,
      server_id: msg.server_id, preset: msg.preset,
      available: msg.available, hint: msg.hint,
    });
    return;
  }
  if (msg.type === "error") {
    resolvePending(msg.id, { ok: false, error: msg.error });
    return;
  }
}

function resolvePending(id, value) {
  const p = pending.get(id);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(id);
  p.resolve(value);
}

function failAllPending(reason) {
  for (const [, p] of pending) {
    clearTimeout(p.timer);
    p.resolve({ ok: false, kind: "disconnected", error: reason });
  }
  pending.clear();
}

// ── status push to any open DeepSeek tab + popup ─────────────────────────
function statusObj() {
  const catalogWarn = connected && catalogTotal > 0 && toolsCache.length < catalogTotal;
  return { type: "rl-status", connected, mcpAlive, studio: studioConnected, studioApp, studioProc, tools: toolsCache.length, servers: serversCache, catalogTotal, catalogLoaded, catalogWarn, plugin: pluginState, presets: presetsCache };
}

function broadcastStatus() {
  chrome.runtime.sendMessage(statusObj()).catch(() => {});
  chrome.tabs.query({ url: PROVIDER_URLS }, (tabs) => {
    for (const t of tabs) chrome.tabs.sendMessage(t.id, statusObj()).catch(() => {});
  });
}

// ── messages from content.js / popup.js ─────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case "status":
        if (!connected) connect(); // self-heal after a worker wake-up
        sendResponse(statusObj());
        break;
      case "list_tools": {
        // Prefer a live refresh; fall back to cache so the loop never stalls.
        // 10s, not 25s: a catalogue request only blocks this long when one of the
        // MCP servers is dead (typically Roblox in a degraded, Blender-only
        // session), and in that exact case we already hold a perfectly good cached
        // catalogue. Waiting the full 25s just froze the boot for no new data.
        const r = await send({ type: "list_tools" }, 10000);
        if (r.ok) sendResponse({ ok: true, tools: r.tools });
        else sendResponse({ ok: toolsCache.length > 0, tools: toolsCache, error: r.error });
        break;
      }
      case "call_tool": {
        const timeout = (msg.timeout || 120000) + 10000;
        const r = await send(
          { type: "call_tool", name: msg.name, arguments: msg.arguments, timeout: msg.timeout },
          timeout
        );
        sendResponse(r);
        break;
      }
      case "restart_mcp": {
        const r = await send({ type: "restart_mcp" }, 30000);
        sendResponse(r);
        break;
      }
      case "list_mcp_servers": {
        // Serves the settings page: the configured servers (command + env KEY
        // names only, never values) and the preset catalogue with per-machine
        // availability. Falls back to the last good answer when the bridge is
        // offline, so the page still renders instead of going blank.
        const r = await send({ type: "list_mcp_servers" }, 20000);
        if (r && r.mcp_servers) {
          sendResponse(r);
        } else {
          sendResponse({
            ok: mcpServersCache.length > 0 || presetsCache.length > 0,
            mcp_servers: mcpServersCache, presets: presetsCache,
            error: (r && r.error) || "bridge offline - showing the last known server list",
          });
        }
        break;
      }
      case "add_preset": {
        // Opt-in: writes the reviewed spawn spec into config.json and has the
        // bridge load that one server in place (restarting only if it cannot).
        // 60s, not 15s: the write itself is instant but the bridge may fall
        // back to a self-restart, and the extension must not report a timeout
        // for an install that actually succeeded.
        const r = await send({
          type: "add_preset", preset: msg.preset,
          server_id: msg.server_id, env: msg.env,
        }, 60000);
        sendResponse(r);
        break;
      }
      case "add_server": {
        const r = await send({
          type: "add_server", server_id: msg.server_id,
          command: msg.command, args: msg.args, env: msg.env,
        }, 15000);
        sendResponse(r);
        break;
      }
      case "remove_server": {
        const r = await send({ type: "remove_server", server_id: msg.server_id }, 15000);
        sendResponse(r);
        break;
      }
      case "version":
        // The options page shows the installed build here; before this existed
        // the badge stayed on its hardcoded fallback forever.
        sendResponse({ ok: true, version: chrome.runtime.getManifest().version });
        break;
      case "open_options":
        // A content script runs on the AI site's origin and cannot open a
        // chrome-extension:// page itself (blocked by the page's own CSP), so
        // the in-page "Extension settings" row routes the request here.
        try { chrome.runtime.openOptionsPage(); sendResponse({ ok: true }); }
        catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
        break;
      case "reconnect":
        reconnectDelay = RECONNECT_MIN;
        connect();
        sendResponse({ ok: true });
        break;
      default:
        sendResponse({ ok: false, error: "unknown message" });
    }
  })();
  return true; // async sendResponse
});

// Wake/keepalive hooks.
chrome.runtime.onStartup.addListener(() => {
  try {
    chrome.storage.local.get(["bridgeUrl"], (v) => {
      if (isLoopbackBridgeUrl(v && v.bridgeUrl)) BRIDGE_URL = v.bridgeUrl;
      connect();
    });
  } catch (_) { connect(); }
});
chrome.runtime.onInstalled.addListener(() => {
  try {
    chrome.storage.local.get(["bridgeUrl"], (v) => {
      if (isLoopbackBridgeUrl(v && v.bridgeUrl)) BRIDGE_URL = v.bridgeUrl;
      connect();
    });
  } catch (_) { connect(); }
});
