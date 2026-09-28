# RoLink 2.7.0 — AI → Roblox Studio

**Turn ChatGPT, DeepSeek, Gemini, Kimi, GLM, Qwen, Arena, Arena Agent, Meta AI, Claude, HF Chat, or Dola into a Roblox Studio agent.** Browser extension + local bridge + MCP. Download through GitHub, no build needed.

> 🌐 Free alternative for building Roblox games with AI.

Twelve providers: **DeepSeek** (recommended), **ChatGPT**, **Gemini**, **Kimi** (`kimi.ai`), **GLM** (`chat.z.ai`), **Qwen** (`chat.qwen.ai`), **Arena** (`arena.ai`, Direct mode), **Arena Agent** (`arena.ai/agent`, supervised, work in progress — not fully working yet), **Meta AI**, **Claude** (`claude.ai`, work in progress — not usable yet), **HF Chat** (`huggingface.co/chat`, fresh support, login required), **Dola** (`dola.com`, work in progress — not usable yet, text-only). Pi (`pi.ai`) is unsupported — its abuse filters escalate to account bans; do not use RoLink there. Images off on ChatGPT free tier (separate quota); Gemini/Kimi may drop tools in long sessions; Arena chat keep **Direct** mode (Battle / Side-by-Side unsupported); Agent Mode runs supervised — it reads settled output, pauses at human prompts, and never votes for you.

## New in 2.7.0

See [CHANGELOG.md](CHANGELOG.md): brick-by-brick `place_parts` with anchored courses, cinematic cutscenes with real camera tweens and lifecycle tools, realistic motion easings plus preview/validate diagnostics, a plugin load fix for the local-register cap, and a preflight that only gates real tree wipes. Catalog 147 → 150 tools. Plugin reinstall required.

## New in 2.6.0

See [CHANGELOG.md](CHANGELOG.md): complete prompt/argument coverage for all 147 tools (the 7 motion tools previously reached the model with no parameter guidance), a repaired Blender MCP test suite, and the motion + Blender work.

## New in 2.5.0

See [CHANGELOG.md](CHANGELOG.md): real Roblox motion-animation/effect controllers, model-animation tools 125–140, an opt-in Blender MCP integration under `blender/*`, the in-Studio timeline editor, and hardened provider startup.

## New in 2.4.0

See [CHANGELOG.md](CHANGELOG.md): execution-truth envelopes on every tool, `execute_luau` preflight + atomic batches, tools 120–124, Studio truth + project memory, HF Chat and Dola providers, proof-gated session start, account-restriction handling, and hardened Dola/HF reads.

## How it works

```
AI chat (in your browser)
  -> RoLink Extension -> Bridge (your PC, ws://127.0.0.1:17613) -> Roblox Studio
```

The extension runs inside the chat page. When you type a request, it sends commands to the Bridge running on your PC, which drives Roblox Studio through the built-in MCP server (`StudioMCP`, port `13469`). Extra MCP servers (Blender, Sketchfab, ...) can be attached alongside via `config.json`. `mcp-server/` (Node) is the advanced power layer: queue API, prompts, and tooling around the same catalog.

## Setup (everything, in order)

### 1. Download the zip and install the extension

Download the latest zip from the **Releases** page and extract it. The zip contains both the **Bridge** and the **extension folder**.

To load the extension:

- Go to `edge://extensions` (Edge) or `chrome://extensions` (Chrome)
- Enable **Developer mode** (top right toggle)
- Click **Load unpacked**
- Select the `rolink-extension` folder from the extracted zip
- After any update: press the extension's **reload icon** on `chrome://extensions`, then refresh your AI tabs (a page refresh alone does not load new files)

### 2. Start Roblox Studio and enable MCP

Open Studio and load a Place, then enable MCP (first time only):

- Click **Assistant AI** in the top bar
- Click **...** (top right of the Assistant panel)
- Click **Manage MCP Servers**
- Click **Enable Studio as MCP Server**

### 2b. Install the RoLink Studio plugin (unlocks all 150 tools)

Roblox's built-in MCP only speaks ~27 commands. The rest of the catalog runs
through our own plugin:

- **Windows:** double-click `install-plugin.bat` inside the extracted folder.
- **macOS:** copy `studio-plugin/RoLink.lua` to `~/Documents/Roblox/Plugins/` (create the folder if missing).
- In Studio, open your place, press **View > Command Bar**, and run:
  `game:GetService("HttpService").HttpEnabled = true` (once per place — lets the plugin reach the bridge).
