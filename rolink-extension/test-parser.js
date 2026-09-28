// Quick Node smoke test for core/parser.js (run: node test-parser.js). Not shipped.
const fs = require("fs");
const RLParse = new Function(fs.readFileSync(__dirname + "/core/parser.js", "utf8") + "; return RLParse;")();

const ok = (name, cond) => { console.log((cond ? "PASS" : "FAIL") + "  " + name); if (!cond) process.exitCode = 1; };

const lua = RLParse.parseToolCalls("###LUA###\nreturn 1+1\n###END_LUA###");
ok("lua block", lua.length === 1 && lua[0].tool === "execute_luau" && lua[0].arguments.code === "return 1+1");
ok("lua defaults to Edit datamodel", lua[0].arguments.datamodel_type === "Edit");

const luaSpaced = RLParse.parseToolCalls("### LUA ###\nlocal s = 'x'\n### END_LUA ###");
ok("markdown-mangled lua markers", luaSpaced.length === 1 && luaSpaced[0].tool === "execute_luau");

const luaServer = RLParse.parseToolCalls("###LUA:Server###\nreturn workspace.Name\n###END_LUA###");
ok("lua :Server datamodel", luaServer.length === 1 && luaServer[0].arguments.datamodel_type === "Server" && luaServer[0].arguments.code === "return workspace.Name");

const luaClient = RLParse.parseToolCalls("### LUA : client ###\nreturn 1\n###END_LUA###");
ok("lua spaced :client datamodel", luaClient.length === 1 && luaClient[0].arguments.datamodel_type === "Client");

// Kimi bleeds its code-block "Copy" button caption into the block text right
// after a lowercase ###lua### marker: `###lua### Copy <code>`. The extracted
// code must NOT start with "Copy" (StudioMCP would reject `Copy task.wait(...)`
// as invalid Lua -> "Failed to parse command code").
const luaCopy = RLParse.parseToolCalls('###lua### Copy task.wait(4)\nreturn "dom test done"\n###END_LUA###');
ok("strips Copy chrome from bare lua block", luaCopy.length === 1 && luaCopy[0].arguments.code === 'task.wait(4)\nreturn "dom test done"');
// A genuine identifier called Copy (no trailing space eaten) must survive.
const luaCopyIdent = RLParse.parseToolCalls("###LUA###\nCopy(workspace)\n###END_LUA###");
ok("keeps legit Copy( identifier", luaCopyIdent[0].arguments.code === "Copy(workspace)");

const paramless = RLParse.parseToolCalls('{"command":"list_commands"}');
ok("paramless command", paramless.length === 1 && paramless[0].tool === "list_commands");

const braces = RLParse.parseToolCalls('{"command":"multi_edit","params":{"code":"if x then {y} end"}}');
ok("braces inside string value", braces.length === 1 && braces[0].arguments.code === "if x then {y} end");

const legacy = RLParse.parseToolCalls('{"tool":"script_read","arguments":{"path":"game.Workspace"}}');
ok("legacy tool/arguments schema", legacy.length === 1 && legacy[0].tool === "script_read");

const mcp = RLParse.parseToolCalls('###MCP_TOOL###\n{"command":"get_studio_state"}\n###END_MCP_TOOL###');
ok("mcp_tool wrapper", mcp.length === 1 && mcp[0].tool === "get_studio_state");

// RAW blocks sit outside JSON so source can contain quotes/braces/newlines.
const rawCall = RLParse.parseToolCalls('###MCP_TOOL###\n{"tool":"set_script_content","args":{"path":"Workspace/Script"}}\n###RAW:content###\nlocal p = Instance.new("Part")\np.Name = "Hello"\n###END_RAW###\n###END_MCP_TOOL###');
ok("raw field is attached", rawCall.length === 1 && rawCall[0].arguments.content.includes('Instance.new("Part")'));
ok("raw field is mirrored", rawCall[0].rawFields && rawCall[0].rawFields.content.includes('p.Name = "Hello"'));
const rawGeneric = RLParse.parseToolCalls('###MCP_TOOL###\n{"tool":"create_module","args":{"path":"ReplicatedStorage/M"}}\n###RAW###\nreturn {}\n###END_RAW###\n###END_MCP_TOOL###');
ok("generic raw field inferred", rawGeneric.length === 1 && rawGeneric[0].arguments.exports === "return {}");

ok("open lua block detected", RLParse.hasOpenToolBlock("###LUA###\nlocal x=1") === true);
ok("closed lua block not open", RLParse.hasOpenToolBlock("###LUA###\nreturn 1\n###END_LUA###") === false);
ok("open json command detected", RLParse.hasOpenToolBlock('{"command":"multi_edit","params":{"a":1') === true);

ok("prose has no signature", RLParse.hasToolSignature("Here is how you could use a command in theory.") === false);
ok("command shape detected", RLParse.hasCommandShape('{"command":"x"}') === true);
ok("injected feedback detected", RLParse.isInjectedFeedback("Output of 'execute_luau':\n2") === true);
ok("parse-error note is feedback not command", RLParse.isInjectedFeedback('ERROR: bad JSON, write {"command": "name"}') === true);
ok("tool name mid-stream", RLParse.toolNameFromText('{"command":"multi_ed') === "multi_ed");

