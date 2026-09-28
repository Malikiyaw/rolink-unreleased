# tests/test_plugin_execution.py - 2.2.0 execution hardening.
#   python3 tests/test_plugin_execution.py
# Covers: bridge Luau preflight rejects yield-less infinite loops, plugin
# no longer calls debug.sethook unconditionally (HAS_SETHOOK guard), and
# get_animation_info supports path-based reads for in-place sequences.
import sys, os, json, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
import bridge


class PluginExecutionTest(unittest.TestCase):
    def test_infinite_loop_preflight(self):
        res = bridge.safe_call("execute_luau", {"code": "while true do print(1) end"}, 5)
        self.assertFalse(res["ok"])
        self.assertEqual(res["kind"], "validation_error")
        self.assertIn("infinite loop", res["error"].lower())

    def test_loop_with_yield_passes_preflight(self):
        err = bridge._luau_preflight("while true do task.wait(0.1) print(1) end")
        self.assertIsNone(err)

    def test_normal_code_passes_preflight(self):
        err = bridge._luau_preflight("return 1+1")
        self.assertIsNone(err)

    def test_plugin_guards_sethook(self):
        with open(os.path.join(ROOT, "studio-plugin", "RoLink.lua"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("HAS_SETHOOK", src)
        self.assertIn("riskyLoop", src)
        self.assertIn("applyEnv", src)
        # No busy-resume loop: yields must propagate via direct pcall.
        self.assertNotIn("coroutine.resume(tracked", src)
        self.assertIn("table.pack(pcall(fn", src)

    def test_yield_and_play_honesty(self):
        with open(os.path.join(ROOT, "studio-plugin", "RoLink.lua"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("task.spawn", src)  # poll runs yield-safe
        self.assertIn("IN_PLAY_MODE", src)
        self.assertIn("playable", src)
        self.assertIn("Edit DataModel", src)
        self.assertIn("require_failed", src)
        self.assertIn("compiler_error", src)
        self.assertIn('mod.Parent = game:GetService("ServerStorage")', src)
        self.assertIn("__RL_BUSY", src)
        self.assertIn("resolveAnimationId", src)
        self.assertIn("runtimeSnippet", src)
        # Generic Script:line unwrap must be gone (it relabeled every error).
        self.assertNotIn('[Ss]cript:%d+', src)

    def test_marker_leak_stripped(self):
        res = bridge.safe_call("set_script_content", {"path": "Workspace/X", "content": "###LUA###\nreturn 1\n###END_LUA###"}, 5)
        # Marker content is stripped at safe_call before queue/MCP, so large-set would be reached but
        # here it must not mislabel as compiler_error and must not allocate a command
        self.assertIn(res["kind"], ("mcp_offline", "plugin_offline", "validation_error"))
        self.assertNotIn("###LUA", str(res.get("error", "")) + str(res.get("text", "")))
        err = bridge._luau_preflight("###LUA###\nreturn {a=1}\n###END_LUA###")
        self.assertIn("###LUA", err)
        with open(os.path.join(ROOT, "studio-plugin", "RoLink.lua"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("stripMarkers", src)
        self.assertIn("compiler_error", src)

    def test_large_script_content_fails_fast(self):
        res = bridge.safe_call("set_script_content", {"path": "Workspace/X", "content": "x" * 100001}, 5)
        self.assertFalse(res["ok"])
        self.assertEqual(res["kind"], "validation_error")
        self.assertIn("100000", res["error"])

    def test_queue_single_flight(self):
        c1 = bridge.queue_enqueue("get_instances", "get_instances", {})
        taken = bridge.queue_take()
        self.assertIsNotNone(taken)
        self.assertEqual(taken["id"], c1)
        c2 = bridge.queue_enqueue("get_instances", "get_instances", {})
        self.assertIsNone(bridge.queue_take(), "second claim must wait for expiry")
        bridge.queue_cancel(taken["id"])
        bridge.queue_cancel(c2)

    def test_animation_info_path_support(self):
        with open(os.path.join(ROOT, "studio-plugin", "RoLink.lua"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("summarizeSequence", src)
        self.assertIn("pathArg", src)
        with open(os.path.join(ROOT, "mcp-server", "src", "tools", "registry.ts"), encoding="utf-8") as f:
            reg = f.read()
        idx = reg.find("get_animation_info")
        self.assertGreater(idx, 0)
        window = reg[idx:idx + 800]
        self.assertIn("path", window)

    def test_extension_prompt_escapes(self):
        import re
        with open(os.path.join(ROOT, "rolink-extension", "core", "config.js"), encoding="utf-8") as f:
            src = f.read()
        # Every literal `require()` mention in prompt text must be escaped;
        # a bare backtick inside the template literal breaks parsing so RL
        # never defines and Start fails with "RL is not defined".
        self.assertNotRegex(src, r"(?<!\\)`require\(\)")
        self.assertIn("\\`require()\\`", src)

    def test_stuck_execution_guidance(self):
        err = bridge._ai_readable_error("stuck-execution", "no plugin answer in 20s (queue: 0 pending)", "execute_luau")
        self.assertIn("plugin_status", err)
        self.assertIn("Do NOT resend", err)
        self.assertNotIn("install-plugin.bat", err)

    def test_plugin_offline_still_has_install_steps(self):
        err = bridge._ai_readable_error("plugin_offline", "never seen", "execute_luau")
        self.assertIn("install-plugin.bat", err)

    def test_get_all_properties_no_pairs_on_instance(self):
        with open(os.path.join(ROOT, "studio-plugin", "RoLink.lua"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("safeProps", src)
        self.assertIn("COMMON_PROPS", src)
        self.assertNotIn("pairs(inst::any)", src)
        self.assertNotIn("in pairs(inst)", src)

    def test_animation_easing_bake(self):
        with open(os.path.join(ROOT, "studio-plugin", "RoLink.lua"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("bakeEased", src)
        self.assertIn("EASE_FNS", src)
        self.assertIn("non-decreasing", src)
        with open(os.path.join(ROOT, "mcp-server", "src", "tools", "registry.ts"), encoding="utf-8") as f:
            reg = f.read()
        self.assertIn("quadInOut", reg)

    def test_cinematic_tools_wired(self):
        for name in ("create_cutscene", "create_dialogue", "create_motion_effect", "create_vfx"):
            with open(os.path.join(ROOT, "tests", "__registry__.json"), encoding="utf-8") as f:
                self.assertIn(name, json.load(f))
        with open(os.path.join(ROOT, "studio-plugin", "RoLink.lua"), encoding="utf-8") as f:
            src = f.read()
        for branch in ('tool=="create_cutscene"', 'tool=="create_dialogue"',
                       'tool=="create_motion_effect"', 'tool=="create_vfx"'):
            self.assertIn(branch, src)
        with open(os.path.join(ROOT, "mcp-server", "src", "tools", "registry.ts"), encoding="utf-8") as f:
            reg = f.read()
        for name in ("create_cutscene", "create_dialogue", "create_motion_effect", "create_vfx"):
            self.assertIn('name: "%s"' % name, reg)

    def test_batch_cap_is_ten(self):
        res = bridge.safe_call("batch_queue", {"commands": [{"tool": "get_time", "args": {}}] * 11}, 5)
        self.assertFalse(res["ok"])
        self.assertEqual(res["kind"], "validation_error")
        self.assertIn("10", res["error"])

    def test_batch_local_fanout_succeeds(self):
        # Studio-free: local sub-calls fan out through the same path.
        res = bridge.safe_call("batch_queue", {"commands": [{"tool": "get_time", "args": {}}] * 3,
                                                      "mode": "best_effort"}, 30)
        self.assertTrue(res["ok"], res)
        body = json.loads(res["text"])
        self.assertEqual(body["status"], "success")
        self.assertEqual(body["succeeded"], 3)

    def test_batch_deadline_bounded(self):
        with open(os.path.join(ROOT, "bridge.py"), encoding="utf-8") as f:
            src = f.read()
        # No sub-call may receive the full batch timeout: the batch must
        # settle before the extension stops listening, or Studio keeps
        # running steps the model recorded as failed (ghost writes).
        self.assertIn("_deadline", src)
        self.assertIn("safe_call(sub_name, sub_args, min(_remaining, 60.0))", src)
        self.assertNotIn("r = safe_call(sub_name, sub_args, timeout)", src)
        self.assertIn("batch time budget exhausted", src)

    def test_clip_and_publish_wired(self):
        for name in ("export_animation_clip", "publish_animation"):
            with open(os.path.join(ROOT, "tests", "__registry__.json"), encoding="utf-8") as f:
                self.assertIn(name, json.load(f))
        with open(os.path.join(ROOT, "studio-plugin", "RoLink.lua"), encoding="utf-8") as f:
            src = f.read()
        for branch in ('tool=="export_animation_clip"', 'tool=="publish_animation"',
                       "exportAnimationClip", "prepareAnimation", "registerAnimation",
                       "clipCurves", "findClipTwin"):
            self.assertIn(branch, src)
        with open(os.path.join(ROOT, "mcp-server", "src", "tools", "registry.ts"), encoding="utf-8") as f:
            reg = f.read()
        for name in ("export_animation_clip", "publish_animation"):
            self.assertIn('name: "%s"' % name, reg)

    def test_publish_register_validates_asset_id(self):
        res = bridge.safe_call("publish_animation", {"action": "register", "assetId": "not-an-id"}, 5)
        # Offline Studio cannot verify, but routing must resolve (mcp_offline),
        # never "unknown tool".
        self.assertIn(res["kind"], ("mcp_offline", "plugin_offline", "stuck-execution", "validation_error", "execution_error"))
        self.assertNotIn("unknown tool", str(res.get("error", "")).lower())

    def test_deepseek_reskin_fallbacks(self):
        import re
        with open(os.path.join(ROOT, "rolink-extension", "providers", "deepseek.js"), encoding="utf-8") as f:
            src = f.read()
        # v4.1 composer: send lookup survives a missing .ds-button--primary,
        # unknown pickers are never clicked, search blocks explain themselves.
        self.assertIn("function findSendBtn", src)
        self.assertIn("needSearchOff", src)
        self.assertNotIn("composerFrame() || document", src)  # no recurse: frame scoping stays direct
        # findSendBtn must query the DOM, never itself (self-recursion kills
        # the content script: no bar, Errors button on the extension card).
        # Strip comments first: a comment may MENTION the call it warns about.
        body = src.split("function findSendBtn", 1)[1].split("\n  }\n", 1)[0]
        body = re.sub(r"//[^\n]*", "", body)
        self.assertNotIn("findSendBtn()", body)
        self.assertIn("document.querySelector(S.sendBtn)", body)
        with open(os.path.join(ROOT, "rolink-extension", "core", "main.js"), encoding="utf-8") as f:
            main = f.read()
        self.assertIn("needSearchOff", main)
        self.assertIn("Smart Search", main)

    def test_deepseek_injects_on_bare_domain(self):
        import json as _json
        with open(os.path.join(ROOT, "rolink-extension", "manifest.json"), encoding="utf-8") as f:
            manifest = _json.load(f)
        with open(os.path.join(ROOT, "rolink-extension", "background.js"), encoding="utf-8") as f:
            bg = f.read()
        deepseek_scripts = [c for c in manifest["content_scripts"]
                            if "providers/deepseek.js" in c.get("js", [])]
        self.assertTrue(deepseek_scripts, "no deepseek content script entry")
        matches = deepseek_scripts[0]["matches"]
        # Bare deepseek.com must inject (v4.1 serves pages there); host
        # permissions already allowed it, but content_scripts did not.
        self.assertIn("https://deepseek.com/*", matches)
        self.assertIn("https://chat.deepseek.com/*", matches)
        self.assertIn("https://deepseek.com/*", bg)


    def test_no_legacy_branding(self):
        # No ZeroScript remnants anywhere: no product name (any case), no
        # legacy code/storage identifiers, no old invite or tip links, no stale
        # repo URL. Migration fallbacks are the one exception: lines marked
        # legacy (or the line above them) may name the old storage keys.
        import re
        banned = [
            r"zeroscript",  # case-insensitive below
            r"ZSParse", r"ZSProvider", r"__zs", r"#zs-", r"data-zs",
            r"zs-diag", r"ZS_BRIDGE_PORT", r"ZS_STUDIO_MCP_PATH",
            r"zStopped", r"zloop", r"zResume", r"zResumeLen", r"zphase",
            r"zsToolT0", r"zsGenT0", r"zsCode", r"zsPlaceholder",
            r"zsGptVer", r"zsDsVer", r"zsSys", r"zsCustomPrompt",
            r"zsCustomMcpServers", r"zsImageTools", r"zsStartedSessions",
            r"zsSetupSeen", r"zsQwenModelVision2", r"domHasZsSignal",
            r"D5G2HAzX8z", r"KOFI_URL", r"sebattfg/RoLink-Free",
        ]
        text_exts = (".js", ".ts", ".html", ".css", ".json", ".md", ".py",
                     ".lua", ".txt", ".bat", ".sh", ".command")
        hits = []
        for dirpath, dirnames, filenames in os.walk(ROOT):
            dirnames[:] = [d for d in dirnames if d != ".git"]
            for fn in filenames:
                if not fn.endswith(text_exts):
                    continue
                p = os.path.join(dirpath, fn)
                if os.path.abspath(p) == os.path.abspath(__file__):
                    continue
                try:
                    with open(p, encoding="utf-8") as f:
                        lines = f.read().splitlines()
                except (OSError, UnicodeDecodeError):
                    continue
                for i, line in enumerate(lines):
                    window = [lines[j] for j in range(max(0, i - 3), i + 1)]
                    if any(re.search(r"legacy", w, re.IGNORECASE) for w in window):
                        continue
                    for pat in banned:
                        flags = re.IGNORECASE if pat == "zeroscript" else 0
                        if re.search(pat, line, flags):
                            hits.append("%s:%d: %s" % (
                                os.path.relpath(p, ROOT), i + 1, pat))
                            break
        self.assertEqual(hits, [], "legacy remnants:\n" + "\n".join(hits[:20]))

    def test_sandbox_exposes_standard_builtins(self):
        import re
        # pcall(require, ...) failed with "attempt to call a nil value" because
        # safeEnv lacked the builtins themselves. All three env definitions
        # must provide them. Whitespace-insensitive: the Rojo mirror writes
        # `pcall = pcall` while the production file writes `pcall=pcall`.
        for rel in ("studio-plugin/RoLink.lua",
                    "studio-plugin/src/plugin/init.plugin.luau",
                    "studio-plugin/src/sandbox.luau"):
            with open(os.path.join(ROOT, rel), encoding="utf-8") as f:
                src = f.read()
            flat = re.sub(r"\s+", "", src)
            for name in ("pcall", "require", "assert", "select", "unpack"):
                self.assertRegex(flat, name + r"=" + name,
                                 "%s missing %s=..." % (rel, name))

    def test_hanging_snippet_times_out_without_wedging(self):
        for rel in ("studio-plugin/RoLink.lua",
                    "studio-plugin/src/plugin/init.plugin.luau"):
            with open(os.path.join(ROOT, rel), encoding="utf-8") as f:
                src = f.read()
            # Wall-clock deadline on its own coroutine: a hung require/wait
            # reports a timeout instead of wedging the single-flight queue.
            self.assertIn("runWithDeadline", src)
            self.assertIn("EXEC_BUDGET_S", src)
            self.assertIn("coroutine.create", src)
            self.assertIn("still running after", src)

    def test_execute_luau_warns_against_bulk_require(self):
        with open(os.path.join(ROOT, "mcp-server", "src", "tools", "toolPrompts.ts"),
                  encoding="utf-8") as f:
            src = f.read()
        self.assertIn("never bulk-require", src)
        with open(os.path.join(ROOT, "generated", "tool-prompts.json"), encoding="utf-8") as f:
            import json as _json
            gen = _json.load(f)["prompts"]["execute_luau"]["pitfalls"]
        self.assertIn("never bulk-require", gen)

    def test_runtime_error_names_offending_line(self):
        with open(os.path.join(ROOT, "studio-plugin", "RoLink.lua"), encoding="utf-8") as f:
            src = f.read()
        # Runtime errors must carry the failing source line, not just a
        # 120-char head: '[string "RoLink"]:460' is useless on long scripts.
        self.assertIn("errLineCtx", src)
        self.assertIn('>> line "', src)
        self.assertIn("attempt to call a nil value", src)
        # Both runtime-failure returns in sandboxRun attach the context, plus
        # the wall-clock timeout path in runWithDeadline and both harness
        # loader-failure returns (require_failed + loader_unavailable carry
        # line context so a wrapped module error stays diagnosable).
        self.assertEqual(src.count("errLineCtx(code,"), 6)
        with open(os.path.join(ROOT, "studio-plugin", "src", "plugin", "init.plugin.luau"),
                  encoding="utf-8") as f:
            mirror = f.read()
        self.assertIn("errLineCtx", mirror)
        self.assertIn("errLineCtx(code, errMsg)", mirror)

    def test_easing_aliases_and_tool_deadline(self):
        with open(os.path.join(ROOT, "studio-plugin", "RoLink.lua"), encoding="utf-8") as f:
            src = f.read()
        # Bare family names normalize instead of erroring (the 'quad' report).
        self.assertIn('quad = "quadInOut"', src)
        self.assertIn('cubic = "cubicInOut"', src)
        self.assertIn('sine = "sineInOut"', src)
        self.assertIn("function resolveEasing", src)
        # Unknown names still error, with the same prefix plus a hint.
        self.assertIn("unknown easing '", src)
        self.assertIn("did you mean", src)
        self.assertIn("EASE_LIST", src)
        # Instance budget fails fast instead of wedging the queue.
        self.assertIn("totalPoses", src)
        self.assertIn("max 1024", src)
        self.assertIn("made % 128", src)
        # Every tool (not just Luau snippets) runs under a wall-clock
        # deadline; the poll loop routes through it instead of bare pcall.
        self.assertIn("TOOL_BUDGET_S", src)
        self.assertIn("function runToolDeadline", src)
        self.assertIn("runToolDeadline(cmd)", src)
        self.assertIn("still running after", src)
        # Exactly one bare dispatch left, inside the deadline runner itself.
        self.assertEqual(src.count("pcall(executeCommand, cmd)"), 1)
        # Prompt surfaces document the enum and the budget.
        with open(os.path.join(ROOT, "mcp-server", "src", "tools", "registry.ts"),
                  encoding="utf-8") as f:
            reg = f.read()
        self.assertIn("quadIn/Out/InOut", reg)
        self.assertIn("1024", reg)
        with open(os.path.join(ROOT, "mcp-server", "src", "tools", "toolPrompts.ts"),
                  encoding="utf-8") as f:
            prompts = f.read()
        self.assertIn("bare quad", prompts)
        with open(os.path.join(ROOT, "generated", "tool-prompts.json"), encoding="utf-8") as f:
            import json as _json2
            gen = _json2.load(f)["prompts"]["create_animation_track"]["pitfalls"]
        self.assertIn("bare quad", gen)


    def test_toolbugfix_execute_luau_shape_and_loader(self):
        with open(os.path.join(ROOT, "studio-plugin", "RoLink.lua"), encoding="utf-8") as f:
            src = f.read()
        # Result must prove execution: executed/hasReturn/output, with preview
        # explicitly labeled input-only (never the whole result).
        for pin in ("executed=true", "hasReturn=", "previewNote=",
                    "input echo only", "code is required for execute_luau"):
            self.assertIn(pin, src)
        # Loader fallback: loadstring, then load, then ModuleScript harness
        # for ANY code (not just require snippets).
        for pin in ("function compileChunk", 'loader_unavailable',
                    '"loadstring", nil', "for ANY code"):
            self.assertIn(pin, src)
        # print() captured into output.
        for pin in ("oldPrint", "captured", "safeEnv.print = function"):
            self.assertIn(pin, src)

    def test_toolbugfix_exact_first_paths(self):
        with open(os.path.join(ROOT, "studio-plugin", "RoLink.lua"), encoding="utf-8") as f:
            src = f.read()
        for pin in ("parseIndexedName", "childByName", "matchedPath",
                    "Name[2]", "matchedPath=inst:GetFullName()"):
            self.assertIn(pin, src)
        # Walk order is the contract: slash, then dot, then legacy scan
        # (which must survive for dotted names like "My.Part").
        self.assertLess(src.index("slash-walk"), src.index("dot-walk"))
        self.assertLess(src.index("dot-walk"), src.index("legacy fallbacks"))
        self.assertIn('gmatch("[^/]+")', src)
        self.assertIn('gmatch("[^.]+")', src)
        # get_instances must not silently fall back to the whole workspace.
        self.assertNotIn('findByPath(args.path or "workspace") or workspace', src)
        self.assertIn("inspect_keyframe_track", src)
        self.assertIn("function inspectKeyframeTrack", src)
        self.assertIn("ToEulerAnglesXYZ", src)

    def test_toolbugfix_raw_markers_and_notfound(self):
        res = bridge.safe_call("set_script_content", {"path": "Workspace/X", "content": "###RAW###\nreturn 1\n###END_RAW###"}, 5)
        self.assertIn(res["kind"], ("mcp_offline", "plugin_offline", "validation_error"))
        self.assertNotIn("###RAW", str(res.get("error", "")) + str(res.get("text", "")))
        err = bridge._ai_readable_error("execution_error", "sabuiltin_Assistant.rbxm.Assistant.Foo not found", "get_script_content")
        self.assertNotIn("sabuiltin_", err)
        self.assertIn("not found", err.lower())
        with open(os.path.join(ROOT, "studio-plugin", "RoLink.lua"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("END_RAW", src)
        self.assertIn("file not found", src)

    def test_toolbugfix_search_asset_live_bridge_side(self):
        # search_asset is now a REAL bridge-side catalog search
        # (bridge.py _local_search_asset). The plugin branch may only exist as
        # an honest pointer - it must never fabricate results.
        with open(os.path.join(ROOT, "studio-plugin", "RoLink.lua"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("search_asset is served by the bridge", src)
        self.assertNotIn("mock asset", src)
        self.assertNotIn("unsupported: search_asset", src)
        with open(os.path.join(ROOT, "bridge.py"), encoding="utf-8") as f:
            br = f.read()
        self.assertIn("def _local_search_asset", br)
        self.assertIn("apis.roblox.com/toolbox-service/v2/assets:search", br)
        self.assertIn('"search_asset": _local_search_asset', br)
        self.assertNotIn("mockAssets", br)

    def test_toolbugfix_forward_declarations(self):
        import re
        with open(os.path.join(ROOT, "studio-plugin", "RoLink.lua"), encoding="utf-8") as f:
            src = f.read()
        # Lock helper is called by earlier-defined model-animation writers;
        # defined further down it resolved to nil at runtime. It must be a
        # single `local function` located BEFORE first use.
        self.assertEqual(len(re.findall(r"local function rlAnimGetLocked\b", src)), 1)
        self.assertLess(src.find("local function rlAnimGetLocked"),
                        src.find("local function rlModelSetKey"))
        # Same for the clip-twin helpers used inside summarizeSequence.
        self.assertEqual(len(re.findall(r"local function findClipTwin\b", src)), 1)
        self.assertEqual(len(re.findall(r"local function clipCurvesSummary\b", src)), 1)
        self.assertLess(src.find("local function findClipTwin"),
                        src.find("local function summarizeSequence"))

    def test_toolbugfix_inspect_keyframe_track_routed(self):
        self.assertIn("inspect_keyframe_track", bridge._QUEUE_EXTRA_TOOLS)
        res = bridge.safe_call("inspect_keyframe_track", {"path": "Workspace/X"}, 0.3)
        self.assertIn(res["kind"], ("plugin_offline", "stuck-execution", "mcp_offline"))
        self.assertNotIn("unknown tool", str(res.get("error", "")).lower())

    def test_toolbugfix_numeric_inspector_advertised(self):
        with open(os.path.join(ROOT, "mcp-server", "src", "tools", "registry.ts"), encoding="utf-8") as f:
            reg = f.read()
        self.assertIn("numeric:true", reg)
        self.assertIn("numeric: z.boolean().optional()", reg)
        self.assertIn("MODEL animations only", reg)

    def test_toolbugfix_loader_hardening(self):
        with open(os.path.join(ROOT, "studio-plugin", "RoLink.lua"), encoding="utf-8") as f:
            src = f.read()
        # Unique harness names per call (require() caches by ModuleScript).
        self.assertIn("harnessSeq", src)
        self.assertIn('RoLinkHarness_"', src)
        # Loader used is reported; total loader failure is distinct from a
        # syntax error so the model stops retrying identical code.
        self.assertIn("loader_unavailable: loadstring/load disabled", src)
        self.assertIn("loader=loader2", src)
        self.assertIn("local function finish(ok:boolean, val:any, used:string?)", src)
        # Extension surfaces the loader.
        with open(os.path.join(ROOT, "rolink-extension", "core", "main.js"), encoding="utf-8") as f:
            main = f.read()
        self.assertIn("parsed.loader", main)
        # Print capture must pack varargs first: a nested non-vararg closure
        # referencing `...` is a load-time compile error that kills the whole
        # plugin ("Cannot use '...' outside of a vararg function").
        self.assertIn("table.pack(...)", src)
        self.assertIn("table.unpack(args, 1, args.n)", src)
        self.assertNotIn("(oldPrint :: any)(...)", src)

    def test_toolbugfix_prop_coercion(self):
        with open(os.path.join(ROOT, "studio-plugin", "RoLink.lua"), encoding="utf-8") as f:
            src = f.read()
        for pin in ("function num3", "function coerceProp", "function applyProps",
                    "function propsFailedSummary", "Color3.fromRGB(math.clamp",
                    "properties_failed", "applied=applied, failed=failed",
                    "coerceProp(inst, key"):
            self.assertIn(pin, src)
        # No silent raw-assign loops remain on the property paths.
        self.assertNotIn("[k]=v end", src)
        # Total property failure errors instead of fake success.
        self.assertIn("none of the properties applied", src)
        # Listings carry counts and truncation flags.
        self.assertIn("count=#t, instances=t", src)
        self.assertIn("truncated=truncated", src)

    def test_toolbugfix_array_forms_advertised(self):
        for rel in ("mcp-server/src/tools/toolPrompts.ts",
                    "generated/tool-prompts.json",
                    "rolink-extension/core/tool-prompts.js"):
            with open(os.path.join(ROOT, rel), encoding="utf-8") as f:
                txt = f.read()
            self.assertIn("Size [11,3,4]", txt, rel)
            self.assertIn("150,95,45", txt, rel)
            self.assertIn("Loader used is reported in loader", txt, rel)

    def test_toolbugfix_apply_material_real(self):
        with open(os.path.join(ROOT, "studio-plugin", "RoLink.lua"), encoding="utf-8") as f:
            src = f.read()
        for pin in ("local function paintMaterial", 'tool=="apply_material"',
                    "result=paintMaterial(args)", "material_failed",
                    "nothing to paint", "of = all", "truncated = all > #parts",
                    "applyProps(bt, {Material = matName})"):
            self.assertIn(pin, src)
        # The echo stub must be gone.
        self.assertNotIn("result={material=args.material}", src)
        for rel in ("mcp-server/src/tools/toolPrompts.ts",
                    "generated/tool-prompts.json",
                    "rolink-extension/core/tool-prompts.js"):
            with open(os.path.join(ROOT, rel), encoding="utf-8") as f:
                txt = f.read()
            self.assertIn("path* or region*", txt, rel)
            self.assertIn("painted", txt, rel)

    def test_toolbugfix_honest_stubs(self):
        with open(os.path.join(ROOT, "studio-plugin", "RoLink.lua"), encoding="utf-8") as f:
            src = f.read()
        for tool in ("diff_snapshots", "get_performance_stats", "explain_code"):
            lines = [ln for ln in src.splitlines() if '"%s"' % tool in ln]
            self.assertTrue(lines, tool + " branch missing")
            self.assertTrue(any("unsupported" in ln.lower() for ln in lines),
                            tool + " must fail honestly, not mock success")
        for mock in ("mock diff", "plugin stats mock", "explanation mock"):
            self.assertNotIn(mock, src)
        # The audit tracks explicit-unsupported branches as partial so the
        # quarantine stays truthful.
        with open(os.path.join(ROOT, "scripts", "audit_tools.py"), encoding="utf-8") as f:
            audit = f.read()
        self.assertIn("explicitly unsupported", audit)

    def test_toolbugfix_partial_failure_nudge(self):
        with open(os.path.join(ROOT, "rolink-extension", "core", "main.js"), encoding="utf-8") as f:
            main = f.read()
        self.assertIn("parsed.failed", main)
        self.assertIn("read the failed map", main)

    def test_luau_blocks_and_line_cap(self):
        # Studio's Luau parser loses block tracking on physical lines past
        # ~1KB and then reports a bogus "Expected 'end' (to close 'else' at
        # line N), got 'elseif'" on the NEXT branch (seen live: lines 3028/
        # 3029/3031 were 1103/1654/1391 chars). Run the repo's grammar-aware
        # checker: every line <= 900 chars and all blocks balanced.
        import importlib.util
        spec = importlib.util.spec_from_file_location(
            "check_luau_blocks", os.path.join(ROOT, "scripts", "check_luau_blocks.py"))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        issues = mod.check(os.path.join(ROOT, "studio-plugin", "RoLink.lua"))
        self.assertEqual(issues, [], "luau structure: " + "; ".join(issues[:10]))
        with open(os.path.join(ROOT, "studio-plugin", "RoLink.lua"), encoding="utf-8") as f:
            for i, ln in enumerate(f.read().splitlines(), 1):
                self.assertLessEqual(len(ln), 900, "line %d is %d chars" % (i, len(ln)))

    def test_plugin_build_tag_present(self):
        # The Output banner must identify a repo-fresh copy ("[repo copy]")
        # so a stale install is distinguishable from the release zip at a
        # glance. The documented `RoLink 2.7.0 loaded` prefix must survive.
        with open(os.path.join(ROOT, "studio-plugin", "RoLink.lua"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("RoLink 2.7.0 loaded [repo copy]", src)

    def test_installed_plugin_state(self):
        import tempfile
        import shutil
        plugdir = tempfile.mkdtemp()
        repodir = tempfile.mkdtemp()
        try:
            repo = os.path.join(repodir, "RoLink.lua")
            with open(repo, "w", encoding="utf-8") as f:
                f.write("-- repo copy")
            # Missing install.
            st = bridge._installed_plugin_state(plugdir, repo)
            self.assertFalse(st["exact_present"])
            self.assertTrue(st["stale_or_missing"])
            self.assertEqual(st["copy_count"], 0)
            # Matching install.
            with open(os.path.join(plugdir, "RoLink.lua"), "w", encoding="utf-8") as f:
                f.write("-- repo copy")
            st = bridge._installed_plugin_state(plugdir, repo)
            self.assertTrue(st["exact_matches_repo"])
            self.assertFalse(st["stale_or_missing"])
            # One byte off -> stale.
            with open(os.path.join(plugdir, "RoLink.lua"), "w", encoding="utf-8") as f:
                f.write("-- repo copY")
            st = bridge._installed_plugin_state(plugdir, repo)
            self.assertTrue(st["exact_present"])
            self.assertFalse(st["exact_matches_repo"])
            self.assertTrue(st["stale_or_missing"])
            # Duplicate stray copy.
            with open(os.path.join(plugdir, "user_RoLink.lua"), "w", encoding="utf-8") as f:
                f.write("-- stray")
            st = bridge._installed_plugin_state(plugdir, repo)
            self.assertEqual(st["copy_count"], 2)
        finally:
            shutil.rmtree(plugdir, ignore_errors=True)
            shutil.rmtree(repodir, ignore_errors=True)

    def test_plugin_status_reports_install_state(self):
        res = bridge._local_plugin_status({})
        body = json.loads(res["text"])
        self.assertIn("installed_plugin", body)
        self.assertIn("install_note", body)
        self.assertIn("copy_count", body["installed_plugin"])

    def test_installer_refuses_hot_stale_installs(self):
        with open(os.path.join(ROOT, "install-plugin.bat"), encoding="utf-8", errors="replace") as f:
            bat = f.read()
        for pin in ("QUIT ROBLOX STUDIO FIRST", "exit /b 2", "INSTALL OK",
                    "matches source", "DUPCOUNT", "user_RoLink.lua",
                    "RoLink 2.7.0 loaded [repo copy]"):
            self.assertIn(pin, bat, "installer missing: " + pin)

    def test_toolbugfix_terrain_and_datastore_real(self):
        with open(os.path.join(ROOT, "studio-plugin", "RoLink.lua"), encoding="utf-8") as f:
            src = f.read()
        for pin in ("local function buildTerrain", 'tool=="generate_terrain"',
                    "result=buildTerrain(args)", "FillBlock", "FillBall",
                    "local function fillTerrainRegion", 'tool=="set_terrain_region"',
                    "result=fillTerrainRegion(args)", "min must be below max",
                    "GetDataStore", "datastore_unavailable", "datastore_error",
                    "found=val ~= nil"):
            self.assertIn(pin, src)
        # The echo stubs must be gone.
        for stub in ('result={terrain=true, size=args.size}', "result={region=true}",
                     "result={value=nil, mock=true}", "then result={set=true}"):
            self.assertNotIn(stub, src)
        # Terrain material is a real schema field, not a silent extra.
        with open(os.path.join(ROOT, "mcp-server", "src", "tools", "registry.ts"), encoding="utf-8") as f:
            reg = f.read()
        self.assertIn('material: z.string().optional().default("Grass")', reg)
        # Quarantine reflects the datastore read going real.
        import json as _json
        with open(os.path.join(ROOT, "generated", "tool-quarantine.json"), encoding="utf-8") as f:
            q = _json.load(f)
        self.assertNotIn("get_datastore_value", q["partial"])
        self.assertEqual(q["failing"], [])

    def test_toolbugfix_place_parts_patterns(self):
        with open(os.path.join(ROOT, "studio-plugin", "RoLink.lua"), encoding="utf-8") as f:
            src = f.read()
        for pin in ("local function placePatternParts", 'tool=="place_parts"',
                    "result=placePatternParts(args)",
                    "pattern must be grid|circle|line",
                    "placed = made", "spacing = num(args.spacing, 6)",
                    "math.cos(a) * r", "% cols) * spacing"):
            self.assertIn(pin, src)
        # The line-stamper that ignored pattern/count is gone.
        self.assertNotIn("for i=1, math.min(args.count or 5, 50) do local p=Instance.new",
                         src)
        # spacing/size/material are real schema fields on both paths.
        with open(os.path.join(ROOT, "mcp-server", "src", "tools", "registry.ts"), encoding="utf-8") as f:
            reg = f.read()
        self.assertIn("spacing: z.number().optional()", reg)
        self.assertIn("size: z.tuple([z.number(),z.number(),z.number()]).optional()", reg)
        self.assertIn("material: z.string().optional()", reg)
        for rel in ("mcp-server/src/tools/toolPrompts.ts",
                    "generated/tool-prompts.json",
                    "rolink-extension/core/tool-prompts.js"):
            with open(os.path.join(ROOT, rel), encoding="utf-8") as f:
                txt = f.read()
            self.assertIn("spacing? studs default 6", txt, rel)
            self.assertIn("placed, of, pattern, parent, spacing, failed", txt, rel)


if __name__ == "__main__":
    unittest.main(verbosity=1)