- **Quit Studio completely first** — it caches plugins at startup, so installing while open changes nothing until a full restart. A **RoLink** toolbar button appears; the bridge prints `plugin polling` when it connects. Without this step, registry tools report a clear `plugin_offline` error instead of running.
- After every RoLink update, reinstall the plugin the same way (quit Studio → run installer → reopen).
- **Plugin not showing up, or red `user_RoLink.lua` errors in Output?** Two causes: (1) a stale copy — quit Studio fully (check Task Manager for `RobloxStudioBeta.exe`), delete every `*RoLink*.lua` in `%LOCALAPPDATA%\Roblox\Plugins`, run `install-plugin.bat` again (it refuses while Studio runs, purges duplicates, and byte-verifies with `INSTALL OK`); (2) a compile error in the file itself — the plugin source is checked by `scripts/check_luau_blocks.py` (grammar-aware block balance + a 900-char line cap, because Studio's parser loses block tracking past ~1KB and misreports the error on a later branch). Proof it worked: Output shows `RoLink 2.7.0 loaded [repo copy]` — no tag, no toolbar means the old file is still installed. Each Team Create collaborator installs locally; plugin errors are per-machine.

### 3. Run the Bridge

- **Windows:** double-click `start.bat` **inside the extracted folder for this version** (an old folder runs the old bridge — check the banner version below).
- **macOS:** double-click `MacOS_Start.command` inside the extracted folder. The first time, macOS shows a security warning — click **Done**, then **System Settings > Privacy & Security > Open Anyway** (once).

A small window opens — the Bridge is running.

### 4. Start a session

Open a new chat on https://chat.deepseek.com (recommended), https://chatgpt.com, https://gemini.google.com, https://www.kimi.ai, https://chat.z.ai, https://chat.qwen.ai, https://arena.ai, https://arena.ai/agent, https://www.meta.ai, https://claude.ai, https://huggingface.co/chat, or https://dola.com. The RoLink bar appears above the input box. Click **Start session** and type what you want to build. The model should call `list_commands` first for the full live reference.

## Version check (all four must match)

| Where | What to look for |
| --- | --- |
| Bridge terminal banner | `BRIDGE START v2.7.0` (proves which folder you launched) |
| Bridge `plugin vX` line | Must equal the bridge version — a mismatch means Studio loaded a stale plugin; redo step 2b with Studio fully quit |
| Extension bar/popup | `v2.7.0` next to the RoLink name |
| Studio Output on launch | `RoLink 2.7.0 loaded` |

If any one differs, that component came from a different install — reinstall it from this release.

## What the AI can do

- Read and edit scripts, run Luau directly in Studio
- Inspect the game tree, create/move/clone instances, apply materials
- Build terrain, UI, particles, lighting, animations (keyframe tracks — easing names need their suffix: `quadIn`, not bare `quad`; max 1024 poses per track)
- Generate assets, levels, quests, sounds; browse the Creator Store. `search_asset` uses Roblox's live v2 Creator Store API in the bridge (no Studio call required), exposes script/price metadata, and `import_asset` inserts the real returned ID after stripping executable sources.
- Control play-testing, debug with breakpoints and watches
- Scan Output errors, inspect UI rects, map the viewport schematically
- Verify gameplay with scenario playtests, migrate systems atomically
- **Remember your project across sessions** (structured project memory: architecture, services, bugs, decisions)
- **Animate any model (beta)**: model-animation tools (analyze, keyframes, markers, preview, validate, retime/blend/fix, attack/idle/walk scaffolds) plus the in-Studio timeline editor (RoLink toolbar → Anim, beta)
- **Create and manage Roblox motion**: `create_motion_animation` builds a native Motor6D pose hierarchy and Play-time controller; `create_motion_effect` creates real tween/shake/FOV/pulse controllers with inspect/remove lifecycle tools. Easing (`quad/cubic/sine` families plus `bezierOut` overshoot and `springOut` settle, per-pose overrides, arc lift) plus `preview` velocity/loop-seam metrics and `validate`/`fix` audits turn sparse blocks into smooth motion. Studio plugins cannot prove rendered pixels, so results report verified paths/data and use Play for the visual check.

## Panel status

| Dot | Meaning |
| --- | --- |
| Green | Bridge + Studio ready (a place is open) |
| Yellow | Bridge OK, but Studio isn't usable yet — open Roblox Studio, load a place, or enable its MCP server |
| Grey | Bridge offline — run start.bat (Windows) or MacOS_Start.command (macOS) |

## Requirements

- Windows or macOS
- Roblox Studio (MCP support built-in)
- Microsoft Edge or Chrome
- Python 3.9+ (auto-installed on Windows; install from python.org on macOS)
- Node 18+ only if you run `mcp-server/` directly (optional)

## Multi-MCP servers

`config.json` declares every MCP server (default: `roblox`). Add more from the bar `⋯ → MCP servers` (`Name, e.g. Blender` + `Start command, e.g. npx -y @some/mcp` + **Add server**) or the extension's **⚙ Settings → MCP servers** page; the Bridge restarts itself to reload custom entries. The `roblox` entry is the primary server and can't be removed.

### Blender (optional, separate namespace)

RoLink includes an opt-in **Blender (MCP for Blender)** preset. It adds only the reviewed stdio server configuration; it does not install Blender, modify a `.blend`, or start the addon automatically. Install [uv](https://docs.astral.sh/uv/getting-started/installation/) first, then:

1. Run `uvx mcp-for-blender install-addon`, then in Blender go to **Edit → Preferences → Add-ons**, enable **Interface: MCP for Blender**.
2. In Blender's 3D viewport press `N`, open the **MCP for Blender** tab, and click **Start MCP Server** (`127.0.0.1:9876`). Or add any server manually from the bar `⋯ → MCP servers` / **⚙ Settings**: Name `Blender`, Start command `uvx --python 3.11 mcp-for-blender`, **Add server** — same RoLink pattern, separate from Roblox tools.
3. In RoLink open **⚙ Settings** (bar button, popup, or `⋯ → Extension settings`) and click **Add** on the Blender preset — or it is already there from step 2.
4. Ask RoLink to `list_mcp_servers`, then use `list_commands` with `server: "blender"` (e.g. `blender/get_scene_info`, `blender/execute_blender_code`).

Blender tools are always advertised as `blender/<upstream-tool>` (for example `blender/get_scene_info` and `blender/get_viewport_screenshot`) and route only to the Blender MCP client. Roblox remains independent; a Blender failure never changes the Roblox session.

## License

GPL-3.0-or-later. See `LICENSE`.
