// SPDX-License-Identifier: GPL-3.0-or-later
// rolink-extension/options.js — settings + multi-MCP server form.

const b = document.getElementById("bridge");
const m = document.getElementById("mcp");
const s = document.getElementById("status");
const ver = document.getElementById("ver");
chrome.storage.local.get(["bridgeUrl", "mcpUrl"], v => {
  if (v.bridgeUrl) b.value = v.bridgeUrl;
  if (v.mcpUrl) m.value = v.mcpUrl;
});
chrome.runtime.sendMessage({ type: "version" }, r => {
  if (r && r.version) ver.textContent = "v" + r.version;
});

function save() {
  chrome.storage.local.set({ bridgeUrl: b.value.trim(), mcpUrl: m.value.trim() }, () => {
    s.textContent = "Saved";
    s.className = "status ok";
    setTimeout(() => { s.textContent = ""; s.className = "status"; }, 1800);
  });
}
document.getElementById("save").onclick = save;
b.onkeydown = m.onkeydown = e => { if (e.key === "Enter") save(); };
document.getElementById("reset").onclick = () => {
  b.value = "ws://127.0.0.1:17613";
  m.value = "http://127.0.0.1:3001";
  save();
};

// ── multi-MCP server list (Phase 5a) ────────────────────────────────
const listEl = document.getElementById("mcpServerList");
const presetsEl = document.getElementById("mcpPresets");
const mcpStatusEl = document.getElementById("mcpStatus");
let mcpServers = [];
let mcpPresets = [];

function renderMcpList() {
  if (!Array.isArray(mcpServers) || !mcpServers.length) {
    listEl.innerHTML = '<p class="desc">No additional MCP servers configured.</p>';
    return;
  }
  listEl.innerHTML = mcpServers.map(s => {
    const id = escapeHtml(s.id || s.server_id || "?");
    const cmd = escapeHtml(s.command || "");
    const args = escapeHtml((s.args || []).join(" "));
    // env_values are NEVER sent by the bridge (they can hold API keys) - only
    // the key names, which is what tells a user "BLENDER_PORT is not set"
    // without ever putting a secret on screen or into the DOM.
    const envKeys = Array.isArray(s.env_keys) && s.env_keys.length
      ? ` <span style="opacity:.75">env: ${escapeHtml(s.env_keys.join(", "))}</span>` : "";
    // A launch failure (e.g. "uvx not on PATH") is the difference between an
    // unactionable "offline" and an obvious fix, so it is shown verbatim.
    const why = s.error
      ? `<div style="font-size:11px;color:var(--red);margin-top:4px">${escapeHtml(s.error)}</div>` : "";
    const ns = s.namespace
      ? ` <span class="status" style="font-weight:400">${escapeHtml(s.namespace)}/*</span>` : "";
    const alive = s.alive === false ? "○ offline" : "● ready";
    const row = `
      <div class="row" style="margin:6px 0;padding:8px;background:#0d1117;border:1px solid var(--border);border-radius:6px">
        <div style="flex:1;min-width:0">
          <div style="font-weight:600">${id}${ns} <span class="status" style="font-weight:400">${alive}</span></div>
          <div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${cmd} ${args}${envKeys}</div>
          ${why}
        </div>
        <button class="danger" data-remove="${id}">Remove</button>
      </div>`;
    return row;
  }).join("");
  listEl.querySelectorAll("[data-remove]").forEach(btn => {
    btn.onclick = () => removeServer(btn.getAttribute("data-remove"));
  });
}