// ── salvageCutOff: auto-close a command whose trailing closers were cut ──
// The live Qwen case: a big multi_edit missing exactly ONE final "}".
const cut1 = RLParse.salvageCutOff('{"command": "multi_edit", "params": {"datamodel_type": "Edit", "file_path": "game.ServerScriptService.AdminHandler", "edits": [{"old_string": "a", "new_string": "b"}]}');
ok("salvage: one missing root brace", cut1 && cut1.tool === "multi_edit" && cut1.arguments.edits.length === 1);
// Two missing closers (params + root) still salvages.
const cut2 = RLParse.salvageCutOff('{"command": "get_studio_state", "params": {"verbose": true');
ok("salvage: two missing closers", cut2 && cut2.tool === "get_studio_state" && cut2.arguments.verbose === true);
// Cut MID-STRING = real content amputated -> refuse.
ok("salvage refuses mid-string cut", RLParse.salvageCutOff('{"command": "multi_edit", "params": {"edits": [{"old_string": "elseif command ==') === null);
// Deep deficit (cut between edits: ] } } missing = 3 closers) -> refuse.
ok("salvage refuses deep deficit", RLParse.salvageCutOff('{"command": "multi_edit", "params": {"edits": [{"old_string": "a", "new_string": "b"}') === null);
// A CLOSED command is not salvage's business.
ok("salvage ignores closed command", RLParse.salvageCutOff('{"command": "list_commands"}') === null);
// Dangling comma after the last complete value = incomplete next value -> refuse.
ok("salvage refuses trailing comma", RLParse.salvageCutOff('{"command": "multi_edit", "params": {"edits": [{"old_string": "a"},') === null);
// Escaped quotes inside values must not confuse the string tracking.
const cutEsc = RLParse.salvageCutOff('{"command": "execute_luau", "params": {"code": "print(\\"hi\\")", "datamodel_type": "Edit"}');
ok("salvage handles escaped quotes", cutEsc && cutEsc.tool === "execute_luau" && cutEsc.arguments.code === 'print("hi")');

// ── DeepSeek's native DSML tool-call markup ────────────────────────────────
// DeepSeek sometimes answers in its own agentic markup instead of a RoLink
// command. It has no "command"/"tool" key and no ###...### markers, so the
// classify ladder used to miss it entirely and the turn died as plain text.
// DSML_RE is what fires the "dsml" parse_error that asks for a rewrite.
const dsmlFull = [
  '<|DSML|>tool_calls>',
  '<|DSML|>invoke name="script_read">',
  '<|DSML|>parameter name="target_file" string="true">game.ServerStorage.RoLink.Memory</|DSML|>parameter>',
  '</|DSML|>invoke>',
  '</|DSML|>tool_calls>',
].join("\n");
ok("dsml full invoke block", RLParse.DSML_RE.test(dsmlFull));
// The degenerate form seen in the wild: a bare opener and NO tool name at all -
// which is why the guard must not be gated on a known command name.
ok("dsml bare opener + prose",
   RLParse.DSML_RE.test('<|DSML|>tool_calls>\n\n<section>Let me explore the remaining key services.</section>'));
// DeepSeek writes its special tokens with the FULL-WIDTH bar (U+FF5C).
ok("dsml full-width bar", RLParse.DSML_RE.test('<｜DSML｜>invoke name="script_read">'));

// ── Placeholder commands (small models copying the example) ─────────────
// A model that types {"command": "command_name"} MEANT it as a call (seen
// live on HF Chat) - the loop must correct it, not idle. Prose merely
// mentioning the word stays untouched: only the command/tool VALUE position
// counts.
ok("placeholder command_name detected",
  RLParse.placeholderCall('```json\n{"command": "command_name", "params": {}}\n```') === "command_name");
ok("placeholder tool_name detected",
  RLParse.placeholderCall('{"tool": "tool_name"}') === "tool_name");
ok("real names are not placeholders",
  RLParse.placeholderCall('{"command": "list_commands"}') === null);
ok("prose mention is not a placeholder call",
  RLParse.placeholderCall("Use the command key with your tool name.") === null);
ok("example-envelope value flags too",
  RLParse.placeholderCall('{"command": "name"}') === "name");
// The form as it appeared in user screenshots - doubled bars with spaces. The
// live capture (2026-08-22) showed DeepSeek actually emits plain ASCII bars and
// that this spacing is only the site's rendering, but the detector stays
// permissive so a build that really emits it is covered.
ok("dsml doubled bars with spaces", RLParse.DSML_RE.test('< |  | DSML |  | tool_calls>'));
ok("dsml doubled-bar closer", RLParse.DSML_RE.test('</ |  | DSML |  | parameter>'));
ok("dsml closing tag alone", RLParse.DSML_RE.test('</|DSML|>parameter>'));
// DSML is NOT a RoLink command shape: it must reach the fallthrough guards.
ok("dsml is not a tool signature", !RLParse.hasToolSignature(dsmlFull));
// DSML must NOT be a tool signature (it has to fall through to the classify
// ladder so the "dsml" parse_error fires) but it MUST be a command shape, so the
// camouflage sweep masks the raw markup behind a chip instead of showing it.
ok("dsml IS a command shape (so it gets masked)", RLParse.hasCommandShape(dsmlFull));
ok("dsml bare opener is a command shape too", RLParse.hasCommandShape('<|DSML|>tool_calls>'));
// No false positives: ordinary prose, a real command, and - critically - OUR OWN
// error note, which names DSML in words. If the note matched, the model echoing
// it would re-fire the error forever.
ok("no dsml false positive on prose",
   !RLParse.DSML_RE.test("I considered the DSML invoke and parameter tags, but used JSON instead."));
ok("no dsml false positive on a real command",
   !RLParse.DSML_RE.test('{"command": "script_read", "params": {"target_file": "x"}}'));
