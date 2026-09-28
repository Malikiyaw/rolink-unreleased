// SPDX-License-Identifier: GPL-3.0-or-later
document.getElementById("ver").textContent = `v${chrome.runtime.getManifest().version}`;

function render(s) {
  const dot = document.getElementById("dot");
  const state = document.getElementById("state");
  const tools = document.getElementById("tools");
  const servers = document.getElementById("servers");
  const list = s.servers || [];
  const up = list.filter((x) => x.alive).length;
  const mcpOk = s.connected && (s.mcpAlive || up > 0 || s.tools > 0);
  const studioOff = mcpOk && s.studio === false; // MCP up but no Studio attached
  const ok = mcpOk && !studioOff;
  dot.className = "dot " + (s.connected ? (ok ? "on" : "warn") : "");
  state.textContent = s.connected
    ? (ok ? "Connected · Roblox Studio ready"
        : studioOff ? "Studio not connected · enable the MCP server in Studio"
        : "Bridge OK · open Roblox Studio")
    : "Bridge offline";
  tools.textContent = s.connected ? `${s.tools || 0} tools available` : "Run bridge.py";
  if (s.connected && s.catalogWarn) {
    tools.textContent += ` (full catalog ${s.catalogTotal} — bridge folder incomplete or outdated, re-extract the zip clean)`;
  }
  const plug = s.plugin;
  if (s.connected && plug) {
    const age = plug.age_s == null ? "never seen" : (plug.alive ? "polling" : `stale ${plug.age_s}s`);
    const ver = plug.version ? ` v${plug.version}` : "";
    let suffix = ` | Plugin${ver}: ${age}`;
    const extVer = chrome.runtime.getManifest().version;
    if (plug.age_s != null && (!plug.version || plug.version !== extVer)) {
      suffix += " — update the Studio plugin (re-run install-plugin.bat, restart Studio)";
    }
    tools.textContent += suffix;
  }
  // A namespaced addon (blender/*) is labelled with its namespace so a dead
  // "blender ○" is never confused with a Roblox command of the same name, and
  // a launch failure (e.g. "uvx not on PATH") is shown instead of a bare "down"
  // - the difference between an unactionable dot and an obvious fix.
  servers.textContent = s.connected
    ? list.map((x) => {
        const ns = (x.meta && x.meta.namespace) || x.namespace;
        const tag = ns ? ` ${ns}/*` : "";
        const why = x.error ? ` - ${x.error}` : "";
        return `${x.alive ? "●" : "○"} ${x.id}${tag} (${x.alive ? x.tools + " tools" : "down"})${why}`;
      }).join("\n")
    : "";
}

function refresh() {
  chrome.runtime.sendMessage({ type: "status" }, (s) => s && render(s));
}

document.getElementById("reconnect").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "reconnect" }, () => setTimeout(refresh, 600));
});
document.getElementById("restart").addEventListener("click", (e) => {
  e.target.textContent = "Restarting…";
  chrome.runtime.sendMessage({ type: "restart_mcp" }, () => {
    e.target.textContent = "⟳ Restart Roblox server";
    setTimeout(refresh, 600);
  });
});
document.getElementById("settings").addEventListener("click", () => {
  // The settings page (endpoints, MCP servers, the Blender preset button, HUD
  // categories) is the real destination for "Settings". It used to be
  // unreachable: options.html was never declared in the manifest and nothing
  // called openOptionsPage, so this button opened the in-page ⋯ panel instead
  // and the whole page was dead code reachable only by typing the URL.
  //
  // openOptionsPage opens the extension's own tab (chrome-extension://...),
  // which a content script's page could never do - that is why this lives here.
  // The in-page panel stays one click away on the RoLink bar.
  if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "rl-status") render(msg);
});
refresh();
setInterval(refresh, 2000);