// Preset cards. Rendered from what the bridge reports, never from a copy of the
// spawn spec baked into the extension: the bridge owns the exact command/env,
// and a second copy here would be free to drift out of sync with it.
function renderPresets() {
  if (!Array.isArray(mcpPresets) || !mcpPresets.length) {
    presetsEl.innerHTML = '<p class="desc">No ready-made servers available. Start the bridge to load this list.</p>';
    return;
  }
  presetsEl.innerHTML = mcpPresets.map(p => {
    const id = escapeHtml(p.id);
    const cmd = escapeHtml([p.command].concat(p.args || []).filter(Boolean).join(" "));
    const env = p.env && Object.keys(p.env).length
      ? ` <span style="opacity:.75">env: ${escapeHtml(Object.keys(p.env).join(", "))}</span>` : "";
    const installed = !!p.installed;
    // "available" is the bridge's per-machine probe of the launcher (uvx). A
    // missing launcher is reported BEFORE the click rather than as a silent
    // server that starts and advertises nothing.
    const badge = installed
      ? '<span class="preset-badge on">installed</span>'
      : p.available
        ? '<span class="preset-badge">not added</span>'
        : '<span class="preset-badge off">missing ' + escapeHtml((p.missing || []).join(", ")) + '</span>';
    const note = installed ? ""
      : p.hint ? `<p class="preset-note warn">${escapeHtml(p.hint)}</p>`
      : p.notes ? `<p class="preset-note">${escapeHtml(p.notes)}</p>` : "";
    const nsNote = p.namespace
      ? `<p class="preset-note">Commands appear as <code>${escapeHtml(p.namespace)}/*</code> in RoLink.</p>` : "";
    const btn = installed ? "" :
      `<button class="primary" data-preset="${id}"${p.available ? "" : " disabled title=\"" + escapeHtml(p.hint || "") + "\""}>Add</button>`;
    return `
      <div class="preset${installed ? " installed" : ""}">
        <div class="preset-top">
          <span class="preset-name">${escapeHtml(p.label || id)}</span>
          ${badge}
        </div>
        <p class="preset-cmd">${cmd}${env}</p>
        <p class="preset-note">${escapeHtml(p.summary || "")}</p>
        ${nsNote}${note}
        <div class="preset-actions">${btn}<span class="status" data-preset-status="${id}"></span></div>
      </div>`;
  }).join("");
  presetsEl.querySelectorAll("[data-preset]").forEach(btn => {
    btn.onclick = () => addPreset(btn.getAttribute("data-preset"));
  });
}

// One preset status line ("Starting blender…"), independent of the shared
// banner, so a slow install does not blank out the other server's feedback.
function presetStatus(id, msg, err) {
  const el = presetsEl.querySelector(`[data-preset-status="${id}"]`);
  if (!el) return;
  el.textContent = msg;
  el.className = "status " + (err ? "err" : "ok");
  if (!msg) return;
  setTimeout(() => { if (el.textContent === msg) { el.textContent = ""; el.className = "status"; } }, 4000);
}

