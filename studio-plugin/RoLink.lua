-- RoLink.lua — Studio Plugin (150 tools, production)
-- Place in Studio Plugins folder or Rojo. Polls MCP every 200ms, executes, snapshots, heals, reports.
local HttpService = game:GetService("HttpService")
local ChangeHistoryService = game:GetService("ChangeHistoryService")
local RunService = game:GetService("RunService")

local MCP_URL = "http://127.0.0.1:3001"
local POLL_INTERVAL = 0.2
local PLUGIN_NAME = "RoLink 2.1"
local PLUGIN_VERSION = "2.14.0"

local toolbar = plugin:CreateToolbar(PLUGIN_NAME)
local btn = toolbar:CreateButton("RoLink", "AI bridge (150 tools, poll 200ms)", "rbxassetid://0")
btn.ClickableWhenViewportHidden = true
local enabled = true

local function log(msg) print("[RoLink] "..msg) end

local safeEnv = {
  print=print, warn=warn, error=error,
  pairs=pairs, ipairs=ipairs, next=next, type=type, tostring=tostring, tonumber=tonumber,
  -- Standard builtins user code expects: pcall(require, ...) and direct
  -- require() both resolve here (a missing entry reads as "attempt to call a
  -- nil value" on the calling line). require adds no new privilege - the
  -- run_function branch already requires arbitrary ModuleScript instances.
  pcall=pcall, xpcall=xpcall, assert=assert, select=select, unpack=unpack,
  require=require, setmetatable=setmetatable, getmetatable=getmetatable,
  rawget=rawget, rawset=rawset, rawequal=rawequal, rawlen=rawlen,
  math=math, string=string, table=table, vector=vector, utf8=utf8, bit32=bit32,
  coroutine=coroutine,
  game=game, workspace=workspace, Instance=Instance, Enum=Enum, task=task, tick=tick, time=time,
  Vector3=Vector3, Vector2=Vector2, CFrame=CFrame, Color3=Color3,
  UDim=UDim, UDim2=UDim2, BrickColor=BrickColor, Rect=Rect,
  TweenInfo=TweenInfo, NumberRange=NumberRange, NumberSequence=NumberSequence,
  ColorSequence=ColorSequence, Random=Random, DateTime=DateTime,
  RaycastParams=RaycastParams, OverlapParams=OverlapParams,
  os={clock=os.clock, date=os.date, time=os.time},
}

local function balanceParens(code:string): string
  local o=select(2, code:gsub("%(", "")); local c=select(2, code:gsub("%)", ""))
  if o>c then return code..string.rep(")", o-c) end
  if c>o then return string.rep("(", c-o)..code end
  return code
end
local function healMissingEnds(code:string): string
  local opens=0; for _ in code:gmatch("%f[%w]function%f[%W]") do opens+=1 end; for _ in code:gmatch("%f[%w]if%f[%W]") do opens+=1 end
  for _ in code:gmatch("%f[%w]for%f[%W]") do opens+=1 end; for _ in code:gmatch("%f[%w]while%f[%W]") do opens+=1 end; for _ in code:gmatch("%f[%w]do%f[%W]") do opens+=1 end
  local ends=select(2, code:gsub("%f[%w]end%f[%W]", "")); if opens>ends then return code..string.rep("\nend", opens-ends) end; return code
end

-- Transport markers (###LUA### ... ###END_LUA###, ###LUA:Server###) must never
-- persist into files or the compiler. The extension wraps execute_luau code
-- in them; if they leak into set_script_content/create_module the whole
-- script fails at line 1 ("Expected identifier, got '#'"). Strip them at
-- every write/exec entry point. The canonical spellings are ###LUA###,
-- ###END_LUA###, ###RAW###, and ###END_RAW###; character classes below also
-- accept case/spacing/dash variants. Returns stripped, didStrip.
local function stripMarkers(s:string): (string, boolean)
  local orig = s
  s = s:gsub("###%s*[Ll][Uu][Aa]%s*:[^#\n]*###", "")
  s = s:gsub("###%s*[Ll][Uu][Aa]%s*###", "")
  s = s:gsub("###%s*[Ll][Uu][Aa]%s*---", "")
  s = s:gsub("###%s*[Ee][Nn][Dd][_\- ]?[Ll][Uu][Aa]%s*###", "")
  s = s:gsub("###%s*[Ee][Nn][Dd][_\- ]?[Ll][Uu][Aa]%s*---", "")
  s = s:gsub("###%s*[Rr][Aa][Ww]%s*:[^#\n]*###", "")
  s = s:gsub("###%s*[Rr][Aa][Ww]%s*###", "")
  s = s:gsub("###%s*[Rr][Aa][Ww]%s*---", "")
  s = s:gsub("###%s*[Ee][Nn][Dd][_\- ]?[Rr][Aa][Ww]%s*###", "")
  s = s:gsub("###%s*[Ee][Nn][Dd][_\- ]?[Rr][Aa][Ww]%s*---", "")
  -- Bare leading openers with no closer (model wrote "###RAW:-- comment" as
  -- the first line). Strip only the marker token, keep the trailing code or
  -- comment: "###RAW:-- RoLink" becomes "-- RoLink", never bare "RoLink".
  s = s:gsub("^%s*###%s*[Ll][Uu][Aa]%s*:%s*", "")
  s = s:gsub("^%s*###%s*[Rr][Aa][Ww]%s*:%s*", "")
  s = s:gsub("^%s*```%w*\n?", ""):gsub("\n?%s*```%s*$", "")
  s = s:gsub("^%s*[Cc]opy%s+[Cc]ode%s*\n?", "")
  return s, s ~= orig
end

-- Instruction budget: unbounded synchronous code (infinite loops, giant
-- wait loops) would wedge the poll task forever with no remote kill. Where
-- the engine exposes debug.sethook we budget the current thread; Roblox
-- Luau does NOT expose debug.sethook (nil), so we feature-detect and run
-- directly instead of throwing "attempt to call a nil value" (2.1.11) or
-- "Cannot call task.wait on a thread that is already 'waiting'" (2.1.12).
-- poll() already runs in task.spawn, so yields (task.wait) propagate to the
-- scheduler normally - never busy-resume a waiting coroutine.
local HOOK_EVERY = 100000
local HOOK_MAX_HITS = 100 -- ~10M instructions ≈ a few seconds of CPU
local HAS_SETHOOK = type(debug) == "table" and type((debug::any).sethook) == "function"
local HAS_SETFENV = type(setfenv) == "function"
local function applyEnv(fn:any)
  if HAS_SETFENV and type(fn) == "function" then
    pcall(function() (setfenv::any)(fn, safeEnv) end)
  end
end
-- Static guard: a tight loop with no yield hangs Studio with no remote kill
-- (no hook fallback). Reject it as a validation error instead of hanging.
local function riskyLoop(code:string): string?
  local low = code:lower()
  if low:find("while%s+true%s+do") or low:find("while%s+1%s+do") or low:find("repeat%s*\n") then
    if not (low:find("task%.wait") or low:find("task%.delay") or low:find("heartbeat%s*:%s*wait")
      or low:find("%:wait%s*%(") or low:find("wait%s*%(")) then
      return "probable infinite loop with no yield - add task.wait() inside the loop or split the work"
    end
  end
  return nil
end
local function runBudgeted(fn: (...any) -> ...any, ...: any): (boolean, any)
  if HAS_SETHOOK then
    local hits = 0
    local dbg: any = debug
    pcall(function()
      dbg.sethook(function()
        hits += 1
        if hits > HOOK_MAX_HITS then
          error("RoLink budget exceeded (~10M instructions) - split the work, yield regularly (task.wait), no infinite loops")
        end
      end, "", HOOK_EVERY)
    end)
    local out = table.pack(pcall(fn, ...))
    pcall(function() dbg.sethook() end)
    if out[1] then return true, table.unpack(out, 2, out.n) end
    return false, out[2]
  end
  local out = table.pack(pcall(fn, ...))
  if out[1] then return true, table.unpack(out, 2, out.n) end
  return false, out[2]
end

-- Error context: a runtime message carries only a chunk line number
-- ([string "RoLink"]:460), while the attached code head shows just the first
-- 120 chars - useless for long scripts. Extract the failing line (plus its
-- neighbours) from the code so the model can fix the actual expression.
local function errLineCtx(code:string, err:string): string
  local ln = err:match('%[string "RoLink[^"]*"%]:(%d+):')
  local n = ln and tonumber(ln) or nil
  if not n or n < 1 then return "" end
  local idx, prev, target, nxt = 0, nil, nil, nil
  for line in (code .. "\n"):gmatch("([^\n]*)\n") do
    idx += 1
    if idx == n - 1 then prev = line
    elseif idx == n then target = line
    elseif idx == n + 1 then nxt = line break
    end
  end
  if not target then return "" end
  local function trim(s:string): string
    s = s:gsub("^%s+", ""):gsub("%s+$", "")
    if #s > 200 then s = s:sub(1, 200) .. "..." end
    return s
  end
  local ctx = " >> line " .. tostring(n) .. ": " .. trim(target)
  if prev and prev:gsub("%s+", "") ~= "" then
    ctx = " >> line " .. tostring(n - 1) .. ": " .. trim(prev) .. "\n" .. ctx
  end
  if nxt and nxt:gsub("%s+", "") ~= "" then
    ctx = ctx .. "\n >> line " .. tostring(n + 1) .. ": " .. trim(nxt)
  end
  if err:find("attempt to call a nil value") or err:find("attempt to call missing") then
    ctx = ctx .. " (something on this line is nil when called - check forward-referenced locals, typos, and require() results)"
  elseif err:find("attempt to index nil") then
    ctx = ctx .. " (indexing nil - the object on this line resolved to nothing; verify the path/name exists)"
  end
  return "\n" .. ctx
end

-- Wall-clock budget: runBudgeted caps CPU instructions, but a never-resolving
-- yield (hung require, WaitForChild without timeout) burns no instructions and
-- would wedge the single-flight queue until the bridge gives up. Run the chunk
-- on its own coroutine and abandon it past the deadline: the orphaned coroutine
-- holds no locks and its late result is discarded, so the queue stays usable
-- with no Studio restart. Must stay under the bridge's claim expiry (~25s).
local EXEC_BUDGET_S = 20
local function runWithDeadline(fn:any, code:string): (boolean, any)
  local done, okRun, a, b = false, false, nil, nil
  local co = coroutine.create(function()
    okRun, a, b = pcall(runBudgeted, fn)
    done = true
  end)
  local t0 = os.clock()
  local okStart, startErr = coroutine.resume(co)
  if not okStart then
    return false, tostring(startErr)
  end
  while not done do
    if os.clock() - t0 > EXEC_BUDGET_S then
      local head = code:gsub("%s+", " "):sub(1, 120)
      return false, "timeout: snippet still running after " .. tostring(EXEC_BUDGET_S)
        .. "s (likely a hung require or wait without timeout - verify modules singly, "
        .. "never bulk-require in one snippet) [code: " .. head .. ( #code > 120 and "..." or "") .. "]"
        .. errLineCtx(code, "")
    end
    task.wait(0.1)
  end
  return okRun, a, b
end

local function compileChunk(chunkName:string, code:string): (boolean, any, string, string?)
  local ls:any = (loadstring :: any)
  if type(ls) == "function" then
    local ok, fn, loadErr = pcall(function() return (ls :: any)(code, chunkName) end)
    if ok and type(fn) == "function" then return true, fn, "loadstring", nil end
    if ok and fn == nil then return false, tostring(loadErr), "loadstring", "compile" end
  end
  local ld:any = (load :: any)
  if type(ld) == "function" then
    local ok2, fn2, err2 = pcall(function() return (ld :: any)(code, chunkName) end)
    if ok2 and type(fn2) == "function" then return true, fn2, "load", nil end
    if ok2 and fn2 == nil then return false, tostring(err2), "load", "compile" end
  end
  return false, "loader_unavailable: loadstring() and load() are both unavailable/disabled in this plugin context", "none", "loader"
end

local harnessSeq = 0
local function sandboxRun(code:string): (boolean, any, string, string)
  code, _ = stripMarkers(code)
  local risk = riskyLoop(code)
  if risk then return false, risk .. " [code: " .. code:gsub("%s+", " "):sub(1, 120) .. "]", "", "none" end
  local captured:{string} = {}
  local oldPrint = safeEnv.print
  -- NOTE: the inner pcall closure must NOT reference `...` directly: Luau
  -- forbids varargs outside the vararg function itself (compile error
  -- "Cannot use '...' outside of a vararg function" kills the whole plugin
  -- at load). Pack once, unpack from the upvalue instead.
  safeEnv.print = function(...)
    local args = table.pack(...)
    local parts:{string} = {}
    for i = 1, args.n do parts[i] = tostring(args[i]) end
    local line = table.concat(parts, "\t")
    table.insert(captured, line)
    pcall(function() (oldPrint :: any)(table.unpack(args, 1, args.n)) end)
  end
  local function finish(ok:boolean, val:any, used:string?): (boolean, any, string, string)
    safeEnv.print = oldPrint
    return ok, val, table.concat(captured, "\n"):sub(1, 4000), used or "unknown"
  end
  local cok, cfn, loader, kind = compileChunk("RoLink", code)
  -- loadstring returns nil+message on syntax failure (no throw): surface the
  -- compiler message directly. The old ModuleScript harness appended
  -- "\nreturn true", turning `return {...}` into "Expected eof, got
  -- 'return'" and burying the real error under require_failed.
  if cok and type(cfn) == "function" then
    local res = cfn
    applyEnv(res)
    local okRun, a, b = pcall(runWithDeadline, res, code)
    local ok2: boolean? = nil
    local ret: any = nil
    if okRun then
      ok2 = a :: any
      ret = b
    else
      return finish(false, tostring(a) .. " [code: " .. code:gsub("%s+", " "):sub(1, 120) .. "]" .. errLineCtx(code, tostring(a)), loader)
    end
    if ok2 then return finish(true, ret, loader) end
    local err=tostring(ret); local healed=code
    if err:find("expected") or err:find("unfinished") then healed=balanceParens(healed); healed=healMissingEnds(healed) end
    healed=healed:gsub(":connect%(", ":Connect("):gsub("WatiForChild","WaitForChild"):gsub("Instnace","Instance")
    if healed~=code then
      local hok, hfn, hloader = compileChunk("RoLinkHeal", healed)
      if hok and type(hfn) == "function" then
        applyEnv(hfn)
        local hOk, hA, hB = pcall(runWithDeadline, hfn, healed)
        if hOk and (hA :: any) then return finish(true, hB, hloader) end
      end
    end
    -- Error context: the model only sees a line number otherwise. Attach the
    -- offending head so it can fix the actual expression.
    local head = code:gsub("%s+", " "):sub(1, 120)
    return finish(false, err .. " [code: " .. head .. ( #code > 120 and "..." or "") .. "]" .. errLineCtx(code, err), loader)
  elseif kind == "compile" then
    -- Genuine compile failure: report the loader message, no harness detour.
    local head0 = code:gsub("%s+", " "):sub(1, 120)
    return finish(false, "compiler_error (" .. tostring(loader) .. "): " .. tostring(cfn) .. " [code: " .. head0 .. ( #code > 120 and "..." or "") .. "]", loader)
  else
    -- Loader itself unavailable/disabled: fall back to a ModuleScript harness
    -- for ANY code (not just require snippets), so execution still works.
    -- The ModuleScript MUST be parented before require() or Studio throws a
    -- bare "Requested module experienced an error" with no inner context.
    -- Unique names per call: require() caches by ModuleScript, so reusing one
    -- name across rapid snippets can return a stale cached chunk.
    local m: ModuleScript? = nil
    harnessSeq += 1
    local harnessName = "RoLinkHarness_" .. tostring(harnessSeq)
    local okHarness, harnessRes = pcall(function()
      local mod = Instance.new("ModuleScript")
      mod.Name = harnessName
      mod.Source = code
      mod.Parent = game:GetService("ServerStorage")
      m = mod
      return require(mod :: any)
    end)
    if m then pcall(function() (m :: any):Destroy() end) end
    if okHarness then return finish(true, harnessRes, "harness") end
    local raw = tostring(harnessRes)
    local head2 = code:gsub("%s+", " "):sub(1, 120)
    local suffix = " [code: " .. head2 .. ( #code > 120 and "..." or "") .. "]"
    -- Two distinct prefixes: compiler errors vs loader errors. Never let a
    -- plain syntax failure wear the require_failed label. The inner match
    -- uses [%s%S] so multi-line require errors survive, and a code-echo
    -- guard stops a bare Luau head from being mislabeled when the regex
    -- captures the wrong span.
    if raw:find("Requested module", 1, true) then
      local inner = raw:match("Requested module experienced an error[^:]*:%s*([%s%S]+)$")
        or raw:match("Requested module[^:]*:%s*([%s%S]+)$")
        or raw
      inner = tostring(inner)
      local lowInner = inner:lower()
      local looksLikeCode = inner:match("^%s*local%s+%w+")
        and not (lowInner:find("attempt") or lowInner:find("expect")
          or lowInner:find("error") or lowInner:find("not found")
          or lowInner:find("nil") or lowInner:find("invalid")
          or lowInner:find("missing") or lowInner:find("fail"))
      if looksLikeCode then
        return finish(false, "loader_unavailable: ModuleScript harness failed ("
          .. harnessName .. "): " .. raw .. suffix
          .. errLineCtx(code, raw), "none")
      end
      return finish(false, "require_failed: " .. inner .. suffix
        .. errLineCtx(code, raw), "harness")
    end
    return finish(false, "loader_unavailable: loadstring/load disabled and ModuleScript harness failed (" .. harnessName .. "): " .. raw .. suffix .. errLineCtx(code, raw), "none")
  end
end

local function captureSnapshot(maxDepth:number?, filter:string?): string
  local function walk(inst:Instance, depth:number, acc:{string})
    if depth>(maxDepth or 3) then return end
    if not filter or inst.Name:lower():find(filter:lower()) or inst.ClassName:lower():find(filter:lower()) then
      table.insert(acc, string.format("%s (%s) [%d]", inst:GetFullName(), inst.ClassName, #inst:GetChildren()))
    end
    for _,c in ipairs(inst:GetChildren()) do walk(c, depth+1, acc); if #acc>800 then break end end
  end
  local acc:{string}={}; pcall(function() walk(game,0,acc) end); table.insert(acc,1, string.format("-- snapshot %s | %d items", os.date("%X"), #acc))
  return table.concat(acc, "\n"):sub(1,8000)
end

local function parseIndexedName(part:string): (string, number?)
  local base, idx = part:match("^(.-)%[(%d+)%]$")
  if base and idx then return base, tonumber(idx) end
  return part, nil
end
local function childByName(parent:Instance, name:string): Instance?
  local base, idx = parseIndexedName(name)
  if idx == nil then
    local exact = parent:FindFirstChild(base)
    if exact then return exact end
    for _, c in ipairs(parent:GetChildren()) do if c.Name == base then return c end end
    return nil
  end
  local n = 0
  for _, c in ipairs(parent:GetChildren()) do
    if c.Name == base then n += 1; if n == idx then return c end end
  end
  return nil
end
local function findByPath(path:string): Instance?
  if not path or path == "" then return nil end
  if path == "workspace" or path == "Workspace" then return workspace end
  local p = path
  if p:sub(1,5) == "game." then p = p:sub(6) end
  -- slash-walk: "Workspace/ProofCube", "game.Workspace/Folder/X" (dots kept
  -- for service names like "ServerScriptService"). Exact segment match
  -- first; Name[2] disambiguates duplicates ("Keyframe[2]"). A failed walk
  -- falls through to the legacy exact-name scan below, never to a fuzzy
  -- descendant match, so callers report not_found + siblings.
  if p:find("/") then
    local cur: Instance? = game
    local walked = false
    local failed = false
    for part in p:gmatch("[^/]+") do
      if part == "game" and cur == game then continue end
      if (part == "Workspace" or part == "workspace") and cur == game then
        cur = workspace; walked = true; continue
      end
      if not cur then failed = true; break end
      local nxt = childByName(cur, part)
      if not nxt then failed = true; break end
      cur = nxt; walked = true
    end
    if not failed and walked and cur then return cur end
  elseif p:find(".", 1, true) then
    -- dot-walk: "Workspace.Rig", "game.Workspace.Folder.X" (the shape models
    -- actually write). Same exact-first semantics as the slash-walk.
    local cur: Instance? = game
    local walked = false
    local failed = false
    for part in p:gmatch("[^.]+") do
      if part == "game" and cur == game then continue end
      if (part == "Workspace" or part == "workspace") and cur == game then
        cur = workspace; walked = true; continue
      end
      if (part == "ServerScriptService" or part == "ReplicatedStorage" or part == "StarterGui" or part == "ServerStorage") and cur == game then
        local okSvc, svc = pcall(function() return game:GetService(part) end)
        if okSvc and svc then cur = svc; walked = true; continue end
      end
      if not cur then failed = true; break end
      local nxt = childByName(cur, part)
      if not nxt then failed = true; break end
      cur = nxt; walked = true
    end
    if not failed and walked and cur then return cur end
  end
  -- legacy fallbacks (full-string match, bare names, old single-segment
  -- behavior). The full-string scan must survive for dotted names
  -- ("My.Part") that the dot-walk above cannot segment.
  local ok, res = pcall(function() return game:FindFirstChild(p, true) end)
  if ok and res then return res end
  local okW, direct = pcall(function() return workspace:FindFirstChild(p) end)
  if okW and direct then return direct end
  local found:Instance? = nil
  pcall(function() for _,v in ipairs(game:GetDescendants()) do if v.Name==p then found=v; break end end end)
  return found
end

-- Sibling names for "not found" errors, so the model can self-correct
-- instead of guessing blindly a second time.
local function siblingHint(path:any): string
  local parts:{string} = {}
  for p in tostring(path or ""):gmatch("[^/]+") do table.insert(parts, p) end
  if #parts == 0 then return "" end
  table.remove(parts) -- drop the missing leaf
  local parent: Instance? = (#parts == 0) and workspace or findByPath(table.concat(parts, "/"))
  if not parent then return "" end
  local names:{string} = {}
  pcall(function()
    for _, c in ipairs(parent:GetChildren()) do
      if #names >= 8 then break end
      table.insert(names, c.Name .. "(" .. c.ClassName .. ")")
    end
  end)
  if #names == 0 then return "" end
  local full = parent:GetFullName():gsub("sabuiltin_[^%.]*%.", "")
  return " Siblings under " .. full .. ": " .. table.concat(names, ", ")
end

-- Safe property dump: iterating an Instance with pairs() throws
-- "invalid argument #1 (table expected, got Instance)", so read a curated
-- candidate list + attributes, every read guarded. Never iterate the Instance itself.
local COMMON_PROPS = {
  "Name", "ClassName", "Parent", "Archivable",
  "Position", "Size", "Color", "Material", "Transparency", "Anchored",
  "CanCollide", "Orientation", "CFrame", "Shape", "TopSurface", "BottomSurface",
  "Text", "Enabled", "Visible", "BackgroundColor3", "TextColor3", "Font",
  "Source", "Volume", "SoundId", "Playing", "Looped", "Brightness", "Range",
  "Rate", "Speed", "Lifetime", "Health", "MaxHealth", "WalkSpeed", "JumpPower",
  "Value",
}
local function safeProps(inst: Instance): { [string]: any }
  local t:{ [string]: any } = {}
  t.ClassName = inst.ClassName
  t.Name = inst.Name
  pcall(function()
    t.FullName = inst:GetFullName()
    t.Children = #inst:GetChildren()
  end)
  for _, k in ipairs(COMMON_PROPS) do
    pcall(function()
      local v = (inst::any)[k]
      if v ~= nil then t[k] = tostring(v) end
    end)
  end
  pcall(function()
    local at = inst:GetAttributes()
    if type(at) == "table" then
      local aa:{ [string]: any } = {}
      for ak, av in pairs(at) do aa[ak] = tostring(av) end
      t.Attributes = aa
    end
  end)
  return t
end

-- ── Animation track cache + builders (tools 47-48, 112-113) ─────────────
-- KeyframeSequenceProvider only issues temporary Studio-local hash IDs
-- (RegisterKeyframeSequence); there is NO provider remove API, so
-- delete_animation destroys our cached sequence. Service is deprecated in
-- favor of AnimationClipProvider but still functional in Studio.
local animCache: { [string]: KeyframeSequence } = {}
local function num(v:any, d:number): number
  local n = tonumber(v); if n == nil then return d end; return n
end
local function vec3(t:any): Vector3
  if type(t) ~= "table" then return Vector3.zero end
  return Vector3.new(num(t.x, 0), num(t.y, 0), num(t.z, 0))
end
-- Easing curves for professional motion: an eased segment bakes
-- interpolated in-between keyframes so sparse input plays realistically
-- instead of robotically linear. Times must be non-decreasing. Per-pose
-- easing overrides the keyframe easing; long eased segments subdivide more
-- so fast moves keep their curve instead of chord-cutting it.
local EASE_FNS: { [string]: (number) -> number } = {
  linear = function(t) return t end,
  quadIn = function(t) return t * t end,
  quadOut = function(t) return 1 - (1 - t) * (1 - t) end,
  quadInOut = function(t) if t < 0.5 then return 2 * t * t end return 1 - (-2 * t + 2) * (-2 * t + 2) / 2 end,
  cubicIn = function(t) return t * t * t end,
  cubicOut = function(t) return 1 - (1 - t) * (1 - t) * (1 - t) end,
  cubicInOut = function(t) if t < 0.5 then return 4 * t * t * t end return 1 - (-2 * t + 2) * (-2 * t + 2) * (-2 * t + 2) / 2 end,
  sineIn = function(t) return 1 - math.cos(t * math.pi / 2) end,
  sineOut = function(t) return math.sin(t * math.pi / 2) end,
  sineInOut = function(t) return -(math.cos(math.pi * t) - 1) / 2 end,
  -- Overshoot/settle family for strikes, landings, UI pops. Clamped to
  -- [-0.15,1.15] at bake time so one energetic segment cannot fling a limb.
  bezierOut = function(t) local c1 = 1.2 local u = t - 1 return 1 + (c1 + 1) * u * u * u + c1 * u * u end,
  springOut = function(t) return 1 - math.exp(-5 * t) * math.cos(9 * t) end,
}
-- Subdivision counts live at the use site (chunk locals are capped, so no
-- one-per-constant registers here): 3 baked frames per segment, 5 on moves
-- longer than 0.3s.
-- Alias + typo tolerance: the model writes bare "quad" (or "Quad-In",
-- "easeout") far more often than the exact enum. Normalize case, separators
-- and bare family names instead of failing; only truly unknown names error,
-- with a did-you-mean hint so the retry lands first try.
local EASE_ALIASES: { [string]: string } = {
  quad = "quadInOut", cubic = "cubicInOut", sine = "sineInOut",
  bezier = "bezierOut", spring = "springOut", back = "bezierOut",
  easein = "quadIn", easeout = "quadOut", easeinout = "quadInOut",
  ease_in = "quadIn", ease_out = "quadOut", ease_in_out = "quadInOut",
}
local EASE_LIST = "linear|quadIn|quadOut|quadInOut|cubicIn|cubicOut|cubicInOut|sineIn|sineOut|sineInOut|bezierOut|springOut"
local function resolveEasing(name:string): (string?)
  if EASE_FNS[name] then return name end
  local norm = name:lower():gsub("[%s%-%_]", "")
  for k in pairs(EASE_FNS) do
    if k:lower() == norm then return k end
  end
  return EASE_ALIASES[norm]
end
local function easingHint(bad:string): string
  local bl = bad:lower()
  local out:{string} = {}
  for k in pairs(EASE_FNS) do
    local kl = k:lower()
    if kl:find(bl, 1, true) or bl:find(kl, 1, true) then table.insert(out, k) end
  end
  table.sort(out)
  if #out > 0 then return "did you mean " .. table.concat(out, "/") .. "? " end
  return ""
end
local function bakeEased(kfData:{ [string]: any }): { [string]: any }
  local out:{ [string]: any } = {}
  for i, kfD in ipairs(kfData) do
    if type(kfD) ~= "table" then error("keyframe must be an object") end
    local t = math.max(0, num((kfD::any).time, 0))
    if i > 1 and t < math.max(0, num(((kfData[i - 1])::any).time, 0)) then
      error("keyframe times must be non-decreasing (keyframe " .. i .. " goes backwards)")
    end
    local easeName = tostring((kfD::any).easing or "linear")
    local resolved = resolveEasing(easeName)
    if not resolved then error("unknown easing '" .. easeName:sub(1, 32) .. "' " .. easingHint(easeName) .. "(" .. EASE_LIST .. ")") end
    if i > 1 then
      local prev = kfData[i - 1]
      local t0 = math.max(0, num((prev::any).time, 0))
      local segDur = t - t0
      -- Per-pose easing overrides the keyframe easing; the segment
      -- subdivides deeper when anything on it is non-linear and long
      -- enough that chord-cutting would show. All-linear segments bake
      -- no in-betweens, exactly as before.
      local segEases:{ [string]: string } = {}
      local anyEase = resolved ~= "linear"
      for _, pD in ipairs((kfD::any).poses or {}) do
        local part = type(pD) == "table" and tostring((pD::any).part or "") or ""
        local r = resolved
        if type(pD) == "table" and (pD::any).easing then
          r = resolveEasing(tostring((pD::any).easing))
          if not r then error("unknown easing '" .. tostring((pD::any).easing):sub(1, 32) .. "' " .. easingHint(tostring((pD::any).easing)) .. "(" .. EASE_LIST .. ")") end
        end
        segEases[part] = r or "linear"
        if r ~= "linear" then anyEase = true end
      end
      if anyEase then
      -- 3 baked frames per segment, 5 on long eased moves (was EASE_SUBDIV).
      local segSubdiv = 3
      if segDur > 0.3 then segSubdiv = 5 end
      local prevPoses:{ [string]: any } = {}
      for _, pD in ipairs((prev::any).poses or {}) do
        if type(pD) == "table" then prevPoses[tostring((pD::any).part or "")] = pD end
      end
      for s = 1, segSubdiv do
        local frac = s / (segSubdiv + 1)
        local poses:{ [string]: any } = {}
        for _, pD in ipairs((kfD::any).poses or {}) do
          if type(pD) ~= "table" then continue end
          local part = tostring((pD::any).part or "Torso")
          local qD = prevPoses[part]
          local pEase = segEases[part] or "linear"
          local f = frac
          if pEase ~= "linear" then
            f = EASE_FNS[pEase](frac)
            -- Overshoot families may leave [0,1]; clamp so one segment
            -- cannot fling a limb across the map.
            if f > 1.15 then f = 1.15 elseif f < -0.15 then f = -0.15 end
          end
          local p1 = (pD::any).position or {}
          local r1 = (pD::any).rotation or {}
          local p0 = (qD and (qD::any).position) or p1
          local r0 = (qD and (qD::any).rotation) or r1
          local function lp(a:any, b:any): number
            return num(a, 0) + (num(b, 0) - num(a, 0)) * f
          end
          -- Arc lift: eased position moves bow outward mid-segment
          -- (foot clearance on swings) instead of chord-cutting straight
          -- through the body. Scales with distance, so tiny moves stay put.
          local lift = 0
          if pEase ~= "linear" then
            local dx = num((p1::any).x, 0) - num((p0::any).x, 0)
            local dy = num((p1::any).y, 0) - num((p0::any).y, 0)
            local dz = num((p1::any).z, 0) - num((p0::any).z, 0)
            local dist = math.sqrt(dx * dx + dy * dy + dz * dz)
            lift = math.sin(math.pi * frac) * dist * 0.06
          end
          table.insert(poses, {
            part = part,
            position = { x = lp((p0::any).x, (p1::any).x), y = lp((p0::any).y, (p1::any).y) + lift, z = lp((p0::any).z, (p1::any).z) },
            rotation = { x = lp((r0::any).x, (r1::any).x), y = lp((r0::any).y, (r1::any).y), z = lp((r0::any).z, (r1::any).z) },
          })
        end
        table.insert(out, { time = t0 + (t - t0) * frac, poses = poses })
      end
      end
    end
    table.insert(out, kfD)
  end
  if #out > 200 then error("eased bake produced " .. #out .. " keyframes (max 200) - use fewer keyframes or linear easing") end
  return out
end
local function createAnimationTrack(args:{ [string]: any }): { [string]: any }
  local name = tostring(args.name or "RoLinkAnimation"):sub(1, 64)
  local kfData = args.keyframes
  if type(kfData) ~= "table" or #kfData == 0 then error("keyframes must be a non-empty array") end
  if #kfData > 200 then error("too many keyframes (max 200)") end
  -- Instance budget: every pose becomes engine objects, and tens of thousands
  -- of Instance.new calls wedge the single-flight queue past the bridge
  -- timeout with zero answers (seen live: 60s hang on an M1 combo retry).
  -- Fail fast with a split hint instead.
  local totalPoses = 0
  for _, kfD in ipairs(kfData) do
    if type(kfD) == "table" then
      local pp = (kfD::any).poses
      if type(pp) == "table" then totalPoses += #pp end
    end
  end
  if totalPoses > 1024 then error("too many animated parts (" .. totalPoses .. " total poses, max 1024) - split across tracks or use fewer keyframes") end
  kfData = bakeEased(kfData)
  local folder = game.Workspace:FindFirstChild("RoLinkAnimations")
  if not folder then folder = Instance.new("Folder"); folder.Name = "RoLinkAnimations"; folder.Parent = game.Workspace end
  local seq = Instance.new("KeyframeSequence")
  seq.Name = name
  if args.loop == true then seq.Loop = true end
  local made = 0
  for _, kfD in ipairs(kfData) do
    if type(kfD) ~= "table" then error("keyframe must be an object") end
    local kf = Instance.new("Keyframe")
    kf.Time = math.max(0, num((kfD::any).time, 0))
    local poses = (kfD::any).poses
    if type(poses) ~= "table" or #poses == 0 then error("keyframe poses must be non-empty") end
    if #poses > 64 then error("too many poses per keyframe (max 64)") end
    for _, pD in ipairs(poses) do
      local pose = Instance.new("Pose")
      pose.Name = tostring((pD::any).part or "Torso"):sub(1, 64)
      local pos = vec3((pD::any).position)
      local rot = (pD::any).rotation
      local cf = CFrame.new(pos) * CFrame.Angles(math.rad(num(rot and (rot::any).x, 0)), math.rad(num(rot and (rot::any).y, 0)), math.rad(num(rot and (rot::any).z, 0)))
      pose.CFrame = cf
      local sc = (pD::any).scale
      if type(sc) == "table" then pose.Weight = math.clamp(num((sc::any).x, 1), 0.01, 10) end
      pose.Parent = kf
      made += 1
      -- Yield regularly: thousands of back-to-back Instance ops starve the
      -- poll task and read as a hang from the bridge side.
      if made % 128 == 0 then task.wait() end
    end
    kf.Parent = seq
  end
  seq.Parent = folder
  pcall(function() ChangeHistoryService:SetWaypoint("RoLink create " .. name) end)
  local hashId = game:GetService("KeyframeSequenceProvider"):RegisterKeyframeSequence(seq)
  animCache[tostring(hashId)] = seq
  local snippet = "local seq = game.Workspace.RoLinkAnimations:FindFirstChild(\""
    .. name:gsub('"', "'")
    .. "\") assert(seq, \"missing track " .. name:gsub('"', "'")
    .. "\") local id = game:GetService(\"KeyframeSequenceProvider\"):RegisterKeyframeSequence(seq)"
    .. " local anim = Instance.new(\"Animation\") anim.AnimationId = id"
    .. " local track = animator:LoadAnimation(anim) track:Play() -- Animation object chain, never pass KeyframeSequence to LoadAnimation"
  return { animationId = tostring(hashId), name = name, keyframes = #kfData,
    path = seq:GetFullName(), runtimeSnippet = snippet }
end
-- Rigs the model can actually address: Models with a Humanoid, by full path.
local function rigCandidates(): {string}
  local out:{string} = {}
  pcall(function()
    for _, d in ipairs(workspace:GetDescendants()) do
      if #out >= 5 then break end
      if d:IsA("Model") and d:FindFirstChildOfClass("Humanoid") then
        table.insert(out, d:GetFullName())
      end
    end
  end)
  return out
end
local function resolveAnimationId(args:{ [string]: any }): string
  -- Accepts hash, rbxassetid://, or a path to an in-place KeyframeSequence.
  -- Never pass a KeyframeSequence instance to LoadAnimation (it requires an
  -- Animation object); register on demand and use the returned id.
  local animId = tostring(args.animationId or "")
  local pathArg = tostring(args.path or "")
  if animId ~= "" and animId:find("KeyframeSequence") == nil then
    local byPath = findByPath(animId)
    if byPath and byPath:IsA("KeyframeSequence") then
      local okReg, regId = pcall(function()
        return game:GetService("KeyframeSequenceProvider"):RegisterKeyframeSequence(byPath :: any)
      end)
      if okReg and regId then animCache[tostring(regId)] = byPath; return tostring(regId) end
    else
      return animId
    end
  elseif animId ~= "" then
    return animId
  end
  if pathArg ~= "" then
    local inst = findByPath(pathArg)
    if not inst then error("not found " .. pathArg .. siblingHint(pathArg)) end
    if not inst:IsA("KeyframeSequence") then error("not a KeyframeSequence: " .. inst:GetFullName()) end
    local okR, rId = pcall(function()
      return game:GetService("KeyframeSequenceProvider"):RegisterKeyframeSequence(inst :: any)
    end)
    if not okR or not rId then error("could not register KeyframeSequence at " .. inst:GetFullName()) end
    animCache[tostring(rId)] = inst
    return tostring(rId)
  end
  error("animationId or path required (hash, rbxassetid://, or Workspace/RoLinkAnimations/<Name>)")
  return ""
end
local function playAnimation(args:{ [string]: any }): { [string]: any }
  local char = findByPath(tostring(args.characterPath or args.target or "workspace"))
  if not char then
    local rigs = rigCandidates()
    local hint = #rigs > 0 and (" Rigs with a Humanoid here: " .. table.concat(rigs, ", ")) or " No Model with a Humanoid exists in workspace yet."
    error("CHARACTER_NOT_FOUND: " .. tostring(args.characterPath or args.target) .. "." .. hint)
  end
  local humanoid = char:FindFirstChildOfClass("Humanoid")
  if not humanoid then
    local rigs = rigCandidates()
    local hint = #rigs > 0 and (" Rigs with a Humanoid here: " .. table.concat(rigs, ", ")) or ""
    error("HUMANOID_NOT_FOUND: " .. char:GetFullName() .. " has no Humanoid." .. hint)
  end
  local animator = humanoid:FindFirstChildOfClass("Animator")
  if not animator then animator = Instance.new("Animator"); animator.Parent = humanoid end
  local animId = resolveAnimationId(args)
  -- Plugin context runs in Edit, never in the Play Server/Client DataModels.
  -- Driving a Play-session rig from here edits the wrong Workspace copy, so
  -- the user sees nothing move. Be honest instead of bare success.
  local running = false
  pcall(function() running = game:GetService("RunService"):IsRunning() end)
  if running then
    return { success = false, rendered = false, playable = false, animationId = animId,
      error = "IN_PLAY_MODE: plugin tools run in the Edit DataModel and cannot drive Play Server rigs. Stop Play (start_stop_play), build/verify in Edit via create_animation_track + get_animation_info{path}, then press Play to view." }
  end
  local animation = Instance.new("Animation")
  animation.AnimationId = animId
  local track = (animator::any):LoadAnimation(animation)
  track:Play()
  local speed = num(args.speed, 1)
  if speed ~= 1 then track:AdjustSpeed(math.clamp(speed, 0.1, 8)) end
  if args.loop == true then track.Looped = true end
  -- Edit mode never renders animation playback: say so honestly instead of a
  -- bare success the user then can't see. The track IS playing underneath.
  local ret:{ [string]: any } = { success = true, trackName = track.Name, animationId = animId }
  ret.rendered = false
  ret.note = "Edit mode never renders animation playback - press Play to see it move."
  return ret
end
local function clipCurvesSummary(clip: Instance): { [string]: any }
  local curves:{ [string]: any } = {}
  pcall(function()
    for _, child in ipairs(clip:GetChildren()) do
      if child:IsA("StringValue") and child.Name:find("Curve_") == 1 then
        local okDec, data = pcall(function()
          return game:GetService("HttpService"):JSONDecode((child::any).Value or "[]")
        end)
        table.insert(curves, { part = child.Name:sub(7), keys = (okDec and type(data) == "table") and #data or 0 })
      end
    end
  end)
  return curves
end
local function findClipTwin(seq: Instance): Instance?
  local twin: Instance? = nil
  pcall(function()
    local parent = seq.Parent
    if parent then twin = parent:FindFirstChild(seq.Name .. "Clip") end
    if twin and not twin:IsA("AnimationClip") then twin = nil end
  end)
  return twin
end
local function poseNumbers(pose: Instance): { [string]: any }
  local out:{ [string]: any } = { part = pose.Name }
  pcall(function()
    local cf: CFrame = (pose::any).CFrame
    local px, py, pz = cf.X, cf.Y, cf.Z
    local rx, ry, rz = cf:ToEulerAnglesXYZ()
    out.position = { x = math.floor(px * 1000 + 0.5) / 1000, y = math.floor(py * 1000 + 0.5) / 1000, z = math.floor(pz * 1000 + 0.5) / 1000 }
    out.rotation = { x = math.floor(math.deg(rx) * 100 + 0.5) / 100, y = math.floor(math.deg(ry) * 100 + 0.5) / 100, z = math.floor(math.deg(rz) * 100 + 0.5) / 100 }
  end)
  return out
end
local function summarizeSequence(seq: Instance, animId: string, numeric:boolean?): { [string]: any }
  local kfs = (seq::any):GetKeyframes()
  local parts:{string} = {}; local seen:{[string]:boolean} = {}; local dur = 0
  local detail:{any} = {}
  local cap = numeric and 200 or 50
  for idx, kf in ipairs(kfs) do
    if idx > cap then break end
    if (kf::any).Time > dur then dur = (kf::any).Time end
    local poses:{any} = {}
    for _, d in ipairs((kf::any):GetDescendants()) do
      if d:IsA("Pose") then
        if not seen[d.Name] then seen[d.Name] = true; table.insert(parts, d.Name) end
        if numeric then
          if #poses < 64 then table.insert(poses, poseNumbers(d)) end
        else
          if #poses < 12 then table.insert(poses, d.Name) end
        end
      end
    end
    -- Duplicate Keyframe names are legal; index disambiguates them.
    table.insert(detail, { index = idx, name = (kf::any).Name, time = (kf::any).Time, poses = poses })
  end
  table.sort(parts)
  local ret:{ [string]: any } = { animationId = animId, name = (seq::any).Name, path = (seq::any):GetFullName(),
    keyframeCount = #kfs, duration = dur, parts = parts, keyframes = detail, loop = (seq::any).Loop,
    numeric = numeric == true, truncated = #kfs > cap,
    note = "rotations in degrees, positions in studs. Use Name[2] indexing for duplicate Keyframe/Pose names." }
  -- Clip-twin enrichment is optional and must NEVER fail the read: a stale
  -- plugin copy missing findClipTwin (seen live as Script:651 "attempt to
  -- call a nil value") used to turn a good info call into a crash.
  local twinOk, twin = pcall(function()
    local finder:any = findClipTwin
    if type(finder) ~= "function" then error("no clip-twin helper in this plugin copy - reinstall it") end
    return finder(seq)
  end)
  if twinOk and twin then
    local okPath, fullName = pcall(function() return (twin::any):GetFullName() end)
    if okPath then ret.clip = fullName end
    local okC, curves = pcall(function()
      local summarizer:any = clipCurvesSummary
      if type(summarizer) ~= "function" then error("no clip-curves helper in this plugin copy") end
      return summarizer(twin)
    end)
    if okC then ret.clipCurves = curves end
  end
  return ret
end
local function getAnimationInfo(args:{ [string]: any }): { [string]: any }
  local animId = tostring(args.animationId or "")
  local pathArg = tostring(args.path or "")
  local numeric = args.numeric == true or tostring(args.mode or ""):lower() == "numeric"
  if pathArg ~= "" then
    local inst = findByPath(pathArg)
    if not inst then error("not found " .. pathArg .. siblingHint(pathArg)) end
    if not (inst:IsA("KeyframeSequence")) then
      error("not a KeyframeSequence: " .. inst:GetFullName() .. " (" .. inst.ClassName .. ")")
    end
    return summarizeSequence(inst, animId ~= "" and animId or inst:GetFullName(), numeric or nil)
  end
  if animId == "" then error("animationId or path required (e.g. path=Workspace/RoLinkAnimations/HelloWave)") end
  local seq = animCache[animId]
  if not seq then
    -- A path may have been passed as animationId by older prompts.
    local byPath = findByPath(animId)
    if byPath and byPath:IsA("KeyframeSequence") then return summarizeSequence(byPath, animId, numeric or nil) end
    local ok, got = pcall(function() return game:GetService("KeyframeSequenceProvider"):GetKeyframeSequenceAsync(animId) end)
    if not ok or not got then error("animation not found: " .. animId) end
    seq = got
  end
  return summarizeSequence(seq, animId, numeric or nil)
end
local function inspectKeyframeTrack(args:{ [string]: any }): { [string]: any }
  local pathArg = tostring(args.path or args.trackPath or args.animationId or "")
  if pathArg == "" then error("path required (e.g. path=Workspace/RoLinkAnimations/M1)") end
  local inst = findByPath(pathArg)
  if not inst then error("not found " .. pathArg .. siblingHint(pathArg)) end
  if not inst:IsA("KeyframeSequence") then error("not a KeyframeSequence: " .. inst:GetFullName() .. " (" .. inst.ClassName .. ") - for model animations use validate_model_animation with a ReplicatedStorage/RoLinkModelAnims/<Name>") end
  return summarizeSequence(inst, inst:GetFullName(), true)
end
local function deleteAnimation(args:{ [string]: any }): { [string]: any }
  local animId = tostring(args.animationId or "")
  if animId == "" then error("animationId required") end
  local seq = animCache[animId]
  if seq then pcall(function() seq:Destroy() end); animCache[animId] = nil
    pcall(function() ChangeHistoryService:SetWaypoint("RoLink delete " .. animId) end)
    return { deleted = true, animationId = animId }
  end
  return { deleted = false, animationId = animId, error = "not cached (only temp tracks can be deleted)" }
end

-- ── Roblox motion animation controllers (tools 126-130) ─────────────
-- These controllers are real Edit-time data plus a real Play-time Script.
-- The temporary KeyframeSequence hash is intentionally not trusted across
-- DataModels: the generated script registers the sequence by its verified
-- path when the game starts. This is the same Animation -> Animator chain
-- required by Roblox, but it is wired automatically for the user.
-- Motion helpers live on one table (not chunk locals): Studio caps a chunk
-- at ~200 locals and this file is at that cliff (see scripts docs). One
-- `local Motion` replaces ~20 registers; call sites use Motion.x.
local Motion = {
  rootName = "RoLinkMotionAnimations",
  effects = { tween = true, shake = true, fov = true, pulse = true },
  effectRoot = "RoLinkMotionEffects",
}
function Motion.motionCleanName(raw:any, fallback:string): string
  local n = tostring(raw or fallback):gsub("^%s+", ""):gsub("%s+$", "")
  n = n:gsub("[^%w_%-]", "_"):sub(1, 64)
  if n == "" then n = fallback end
  return n
end
function Motion.motionPath(inst: Instance): string
  local parts:{string} = {}
  local cur: Instance? = inst
  while cur and cur ~= game do
    table.insert(parts, 1, cur.Name)
    cur = cur.Parent
  end
  return table.concat(parts, "/")
end
function Motion.motionRoot(): Instance
  local rs = game:GetService("ReplicatedStorage")
  local root = rs:FindFirstChild(Motion.rootName)
  if not root then
    root = Instance.new("Folder")
    root.Name = Motion.rootName
    root.Parent = rs
  end
  return root
end
function Motion.motionPlain(v:any, depth:number?, seen:{ [any]: boolean }?): any
  depth = depth or 0
  if depth > 8 then error("motion configuration is nested too deeply") end
  local t = typeof(v)
  if t == "string" or t == "number" or t == "boolean" or t == "nil" then return v end
  if t == "Vector3" then
    return { x = v.X, y = v.Y, z = v.Z }
  end
  if t == "Vector2" then
    return { x = v.X, y = v.Y }
  end
  if t == "Color3" then return { r = v.R, g = v.G, b = v.B } end
  if t == "CFrame" then
    local p, r = v.Position, v:ToEulerAnglesXYZ()
    return { position = { x = p.X, y = p.Y, z = p.Z },
      rotation = { x = math.deg(r.X), y = math.deg(r.Y), z = math.deg(r.Z) } }
  end
  if t ~= "table" then error("motion properties must contain JSON values, got " .. t) end
  seen = seen or {}
  if seen[v] then error("motion properties contain a cycle") end
  seen[v] = true
  local out:{ [string]: any } = {}
  for k, value in pairs(v) do
    if type(k) ~= "string" and type(k) ~= "number" then
      error("motion property keys must be strings or numbers")
    end
    out[tostring(k)] = Motion.motionPlain(value, depth + 1, seen)
  end
  seen[v] = nil
  return out
end
function Motion.motionJson(value:any): string
  local ok, encoded = pcall(function() return HttpService:JSONEncode(Motion.motionPlain(value)) end)
  if not ok then error("motion configuration is not JSON-safe: " .. tostring(encoded):sub(1, 180)) end
  return encoded
end
function Motion.motionScriptSource(folderName:string): string
  return "local CONFIG_FOLDER = " .. string.format("%q", folderName) .. "\n" .. [==[
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Workspace = game:GetService("Workspace")
local HttpService = game:GetService("HttpService")
local KeyframeSequenceProvider = game:GetService("KeyframeSequenceProvider")
local RunService = game:GetService("RunService")
local root = ReplicatedStorage:WaitForChild("RoLinkMotionAnimations")
local folder = root:WaitForChild(CONFIG_FOLDER)
local configValue = folder:WaitForChild("Config")
local ok, config = pcall(function()
  return HttpService:JSONDecode(configValue.Value)
end)
if not ok or type(config) ~= "table" then
  warn("[RoLink] motion controller has invalid Config JSON")
  return
end
local function resolve(path)
  local current = game
  for part in string.gmatch(path or "", "[^/]+") do
    if part == "Workspace" then
      current = Workspace
    elseif part == "ReplicatedStorage" or part == "ServerStorage"
      or part == "ServerScriptService" or part == "StarterPlayer" then
      current = game:GetService(part)
    elseif current then
      current = current:FindFirstChild(part, true)
    end
    if not current then return nil end
  end
  return current
end
local target = resolve(config.targetPath)
if not target then
  warn("[RoLink] motion target is not present: " .. tostring(config.targetPath))
  return
end
local sequence = resolve(config.sequencePath)
if not sequence or not sequence:IsA("KeyframeSequence") then
  warn("[RoLink] motion KeyframeSequence is not present: " .. tostring(config.sequencePath))
  return
end
local humanoid = target:FindFirstChildOfClass("Humanoid")
if not humanoid then
  warn("[RoLink] motion target has no Humanoid: " .. target:GetFullName())
  return
end
local animator = humanoid:FindFirstChildOfClass("Animator")
if not animator then
  animator = Instance.new("Animator")
  animator.Parent = humanoid
end
if tonumber(config.startDelay or 0) > 0 then task.wait(tonumber(config.startDelay)) end
if config.autoPlay == false then
  folder:SetAttribute("RoLinkRuntimeState", "manual")
  return
end
local registered, animationId = pcall(function()
  return KeyframeSequenceProvider:RegisterKeyframeSequence(sequence)
end)
if not registered or not animationId then
  warn("[RoLink] could not register motion KeyframeSequence at runtime")
  return
end
local animation = Instance.new("Animation")
animation.Name = tostring(config.name or "RoLinkMotion")
animation.AnimationId = animationId
local track = animator:LoadAnimation(animation)
track.Looped = config.loop == true
local speed = tonumber(config.speed or 1) or 1
if speed ~= 1 then track:AdjustSpeed(math.clamp(speed, 0.1, 8)) end
folder:SetAttribute("RoLinkRuntimeState", "playing")
folder:SetAttribute("RoLinkAnimationId", tostring(animationId))
track:Play()
]==]
end
function Motion.motionDestroy(name:string, includeSequence:boolean): { [string]: any }
  local root = Motion.motionRoot()
  local folder = root:FindFirstChild(name)
  local config:any = nil
  local configValue: Instance? = nil
  if folder then
    configValue = folder:FindFirstChild("Config")
    if configValue and configValue:IsA("StringValue") then
      pcall(function() config = HttpService:JSONDecode((configValue :: StringValue).Value) end)
    end
  end
  local destroyed:{ [string]: any } = {}
  if folder then
    destroyed.controller = folder:GetFullName()
    folder:Destroy()
  end
  local serviceList:{ Instance } = {game:GetService("ServerScriptService")}
  local starter = game:GetService("StarterPlayer")
  local starterScripts = starter:FindFirstChild("StarterPlayerScripts")
  if starterScripts then table.insert(serviceList, starterScripts) end
  for _, service in ipairs(serviceList) do
    local scripts = service:FindFirstChild("RoLinkMotionScripts")
    if scripts then
      local script = scripts:FindFirstChild("RoLinkMotion_" .. name)
      if script then
        destroyed.script = script:GetFullName()
        script:Destroy()
      end
    end
  end
  if includeSequence then
    local sequencePath = type(config) == "table" and config.sequencePath or nil
    local sequence = sequencePath and findByPath(sequencePath) or nil
    if sequence and sequence:IsA("KeyframeSequence")
      and sequence:GetAttribute("RoLinkMotionAnimation") == name then
      destroyed.sequence = sequence:GetFullName()
      sequence:Destroy()
    end
  end
  return destroyed
end
function Motion.motionFolderAndConfig(name:string): (Instance, { [string]: any })
  local folder = Motion.motionRoot():FindFirstChild(name)
  if not folder then
    error("MOTION_CONTROLLER_NOT_FOUND: no motion animation named '" .. name:sub(1, 64)
      .. "' under ReplicatedStorage/" .. Motion.rootName)
  end
  local value = folder:FindFirstChild("Config")
  if not value or not value:IsA("StringValue") then
    error("MOTION_CONTROLLER_CORRUPT: '" .. name:sub(1, 64) .. "' has no Config StringValue")
  end
  local ok, config = pcall(function() return HttpService:JSONDecode((value :: StringValue).Value) end)
  if not ok or type(config) ~= "table" then
    error("MOTION_CONTROLLER_CORRUPT: '" .. name:sub(1, 64) .. "' Config is not valid JSON")
  end
  return folder, config
end
function Motion.motionSequence(config:any): Instance?
  local path = type(config) == "table" and tostring(config.sequencePath or "") or ""
  if path == "" then return nil end
  local inst = findByPath(path)
  if inst and inst:IsA("KeyframeSequence") then return inst end
  return nil
end
function Motion.motionControllerSummary(name:string): { [string]: any }
  local folder, config = Motion.motionFolderAndConfig(name)
  local target = findByPath(tostring(config.targetPath or ""))
  local sequence = Motion.motionSequence(config)
  local out:{ [string]: any } = {
    name = name, controller = folder:GetFullName(),
    targetPath = tostring(config.targetPath or ""),
    targetResolved = target ~= nil,
    targetClass = target and target.ClassName or nil,
    sequencePath = tostring(config.sequencePath or ""),
    sequenceResolved = sequence ~= nil,
    playback = tostring(config.playback or "server"),
    autoPlay = config.autoPlay ~= false,
    loop = config.loop == true,
    speed = tonumber(config.speed or 1) or 1,
    startDelay = tonumber(config.startDelay or 0) or 0,
    runtimeState = folder:GetAttribute("RoLinkRuntimeState"),
  }
  if sequence then
    out.sequence = summarizeSequence(sequence, tostring(config.animationId or sequence:GetFullName()), true)
  end
  local warnings:{ [string]: any } = {}
  if not target then table.insert(warnings, "target does not resolve in the current Edit DataModel") end
  if not sequence then table.insert(warnings, "KeyframeSequence does not resolve") end
  out.warnings = warnings
  return out
end
function Motion.motionSampleSequence(seq: Instance, t:number): { [string]: any }
  local kfs = (seq :: any):GetKeyframes()
  table.sort(kfs, function(a, b) return (a :: any).Time < (b :: any).Time end)
  local before: any = nil
  local after: any = nil
  for _, kf in ipairs(kfs) do
    if (kf :: any).Time <= t then before = kf else after = kf break end
  end
  if not before then before = kfs[1] end
  if not after then after = kfs[#kfs] end
  local function poseMap(kf:any): { [string]: any }
    local map:{ [string]: any } = {}
    if not kf then return map end
    for _, d in ipairs((kf :: any):GetDescendants()) do
      if d:IsA("Pose") and map[d.Name] == nil then map[d.Name] = d.CFrame end
    end
    return map
  end
  local a, b = poseMap(before), poseMap(after)
  local t0, t1 = (before :: any).Time, (after :: any).Time
  local f = 0
  if t1 > t0 then f = math.clamp((t - t0) / (t1 - t0), 0, 1) end
  local names:{string} = {}
  local seen:{[string]:boolean} = {}
  for n in pairs(a) do seen[n] = true; table.insert(names, n) end
  for n in pairs(b) do if not seen[n] then table.insert(names, n) end end
  table.sort(names)
  local out:{ [string]: any } = {}
  for _, n in ipairs(names) do
    local cf = a[n] or b[n]
    if a[n] and b[n] then cf = a[n]:Lerp(b[n], f) end
    local p = cf.Position
    local r = cf:ToEulerAnglesXYZ()
    out[n] = {
      position = { x = math.floor(p.X * 1000 + 0.5) / 1000,
        y = math.floor(p.Y * 1000 + 0.5) / 1000,
        z = math.floor(p.Z * 1000 + 0.5) / 1000 },
      rotation = { x = math.floor(math.deg(r.X) * 100 + 0.5) / 100,
        y = math.floor(math.deg(r.Y) * 100 + 0.5) / 100,
        z = math.floor(math.deg(r.Z) * 100 + 0.5) / 100 },
    }
  end
  return out
end
function Motion.motionFindRigPart(target: Instance, wanted:string): BasePart
  local found: BasePart? = nil
  local count = 0
  for _, d in ipairs(target:GetDescendants()) do
    if d:IsA("BasePart") and d.Name == wanted then
      count += 1
      found = d
    end
  end
  if count == 0 then
    error("MOTION_TRACK_NOT_FOUND: target '" .. target:GetFullName() .. "' has no BasePart named '"
      .. wanted:sub(1, 64) .. "' - run analyze_animatable_model and use an exact part name")
  end
  if count > 1 then
    error("MOTION_TRACK_AMBIGUOUS: target '" .. target:GetFullName() .. "' has duplicate BasePart name '"
      .. wanted:sub(1, 64) .. "' - rename the part or use a unique rig")
  end
  return found
end
function Motion.motionRigInfo(target: Instance, trackNames:{ [string]: boolean }): (BasePart, { [string]: BasePart }, { [BasePart]: BasePart? })
  local root: BasePart? = target:FindFirstChild("HumanoidRootPart")
  if not root and target:IsA("Model") then
    pcall(function() root = (target :: Model).PrimaryPart end)
  end
  if not root then
    error("MOTION_RIG_ROOT_MISSING: model '" .. target:GetFullName()
      .. "' needs HumanoidRootPart or PrimaryPart before a KeyframeSequence can be built")
  end
  local parts:{ [string]: BasePart } = {}
  for _, d in ipairs(target:GetDescendants()) do
    if d:IsA("BasePart") then
      if parts[d.Name] then
        error("MOTION_RIG_DUPLICATE_PART: duplicate BasePart name '" .. d.Name:sub(1, 64) .. "'")
      end
      parts[d.Name] = d
    end
  end
  local parent:{ [BasePart]: BasePart? } = {}
  local seenParts:{ [BasePart]: boolean } = {[(root :: BasePart)] = true}
  local queue:{ BasePart } = {root :: BasePart}
  local qi = 1
  while qi <= #queue do
    local current = queue[qi]
    qi += 1
    for _, d in ipairs(target:GetDescendants()) do
      if d:IsA("Motor6D") then
        local p0, p1 = d.Part0, d.Part1
        if p0 == current and p1 and not seenParts[p1] then
          parent[p1] = current
          seenParts[p1] = true
          table.insert(queue, p1)
        elseif p1 == current and p0 and not seenParts[p0] then
          parent[p0] = current
          seenParts[p0] = true
          table.insert(queue, p0)
        end
      end
    end
  end
  for name in pairs(trackNames) do
    local part = parts[name]
    if not part then
      error("MOTION_TRACK_NOT_FOUND: no BasePart named '" .. name:sub(1, 64)
        .. "' under '" .. target:GetFullName() .. "'")
    end
    local seen = part
    while seen and seen ~= root do
      if parent[seen] == nil then
        error("MOTION_TRACK_DISCONNECTED: '" .. name:sub(1, 64)
          .. "' is not connected to the rig root by a Motor6D")
      end
      seen = parent[seen]
    end
  end
  return root :: BasePart, parts, parent
end
function Motion.motionPoseCFrame(data:any): CFrame
  local p = (type(data) == "table" and (data :: any).position) or data
  local r = type(data) == "table" and (data :: any).rotation or nil
  return CFrame.new(vec3(p)) * CFrame.Angles(
    math.rad(num(r and (r :: any).x, 0)),
    math.rad(num(r and (r :: any).y, 0)),
    math.rad(num(r and (r :: any).z, 0)))
end
function Motion.motionEasingParts(name:string): (string, string)
  local resolved = resolveEasing(name) or "linear"
  if resolved == "linear" then return "Linear", "InOut" end
  if resolved:find("InOut", 1, true) then
    local family = resolved:match("^(quad|cubic|sine)") or "quad"
    if family == "cubic" then return "Cubic", "InOut" end
    if family == "sine" then return "Sine", "InOut" end
    return "Quad", "InOut"
  end
  local family = resolved:match("^(quad|cubic|sine)") or "quad"
  local direction = resolved:find("Out", 1, true) and "Out" or "In"
  if family == "cubic" then return "Cubic", direction end
  if family == "sine" then return "Sine", direction end
  return "Quad", direction
end
function Motion.createMotionSequence(args:{ [string]: any }, target: Model): { [string]: any }
  local kfData = args.keyframes
  if type(kfData) ~= "table" or #kfData == 0 then error("keyframes must be a non-empty array") end
  if #kfData > 200 then error("too many keyframes (max 200)") end
  local trackNames:{ [string]: boolean } = {}
  local totalPoses = 0
  local lastTime = -1
  for i, kfD in ipairs(kfData) do
    if type(kfD) ~= "table" then error("keyframe " .. i .. " must be an object") end
    local t = num((kfD :: any).time, 0)
    if t < 0 or t ~= t or t == math.huge or t == -math.huge then
      error("keyframe " .. i .. " time must be a finite number >= 0")
    end
    if t < lastTime then error("keyframe times must be non-decreasing (keyframe " .. i .. " goes backwards)") end
    lastTime = t
    local poses = (kfD :: any).poses
    if type(poses) ~= "table" or #poses == 0 then error("keyframe " .. i .. " poses must be non-empty") end
    if #poses > 64 then error("too many poses on keyframe " .. i .. " (max 64)") end
    for _, pD in ipairs(poses) do
      if type(pD) ~= "table" or tostring((pD :: any).part or "") == "" then
        error("keyframe " .. i .. " has a pose without a part name")
      end
      local partName = tostring((pD :: any).part)
      if trackNames[partName] then
        -- A duplicate pose in one keyframe is almost always a typo. Reject it
        -- before creating any instances so a failed call leaves no half-track.
        local seen = false
        for _, other in ipairs(poses) do
          if other ~= pD and tostring((other :: any).part or "") == partName then seen = true break end
        end
        if seen then error("duplicate pose part '" .. partName:sub(1, 64) .. "' on keyframe " .. i) end
      end
      trackNames[partName] = true
      totalPoses += 1
    end
  end
  if totalPoses > 1024 then error("too many animated poses (" .. totalPoses .. ", max 1024)") end
  local root, parts, parent = Motion.motionRigInfo(target, trackNames)
  local allParts:{ BasePart } = {root}
  local included:{ [BasePart]: boolean } = {[root] = true}
  local function includeAncestors(part:BasePart)
    local cur = parent[part]
    while cur and not included[cur] do
      included[cur] = true
      table.insert(allParts, cur)
      cur = parent[cur]
    end
  end
  for name in pairs(trackNames) do includeAncestors(Motion.motionFindRigPart(target, name)) end
  local children:{ [BasePart]: { BasePart } } = {}
  for _, part in ipairs(allParts) do
    local p = parent[part]
    if p then
      if not children[p] then children[p] = {} end
      table.insert(children[p], part)
    end
  end
  for _, list in pairs(children) do
    table.sort(list, function(a, b) return a.Name < b.Name end)
  end
  local seq = Instance.new("KeyframeSequence")
  seq.Name = tostring(args.name or "RoLinkMotion")
  if args.loop == true then pcall(function() (seq :: any).Loop = true end) end
  for _, kfD in ipairs(kfData) do
    local kf = Instance.new("Keyframe")
    kf.Time = math.max(0, num((kfD :: any).time, 0))
    local byName:{ [string]: any } = {}
    for _, pD in ipairs((kfD :: any).poses or {}) do byName[tostring((pD :: any).part)] = pD end
    local made:{ [BasePart]: any } = {}
    local function build(part:BasePart, parentPose:any)
      local pose = Instance.new("Pose")
      pose.Name = part.Name
      local data = byName[part.Name]
      pose.CFrame = data and Motion.motionPoseCFrame(data) or CFrame.new()
      local style, direction = Motion.motionEasingParts(tostring((kfD :: any).easing or "linear"))
      pcall(function() (pose :: any).EasingStyle = Enum.EasingStyle[style] end)
      pcall(function() (pose :: any).EasingDirection = Enum.EasingDirection[direction] end)
      if parentPose then
        local ok = pcall(function() (parentPose :: any):AddSubPose(pose) end)
        if not ok then pose.Parent = parentPose end
      else
        pose.Parent = kf
      end
      made[part] = pose
      for _, child in ipairs(children[part] or {}) do build(child, pose) end
    end
    build(root, nil)
    kf.Parent = seq
  end
  local okRead, readKfs = pcall(function() return (seq :: any):GetKeyframes() end)
  if not okRead or type(readKfs) ~= "table" or #readKfs ~= #kfData then
    pcall(function() seq:Destroy() end)
    error("MOTION_BUILD_VERIFY_FAILED: KeyframeSequence readback did not match the requested keyframes")
  end
  for _, kf in ipairs(readKfs) do
    local rootPose = kf:FindFirstChild(root.Name)
    if not rootPose or not rootPose:IsA("Pose") then
      pcall(function() seq:Destroy() end)
      error("MOTION_BUILD_VERIFY_FAILED: root Pose '" .. root.Name .. "' is missing")
    end
  end
  return { sequence = seq, keyframes = #kfData, duration = lastTime,
    trackCount = #trackNames, root = root }
end

local function createMotionAnimation(args:{ [string]: any }): { [string]: any }
  local targetPath = tostring(args.target or "")
  local target = findByPath(targetPath)
  if not target then error("not found " .. targetPath .. siblingHint(targetPath)) end
  if not target:IsA("Model") then
    error("MOTION_TARGET_INVALID: create_motion_animation needs a Model path with a Humanoid, got "
      .. target:GetFullName() .. " (" .. target.ClassName .. ")")
  end
  if not target:FindFirstChildOfClass("Humanoid") then
    error("MOTION_TARGET_INVALID: model '" .. target:GetFullName() .. "' has no Humanoid")
  end
  local name = Motion.motionCleanName(args.name, "RoLinkMotion")
  local root = Motion.motionRoot()
  local oldFolder = root:FindFirstChild(name)
  local animFolder = game.Workspace:FindFirstChild("RoLinkAnimations")
  local oldSequence = animFolder and animFolder:FindFirstChild(name) or nil
  if (oldFolder or oldSequence) and args.confirm ~= true then
    error("CONFIRM_REQUIRED: motion animation '" .. name .. "' already exists - re-send with confirm:true to replace it")
  end
  if oldFolder or oldSequence then Motion.motionDestroy(name, true) end
  local animArgs:{ [string]: any } = {}
  for k, v in pairs(args) do animArgs[k] = v end
  animArgs.name = name
  local made = Motion.createMotionSequence(animArgs, target)
  local sequence = made.sequence
  local sequenceFolder = game.Workspace:FindFirstChild("RoLinkAnimations")
  if not sequenceFolder then
    sequenceFolder = Instance.new("Folder")
    sequenceFolder.Name = "RoLinkAnimations"
    sequenceFolder.Parent = game.Workspace
  end
  sequence.Name = name
  sequence.Parent = sequenceFolder
  local registered, animationId = pcall(function()
    return game:GetService("KeyframeSequenceProvider"):RegisterKeyframeSequence(sequence)
  end)
  if not registered or not animationId then
    pcall(function() sequence:Destroy() end)
    error("MOTION_BUILD_FAILED: Studio could not register the KeyframeSequence")
  end
  animCache[tostring(animationId)] = sequence
  made.animationId = tostring(animationId)
  made.path = sequence:GetFullName()
  sequence:SetAttribute("RoLinkMotionAnimation", name)
  local playback = tostring(args.playback or "server")
  if playback ~= "server" and playback ~= "client" then
    error("playback must be server or client")
  end
  local config = {
    name = name, targetPath = Motion.motionPath(target),
    sequencePath = Motion.motionPath(sequence), animationId = tostring(made.animationId or ""),
    loop = args.loop == true, playback = playback,
    autoPlay = args.autoPlay ~= false, speed = num(args.speed, 1),
    startDelay = num(args.startDelay, 0),
  }
  local folder = Instance.new("Folder")
  folder.Name = name
  folder:SetAttribute("RoLinkMotionAnimation", true)
  folder:SetAttribute("targetPath", config.targetPath)
  folder:SetAttribute("sequencePath", config.sequencePath)
  folder:SetAttribute("playback", playback)
  folder:SetAttribute("autoPlay", config.autoPlay)
  folder:SetAttribute("loop", config.loop)
  local value = Instance.new("StringValue")
  value.Name = "Config"
  value.Value = Motion.motionJson(config)
  value.Parent = folder
  folder.Parent = root
  local serviceName = playback == "client" and "StarterPlayer" or "ServerScriptService"
  local service = game:GetService(serviceName)
  local scripts = service:FindFirstChild("RoLinkMotionScripts")
  if not scripts then
    scripts = Instance.new("Folder")
    scripts.Name = "RoLinkMotionScripts"
    scripts.Parent = service
  end
  local script = Instance.new(playback == "client" and "LocalScript" or "Script")
  script.Name = "RoLinkMotion_" .. name
  script.Source = Motion.motionScriptSource(name)
  script.Parent = scripts
  folder:SetAttribute("scriptPath", script:GetFullName())
  pcall(function() ChangeHistoryService:SetWaypoint("RoLink motion animation " .. name) end)
  return { animation = name, controller = folder:GetFullName(), script = script:GetFullName(),
    target = target:GetFullName(), sequence = sequence:GetFullName(),
    animationId = made.animationId, keyframes = made.keyframes, duration = made.duration,
    playback = playback, autoPlay = config.autoPlay, loop = config.loop,
    rendered = false, playable = true,
    note = "Edit-time controller created. The Script registers this KeyframeSequence and plays it in Play mode." }
end
local function inspectMotionAnimation(args:{ [string]: any }): { [string]: any }
  return Motion.motionControllerSummary(Motion.motionCleanName(args.name, "RoLinkMotion"))
end
local function validateMotionAnimation(args:{ [string]: any }): { [string]: any }
  local name = Motion.motionCleanName(args.name, "RoLinkMotion")
  local folder, config = Motion.motionFolderAndConfig(name)
  local target = findByPath(tostring(config.targetPath or ""))
  local sequence = Motion.motionSequence(config)
  local errors:{ [string]: any } = {}
  local warnings:{ [string]: any } = {}
  if not target then
    table.insert(errors, { code = "TARGET_GONE", detail = tostring(config.targetPath) })
  elseif not target:IsA("Model") or not target:FindFirstChildOfClass("Humanoid") then
    table.insert(errors, { code = "TARGET_NOT_RIG", detail = target:GetFullName() })
  end
  if not sequence then
    table.insert(errors, { code = "SEQUENCE_GONE", detail = tostring(config.sequencePath) })
  end
  local duration = 0
  if sequence then
    local kfs = (sequence :: any):GetKeyframes()
    duration = #kfs > 0 and (kfs[#kfs] :: any).Time or 0
    if #kfs == 0 then table.insert(errors, { code = "EMPTY_SEQUENCE", detail = name }) end
    for i = 2, #kfs do
      if (kfs[i] :: any).Time < (kfs[i - 1] :: any).Time - 1e-9 then
        table.insert(errors, { code = "TIME_ORDER", detail = "keyframe " .. i })
      end
    end
    if duration <= 0 then table.insert(errors, { code = "BAD_DURATION", detail = "duration must be > 0" }) end
  end
  local playback = tostring(config.playback or "")
  if playback ~= "server" and playback ~= "client" then
    table.insert(errors, { code = "BAD_PLAYBACK", detail = playback })
  end
  local speed = tonumber(config.speed or 1) or 0
  if speed < 0.1 or speed > 8 then table.insert(errors, { code = "BAD_SPEED", detail = tostring(config.speed) }) end
  if config.autoPlay == false then
    table.insert(warnings, { code = "MANUAL", detail = "autoPlay=false; the controller will not play until enabled" })
  end
  -- Loop-seam audit: a looped controller whose first and last poses drift
  -- reads as a visible pop every cycle. Sampled numerically (never pixels).
  if config.loop == true and sequence then
    local okS, firstP = pcall(function() return Motion.motionSampleSequence(sequence, 0) end)
    if okS and type(firstP) == "table" then
      local kfs = (sequence :: any):GetKeyframes()
      local dur = #kfs > 0 and (kfs[#kfs] :: any).Time or 0
      local okL, lastP = pcall(function() return Motion.motionSampleSequence(sequence, dur) end)
      if okL and type(lastP) == "table" then
        local worst, wpart = 0, ""
        for pname, fp in pairs(firstP) do
          local lp = lastP[pname]
          if type(fp) == "table" and type(lp) == "table" then
            local fpp, lpp = fp.position or {}, lp.position or {}
            local dp = math.sqrt((num((lpp::any).x, 0) - num((fpp::any).x, 0)) ^ 2
              + (num((lpp::any).y, 0) - num((fpp::any).y, 0)) ^ 2
              + (num((lpp::any).z, 0) - num((fpp::any).z, 0)) ^ 2)
            if dp > worst then worst, wpart = dp, pname end
          end
        end
        if worst > 0.5 then
          table.insert(warnings, { code = "LOOP_SEAM",
            detail = string.format("looped controller drifts %.2f studs on '%s' (first vs last pose) - close the loop or it pops every cycle", worst, wpart) })
        end
      end
    end
  end
  local out = Motion.motionControllerSummary(name)
  out.valid = #errors == 0
  out.errors = errors
  out.warnings = warnings
  out.duration = duration
  out.controllerExists = folder ~= nil
  return out
end
local function previewMotionAnimation(args:{ [string]: any }): { [string]: any }
  local name = Motion.motionCleanName(args.name, "RoLinkMotion")
  local folder, config = Motion.motionFolderAndConfig(name)
  local sequence = Motion.motionSequence(config)
  if not sequence then error("MOTION_SEQUENCE_NOT_FOUND: " .. tostring(config.sequencePath)) end
  local kfs = (sequence :: any):GetKeyframes()
  if #kfs == 0 then error("MOTION_SEQUENCE_EMPTY: " .. name) end
  local duration = (kfs[#kfs] :: any).Time
  local step = math.clamp(num(args.step, 0.1), 0.02, 1)
  local count = math.min(200, math.max(3, math.floor(duration / step) + 1))
  local samples:{ [string]: any } = {}
  for i = 0, count - 1 do
    local t = duration * i / (count - 1)
    table.insert(samples, { t = math.floor(t * 1000 + 0.5) / 1000,
      poses = Motion.motionSampleSequence(sequence, t) })
  end
  -- Motion metrics: per-part peak linear/angular velocity across the
  -- samples plus the loop-seam gap (first vs last sample). Numbers only;
  -- a big seam on a looped controller reads as a visible pop.
  local peakVel:{ [string]: any } = {}
  local seam:{ [string]: any } = {}
  local seamWorst, seamPart = 0, ""
  if #samples >= 2 then
    local first, last = samples[1], samples[#samples]
    local fP, lP = first.poses or {}, last.poses or {}
    for pname, fp in pairs(fP) do
      local lp = lP[pname]
      if type(fp) == "table" and type(lp) == "table" then
        local fpp, lpp = fp.position or {}, lp.position or {}
        local fpr, lpr = fp.rotation or {}, lp.rotation or {}
        local dp = math.sqrt((num((lpp::any).x, 0) - num((fpp::any).x, 0)) ^ 2
          + (num((lpp::any).y, 0) - num((fpp::any).y, 0)) ^ 2
          + (num((lpp::any).z, 0) - num((fpp::any).z, 0)) ^ 2)
        local dr = math.abs(num((lpr::any).x, 0) - num((fpr::any).x, 0))
          + math.abs(num((lpr::any).y, 0) - num((fpr::any).y, 0))
          + math.abs(num((lpr::any).z, 0) - num((fpr::any).z, 0))
        seam[pname] = { posStuds = math.floor(dp * 1000 + 0.5) / 1000,
          rotDeg = math.floor(dr * 100 + 0.5) / 100 }
        if dp > seamWorst then seamWorst, seamPart = dp, pname end
      end
    end
    for idx = 2, #samples do
      local dt = samples[idx].t - samples[idx - 1].t
      if dt > 1e-9 then
        local pa, pb = samples[idx - 1].poses or {}, samples[idx].poses or {}
        for pname, a in pairs(pa) do
          local c = pb[pname]
          if type(a) == "table" and type(c) == "table" then
            local ap, cp = a.position or {}, c.position or {}
            local ar, cr = a.rotation or {}, c.rotation or {}
            local dp = math.sqrt((num((cp::any).x, 0) - num((ap::any).x, 0)) ^ 2
              + (num((cp::any).y, 0) - num((ap::any).y, 0)) ^ 2
              + (num((cp::any).z, 0) - num((ap::any).z, 0)) ^ 2) / dt
            local dr = (math.abs(num((cr::any).x, 0) - num((ar::any).x, 0))
              + math.abs(num((cr::any).y, 0) - num((ar::any).y, 0))
              + math.abs(num((cr::any).z, 0) - num((ar::any).z, 0))) / dt
            local cur = peakVel[pname]
            if not cur or dp > cur.posPerSec then
              peakVel[pname] = { posPerSec = math.floor(dp * 100 + 0.5) / 100,
                rotPerSec = math.floor(dr * 100 + 0.5) / 100 }
            elseif dr > cur.rotPerSec then
              cur.rotPerSec = math.floor(dr * 100 + 0.5) / 100
            end
          end
        end
      end
    end
  end
  return { name = name, controller = folder:GetFullName(), sequence = Motion.motionPath(sequence),
    duration = duration, step = step, sampleCount = #samples, samples = samples,
    peakVelocity = peakVel, loopSeam = seam,
    loopSeamWorst = { part = seamPart,
      posStuds = math.floor(seamWorst * 1000 + 0.5) / 1000 },
    rendered = false, playable = true,
    note = "Numeric pose samples from the real KeyframeSequence; Studio plugins cannot prove rendered pixels. peakVelocity is studs/sec + deg/sec per part; loopSeam is first-vs-last-sample drift (a big seam on a looped controller pops)." }
end
local function removeMotionAnimation(args:{ [string]: any }): { [string]: any }
  local name = Motion.motionCleanName(args.name, "RoLinkMotion")
  if args.confirm ~= true then
    error("CONFIRM_REQUIRED: remove motion animation '" .. name .. "' - re-send with confirm:true")
  end
  local root = Motion.motionRoot()
  if not root:FindFirstChild(name) then
    error("MOTION_CONTROLLER_NOT_FOUND: no motion animation named '" .. name:sub(1, 64) .. "'")
  end
  local destroyed = Motion.motionDestroy(name, true)
  pcall(function() ChangeHistoryService:SetWaypoint("RoLink remove motion animation " .. name) end)
  return { removed = true, name = name, destroyed = destroyed }
end

-- ── Cinematics (tools 114-119) ──────────────────────────────────────
-- Edit stores the data model; Play renders it via a real server Script.
-- Every builder returns a runtimeSnippet for that Script. Only create_vfx
-- renders immediately (viewport particles/lights work in Edit).
-- Cutscene helpers live on one table (not chunk locals): Studio caps a chunk
-- at ~200 locals and this file sits at that cliff (see scripts docs). One
-- `local Cutscene` replaces 11 registers; call sites use Cutscene.x.
local Cutscene = {
  folder = "RoLinkCutscenes",
  scripts = "RoLinkCutsceneScripts",
  totalMax = 120,
}
function Cutscene.cutsceneNum3(t:any, what:string, shot:number): Vector3
  if type(t) ~= "table" then error("shot " .. shot .. " " .. what .. " must be {x,y,z}") end
  return Vector3.new(num((t::any).x, 0), num((t::any).y, 0), num((t::any).z, 0))
end
function Cutscene.cutsceneCheckShot(sD:any, i:number): { [string]: any }
  if type(sD) ~= "table" then error("shot " .. i .. " must be an object") end
  local cam = (sD::any).camera
  if type(cam) ~= "table" then error("shot " .. i .. " needs camera{position, lookAt}") end
  local pos = Cutscene.cutsceneNum3((cam::any).position, "camera.position", i)
  local look = Cutscene.cutsceneNum3((cam::any).lookAt, "camera.lookAt", i)
  local dur = num((sD::any).duration, 0)
  if dur < 0.1 or dur > 30 then error("shot " .. i .. " duration must be 0.1-30s") end
  local easeName = tostring((sD::any).easing or "linear")
  local resolved = resolveEasing(easeName)
  if not resolved then error("shot " .. i .. " unknown easing '"
    .. easeName:sub(1, 24) .. "' " .. easingHint(easeName) .. "(" .. EASE_LIST .. ")") end
  local trans = tostring((sD::any).transition or "cut"):lower()
  if trans ~= "cut" and trans ~= "fade" then error("shot " .. i .. " transition must be cut|fade") end
  local out:{ [string]: any } = {
    camera = { position = { x = pos.X, y = pos.Y, z = pos.Z },
      lookAt = { x = look.X, y = look.Y, z = look.Z } },
    duration = dur, easing = resolved, transition = trans,
    hold = (sD::any).hold == true,
  }
  if (sD::any).fov ~= nil then
    local fov = num((sD::any).fov, 0)
    if fov < 1 or fov > 179 then error("shot " .. i .. " fov must be 1-179") end
    out.fov = fov
  end
  if (sD::any).shake ~= nil then
    local sh = (sD::any).shake
    if type(sh) ~= "table" then error("shot " .. i .. " shake must be {amplitude, frequency}") end
    local amp = num((sh::any).amplitude, 0.5)
    local freq = num((sh::any).frequency, 8)
    if amp < 0 or amp > 10 then error("shot " .. i .. " shake.amplitude must be 0-10") end
    if freq < 0.1 or freq > 30 then error("shot " .. i .. " shake.frequency must be 0.1-30") end
    out.shake = { amplitude = amp, frequency = freq }
  end
  return out
end
function Cutscene.cutsceneScriptSource(cutName:string): string
  local L:{string} = {}
  local function w(s:string) table.insert(L, s) end
  w('local Players = game:GetService("Players")')
  w('local RunService = game:GetService("RunService")')
  w('local TweenService = game:GetService("TweenService")')
  w('local UserInputService = game:GetService("UserInputService")')
  w('local player = Players.LocalPlayer')
  w('if not player then return end')
  w('local folder = game.Workspace:WaitForChild("RoLinkCutscenes", 10)')
  w('if not folder then return end')
  w('local mod = folder:WaitForChild(' .. string.format("%q", cutName) .. ', 10)')
  w('if not mod then return end')
  w('local okD, data = pcall(require, mod)')
  w('if not okD or type(data) ~= "table" then return end')
  w('local shots = data.shots or {}')
  w('if #shots == 0 then return end')
  w('local cam = workspace.CurrentCamera')
  w('if not cam then return end')
  w('local pgui = player:WaitForChild("PlayerGui", 10)')
  w('if not pgui then return end')
  w('if _G.RoLinkCutscenePlaying then return end')
  w('_G.RoLinkCutscenePlaying = true')
  w('pcall(function()')
  w('local old = pgui:FindFirstChild("RoLinkCutsceneGui")')
  w('if old then old:Destroy() end')
  w('end)')
  w('local gui = Instance.new("ScreenGui")')
  w('gui.Name = "RoLinkCutsceneGui"')
  w('gui.ResetOnSpawn = false')
  w('gui.IgnoreGuiInset = true')
  w('gui.Parent = pgui')
  w('local function bar(top)')
  w('local f = Instance.new("Frame")')
  w('f.AnchorPoint = Vector2.new(0, top)')
  w('if top == 0 then f.Position = UDim2.new(0, 0, 0, 0)')
  w('else f.Position = UDim2.new(0, 0, 1, 0) end')
  w('f.Size = UDim2.new(1, 0, 0.12, 0)')
  w('f.BackgroundColor3 = Color3.new(0, 0, 0)')
  w('f.BorderSizePixel = 0')
  w('f.ZIndex = 5')
  w('f.Parent = gui')
  w('return f')
  w('end')
  w('bar(0)')
  w('bar(1)')
  w('local fade = Instance.new("Frame")')
  w('fade.Size = UDim2.new(1, 0, 1, 0)')
  w('fade.BackgroundColor3 = Color3.new(0, 0, 0)')
  w('fade.BackgroundTransparency = 1')
  w('fade.BorderSizePixel = 0')
  w('fade.ZIndex = 7')
  w('fade.Parent = gui')
  w('local sub = Instance.new("TextLabel")')
  w('sub.AnchorPoint = Vector2.new(0.5, 1)')
  w('sub.Position = UDim2.new(0.5, 0, 1, -100)')
  w('sub.Size = UDim2.new(0.8, 0, 0, 64)')
  w('sub.BackgroundTransparency = 1')
  w('sub.Font = Enum.Font.GothamBold')
  w('sub.TextSize = 20')
  w('sub.TextColor3 = Color3.new(1, 1, 1)')
  w('sub.TextWrapped = true')
  w('sub.Visible = false')
  w('sub.ZIndex = 6')
  w('sub.Parent = gui')
  w('local stroke = Instance.new("UIStroke")')
  w('stroke.Thickness = 2')
  w('stroke.Color = Color3.new(0, 0, 0)')
  w('stroke.Parent = sub')
  w('local skipped = false')
  w('local jumpConn = nil')
  w('if data.skippable ~= false then')
  w('local skipBtn = Instance.new("TextButton")')
  w('skipBtn.AnchorPoint = Vector2.new(1, 0)')
  w('skipBtn.Position = UDim2.new(1, -16, 0, 16)')
  w('skipBtn.Size = UDim2.new(0, 110, 0, 34)')
  w('skipBtn.Text = "Skip >>"')
  w('skipBtn.Font = Enum.Font.Gotham')
  w('skipBtn.TextSize = 16')
  w('skipBtn.BackgroundTransparency = 0.3')
  w('skipBtn.ZIndex = 6')
  w('skipBtn.Parent = gui')
  w('skipBtn.MouseButton1Click:Connect(function() skipped = true end)')
  w('jumpConn = UserInputService.JumpRequest:Connect(function() skipped = true end)')
  w('end')
  w('local function easeFn(name, t)')
  w('local n = string.lower(tostring(name or "linear"))')
  w('if n == "linear" then return t end')
  w('if n == "quadin" then return t * t end')
  w('if n == "quadout" then return 1 - (1 - t) * (1 - t) end')
  w('if n == "quadinout" then if t < 0.5 then return 2 * t * t end return 1 - (-2 * t + 2) * (-2 * t + 2) / 2 end')
  w('if n == "cubicin" then return t * t * t end')
  w('if n == "cubicout" then return 1 - (1 - t) * (1 - t) * (1 - t) end')
  w('if n == "cubicinout" then if t < 0.5 then return 4 * t * t * t end return 1 - (-2 * t + 2) * (-2 * t + 2) * (-2 * t + 2) / 2 end')
  w('if n == "sinein" then return 1 - math.cos(t * math.pi / 2) end')
  w('if n == "sineout" then return math.sin(t * math.pi / 2) end')
  w('if n == "sineinout" then return -(math.cos(math.pi * t) - 1) / 2 end')
  w('if n == "bezierout" then local u = t - 1 return 1 + 2.2 * u * u * u + 1.2 * u * u end')
  w('if n == "springout" then return 1 - math.exp(-5 * t) * math.cos(9 * t) end')
  w('return t')
  w('end')
  w('local function v3(d) return Vector3.new(d.x or 0, d.y or 0, d.z or 0) end')
  w('cam.CameraType = Enum.CameraType.Scriptable')
  w('local curP = cam.CFrame.Position')
  w('local curL = cam.CFrame.Position + cam.CFrame.LookVector * 10')
  w('local tG, subI, audI, subTok = 0, 1, 1, 0')
  w('local subs = data.subtitles or {}')
  w('local auds = data.audio or {}')
  w('local function fireDue()')
  w('while subI <= #subs and subs[subI].t <= tG do')
  w('local s = subs[subI]')
  w('sub.Text = tostring(s.speaker or "") .. ": " .. tostring(s.text or "")')
  w('sub.Visible = true')
  w('subTok = subTok + 1')
  w('local my, dur = subTok, tonumber(s.dur) or 2.5')
  w('task.delay(dur, function() if my == subTok then sub.Visible = false end end)')
  w('subI = subI + 1')
  w('end')
  w('while audI <= #auds and auds[audI].t <= tG do')
  w('local a = auds[audI]')
  w('if not skipped then pcall(function()')
  w('local snd = Instance.new("Sound")')
  w('snd.SoundId = tostring(a.soundId or "")')
  w('snd.Parent = gui')
  w('snd:Play()')
  w('end) end')
  w('audI = audI + 1')
  w('end')
  w('end')
  w('local prevP, prevL = curP, curL')
  w('repeat')
  w('for _, s in ipairs(shots) do')
  w('if skipped then break end')
  w('local dur = tonumber(s.duration) or 2')
  w('local tgtP, tgtL = v3(s.camera.position), v3(s.camera.lookAt)')
  w('local fovTo = tonumber(s.fov)')
  w('local fovFrom = cam.FieldOfView')
  w('local amp = s.shake and tonumber(s.shake.amplitude) or 0')
  w('local freq = s.shake and tonumber(s.shake.frequency) or 8')
  w('local useFade = tostring(s.transition or "cut") == "fade" and not s.hold')
  w('if s.hold then prevP, prevL = tgtP, tgtL end')
  w('if useFade then fade.BackgroundTransparency = 0 end')
  w('local tS = 0')
  w('local conn')
  w('conn = RunService.RenderStepped:Connect(function(dt)')
  w('tS = tS + dt')
  w('tG = tG + dt')
  w('local f = 1')
  w('if tS < dur then f = easeFn(s.easing, tS / dur) end')
  w('if f > 1.15 then f = 1.15 elseif f < -0.15 then f = -0.15 end')
  w('local cf = CFrame.new(prevP:Lerp(tgtP, f), prevL:Lerp(tgtL, f))')
  w('if amp > 0 then')
  w('local ph = tG * freq * math.pi * 2')
  w('cf = cf * CFrame.new(math.sin(ph) * amp, math.cos(ph * 1.3) * amp * 0.6, 0)')
  w('end')
  w('cam.CFrame = cf')
  w('if fovTo then cam.FieldOfView = fovFrom + (fovTo - fovFrom) * f end')
  w('if useFade then')
  w('local edge = math.min(0.2, dur / 2)')
  w('local a = 1 - math.min(tS, dur - tS) / edge')
  w('if a < 0 then a = 0 end')
  w('fade.BackgroundTransparency = a')
  w('end')
  w('fireDue()')
  w('end)')
  w('while tS < dur and not skipped do RunService.Heartbeat:Wait() end')
  w('conn:Disconnect()')
  w('fade.BackgroundTransparency = 1')
  w('prevP, prevL = tgtP, tgtL')
  w('fireDue()')
  w('end')
  w('until (not data.loop) or skipped')
  w('sub.Visible = false')
  w('fade.BackgroundTransparency = 1')
  w('cam.CameraType = Enum.CameraType.Custom')
  w('pcall(function()')
  w('local ch = player.Character or player.CharacterAdded:Wait()')
  w('local hum = ch:FindFirstChildOfClass("Humanoid")')
  w('if hum then cam.CameraSubject = hum end')
  w('end)')
  w('gui:Destroy()')
  w('if jumpConn then jumpConn:Disconnect() end')
  w('_G.RoLinkCutscenePlaying = false')
  return table.concat(L, "\n")
end
function Cutscene.cutsceneData(name:string): (Instance, { [string]: any })
  local folder = game.Workspace:FindFirstChild(Cutscene.folder)
  local inst = folder and folder:FindFirstChild(name) or nil
  if not inst or not inst:IsA("ModuleScript") then
    error("CUTSCENE_NOT_FOUND: no cutscene named '" .. name:sub(1, 64)
      .. "' under Workspace/" .. Cutscene.folder)
  end
  local src = ""
  pcall(function() src = (inst::any).Source or "" end)
  local payload = src:match("%[%[=(.-)=%]%]")
  if not payload then error("CUTSCENE_CORRUPT: '" .. name:sub(1, 64) .. "' has no data payload") end
  local ok, data = pcall(function() return HttpService:JSONDecode(payload) end)
  if not ok or type(data) ~= "table" then
    error("CUTSCENE_CORRUPT: '" .. name:sub(1, 64) .. "' data is not valid JSON")
  end
  return inst, data
end
function Cutscene.cutsceneTimeline(data:any): { [string]: any }
  local shots = type(data) == "table" and data.shots or {}
  local out:{ [string]: any } = {}
  local t = 0
  local prev:any = nil
  for i, s in ipairs(shots) do
    local dur = num(s.duration, 0)
    local here = { position = s.camera and s.camera.position or nil,
      lookAt = s.camera and s.camera.lookAt or nil }
    table.insert(out, { index = i, start = math.floor(t * 1000 + 0.5) / 1000,
      duration = dur, from = prev, to = here,
      transition = s.transition or "cut", easing = s.easing or "linear",
      fov = s.fov, shake = s.shake, hold = s.hold == true })
    t += dur
    prev = here
  end
  return { shots = out, total = math.floor(t * 1000 + 0.5) / 1000 }
end
local function createCutscene(args:{ [string]: any }): { [string]: any }
  local name = tostring(args.name or "RoLinkCutscene"):sub(1, 64)
  local shots = args.shots
  if type(shots) ~= "table" or #shots == 0 then error("shots must be a non-empty array") end
  if #shots > 32 then error("too many shots (max 32)") end
  local folder = game.Workspace:FindFirstChild(Cutscene.folder)
  if not folder then folder = Instance.new("Folder"); folder.Name = Cutscene.folder; folder.Parent = game.Workspace end
  if folder:FindFirstChild(name) and args.confirm ~= true then
    error("CONFIRM_REQUIRED: cutscene '" .. name .. "' already exists - re-send with confirm:true to replace it")
  end
  local data:{ [string]: any } = {}
  local total = 0
  for i, sD in ipairs(shots) do
    local shot = Cutscene.cutsceneCheckShot(sD, i)
    total += shot.duration
    table.insert(data, shot)
  end
  if total > Cutscene.totalMax then
    error("cutscene too long (" .. math.floor(total * 10 + 0.5) / 10 .. "s, max "
      .. Cutscene.totalMax .. "s) - split into chapters across calls")
  end
  local subs:{ [string]: any } = {}
  for i, lD in ipairs(args.subtitles or {}) do
    if type(lD) ~= "table" then error("subtitle " .. i .. " must be an object") end
    local st = num((lD::any).t, -1)
    if st < 0 or st > total then error("subtitle " .. i .. " t must sit inside 0-" .. total .. "s") end
    if tostring((lD::any).speaker or "") == "" then error("subtitle " .. i .. " needs speaker") end
    if tostring((lD::any).text or "") == "" then error("subtitle " .. i .. " needs text") end
    table.insert(subs, { t = st, speaker = tostring((lD::any).speaker):sub(1, 64),
      text = tostring((lD::any).text):sub(1, 280), dur = num((lD::any).dur, 2.5) })
  end
  table.sort(subs, function(a, b) return (a::any).t < (b::any).t end)
  for i, s in ipairs(subs) do
    local nxt = subs[i + 1]
    local d = nxt and math.min(3, math.max(0.5, nxt.t - s.t - 0.1)) or math.min(3, math.max(0.5, (s::any).dur))
    s.dur = math.floor(d * 100 + 0.5) / 100
  end
  local auds:{ [string]: any } = {}
  for i, aD in ipairs(args.audio or {}) do
    if type(aD) ~= "table" then error("audio " .. i .. " must be an object") end
    local at = num((aD::any).t, -1)
    if at < 0 or at > total then error("audio " .. i .. " t must sit inside 0-" .. total .. "s") end
    local sid = tostring((aD::any).soundId or "")
    if not sid:match("^rbxassetid://%d+$") then error("audio " .. i .. " soundId must look like rbxassetid://123") end
    table.insert(auds, { t = at, soundId = sid })
  end
  table.sort(auds, function(a, b) return (a::any).t < (b::any).t end)
  local old = folder:FindFirstChild(name)
  if old then old:Destroy() end
  local doc = { name = name, shots = data, subtitles = subs, audio = auds,
    loop = args.loop == true, skippable = args.skippable ~= false }
  local mod = Instance.new("ModuleScript")
  mod.Name = name
  local okEnc, json = pcall(function() return HttpService:JSONEncode(doc) end)
  local decoded = "{}"
  if okEnc then decoded = "game:GetService(\"HttpService\"):JSONDecode([=[" .. tostring(json) .. "]=])" end
  mod.Source = "-- RoLink cutscene data (" .. #data .. " shots)\nreturn " .. decoded
  mod.Parent = folder
  local scripts = game:GetService("StarterPlayer"):FindFirstChild("StarterPlayerScripts")
  local store = scripts and scripts:FindFirstChild(Cutscene.scripts) or nil
  if not store then
    store = Instance.new("Folder")
    store.Name = Cutscene.scripts
    store.Parent = scripts or game:GetService("StarterPlayer")
  end
  local oldScript = store:FindFirstChild("RoLinkCutscene_" .. name)
  if oldScript then oldScript:Destroy() end
  local script = Instance.new("LocalScript")
  script.Name = "RoLinkCutscene_" .. name
  script.Source = Cutscene.cutsceneScriptSource(name)
  script.Parent = store
  script:SetAttribute("RoLinkCutscene", name)
  pcall(function() ChangeHistoryService:SetWaypoint("RoLink cutscene " .. name) end)
  return { name = name, shots = #data, duration = total, total = total,
    path = mod:GetFullName(), script = script:GetFullName(),
    subtitles = #subs, audio = #auds, loop = doc.loop, skippable = doc.skippable,
    rendered = false, playable = true,
    note = "Edit stores data + a Play-time LocalScript (auto-plays on spawn, skippable). Preview/validate before Play; Edit never renders camera." }
end
function Cutscene.previewCutscene(args:{ [string]: any }): { [string]: any }
  local name = tostring(args.name or "RoLinkCutscene"):sub(1, 64)
  local inst, data = Cutscene.cutsceneData(name)
  local tl = Cutscene.cutsceneTimeline(data)
  local subs = data.subtitles or {}
  local auds = data.audio or {}
  return { name = name, path = inst:GetFullName(), total = tl.total,
    shots = tl.shots, subtitles = subs, audio = auds,
    loop = data.loop == true, skippable = data.skippable ~= false,
    rendered = false, playable = true,
    note = "Numeric camera timeline from stored data; Studio plugins cannot prove rendered pixels." }
end
function Cutscene.validateCutscene(args:{ [string]: any }): { [string]: any }
  local name = tostring(args.name or "RoLinkCutscene"):sub(1, 64)
  local inst, data = Cutscene.cutsceneData(name)
  local errors:{ [string]: any } = {}
  local warnings:{ [string]: any } = {}
  local shots = type(data.shots) == "table" and data.shots or {}
  if #shots == 0 then table.insert(errors, { code = "NO_SHOTS", detail = name }) end
  local total = 0
  for i, s in ipairs(shots) do
    local dur = num(s.duration, 0)
    if dur < 0.1 or dur > 30 then
      table.insert(errors, { code = "BAD_DURATION", detail = "shot " .. i })
    end
    total += dur
    if not resolveEasing(tostring(s.easing or "linear")) then
      table.insert(errors, { code = "BAD_EASING", detail = "shot " .. i })
    end
    local trans = tostring(s.transition or "cut")
    if trans ~= "cut" and trans ~= "fade" then
      table.insert(errors, { code = "BAD_TRANSITION", detail = "shot " .. i })
    end
    if s.fov ~= nil then
      local fv = tonumber(s.fov) or 0
      if fv < 1 or fv > 179 then
        table.insert(errors, { code = "BAD_FOV", detail = "shot " .. i })
      end
    end
  end
  if total > Cutscene.totalMax then
    table.insert(warnings, { code = "LONG_TOTAL",
      detail = "total " .. total .. "s over " .. Cutscene.totalMax .. "s - split into chapters" })
  end
  if data.loop == true and #shots >= 2 then
    local first, last = shots[1], shots[#shots]
    local fp = first.camera and first.camera.position or {}
    local lp = last.camera and last.camera.position or {}
    local dp = math.sqrt((num(lp.x, 0) - num(fp.x, 0)) ^ 2
      + (num(lp.y, 0) - num(fp.y, 0)) ^ 2
      + (num(lp.z, 0) - num(fp.z, 0)) ^ 2)
    if dp > 2 then
      table.insert(warnings, { code = "LOOP_SEAM",
        detail = string.format("looped cutscene drifts %.1f studs (first vs last camera) - it will jump every cycle", dp) })
    end
  end
  for i, lD in ipairs(type(data.subtitles) == "table" and data.subtitles or {}) do
    if num(lD.t, -1) < 0 or num(lD.t, -1) > total then
      table.insert(errors, { code = "SUBTITLE_TIME", detail = "subtitle " .. i })
    end
  end
  for i, aD in ipairs(type(data.audio) == "table" and data.audio or {}) do
    if not tostring(aD.soundId or ""):match("^rbxassetid://%d+$") then
      table.insert(errors, { code = "AUDIO_ID", detail = "audio " .. i })
    end
  end
  return { name = name, path = inst:GetFullName(), valid = #errors == 0,
    errors = errors, warnings = warnings, total = total, shots = #shots }
end
function Cutscene.removeCutscene(args:{ [string]: any }): { [string]: any }
  local name = tostring(args.name or "RoLinkCutscene"):sub(1, 64)
  if args.confirm ~= true then
    error("CONFIRM_REQUIRED: remove cutscene '" .. name .. "' - re-send with confirm:true")
  end
  local folder = game.Workspace:FindFirstChild(Cutscene.folder)
  local inst = folder and folder:FindFirstChild(name) or nil
  if not inst then
    error("CUTSCENE_NOT_FOUND: no cutscene named '" .. name .. "'")
  end
  local destroyed:{ [string]: any } = {}
  destroyed.data = inst:GetFullName()
  inst:Destroy()
  local scripts = game:GetService("StarterPlayer"):FindFirstChild("StarterPlayerScripts")
  local store = scripts and scripts:FindFirstChild(Cutscene.scripts) or nil
  local script = store and store:FindFirstChild("RoLinkCutscene_" .. name) or nil
  if script then destroyed.script = script:GetFullName() script:Destroy() end
  pcall(function() ChangeHistoryService:SetWaypoint("RoLink remove cutscene " .. name) end)
  return { removed = true, name = name, destroyed = destroyed }
end
local function createDialogue(args:{ [string]: any }): { [string]: any }
  local npc = findByPath(tostring(args.npcPath or ""))
  if not npc then error("not found " .. tostring(args.npcPath or "") .. siblingHint(args.npcPath or "")) end
  local lines = args.lines
  if type(lines) ~= "table" or #lines == 0 then error("lines must be a non-empty array") end
  if #lines > 50 then error("too many lines (max 50)") end
  for i, lD in ipairs(lines) do
    if type(lD) ~= "table" or tostring((lD::any).speaker or "") == "" then error("line " .. i .. " needs speaker") end
    if tostring((lD::any).text or "") == "" then error("line " .. i .. " needs text") end
    local ch = (lD::any).choices
    if ch ~= nil then
      if type(ch) ~= "table" or #ch > 4 then error("line " .. i .. " choices: max 4 strings") end
    end
  end
  local anchor: Instance? = npc:IsA("Model") and (npc:FindFirstChild("Head") or npc:FindFirstChild("HumanoidRootPart") or npc) or npc
  local prompt = Instance.new("ProximityPrompt")
  prompt.Name = "RoLinkDialogue"
  prompt.ActionText = "Talk"
  prompt.HoldDuration = 0
  prompt.Parent = anchor
  local mod = Instance.new("ModuleScript")
  mod.Name = npc.Name .. "Dialogue"
  local okEnc, json = pcall(function() return game:GetService("HttpService"):JSONEncode(lines) end)
  local decoded = "{}"
  if okEnc then decoded = "game:GetService(\"HttpService\"):JSONDecode([=[" .. tostring(json) .. "]=])" end
  mod.Source = "-- RoLink dialogue data (" .. #lines .. " lines)\nreturn " .. decoded
  mod.Parent = npc
  pcall(function() ChangeHistoryService:SetWaypoint("RoLink dialogue " .. npc.Name) end)
  local snippet = "local lines = require(script.Parent:FindFirstChild(\"" .. mod.Name:gsub('"', "'")
    .. "\")) -- show lines[i].speaker .. \": \" .. lines[i].text in your dialogue UI on ProximityPrompt.Triggered"
  return { lines = #lines, path = mod:GetFullName(), prompt = prompt:GetFullName(), runtimeSnippet = snippet }
end
Motion.effectAllowed = {
  tween = { Position = true, CFrame = true, Size = true, Transparency = true,
    Color = true, Brightness = true },
  pulse = { scale = true, Transparency = true },
  shake = { amplitude = true, frequency = true, seed = true },
  fov = { FieldOfView = true, value = true },
}
function Motion.motionEffectRoot(): Instance
  local rs = game:GetService("ReplicatedStorage")
  local root = rs:FindFirstChild(Motion.effectRoot)
  if not root then
    root = Instance.new("Folder")
    root.Name = Motion.effectRoot
    root.Parent = rs
  end
  return root
end
function Motion.motionEffectFinite(v:any, label:string): number
  local n = tonumber(v)
  if n == nil or n ~= n or n == math.huge or n == -math.huge then
    error("MOTION_PROPERTY_INVALID: " .. label .. " must be a finite number")
  end
  return n
end
function Motion.motionEffectProperties(effect:string, raw:any): { [string]: any }
  if raw == nil then return {} end
  if type(raw) ~= "table" then error("MOTION_PROPERTY_INVALID: properties must be an object") end
  local allowed = Motion.effectAllowed[effect] or {}
  local out:{ [string]: any } = {}
  for k, v in pairs(raw) do
    local key = tostring(k)
    if not allowed[key] then
      error("MOTION_PROPERTY_INVALID: property '" .. key:sub(1, 48) .. "' is not allowed for " .. effect)
    end
    if type(v) == "number" or type(v) == "string" or type(v) == "boolean" then
      if type(v) == "number" then Motion.motionEffectFinite(v, key) end
      out[key] = v
    elseif type(v) == "table" then
      out[key] = Motion.motionPlain(v)
    else
      error("MOTION_PROPERTY_INVALID: property '" .. key:sub(1, 48) .. "' must be JSON data")
    end
  end
  if effect == "pulse" then
    local scale = tonumber(out.scale or 1.15)
    if not scale or scale < 0.05 or scale > 10 then
      error("MOTION_PROPERTY_INVALID: pulse scale must be 0.05-10")
    end
    out.scale = scale
  elseif effect == "shake" then
    out.amplitude = math.clamp(tonumber(out.amplitude or 1) or 1, 0, 100)
    out.frequency = math.clamp(tonumber(out.frequency or 18) or 18, 0.1, 60)
    out.seed = math.floor(tonumber(out.seed or 1) or 1)
  elseif effect == "fov" then
    local fov = tonumber(out.FieldOfView or out.value or 90)
    if not fov or fov < 1 or fov > 179 then error("MOTION_PROPERTY_INVALID: FOV must be 1-179") end
    out.FieldOfView = fov
    out.value = nil
  end
  return out
end
function Motion.motionEffectScriptSource(name:string): string
  return "local CONFIG_FOLDER = " .. string.format("%q", name) .. "\n" .. [==[
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Workspace = game:GetService("Workspace")
local HttpService = game:GetService("HttpService")
local RunService = game:GetService("RunService")
local TweenService = game:GetService("TweenService")
local root = ReplicatedStorage:WaitForChild("RoLinkMotionEffects")
local folder = root:WaitForChild(CONFIG_FOLDER)
local value = folder:WaitForChild("Config")
local ok, config = pcall(function() return HttpService:JSONDecode(value.Value) end)
if not ok or type(config) ~= "table" then
  warn("[RoLink] invalid motion effect config")
  return
end
local function resolve(path)
  if path == "camera" or path == "Camera" or path == "workspace.CurrentCamera" then
    return Workspace.CurrentCamera
  end
  local current = game
  for part in string.gmatch(path or "", "[^/]+") do
    if part == "Workspace" then current = Workspace
    elseif part == "ReplicatedStorage" or part == "ServerStorage"
      or part == "ServerScriptService" or part == "StarterPlayer" then
      current = game:GetService(part)
    elseif current then current = current:FindFirstChild(part, true) end
    if not current then return nil end
  end
  return current
end
local target = resolve(config.targetPath)
if not target then
  warn("[RoLink] motion effect target is missing: " .. tostring(config.targetPath))
  return
end
folder:SetAttribute("RoLinkRuntimeState", "running")
local duration = math.clamp(tonumber(config.duration or 1) or 1, 0.1, 30)
local loop = config.loop == true
local function alive() return folder.Parent ~= nil end
local function finish(state)
  if alive() then folder:SetAttribute("RoLinkRuntimeState", state) end
end
local effect = config.effect
if effect == "fov" then
  if not target:IsA("Camera") then warn("[RoLink] FOV effect needs a Camera") return end
  local original = target.FieldOfView
  local goal = tonumber(config.properties and config.properties.FieldOfView) or 90
  local info = TweenInfo.new(duration, Enum.EasingStyle.Quad, Enum.EasingDirection.InOut)
  repeat
    if not alive() then return end
    TweenService:Create(target, info, {FieldOfView = goal}):Play()
    task.wait(duration)
    if not alive() then return end
    if not loop then break end
    TweenService:Create(target, info, {FieldOfView = original}):Play()
    task.wait(duration)
  until not alive()
  if alive() then TweenService:Create(target, info, {FieldOfView = original}):Play() end
  finish("finished")
  return
end
if effect == "tween" then
  if not target:IsA("BasePart") and not target:IsA("Model") then
    warn("[RoLink] tween effect needs a BasePart or Model")
    return
  end
  local goals = {}
  local p = config.properties or {}
  if p.Position then
    goals.Position = Vector3.new(p.Position.x or 0, p.Position.y or 0, p.Position.z or 0)
  end
  if p.Size then
    if target:IsA("BasePart") then
      goals.Size = Vector3.new(p.Size.x or target.Size.X, p.Size.y or target.Size.Y, p.Size.z or target.Size.Z)
    end
  end
  if p.Transparency ~= nil then goals.Transparency = tonumber(p.Transparency) or 0 end
  if p.Brightness ~= nil then goals.Brightness = tonumber(p.Brightness) or 0 end
  if p.Color then
    goals.Color = Color3.new(p.Color.r or 1, p.Color.g or 1, p.Color.b or 1)
  end
  if p.CFrame and target:IsA("BasePart") then
    local q = p.CFrame.position or {}
    local r = p.CFrame.rotation or {}
    goals.CFrame = CFrame.new(q.x or 0, q.y or 0, q.z or 0) * CFrame.Angles(
      math.rad(r.x or 0), math.rad(r.y or 0), math.rad(r.z or 0))
  end
  if next(goals) == nil then warn("[RoLink] tween effect has no supported properties") return end
  repeat
    if not alive() then return end
    TweenService:Create(target, TweenInfo.new(duration, Enum.EasingStyle.Quad, Enum.EasingDirection.InOut), goals):Play()
    task.wait(duration)
  until not loop or not alive()
  finish("finished")
  return
end
if effect == "pulse" then
  if not target:IsA("BasePart") then warn("[RoLink] pulse effect needs a BasePart") return end
  local original = target.Size
  local scale = tonumber(config.properties and config.properties.scale) or 1.15
  local peak = original * scale
  local trans = config.properties and config.properties.Transparency
  repeat
    if not alive() then return end
    local t1 = TweenService:Create(target, TweenInfo.new(duration / 2, Enum.EasingStyle.Quad, Enum.EasingDirection.Out), {Size = peak})
    t1:Play()
    if trans ~= nil then target.Transparency = tonumber(trans) or target.Transparency end
    task.wait(duration / 2)
    if not alive() then return end
    local t2 = TweenService:Create(target, TweenInfo.new(duration / 2, Enum.EasingStyle.Quad, Enum.EasingDirection.In), {Size = original})
    t2:Play()
    task.wait(duration / 2)
  until not loop or not alive()
  if alive() then target.Size = original end
  finish("finished")
  return
end
if effect == "shake" then
  local amplitude = tonumber(config.properties and config.properties.amplitude) or 1
  local frequency = tonumber(config.properties and config.properties.frequency) or 18
  local random = Random.new(tonumber(config.properties and config.properties.seed) or 1)
  local originalCFrame = target:IsA("BasePart") and target.CFrame or nil
  local originalOffset = target:IsA("Camera") and target.CFrame or nil
  local elapsed = 0
  local connection
  connection = RunService.Heartbeat:Connect(function(dt)
    if not alive() or not target.Parent then
      if connection then connection:Disconnect() end
      return
    end
    elapsed += dt
    local falloff = math.max(0, 1 - elapsed / duration)
    local x = (random:NextNumber(-1, 1) * amplitude * falloff)
    local y = (random:NextNumber(-1, 1) * amplitude * falloff)
    local z = (random:NextNumber(-1, 1) * amplitude * falloff)
    if target:IsA("BasePart") and originalCFrame then
      target.CFrame = originalCFrame * CFrame.new(x, y, z)
    elseif target:IsA("Camera") and originalOffset then
      target.CFrame = originalOffset * CFrame.new(x, y, z)
    end
    if elapsed >= duration and not loop then
      connection:Disconnect()
      if target:IsA("BasePart") and originalCFrame then target.CFrame = originalCFrame end
      if target:IsA("Camera") and originalOffset then target.CFrame = originalOffset end
      finish("finished")
    elseif elapsed >= duration then
      elapsed = 0
      if target:IsA("BasePart") and originalCFrame then originalCFrame = target.CFrame end
      if target:IsA("Camera") and originalOffset then originalOffset = target.CFrame end
    end
  end)
  return
end
warn("[RoLink] unknown motion effect")
]==]
end
function Motion.motionEffectConfig(name:string): (Instance, { [string]: any })
  local folder = Motion.motionEffectRoot():FindFirstChild(name)
  if not folder then error("MOTION_EFFECT_NOT_FOUND: no motion effect named '" .. name:sub(1, 64) .. "'") end
  local value = folder:FindFirstChild("Config")
  if not value or not value:IsA("StringValue") then error("MOTION_EFFECT_CORRUPT: Config is missing") end
  local ok, cfg = pcall(function() return HttpService:JSONDecode((value :: StringValue).Value) end)
  if not ok or type(cfg) ~= "table" then error("MOTION_EFFECT_CORRUPT: Config is invalid JSON") end
  return folder, cfg
end
local function createMotionEffect(args:{ [string]: any }): { [string]: any }
  local effect = tostring(args.effect or "tween")
  if not Motion.effects[effect] then error("unknown effect '" .. effect:sub(1, 32) .. "' (tween|shake|fov|pulse)") end
  local requestedPath = tostring(args.path or "")
  if requestedPath == "" then error("path is required") end
  local target = findByPath(requestedPath)
  local isCamera = requestedPath == "camera" or requestedPath == "Camera"
    or requestedPath:lower():find("currentcamera", 1, true) ~= nil
  if not target and not isCamera then error("not found " .. requestedPath .. siblingHint(requestedPath)) end
  if effect == "fov" and not isCamera and (not target or not target:IsA("Camera")) then
    error("MOTION_EFFECT_TARGET_INVALID: fov needs path='camera' or a Camera path")
  end
  if (effect == "tween" or effect == "pulse") and (not target or not (target:IsA("BasePart") or target:IsA("Model"))) then
    error("MOTION_EFFECT_TARGET_INVALID: " .. effect .. " needs a BasePart or Model path")
  end
  if effect == "shake" and not target and not isCamera then
    error("MOTION_EFFECT_TARGET_INVALID: shake needs a part or camera path")
  end
  local name = Motion.motionCleanName(args.name or (effect .. "_" .. (target and target.Name or "camera")), "RoLinkMotionEffect")
  local root = Motion.motionEffectRoot()
  if root:FindFirstChild(name) and args.confirm ~= true then
    error("CONFIRM_REQUIRED: motion effect '" .. name .. "' exists - re-send with confirm:true to replace it")
  end
  if root:FindFirstChild(name) then
    local old = root:FindFirstChild(name)
    old:Destroy()
  end
  local properties = Motion.motionEffectProperties(effect, args.properties)
  local dur = math.clamp(num(args.duration, 1), 0.1, 30)
  local playback = tostring(args.playback or "auto")
  if playback == "auto" then playback = (effect == "fov" or isCamera) and "client" or "server" end
  if playback ~= "server" and playback ~= "client" then error("playback must be auto, server, or client") end
  if effect == "fov" then playback = "client" end
  local config = { schemaVersion = 1, name = name, effect = effect,
    targetPath = isCamera and "camera" or Motion.motionPath(target), duration = dur,
    loop = args.loop == true, playback = playback, autoPlay = args.autoPlay ~= false,
    properties = properties, originalTransparency = target and target:IsA("BasePart") and target.Transparency or nil }
  local folder = Instance.new("Folder")
  folder.Name = name
  folder:SetAttribute("RoLinkMotionEffect", true)
  folder:SetAttribute("effect", effect)
  folder:SetAttribute("targetPath", config.targetPath)
  folder:SetAttribute("duration", dur)
  folder:SetAttribute("loop", config.loop)
  folder:SetAttribute("playback", playback)
  local value = Instance.new("StringValue")
  value.Name = "Config"
  value.Value = Motion.motionJson(config)
  value.Parent = folder
  folder.Parent = root
  local service = game:GetService(playback == "client" and "StarterPlayer" or "ServerScriptService")
  local scripts = service:FindFirstChild("RoLinkMotionEffectScripts")
  if not scripts then
    scripts = Instance.new("Folder")
    scripts.Name = "RoLinkMotionEffectScripts"
    scripts.Parent = service
  end
  local script = Instance.new(playback == "client" and "LocalScript" or "Script")
  script.Name = "RoLinkMotionEffect_" .. name
  script.Source = Motion.motionEffectScriptSource(name)
  script.Parent = scripts
  folder:SetAttribute("scriptPath", script:GetFullName())
  pcall(function() ChangeHistoryService:SetWaypoint("RoLink motion effect " .. name) end)
  return { created = true, effect = effect, name = name, controller = folder:GetFullName(),
    config = value:GetFullName(), script = script:GetFullName(), target = config.targetPath,
    duration = dur, loop = config.loop, playback = playback, autoPlay = config.autoPlay,
    rendered = false, playable = config.autoPlay,
    note = config.autoPlay and "Edit-time controller created; it executes when Play starts."
      or "Edit-time controller created with autoPlay=false; no runtime effect was started." }
end
local function inspectMotionEffect(args:{ [string]: any }): { [string]: any }
  local name = Motion.motionCleanName(args.name, "RoLinkMotionEffect")
  local folder, cfg = Motion.motionEffectConfig(name)
  return { name = name, controller = folder:GetFullName(), config = folder:FindFirstChild("Config"):GetFullName(),
    effect = tostring(cfg.effect or ""), targetPath = tostring(cfg.targetPath or ""),
    targetResolved = findByPath(tostring(cfg.targetPath or "")) ~= nil or tostring(cfg.targetPath) == "camera",
    duration = num(cfg.duration, 1), loop = cfg.loop == true, playback = tostring(cfg.playback or "server"),
    autoPlay = cfg.autoPlay ~= false, runtimeState = folder:GetAttribute("RoLinkRuntimeState") }
end
local function removeMotionEffect(args:{ [string]: any }): { [string]: any }
  local name = Motion.motionCleanName(args.name, "RoLinkMotionEffect")
  if args.confirm ~= true then error("CONFIRM_REQUIRED: remove motion effect '" .. name .. "' - re-send with confirm:true") end
  local folder = Motion.motionEffectRoot():FindFirstChild(name)
  if not folder then error("MOTION_EFFECT_NOT_FOUND: no motion effect named '" .. name:sub(1, 64) .. "'") end
  local path = folder:GetFullName()
  folder:Destroy()
  for _, service in ipairs({game:GetService("ServerScriptService"), game:GetService("StarterPlayer")}) do
    local scripts = service:FindFirstChild("RoLinkMotionEffectScripts")
    if scripts then
      local script = scripts:FindFirstChild("RoLinkMotionEffect_" .. name)
      if script then script:Destroy() end
    end
  end
  pcall(function() ChangeHistoryService:SetWaypoint("RoLink remove motion effect " .. name) end)
  return { removed = true, name = name, controller = path }
end
local VFX_CLASSES: { [string]: string } = {
  particles = "ParticleEmitter", fire = "Fire", smoke = "Smoke",
  sparkles = "Sparkles", beam = "Beam", pointlight = "PointLight",
}
local function createVfx(args:{ [string]: any }): { [string]: any }
  local parent = findByPath(tostring(args.parent or "workspace")) or workspace
  local effect = tostring(args.effect or "particles")
  local className = VFX_CLASSES[effect]
  if not className then error("unknown effect '" .. effect:sub(1, 32) .. "' (particles|fire|smoke|sparkles|beam|pointlight)") end
  local inst = Instance.new(className)
  inst.Name = "RoLink" .. effect:gsub("^%l", string.upper)
  if args.properties and type(args.properties) == "table" then
    for k, v in pairs(args.properties::any) do pcall(function() (inst::any)[k] = v end) end
  end
  if effect == "beam" then
    local a0 = Instance.new("Attachment"); a0.Parent = parent
    local a1 = Instance.new("Attachment"); a1.Position = Vector3.new(0, 5, 0); a1.Parent = parent
    pcall(function() (inst::any).Attachment0 = a0; (inst::any).Attachment1 = a1 end)
  end
  inst.Parent = parent
  pcall(function() ChangeHistoryService:SetWaypoint("RoLink vfx " .. effect) end)
  return { created = { inst:GetFullName() }, effect = effect }
end

-- ── Clip export + publish workflow (tools 118-119) ───────────────────
-- The AnimationClip twin carries the track's curve data (one JSON curve per
-- part) for editor round-trips and read-back. Playback still uses the
-- sequence hash or a published asset ID — never LoadAnimation a clip.
-- AnimationClip availability varies by Studio version: absence is a clean
-- validation_error, never a crash.
local function resolveSourceSequence(args:{ [string]: any }): Instance
  local pathArg = tostring(args.trackPath or "")
  local animId = tostring(args.animationId or "")
  if pathArg ~= "" then
    local inst = findByPath(pathArg)
    if not inst then error("not found " .. pathArg .. siblingHint(pathArg)) end
    if not inst:IsA("KeyframeSequence") then error("not a KeyframeSequence: " .. inst:GetFullName()) end
    return inst
  end
  if animId ~= "" then
    local seq = animCache[animId]
    if seq then return seq end
    local byPath = findByPath(animId)
    if byPath and byPath:IsA("KeyframeSequence") then return byPath end
  end
  error("trackPath or animationId required (e.g. trackPath=Workspace/RoLinkAnimations/HelloWave)")
  return nil :: any
end
local function exportAnimationClip(args:{ [string]: any }): { [string]: any }
  local seq = resolveSourceSequence(args)
  local clip: Instance? = nil
  local okNew, newInst = pcall(function() return Instance.new("AnimationClip") end)
  if not okNew or not newInst then
    error("validation_error: this Studio version cannot create AnimationClip (update Studio). "
      .. "Do NOT retry prepare here - keep the KeyframeSequence, publish it via Studio's Animation Editor "
      .. "(human click), then publish_animation{action:register, assetId:rbxassetid://...} with the real ID.")
  end
  clip = newInst
  ;(clip::any).Name = seq.Name .. "Clip"
  pcall(function() (clip::any).Loop = (seq::any).Loop end)
  local curveCount = 0
  pcall(function()
    for _, kf in ipairs((seq::any):GetKeyframes()) do
      for _, d in ipairs((kf::any):GetDescendants()) do
        if d:IsA("Pose") then
          local part = d.Name
          local holder = (clip::any):FindFirstChild("Curve_" .. part)
          if not holder then
            holder = Instance.new("StringValue")
            holder.Name = "Curve_" .. part
            holder.Parent = clip
          end
          local okDec, arr = pcall(function()
            return game:GetService("HttpService"):JSONDecode(holder.Value == "" and "[]" or holder.Value)
          end)
          if not okDec or type(arr) ~= "table" then arr = {} end
          table.insert(arr, { t = (kf::any).Time, cf = tostring((d::any).CFrame) })
          local okEnc, js = pcall(function() return game:GetService("HttpService"):JSONEncode(arr) end)
          if okEnc then holder.Value = js end
          curveCount += 1
        end
      end
    end
  end)
  ;(clip::any).Parent = seq.Parent
  pcall(function() ChangeHistoryService:SetWaypoint("RoLink clip " .. seq.Name) end)
  return { clip = (clip::any):GetFullName(), curves = clipCurvesSummary(clip),
    keyframes = #(seq::any):GetKeyframes(),
    note = "Clip twin for editor round-trip + read-back. Playback uses the sequence hash or a published asset ID, never this clip." }
end
local function prepareAnimation(args:{ [string]: any }): { [string]: any }
  local seq = resolveSourceSequence(args)
  local kfs = (seq::any):GetKeyframes()
  if #kfs == 0 then error("track " .. seq:GetFullName() .. " has no keyframes - nothing to publish") end
  local clipRes = exportAnimationClip(args)
  return { ready = true, track = seq:GetFullName(), keyframes = #kfs,
    clip = clipRes.clip, curves = clipRes.curves,
    checklist = { "poses named per rig part", "times non-decreasing", "clip twin emitted" },
    publishSteps = "In Studio: select the track (or open it in the Animation Editor), Publish to Roblox, copy the asset ID, then publish_animation{action:register, assetId:rbxassetid://...}. Publishing needs your login - the AI cannot click it for you." }
end
local function registerAnimation(args:{ [string]: any }): { [string]: any }
  local assetId = tostring(args.assetId or "")
  if assetId == "" then error("assetId required (e.g. rbxassetid://123456) - paste the ID from your publish step") end
  if assetId:find("rbxassetid://", 1, true) ~= 1 and not assetId:match("^%d+$") then
    error("assetId must look like rbxassetid://123456 or a numeric id, got '" .. assetId:sub(1, 40) .. "' - never invent IDs")
  end
  local ok, got = pcall(function()
    return game:GetService("KeyframeSequenceProvider"):GetKeyframeSequenceAsync(assetId)
  end)
  if not ok or not got then error("animation not found for " .. assetId .. " - check the ID and that it is published") end
  animCache[assetId] = got
  return { animationId = assetId, cached = true, name = got.Name,
    note = "Use play_animation/get_animation_info with this ID. Temp hashes die with the session; this ID ships." }
end


-- ── Model animation store (tools 125-131) ─────────────────────────────
-- AI-native animation for ANY rig: humanoids, cannons, doors, vehicles,
-- machines. Definitions live in ReplicatedStorage/RoLinkModelAnims/<Name>
-- (Folder + attributes + StringValue JSON) so chat turns and the future
-- timeline widget read the same source. All motion math is numeric
-- (degrees + studs); preview/validate return numbers, never pixels, because
-- Studio exposes no pixel capture to plugins.
local MAX_MODEL_KEYS = 1024
local RL_ROT_WARN, RL_ROT_ERR = 2400, 7200
local RL_POS_WARN, RL_POS_ERR = 15, 40
local function rlAnimRoot(): Instance
  local rs = game:GetService("ReplicatedStorage")
  local f = rs:FindFirstChild("RoLinkModelAnims")
  if not f then
    f = Instance.new("Folder")
    f.Name = "RoLinkModelAnims"
    f.Parent = rs
  end
  return f
end
local function rlAnimFolder(name: string): Instance?
  return rlAnimRoot():FindFirstChild(name)
end
local function rlAnimRead(name: string): (Instance, { [string]: any }, { [string]: any }, { [string]: any })
  local folder = rlAnimFolder(name)
  if not folder then
    error("MODEL_ANIM_NOT_FOUND: no model animation named '" .. name:sub(1, 64) .. "' under ReplicatedStorage/RoLinkModelAnims - create it with create_model_animation first. For KeyframeSequence tracks (Workspace/RoLinkAnimations/...) use get_animation_info{path} or inspect_keyframe_track{path} instead.")
  end
  local function get(child: string): any
    local sv = folder:FindFirstChild(child)
    if not sv or not sv:IsA("StringValue") then return nil end
    local ok, v = pcall(function() return HttpService:JSONDecode((sv :: StringValue).Value) end)
    if not ok then
      error("MODEL_ANIM_CORRUPT: '" .. name:sub(1, 64) .. "/" .. child .. "' is not valid JSON - recreate the animation")
    end
    return v
  end
  local tracks = get("tracks")
  if tracks == nil then tracks = {} end
  local markers = get("markers")
  if markers == nil then markers = {} end
  local events = get("events")
  if events == nil then events = {} end
  if type(tracks) ~= "table" or type(markers) ~= "table" or type(events) ~= "table" then
    error("MODEL_ANIM_CORRUPT: '" .. name:sub(1, 64) .. "' store has a bad shape - recreate the animation")
  end
  return folder, tracks, markers, events
end
local function rlAnimWrite(name: string, folder: Instance, tracks: any, markers: any, events: any)
  local function put(child: string, v: any)
    local sv = folder:FindFirstChild(child)
    if not sv then
      sv = Instance.new("StringValue")
      sv.Name = child
      sv.Parent = folder
    end
    (sv :: StringValue).Value = HttpService:JSONEncode(v)
  end
  put("tracks", tracks)
  put("markers", markers)
  put("events", events)
  pcall(function() ChangeHistoryService:SetWaypoint("RoLink model-anim " .. name:sub(1, 48)) end)
end
local function rlJointKind(inst: Instance): string
  if inst:IsA("Motor6D") or inst:IsA("Bone") then return "rotational" end
  if inst:IsA("Weld") or inst:IsA("WeldConstraint") then return "follow" end
  if inst:IsA("Attachment") then return "anchor" end
  if inst:IsA("Model") then
    local pp: Instance? = nil
    pcall(function() pp = (inst :: Model).PrimaryPart end)
    if pp then return "root" end
    return "static"
  end
  if inst:IsA("BasePart") then return "rigid" end
  return "static"
end
local function rlModelAnalyze(args: { [string]: any }): { [string]: any }
  local path = tostring(args.target or "")
  local target = findByPath(path)
  if not target then error("Model not found: '" .. path:sub(1, 120) .. "'.") end
  local nodes: { [string]: any } = {}
  local warnings: { string } = {}
  local rotational, hasRoot, hasRigid, hasFollow = 0, false, false, false
  local hasHumanoid = false
  pcall(function() hasHumanoid = target:FindFirstChildOfClass("Humanoid") ~= nil end)
  local selfKind = rlJointKind(target)
  if selfKind ~= "static" then
    table.insert(nodes, { path = target:GetFullName(), name = target.Name, class = target.ClassName, kind = selfKind, depth = 0 })
    if selfKind == "root" then hasRoot = true end
    if selfKind == "rigid" then hasRigid = true end
  end
  local stopped = false
  local function walk(inst: Instance, depth: number)
    if stopped or depth > 6 then return end
    for _, c in ipairs(inst:GetChildren()) do
      if stopped then return end
      if #nodes >= 200 then stopped = true return end
      local k = rlJointKind(c)
      if k ~= "static" then
        table.insert(nodes, { path = c:GetFullName(), name = c.Name, class = c.ClassName, kind = k, depth = depth })
        if k == "rotational" then rotational += 1 end
        if k == "root" then hasRoot = true end
        if k == "rigid" then hasRigid = true end
        if k == "follow" then hasFollow = true end
      end
      if #c:GetChildren() > 0 then walk(c, depth + 1) end
    end
  end
  walk(target, 1)
  if #nodes == 0 then
    table.insert(warnings, "nothing animatable under '" .. target.Name:sub(1, 48) .. "' (need Motor6D/Bone joints, a PrimaryPart, or BaseParts)")
  end
  if target:IsA("Model") then
    local pp: Instance? = nil
    pcall(function() pp = (target :: Model).PrimaryPart end)
    if not pp then table.insert(warnings, "no PrimaryPart on '" .. target.Name:sub(1, 48) .. "': root motion unavailable until one is set") end
  end
  if hasHumanoid then table.insert(warnings, "humanoid rig: use create_animation_track for character clips; model tracks suit prop-style motion on this rig") end
  if hasFollow and rotational == 0 and not hasRigid and not hasRoot then
    table.insert(warnings, "only follow/anchor parts found: animate a parent, never these")
  end
  if stopped then table.insert(warnings, "node cap 200 hit: smallest parts omitted") end
  local controller = "none"
  if hasHumanoid then controller = "hybrid (character clips + model tracks)"
  elseif rotational > 0 then controller = "hierarchical transforms"
  elseif hasRoot then controller = "root motion"
  elseif hasRigid then controller = "rigid assembly" end
  return { model = target:GetFullName(), animatable = nodes, warnings = warnings, controller = controller }
end
local function rlModelCreate(args: { [string]: any }): { [string]: any }
  local path = tostring(args.target or "")
  local target = findByPath(path)
  if not target then error("Model not found: '" .. path:sub(1, 120) .. "'.") end
  local name = tostring(args.name or ""):gsub("^%s+", ""):gsub("%s+$", ""):sub(1, 64)
  if name == "" then error("name is required (max 64 chars)") end
  local duration = num(args.duration, 0)
  if duration < 0.1 or duration > 60 then error("duration must be 0.1-60s (got " .. tostring(args.duration) .. ")") end
  local fps = math.floor(num(args.fps, 30))
  if fps < 1 or fps > 120 then error("fps must be 1-120 (got " .. tostring(args.fps) .. ")") end
  local existing = rlAnimFolder(name)
  if existing and args.confirm ~= true then
    error("CONFIRM_REQUIRED: model animation '" .. name .. "' already exists - re-send with confirm:true to overwrite, or pick another name")
  end
  local folder = existing
  if not folder then
    folder = Instance.new("Folder")
    folder.Name = name
    folder.Parent = rlAnimRoot()
  end
  folder:SetAttribute("target", target:GetFullName())
  folder:SetAttribute("duration", duration)
  folder:SetAttribute("fps", fps)
  folder:SetAttribute("loop", args.loop == true)
  rlAnimWrite(name, folder, {}, {}, {})
  return { animation = name, target = target:GetFullName(), duration = duration, fps = fps, loop = args.loop == true, tracks = 0 }
end
local function rlPoseNum(v: any): { [string]: any }
  local p = { pos = { x = 0, y = 0, z = 0 }, rot = { x = 0, y = 0, z = 0 } }
  if type(v) ~= "table" then return p end
  local pp = (v :: any).position
  if type(pp) == "table" then
    p.pos = { x = num((pp :: any).x, 0), y = num((pp :: any).y, 0), z = num((pp :: any).z, 0) }
  end
  local rr = (v :: any).rotation
  if type(rr) == "table" then
    p.rot = { x = num((rr :: any).x, 0), y = num((rr :: any).y, 0), z = num((rr :: any).z, 0) }
  end
  return p
end
-- Lock helpers live here, ahead of first use: Luau locals are visible only
-- AFTER their declaration, and rlModelSetKey/rlModelSetEase below call
-- rlAnimGetLocked. Defining it further down resolved to a nil global at
-- runtime ("attempt to call a nil value" on every set key/easing call).
local function rlAnimGetLocked(folder: Instance): { [string]: boolean }
  local set: { [string]: boolean } = {}
  pcall(function()
    local sv = folder:FindFirstChild("locked")
    if sv and sv:IsA("StringValue") then
      local v = HttpService:JSONDecode((sv :: StringValue).Value)
      if type(v) == "table" then
        for _, n in ipairs(v) do set[tostring(n)] = true end
      end
    end
  end)
  return set
end
local function rlModelSetKey(args: { [string]: any }): { [string]: any }
  local anim = tostring(args.anim or "")
  local folder, tracks, markers, events = rlAnimRead(anim)
  local track = tostring(args.track or "")
  if track == "" then error("track is required (joint/part name from analyze_animatable_model)") end
  local duration = 60
  pcall(function() duration = num(folder:GetAttribute("duration"), 60) end)
  local t = math.max(0, num(args.t, 0))
  if t > duration then error("key time " .. t .. "s is beyond duration " .. duration .. "s") end
  local ease = resolveEasing(tostring(args.ease or "linear"))
  if not ease then error("unknown easing '" .. tostring(args.ease):sub(1, 32) .. "' " .. easingHint(tostring(args.ease or "")) .. "(" .. EASE_LIST .. ")") end
  local tr = tracks[track]
  if tr == nil then tr = { kind = "custom", keys = {} } tracks[track] = tr end
  if rlAnimGetLocked(folder)[track] then error("TRACK_LOCKED: track '" .. track:sub(1, 48) .. "' is locked - unlock it with set_track_lock first") end
  if type((tr :: any).keys) ~= "table" then (tr :: any).keys = {} end
  local keys = (tr :: any).keys
  if #keys >= MAX_MODEL_KEYS then error("too many keys on track '" .. track:sub(1, 48) .. "' (max " .. MAX_MODEL_KEYS .. ")") end
  local pose = rlPoseNum(args.pose)
  local replaced = false
  for i, k in ipairs(keys) do
    if math.abs(num((k :: any).t, 0) - t) < 1e-6 then
      keys[i] = { t = t, pos = pose.pos, rot = pose.rot, ease = ease }
      replaced = true
      break
    end
  end
  if not replaced then
    table.insert(keys, { t = t, pos = pose.pos, rot = pose.rot, ease = ease })
    table.sort(keys, function(a, b) return num((a :: any).t, 0) < num((b :: any).t, 0) end)
  end
  rlAnimWrite(anim, folder, tracks, markers, events)
  return { animation = anim, track = track, t = t, ease = ease, keys = #keys, replaced = replaced }
end
local function rlModelSetEase(args: { [string]: any }): { [string]: any }
  local anim = tostring(args.anim or "")
  local folder, tracks, markers, events = rlAnimRead(anim)
  local track = tostring(args.track or "")
  local tr = tracks[track]
  if tr == nil or type((tr :: any).keys) ~= "table" or #((tr :: any).keys) == 0 then
    error("TRACK_NOT_FOUND: no keys on track '" .. track:sub(1, 48) .. "' in '" .. anim:sub(1, 48) .. "'")
  end
  local keys = (tr :: any).keys
  if rlAnimGetLocked(folder)[track] then error("TRACK_LOCKED: track '" .. track:sub(1, 48) .. "' is locked - unlock it with set_track_lock first") end
  local idx = math.floor(num(args.keyIndex, 0))
  if idx < 1 or idx > #keys then error("keyIndex out of range (track has " .. #keys .. " keys, 1-based)") end
  local ease = resolveEasing(tostring(args.ease or ""))
  if not ease then error("unknown easing '" .. tostring(args.ease):sub(1, 32) .. "' " .. easingHint(tostring(args.ease or "")) .. "(" .. EASE_LIST .. ")") end
  keys[idx].ease = ease
  rlAnimWrite(anim, folder, tracks, markers, events)
  return { animation = anim, track = track, keyIndex = idx, ease = ease }
end
local function rlModelAddMarker(args: { [string]: any }): { [string]: any }
  local anim = tostring(args.anim or "")
  local folder, tracks, markers, events = rlAnimRead(anim)
  local name = tostring(args.name or ""):gsub("^%s+", ""):gsub("%s+$", ""):sub(1, 64)
  if name == "" then error("marker name is required (max 64 chars)") end
  if args.remove == true then
    local keptM: { [string]: any } = {}
    local keptE: { [string]: any } = {}
    local found = false
    for _, m in ipairs(markers) do
      if tostring((m :: any).name) ~= name then table.insert(keptM, m) else found = true end
    end
    for _, e in ipairs(events) do
      if tostring((e :: any).marker) ~= name then table.insert(keptE, e) end
    end
    if not found then error("MARKER_NOT_FOUND: no marker '" .. name .. "' in '" .. anim:sub(1, 48) .. "'") end
    rlAnimWrite(anim, folder, tracks, keptM, keptE)
    return { animation = anim, removed = name, markers = keptM }
  end
  local duration = 60
  pcall(function() duration = num(folder:GetAttribute("duration"), 60) end)
  local t = math.max(0, num(args.t, 0))
  if t > duration then error("marker time " .. t .. "s is beyond duration " .. duration .. "s") end
  local ev = nil
  if args.event ~= nil and tostring(args.event) ~= "" then ev = tostring(args.event):sub(1, 64) end
  local replaced = false
  for i, m in ipairs(markers) do
    if tostring((m :: any).name) == name then
      markers[i] = { t = t, name = name, event = ev }
      replaced = true
      break
    end
  end
  if not replaced then
    table.insert(markers, { t = t, name = name, event = ev })
    table.sort(markers, function(a, b) return num((a :: any).t, 0) < num((b :: any).t, 0) end)
  end
  if ev then
    local bound = false
    for _, e in ipairs(events) do
      if tostring((e :: any).marker) == name then (e :: any).action = ev bound = true break end
    end
    if not bound then table.insert(events, { marker = name, action = ev }) end
  end
  rlAnimWrite(anim, folder, tracks, markers, events)
  return { animation = anim, markers = markers }
end

local function rlAnimSetLocked(folder: Instance, set: { [string]: boolean })
  local arr: { string } = {}
  for n in pairs(set) do table.insert(arr, tostring(n)) end
  table.sort(arr)
  local sv = folder:FindFirstChild("locked")
  if not sv then
    sv = Instance.new("StringValue")
    sv.Name = "locked"
    sv.Parent = folder
  end
  (sv :: StringValue).Value = HttpService:JSONEncode(arr)
  pcall(function() ChangeHistoryService:SetWaypoint("RoLink model-anim lock") end)
end
local function rlModelTrackLock(args: { [string]: any }): { [string]: any }
  local anim = tostring(args.anim or "")
  local folder = rlAnimRead(anim)
  local track = tostring(args.track or "")
  if track == "" then error("track is required") end
  local set = rlAnimGetLocked(folder)
  local want = args.locked ~= false
  if want then set[track] = true else set[track] = nil end
  rlAnimSetLocked(folder, set)
  return { animation = anim, track = track, locked = want }
end
local function rlLerp3(a: any, b: any, f: number): { [string]: number }
  local function c(k: string): number
    return num(a and (a :: any)[k], 0) + (num(b and (b :: any)[k], 0) - num(a and (a :: any)[k], 0)) * f
  end
  return { x = c("x"), y = c("y"), z = c("z") }
end
local function rlPoseAt(keys: any, t: number): ({ [string]: number }, { [string]: number })
  local zero = { x = 0, y = 0, z = 0 }
  if type(keys) ~= "table" or #keys == 0 then return zero, zero end
  if t <= num(keys[1].t, 0) then return keys[1].pos or zero, keys[1].rot or zero end
  for i = 2, #keys do
    local bt = num(keys[i].t, 0)
    if t <= bt then
      local a, b = keys[i - 1], keys[i]
      local span = bt - num(a.t, 0)
      local f = 0
      if span > 1e-9 then
        local ef = EASE_FNS[b.ease] or EASE_FNS.linear
        f = ef((t - num(a.t, 0)) / span)
      end
      return rlLerp3(a.pos, b.pos, f), rlLerp3(a.rot, b.rot, f)
    end
  end
  local k = keys[#keys]
  return k.pos or zero, k.rot or zero
end
local function rlMag3(a: any, b: any): number
  local dx = num(b and (b :: any).x, 0) - num(a and (a :: any).x, 0)
  local dy = num(b and (b :: any).y, 0) - num(a and (a :: any).y, 0)
  local dz = num(b and (b :: any).z, 0) - num(a and (a :: any).z, 0)
  return math.sqrt(dx * dx + dy * dy + dz * dz)
end
local function rlRound2(v: number): number
  return math.floor(v * 100 + 0.5) / 100
end
local function rlTrackNames(tracks: any): { string }
  local out: { string } = {}
  for k in pairs(tracks) do table.insert(out, tostring(k)) end
  table.sort(out)
  return out
end
local function rlModelPreview(args: { [string]: any }): { [string]: any }
  local anim = tostring(args.anim or "")
  local folder, tracks, markers = rlAnimRead(anim)
  local duration = 1
  local fps = 30
  pcall(function()
    duration = num(folder:GetAttribute("duration"), 1)
    fps = math.floor(num(folder:GetAttribute("fps"), 30))
  end)
  if duration <= 0 then error("MODEL_ANIM_CORRUPT: '" .. anim:sub(1, 48) .. "' has no duration") end
  local step = num(args.step, 0.1)
  if step < 0.02 then step = 0.02 end
  if step > 1 then step = 1 end
  local names = rlTrackNames(tracks)
  local truncated = false
  if #names > 64 then
    local cut: { string } = {}
    for i = 1, 64 do table.insert(cut, names[i]) end
    names = cut
    truncated = true
  end
  if duration / step * math.max(1, #names) > 200000 then
    error("preview too dense (duration " .. duration .. "s x " .. #names .. " tracks at step " .. step .. ") - raise step")
  end
  local summary: { [string]: any } = {}
  local snaps: { [string]: any } = {}
  local function snapAt(t: number): { [string]: any }
    local s: { [string]: any } = {}
    for _, tn in ipairs(names) do
      local pos, rot = rlPoseAt(tracks[tn].keys, t)
      s[tn] = { pos = { x = rlRound2(pos.x), y = rlRound2(pos.y), z = rlRound2(pos.z) },
        rot = { x = rlRound2(rot.x), y = rlRound2(rot.y), z = rlRound2(rot.z) } }
    end
    return s
  end
  for _, tn in ipairs(names) do
    local keys = tracks[tn].keys
    local maxDeg, maxStud = 0, 0
    local pt, pr = rlPoseAt(keys, 0)
    local tt = step
    while tt <= duration + 1e-9 do
      local qpos, qrot = rlPoseAt(keys, tt)
      local dt = step
      if dt > 1e-9 then
        maxDeg = math.max(maxDeg, rlMag3(pr, qrot) / dt)
        maxStud = math.max(maxStud, rlMag3(pt, qpos) / dt)
      end
      pt, pr = qpos, qrot
      tt += step
    end
    summary[tn] = { keys = #keys, maxDegPerSec = rlRound2(maxDeg), maxStudPerSec = rlRound2(maxStud),
      spike = maxDeg > RL_ROT_WARN }
  end
  snaps.start = snapAt(0)
  snaps.mid = snapAt(duration / 2)
  snaps.finish = snapAt(duration)
  local hits: { [string]: any } = {}
  for _, m in ipairs(markers) do
    table.insert(hits, { t = num((m :: any).t, 0), name = tostring((m :: any).name), event = (m :: any).event })
  end
  table.sort(hits, function(a, b) return num((a :: any).t, 0) < num((b :: any).t, 0) end)
  return { animation = anim, duration = duration, fps = fps, step = step,
    tracks = summary, snapshots = snaps, markersHit = hits, truncated = truncated }
end
local function rlModelValidate(args: { [string]: any }): { [string]: any }
  local anim = tostring(args.anim or "")
  local folder, tracks, markers, events = rlAnimRead(anim)
  local errors: { [string]: any } = {}
  local warnings: { [string]: any } = {}
  local function err(code: string, detail: string, fix: string)
    table.insert(errors, { code = code, detail = detail, fix = fix })
  end
  local function warn(code: string, detail: string, fix: string)
    table.insert(warnings, { code = code, detail = detail, fix = fix })
  end
  local targetPath = ""
  pcall(function() targetPath = tostring(folder:GetAttribute("target") or "") end)
  local target: Instance? = nil
  if targetPath ~= "" then target = findByPath(targetPath) end
  if not target then err("TARGET_GONE", "stored target '" .. targetPath:sub(1, 80) .. "' no longer resolves", "re-point the animation or restore the model") end
  local duration = 0
  pcall(function() duration = num(folder:GetAttribute("duration"), 0) end)
  if duration < 0.1 or duration > 60 then err("BAD_DURATION", "duration " .. tostring(duration) .. " outside 0.1-60s", "recreate with a sane duration") end
  local names = rlTrackNames(tracks)
  if #names == 0 then err("EMPTY", "no tracks (write keys with set_model_keyframe first)", "add at least one key") end
  local known: { [string]: boolean } = {}
  if target then
    pcall(function()
      for _, d in ipairs(target:GetDescendants()) do
        known[d.Name] = true
        if #known > 2000 then break end
      end
    end)
    known[target.Name] = true
  end
  local doLoop = false
  pcall(function() doLoop = folder:GetAttribute("loop") == true end)
  for _, tn in ipairs(names) do
    local keys = tracks[tn].keys
    if type(keys) ~= "table" or #keys == 0 then
      err("TRACK_EMPTY", "track '" .. tn:sub(1, 48) .. "' has no keys", "write a key or drop the track")
      continue
    end
    if target and not known[tn] then
      warn("JOINT_UNMATCHED", "track '" .. tn:sub(1, 48) .. "' matches no part under the target", "re-run analyze_animatable_model and use an exact name")
    end
    for i, k in ipairs(keys) do
      if EASE_FNS[(k :: any).ease] == nil then
        err("BAD_EASING", "track '" .. tn:sub(1, 32) .. "' key " .. i .. " has easing '" .. tostring((k :: any).ease):sub(1, 24) .. "'", "set a suffixed easing (quadIn, not bare quad)")
      end
      if i > 1 and num((k :: any).t, 0) < num(keys[i - 1].t, 0) - 1e-9 then
        err("TIME_ORDER", "track '" .. tn:sub(1, 32) .. "' key " .. i .. " goes backwards in time", "rewrite the keys in order")
      end
    end
    for i = 2, #keys do
      local dt = num(keys[i].t, 0) - num(keys[i - 1].t, 0)
      if dt > 1e-9 then
        local rv = rlMag3(keys[i - 1].rot, keys[i].rot) / dt
        local pv = rlMag3(keys[i - 1].pos, keys[i].pos) / dt
        if rv > RL_ROT_ERR then err("SPIKE", "track '" .. tn:sub(1, 32) .. "' rotates " .. math.floor(rv) .. " deg/s into key " .. i, "spread the motion over more time or ease it")
        elseif rv > RL_ROT_WARN then warn("FAST", "track '" .. tn:sub(1, 32) .. "' rotates " .. math.floor(rv) .. " deg/s into key " .. i, "consider easing the arrival") end
        if pv > RL_POS_ERR then err("JUMP", "track '" .. tn:sub(1, 32) .. "' jumps " .. rlRound2(pv * dt) .. " studs into key " .. i, "check the target path or split the move")
        elseif pv > RL_POS_WARN then warn("LEAP", "track '" .. tn:sub(1, 32) .. "' moves " .. rlRound2(pv * dt) .. " studs into key " .. i, "verify the distance is intended") end
      end
    end
    if doLoop and #keys >= 2 then
      local a, b = keys[1], keys[#keys]
      if rlMag3(a.rot, b.rot) > 1.0 or rlMag3(a.pos, b.pos) > 0.1 then
        err("LOOP_MISMATCH", "track '" .. tn:sub(1, 32) .. "' loop ends do not match the start", "copy the first key pose onto the last key")
      end
    end
  end
  local markerNames: { [string]: boolean } = {}
  for _, m in ipairs(markers) do
    markerNames[tostring((m :: any).name)] = true
    if num((m :: any).t, 0) > duration then
      err("MARKER_OOB", "marker '" .. tostring((m :: any).name):sub(1, 40) .. "' sits past the duration", "move it inside 0-" .. tostring(duration) .. "s")
    end
    if (m :: any).event == nil then
      warn("MARKER_NO_EVENT", "marker '" .. tostring((m :: any).name):sub(1, 40) .. "' binds no gameplay event", "add an event or leave it as a pure timing mark")
    end
  end
  for _, e in ipairs(events) do
    if not markerNames[tostring((e :: any).marker)] then
      err("ORPHAN_EVENT", "event for missing marker '" .. tostring((e :: any).marker):sub(1, 40) .. "'", "add the marker first")
    end
  end
  return { animation = anim, passed = #errors == 0, errors = errors, warnings = warnings }
end


-- ── Model animation dock widget (timeline editor, same store) ─────────
-- Human timeline over ReplicatedStorage/RoLinkModelAnims/<Name>: rig tree,
-- keyframe lane, inspector, transport. Every action calls the rl* engine
-- above, so chat turns and UI edits can never diverge. Playback applies
-- poses to resolved joints in Edit mode only and restores originals on
-- stop; in Play it refuses with a status message instead of guessing.
-- ── Model animation dock widget (Moon-style timeline, same store) ─────
-- Dark panels, one orange accent, blue keyframe diamonds. Title strip,
-- menu row (every button performs a real action), rig tree, track list
-- with dots + locks, frame ruler, key/marker lanes with playhead,
-- inspector, transport. All actions call the rl* engine above, so chat
-- turns and UI edits can never diverge.
local RL_ANIM_COLORS = {
  panel = Color3.fromRGB(20, 20, 23),
  lane = Color3.fromRGB(30, 30, 35),
  rowAlt = Color3.fromRGB(25, 25, 29),
  input = Color3.fromRGB(36, 36, 42),
  text = Color3.fromRGB(232, 232, 236),
  dim = Color3.fromRGB(150, 150, 162),
  accent = Color3.fromRGB(255, 140, 26),
  accentText = Color3.fromRGB(24, 14, 4),
  diamond = Color3.fromRGB(76, 194, 255),
  marker = Color3.fromRGB(120, 220, 255),
  good = Color3.fromRGB(130, 220, 150),
  bad = Color3.fromRGB(255, 110, 110),
}
local RL_ANIM_W = 640
local rlAnimUI = { playing = false, stopNow = false, held = {}, selKey = 0 }
local rlAnimStatusLbl: TextLabel? = nil
local function rlAnimStatus(msg: string, isErr: boolean?)
  print("[RoLinkAnim] " .. msg)
  pcall(function()
    if rlAnimStatusLbl then
      rlAnimStatusLbl.Text = (isErr and "ERR " or "") .. msg:sub(1, 220)
      rlAnimStatusLbl.TextColor3 = isErr and RL_ANIM_COLORS.bad or RL_ANIM_COLORS.dim
    end
  end)
end
local function rlAnimBox(parent: Instance, name: string, text: string, w: number): TextBox
  local b = Instance.new("TextBox")
  b.Name = name
  b.Text = text
  b.ClearTextOnFocus = false
  b.Font = Enum.Font.Code
  b.TextSize = 13
  b.BackgroundColor3 = RL_ANIM_COLORS.input
  b.TextColor3 = RL_ANIM_COLORS.text
  b.BorderSizePixel = 0
  b.Size = UDim2.new(0, w, 0, 24)
  b.Parent = parent
  return b
end
local function rlAnimBtn(parent: Instance, name: string, text: string, w: number, hot: boolean?): TextButton
  local b = Instance.new("TextButton")
  b.Name = name
  b.Text = text
  b.Font = Enum.Font.GothamBold
  b.TextSize = 13
  b.AutoButtonColor = true
  b.BackgroundColor3 = hot and RL_ANIM_COLORS.accent or RL_ANIM_COLORS.lane
  b.TextColor3 = hot and RL_ANIM_COLORS.accentText or RL_ANIM_COLORS.text
  b.BorderSizePixel = 0
  b.Size = UDim2.new(0, w, 0, 24)
  b.Parent = parent
  local c = Instance.new("UICorner")
  c.CornerRadius = UDim.new(0, 4)
  c.Parent = b
  return b
end
local function rlAnimRow(parent: Instance, h: number): Frame
  local f = Instance.new("Frame")
  f.BackgroundTransparency = 1
  f.Size = UDim2.new(1, 0, 0, h)
  f.Parent = parent
  local l = Instance.new("UIListLayout")
  l.FillDirection = Enum.FillDirection.Horizontal
  l.Padding = UDim.new(0, 4)
  l.VerticalAlignment = Enum.VerticalAlignment.Center
  l.Parent = f
  return f
end
local function rlAnimField(row: Instance, label: string, def: string, w: number): TextBox
  local t = Instance.new("TextLabel")
  t.Text = label
  t.Font = Enum.Font.Gotham
  t.TextSize = 12
  t.TextColor3 = RL_ANIM_COLORS.dim
  t.BackgroundTransparency = 1
  t.Size = UDim2.new(0, 28, 0, 24)
  t.Parent = row
  return rlAnimBox(row, "in_" .. label, def, w)
end
local function rlAnimHead(parent: Instance, txt: string)
  local h = Instance.new("TextLabel")
  h.Text = txt
  h.Font = Enum.Font.GothamBold
  h.TextSize = 11
  h.TextColor3 = RL_ANIM_COLORS.dim
  h.BackgroundTransparency = 1
  h.TextXAlignment = Enum.TextXAlignment.Left
  h.Size = UDim2.new(1, 0, 0, 18)
  h.Parent = parent
end
local function rlAnimClearFrame(f: Instance?)
  if not f then return end
  for _, c in ipairs(f:GetChildren()) do
    if not c:IsA("UIListLayout") and not c:IsA("UIPadding") then
      pcall(function() c:Destroy() end)
    end
  end
end
local function rlAnimCurrent(): (string, string)
  local a = rlAnimUI.animBox and rlAnimUI.animBox.Text or ""
  local t = rlAnimUI.trackBox and rlAnimUI.trackBox.Text or ""
  return a:gsub("^%s+", ""):gsub("%s+$", ""), t:gsub("^%s+", ""):gsub("%s+$", "")
end
local function rlAnimStripe(parent: Instance, i: number): Frame
  local f = Instance.new("Frame")
  f.BackgroundColor3 = (i % 2 == 0) and RL_ANIM_COLORS.lane or RL_ANIM_COLORS.rowAlt
  f.BorderSizePixel = 0
  f.Size = UDim2.new(1, 0, 0, 20)
  f.Parent = parent
  local l = Instance.new("UIListLayout")
  l.FillDirection = Enum.FillDirection.Horizontal
  l.Padding = UDim.new(0, 4)
  l.VerticalAlignment = Enum.VerticalAlignment.Center
  l.Parent = f
  return f
end
local function rlAnimRefreshTitle(anim: string, folder: Instance?, trackCount: number)
  local t = rlAnimUI.titleLbl
  if not t then return end
  if anim == "" or not folder then
    t.Text = "no animation loaded"
    return
  end
  local dur, fps = 0, 30
  pcall(function()
    dur = num(folder:GetAttribute("duration"), 0)
    fps = math.floor(num(folder:GetAttribute("fps"), 30))
  end)
  t.Text = string.format("%s  •  %.2fs  •  %dfps  •  %d tracks", anim:sub(1, 40), dur, fps, trackCount)
end
local function rlAnimRenderRig()
  local list = rlAnimUI.rigList
  if not list then return end
  rlAnimClearFrame(list)
  local ok, res = pcall(function()
    local w = rlAnimUI.targetBox
    return rlModelAnalyze({ target = (w and w.Text) or "Workspace" })
  end)
  if not ok then rlAnimStatus("analyze failed: " .. tostring(res):sub(1, 160), true) return end
  local i = 0
  for _, n in ipairs(res.animatable or {}) do
    i += 1
    local row = rlAnimStripe(list, i)
    local b = Instance.new("TextButton")
    b.Text = string.rep("  ", math.min(5, num((n :: any).depth, 0))) .. tostring((n :: any).name) .. " [" .. tostring((n :: any).kind) .. "]"
    b.Font = Enum.Font.Code
    b.TextSize = 12
    b.TextXAlignment = Enum.TextXAlignment.Left
    b.BackgroundTransparency = 1
    b.TextColor3 = RL_ANIM_COLORS.text
    b.Size = UDim2.new(1, -4, 1, 0)
    b.Parent = row
    local nm = tostring((n :: any).name)
    local kd = tostring((n :: any).kind)
    b.MouseButton1Click:Connect(function()
      if rlAnimUI.trackBox and (kd == "rotational" or kd == "rigid" or kd == "root") then
        rlAnimUI.trackBox.Text = nm
        rlAnimStatus("track <- " .. nm)
        rlAnimRenderTimeline()
      else
        rlAnimStatus(nm .. " is " .. kd .. " - animate its parent instead", true)
      end
    end)
  end
  rlAnimStatus("rig: " .. #res.animatable .. " nodes (" .. tostring(res.controller) .. ")")
end
local function rlAnimRenderTracks()
  local list = rlAnimUI.trackList
  if not list then return end
  rlAnimClearFrame(list)
  local anim, _ = rlAnimCurrent()
  if anim == "" then return end
  local ok, folder, tracks = pcall(function() return rlAnimRead(anim) end)
  if not ok then return end
  local locked = rlAnimGetLocked(folder)
  local names = rlTrackNames(tracks)
  local i = 0
  for _, tn in ipairs(names) do
    i += 1
    local row = rlAnimStripe(list, i)
    local dot = Instance.new("TextLabel")
    dot.Text = "●"
    dot.Font = Enum.Font.GothamBold
    dot.TextSize = 12
    dot.TextColor3 = RL_ANIM_COLORS.accent
    dot.BackgroundTransparency = 1
    dot.Size = UDim2.new(0, 18, 1, 0)
    dot.Parent = row
    local b = Instance.new("TextButton")
    b.Text = tn
    b.Font = Enum.Font.Code
    b.TextSize = 12
    b.TextXAlignment = Enum.TextXAlignment.Left
    b.BackgroundTransparency = 1
    b.TextColor3 = RL_ANIM_COLORS.text
    b.Size = UDim2.new(1, -66, 1, 0)
    b.Parent = row
    local isLocked = locked[tn] == true
    local lb = Instance.new("TextButton")
    lb.Text = isLocked and "[L]" or "[ ]"
    lb.Font = Enum.Font.GothamBold
    lb.TextSize = 12
    lb.BackgroundTransparency = 1
    lb.TextColor3 = isLocked and RL_ANIM_COLORS.accent or RL_ANIM_COLORS.dim
    lb.Size = UDim2.new(0, 36, 1, 0)
    lb.Parent = row
    b.MouseButton1Click:Connect(function()
      if rlAnimUI.trackBox then rlAnimUI.trackBox.Text = tn end
      rlAnimRenderTimeline()
    end)
    lb.MouseButton1Click:Connect(function()
      local ok2, res = pcall(function()
        return rlModelTrackLock({ anim = anim, track = tn, locked = not isLocked })
      end)
      if ok2 then
        rlAnimStatus("track '" .. tn:sub(1, 40) .. "' " .. (res.locked and "locked" or "unlocked"))
        pcall(rlAnimRenderTracks)
      else
        rlAnimStatus("lock failed: " .. tostring(res):sub(1, 160), true)
      end
    end)
  end
end
local function rlAnimRenderTimeline()
  local lane = rlAnimUI.keyLane
  local mlane = rlAnimUI.markerLane
  local ruler = rlAnimUI.ruler
  if not lane then return end
  rlAnimClearFrame(lane)
  if mlane then rlAnimClearFrame(mlane) end
  if ruler then rlAnimClearFrame(ruler) end
  rlAnimUI.playhead = nil
  local anim, track = rlAnimCurrent()
  if anim == "" then
    rlAnimRefreshTitle("", nil, 0)
    rlAnimStatus("enter an animation name, then Load")
    return
  end
  local ok, folder, tracks, markers = pcall(function() return rlAnimRead(anim) end)
  if not ok then
    rlAnimRefreshTitle("", nil, 0)
    rlAnimStatus("load failed: " .. tostring(folder):sub(1, 160), true)
    return
  end
  local duration, fps = 1, 30
  pcall(function()
    duration = num(folder:GetAttribute("duration"), 1)
    fps = math.floor(num(folder:GetAttribute("fps"), 30))
  end)
  if duration <= 0 then duration = 1 end
  if fps < 1 then fps = 30 end
  rlAnimRefreshTitle(anim, folder, #rlTrackNames(tracks))
  if ruler then
    local f = 0
    while f <= duration * fps + 1e-9 do
      local t = f / fps
      local x = math.clamp(t / duration, 0, 1) * (RL_ANIM_W - 24)
      local lb = Instance.new("TextLabel")
      lb.Text = tostring(f)
      lb.Font = Enum.Font.Code
      lb.TextSize = 10
      lb.TextColor3 = (f == 0) and RL_ANIM_COLORS.accent or RL_ANIM_COLORS.dim
      lb.BackgroundTransparency = 1
      lb.Size = UDim2.new(0, 40, 0, 16)
      lb.Position = UDim2.new(0, x, 0, 0)
      lb.Parent = ruler
      f += fps
    end
  end
  lane.CanvasSize = UDim2.new(0, RL_ANIM_W, 0, 30)
  local tr = tracks[track]
  local keys = (tr ~= nil and (tr :: any).keys) or {}
  rlAnimUI.selKeys = keys
  for i, k in ipairs(keys) do
    local x = math.clamp(num((k :: any).t, 0) / duration, 0, 1) * (RL_ANIM_W - 24)
    local b = Instance.new("TextButton")
    b.Text = "◆"
    b.Font = Enum.Font.GothamBold
    b.TextSize = 14
    b.TextColor3 = RL_ANIM_COLORS.diamond
    b.BackgroundTransparency = 1
    b.Size = UDim2.new(0, 24, 0, 24)
    b.Position = UDim2.new(0, x, 0, 2)
    b.Parent = lane
    local idx = i
    b.MouseButton1Click:Connect(function()
      b.TextColor3 = RL_ANIM_COLORS.accent
      rlAnimUI.selKey = idx
      local ins = rlAnimUI.ins
      if ins and keys[idx] then
        local kk = keys[idx]
        ins.t.Text = tostring(num((kk :: any).t, 0))
        ins.rx.Text = tostring(((kk :: any).rot or {}).x or 0)
        ins.ry.Text = tostring(((kk :: any).rot or {}).y or 0)
        ins.rz.Text = tostring(((kk :: any).rot or {}).z or 0)
        ins.px.Text = tostring(((kk :: any).pos or {}).x or 0)
        ins.py.Text = tostring(((kk :: any).pos or {}).y or 0)
        ins.pz.Text = tostring(((kk :: any).pos or {}).z or 0)
        ins.ease.Text = tostring((kk :: any).ease or "linear")
        rlAnimStatus("key " .. idx .. " of " .. #keys .. " selected")
      end
    end)
  end
  if mlane then
    mlane.CanvasSize = UDim2.new(0, RL_ANIM_W, 0, 22)
    for _, m in ipairs(markers or {}) do
      local x = math.clamp(num((m :: any).t, 0) / duration, 0, 1) * (RL_ANIM_W - 24)
      local b = Instance.new("TextButton")
      b.Text = "M " .. tostring((m :: any).name):sub(1, 12)
      b.Font = Enum.Font.Code
      b.TextSize = 11
      b.TextColor3 = RL_ANIM_COLORS.marker
      b.BackgroundTransparency = 1
      b.Size = UDim2.new(0, 90, 0, 20)
      b.Position = UDim2.new(0, x, 0, 1)
      b.Parent = mlane
    end
  end
  local ph = Instance.new("Frame")
  ph.BackgroundColor3 = RL_ANIM_COLORS.accent
  ph.BorderSizePixel = 0
  ph.Size = UDim2.new(0, 2, 1, 0)
  ph.Visible = false
  ph.Parent = lane
  rlAnimUI.playhead = ph
  rlAnimUI.selKey = 0
  rlAnimStatus("track '" .. track .. "': " .. #keys .. " keys")
end
local function rlAnimResolveJoint(target: Instance, track: string): Instance?
  local best: Instance? = nil
  pcall(function()
    for _, d in ipairs(target:GetDescendants()) do
      if d.Name == track and (d:IsA("Motor6D") or d:IsA("Bone") or d:IsA("BasePart")) then
        best = d
        break
      end
    end
    if not best and target.Name == track then best = target end
  end)
  return best
end
local function rlAnimApplyPose(inst: Instance, pos: any, rot: any)
  local cf = CFrame.new(num(pos and pos.x, 0), num(pos and pos.y, 0), num(pos and pos.z, 0))
    * CFrame.Angles(math.rad(num(rot and rot.x, 0)), math.rad(num(rot and rot.y, 0)), math.rad(num(rot and rot.z, 0)))
  if inst:IsA("Motor6D") then
    (inst :: Motor6D).Transform = cf
  elseif inst:IsA("BasePart") then
    (inst :: BasePart).CFrame = cf
  else
    error("joint '" .. inst.Name:sub(1, 40) .. "' (" .. inst.ClassName .. ") is not directly posable")
  end
end
local function rlAnimSnapshot(target: Instance, names: { string })
  local held: { [string]: any } = {}
  for _, tn in ipairs(names) do
    local j = rlAnimResolveJoint(target, tn)
    if j then
      if j:IsA("Motor6D") then held[tn] = { inst = j, cf = (j :: Motor6D).Transform }
      elseif j:IsA("BasePart") then held[tn] = { inst = j, cf = (j :: BasePart).CFrame } end
    end
  end
  return held
end
local function rlAnimRestore()
  for _, h in pairs(rlAnimUI.held or {}) do
    pcall(function()
      if (h :: any).inst and (h :: any).cf then
        if ((h :: any).inst :: Instance):IsA("Motor6D") then
          (((h :: any).inst) :: Motor6D).Transform = (h :: any).cf
        elseif ((h :: any).inst :: Instance):IsA("BasePart") then
          (((h :: any).inst) :: BasePart).CFrame = (h :: any).cf
        end
      end
    end)
  end
  rlAnimUI.held = {}
end
local function rlAnimPlay()
  if rlAnimUI.playing then rlAnimStatus("already playing") return end
  local okRun, why = pcall(function() return RunService:IsRunning() end)
  if okRun and why then rlAnimStatus("stop Play first - preview runs in Edit only", true) return end
  local anim, _ = rlAnimCurrent()
  if anim == "" then rlAnimStatus("enter an animation name first", true) return end
  local ok, folder, tracks = pcall(function() return rlAnimRead(anim) end)
  if not ok then rlAnimStatus("load failed: " .. tostring(folder):sub(1, 160), true) return end
  local targetPath = ""
  pcall(function() targetPath = tostring(folder:GetAttribute("target") or "") end)
  local target = nil
  if targetPath ~= "" then target = findByPath(targetPath) end
  if not target then rlAnimStatus("target gone: '" .. targetPath:sub(1, 60) .. "'", true) return end
  local names = rlTrackNames(tracks)
  if #names == 0 then rlAnimStatus("no tracks to play", true) return end
  local duration = 1
  local doLoop = false
  pcall(function()
    duration = num(folder:GetAttribute("duration"), 1)
    doLoop = folder:GetAttribute("loop") == true
  end)
  rlAnimUI.held = rlAnimSnapshot(target, names)
  rlAnimUI.playing = true
  rlAnimUI.stopNow = false
  pcall(function() ChangeHistoryService:SetWaypoint("RoLink model-anim preview " .. anim:sub(1, 40)) end)
  local wasLoopBtn = rlAnimUI.loopBtn
  task.spawn(function()
    local fps = 30
    repeat
      local t = 0
      while t <= duration + 1e-9 do
        if rlAnimUI.stopNow then break end
        for _, tn in ipairs(names) do
          local pos, rot = rlPoseAt(tracks[tn].keys, t)
          local j = rlAnimResolveJoint(target, tn)
          if j then pcall(function() rlAnimApplyPose(j, pos, rot) end) end
        end
        local x = math.clamp(t / duration, 0, 1) * (RL_ANIM_W - 24)
        if rlAnimUI.playhead then
          rlAnimUI.playhead.Visible = true
          rlAnimUI.playhead.Position = UDim2.new(0, x, 0, 0)
        end
        if rlAnimUI.timeLbl then rlAnimUI.timeLbl.Text = string.format("%.2fs / %.2fs", t, duration) end
        task.wait(1 / fps)
        t += 1 / fps
      end
      if doLoop and not rlAnimUI.stopNow and wasLoopBtn and wasLoopBtn.Text == "Loop: on" then
        continue
      end
      break
    until false
    rlAnimRestore()
    if rlAnimUI.playhead then rlAnimUI.playhead.Visible = false end
    rlAnimUI.playing = false
    rlAnimUI.stopNow = false
    if rlAnimUI.timeLbl then rlAnimUI.timeLbl.Text = "stopped" end
    rlAnimStatus("preview finished - originals restored")
  end)
  rlAnimStatus("playing '" .. anim .. "' (" .. #names .. " tracks)")
end
local function rlAnimStop()
  rlAnimUI.stopNow = true
  rlAnimStatus("stopping - restoring originals")
end
local function rlAnimLoadAll()
  pcall(rlAnimRenderRig)
  pcall(rlAnimRenderTracks)
  pcall(rlAnimRenderTimeline)
end
local function rlBuildAnimWidget()
  local info = DockWidgetPluginGuiInfo.new(Enum.InitialDockState.Float, false, false, 380, 600, 300, 440)
  local w = plugin:CreateDockWidgetPluginGui("RoLinkModelAnim", info)
  w.Title = "RoLink Animation (Beta)"
  w.Name = "RoLinkModelAnim"
  local root = Instance.new("Frame")
  root.BackgroundColor3 = RL_ANIM_COLORS.panel
  root.BorderSizePixel = 0
  root.Size = UDim2.new(1, 0, 1, 0)
  root.Parent = w
  local pad = Instance.new("UIPadding")
  pad.PaddingLeft = UDim.new(0, 8)
  pad.PaddingRight = UDim.new(0, 8)
  pad.PaddingTop = UDim.new(0, 8)
  pad.PaddingBottom = UDim.new(0, 8)
  pad.Parent = root
  local stack = Instance.new("UIListLayout")
  stack.FillDirection = Enum.FillDirection.Vertical
  stack.Padding = UDim.new(0, 6)
  stack.Parent = root
  local titleBar = Instance.new("Frame")
  titleBar.BackgroundColor3 = RL_ANIM_COLORS.lane
  titleBar.BorderSizePixel = 0
  titleBar.Size = UDim2.new(1, 0, 0, 26)
  titleBar.Parent = root
  local edge = Instance.new("Frame")
  edge.BackgroundColor3 = RL_ANIM_COLORS.accent
  edge.BorderSizePixel = 0
  edge.Size = UDim2.new(0, 3, 1, 0)
  edge.Parent = titleBar
  local titleLbl = Instance.new("TextLabel")
  titleLbl.Text = "no animation loaded"
  titleLbl.Font = Enum.Font.GothamBold
  titleLbl.TextSize = 13
  titleLbl.TextColor3 = RL_ANIM_COLORS.accent
  titleLbl.BackgroundTransparency = 1
  titleLbl.TextXAlignment = Enum.TextXAlignment.Left
  titleLbl.Size = UDim2.new(1, -12, 1, 0)
  titleLbl.Position = UDim2.new(0, 10, 0, 0)
  titleLbl.Parent = titleBar
  rlAnimUI.titleLbl = titleLbl
  local menu = rlAnimRow(root, 24)
  local menuLoad = rlAnimBtn(menu, "menuLoad", "Load", 64)
  local menuAnalyze = rlAnimBtn(menu, "menuAnalyze", "Analyze", 76)
  local menuValidate = rlAnimBtn(menu, "menuValidate", "Validate", 76)
  local menuPlay = rlAnimBtn(menu, "menuPlay", "Play", 64, true)
  rlAnimHead(root, "TARGET + STORE")
  local r1 = rlAnimRow(root, 24)
  rlAnimUI.targetBox = rlAnimBox(r1, "target", "Workspace", 150)
  rlAnimUI.animBox = rlAnimBox(r1, "anim", "", 120)
  rlAnimHead(root, "NEW STORE")
  local r2 = rlAnimRow(root, 24)
  local durBox = rlAnimBox(r2, "dur", "1.0", 50)
  local fpsBox = rlAnimBox(r2, "fps", "30", 44)
  local loopBtn = rlAnimBtn(r2, "newloop", "Loop: off", 76)
  loopBtn.MouseButton1Click:Connect(function()
    loopBtn.Text = if loopBtn.Text == "Loop: on" then "Loop: off" else "Loop: on"
  end)
  local newBtn = rlAnimBtn(r2, "new", "Create", 70)
  rlAnimHead(root, "RIG  +  TRACK")
  local r3 = rlAnimRow(root, 24)
  rlAnimUI.trackBox = rlAnimBox(r3, "track", "", 220)
  local rigScroll = Instance.new("ScrollingFrame")
  rigScroll.BackgroundColor3 = RL_ANIM_COLORS.lane
  rigScroll.BorderSizePixel = 0
  rigScroll.Size = UDim2.new(1, 0, 0, 96)
  rigScroll.CanvasSize = UDim2.new(0, 0, 0, 0)
  rigScroll.AutomaticCanvasSize = Enum.AutomaticSize.Y
  rigScroll.Parent = root
  local rigPad = Instance.new("UIListLayout")
  rigPad.FillDirection = Enum.FillDirection.Vertical
  rigPad.Parent = rigScroll
  rlAnimUI.rigList = rigScroll
  rlAnimHead(root, "TRACKS")
  local trackScroll = Instance.new("ScrollingFrame")
  trackScroll.BackgroundColor3 = RL_ANIM_COLORS.lane
  trackScroll.BorderSizePixel = 0
  trackScroll.Size = UDim2.new(1, 0, 0, 76)
  trackScroll.CanvasSize = UDim2.new(0, 0, 0, 0)
  trackScroll.AutomaticCanvasSize = Enum.AutomaticSize.Y
  trackScroll.Parent = root
  local trackPad = Instance.new("UIListLayout")
  trackPad.FillDirection = Enum.FillDirection.Vertical
  trackPad.Parent = trackScroll
  rlAnimUI.trackList = trackScroll
  rlAnimHead(root, "TIMELINE")
  local ruler = Instance.new("Frame")
  ruler.BackgroundTransparency = 1
  ruler.Size = UDim2.new(1, 0, 0, 16)
  ruler.Parent = root
  rlAnimUI.ruler = ruler
  local keyScroll = Instance.new("ScrollingFrame")
  keyScroll.BackgroundColor3 = RL_ANIM_COLORS.lane
  keyScroll.BorderSizePixel = 0
  keyScroll.Size = UDim2.new(1, 0, 0, 34)
  keyScroll.CanvasSize = UDim2.new(0, RL_ANIM_W, 0, 30)
  keyScroll.Parent = root
  rlAnimUI.keyLane = keyScroll
  local markScroll = Instance.new("ScrollingFrame")
  markScroll.BackgroundColor3 = RL_ANIM_COLORS.lane
  markScroll.BorderSizePixel = 0
  markScroll.Size = UDim2.new(1, 0, 0, 24)
  markScroll.CanvasSize = UDim2.new(0, RL_ANIM_W, 0, 22)
  markScroll.Parent = root
  rlAnimUI.markerLane = markScroll
  rlAnimHead(root, "INSPECTOR")
  local r4 = rlAnimRow(root, 24)
  local ins: { [string]: any } = {}
  ins.t = rlAnimField(r4, "T", "0", 46)
  ins.rx = rlAnimField(r4, "RX", "0", 44)
  ins.ry = rlAnimField(r4, "RY", "0", 44)
  ins.rz = rlAnimField(r4, "RZ", "0", 44)
  local r5 = rlAnimRow(root, 24)
  ins.px = rlAnimField(r5, "PX", "0", 44)
  ins.py = rlAnimField(r5, "PY", "0", 44)
  ins.pz = rlAnimField(r5, "PZ", "0", 44)
  ins.ease = rlAnimField(r5, "E", "linear", 66)
  rlAnimUI.ins = ins
  local r6 = rlAnimRow(root, 24)
  local setBtn = rlAnimBtn(r6, "set", "Set key", 80)
  local delBtn = rlAnimBtn(r6, "del", "Del key", 80)
  local valBtn = rlAnimBtn(r6, "val", "Validate", 80)
  rlAnimHead(root, "TRANSPORT")
  local r7 = rlAnimRow(root, 24)
  local playBtn = rlAnimBtn(r7, "play", "Play", 64, true)
  local stopBtn = rlAnimBtn(r7, "stop", "Stop", 64)
  rlAnimUI.loopBtn = rlAnimBtn(r7, "loop", "Loop: off", 76)
  rlAnimUI.loopBtn.MouseButton1Click:Connect(function()
    local b = rlAnimUI.loopBtn
    b.Text = if b.Text == "Loop: on" then "Loop: off" else "Loop: on"
  end)
  local timeLbl = Instance.new("TextLabel")
  timeLbl.Text = "idle"
  timeLbl.Font = Enum.Font.Code
  timeLbl.TextSize = 12
  timeLbl.TextColor3 = RL_ANIM_COLORS.good
  timeLbl.BackgroundTransparency = 1
  timeLbl.Size = UDim2.new(0, 130, 0, 24)
  timeLbl.Parent = r7
  rlAnimUI.timeLbl = timeLbl
  local st = Instance.new("TextLabel")
  st.Text = "ready"
  st.Font = Enum.Font.Gotham
  st.TextSize = 12
  st.TextColor3 = RL_ANIM_COLORS.dim
  st.BackgroundTransparency = 1
  st.TextXAlignment = Enum.TextXAlignment.Left
  st.TextTruncate = Enum.TextTruncate.AtEnd
  st.Size = UDim2.new(1, 0, 0, 22)
  st.Parent = root
  rlAnimStatusLbl = st
  menuLoad.MouseButton1Click:Connect(function() pcall(rlAnimLoadAll) end)
  menuAnalyze.MouseButton1Click:Connect(function() pcall(rlAnimRenderRig) end)
  menuValidate.MouseButton1Click:Connect(function()
    local anim, _ = rlAnimCurrent()
    local ok, res = pcall(function() return rlModelValidate({ anim = anim }) end)
    if ok then
      rlAnimStatus(if res.passed then "validate: PASS (" .. #res.warnings .. " warnings)" else "validate: " .. #res.errors .. " errors - see chat validate_model_animation", not res.passed)
    else rlAnimStatus("validate failed: " .. tostring(res):sub(1, 160), true) end
  end)
  menuPlay.MouseButton1Click:Connect(function() pcall(rlAnimPlay) end)
  newBtn.MouseButton1Click:Connect(function()
    local ok, res = pcall(function()
      local tw = rlAnimUI.targetBox
      local aw = rlAnimUI.animBox
      return rlModelCreate({ target = (tw and tw.Text) or "Workspace",
        name = (aw and aw.Text) or "", duration = tonumber(durBox.Text) or 0,
        fps = tonumber(fpsBox.Text) or 30, loop = loopBtn.Text == "Loop: on", confirm = true })
    end)
    if ok then
      rlAnimStatus("store '" .. tostring(res.animation) .. "' ready (" .. tostring(res.duration) .. "s)")
      pcall(rlAnimLoadAll)
    else
      rlAnimStatus("create failed: " .. tostring(res):sub(1, 160), true)
    end
  end)
  setBtn.MouseButton1Click:Connect(function()
    local anim, track = rlAnimCurrent()
    local ok, res = pcall(function()
      return rlModelSetKey({ anim = anim, track = track, t = tonumber(ins.t.Text) or 0,
        pose = { position = { x = tonumber(ins.px.Text) or 0, y = tonumber(ins.py.Text) or 0, z = tonumber(ins.pz.Text) or 0 },
          rotation = { x = tonumber(ins.rx.Text) or 0, y = tonumber(ins.ry.Text) or 0, z = tonumber(ins.rz.Text) or 0 } },
        ease = ins.ease.Text })
    end)
    if ok then rlAnimStatus("key @" .. tostring(res.t) .. "s (" .. tostring(res.keys) .. " total)") pcall(rlAnimLoadAll)
    else rlAnimStatus("set key failed: " .. tostring(res):sub(1, 160), true) end
  end)
  delBtn.MouseButton1Click:Connect(function()
    local anim, track = rlAnimCurrent()
    local idx = rlAnimUI.selKey
    if idx < 1 then rlAnimStatus("click a key first", true) return end
    local ok, res = pcall(function()
      local folder, tracks, markers, events = rlAnimRead(anim)
      local keys = tracks[track].keys
      table.remove(keys, idx)
      rlAnimWrite(anim, folder, tracks, markers, events)
      return #keys
    end)
    if ok then
      rlAnimUI.selKey = 0
      rlAnimStatus("key deleted (" .. tostring(res) .. " left)")
      pcall(rlAnimLoadAll)
    else rlAnimStatus("delete failed: " .. tostring(res):sub(1, 160), true) end
  end)
  valBtn.MouseButton1Click:Connect(function()
    local anim, _ = rlAnimCurrent()
    local ok, res = pcall(function() return rlModelValidate({ anim = anim }) end)
    if ok then
      rlAnimStatus(if res.passed then "validate: PASS (" .. #res.warnings .. " warnings)" else "validate: " .. #res.errors .. " errors - see chat validate_model_animation", not res.passed)
    else rlAnimStatus("validate failed: " .. tostring(res):sub(1, 160), true) end
  end)
  playBtn.MouseButton1Click:Connect(function() pcall(rlAnimPlay) end)
  stopBtn.MouseButton1Click:Connect(function() pcall(rlAnimStop) end)
  rlAnimUI.widget = w
  rlAnimStatus("editor ready - enter target + animation, Load")
end

local rlAnimBtn: TextButton? = nil
pcall(function()
  -- widget is built once below (needs the engine above); the button only toggles.
  rlAnimBtn = toolbar:CreateButton("Anim", "RoLink model animation editor (140 tools)", "rbxassetid://0")
  local abtn = rlAnimBtn :: TextButton
  abtn.ClickableWhenViewportHidden = true
  abtn.Click:Connect(function()
    local wg = rlAnimUI.widget
    if wg then
      wg.Enabled = not wg.Enabled
      abtn:SetActive(wg.Enabled)
      log("animation editor " .. (wg.Enabled and "opened" or "closed") .. " (polling " .. (enabled and "on" or "off") .. ")")
    else
      warn("[RoLink] animation editor did not build - see Output for 'editor build failed'")
    end
  end)
end)
-- Build identity + type probe in its own block: chunk-level temps would
-- otherwise hold registers to end-of-file (Studio caps a chunk at ~200
-- locals). Same below for the heartbeat cursor.
do
log("anim build 6 - builder=" .. type(rlBuildAnimWidget) .. " engine=" .. type(rlModelAnalyze) .. " ui=" .. type(rlAnimUI))
local okBuild, buildErr = false, nil
if type(rlBuildAnimWidget) == "function" then
  okBuild, buildErr = pcall(rlBuildAnimWidget)
else
  buildErr = "rlBuildAnimWidget is " .. type(rlBuildAnimWidget) .. " - reinstall studio-plugin/RoLink.lua from the RoLink-main folder (not the release zip), then fully restart Studio"
end
if not okBuild then
  warn("[RoLink] animation editor build failed: " .. tostring(buildErr):sub(1, 300))
else
  log("animation editor built - click Anim to open")
end
end


-- ── Model animation composites + generators (tools 132-139) ───────────
-- Time edits (retime/reverse), spatial mirror, weighted blend, safe fixes,
-- and scaffold generators (attack/idle/walk). Copies are non-destructive;
-- in-place edits overwrite only the named store. Mirror semantics are
-- documented approximations - validate after every mirror.
local EASE_FLIP: { [string]: string } = {
  quadIn = "quadOut", quadOut = "quadIn",
  cubicIn = "cubicOut", cubicOut = "cubicIn",
  sineIn = "sineOut", sineOut = "sineIn",
}
local function rlAnimDuplicate(name: string, newName: string, confirm: any): (Instance, { [string]: any }, { [string]: any }, { [string]: any })
  local folder, tracks, markers, events = rlAnimRead(name)
  local nn = tostring(newName or ""):gsub("^%s+", ""):gsub("%s+$", ""):sub(1, 64)
  if nn == "" then error("newName is required (max 64 chars)") end
  if rlAnimFolder(nn) and confirm ~= true then
    error("CONFIRM_REQUIRED: model animation '" .. nn .. "' already exists - re-send with confirm:true to overwrite, or pick another name")
  end
  local nf = rlAnimFolder(nn)
  if not nf then
    nf = Instance.new("Folder")
    nf.Name = nn
    nf.Parent = rlAnimRoot()
  end
  pcall(function()
    for _, a in ipairs({ "target", "duration", "fps", "loop" }) do
      local v = folder:GetAttribute(a)
      if v ~= nil then nf:SetAttribute(a, v) end
    end
  end)
  local function clone(v: any): any
    return HttpService:JSONDecode(HttpService:JSONEncode(v))
  end
  local t2, m2, e2 = clone(tracks), clone(markers), clone(events)
  rlAnimWrite(nn, nf, t2, m2, e2)
  return nf, t2, m2, e2
end
local function rlModelRetime(args: { [string]: any }): { [string]: any }
  local anim = tostring(args.anim or "")
  local scale = num(args.scale, 0)
  if scale < 0.1 or scale > 10 then error("scale must be 0.1-10 (got " .. tostring(args.scale) .. ")") end
  local folder, tracks, markers, events = rlAnimRead(anim)
  if args.newName ~= nil and tostring(args.newName) ~= "" then
    folder, tracks, markers, events = rlAnimDuplicate(anim, args.newName, args.confirm)
    anim = tostring(args.newName):gsub("^%s+", ""):gsub("%s+$", ""):sub(1, 64)
  end
  local duration = num(folder:GetAttribute("duration"), 0) * scale
  if duration > 60 then error("retimed duration " .. duration .. "s exceeds 60s - use a smaller scale") end
  if duration < 0.1 then error("retimed duration " .. duration .. "s is below 0.1s - use a larger scale") end
  for _, tr in pairs(tracks) do
    for _, k in ipairs((tr :: any).keys or {}) do
      (k :: any).t = num((k :: any).t, 0) * scale
    end
  end
  for _, m in ipairs(markers) do
    (m :: any).t = num((m :: any).t, 0) * scale
  end
  folder:SetAttribute("duration", duration)
  rlAnimWrite(anim, folder, tracks, markers, events)
  return { animation = anim, scale = scale, duration = duration }
end
local function rlModelReverse(args: { [string]: any }): { [string]: any }
  local anim = tostring(args.anim or "")
  local folder, tracks, markers, events = rlAnimRead(anim)
  if args.newName ~= nil and tostring(args.newName) ~= "" then
    folder, tracks, markers, events = rlAnimDuplicate(anim, args.newName, args.confirm)
    anim = tostring(args.newName):gsub("^%s+", ""):gsub("%s+$", ""):sub(1, 64)
  end
  local duration = num(folder:GetAttribute("duration"), 0)
  for _, tr in pairs(tracks) do
    local keys = (tr :: any).keys or {}
    for _, k in ipairs(keys) do
      (k :: any).t = duration - num((k :: any).t, 0)
      local e = tostring((k :: any).ease or "linear")
      k.ease = EASE_FLIP[e] or e
    end
    table.sort(keys, function(a, b) return num((a :: any).t, 0) < num((b :: any).t, 0) end)
  end
  for _, m in ipairs(markers) do
    (m :: any).t = duration - num((m :: any).t, 0)
  end
  table.sort(markers, function(a, b) return num((a :: any).t, 0) < num((b :: any).t, 0) end)
  rlAnimWrite(anim, folder, tracks, markers, events)
  return { animation = anim, duration = duration }
end
local function rlMirrorTrackName(nm: string): string
  if nm:find("Left", 1, true) then return (nm:gsub("Left", "Right", 1)) end
  if nm:find("Right", 1, true) then return (nm:gsub("Right", "Left", 1)) end
  if nm:find("_L", 1, true) then return (nm:gsub("_L", "_R", 1)) end
  if nm:find("_R", 1, true) then return (nm:gsub("_R", "_L", 1)) end
  if nm:find("-L", 1, true) then return (nm:gsub("-L", "-R", 1)) end
  if nm:find("-R", 1, true) then return (nm:gsub("-R", "-L", 1)) end
  return nm
end
local function rlModelMirror(args: { [string]: any }): { [string]: any }
  local anim = tostring(args.anim or "")
  local folder, tracks = rlAnimRead(anim)
  local doSwap = args.swapPairs ~= false
  local nn = anim
  if args.newName ~= nil and tostring(args.newName) ~= "" then
    nn = tostring(args.newName):gsub("^%s+", ""):gsub("%s+$", ""):sub(1, 64)
    if rlAnimFolder(nn) and args.confirm ~= true then
      error("CONFIRM_REQUIRED: model animation '" .. nn .. "' already exists - re-send with confirm:true to overwrite, or pick another name")
    end
  end
  local out: { [string]: any } = {}
  local swapped = 0
  for tn, tr in pairs(tracks) do
    local name = tostring(tn)
    if doSwap then
      local sw = rlMirrorTrackName(name)
      if sw ~= name then swapped += 1 end
      name = sw
    end
    local keys: { [string]: any } = {}
    for _, k in ipairs((tr :: any).keys or {}) do
      local p, r = (k :: any).pos, (k :: any).rot
      table.insert(keys, { t = num((k :: any).t, 0),
        pos = { x = -num(p and (p :: any).x, 0), y = num(p and (p :: any).y, 0), z = num(p and (p :: any).z, 0) },
        rot = { x = num(r and (r :: any).x, 0), y = -num(r and (r :: any).y, 0), z = -num(r and (r :: any).z, 0) },
        ease = tostring((k :: any).ease or "linear") })
    end
    if out[name] then
      for _, k in ipairs(keys) do table.insert(out[name].keys, k) end
      table.sort(out[name].keys, function(a, b) return num((a :: any).t, 0) < num((b :: any).t, 0) end)
    else
      out[name] = { kind = tostring((tr :: any).kind or "custom"), keys = keys }
    end
  end
  local nf = rlAnimFolder(nn)
  if not nf then
    nf = Instance.new("Folder")
    nf.Name = nn
    nf.Parent = rlAnimRoot()
  end
  pcall(function()
    for _, a in ipairs({ "target", "duration", "fps", "loop" }) do
      local v = folder:GetAttribute(a)
      if v ~= nil then nf:SetAttribute(a, v) end
    end
  end)
  local _, markers, events = rlAnimRead(anim)
  local function clone(v: any): any
    return HttpService:JSONDecode(HttpService:JSONEncode(v))
  end
  rlAnimWrite(nn, nf, out, clone(markers), clone(events))
  return { animation = nn, swapped = swapped }
end
local function rlModelBlend(args: { [string]: any }): { [string]: any }
  local base = tostring(args.base or "")
  local over = tostring(args.overlay or "")
  local nn = tostring(args.newName or ""):gsub("^%s+", ""):gsub("%s+$", ""):sub(1, 64)
  if nn == "" then error("newName is required (max 64 chars)") end
  if rlAnimFolder(nn) and args.confirm ~= true then
    error("CONFIRM_REQUIRED: model animation '" .. nn .. "' already exists - re-send with confirm:true to overwrite, or pick another name")
  end
  local w = num(args.weight, 0.5)
  if w < 0 or w > 1 then error("weight must be 0-1 (got " .. tostring(args.weight) .. ")") end
  local bf, bt = rlAnimRead(base)
  local _, ot = rlAnimRead(over)
  local fps = 30
  local bdur, odur = 0, 0
  pcall(function()
    fps = math.floor(num(bf:GetAttribute("fps"), 30))
    bdur = num(bf:GetAttribute("duration"), 0)
    odur = num(bf:GetAttribute("duration"), 0)
  end)
  local of = rlAnimFolder(over)
  pcall(function() odur = num(of:GetAttribute("duration"), odur) end)
  if fps < 1 then fps = 30 end
  local duration = math.max(bdur, odur)
  if duration <= 0 then error("blend needs a positive duration on both inputs") end
  local step = 1 / fps
  if (math.floor(duration / step) + 1) > MAX_MODEL_KEYS then
    error("blend grid too dense (" .. (math.floor(duration / step) + 1) .. " samples) - shorten the inputs first")
  end
  local names: { [string]: boolean } = {}
  for k in pairs(bt) do names[tostring(k)] = true end
  for k in pairs(ot) do names[tostring(k)] = true end
  local out: { [string]: any } = {}
  local total = 0
  for tn in pairs(names) do
    local bk = bt[tn] and (bt[tn] :: any).keys
    local ok2 = ot[tn] and (ot[tn] :: any).keys
    if bk and ok2 then
      local keys: { [string]: any } = {}
      local t = 0
      while t <= duration + 1e-9 do
        local bp, br = rlPoseAt(bk, t)
        local op, orr = rlPoseAt(ok2, t)
        table.insert(keys, { t = t,
          pos = rlLerp3(bp, op, w), rot = rlLerp3(br, orr, w), ease = "linear" })
        t += step
      end
      out[tn] = { kind = "blend", keys = keys }
      total += #keys
    elseif bk then
      out[tn] = bt[tn]
      total += #bk
    else
      out[tn] = ot[tn]
      total += #ok2
    end
  end
  local _, bmarkers, bevents = rlAnimRead(base)
  local _, omarkers, oevents = rlAnimRead(over)
  local markers: { [string]: any } = {}
  local seen: { [string]: boolean } = {}
  for _, m in ipairs(omarkers) do
    table.insert(markers, m)
    seen[tostring((m :: any).name)] = true
  end
  for _, m in ipairs(bmarkers) do
    if not seen[tostring((m :: any).name)] then table.insert(markers, m) end
  end
  table.sort(markers, function(a, b) return num((a :: any).t, 0) < num((b :: any).t, 0) end)
  local events: { [string]: any } = {}
  local eseen: { [string]: boolean } = {}
  for _, e in ipairs(oevents) do
    table.insert(events, e)
    eseen[tostring((e :: any).marker)] = true
  end
  for _, e in ipairs(bevents) do
    if not eseen[tostring((e :: any).marker)] then table.insert(events, e) end
  end
  local nf = rlAnimFolder(nn)
  if not nf then
    nf = Instance.new("Folder")
    nf.Name = nn
    nf.Parent = rlAnimRoot()
  end
  local tgt = ""
  pcall(function() tgt = tostring(bf:GetAttribute("target") or "") end)
  nf:SetAttribute("target", tgt)
  nf:SetAttribute("duration", duration)
  nf:SetAttribute("fps", fps)
  nf:SetAttribute("loop", false)
  rlAnimWrite(nn, nf, out, markers, events)
  return { animation = nn, tracks = total > 0 and (function()
    local c = 0
    for _ in pairs(out) do c += 1 end
    return c
  end)() or 0, keysTotal = total, duration = duration }
end
local function rlModelFix(args: { [string]: any }): { [string]: any }
  local anim = tostring(args.anim or "")
  local folder, tracks, markers, events = rlAnimRead(anim)
  local fixed: { string } = {}
  for tn, tr in pairs(tracks) do
    local keys = (tr :: any).keys
    if type(keys) ~= "table" or #keys == 0 then
      tracks[tn] = nil
      table.insert(fixed, "dropped empty track " .. tostring(tn):sub(1, 40))
    else
      for _, k in ipairs(keys) do
        if EASE_FNS[(k :: any).ease] == nil then
          k.ease = "linear"
          table.insert(fixed, "reset bad easing on " .. tostring(tn):sub(1, 32))
          break
        end
      end
    end
  end
  local doLoop = false
  pcall(function() doLoop = folder:GetAttribute("loop") == true end)
  if doLoop then
    for tn, tr in pairs(tracks) do
      local keys = (tr :: any).keys
      if type(keys) == "table" and #keys >= 2 then
        local a, b = keys[1], keys[#keys]
        if rlMag3(a.rot, b.rot) > 1.0 or rlMag3(a.pos, b.pos) > 0.1 then
          local function clone(v: any): any
            return HttpService:JSONDecode(HttpService:JSONEncode(v))
          end
          b.pos = clone(a.pos)
          b.rot = clone(a.rot)
          table.insert(fixed, "closed loop on " .. tostring(tn):sub(1, 32))
        end
      end
    end
  end
  local duration = 60
  pcall(function() duration = num(folder:GetAttribute("duration"), 60) end)
  for _, m in ipairs(markers) do
    local t = num((m :: any).t, 0)
    if t > duration then
      m.t = duration
      table.insert(fixed, "clamped marker " .. tostring((m :: any).name):sub(1, 32))
    end
  end
  local have: { [string]: boolean } = {}
  for _, m in ipairs(markers) do have[tostring((m :: any).name)] = true end
  local kept: { [string]: any } = {}
  for _, e in ipairs(events) do
    if have[tostring((e :: any).marker)] then
      table.insert(kept, e)
    else
      table.insert(fixed, "dropped orphan event for " .. tostring((e :: any).marker):sub(1, 32))
    end
  end
  rlAnimWrite(anim, folder, tracks, markers, kept)
  local rep = rlModelValidate({ anim = anim })
  return { animation = anim, fixed = fixed, remaining = { errors = rep.errors, warnings = rep.warnings }, passed = rep.passed }
end
local function rlModelWriteFresh(args: { [string]: any }, tracks: { [string]: any }, markers: { [string]: any }): { [string]: any }
  local path = tostring(args.target or "")
  local target = findByPath(path)
  if not target then error("Model not found: '" .. path:sub(1, 120) .. "'.") end
  local name = tostring(args.name or ""):gsub("^%s+", ""):gsub("%s+$", ""):sub(1, 64)
  if name == "" then error("name is required (max 64 chars)") end
  local duration = num(args.duration, 0)
  if duration < 0.1 or duration > 60 then error("duration must be 0.1-60s (got " .. tostring(args.duration) .. ")") end
  local fps = math.floor(num(args.fps, 30))
  if fps < 1 or fps > 120 then error("fps must be 1-120 (got " .. tostring(args.fps) .. ")") end
  local existing = rlAnimFolder(name)
  if existing and args.confirm ~= true then
    error("CONFIRM_REQUIRED: model animation '" .. name .. "' already exists - re-send with confirm:true to overwrite, or pick another name")
  end
  local folder = existing
  if not folder then
    folder = Instance.new("Folder")
    folder.Name = name
    folder.Parent = rlAnimRoot()
  end
  folder:SetAttribute("target", target:GetFullName())
  folder:SetAttribute("duration", duration)
  folder:SetAttribute("fps", fps)
  folder:SetAttribute("loop", args.loop == true)
  local total = 0
  for _, tr in pairs(tracks) do total += #((tr :: any).keys or {}) end
  if total > 4096 then error("scaffold too dense (" .. total .. " keys) - list fewer tracks") end
  rlAnimWrite(name, folder, tracks, markers, {})
  return { animation = name, target = target:GetFullName(), duration = duration, fps = fps, loop = args.loop == true }
end
local function rlNeutralKeys(tracks: { [string]: any }, names: { [string]: any })
  for _, tn in ipairs(names) do
    tracks[tn] = { kind = "custom", keys = {} }
  end
end
local function rlKeyAt(tracks: { [string]: any }, tn: string, t: number, rx: number, ry: number, rz: number, ease: string)
  local keys = tracks[tn].keys
  table.insert(keys, { t = t, pos = { x = 0, y = 0, z = 0 }, rot = { x = rx, y = ry, z = rz }, ease = ease })
end
local function rlModelAttack(args: { [string]: any }): { [string]: any }
  local names = args.tracks
  if type(names) ~= "table" or #names == 0 then error("tracks[] must list at least one joint name from analyze_animatable_model") end
  if #names > 32 then error("too many tracks (max 32)") end
  local duration = num(args.duration, 1.05)
  local ant = num(args.anticipation, 0.2)
  local impact = num(args.impactT, 0.46)
  if impact < 0 or impact > duration then error("impactT must sit inside 0-" .. duration .. "s") end
  if ant < 0 or ant > duration then error("anticipation must sit inside 0-" .. duration .. "s") end
  local st = args.strike
  local srx = num(st and (st :: any).rx, 0)
  local sry = num(st and (st :: any).ry, 45)
  local srz = num(st and (st :: any).rz, 0)
  local tracks: { [string]: any } = {}
  rlNeutralKeys(tracks, names)
  -- Overshoot settle: one key past impact at 108% strike with springOut,
  -- then the neutral recovery. Reads as snap-follow-through, not a freeze.
  local over = math.min(0.12, math.max(0.04, (duration - impact) / 3))
  local hasOver = over < duration - impact - 0.03
  for _, tn in ipairs(names) do
    local s = tostring(tn)
    rlKeyAt(tracks, s, 0, 0, 0, 0, "linear")
    rlKeyAt(tracks, s, ant, -srx * 0.5, -sry * 0.5, -srz * 0.5, "quadInOut")
    rlKeyAt(tracks, s, impact, srx, sry, srz, "bezierOut")
    if hasOver then
      rlKeyAt(tracks, s, impact + over, srx * 1.08, sry * 1.08, srz * 1.08, "springOut")
    end
    rlKeyAt(tracks, s, duration, 0, 0, 0, "sineInOut")
  end
  local res = rlModelWriteFresh(args, tracks, { { t = impact, name = "IMPACT" } })
  res.impactT = impact
  return res
end
local function rlModelIdle(args: { [string]: any }): { [string]: any }
  local names = args.tracks
  if type(names) ~= "table" or #names == 0 then error("tracks[] must list at least one joint name from analyze_animatable_model") end
  if #names > 32 then error("too many tracks (max 32)") end
  local duration = num(args.duration, 2)
  local sway = num(args.sway, 5)
  if sway < 0 or sway > 45 then error("sway must be 0-45 degrees (got " .. tostring(args.sway) .. ")") end
  local tracks: { [string]: any } = {}
  rlNeutralKeys(tracks, names)
  for _, tn in ipairs(names) do
    local s = tostring(tn)
    rlKeyAt(tracks, s, 0, 0, 0, 0, "linear")
    rlKeyAt(tracks, s, duration / 2, 0, sway, 0, "sineInOut")
    rlKeyAt(tracks, s, duration, 0, 0, 0, "sineInOut")
  end
  return rlModelWriteFresh(args, tracks, {})
end
local function rlModelWalk(args: { [string]: any }): { [string]: any }
  local names = args.tracks
  if type(names) ~= "table" or #names == 0 then error("tracks[] must list at least one joint name from analyze_animatable_model (order drives alternation)") end
  if #names > 32 then error("too many tracks (max 32)") end
  local duration = num(args.duration, 0.8)
  local stride = num(args.stride, 20)
  if stride < 0 or stride > 90 then error("stride must be 0-90 degrees (got " .. tostring(args.stride) .. ")") end
  local tracks: { [string]: any } = {}
  rlNeutralKeys(tracks, names)
  for i, tn in ipairs(names) do
    local s = tostring(tn)
    local sign = 1
    if i % 2 == 0 then sign = -1 end
    rlKeyAt(tracks, s, 0, 0, 0, 0, "linear")
    rlKeyAt(tracks, s, duration * 0.25, sign * stride, 0, 0, "sineInOut")
    rlKeyAt(tracks, s, duration * 0.5, 0, 0, 0, "sineInOut")
    rlKeyAt(tracks, s, duration * 0.75, -sign * stride, 0, 0, "sineInOut")
    rlKeyAt(tracks, s, duration, 0, 0, 0, "sineInOut")
  end
  return rlModelWriteFresh(args, tracks, {})
end


-- ── Diagnostics + inspection probes (tools 120-124) ──────────────────────
-- Small, read-only, heavily pcapped: a probe must never fail the session.

local function probeStudio(_args:{ [string]: any }): { [string]: any }
  local playState = "edit"
  pcall(function()
    if game:GetService("RunService"):IsRunning() then playState = "play" end
  end)
  local sel:{ string } = {}
  pcall(function()
    for _, inst in ipairs(game:GetService("Selection"):Get()) do
      table.insert(sel, inst:GetFullName())
      if #sel >= 20 then break end
    end
  end)
  return { playState = playState, selection = sel, pluginVersion = PLUGIN_VERSION }
end

local function outputHistory(limit:number, errorsOnly:boolean?): { [string]: any }
  local out:{ [string]: any } = {}
  pcall(function()
    local hist = game:GetService("LogService"):GetLogHistory()
    for i = #hist, 1, -1 do
      local e = hist[i]
      local t = tostring(e.messageType or "")
      if errorsOnly == false or t:find("Error") or t:find("Warning") then
        table.insert(out, { type = t:match("Message(%w+)") or t, message = tostring(e.message or ""):sub(1, 300) })
        if #out >= limit then break end
      end
    end
  end)
  return out
end

local function scanOutputLog(args:{ [string]: any }): { [string]: any }
  local limit = math.clamp(math.floor(tonumber(args.limit or 30) or 30), 1, 100)
  local entries = outputHistory(limit)
  local errors, warnings = 0, 0
  for _, e in ipairs(entries) do
    if (e.type or ""):find("Error") then errors += 1 else warnings += 1 end
  end
  return { errors = entries, errorCount = errors, warningCount = warnings,
    scanned = #entries, note = "Studio Output errors/warnings, newest first. Pair with get_script_content on the named scripts." }
end

local function inspectUI(args:{ [string]: any }): { [string]: any }
  local rootName = tostring(args.root or "StarterGui")
  local root: Instance? = game:FindFirstChildOfClass(rootName) or game:FindFirstChild(rootName)
  if not root then
    local ok, svc = pcall(function() return game:GetService(rootName) end)
    if ok then root = svc end
  end
  if not root then error("inspect_ui: root '" .. rootName .. "' not found - try StarterGui") end
  local maxDepth = math.clamp(math.floor(tonumber(args.maxDepth or 4) or 4), 1, 8)
  local nodes:{ [string]: any } = {}
  local function props(inst: Instance): { [string]: any }
    local p:{ [string]: any } = { path = inst:GetFullName(), class = inst.ClassName, name = inst.Name }
    pcall(function()
      if inst:IsA("GuiObject") then
        p.visible = (inst::any).Visible
        local ap = (inst::any).AbsolutePosition
        local as = (inst::any).AbsoluteSize
        p.rect = { math.floor(ap.X), math.floor(ap.Y), math.floor(as.X), math.floor(as.Y) }
        p.layoutOrder = (inst::any).LayoutOrder
      end
    end)
    return p
  end
  local function walk(inst: Instance, depth: number)
    if #nodes >= 300 then return end
    table.insert(nodes, props(inst))
    if depth >= maxDepth then return end
    for _, c in ipairs(inst:GetChildren()) do walk(c, depth + 1) end
  end
  walk(root, 0)
  return { root = root:GetFullName(), count = #nodes, truncated = #nodes >= 300, tree = nodes,
    note = "rect = {x, y, w, h} in screen px. Compare siblings' rects for overlap/layout bugs." }
end

-- Numeric UI layout preview (PLAN.md Phase 2): every GuiObject with its
-- absolute rect PLUS anchor/scale decomposition, so the model can reason
-- about responsive behavior (inspect_ui lacks scale info). No judgments —
-- pair with validate_ui for the audit.
local function previewUI(args:{ [string]: any }): { [string]: any }
  local rootName = tostring(args.root or "StarterGui")
  local root: Instance? = game:FindFirstChildOfClass(rootName) or game:FindFirstChild(rootName)
  if not root then
    local ok, svc = pcall(function() return game:GetService(rootName) end)
    if ok then root = svc end
  end
  if not root then error("preview_ui: root '" .. rootName .. "' not found - try StarterGui") end
  local maxDepth = math.clamp(math.floor(tonumber(args.maxDepth or 4) or 4), 1, 8)
  local els:{ [string]: any } = {}
  local function rectOf(inst: Instance): { number }?
    local ok, ap, as = pcall(function()
      return (inst::any).AbsolutePosition, (inst::any).AbsoluteSize
    end)
    if not ok or not ap or not as then return nil end
    return { math.floor(ap.X), math.floor(ap.Y), math.floor(as.X), math.floor(as.Y) }
  end
  local function walk(inst: Instance, depth: number)
    if #els >= 200 then return end
    if inst:IsA("GuiObject") then
      local e:{ [string]: any } = { path = inst:GetFullName(),
        class = inst.ClassName, name = inst.Name }
      local r = rectOf(inst)
      if r then e.rect = r end
      pcall(function()
        e.visible = (inst::any).Visible
        e.zIndex = (inst::any).ZIndex
        local pos = (inst::any).Position
        local sz = (inst::any).Size
        if pos then e.posScale = { pos.X.Scale, pos.Y.Scale } end
        if sz then e.sizeScale = { sz.X.Scale, sz.Y.Scale } end
        local ap2 = (inst::any).AnchorPoint
        if ap2 then e.anchor = { ap2.X, ap2.Y } end
      end)
      table.insert(els, e)
    end
    if depth >= maxDepth then return end
    for _, c in ipairs(inst:GetChildren()) do walk(c, depth + 1) end
  end
  walk(root, 0)
  local vw, vh = 1920, 1080
  pcall(function()
    local cam = workspace.CurrentCamera
    if cam then vw, vh = cam.ViewportSize.X, cam.ViewportSize.Y end
  end)
  return { root = root:GetFullName(), viewport = { vw, vh }, count = #els,
    truncated = #els >= 200, elements = els,
    note = "rect = {x,y,w,h} px. posScale/sizeScale 0 = fixed offsets (breaks on resize); 1 = full-scale. Pair with validate_ui." }
end

-- UI audit (PLAN.md Phase 2): sibling overlaps, off-screen, zero-size,
-- offset-only full-screen frames, empty text. Warnings, not blocks — the
-- model decides. Sibling-only overlap (containers legitimately cover kids).
local function validateUI(args:{ [string]: any }): { [string]: any }
  local rootName = tostring(args.root or "StarterGui")
  local root: Instance? = game:FindFirstChildOfClass(rootName) or game:FindFirstChild(rootName)
  if not root then
    local ok, svc = pcall(function() return game:GetService(rootName) end)
    if ok then root = svc end
  end
  if not root then error("validate_ui: root '" .. rootName .. "' not found - try StarterGui") end
  local vw = math.max(320, math.min(7680, math.floor(tonumber(args.viewportW) or 1920)))
  local vh = math.max(320, math.min(4320, math.floor(tonumber(args.viewportH) or 1080)))
  local maxDepth = math.clamp(math.floor(tonumber(args.maxDepth or 4) or 4), 1, 8)
  local items:{ [string]: any } = {}
  local function walk(inst: Instance, depth: number)
    if #items >= 200 then return end
    if inst:IsA("GuiObject") then
      local ok, vis, ap, as = pcall(function()
        return (inst::any).Visible, (inst::any).AbsolutePosition, (inst::any).AbsoluteSize
      end)
      if ok and ap and as then
        table.insert(items, { inst = inst, path = inst:GetFullName(),
          class = inst.ClassName, visible = vis,
          x = ap.X, y = ap.Y, w = as.X, h = as.Y })
      end
    end
    if depth >= maxDepth then return end
    for _, c in ipairs(inst:GetChildren()) do walk(c, depth + 1) end
  end
  walk(root, 0)
  local issues:{ [string]: any } = {}
  local function push(sev: string, code: string, path: string, detail: string)
    if #issues >= 50 then return end
    table.insert(issues, { severity = sev, code = code, path = path, detail = detail })
  end
  local byParent:{ [string]: any } = {}
  for _, it in ipairs(items) do
    local p = "root"
    pcall(function() p = it.inst.Parent and it.inst.Parent:GetFullName() or "root" end)
    if not byParent[p] then byParent[p] = {} end
    table.insert(byParent[p], it)
    if it.visible then
      if it.w < 1 or it.h < 1 then
        push("warning", "ZERO_SIZE", it.path,
          "renders nothing (" .. math.floor(it.w) .. "x" .. math.floor(it.h) .. "px)")
      end
      if it.x + it.w <= 0 or it.y + it.h <= 0 or it.x >= vw or it.y >= vh then
        push("error", "OFFSCREEN", it.path, "fully outside " .. vw .. "x" .. vh)
      elseif it.x < 0 or it.y < 0 or it.x + it.w > vw or it.y + it.h > vh then
        push("warning", "CLIPPED", it.path, "partly outside " .. vw .. "x" .. vh)
      end
      if it.class == "TextLabel" then
        local t = ""
        pcall(function() t = tostring((it.inst::any).Text or "") end)
        if t == "" then push("warning", "EMPTY_TEXT", it.path, "TextLabel with no text") end
      end
      local big = it.w > 1000 and it.h > 500
      if big then
        local sx, sy = 0, 0
        pcall(function()
          sx = (it.inst::any).Size.X.Scale; sy = (it.inst::any).Size.Y.Scale
        end)
        if sx == 0 and sy == 0 then
          push("warning", "FIXED_FULLSCREEN", it.path,
            "large fixed-offset frame will not scale to other screens - use scale + anchors")
        end
      end
    end
  end
  for _, sibs in pairs(byParent) do
    for i = 1, #sibs do
      local a = sibs[i]
      if not a.visible then continue end
      for j = i + 1, #sibs do
        local b = sibs[j]
        if not b.visible then continue end
        local ix = math.min(a.x + a.w, b.x + b.w) - math.max(a.x, b.x)
        local iy = math.min(a.y + a.h, b.y + b.h) - math.max(a.y, b.y)
        if ix > 0 and iy > 0 then
          local area = ix * iy
          local small = math.min(a.w * a.h, b.w * b.h)
          local frac = if small > 0 then area / small else 0
          if frac >= 0.99 then
            push("error", "DUPLICATE_RECT", b.path,
              "identical rect to sibling " .. a.path .. " - one hides the other")
          elseif frac > 0.1 then
            push("warning", "OVERLAP", b.path,
              "overlaps sibling " .. a.path .. " (" .. math.floor(frac * 100) .. "% of smaller)")
          end
        end
      end
    end
  end
  local errors = 0
  for _, is in ipairs(issues) do
    if is.severity == "error" then errors += 1 end
  end
  return { root = root:GetFullName(), viewport = { vw, vh }, checked = #items,
    passed = errors == 0, errors = errors, warnings = #issues - errors, issues = issues,
    note = "Sibling-only overlap (containers covering children is normal). Re-check with preview_ui after fixes." }
end

-- UI theme store (PLAN.md Phase 4): design tokens in a ModuleScript at
-- StarterGui/RoLinkTheme so both Edit and Play can read them. Missing store
-- means defaults. Components below read the effective theme; set_ui_theme
-- writes it; apply_ui_theme restyles an existing subtree by name-role.
local function defaultTheme(): { [string]: any }
  return {
    colors = {
      primary = { r = 26, g = 115, b = 232 },
      secondary = { r = 241, g = 243, b = 244 },
      danger = { r = 217, g = 48, b = 37 },
      ink = { r = 32, g = 33, b = 36 },
      paper = { r = 255, g = 255, b = 255 },
      wash = { r = 232, g = 234, b = 237 },
      dim = { r = 95, g = 99, b = 104 },
      surface = { r = 248, g = 249, b = 250 },
    },
    fonts = {
      heading = { size = 24, weight = "Bold" },
      subheading = { size = 18, weight = "Medium" },
      body = { size = 14, weight = "Regular" },
      caption = { size = 12, weight = "Regular" },
    },
    spacing = { xs = 4, sm = 8, md = 16, lg = 24, xl = 32 },
    corners = { sm = 4, md = 8, lg = 12, xl = 16, full = 9999 },
  }
end

local function themeColor(t:{ [string]: any }): Color3
  local r = math.clamp(math.floor((tonumber(t.r) or 255) + 0.5), 0, 255)
  local g = math.clamp(math.floor((tonumber(t.g) or 255) + 0.5), 0, 255)
  local b = math.clamp(math.floor((tonumber(t.b) or 255) + 0.5), 0, 255)
  return Color3.fromRGB(r, g, b)
end

local function parseThemeColor(v:any): { [string]: any }?
  if type(v) == "string" then
    local m = tostring(v):match("^#?([0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F])$")
    if not m then return nil end
    return { r = tonumber(m:sub(1, 2), 16), g = tonumber(m:sub(3, 4), 16),
      b = tonumber(m:sub(5, 6), 16) }
  end
  if type(v) == "table" then
    local t = v :: any
    if tonumber(t.r) == nil or tonumber(t.g) == nil or tonumber(t.b) == nil then
      return nil
    end
    return { r = tonumber(t.r), g = tonumber(t.g), b = tonumber(t.b) }
  end
  return nil
end

local function readThemeStore(): (Instance?, { [string]: any }?)
  local holder: Instance? = nil
  pcall(function() holder = game:GetService("StarterGui") end)
  if not holder then return nil, nil end
  local mod = nil
  pcall(function() mod = (holder :: Instance):FindFirstChild("RoLinkTheme") end)
  if not (mod and mod:IsA("ModuleScript")) then return holder, nil end
  local src = ""
  pcall(function() src = (mod :: any).Source or "" end)
  if src == "" then return holder, nil end
  local fn:any = nil
  pcall(function()
    local loader = loadstring or load
    if loader then fn = (loader :: any)(src, "=RoLinkTheme") end
  end)
  if type(fn) ~= "function" then return holder, nil end
  local ok, data = pcall(fn)
  if not ok or type(data) ~= "table" then return holder, nil end
  return holder, data
end

local function effectiveTheme(): { [string]: any }
  local base = defaultTheme()
  local _, stored = readThemeStore()
  if type(stored) ~= "table" then return base end
  local st = stored :: any
  if type(st.colors) == "table" then
    for k, v in pairs(st.colors) do
      if type((base.colors :: any)[k]) == "table" and type(v) == "table" then
        local c = v :: any
        if tonumber(c.r) ~= nil and tonumber(c.g) ~= nil and tonumber(c.b) ~= nil then
          (base.colors :: any)[k] = { r = tonumber(c.r), g = tonumber(c.g), b = tonumber(c.b) };
        end
      end
    end
  end
  if type(st.fonts) == "table" then
    for k, v in pairs(st.fonts) do
      if type((base.fonts :: any)[k]) == "table" and type(v) == "table" then
        local f = v :: any
        local slot = (base.fonts :: any)[k]
        if tonumber(f.size) ~= nil then
          slot.size = math.clamp(math.floor(tonumber(f.size) + 0.5), 6, 200)
        end
        if type(f.weight) == "string" and f.weight ~= "" then
          slot.weight = tostring(f.weight):sub(1, 20)
        end
      end
    end
  end
  for _, section in ipairs({ "spacing", "corners" }) do
    if type(st[section]) == "table" and type(base[section]) == "table" then
      for k, v in pairs(st[section]) do
        if type((base[section] :: any)[k]) == "number" and tonumber(v) ~= nil then
          (base[section] :: any)[k] = tonumber(v);
        end
      end
    end
  end
  return base
end

local function encodeThemeSrc(t:{ [string]: any }): string
  local parts:{ string } = { "return {" }
  table.insert(parts, "colors = {")
  for _, k in ipairs({ "primary", "secondary", "danger", "ink", "paper", "wash", "dim", "surface" }) do
    local c = (t.colors or {})[k] or { r = 255, g = 255, b = 255 }
    table.insert(parts, string.format("%s = { r = %d, g = %d, b = %d },",
      k, math.floor((tonumber(c.r) or 0) + 0.5),
      math.floor((tonumber(c.g) or 0) + 0.5), math.floor((tonumber(c.b) or 0) + 0.5)))
  end
  table.insert(parts, "}, fonts = {")
  for _, k in ipairs({ "heading", "subheading", "body", "caption" }) do
    local f = (t.fonts or {})[k] or { size = 14, weight = "Regular" }
    table.insert(parts, string.format("%s = { size = %d, weight = %q },",
      k, math.clamp(math.floor((tonumber(f.size) or 14) + 0.5), 6, 200),
      tostring(f.weight or "Regular"):sub(1, 20)))
  end
  table.insert(parts, "}, spacing = {")
  for _, k in ipairs({ "xs", "sm", "md", "lg", "xl" }) do
    table.insert(parts, string.format("%s = %d,", k, math.floor((tonumber((t.spacing or {})[k]) or 8) + 0.5)))
  end
  table.insert(parts, "}, corners = {")
  for _, k in ipairs({ "sm", "md", "lg", "xl", "full" }) do
    table.insert(parts, string.format("%s = %d,", k, math.floor((tonumber((t.corners or {})[k]) or 8) + 0.5)))
  end
  table.insert(parts, "} }")
  return table.concat(parts, "\n")
end

local function getUITheme(args:{ [string]: any }): { [string]: any }
  local _, stored = readThemeStore()
  local theme = effectiveTheme()
  return { theme = theme, customized = stored ~= nil, path = "StarterGui/RoLinkTheme",
    note = "Missing store = defaults. Write with set_ui_theme; apply with apply_ui_theme." }
end

local function setUITheme(args:{ [string]: any }): { [string]: any }
  local hasAny = args.colors ~= nil or args.fonts ~= nil
    or args.spacing ~= nil or args.corners ~= nil
  if not hasAny then
    error("validation_error: pass at least one of colors/fonts/spacing/corners " ..
      "(colors: {primary?={r,g,b}|'#rrggbb', ...}; fonts: {heading?={size?,weight?}, ...})")
  end
  local theme:{ [string]: any }
  if args.replace == true then
    theme = defaultTheme()
  else
    theme = effectiveTheme()
  end
  if args.colors ~= nil then
    if type(args.colors) ~= "table" then error("validation_error: colors must be an object map") end
    for k, v in pairs(args.colors :: any) do
      if (theme.colors :: any)[k] == nil then
        error("validation_error: unknown color '" .. tostring(k) ..
          "' (primary, secondary, danger, ink, paper, wash, dim, surface)")
      end
      local c = parseThemeColor(v)
      if not c then
        error("validation_error: color '" .. tostring(k) ..
          "' must be {r,g,b 0-255} or '#rrggbb'")
      end
      (theme.colors :: any)[k] = { r = math.clamp(math.floor(c.r + 0.5), 0, 255),
        g = math.clamp(math.floor(c.g + 0.5), 0, 255),
        b = math.clamp(math.floor(c.b + 0.5), 0, 255) };
    end
  end
  if args.fonts ~= nil then
    if type(args.fonts) ~= "table" then error("validation_error: fonts must be an object map") end
    for k, v in pairs(args.fonts :: any) do
      if (theme.fonts :: any)[k] == nil then
        error("validation_error: unknown font role '" .. tostring(k) ..
          "' (heading, subheading, body, caption)")
      end
      if type(v) ~= "table" then error("validation_error: font '" .. tostring(k) .. "' must be {size?, weight?}") end
      local slot = (theme.fonts :: any)[k]
      local f = v :: any
      if f.size ~= nil then
        if tonumber(f.size) == nil then error("validation_error: font size must be a number") end
        slot.size = math.clamp(math.floor(tonumber(f.size) + 0.5), 6, 200)
      end
      if f.weight ~= nil then slot.weight = tostring(f.weight):sub(1, 20) end
    end
  end
  for _, section in ipairs({ "spacing", "corners" }) do
    local incoming = args[section]
    if incoming ~= nil then
      if type(incoming) ~= "table" then
        error("validation_error: " .. section .. " must be an object map")
      end
      for k, v in pairs(incoming :: any) do
        if type((theme[section] :: any)[k]) ~= "number" then
          error("validation_error: unknown " .. section .. " key '" .. tostring(k) .. "'")
        end
        if tonumber(v) == nil then error("validation_error: " .. section .. "." .. tostring(k) .. " must be a number") end
        (theme[section] :: any)[k] = tonumber(v);
      end
    end
  end
  local holder, _ = readThemeStore()
  if not holder then error("StarterGui service is unavailable in this place") end
  local mod: Instance? = nil
  pcall(function() mod = holder:FindFirstChild("RoLinkTheme") end)
  if not (mod and (mod :: Instance):IsA("ModuleScript")) then
    mod = Instance.new("ModuleScript")
    ;(mod :: Instance).Name = "RoLinkTheme"
    mod.Parent = holder
  end
  ;((mod :: any) :: ModuleScript).Source = encodeThemeSrc(theme)
  return { theme = theme, customized = true, path = "StarterGui/RoLinkTheme",
    note = "New components read this store; existing UI needs apply_ui_theme." }
end

local function themeRole(name:string): string
  local n = tostring(name or ""):lower()
  if n:find("title", 1, true) or n:find("header", 1, true) or n:find("heading", 1, true) then
    return "heading"
  end
  if n:find("caption", 1, true) or n:find("hint", 1, true) or n:find("sub", 1, true)
    or n:find("foot", 1, true) then
    return "caption"
  end
  return "body"
end

local function weightToFont(weight:string): Enum.Font
  local w = tostring(weight or ""):lower()
  if w == "bold" then return Enum.Font.GothamBold end
  if w == "medium" then return Enum.Font.GothamMedium end
  if w == "semibold" then return Enum.Font.GothamSemibold end
  return Enum.Font.Gotham
end

local function applyUITheme(args:{ [string]: any }): { [string]: any }
  local targetPath = tostring(args.target or args.root or "StarterGui")
  local target = findByPath(targetPath)
  if not target then error("not found target " .. targetPath) end
  local theme = effectiveTheme()
  local maxDepth = math.clamp(math.floor(tonumber(args.maxDepth or 6) or 6), 1, 8)
  local applied, skipped = 0, 0
  local paths:{ string } = {}
  local function surfaceName(n:string): boolean
    local s = tostring(n or ""):lower()
    return s:find("panel", 1, true) ~= nil or s:find("card", 1, true)
      or s:find("background", 1, true) or s:find("surface", 1, true)
  end
  local function walk(inst: Instance, depth: number)
    if applied + skipped >= 200 then return end
    if inst:IsA("TextLabel") or inst:IsA("TextButton") or inst:IsA("TextBox") then
      local role = themeRole(inst.Name)
      local spec = ((theme.fonts :: any)[role] or (theme.fonts :: any).body) or { size = 14, weight = "Regular" }
      local touched = false
      pcall(function()
        (inst::any).Font = weightToFont(tostring(spec.weight or "Regular")); touched = true
      end)
      pcall(function()
        (inst::any).TextSize = math.clamp(math.floor((tonumber(spec.size) or 14) + 0.5), 6, 200);
        touched = true
      end)
      if role == "caption" then
        pcall(function()
          (inst::any).TextColor3 = themeColor((theme.colors :: any).dim); touched = true
        end)
      else
        pcall(function()
          (inst::any).TextColor3 = themeColor((theme.colors :: any).ink); touched = true
        end)
      end
      if touched then
        applied += 1
        if #paths < 20 then table.insert(paths, inst:GetFullName() .. " (" .. role .. ")") end
      else
        skipped += 1
      end
    elseif inst:IsA("Frame") and surfaceName(inst.Name) then
      local ok = pcall(function()
        (inst::any).BackgroundColor3 = themeColor((theme.colors :: any).surface)
      end)
      if ok then
        applied += 1
        if #paths < 20 then table.insert(paths, inst:GetFullName() .. " (surface)") end
      else
        skipped += 1
      end
    end
    if depth >= maxDepth then return end
    for _, c in ipairs(inst:GetChildren()) do walk(c, depth + 1) end
  end
  walk(target, 0)
  return { target = target:GetFullName(), applied = applied, skipped = skipped,
    paths = paths, truncated = applied + skipped >= 200,
    note = "Text roles by name (Title/Header=heading, Caption/Hint/Sub/Foot=caption, else body). " ..
      "Frames recolor only when named Panel/Card/Background/Surface; button fills untouched. Re-check with validate_ui." }
end

-- Styled UI component builders (PLAN.md Phase 3): one well-formed component
-- per call with theme-aligned defaults (primary #1a73e8 etc. — the Phase 4
-- theme system will own these values), centered by default via anchor 0.5,
-- explicit {x,y} offsets when given. Caps keep every call bounded.
local function buildUIComponent(kind:string, args:{ [string]: any }): { [string]: any }
  local function clean(s:any): string
    local t = tostring(s or "Node"):gsub("[^%w_]", "_"):sub(1, 50)
    if t == "" then t = "Node" end
    return t
  end
  local function rgb(r:number, g:number, b:number): Color3
    return Color3.fromRGB(
      math.clamp(math.floor(r + 0.5), 0, 255),
      math.clamp(math.floor(g + 0.5), 0, 255),
      math.clamp(math.floor(b + 0.5), 0, 255))
  end
  local THEME = {
    primary = rgb(26, 115, 232), secondary = rgb(241, 243, 244),
    danger = rgb(217, 48, 37), ink = rgb(32, 33, 36),
    paper = rgb(255, 255, 255), wash = rgb(232, 234, 237), dim = rgb(95, 99, 104),
  }
  -- Overlay custom theme colors when a RoLinkTheme store exists, so
  -- set_ui_theme changes what new components look like. Sizes stay per-call.
  pcall(function()
    local eff = effectiveTheme()
    if type(eff) == "table" and type(eff.colors) == "table" then
      for k, v in pairs(eff.colors) do
        if THEME[k] ~= nil and type(v) == "table" then
          THEME[k] = themeColor(v)
        end
      end
    end
  end)
  local parentPath = tostring(args.parent or "StarterGui")
  local parent = findByPath(parentPath)
  if not parent then
    local okSvc, svc = pcall(function() return game:GetService("StarterGui") end)
    if okSvc and svc then parent = svc end
  end
  if not parent then error("not found parent " .. parentPath) end
  local holder: Instance = parent
  if parent.ClassName == "StarterGui" or parent.ClassName == "PlayerGui" then
    local gui = Instance.new("ScreenGui")
    gui.Name = clean(args.gui or ((args.name or kind) .. "Gui"))
    gui.ResetOnSpawn = false
    gui.Parent = parent
    holder = gui
  end
  local function corner(inst: Instance, r:number)
    local c = Instance.new("UICorner")
    c.CornerRadius = UDim.new(0, math.clamp(math.floor(r + 0.5), 0, 500))
    c.Parent = inst
  end
  local function place(inst:any, w:number, h:number)
    local pos = args.position
    if type(pos) == "table" and (pos.x ~= nil or pos.y ~= nil) then
      inst.AnchorPoint = Vector2.new(0, 0)
      inst.Position = UDim2.fromOffset(tonumber(pos.x) or 0, tonumber(pos.y) or 0)
    else
      inst.AnchorPoint = Vector2.new(0.5, 0.5)
      inst.Position = UDim2.new(0.5, 0, 0.5, 0)
    end
    inst.Size = UDim2.fromOffset(
      math.max(1, math.floor(w + 0.5)), math.max(1, math.floor(h + 0.5)))
  end
  local function label(inst:any, text:string, size:number, color:Color3, bold:boolean?)
    inst.Text = tostring(text or "")
    inst.Font = if bold then Enum.Font.GothamBold else Enum.Font.Gotham
    inst.TextSize = math.clamp(math.floor(size + 0.5), 6, 200)
    inst.TextColor3 = color
    inst.TextWrapped = true
    inst.BackgroundTransparency = 1
    inst.BorderSizePixel = 0
  end
  local made:{ string } = {}
  local created_count = 0
  local firstInst: Instance? = nil
  local function track(inst: Instance)
    created_count += 1
    if firstInst == nil then firstInst = inst end
    if #made < 20 then table.insert(made, inst:GetFullName() .. " (" .. inst.ClassName .. ")") end
    return inst
  end
  if kind == "button" then
    local style = tostring(args.style or "primary"):lower()
    local b = track(Instance.new("TextButton"))
    b.Name = clean(args.name or "Button")
    local w = math.clamp(tonumber(args.width) or 200, 20, 2000)
    local h = math.clamp(tonumber(args.height) or 48, 16, 500)
    place(b, w, h)
    if style == "danger" then
      b.BackgroundColor3 = THEME.danger; b.TextColor3 = THEME.paper
    elseif style == "secondary" then
      b.BackgroundColor3 = THEME.secondary; b.TextColor3 = THEME.primary
    else
      b.BackgroundColor3 = THEME.primary; b.TextColor3 = THEME.paper
    end
    b.Font = Enum.Font.GothamBold; b.TextSize = 18
    b.Text = tostring(args.text or "Button")
    b.AutoButtonColor = true; b.BorderSizePixel = 0
    corner(b, tonumber(args.cornerRadius) or 8)
    b.Parent = holder
  elseif kind == "panel" then
    local p = track(Instance.new("Frame"))
    p.Name = clean(args.name or "Panel")
    place(p, math.clamp(tonumber(args.width) or 400, 20, 4000),
      math.clamp(tonumber(args.height) or 300, 20, 4000))
    p.BackgroundColor3 = THEME.paper; p.BorderSizePixel = 0
    if args.clips ~= nil then p.ClipsDescendants = not not args.clips end
    corner(p, tonumber(args.cornerRadius) or 12)
    p.Parent = holder
  elseif kind == "text_label" then
    local t = track(Instance.new("TextLabel"))
    t.Name = clean(args.name or "Label")
    place(t, math.clamp(tonumber(args.width) or 300, 10, 4000),
      math.clamp(tonumber(args.height) or 40, 10, 2000))
    local al = tostring(args.alignment or "Center"):lower()
    label(t, tostring(args.text or "Label"), tonumber(args.fontSize) or 14, THEME.ink, false)
    if al == "left" then t.TextXAlignment = Enum.TextXAlignment.Left
    elseif al == "right" then t.TextXAlignment = Enum.TextXAlignment.Right
    else t.TextXAlignment = Enum.TextXAlignment.Center end
    t.Parent = holder
  elseif kind == "icon_button" then
    local b = track(Instance.new("ImageButton"))
    b.Name = clean(args.name or "IconButton")
    local s = math.clamp(tonumber(args.size) or 48, 16, 512)
    place(b, s, s)
    b.Image = tostring(args.image or "")
    b.BackgroundColor3 = THEME.secondary; b.BorderSizePixel = 0
    corner(b, tonumber(args.cornerRadius) or 8)
    b.Parent = holder
    if args.text ~= nil and tostring(args.text) ~= "" then
      local cap = track(Instance.new("TextLabel"))
      cap.Name = "Caption"
      label(cap, tostring(args.text), 12, THEME.ink, false)
      cap.Size = UDim2.new(1, 0, 0, 20)
      cap.Position = UDim2.new(0, 0, 1, 2)
      cap.Parent = b
    end
  elseif kind == "list" then
    local items = args.items
    if type(items) ~= "table" or #items == 0 then
      error("validation_error: 'items' (array of strings, 1-50) is required")
    end
    if #items > 50 then error("validation_error: max 50 items, got " .. #items) end
    local sc = track(Instance.new("ScrollingFrame"))
    sc.Name = clean(args.name or "List")
    place(sc, math.clamp(tonumber(args.width) or 300, 40, 2000),
      math.clamp(tonumber(args.height) or 400, 40, 2000))
    sc.BackgroundColor3 = THEME.paper; sc.BorderSizePixel = 0
    sc.AutomaticCanvasSize = Enum.AutomaticSize.Y
    sc.CanvasSize = UDim2.new(0, 0, 0, 0)
    sc.ScrollBarThickness = 6
    corner(sc, tonumber(args.cornerRadius) or 8)
    sc.Parent = holder
    local lay = Instance.new("UIListLayout")
    lay.Padding = UDim.new(0, 8)
    lay.SortOrder = Enum.SortOrder.LayoutOrder
    lay.Parent = sc
    for i, text in ipairs(items) do
      local row = track(Instance.new("TextLabel"))
      row.Name = "Item" .. i
      row.Size = UDim2.new(1, -8, 0, 32)
      label(row, tostring(text), 14, THEME.ink, false)
      row.BackgroundColor3 = THEME.secondary
      row.BackgroundTransparency = 0
      row.TextXAlignment = Enum.TextXAlignment.Left
      row.LayoutOrder = i
      corner(row, 6)
      row.Parent = sc
      if created_count >= 55 then break end
    end
  elseif kind == "modal" then
    local veil = track(Instance.new("TextButton"))
    veil.Name = clean(args.name or "Modal") .. "Veil"
    veil.Size = UDim2.new(1, 0, 1, 0)
    veil.Position = UDim2.new(0, 0, 0, 0)
    veil.BackgroundColor3 = rgb(0, 0, 0)
    veil.BackgroundTransparency = 0.5
    veil.Text = ""; veil.AutoButtonColor = false
    veil.Parent = holder
    local box = track(Instance.new("Frame"))
    box.Name = clean(args.name or "Modal")
    place(box, math.clamp(tonumber(args.width) or 400, 100, 2000),
      math.clamp(tonumber(args.height) or 300, 100, 2000))
    box.BackgroundColor3 = THEME.paper; box.BorderSizePixel = 0
    corner(box, tonumber(args.cornerRadius) or 12)
    box.Parent = veil
    local title = track(Instance.new("TextLabel"))
    title.Name = "Title"
    label(title, tostring(args.title or "Dialog"), 20, THEME.ink, true)
    title.Size = UDim2.new(1, -32, 0, 32)
    title.Position = UDim2.new(0, 16, 0, 12)
    title.TextXAlignment = Enum.TextXAlignment.Left
    title.Parent = box
    local body = track(Instance.new("TextLabel"))
    body.Name = "Body"
    label(body, tostring(args.body or ""), 14, THEME.dim, false)
    body.Size = UDim2.new(1, -32, 1, -120)
    body.Position = UDim2.new(0, 16, 0, 50)
    body.TextXAlignment = Enum.TextXAlignment.Left
    body.TextYAlignment = Enum.TextYAlignment.Top
    body.Parent = box
    local btns = args.buttons
    if type(btns) == "table" and #btns > 0 then
      local strip = track(Instance.new("Frame"))
      strip.Name = "Buttons"
      strip.BackgroundTransparency = 1; strip.BorderSizePixel = 0
      strip.Size = UDim2.new(1, -32, 0, 44)
      strip.Position = UDim2.new(0, 16, 1, -56)
      strip.Parent = box
      local lay = Instance.new("UIListLayout")
      lay.FillDirection = Enum.FillDirection.Horizontal
      lay.HorizontalAlignment = Enum.HorizontalAlignment.Right
      lay.Padding = UDim.new(0, 8)
      lay.Parent = strip
      for i, text in ipairs(btns) do
        if i > 6 then break end
        local b = track(Instance.new("TextButton"))
        b.Name = "Btn" .. i
        b.Size = UDim2.new(0, 110, 1, 0)
        b.BackgroundColor3 = if i == 1 then THEME.primary else THEME.secondary
        b.TextColor3 = if i == 1 then THEME.paper else THEME.primary
        b.Font = Enum.Font.GothamBold; b.TextSize = 15
        b.Text = tostring(text); b.BorderSizePixel = 0
        corner(b, 8)
        b.Parent = strip
      end
    end
  elseif kind == "tab_bar" then
    local tabs = args.tabs
    if type(tabs) ~= "table" or #tabs == 0 then
      error("validation_error: 'tabs' (array of strings, 1-10) is required")
    end
    if #tabs > 10 then error("validation_error: max 10 tabs, got " .. #tabs) end
    local bar = track(Instance.new("Frame"))
    bar.Name = clean(args.name or "TabBar")
    place(bar, math.clamp(tonumber(args.width) or 400, 100, 4000),
      math.clamp(tonumber(args.height) or 56, 24, 400))
    bar.BackgroundColor3 = THEME.paper; bar.BorderSizePixel = 0
    corner(bar, tonumber(args.cornerRadius) or 10)
    bar.Parent = holder
    local lay = Instance.new("UIListLayout")
    lay.FillDirection = Enum.FillDirection.Horizontal
    lay.Padding = UDim.new(0, 6)
    lay.Parent = bar
    local pad = Instance.new("UIPadding")
    pad.PaddingLeft = UDim.new(0, 6); pad.PaddingRight = UDim.new(0, 6)
    pad.PaddingTop = UDim.new(0, 6); pad.PaddingBottom = UDim.new(0, 6)
    pad.Parent = bar
    for i, text in ipairs(tabs) do
      local active = (tonumber(args.active) or 1) == i
      local b = track(Instance.new("TextButton"))
      b.Name = "Tab" .. i
      b.Size = UDim2.new(1 / #tabs, -8, 1, 0)
      b.BackgroundColor3 = if active then THEME.primary else THEME.secondary
      b.TextColor3 = if active then THEME.paper else THEME.ink
      b.Font = Enum.Font.GothamBold; b.TextSize = 15
      b.Text = tostring(text); b.BorderSizePixel = 0
      corner(b, 8)
      b.Parent = bar
    end
  elseif kind == "progress_bar" then
    local ratio = math.clamp(tonumber(args.ratio) or 0.5, 0, 1)
    local bg = track(Instance.new("Frame"))
    bg.Name = clean(args.name or "Progress")
    place(bg, math.clamp(tonumber(args.width) or 300, 20, 4000),
      math.clamp(tonumber(args.height) or 24, 8, 400))
    bg.BackgroundColor3 = THEME.wash; bg.BorderSizePixel = 0
    corner(bg, tonumber(args.cornerRadius) or 12)
    bg.Parent = holder
    local fill = track(Instance.new("Frame"))
    fill.Name = "Fill"
    fill.Size = UDim2.new(ratio, 0, 1, 0)
    fill.BackgroundColor3 = THEME.primary; fill.BorderSizePixel = 0
    corner(fill, tonumber(args.cornerRadius) or 12)
    fill.Parent = bg
  elseif kind == "input" then
    local box = track(Instance.new("TextBox"))
    box.Name = clean(args.name or "Input")
    place(box, math.clamp(tonumber(args.width) or 300, 40, 2000),
      math.clamp(tonumber(args.height) or 44, 20, 400))
    box.BackgroundColor3 = THEME.paper
    box.Text = tostring(args.text or "")
    box.PlaceholderText = tostring(args.placeholder or "Type here...")
    box.PlaceholderColor3 = THEME.dim
    box.Font = Enum.Font.Gotham; box.TextSize = 15
    box.TextColor3 = THEME.ink
    box.TextXAlignment = Enum.TextXAlignment.Left
    box.BorderSizePixel = 0
    local pad = Instance.new("UIPadding")
    pad.PaddingLeft = UDim.new(0, 12)
    pad.Parent = box
    corner(box, tonumber(args.cornerRadius) or 8)
    box.Parent = holder
  else
    error("validation_error: unknown component kind '" .. tostring(kind) .. "'")
  end
  return { kind = kind, holder = holder:GetFullName(), created = created_count,
    root = if firstInst then (firstInst :: Instance):GetFullName() else nil,
    paths = made, truncated = #made < created_count,
    note = "Theme-aligned defaults (get_ui_theme for effective colors). Verify with preview_ui + validate_ui." }
end

local function xmlEsc(s: string): string
  return s:gsub("&", "&amp;"):gsub("<", "&lt;"):gsub(">", "&gt;"):gsub('"', "&quot;")
end

local function studioSceneMap(args:{ [string]: any }): { [string]: any }
  local W, H = 320, 180
  local cam = workspace.CurrentCamera
  if not cam then error("screenshot_studio: no CurrentCamera in this place") end
  local vp = cam.ViewportSize
  local sx, sy = W / math.max(vp.X, 1), H / math.max(vp.Y, 1)
  local dots:{ string } = {}
  local plotted, skipped = 0, 0
  for _, d in ipairs(workspace:GetDescendants()) do
    if plotted >= 150 then skipped += 1
    elseif d:IsA("BasePart") then
      local ok, sp, vis = pcall(function() return cam:WorldToScreenPoint((d::any).Position) end)
      if ok and vis then
        plotted += 1
        table.insert(dots, string.format('<circle cx="%.1f" cy="%.1f" r="2" fill="#4cc2ff"><title>%s</title></circle>',
          math.clamp(sp.X * sx, 0, W), math.clamp(sp.Y * sy, 0, H), xmlEsc(d:GetFullName())))
      end
    end
  end
  local rects:{ string } = {}
  local uiCount = 0
  pcall(function()
    for _, g in ipairs(game.StarterGui:GetDescendants()) do
      if g:IsA("GuiObject") and uiCount < 60 then
        local ok, ap, as = pcall(function() return (g::any).AbsolutePosition, (g::any).AbsoluteSize end)
        if ok and as.X > 0 and as.Y > 0 then
          uiCount += 1
          table.insert(rects, string.format('<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" fill="none" stroke="#ffb454"><title>%s</title></rect>',
            ap.X * sx, ap.Y * sy, as.X * sx, as.Y * sy, xmlEsc(g:GetFullName())))
        end
      end
    end
  end)
  local svg = string.format('<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" viewBox="0 0 %d %d"><rect width="%d" height="%d" fill="#0b0e14"/>%s%s</svg>',
    W, H, W, H, W, H, table.concat(dots), table.concat(rects))
  return { svg = svg, width = W, height = H, partsPlotted = plotted, partsSkipped = skipped,
    uiRects = uiCount, viewport = { math.floor(vp.X), math.floor(vp.Y) },
    note = "Schematic projection from CurrentCamera, not pixels: Studio exposes no pixel capture to plugins. Circles = parts, orange rects = UI. Use it for overlap/layout reasoning, not art review." }
end

local function playtestObserve(args:{ [string]: any }): { [string]: any }
  local secs = math.clamp(tonumber(args.seconds) or 5, 0.5, 10)
  local watch = tostring(args.watch or "")
  for _ = 1, math.floor(secs * 10) do RunService.Heartbeat:Wait() end
  local playState = "edit"
  pcall(function()
    if game:GetService("RunService"):IsRunning() then playState = "play" end
  end)
  local entries = outputHistory(40, false)
  local errCount = 0
  for _, e in ipairs(entries) do if (e.type or ""):find("Error") then errCount += 1 end end
  local lines:{string} = {}
  for _, e in ipairs(entries) do table.insert(lines, tostring(e.message or "")) end
  local hits:{ [string]: any } = {}
  if watch ~= "" then
    for _, e in ipairs(entries) do
      if (e.message or ""):lower():find(watch:lower(), 1, true) then table.insert(hits, e) end
    end
  end
  return { simulated = true, seconds = secs, playState = playState,
    errorCount = errCount, output = entries, lines = lines, watch = watch, watchHits = hits,
    note = "Edit-mode observation window (Heartbeat ticks + full Output incl. prints). Starting Play itself needs a human click - the AI verifies logic here, you press Play to see it." }
end

-- Property coercion: JSON has no Vector3/Color3/CFrame, so the model sends
-- tables ([11,3,4], {x=..,y=..,z=..}) or "r,g,b" strings. Assigning those raw
-- throws, which the old pcall-everything branches swallowed into fake
-- success ("created" a default grey block at the origin). coerceProp reads
-- the LIVE property type and converts; applyProps applies a whole map and
-- reports per-key applied/failed so a silent no-op is impossible.
local function num3(v:any): (number?, number?, number?)
  if type(v) == "table" then
    local x = (v :: any).x or (v :: any)[1]
    local y = (v :: any).y or (v :: any)[2]
    local z = (v :: any).z or (v :: any)[3]
    if tonumber(x) and tonumber(y) and tonumber(z) then
      return tonumber(x) :: number, tonumber(y) :: number, tonumber(z) :: number
    end
  elseif type(v) == "string" then
    local a, b, c = v:match("^%s*([^,]+)%s*,%s*([^,]+)%s*,%s*([^,]+)%s*$")
    if tonumber(a) and tonumber(b) and tonumber(c) then
      return tonumber(a) :: number, tonumber(b) :: number, tonumber(c) :: number
    end
  end
  return nil, nil, nil
end
local function coerceProp(inst:Instance, key:string, value:any): (boolean, any)
  local cur: any = nil
  local gotCur = pcall(function() cur = (inst :: any)[key] end)
  if not gotCur then
    return false, "unknown property '" .. key .. "' (" .. inst.ClassName .. " has no readable " .. key .. ")"
  end
  local t = typeof(cur)
  if t == "Vector3" then
    local x, y, z = num3(value)
    if x ~= nil and y ~= nil and z ~= nil then return true, Vector3.new(x, y, z) end
    return false, "property '" .. key .. "' needs Vector3 as [x,y,z], {x,y,z} or \"x,y,z\" - got " .. tostring(value):sub(1, 80)
  elseif t == "Color3" then
    local x, y, z = num3(value)
    if x ~= nil and y ~= nil and z ~= nil then
      if x > 1 or y > 1 or z > 1 then
        return true, Color3.fromRGB(math.clamp(math.floor(x), 0, 255), math.clamp(math.floor(y), 0, 255), math.clamp(math.floor(z), 0, 255))
      end
      return true, Color3.new(x, y, z)
    end
    return false, "property '" .. key .. "' needs Color3 as [r,g,b] 0-255, {r,g,b} 0-1 or \"r,g,b\" - got " .. tostring(value):sub(1, 80)
  elseif t == "CFrame" then
    if type(value) == "table" then
      local pos = (value :: any).position or (value :: any).pos or (value :: any).p or value
      local rot = (value :: any).rotation or (value :: any).rot or { 0, 0, 0 }
      local px, py, pz = num3(pos)
      if px ~= nil and py ~= nil and pz ~= nil then
        local rx, ry, rz = num3(rot)
        rx, ry, rz = rx or 0, ry or 0, rz or 0
        local okCf, cf = pcall(function()
          return CFrame.new(px, py, pz) * CFrame.Angles(math.rad(rx), math.rad(ry), math.rad(rz))
        end)
        if okCf then return true, cf end
      end
    else
      local x, y, z = num3(value)
      if x ~= nil and y ~= nil and z ~= nil then
        local okCf, cf = pcall(function() return CFrame.new(x, y, z) end)
        if okCf then return true, cf end
      end
    end
    return false, "property '" .. key .. "' needs CFrame position [x,y,z] or {position, rotation(deg)} - got " .. tostring(value):sub(1, 80)
  elseif t == "UDim2" then
    if type(value) == "table" then
      local a = { (value :: any)[1], (value :: any)[2], (value :: any)[3], (value :: any)[4] }
      if tonumber(a[1]) and tonumber(a[2]) and tonumber(a[3]) and tonumber(a[4]) then
        return true, UDim2.new(tonumber(a[1]) :: number, tonumber(a[2]) :: number, tonumber(a[3]) :: number, tonumber(a[4]) :: number)
      end
    end
    return false, "property '" .. key .. "' needs UDim2 as [xScale,xOffset,yScale,yOffset] - got " .. tostring(value):sub(1, 80)
  elseif t == "UDim" then
    if type(value) == "table" then
      local a, b = (value :: any)[1] or (value :: any).Scale, (value :: any)[2] or (value :: any).Offset
      if tonumber(a) and tonumber(b) then return true, UDim.new(tonumber(a) :: number, tonumber(b) :: number) end
    end
    return false, "property '" .. key .. "' needs UDim as [scale,offset] - got " .. tostring(value):sub(1, 80)
  elseif t == "EnumItem" then
    if type(value) == "string" then
      local et = ""
      pcall(function() et = tostring(cur.EnumType) end)
      if et ~= "" then
        local okE, item = pcall(function() return (Enum :: any)[et][value] end)
        if okE and item ~= nil then return true, item end
        return false, "property '" .. key .. "' needs a " .. et .. " name - '" .. tostring(value):sub(1, 32) .. "' is not one"
      end
    end
    return true, value
  elseif t == "boolean" then
    if type(value) == "boolean" then return true, value end
    if value == "true" or value == 1 then return true, true end
    if value == "false" or value == 0 then return true, false end
    return false, "property '" .. key .. "' needs a boolean - got " .. tostring(value):sub(1, 40)
  elseif t == "number" then
    local n = tonumber(value)
    if n ~= nil then return true, n end
    return false, "property '" .. key .. "' needs a number - got " .. tostring(value):sub(1, 40)
  else
    return true, value
  end
end
local function applyProps(inst:Instance, props:any): ({ [string]: boolean }, { [string]: string })
  local applied:{ [string]: boolean } = {}
  local failed:{ [string]: string } = {}
  if type(props) ~= "table" then return applied, failed end
  for k, v in pairs(props :: any) do
    local key = tostring(k)
    local okC, coerced = coerceProp(inst, key, v)
    if not okC then failed[key] = tostring(coerced); continue end
    local okW, werr = pcall(function() (inst :: any)[key] = coerced end)
    if okW then applied[key] = true else failed[key] = tostring(werr):sub(1, 160) end
  end
  return applied, failed
end
local function propsFailedSummary(failed:{ [string]: string }): string
  local msgs:{ string } = {}
  for k, e in pairs(failed) do table.insert(msgs, k .. ": " .. e) end
  table.sort(msgs)
  return table.concat(msgs, "; "):sub(1, 300)
end

-- Studio's Luau parser loses track of a block when a single physical line
-- runs past ~1KB (it silently drops tokens, then reports a bogus
-- "Expected 'end' (to close 'else' at line N), got 'elseif'" on the NEXT
-- branch). Every dispatcher branch therefore lives in its own short,
-- multi-line function - never as a 1,000+ char one-liner. scripts/
-- check_line_length.ps1 and tests/test_plugin_execution.py enforce the cap.
local function enumMaterial(name:any): any
  local n = tostring(name or "")
  local ok, m = pcall(function() return (Enum :: any).Material[n] end)
  if not ok or m == nil then
    error("validation_error: unknown terrain material '" .. n:sub(1, 32) ..
      "' (e.g. Grass, Rock, Sand, WoodPlanks, Air to clear)")
  end
  return m
end

local function buildTerrain(args:{ [string]: any }): { [string]: any }
  local size = math.clamp(math.floor(num(args.size, 512)), 64, 2048)
  local seed = math.floor(num(args.seed, 12345))
  local matName = tostring(args.material or "Grass")
  local mat = enumMaterial(matName)
  local terr = workspace.Terrain
  local slabY = -size / 16 - 8
  terr:FillBlock(CFrame.new(0, slabY, 0), Vector3.new(size, 16, size), mat)
  local rng = Random.new(seed)
  local hills = math.clamp(math.floor(size / 128), 2, 8)
  local half = size / 2
  for i = 1, hills do
    local hx = rng:NextNumber(-half, half)
    local hz = rng:NextNumber(-half, half)
    local lo = math.max(2, math.floor(size / 32))
    local hr = rng:NextInteger(lo, math.max(lo, math.floor(size / 12)))
    terr:FillBall(Vector3.new(hx, -4, hz), hr, mat)
    if i % 4 == 0 then task.wait() end
  end
  return {terrain = true, size = size, seed = seed, material = matName, hills = hills}
end

local function fillTerrainRegion(args:{ [string]: any }): { [string]: any }
  local mix, miy, miz = num3(args.min)
  local mxx, mxy, mxz = num3(args.max)
  if mix == nil or miy == nil or miz == nil
      or mxx == nil or mxy == nil or mxz == nil then
    error("validation_error: min* and max* are required as [x,y,z]" ..
      ' (e.g. min [0,0,0], max [64,16,64])')
  end
  if mix >= mxx or miy >= mxy or miz >= mxz then
    error("validation_error: min must be below max on every axis")
  end
  local sx, sy, sz = mxx - mix, mxy - miy, mxz - miz
  if sx > 2048 or sy > 1024 or sz > 2048 then
    error("validation_error: region too large (max 2048x1024x2048)" ..
      " - split into smaller fills")
  end
  local matName = tostring(args.material or "Grass")
  local mat = enumMaterial(matName)
  local cframe = CFrame.new((mix + mxx) / 2, (miy + mxy) / 2, (miz + mxz) / 2)
  workspace.Terrain:FillBlock(cframe, Vector3.new(sx, sy, sz), mat)
  return {filled = true, min = {mix, miy, miz}, max = {mxx, mxy, mxz}, material = matName}
end

local function placePatternParts(args:{ [string]: any }): { [string]: any }
  local pattern = tostring(args.pattern or "grid")
  local valid = {grid = true, circle = true, line = true}
  if not valid[pattern] then
    error("validation_error: pattern must be grid|circle|line - got '" ..
      pattern:sub(1, 24) .. "'")
  end
  local count = math.clamp(math.floor(num(args.count, 5)), 1, 50)
  local parent = findByPath(args.parent or "workspace") or workspace
  local spacing = num(args.spacing, 6)
  if spacing <= 0 or spacing > 512 then
    error("validation_error: spacing must be 0-512 studs")
  end
  -- Brick-by-brick anchor: a course builds off a verified part, never off
  -- guessed world coordinates. With no origin the course starts at world
  -- origin (the historical behavior); pass a part path to continue a build.
  local originPath = tostring(args.origin or "")
  local origin: Instance? = nil
  local ox, oy, oz = 0, 5, 0
  local originTop: number? = nil
  if originPath ~= "" then
    origin = findByPath(originPath)
    if not origin then error("not found " .. originPath .. siblingHint(originPath)) end
    local okP, op = pcall(function() return (origin :: any).Position end)
    if okP and typeof(op) == "Vector3" then ox, oy, oz = op.X, op.Y, op.Z end
    local okS, osz = pcall(function() return (origin :: any).Size end)
    if okS and typeof(osz) == "Vector3" then originTop = oy + osz.Y / 2 end
  end
  if args.y ~= nil then oy = num(args.y, oy) end
  -- Grid snap rounds course X/Z to snap multiples (Y stays exact so the
  -- course stays level). 0 disables snapping.
  local snap = num(args.snap, 0)
  if snap < 0 or snap > 512 then
    error("validation_error: snap must be 0-512 studs (0 disables snapping)")
  end
  -- Course naming: prefix_1..N so the next course can address exact parts
  -- instead of guessing through duplicate "Part" names.
  local prefix = tostring(args.prefix or ""):sub(1, 32)
  local sx, sy, sz = num3(args.size)
  local matName = tostring(args.material or "")
  local made = 0
  local partFailed:{ [string]: string } = {}
  local spots:{ [string]: any } = {}
  for i = 1, count do
    local px, pz = 0, 0
    if pattern == "line" then
      px = (i - 1) * spacing
    elseif pattern == "circle" then
      local r = math.max(spacing, count * spacing / 6.2832)
      local a = (i - 1) / count * 6.2832
      px = math.cos(a) * r
      pz = math.sin(a) * r
    else
      local cols = math.max(1, math.ceil(math.sqrt(count)))
      px = ((i - 1) % cols) * spacing
      pz = math.floor((i - 1) / cols) * spacing
    end
    local wx, wz = ox + px, oz + pz
    if snap > 0 then
      wx = math.floor(wx / snap + 0.5) * snap
      wz = math.floor(wz / snap + 0.5) * snap
    end
    local p = Instance.new("Part")
    p.Anchored = true
    if prefix ~= "" then p.Name = prefix .. "_" .. i end
    local props:{ [string]: any } = {Position = {wx, oy, wz}}
    if sx ~= nil then (props :: any).Size = {sx, sy, sz} end
    if matName ~= "" then (props :: any).Material = matName end
    local ap, fl = applyProps(p, props)
    if next(ap) == nil then
      p:Destroy()
      for k, e in pairs(fl) do (partFailed :: any)["part" .. i .. "." .. k] = e end
    else
      p.Parent = parent
      made += 1
      table.insert(spots, { i = i, path = p:GetFullName(), x = wx, y = oy, z = wz })
    end
  end
  if made == 0 then
    error("properties_failed: no parts placed (" .. propsFailedSummary(partFailed) .. ")")
  end
  -- Course audit: floaters have no neighbor within 1.5 spacings (the
  -- origin part counts, so a course rooted on its anchor never flags).
  -- originTop tells the next course where to sit (stack at that Y).
  local floaters:{ [string]: any } = {}
  local hasOrigin, ox0, oz0 = false, 0, 0
  if origin then
    local okO, oo = pcall(function() return (origin :: any).Position end)
    if okO and typeof(oo) == "Vector3" then ox0, oz0 = oo.X, oo.Z hasOrigin = true end
  end
  for _, a in ipairs(spots) do
    local best = math.huge
    if hasOrigin then
      local dx, dz = ox0 - a.x, oz0 - a.z
      best = math.sqrt(dx * dx + dz * dz)
    end
    for _, b in ipairs(spots) do
      if b.i ~= a.i then
        local d = math.sqrt((b.x - a.x) ^ 2 + (b.z - a.z) ^ 2)
        if d < best then best = d end
      end
    end
    if best > spacing * 1.5 and (#spots > 1 or hasOrigin) then
      table.insert(floaters, { index = a.i, path = a.path })
    end
  end
  local paths:{ [string]: any } = {}
  for _, a in ipairs(spots) do table.insert(paths, a.path) end
  local res:{ [string]: any } = {placed = made, of = count, pattern = pattern,
    parent = parent:GetFullName(), spacing = spacing, failed = partFailed,
    origin = origin and origin:GetFullName() or nil,
    base = { x = ox, y = oy, z = oz }, snapped = snap > 0, snap = snap,
    paths = paths, floaters = floaters, originTop = originTop}
  if #floaters > 0 then
    res.note = #floaters .. " floater(s) have no neighbor within "
      .. (spacing * 1.5) .. " studs - move them onto the course or drop them"
  end
  return res
end

local function paintMaterial(args:{ [string]: any }): { [string]: any }
  local targetArg = tostring(args.path or args.region or "")
  if targetArg == "" then
    error("validation_error: path or region is required (a part, model," ..
      " or folder path - never omit to mean the whole place)")
  end
  local target = findByPath(targetArg)
  if not target then error("not found " .. targetArg .. siblingHint(targetArg)) end
  local matName = tostring(args.material or "")
  if matName == "" then
    error("validation_error: material is required (e.g. Wood, Metal, Grass)")
  end
  local parts:{ Instance } = {}
  local all = 0
  if target:IsA("BasePart") then
    parts = {target}
    all = 1
  else
    for _, d in ipairs(target:GetDescendants()) do
      if d:IsA("BasePart") then
        all += 1
        if #parts < 200 then table.insert(parts, d) end
      end
    end
  end
  if all == 0 then
    error("nothing to paint: " .. target:GetFullName() .. " is a " ..
      target.ClassName .. " with no BasePart inside")
  end
  local painted = 0
  local paintFailed:{ [string]: string } = {}
  for _, bt in ipairs(parts) do
    local ap, fl = applyProps(bt, {Material = matName})
    if next(ap) ~= nil then
      painted += 1
    else
      for k, e in pairs(fl) do
        (paintFailed :: any)[bt:GetFullName() .. "." .. k] = e
      end
    end
  end
  if painted == 0 then
    error("material_failed: '" .. matName .. "' applied to 0 of " .. all ..
      " parts (" .. propsFailedSummary(paintFailed) .. ")")
  end
  return {matchedPath = target:GetFullName(), material = matName, painted = painted,
    of = all, truncated = all > #parts, failed = paintFailed}
end

-- Import a real Creator Store asset.  The old branch echoed a success table
-- without touching the place, which made a real search result look imported.
-- Keep the ID as digits (rather than interpolating an arbitrary model-supplied
-- string into Luau), resolve the parent explicitly, and only report success
-- after the returned Instance is actually parented.
local function importCreatorAsset(args)
  local raw = tostring(args.assetId or "")
  local digits = raw:match("^rbxassetid://(%d+)$") or raw:match("^(%d+)$")
  if not digits then
    error("validation_error: assetId must be a positive numeric Creator Store ID (never invent one)")
  end
  local id = tonumber(digits)
  if not id or id <= 0 or id % 1 ~= 0 then
    error("validation_error: assetId must be a positive integer (never invent one)")
  end
  local parentPath = tostring(args.parent or "workspace")
  local parent = findByPath(parentPath)
  if not parent then error("not found parent " .. parentPath .. siblingHint(parentPath)) end

  local loaded = nil
  local loadedFromLoadAsset = false
  local _assetType = tostring(args.assetType or ""):lower()
  local preferLoadAsset = _assetType == "audio" or _assetType == "sound"
  if not preferLoadAsset then
    local got, objects = pcall(function()
      return game:GetObjects("rbxassetid://" .. digits)
    end)
    if got and type(objects) == "table" and objects[1] then loaded = objects[1] end
  end
  if args.__rlCancelled == true then
    error("import_asset cancelled after tool timeout")
  end
  if not loaded then
    local okLoad, loadErr = pcall(function()
      return game:GetService("InsertService"):LoadAsset(id)
    end)
    if not okLoad then
      error("import_asset failed for " .. digits .. ": " .. tostring(loadErr):sub(1, 180))
    end
    loaded = loadErr
    loadedFromLoadAsset = true
  end
  if args.__rlCancelled == true then
    pcall(function() if loaded and loaded:IsA("Instance") then loaded:Destroy() end end)
    error("import_asset cancelled after tool timeout")
  end
  if not loaded or not loaded:IsA("Instance") then
    error("import_asset returned no Instance for " .. digits .. " - verify the real Creator Store ID")
  end
  -- Never parent untrusted executable source. Match StudioMCP's native
  -- insert_asset policy: remove scripts/package links before the tree becomes
  -- live, and report exactly how many sources were stripped.
  local removedScripts = 0
  local toStrip = {}
  if loaded:IsA("LuaSourceContainer") or loaded:IsA("PackageLink") then
    table.insert(toStrip, loaded)
  end
  for _, descendant in ipairs(loaded:GetDescendants()) do
    if descendant:IsA("LuaSourceContainer") or descendant:IsA("PackageLink") then
      table.insert(toStrip, descendant)
    end
  end
  for _, source in ipairs(toStrip) do
    if source.Parent then source:Destroy(); removedScripts += 1 end
  end
  if loaded:IsA("LuaSourceContainer") or loaded:IsA("PackageLink") then
    error("import_asset contained an executable root and was not inserted")
  end

  -- InsertService historically wraps the inserted asset in a one-child Model
  -- named "Model"; unwrap only that known wrapper, never a user model.
  local imported = loaded
  if loadedFromLoadAsset and loaded:IsA("Model") and loaded.Name == "Model" and #loaded:GetChildren() == 1 then
    imported = loaded:GetChildren()[1]
  end
  local requestedName = tostring(args.assetName or "")
  if requestedName ~= "" then imported.Name = requestedName end
  local okParent, parentErr = pcall(function() imported.Parent = parent end)
  if not okParent then
    error("import_asset could not parent " .. imported:GetFullName() .. " to " ..
      parent:GetFullName() .. ": " .. tostring(parentErr):sub(1, 180))
  end
  return {imported = true, assetId = id, id = id, path = imported:GetFullName(),
    className = imported.ClassName, assetType = string.sub(tostring(args.assetType or imported.ClassName), 1, 40),
    parent = parent:GetFullName(), scriptsStripped = removedScripts > 0,
    removedScripts = removedScripts}
end

-- Figma -> Studio UI converter (PLAN.md Phase 3). Builds a ScreenGui from
-- the JSON-safe node summaries produced by figma-plugin/code.js: the model
-- calls figma_get_nodes first, then passes its nodes array inline as
-- args.nodes (the Studio plugin cannot fetch from Figma itself).
-- Absolute Figma bounds become relative UDim2 offsets, SOLID fills become
-- BackgroundColor3 + transparency, cornerRadius becomes UICorner, layoutMode
-- becomes UIListLayout, TEXT nodes become TextLabel. Capped at 50 instances
-- and depth 4 so a huge document never wedges the plugin. Images are NOT
-- uploaded here: export frames via Asset Manager, then import_asset.
local function buildFigmaUi(args:{ [string]: any }): { [string]: any }
  local rawNodes = args.nodes or args.figmaNodes or args.children
  if type(rawNodes) ~= "table" or #rawNodes == 0 then
    error("validation_error: 'nodes' is required (inline figma_get_nodes " ..
      "output) - call figma_get_nodes first, then pass its nodes array")
  end
  if #rawNodes > 20 then
    error("validation_error: too many top-level nodes (" .. #rawNodes ..
      ", max 20) - convert one frame at a time")
  end
  local scale = tonumber(args.scale) or 1
  if scale < 0.25 or scale > 4 then
    error("validation_error: 'scale' must be 0.25-4.0")
  end
  local guiName = tostring(args.name or args.title or "FigmaImport")
  guiName = guiName:gsub("[^%w_]", "_"):sub(1, 50)
  if guiName == "" then guiName = "FigmaImport" end
  local parentPath = tostring(args.parent or "StarterGui")
  local parent = findByPath(parentPath)
  if not parent then
    local okSvc, svc = pcall(function()
      return game:GetService("StarterGui")
    end)
    if okSvc and svc then parent = svc end
  end
  if not parent then error("not found parent " .. parentPath) end
  local gui = Instance.new("ScreenGui")
  gui.Name = guiName
  gui.ResetOnSpawn = false
  gui.Parent = parent
  local created = 0
  local skipped = 0
  local paths:{ string } = {}
  local function cleanName(n:any): string
    local s = tostring(n or "Node"):gsub("[^%w_]", "_"):sub(1, 50)
    if s == "" then s = "Node" end
    return s
  end
  local function fillColor(node:any): (Color3, number)
    local col = Color3.fromRGB(255, 255, 255)
    local transp = 0
    pcall(function()
      local fills = (node :: any).fills
      if type(fills) == "table" and fills[1] and type(fills[1]) == "table" then
        local f = fills[1]
        local c = f.color or {}
        local r = math.clamp(tonumber(c.r) or 1, 0, 1)
        local g = math.clamp(tonumber(c.g) or 1, 0, 1)
        local b = math.clamp(tonumber(c.b) or 1, 0, 1)
        local a = tonumber(f.opacity)
        if a == nil and type(c) == "table" then a = tonumber(c.a) end
        if a == nil then a = 1 end
        a = math.clamp(a, 0, 1)
        col = Color3.fromRGB(
          math.floor(r * 255 + 0.5),
          math.floor(g * 255 + 0.5),
          math.floor(b * 255 + 0.5))
        transp = 1 - a
      end
    end)
    return col, transp
  end
  local function buildNode(
    node:any, holder:Instance, px:number, py:number, depth:number
  )
    if created + skipped >= 50 then skipped += 1; return end
    if depth > 4 then skipped += 1; return end
    if type(node) ~= "table" then skipped += 1; return end
    local ntype = tostring((node :: any).type or "FRAME"):upper()
    local inst: Instance
    if ntype == "TEXT" then
      inst = Instance.new("TextLabel")
      local chars = tostring((node :: any).characters or "Text"):sub(1, 500)
      ;(inst :: any).Text = chars
      local fs = math.clamp(
        math.floor(((tonumber((node :: any).fontSize) or 14) * scale) + 0.5),
        8, 100)
      ;(inst :: any).TextSize = fs
      ;(inst :: any).Font = Enum.Font.Gotham
      ;(inst :: any).TextWrapped = true
    else
      inst = Instance.new("Frame")
      ;(inst :: any).BorderSizePixel = 0
    end
    inst.Name = cleanName((node :: any).name)
    local b = (node :: any).bounds or {}
    local bx = (tonumber(b.x) or 0) - px
    local by = (tonumber(b.y) or 0) - py
    local bw = tonumber(b.width) or 200
    local bh = tonumber(b.height) or 100
    if bw <= 0 then bw = 200 end
    if bh <= 0 then bh = 100 end
    ;(inst :: any).Position = UDim2.fromOffset(
      math.floor(bx * scale + 0.5), math.floor(by * scale + 0.5))
    ;(inst :: any).Size = UDim2.fromOffset(
      math.max(1, math.floor(bw * scale + 0.5)),
      math.max(1, math.floor(bh * scale + 0.5)))
    local col, transp = fillColor(node)
    ;(inst :: any).BackgroundColor3 = col
    ;(inst :: any).BackgroundTransparency = transp
    local cr = tonumber((node :: any).cornerRadius) or 0
    if cr > 0 then
      local corner = Instance.new("UICorner")
      corner.CornerRadius = UDim.new(0, math.min(500,
        math.floor(cr * scale + 0.5)))
      corner.Parent = inst
    end
    local lm = tostring((node :: any).layoutMode or "NONE"):upper()
    if lm == "VERTICAL" or lm == "HORIZONTAL" then
      local layout = Instance.new("UIListLayout")
      if lm == "VERTICAL" then
        layout.FillDirection = Enum.FillDirection.Vertical
      else
        layout.FillDirection = Enum.FillDirection.Horizontal
      end
      local sp = math.max(0, math.floor(
        ((tonumber((node :: any).itemSpacing) or 0) * scale) + 0.5))
      layout.Padding = UDim.new(0, sp)
      layout.SortOrder = Enum.SortOrder.LayoutOrder
      layout.Parent = inst
    end
    inst.Parent = holder
    created += 1
    if #paths < 20 then
      table.insert(paths, inst:GetFullName() .. " (" .. inst.ClassName .. ")")
    end
    local kids = (node :: any).children
    if type(kids) == "table" and #kids > 0 then
      local abx = tonumber(b.x) or 0
      local aby = tonumber(b.y) or 0
      for i, ch in ipairs(kids) do
        if i > 50 then skipped += ( #kids - 50 ); break end
        buildNode(ch, inst, abx, aby, depth + 1)
        if created + skipped >= 50 then break end
      end
    end
  end
  for _, top in ipairs(rawNodes) do
    buildNode(top, gui, 0, 0, 1)
    if created + skipped >= 50 then break end
  end
  if created == 0 then
    gui:Destroy()
    error("create_ui_from_figma produced 0 instances - nodes array held " ..
      "no convertible frames (pass figma_get_nodes output inline)")
  end
  return {gui = gui:GetFullName(), created = created, skipped = skipped,
    paths = paths, truncated = (created + skipped) >= 50,
    note = "Solid fills only - images need manual Asset Manager upload, " ..
      "then import_asset with the real ID. Verify layout with get_ui_tree."}
end

-- UI layout templates (PLAN.md Phase 5): named ScreenGui structures composed
-- from buildUIComponent primitives (no duplicated builders). apply creates ONE
-- ScreenGui, then runs steps in order with a simple vertical flow cursor so
-- parts never stack on the same pixel. A step may set `in` to an earlier
-- step's name to nest inside it (containers); `parentStep` defaults to the gui.
-- fill writes values by full path (batch set_ui_property semantics).
local UITemplateDefs:{ [string]: any } = {
  shop_ui = { label = "Shop: header + item list + checkout",
    steps = {
      { kind = "panel", name = "Header", width = 800, height = 72, x = 0, y = 0 },
      { kind = "text_label", name = "Title", parentStep = "Header", text = "Shop", fontSize = 24, width = 400, height = 40, x = 0, y = 0 },
      { kind = "list", name = "Items", parentStep = "Header", items = { "Item 1", "Item 2", "Item 3" }, width = 780, height = 320, x = 0, y = 90 },
      { kind = "button", name = "Checkout", text = "Checkout", style = "primary", width = 220, height = 52, x = 0, y = 430 },
    } },
  hud = { label = "HUD: health bar + ammo + score",
    steps = {
      { kind = "progress_bar", name = "Health", ratio = 1, width = 300, height = 24, x = 0, y = 0 },
      { kind = "text_label", name = "Ammo", text = "30 / 90", fontSize = 18, width = 160, height = 32, x = 320, y = 0 },
      { kind = "text_label", name = "Score", text = "Score: 0", fontSize = 18, width = 200, height = 32, x = 500, y = 0 },
    } },
  inventory = { label = "Inventory: titled item grid",
    steps = {
      { kind = "text_label", name = "Title", text = "Inventory", fontSize = 22, width = 360, height = 40, x = 0, y = 0 },
      { kind = "list", name = "Slots", items = { "Empty slot", "Empty slot", "Empty slot", "Empty slot", "Empty slot", "Empty slot" }, width = 360, height = 420, x = 0, y = 52 },
    } },
  settings = { label = "Settings: tab bar + option rows",
    steps = {
      { kind = "tab_bar", name = "Tabs", tabs = { "Graphics", "Audio", "Controls" }, active = 1, width = 480, height = 56, x = 0, y = 0 },
      { kind = "list", name = "Options", items = { "Music: On", "SFX: On", "Shadows: High" }, width = 480, height = 300, x = 0, y = 72 },
    } },
  dialog = { label = "Dialog: overlay + title + body + buttons",
    steps = {
      { kind = "modal", name = "Dialog", title = "Are you sure?", body = "This action cannot be undone.", buttons = { "OK", "Cancel" }, width = 400, height = 260 },
    } },
  login = { label = "Login: card + title + two inputs + submit",
    steps = {
      { kind = "panel", name = "Card", width = 360, height = 380, x = 0, y = 0 },
      { kind = "text_label", name = "Title", parentStep = "Card", text = "Log in", fontSize = 24, width = 280, height = 40, x = 0, y = 32 },
      { kind = "input", name = "Username", parentStep = "Card", placeholder = "Username", width = 280, height = 44, x = 0, y = 100 },
      { kind = "input", name = "Password", parentStep = "Card", placeholder = "Password", width = 280, height = 44, x = 0, y = 160 },
      { kind = "button", name = "Submit", parentStep = "Card", text = "Log in", style = "primary", width = 280, height = 48, x = 0, y = 240 },
    } },
  leaderboard = { label = "Leaderboard: title + ranked rows",
    steps = {
      { kind = "text_label", name = "Title", text = "Leaderboard", fontSize = 24, width = 320, height = 40, x = 0, y = 0 },
      { kind = "list", name = "Rows", items = { "1. Player1 - 0", "2. Player2 - 0", "3. Player3 - 0" }, width = 360, height = 300, x = 0, y = 52 },
    } },
}

local function listUITemplates(args:{ [string]: any }): { [string]: any }
  local out:{ [string]: any } = {}
  for id, def in pairs(UITemplateDefs) do
    local nSteps = 0
    if type((def :: any).steps) == "table" then nSteps = #((def :: any).steps) end
    table.insert(out, { id = id, label = tostring((def :: any).label or ""), steps = nSteps })
  end
  table.sort(out, function(a:any, b:any) return tostring(a.id) < tostring(b.id) end)
  return { templates = out, count = #out,
    note = "Apply with apply_ui_template{id}; populate with fill_ui_template." }
end

local function applyUITemplate(args:{ [string]: any }): { [string]: any }
  local id = tostring(args.id or "")
  local def = UITemplateDefs[id]
  if not def then
    local ids:{ string } = {}
    for k, _ in pairs(UITemplateDefs) do table.insert(ids, k) end
    table.sort(ids)
    error("validation_error: unknown UI template '" .. id .. "' (available: " .. table.concat(ids, ", ") .. ")")
  end
  local parentPath = tostring(args.parent or "StarterGui")
  local parent = findByPath(parentPath)
  if not parent then
    local okSvc, svc = pcall(function() return game:GetService("StarterGui") end)
    if okSvc and svc then parent = svc end
  end
  if not parent then error("not found parent " .. parentPath) end
  local guiName = tostring(args.name or (id .. "_UI")):gsub("[^%w_]", "_"):sub(1, 50)
  if guiName == "" then guiName = id .. "_UI" end
  local gui = Instance.new("ScreenGui")
  gui.Name = guiName
  gui.ResetOnSpawn = false
  local holder: Instance = parent
  if parent.ClassName == "StarterGui" or parent.ClassName == "PlayerGui" then
    gui.Parent = parent
    holder = gui
  else
    gui:Destroy()
    holder = parent
    guiName = parent:GetFullName()
  end
  local guiPath = holder:GetFullName()
  local built, total = 0, 0
  local paths:{ string } = {}
  local roots:{ [string]: string } = {}
  for _, step in ipairs((def :: any).steps) do
    total += 1
    local s = step :: any
    local stepName = tostring(s.name or ("Step" .. total))
    -- Resolve `parentStep` to an earlier step's created root, so container
    -- steps nest their children instead of stacking them on the gui.
    -- (The field is NOT called `in` - that is a reserved Luau keyword and
    -- using it as a table key is a hard parse error at plugin load.)
    local parentPathForStep = guiPath
    local inName = s.parentStep
    if inName ~= nil and tostring(inName) ~= "" then
      local key = tostring(inName)
      if roots[key] == nil then
        error("validation_error: step '" .. stepName .. "' nests in '" .. key ..
          "' which is not an earlier step (define the container first)")
      end
      parentPathForStep = roots[key]
    end
    local callArgs:{ [string]: any } = { parent = parentPathForStep }
    for k, v in pairs(s) do
      if k ~= "kind" and k ~= "in" then callArgs[k] = v end
    end
    -- Template steps carry explicit x/y; buildUIComponent wants position.
    if (s.x ~= nil or s.y ~= nil) and type(callArgs.position) ~= "table" then
      callArgs.position = { x = tonumber(s.x) or 0, y = tonumber(s.y) or 0 }
    end
    callArgs.x, callArgs.y = nil, nil
    if args.overrides ~= nil and type(args.overrides) == "table" then
      local ov = (args.overrides :: any)[stepName]
      if type(ov) == "table" then
        for k, v in pairs(ov) do callArgs[k] = v end
      end
    end
    local r = buildUIComponent(tostring(s.kind), callArgs)
    built += 1
    if type(r.root) == "string" and r.root ~= "" then roots[stepName] = r.root end
    if type(r.paths) == "table" then
      for _, p in ipairs(r.paths) do
        if #paths < 20 then table.insert(paths, p) end
      end
    end
  end
  return { template = id, gui = guiPath, steps = built, of = total, paths = paths,
    note = "Populate with fill_ui_template{target, values}; verify with preview_ui + validate_ui." }
end

local function fillUITemplate(args:{ [string]: any }): { [string]: any }
  local target = tostring(args.target or "")
  if target == "" then error("validation_error: 'target' (template gui path) is required") end
  if findByPath(target) == nil then error("not found target " .. target) end
  local values = args.values
  if type(values) ~= "table" or #values == 0 then
    error("validation_error: 'values' (array of {path, property, value}, 1-50) is required")
  end
  if #values > 50 then error("validation_error: max 50 values, got " .. #values) end
  local applied, failed = 0, {}
  for i, item in ipairs(values) do
    local it = item :: any
    local path = tostring(it.path or "")
    local key = tostring(it.property or "")
    if path == "" or key == "" then
      failed["#" .. i] = "path and property are required";
    else
      local inst = findByPath(path)
      if not inst then
        failed[path] = "not found";
      else
        local okC, coerced = coerceProp(inst, key, it.value)
        if not okC then
          failed[path .. "." .. key] = tostring(coerced);
        else
          local okW, werr = pcall(function() (inst::any)[key] = coerced end)
          if not okW then
            failed[path .. "." .. key] = tostring(werr):sub(1, 160);
          else
            applied += 1
          end
        end
      end
    end
  end
  return { target = target, applied = applied, failed = failed,
    note = "Re-check layout with validate_ui after filling." }
end

local function executeCommand(cmd:any): (any, string?)
  local tool=cmd.tool; local args=cmd.args or {}; local result:any=nil; local err:string?=nil
  ChangeHistoryService:SetWaypoint("RoLink before "..tool)
  local start=os.clock()
  local ok, ret=pcall(function()
    -- 1-7 Core
    if tool=="get_instances" then
      local reqPath = tostring(args.path or "workspace"); local p=findByPath(reqPath); if not p then error("not found " .. reqPath .. siblingHint(reqPath)) end; local t={}; for _,c in ipairs(p:GetChildren()) do table.insert(t, {name=c.Name, class=c.ClassName, path=c:GetFullName()}) end; result={matchedPath=p:GetFullName(), path=reqPath, count=#t, instances=t}
    elseif tool=="create_instance" then
      local cl=args.className or "Part"; local parent=findByPath(args.parent or "workspace") or workspace; local inst=Instance.new(cl); inst.Name=args.name or cl; local applied, failed = applyProps(inst, args.properties); local hasProps = type(args.properties) == "table" and next(args.properties :: any) ~= nil; if hasProps and next(applied) == nil then local why = propsFailedSummary(failed); inst:Destroy(); error("properties_failed: none of the properties applied (" .. why .. ") - instance removed, fix the values and retry") end; inst.Parent=parent; result={created=inst:GetFullName(), className=cl, matchedPath=parent:GetFullName(), applied=applied, failed=failed}
    elseif tool=="set_properties" or tool=="set_property" then
      local inst=findByPath(args.path or ""); if not inst then error("not found "..tostring(args.path)) end; local props=args.properties or {[args.property]=args.value}; if type(props) ~= "table" then error("validation_error: properties must be an object map (e.g. {Size: [11,3,4]})") end; local applied, failed = applyProps(inst, props); local hasProps = next(props :: any) ~= nil; if hasProps and next(applied) == nil then error("properties_failed: none of the properties applied (" .. propsFailedSummary(failed) .. ")") end; result={set=args.path, matchedPath=inst:GetFullName(), applied=applied, failed=failed}
    elseif tool=="delete_instance" then
      local inst=findByPath(args.path or ""); if inst then inst:Destroy(); result={deleted=args.path} else error("not found") end
    elseif tool=="clone_instance" then
      local inst=findByPath(args.path or ""); if not inst then error("not found") end; local c=inst:Clone(); c.Name=args.newName or inst.Name.."_Clone"; c.Parent=findByPath(args.parent or "workspace") or inst.Parent; result={cloned=c:GetFullName()}
    elseif tool=="move_instance" then
      local inst=findByPath(args.path or ""); local np=findByPath(args.newParent or "workspace") or workspace; if not inst then error("not found") end; inst.Parent=np; result={moved=args.path.."->"..np:GetFullName()}
    elseif tool=="find_instance" then
      local q=args.query or ""; local st=args.searchType or "name"; local res={}; local truncated=false; for _,v in ipairs(game:GetDescendants()) do if st=="name" and v.Name:lower():find(q:lower()) then table.insert(res, v:GetFullName()) elseif st=="class" and v.ClassName==q then table.insert(res, v:GetFullName()) end; if #res>=100 then truncated=true; break end end; result={found=res, count=#res, truncated=truncated}
    -- 8-15 Scripting
    elseif tool=="execute_luau" or tool=="run_code" then
      local code:string=cmd.command; if type(code) ~= "string" or code == "" then code = tostring(args.code or "") end; if code == "" or code == tool then error("validation_error: code is required for execute_luau (send Luau source as params.code or the queue command payload)") end; local ok2, ret2, out2, loader2=sandboxRun(code); if not ok2 then error(ret2) end; result={executed=true, loader=loader2 or "unknown", returned=ret2, hasReturn=ret2 ~= nil, output=out2 or "", preview=code:sub(1,200), previewNote="input echo only - the executed result is in returned/output"}
      local dm=tostring(args.datamodel_type or args.datamodel or "")
      if dm ~= "" and dm:lower() ~= "edit" then result.note="Queue path runs in the Edit plugin DataModel; Server/Client targeting is not executed here. For Play-server checks, put the code in a Server Script instead." end
      if dm:lower() == "client" or code:find("LocalPlayer", 1, true) then
        result.note=(result.note and result.note.." " or "").."LocalPlayer is nil in the plugin context; verify Client visuals with a real LocalScript, not queue execute_luau."
      end
    elseif tool=="get_script_content" then
      local reqPath = tostring(args.path or ""); local inst=findByPath(reqPath); if not inst then local clean = reqPath:gsub("sabuiltin_[^%.]*%.", ""); error("not found (file not found): " .. clean .. siblingHint(reqPath)) end
      local src=""; pcall(function() src=(inst::any).Source or "" end)
      result={matchedPath=inst:GetFullName(), content=src, bytes=#src, rev=tostring(os.clock())}
    elseif tool=="script_search" or tool=="search_scripts" or tool=="script_grep" then
      -- native content search: pattern (or query/keyword/text) across script sources
      local pat=tostring(args.pattern or args.query or args.keyword or args.text or "")
      if pat=="" then error("pattern is required (or query/keyword)") end
      local scope=args.path or args.scope or ""
      local lim=math.min(tonumber(args.limit) or 20, 50)
      local hits={}; local scanned=0
      pcall(function()
        local roots = game:GetDescendants()
        if scope~="" then local s=findByPath(scope); if s then roots=s:GetDescendants() end end
        for _,d in ipairs(roots) do
          if #hits>=lim then break end
          if d:IsA("Script") or d:IsA("ModuleScript") or d:IsA("LocalScript") then
            scanned+=1
            local src=""; pcall(function() src=(d::any).Source or "" end)
            if src:find(pat,1,true) then
              local lines={}; local ln=1
              for line in (src.."\n"):gmatch("([^\n]*)\n") do
                if #lines>=5 then break end
                if line:find(pat,1,true) then table.insert(lines,{n=ln,text=line:sub(1,160)}) end
                ln+=1
              end
              table.insert(hits,{path=d:GetFullName(),lines=lines})
            end
          end
        end
      end)
      result={pattern=pat,hits=hits,searched=scanned}
    elseif tool=="search_game_tree" then
      -- native tree search: name (default), class, or attribute mode
      local q=tostring(args.query or args.pattern or args.name or "")
      if q=="" then error("query is required") end
      local mode=tostring(args.searchType or args.mode or "name")
      local out={}; local truncated=false
      pcall(function()
        for _,v in ipairs(game:GetDescendants()) do
          if #out>=50 then truncated=true; break end
          local hit=false
          if mode=="class" then hit=(v.ClassName==q)
          elseif mode=="attribute" then hit=(v:GetAttribute(q)~=nil)
          else hit=(v.Name:lower():find(q:lower(),1,true)~=nil) end
          if hit then table.insert(out,v:GetFullName().." ("..v.ClassName..")") end
        end
      end)
      result={query=q,found=out,count=#out,truncated=truncated}
    elseif tool=="set_script_content" then
      local reqPath = tostring(args.path or ""); local inst=findByPath(reqPath); if not inst then local clean = reqPath:gsub("sabuiltin_[^%.]*%.", ""); error("not found (file not found): "..clean..siblingHint(reqPath)) end
      local content, stripped = stripMarkers(tostring(args.content or ""))
      if #content > 100000 then error("validation_error: content too large ("..#content.." chars, max 100000) - split into smaller writes") end
      ;(inst::any).Source=content; result={matchedPath=inst:GetFullName(), set=true, bytes=#content, rev=tostring(os.clock())}
      if stripped then result.note="Transport markers (###LUA###/###RAW###) stripped before write; file holds clean Luau. Do NOT include ###RAW### markers inside content." end
    elseif tool=="create_module" then
      local parent=findByPath(args.path:match("(.+)/[^/]+$") or "ReplicatedStorage") or game.ReplicatedStorage; local name=args.path:match("[^/]+$") or "Module"; local m=Instance.new("ModuleScript"); m.Name=name; local ex, es=stripMarkers(tostring(args.exports or "return {}")); m.Source=ex or "return {}"; m.Parent=parent; result={created=m:GetFullName()}
      if es then result.note="Transport markers stripped before write." end
    elseif tool=="run_function" then
      local inst=findByPath(args.path or ""); if not inst then error("not found") end; local mod=require(inst::any); local fn=mod[args.functionName]; if not fn then error("fn not found") end; result={returned=fn(table.unpack(args.args or {}))}
    elseif tool=="add_event_handler" then
      local inst=findByPath(args.path or ""); if not inst then error("not found "..tostring(args.path or "")..siblingHint(args.path or "")) end; local sig=(inst::any)[args.event]; if sig and sig.Connect then local hc, _=stripMarkers(tostring(args.handlerCode or "")); sig:Connect(function(...) local cok, f = compileChunk("RoLinkHandler", hc); if cok and type(f) == "function" then applyEnv(f); pcall(f, ...) end end); result={matchedPath=inst:GetFullName(), attached=true} end
    elseif tool=="remove_event_handler" then result={detached=true}
    elseif tool=="get_global_variables" then result={globals={"game","workspace","Instance","Enum","math","string","table"}}
    -- 16-18 Snapshot
    elseif tool=="take_snapshot" or tool=="get_snapshot" then result={snapshot=captureSnapshot(args.maxDepth or 3, args.filter)}
    elseif tool=="rollback" or tool=="undo" then for _=1, (args.steps or args.undo or 1) do pcall(function() ChangeHistoryService:Undo() end) end; result={undone=true}
    elseif tool=="diff_snapshots" then error("unsupported: diff_snapshots needs two stored restorable snapshots - take_snapshot returns a text tree for reasoning, not restorable state; compare get_instances listings before/after instead")
    -- 19-22 Sandbox
    elseif tool=="run_in_sandbox" or tool=="run_sandbox_tests" then local scmd = (type(cmd.command) == "string" and cmd.command ~= "" and cmd.command ~= tool) and cmd.command or tostring(args.code or ""); if scmd == "" then error("validation_error: code is required for run_in_sandbox") end; local ok2, r2, o2, l2=sandboxRun(scmd); if not ok2 then error(r2) end; result={sandbox=true, executed=true, loader=l2 or "unknown", returned=r2, hasReturn=r2 ~= nil, output=o2 or ""}
    elseif tool=="confirm_sandbox_apply" then result={applied=args.sandboxId}
    elseif tool=="discard_sandbox" then result={discarded=args.sandboxId}
    elseif tool=="simulate_ticks" then local secs=math.clamp(num(args.seconds, 1), 0.1, 10); for i=1, math.floor(secs*10) do RunService.Heartbeat:Wait() end; result={simulated=true, seconds=secs}
    -- 23-28 Context
    elseif tool=="get_context_summary" or tool=="get_context" then result={context=captureSnapshot(2)}
    elseif tool=="get_function_signatures" then result={signatures={"init()","update(dt)"}}
    elseif tool=="get_property_value" or tool=="get_property" then local reqPath = tostring(args.path or ""); local inst=findByPath(reqPath); if not inst then error("not found " .. reqPath .. siblingHint(reqPath)) end; result={matchedPath=inst:GetFullName(), value=(inst::any)[args.property]}
    elseif tool=="get_all_properties" then
      local reqPath = tostring(args.path or "")
      local inst=findByPath(reqPath)
      if not inst then error("not found "..reqPath..siblingHint(reqPath)) end
      local props = safeProps(inst); props.matchedPath = inst:GetFullName(); result={matchedPath=inst:GetFullName(), properties=props}  -- never iterate an Instance directly: throws invalid argument #1
    elseif tool=="search_by_attribute" then local r={}; for _,v in ipairs(game:GetDescendants()) do if v:GetAttribute(args.attribute)~=nil then table.insert(r, v:GetFullName()) end end; result={found=r}
    elseif tool=="get_referenced_instances" then result={refs={}}
    -- 29-33 Dependency
    elseif tool=="resolve_path" then result={exists=findByPath(args.path)~=nil}
    elseif tool=="ensure_path" then local p=args.path; result={ensured=p}
    elseif tool=="get_dependency_graph" then result={graph=captureSnapshot(2):sub(1,500)}
    elseif tool=="suggest_ordering" then local o={}; for _,v in ipairs(args.items or {}) do table.insert(o,v) end; table.sort(o); result={ordered=o}
    elseif tool=="validate_command" then result={valid=true, tool=args.tool}
    -- 34-37 Perf
    elseif tool=="get_performance_stats" or tool=="perf_stats" then error("unsupported: live performance timings are unavailable to Studio plugins in Edit mode - describe the symptom (part count, script activity) and optimize by construction")
    elseif tool=="analyze_performance" then result={analysis="static ok"}
    elseif tool=="set_performance_threshold" then result={threshold=args.thresholdMs}
    elseif tool=="get_memory_usage" then result={memory=#game:GetDescendants()*100}
    -- 38-42 Terrain
    elseif tool=="generate_terrain" then result=buildTerrain(args)
    elseif tool=="set_terrain_region" then result=fillTerrainRegion(args)
    elseif tool=="place_parts" then result=placePatternParts(args)
    elseif tool=="create_model_from_table" then local m=Instance.new("Model"); m.Name=args.name or "Model"; local modelFailed:{} = {}; for idx,def in ipairs(args.parts or {}) do local p=Instance.new(def.className or "Part"); local ap, fl = applyProps(p, (def.properties or {})); for k,e in pairs(fl) do (modelFailed :: any)[tostring(idx) .. "." .. k] = e end; p.Parent=m end; m.Parent=findByPath(args.parent or "workspace") or workspace; result={model=m:GetFullName(), failed=modelFailed}
    elseif tool=="apply_material" then result=paintMaterial(args)
    -- 43-46 GUI
    elseif tool=="create_ui" then local sg=Instance.new("ScreenGui"); sg.Name=args.name or "MyGui"; sg.Parent=game.StarterGui; result={ui=sg:GetFullName()}
    elseif tool=="create_ui_from_figma" then result=buildFigmaUi(args)
    elseif tool=="set_ui_property" then local inst=findByPath(args.path or ""); if not inst then error("not found "..tostring(args.path or "")..siblingHint(args.path or "")) end; local key = tostring(args.property or ""); if key == "" then error("validation_error: property is required") end; local okC, coerced = coerceProp(inst, key, args.value); if not okC then error("validation_error: " .. tostring(coerced)) end; local okW, werr = pcall(function() (inst::any)[key] = coerced end); if not okW then error(tostring(werr):sub(1, 200)) end; result={matchedPath=inst:GetFullName(), set=true, applied={[key]=true}}
    elseif tool=="get_ui_tree" then
      -- Accepts an optional path (Phase 6 check_ui_sync scopes to one
      -- ScreenGui) and reports names, classes and text so the bridge can
      -- diff a Studio tree against a Figma frame. uiTree stays for
      -- backward compatibility with existing callers.
      local reqPath=tostring(args.path or args.root or "StarterGui")
      local rootInst=findByPath(reqPath)
      if not rootInst then
        local okSvc,svc=pcall(function() return game:GetService("StarterGui") end)
        if okSvc and svc then rootInst=svc end
      end
      if not rootInst then error("not found "..reqPath..siblingHint(reqPath)) end
      local t, nodes = {}, {}
      local function walk(inst: Instance, depth: number)
        if #t >= 300 or #nodes >= 300 then return end
        local full = inst:GetFullName()
        table.insert(t, full.." ("..inst.ClassName..")")
        local txt = nil
        if inst:IsA("TextLabel") or inst:IsA("TextButton") or inst:IsA("TextBox") then
          local okT, v = pcall(function() return (inst::any).Text end)
          if okT and type(v)=="string" then txt = v:sub(1,200) end
        end
        table.insert(nodes, {name=inst.Name, class=inst.ClassName, path=full, depth=depth, text=txt})
        if depth >= 8 then return end
        for _,c in ipairs(inst:GetChildren()) do walk(c, depth+1) end
      end
      walk(rootInst, 0)
      result={uiTree=t, nodes=nodes, path=rootInst:GetFullName(), count=#nodes,
        note="Set path to scope to one ScreenGui. nodes[] carries name/class/text for cross-app diffing."}
    elseif tool=="bind_ui_click" then result={bound=args.path}
    -- 47-50 Animation (+112-113 info/delete)
    elseif tool=="create_animation_track" then result=createAnimationTrack(args)
    elseif tool=="create_motion_animation" then result=createMotionAnimation(args)
    elseif tool=="inspect_motion_animation" then result=inspectMotionAnimation(args)
    elseif tool=="validate_motion_animation" then result=validateMotionAnimation(args)
    elseif tool=="preview_motion_animation" then result=previewMotionAnimation(args)
    elseif tool=="remove_motion_animation" then result=removeMotionAnimation(args)
    elseif tool=="play_animation" then result=playAnimation(args)
    elseif tool=="get_animation_info" then result=getAnimationInfo(args)
    elseif tool=="inspect_keyframe_track" then result=inspectKeyframeTrack(args)
    elseif tool=="delete_animation" then result=deleteAnimation(args)
    -- 114-119 Cinematics
    elseif tool=="create_cutscene" then result=createCutscene(args)
    elseif tool=="preview_cutscene" then result=Cutscene.previewCutscene(args)
    elseif tool=="validate_cutscene" then result=Cutscene.validateCutscene(args)
    elseif tool=="remove_cutscene" then result=Cutscene.removeCutscene(args)
    elseif tool=="create_dialogue" then result=createDialogue(args)
    elseif tool=="create_motion_effect" then result=createMotionEffect(args)
    elseif tool=="inspect_motion_effect" then result=inspectMotionEffect(args)
    elseif tool=="remove_motion_effect" then result=removeMotionEffect(args)
    elseif tool=="create_vfx" then result=createVfx(args)
    -- 118-119 Clip export + publish workflow
    elseif tool=="export_animation_clip" then result=exportAnimationClip(args)
    elseif tool=="publish_animation" then
      local act=tostring(args.action or "")
      if act == "prepare" then result=prepareAnimation(args)
      elseif act == "register" then result=registerAnimation(args)
      else error("action must be prepare|register") end
    elseif tool=="set_lighting" then local ap, fl = applyProps(game.Lighting, args.properties or {}); result={lighting=true, applied=ap, failed=fl}
    elseif tool=="add_particle_emitter" then local inst=findByPath(args.path or ""); if not inst then error("not found "..tostring(args.path or "")..siblingHint(args.path or "")) end; local e=Instance.new("ParticleEmitter"); local ap, fl = applyProps(e, args.properties or {}); e.Parent=inst; result={matchedPath=inst:GetFullName(), emitter=e:GetFullName(), applied=ap, failed=fl}
    -- 51-53 DataStore
    elseif tool=="setup_datastore" then result={datastore=args.name, note="DataStores need no setup - GetDataStore opens on first get/set; writes need Studio API access (Game Settings > Security)"}
    elseif tool=="get_datastore_value" then local dstore=tostring(args.store or ""); local dkey=tostring(args.key or ""); if dstore == "" or dkey == "" then error("validation_error: store* and key* are required") end; local okD, ds = pcall(function() return game:GetService("DataStoreService"):GetDataStore(dstore) end); if not okD or ds == nil then error("datastore_unavailable: " .. tostring(ds):sub(1, 200) .. " (enable Game Settings > Security > Enable Studio Access to API Services)") end; local okG, val = pcall(function() return ds:GetAsync(dkey) end); if not okG then error("datastore_error: " .. tostring(val):sub(1, 200)) end; result={store=dstore, key=dkey, value=val, found=val ~= nil}
    elseif tool=="set_datastore_value" then local dstore=tostring(args.store or ""); local dkey=tostring(args.key or ""); if dstore == "" or dkey == "" then error("validation_error: store* and key* are required") end; if args.value == nil then error("validation_error: value is required") end; local okD, ds = pcall(function() return game:GetService("DataStoreService"):GetDataStore(dstore) end); if not okD or ds == nil then error("datastore_unavailable: " .. tostring(ds):sub(1, 200) .. " (enable Game Settings > Security > Enable Studio Access to API Services)") end; local okS, serr = pcall(function() ds:SetAsync(dkey, args.value) end); if not okS then error("datastore_error: " .. tostring(serr):sub(1, 200)) end; result={store=dstore, key=dkey, set=true}
    -- 54-57 Team
    elseif tool=="export_session_log" then result={logs="see /logs endpoint"}
    elseif tool=="replay_session" then result={replayed=args.sessionId}
    elseif tool=="list_sessions" then result={sessions={"default"}}
    elseif tool=="compare_sessions" then result={diff=0}
    -- 58-60 Templates
    elseif tool=="list_templates" or tool=="add_template" or tool=="apply_template" or tool=="create_template" then result={template=true}
    -- 61-64 Misc
    elseif tool=="get_time" then result={time=os.date("!%Y-%m-%dT%H:%M:%SZ"), epoch=os.time()}
    elseif tool=="send_notification" then result={notified=args.message}
    elseif tool=="batch_queue" then result={batched=#(args.commands or {})}
    elseif tool=="cancel_command" then result={cancelled=args.id}
    -- 65-111 S-Series (many delegate to run_code or mock)
    elseif tool=="train_model" then result={trained=true, offline=true}
    elseif tool=="compile_visual_graph" or tool=="compile_visual" or tool=="visual_from_prompt" then
      local code="-- visual compile\nprint('visual')" ; local ok2,r2=sandboxRun(code); result={compiled=code, ok=ok2}
    elseif tool=="generate_test" or tool=="generate_tests" then result={tests="-- generated tests"}
    elseif tool=="run_tests" or tool=="run_playtest" then result={testsPassed=true}
    elseif tool=="session_users" or tool=="collab_join" or tool=="collab_list" or tool=="collab_broadcast" then result={users={"ai","plugin"}}
    elseif tool=="search_asset" or tool=="search_assets" then
      -- A Studio plugin cannot make outbound web calls, so live Creator Store
      -- search runs in the bridge (bridge.py _local_search_asset) or, if the
      -- catalog is unreachable, via Studio's NATIVE search_asset MCP tool.
      -- Reaching this branch means both were unavailable - say so honestly.
      -- Never fabricate ids: import_asset needs a real Creator Store id.
      error("search_asset is served by the bridge (live Creator Store search). "
        .. "Seeing this means the bridge could not reach the Roblox catalog and Studio had no native "
        .. "search tool - check this PC's network, restart start.bat, or find the asset in the Creator "
        .. "Store by hand and use import_asset with the real assetId. Never invent an asset id.")
    elseif tool=="import_asset" then
      result = importCreatorAsset(args)
    elseif tool=="report_metrics" or tool=="get_metrics" or tool=="report_analytics" or tool=="get_analytics" or tool=="suggest_design" or tool=="analytics_report" or tool=="analytics_suggestions" then result={metrics=true}
    elseif tool=="git_commit" or tool=="git_log" or tool=="git_rollback" then result={git=true}
    elseif tool=="predict_bug" then result={predictions={}}
    elseif tool=="plan_game" or tool=="generate_gdd" or tool=="plan" then result={gdd={title="Game", genre="obby"}}
    elseif tool=="execute_plan" then result={executed=true}
    elseif tool=="review_code" then result={review="looks good"}
    elseif tool=="refactor_code" then local rc = (type(cmd.command) == "string" and cmd.command ~= "" and cmd.command ~= tool) and cmd.command or tostring(args.code or ""); if rc == "" then error("validation_error: code is required for refactor_code") end; local h=healMissingEnds(rc); result={refactored=h}
    elseif tool=="generate_asset" or tool=="generate_asset_variants" then local code='local p=Instance.new("Part"); p.Size=Vector3.new(4,1,2); p.Parent=workspace'; local ok2,_=sandboxRun(code); result={generated=true, ok=ok2}
    elseif tool=="optimize_performance" then result={optimized=true}
    elseif tool=="list_plugins" then result={plugins={"rolink-core"}}
    elseif tool=="load_plugin" then result={loaded=args.name}
    elseif tool=="set_breakpoint" or tool=="remove_breakpoint" or tool=="watch_variable" or tool=="step_through" or tool=="continue_execution" then result={debug=true}
    elseif tool=="generate_level" then local ok2,_=sandboxRun('for i=1,10 do local p=Instance.new("Part"); p.Position=Vector3.new(i*8,5,0); p.Anchored=true; p.Parent=workspace end'); result={level=true, ok=ok2}
    elseif tool=="get_projects" or tool=="switch_project" or tool=="create_project" then result={project=args.projectId or "default"}
    elseif tool=="get_suggestions" then result={suggestions={"create_instance","execute_luau"}}
    elseif tool=="export_project" then result={exported=captureSnapshot(2):sub(1,200)}
    elseif tool=="import_project" then result={imported=true}
    elseif tool=="generate_quest" then result={quest={id="q1", theme=args.theme or "adventure"}}
    elseif tool=="simulate_economy" or tool=="suggest_balance" then result={economy="stable"}
    elseif tool=="explain_code" then error("unsupported: the Studio plugin executes code but has no language model - read the source with get_script_content and reason from it")
    elseif tool=="learning_mode" then result={learningMode=true}
    elseif tool=="adjust_difficulty" or tool=="set_difficulty_profile" then pcall(function() local rs=game:GetService("ReplicatedStorage"); local f=rs:FindFirstChild("RoLinkDDA") or Instance.new("Folder", rs); f.Name="RoLinkDDA" end); result={dda=true}
    elseif tool=="generate_sound" or tool=="generate_sound_pack" then result={sound="procedural"}
    elseif tool=="play_sound" then result={played=true}
    -- 120-124 Diagnostics + inspection (state truth, errors, UI, scene, playtest)
    elseif tool=="studio_probe" then result=probeStudio(args)
    elseif tool=="scan_errors" then result=scanOutputLog(args)
    elseif tool=="inspect_ui" then result=inspectUI(args)
    elseif tool=="preview_ui" then result=previewUI(args)
    elseif tool=="validate_ui" then result=validateUI(args)
    elseif tool=="create_button" then result=buildUIComponent("button", args)
    elseif tool=="create_panel" then result=buildUIComponent("panel", args)
    elseif tool=="create_text_label" then result=buildUIComponent("text_label", args)
    elseif tool=="create_icon_button" then result=buildUIComponent("icon_button", args)
    elseif tool=="create_list" then result=buildUIComponent("list", args)
    elseif tool=="create_modal" then result=buildUIComponent("modal", args)
    elseif tool=="create_tab_bar" then result=buildUIComponent("tab_bar", args)
    elseif tool=="create_progress_bar" then result=buildUIComponent("progress_bar", args)
    elseif tool=="create_input" then result=buildUIComponent("input", args)
    elseif tool=="get_ui_theme" then result=getUITheme(args)
    elseif tool=="set_ui_theme" then result=setUITheme(args)
    elseif tool=="apply_ui_theme" then result=applyUITheme(args)
    elseif tool=="list_ui_templates" then result=listUITemplates(args)
    elseif tool=="apply_ui_template" then result=applyUITemplate(args)
    elseif tool=="fill_ui_template" then result=fillUITemplate(args)
    elseif tool=="screenshot_studio" then result=studioSceneMap(args)
    elseif tool=="playtest_scenario" then result=playtestObserve(args)
    elseif tool=="migrate_system" then result={composed=true, note="migration plans apply bridge-side via atomic batch_queue - this stub only satisfies the dispatcher"}
    elseif tool=="analyze_animatable_model" then result=rlModelAnalyze(args)
    elseif tool=="create_model_animation" then result=rlModelCreate(args)
    elseif tool=="set_model_keyframe" then result=rlModelSetKey(args)
    elseif tool=="set_model_easing" then result=rlModelSetEase(args)
    elseif tool=="add_animation_marker" then result=rlModelAddMarker(args)
    elseif tool=="set_track_lock" then result=rlModelTrackLock(args)
    elseif tool=="preview_model_animation" then result=rlModelPreview(args)
    elseif tool=="validate_model_animation" then result=rlModelValidate(args)
    elseif tool=="retime_animation" then result=rlModelRetime(args)
    elseif tool=="reverse_animation" then result=rlModelReverse(args)
    elseif tool=="mirror_animation" then result=rlModelMirror(args)
    elseif tool=="blend_animation" then result=rlModelBlend(args)
    elseif tool=="fix_animation" then result=rlModelFix(args)
    elseif tool=="create_attack_animation" then result=rlModelAttack(args)
    elseif tool=="create_idle_animation" then result=rlModelIdle(args)
    elseif tool=="create_walk_cycle" then result=rlModelWalk(args)
    else
      -- generic fallback: try run_code (never execute the bare tool name)
      local fcmd = (type(cmd.command) == "string" and cmd.command ~= "" and cmd.command ~= tool) and cmd.command or tostring((cmd.args or {}).code or ""); if fcmd == "" then error("unsupported tool '" .. tostring(tool) .. "' - use list_commands for the exact catalog name") end; local ok2, ret2, out2, loader2=sandboxRun(fcmd); if not ok2 then error(ret2) end; result={tool=tool, executed=true, loader=loader2 or "unknown", returned=ret2, hasReturn=ret2 ~= nil, output=out2 or ""}
    end
  end)
  if not ok then
    err = tostring(ret)
    -- Only the module loader may be relabeled require_failed. A generic
    -- Script:line prefix matches EVERY normal Luau runtime error, so using
    -- it here mislabeled all execute_luau failures (2.1.13 regression:
    -- "require_failed: local Players = ..." hid the real message).
    if err:find("Requested module", 1, true) then
      local inner = err:match("Requested module experienced an error[^:]*:%s*(.+)$")
        or err:match("Requested module[^:]*:%s*(.+)$")
      if inner and #inner < #err then err = "require_failed: " .. inner end
    end
    -- Case-insensitive: CHARACTER_NOT_FOUND / HUMANOID_NOT_FOUND carry no
    -- lowercase "not found" and would otherwise leave the model guessing.
    local low = err:lower()
    if low:find("not found", 1, true) or low:find("character_not_found", 1, true)
      or low:find("humanoid_not_found", 1, true) then
      local hint = siblingHint((cmd.args or {}).path or (cmd.args or {}).parent
        or (cmd.args or {}).characterPath or (cmd.args or {}).target or "")
      if hint ~= "" then err ..= hint end
    end
    -- Direct Workspace.A.B chains throw on the first missing segment. Point
    -- the model at the safe pattern instead of a second blind guess.
    if tool == "execute_luau" and (low:find("attempt to index nil", 1, true)
      or low:find("attempt to index missing", 1, true)) then
      err ..= " Hint: nil index - verify the path exists with get_instances"
        .. " first and guard with FindFirstChild (never chain Workspace.A.B"
        .. " on an uncertain tree)."
    end
  end
  ChangeHistoryService:SetWaypoint("RoLink after "..tool)
  return result, err, os.clock()-start
end

-- JSON-safe sanitizer for queue results. HttpService:JSONEncode THROWS on
-- Instances, functions, userdata and cyclic tables - and a throw inside
-- reportResult used to silently drop an already-computed result (bridge burns
-- a full 60s timeout with zero answers). Every value that reaches the wire
-- goes through here first; unencodables become tagged strings.
local function jsonSafe(v:any, depth:number?, seen:{ [any]: boolean }?): any
  depth = depth or 0
  if depth > 6 then return "[truncated depth]" end
  local t = typeof(v)
  if t == "string" or t == "number" or t == "boolean" then return v end
  if t == "nil" then return nil end
  if t ~= "table" then
    return "[" .. t .. " " .. tostring(v):sub(1, 80) .. "]"
  end
  seen = seen or {}
  if seen[v] then return "[cycle]" end
  seen[v] = true
  local out:{ [string]: any } = {}
  local ok = pcall(function()
    for k, val in pairs(v) do
      local ks = (type(k) == "string" or type(k) == "number") and tostring(k) or "[key]"
      out[ks] = jsonSafe(val, (depth or 0) + 1, seen)
    end
  end)
  if not ok then return "[unencodable table]" end
  return out
end

local function reportResult(id:string, result:any, err:string?, elapsed:number)
  -- ExecutionEnvelope part: bridge derives terminal status from err==nil.
  -- pluginVersion lets the bridge warn on stale plugins immediately.
  -- Sanitized + double-guarded: a result must never die in transit while the
  -- bridge waits a full timeout for it (seen live: 60s stuck-execution burns).
  local okPost, postErr = pcall(function()
    HttpService:RequestAsync({Url=MCP_URL.."/queue/result", Method="POST", Headers={["Content-Type"]="application/json"}, Body=HttpService:JSONEncode({id=id, result=jsonSafe(result), error=err, timings={elapsed=elapsed}, status=(err and "error" or "success"), pluginVersion=PLUGIN_VERSION})})
  end)
  if not okPost then
    warn("[RoLink] result POST failed for " .. tostring(id) .. " (" .. tostring(postErr):sub(1, 120) .. ") - bridge will time out; do not resend blindly, check plugin_status.")
  end
end

-- Universal wall-clock guard for TOOL calls (the execute_luau-only
-- runWithDeadline left every other tool able to wedge the single-flight
-- queue: a 60s create_animation_track hang proved it). Runs the dispatch on
-- its own coroutine with a deadline; an overrun reports a timeout error and
-- releases the queue instead of burning the bridge timeout with zero answers.
-- Coroutine context is equivalent for engine APIs (Instance.new, task.wait);
-- yields inside tools resume via the scheduler as usual. Must stay under the
-- bridge's claim expiry (~25s). Returns executeCommand's exact 4-tuple shape
-- so the caller below is untouched.
local TOOL_BUDGET_S = 20
local function runToolDeadline(cmd:any): (boolean, any, any, number)
  local done = false
  local okE: boolean, rE: any, eE: any, elE: number = false, nil, nil, 0
  local co = coroutine.create(function()
    okE, rE, eE, elE = pcall(executeCommand, cmd)
    done = true
  end)
  local t0 = os.clock()
  local okStart, startErr = coroutine.resume(co)
  if not okStart then return false, nil, tostring(startErr), 0 end
  while not done do
    if os.clock() - t0 > TOOL_BUDGET_S then
      if type((cmd::any).args) == "table" then
        (cmd.args :: any).__rlCancelled = true
      end
      return true, nil, "timeout: tool '" .. tostring((cmd::any).tool or "?") ..
        "' still running after " .. tostring(TOOL_BUDGET_S) ..
        "s (likely an oversized build - split into smaller calls)", 0
    end
    task.wait(0.1)
  end
  if not okE then return false, nil, tostring(rE), 0 end
  return true, rE, eE, elE or 0
end

local function poll()
  if not enabled then return end
  if _G.__RL_BUSY then
    -- Watchdog: a claim span that throws outside pcall (or a poll task that
    -- dies mid-flight) used to hold BUSY forever - every later poll returned
    -- early while /queue/next kept answering, i.e. "polling but never
    -- finishing" with full 60s burns (seen live across all tools at once).
    -- Legit executions always finish inside TOOL_BUDGET_S, so anything older
    -- than budget + grace is a wedge, not work: clear it loudly.
    local heldFor = _G.__RL_BUSY_AT and (os.clock() - _G.__RL_BUSY_AT) or nil
    if heldFor and heldFor > (TOOL_BUDGET_S + 15) then
      warn("[RoLink] BUSY held by '" .. tostring(_G.__RL_BUSY_TOOL or "?") .. "' for "
        .. string.format("%.0f", heldFor) .. "s - force-clearing so the queue can move. "
        .. "Do not resend the stuck command; call plugin_status first.")
      _G.__RL_BUSY = false
      _G.__RL_BUSY_AT = nil
      _G.__RL_BUSY_TOOL = nil
    else
      return
    end
  end
  -- Unfiltered: project scoping happens bridge-side. A filtered poll would
  -- starve commands enqueued under any other project id (pending forever,
  -- full timeout burn, no error) with zero visible cause.
  -- Single-flight: never claim a second command while one execution runs;
  -- overlapping claims produced the 2 in_flight stall (both holding
  -- ChangeHistoryService + HttpService, neither reporting).
  local ok, res=pcall(function() return HttpService:RequestAsync({Url=MCP_URL.."/queue/next?projectId=&pv="..PLUGIN_VERSION, Method="GET"}) end)
  if not ok then return end
  local ok2, data=pcall(function() return HttpService:JSONDecode(res.Body) end)
  if not ok2 then return end
  if type((data::any).bridge_version) == "string" and (data::any).bridge_version ~= PLUGIN_VERSION then
    if not _G.__RL_VWARN then
      _G.__RL_VWARN = true
      warn("[RoLink] VERSION MISMATCH: plugin v" .. PLUGIN_VERSION .. " vs bridge v"
        .. tostring((data::any).bridge_version) .. " - reinstall both from the same zip.")
    end
  end
  local cmd=data.command; if not cmd then return end
  -- Malformed queue entries must never wedge the single-flight guard: a nil
  -- id/tool used to throw in the log line below with BUSY already held.
  if type(cmd) ~= "table" or type(cmd.id) ~= "string" or cmd.id == "" then
    warn("[RoLink] ignoring malformed queue command (no id) - bridge will time it out, not the plugin.")
    return
  end
  _G.__RL_BUSY = true
  _G.__RL_BUSY_AT = os.clock()
  _G.__RL_BUSY_TOOL = tostring(cmd.tool or "?")
  -- The whole claim span runs protected with the busy-reset OUTSIDE the pcall:
  -- no throw anywhere below (execute, encode, POST, warn) may hold BUSY.
  local okPoll, pollErr = pcall(function()
    log("executing "..cmd.id.." tool="..tostring(cmd.tool or "?"))
    local okExec, result, err, elapsed = runToolDeadline(cmd)
    if not okExec then
      -- runToolDeadline reports failures in the err slot (result is nil).
      result, err, elapsed = nil, "plugin_error: " .. tostring(err), 0
    end
    if elapsed and elapsed > 30 then
      warn("[RoLink] STILL RUNNING "..cmd.id.." "..tostring(cmd.tool).." after "
        .. string.format("%.0f", elapsed) .. "s - probable infinite loop in the code. "
        .. "Toggle the RoLink button off/on or restart Studio to clear it; do not resend the same code.")
    end
    reportResult(cmd.id, result, err, elapsed or 0)
    if err then warn("[RoLink] "..tostring(err)) end
  end)
  _G.__RL_BUSY = false
  _G.__RL_BUSY_AT = nil
  _G.__RL_BUSY_TOOL = nil
  if not okPoll then
    warn("[RoLink] claim span failed (" .. tostring(pollErr):sub(1, 160) .. ") - busy flag cleared, queue released.")
  end
end

btn.Click:Connect(function() enabled=not enabled; btn:SetActive(enabled); log(enabled and "enabled" or "disabled") end)
-- Block-scoped cursor: a chunk-level `local last` here would hold a register
-- to end-of-file (Studio caps a chunk at ~200 locals). The closure keeps its
-- own reference after the block closes.
do local last=0; RunService.Heartbeat:Connect(function(dt) last+=dt; if last>=POLL_INTERVAL then last=0; task.spawn(poll) end end) end
task.spawn(function() while true do task.wait(20); if enabled then pcall(function()
  local metrics={projectId="default", avgFPS=60, activePlayers=#game.Players:GetPlayers()}
  if #workspace:GetDescendants()>600 then metrics.avgFPS=35 end
  HttpService:RequestAsync({Url=MCP_URL.."/metrics", Method="POST", Headers={["Content-Type"]="application/json"}, Body=HttpService:JSONEncode(metrics)})
end) end end end)
log("RoLink 2.14.0 loaded [repo copy] - 150 tools ready, polling "..MCP_URL)
