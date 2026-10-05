# RoLink Free - AI Roblox Studio Agent (ChatGPT, DeepSeek, Gemini, Kimi, GLM, Qwen, Arena, Meta AI, Claude)

Control Roblox Studio with AI, for free. RoLink turns a normal AI chat (ChatGPT, DeepSeek, Google Gemini, Kimi, GLM, Qwen, Arena, Meta AI, or Claude) into an agent that builds and scripts your Roblox game for you: just describe what you want, and it reads/edits scripts, runs Luau, inspects the game tree, and generates assets directly in Roblox Studio. No API key, no terminal, no coding required.

It's a Chrome/Edge browser extension plus a small local bridge that connects the chat to Roblox Studio through the official MCP server. **DeepSeek is the recommended provider.** ChatGPT, Gemini, Kimi, GLM, Qwen, Arena, Meta AI and Claude also work. On ChatGPT, screenshots and image input are disabled on purpose (its free tier caps files/images on a separate quota from messages, so vision would only work part of the day); ChatGPT also summarises its own context in long sessions, so RoLink re-states its operating instructions periodically (shown as a "Reminder" chip) to stop it forgetting it can run commands. Gemini and Kimi can be less stable: Gemini tends to stop using the Roblox tools in long sessions, and Kimi sometimes reaches for its own native tools instead of the Roblox commands. On Arena, keep the mode dropdown on **Direct** (RoLink only supports Direct mode). Claude support is fresh and unvalidated - please report issues.

## Setup

**Load the extension manually (Edge or Chrome):**
1. Go to `edge://extensions` (Edge) or `chrome://extensions` (Chrome)
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked**
4. Select the `rolink-extension` folder
5. The extension is now active

**Then set up the Bridge:**
1. **Download the Bridge** from the [GitHub releases page](https://github.com/Malikiyaw/RoLink/releases)
2. **Open Roblox Studio** and load a Place
3. **Enable the MCP server in Roblox Studio** (first time only): click **Assistant AI** in the top bar, then **...** > **Manage MCP Servers** > **Enable Studio as MCP Server**
4. **Run the Bridge** - double-click `start.bat` (Windows) or `MacOS_Start.command` (macOS); a small window opens, the Bridge is running. On macOS, the first launch shows a Gatekeeper warning (normal for any downloaded script): click **Done**, then **System Settings > Privacy & Security**, scroll down, and click **Open Anyway**.
5. **Go to https://chat.deepseek.com** (recommended), https://chatgpt.com, https://gemini.google.com, https://www.kimi.com, https://chat.z.ai, https://chat.qwen.ai, https://arena.ai, https://www.meta.ai, https://claude.ai, https://huggingface.co/chat, or https://dola.com, open a new chat (only works on these exact addresses; on Arena use Direct mode)
6. Click **Start session** in the RoLink panel
7. Type what you want to build

📺 [Watch the setup tutorial](https://youtu.be/kPKiZLZ9_Ps)

## Architecture (for contributors)

The extension is split between a provider-agnostic core and per-AI-site providers:

```
core/config.js        system prompt, feedback strings, tool categories (global RL)
core/parser.js        RoLink command parsing - pure string logic   (global RLParse)
core/main.js          agentic loop, UI, camouflage, session state      (uses RLProvider)
providers/deepseek.js everything DeepSeek-specific: DOM selectors, generation
                      detection, send mechanics, composer modes…       (global RLProvider)
providers/gemini.js   same interface for Google Gemini (Angular DOM, Quill
                      composer, code-block masking)                    (global RLProvider)
providers/kimi.js     same interface for Kimi / Moonshot AI (Vue DOM, Lexical
                      composer, segment-code masking)                  (global RLProvider)
providers/glm.js      same interface for GLM / Z.ai (Svelte DOM, code-block
                      wrapper masking)                                 (global RLProvider)
providers/qwen.js     same interface for Qwen / chat.qwen.ai (Vue DOM, network-tap
                      SSE stream, Monaco disposal guard)               (global RLProvider)
providers/qwen-net.js MAIN-world fetch tap for Qwen SSE stream        (injected by manifest)
providers/chatgpt.js  same interface for ChatGPT / chatgpt.com (React DOM,
                      ProseMirror composer, CodeMirror reply reading) (global RLProvider)
providers/chatgpt-cm.js MAIN-world CodeMirror tap: republishes each code block's
                      TRUE document (the rendered DOM truncates long
                      lines)                                          (injected by manifest)
providers/arena.js    same interface for Arena / arena.ai (React DOM, multi-model
                      playground, A/B-comparison auto-commit, Direct-mode gate) (global RLProvider)
providers/generic.js  base RLProvider factory for new sites (selector overrides,
                      volatile-chrome stripping, isGeneratingExtra hook) (global makeGenericProvider)
providers/agent.js    Arena Agent Mode / arena.ai/agent via the generic factory
                      (ProseMirror composer, orchestration detection, human vote
                      gate - supervised only, never votes) (global RLProvider)
providers/meta.js     same interface for Meta AI / meta.ai (React DOM, textarea
                      composer, JSON-viewer + code-collapse masking)   (global RLProvider)
providers/claude.js   Claude / claude.ai via the generic factory (layered
                      composer discovery, extended-thinking exclusion, chat-only
                      commands, usage-cap economy)                     (global RLProvider)
providers/hfchat.js   HF Chat / huggingface.co/chat via the generic factory
                      (textarea composer, model-variance + login rules,
                      text-only until validated)                       (global RLProvider)
providers/dola.js     Dola / dola.com via the generic factory (layered
                      composer discovery, mode-chip/disabled-send guards,
                      native-tool drift rules, anchored card)           (global RLProvider)
background.js         WebSocket to the local bridge (provider-agnostic)
```

`core/main.js` never touches the host site's DOM directly - it only calls the
`RLProvider` interface. To integrate another AI site: write a new
`providers/<site>.js` exporting the same interface, then add its URL pattern to
`manifest.json` (`content_scripts` + `host_permissions`) and to
`PROVIDER_URLS` in `background.js`. No core change required.

Smoke tests (plain Node, no dependencies - run them from this directory):

- `node test-parser.js` - the command parser (`core/parser.js`).
- `node test-chatgpt.js` - ChatGPT reply reading (`providers/chatgpt.js`),
  driven against a stub DOM: CodeMirror line joining, the `data-rl-cm`
  MAIN-world tap that long code blocks depend on, and subtree exclusion.
- `node test-agent.js` - Arena Agent Mode contract (`providers/agent.js`):
  supervised-only (single send-button click path, never a vote button),
  vote-gate hook, and prompt rules.
- `node test-arena.js` - Arena Direct editor discovery (`providers/arena.js`):
  legacy `form textarea` preferred, contenteditable/textbox fallbacks,
  cached-card anchor through teardown, lock branching, own-UI exclusion.
- `node test-claude.js` - Claude contract (`providers/claude.js`): identity,
  vision flag, thinking hook, prompt rules, single send click path, plus
  manifest/background wiring pins.
- `node test-hfchat.js` - HF Chat contract (`providers/hfchat.js`): identity,
  text-only flag, login/model rules, single send click path, wiring pins.
- `node test-dola.js` - Dola contract (`providers/dola.js`): identity,
  text-only flag, mode-chip/disabled-send guards, drift rules, anchored
  card, wiring pins.

Both print `PASS`/`FAIL` per case and exit non-zero on failure.

## Support

Found a bug? Open an issue with your bridge log (`logs/bridge_debug.log`).