function addPreset(id) {
  const p = (mcpPresets || []).find(x => x.id === id);
  if (!p) { mcpStatus("Unknown server preset: " + id, true); return; }
  // The preset may create a new child process the next time the bridge calls
  // into Blender, and the bridge may need to restart itself: say so up front.
  if (!confirm("Add " + (p.label || id) + "?\n\n"
    + "This writes one entry to config.json and asks the bridge to load it.\n"
    + (p.notes ? p.notes + "\n" : "")
    + "Nothing is installed or launched until you click OK.")) return;
  presetStatus(id, "Adding…");
  chrome.runtime.sendMessage({ type: "add_preset", preset: id }, r => {
    if (r && r.ok) {
      // restarting:false means the bridge hot-loaded the server, so the tool
      // list is already updating and no reconnect wait is needed.
      presetStatus(id, r.restarting ? "Added - bridge restarting…" : "Added");
      mcpStatus("Added " + (p.label || id));
      setTimeout(refreshMcpList, r.restarting ? 4000 : 1200);
    } else {
      const err = (r && r.error) || "unknown error";
      presetStatus(id, "Add failed", true);
      mcpStatus("Add failed: " + err, true);
    }
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"})[c]);
}

function refreshMcpList() {
  chrome.runtime.sendMessage({ type: "list_mcp_servers" }, r => {
    mcpServers = (r && r.mcp_servers) || [];
    mcpPresets = (r && r.presets) || [];
    renderMcpList();
    renderPresets();
    if (r && r.error && !(r.mcp_servers || []).length) mcpStatus(r.error, true);
  });
}

function addServer() {
  const id = document.getElementById("newServerId").value.trim();
  const cmd = document.getElementById("newServerCmd").value.trim();
  const argsRaw = document.getElementById("newServerArgs").value.trim();
  const envRaw = document.getElementById("newServerEnv").value.trim();
  if (!id || !cmd) { mcpStatus("id and command required", true); return; }
  const args = argsRaw ? argsRaw.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [] : [];
  const env = {};
  if (envRaw) {
    for (const kv of envRaw.split(",")) {
      const i = kv.indexOf("=");
      if (i > 0) env[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
    }
  }
  chrome.runtime.sendMessage({ type: "add_server", server_id: id, command: cmd, args, env }, r => {
    if (r && r.ok) {
      mcpStatus("Added " + id);
      document.getElementById("newServerId").value = "";
      document.getElementById("newServerCmd").value = "";
      document.getElementById("newServerArgs").value = "";
      document.getElementById("newServerEnv").value = "";
      setTimeout(refreshMcpList, 800);
    } else {
      mcpStatus("Add failed: " + (r && r.error || "unknown"), true);
    }
  });
}

function removeServer(id) {
  if (!confirm("Remove MCP server '" + id + "'?")) return;
  chrome.runtime.sendMessage({ type: "remove_server", server_id: id }, r => {
    if (r && r.ok) { mcpStatus("Removed " + id); setTimeout(refreshMcpList, 800); }
    else mcpStatus("Remove failed: " + (r && r.error || "unknown"), true);
  });
}

function mcpStatus(msg, err) {
  mcpStatusEl.textContent = msg;
  mcpStatusEl.className = "status " + (err ? "err" : "ok");
  setTimeout(() => { mcpStatusEl.textContent = ""; mcpStatusEl.className = "status"; }, 2200);
}

document.getElementById("addServer").onclick = addServer;
refreshMcpList();

// ── Figma bridge status (Phase 5) ─────────────────────────────────
// figma_status is a bridge-local tool: it answers even with no Figma plugin
// polling, so this panel renders instead of going blank. It travels the
// generic call_tool path (background.js forwards name+arguments verbatim),
// so no background change was needed for Figma routing.
const figmaDot = document.getElementById("figmaDot");
const figmaStatusEl = document.getElementById("figmaStatus");
const figmaMetaEl = document.getElementById("figmaMeta");
const figmaNoteEl = document.getElementById("figmaNote");
const figmaMsgEl = document.getElementById("figmaMsg");

function figmaPaint(color, status, meta, note) {
  figmaDot.style.background = color;
  figmaStatusEl.textContent = status;
  figmaMetaEl.textContent = meta || "";
  figmaNoteEl.textContent = note || "";
}

function refreshFigmaStatus() {
  chrome.runtime.sendMessage({ type: "call_tool", name: "figma_status", arguments: {} }, r => {
    if (!r) { figmaPaint("var(--muted)", "Bridge offline", "", "Run start.bat (Windows) or MacOS_Start.command (macOS), then check again."); return; }
    if (!r.ok) {
      figmaPaint("var(--red)", "Bridge error", "", String((r && r.error) || "unknown error").slice(0, 200));
      return;
    }
    let body;
    try { body = JSON.parse(r.text || "{}"); }
    catch (e) { figmaPaint("var(--yellow)", "Bad status reply", "", "Bridge answered figma_status with non-JSON text."); return; }
    const ver = body.figma_version ? "v" + body.figma_version : "unversioned";
    const age = body.last_poll_age_s != null ? body.last_poll_age_s + "s ago" : "never";
    const pend = body.pending ? body.pending + " pending" : "queue empty";
    const meta = ver + " · poll " + age + " · " + pend;
    switch (body.verdict) {
      case "healthy":
        figmaPaint("var(--green)", "Figma ready", meta, "The Figma plugin is polling. figma_* tools will execute.");
        break;
      case "executing":
        figmaPaint("var(--green)", "Figma executing", meta, "A Figma command is running — wait for its result.");
        break;
      case "stuck-execution":
        figmaPaint("var(--red)", "Figma stuck", meta, "A Figma claim is over 30s old. Reopen the Figma plugin window.");
        break;
      case "plugin-stale":
        figmaPaint("var(--yellow)", "Figma stale", meta, "The Figma plugin stopped polling. Reopen it in Figma Desktop (Plugins > Development > RoLink Bridge).");
        break;
      case "no-queue":
        figmaPaint("var(--red)", "Queue down", meta, "The bridge queue is not running — restart the bridge.");
        break;
      default: // no-plugin and anything unknown
        figmaPaint("var(--muted)", "Figma not connected", meta, "Open Figma Desktop, run the RoLink Bridge plugin (Plugins > Development), and keep its window open.");
    }
  });
}

function figmaMsg(msg, err) {
  figmaMsgEl.textContent = msg;
  figmaMsgEl.className = "status " + (err ? "err" : "ok");
  setTimeout(() => { figmaMsgEl.textContent = ""; figmaMsgEl.className = "status"; }, 2200);
}

document.getElementById("figmaCheck").onclick = () => { refreshFigmaStatus(); figmaMsg("Checked"); };
document.getElementById("figmaReconnect").onclick = () => {
  chrome.runtime.sendMessage({ type: "reconnect" }, () => {
    figmaMsg("Reconnecting…");
    setTimeout(refreshFigmaStatus, 2500);
  });
};
refreshFigmaStatus();
setInterval(refreshFigmaStatus, 5000);

// ── P4 HUD category toggles ─────────────────────────────────────────
// Must stay in sync with ui/toolHud/toolRegistry.js CATEGORY_ORDER/COLORS.
// Stored as an array of hidden category names under `rl-hidden-cats`.
const HUD_CATS = [
  ["read", "#5B8DEF", "Reads & queries"],
  ["edit", "#FFB800", "Edits & creates"],
  ["inspect", "#00E5FF", "Snapshots & explore"],
  ["generate", "#FF6B35", "Generators"],
  ["asset", "#F472B6", "Marketplace assets"],
  ["visual", "#A855F7", "UI, light & sound"],
  ["test", "#00FF88", "Tests & sims"],
  ["tool", "#94A3B8", "Ops & misc"],
];
const HIDDEN_CATS_KEY = "rl-hidden-cats";
const catBox = document.getElementById("catToggles");
function renderCatToggles(hidden) {
  const set = new Set(Array.isArray(hidden) ? hidden : []);
  catBox.innerHTML = HUD_CATS.map(([name, color, desc]) => `
    <label class="cat-row">
      <input type="checkbox" data-cat="${name}" ${set.has(name) ? "" : "checked"}>
      <span class="cat-dot" style="background:${color}"></span>
      <span class="cn">${name}</span>
      <span class="cd">${desc}</span>
    </label>`).join("");
  catBox.querySelectorAll("input[data-cat]").forEach(box => {
    box.onchange = () => {
      const nowHidden = HUD_CATS.map(([n]) => n).filter(n => {
        const el = catBox.querySelector(`input[data-cat="${n}"]`);
        return el && !el.checked;
      });
      chrome.storage.local.set({ [HIDDEN_CATS_KEY]: nowHidden }, () => {
        s.textContent = "Categories saved";
        s.className = "status ok";
        setTimeout(() => { s.textContent = ""; s.className = "status"; }, 1500);
      });
    };
  });
}
chrome.storage.local.get([HIDDEN_CATS_KEY], v => {
  renderCatToggles(v && v[HIDDEN_CATS_KEY]);
});
