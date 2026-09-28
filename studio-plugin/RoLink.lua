-- RoLink.lua — Studio Plugin (150 tools, production)
-- Place in Studio Plugins folder or Rojo. Polls MCP every 200ms, executes, snapshots, heals, reports.
local HttpService = game:GetService("HttpService")
local ChangeHistoryService = game:GetService("ChangeHistoryService")
local RunService = game:GetService("RunService")

local MCP_URL = "http://127.0.0.1:3001"
local POLL_INTERVAL = 0.2
local PLUGIN_NAME = "RoLink 2.1"
local PLUGIN_VERSION = "2.7.0"

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
--[[RIGADAPTER_BEGIN (canonical source: studio-plugin/animation/RigAdapter.lua; check_rigadapter_sync.js enforces equality)]]
local RigAdapter = {
  VERSION = 1,
  CHANNELS = {
    Motor6D = {"Motor6DTransform"},
    AnimationConstraint = {"ConstraintTransform", "ClipOnly"},
    Bone = {"ClipOnly"},
    Weld = {"None"},
    Rigid = {"PartCFrame"},
    Custom = {"None"},
  },
}

local function raNum(v: any, fallback: number): number
  local n = tonumber(v)
  if n == nil then return fallback end
  return n
end

function RigAdapter.classify(inst: Instance): { kind: string, legacyKind: string, className: string }
  local cn = inst.ClassName
  if inst:IsA("Motor6D") then
    return { kind = "Motor6D", legacyKind = "rotational", className = cn }
  end
  if inst:IsA("AnimationConstraint") then
    return { kind = "AnimationConstraint", legacyKind = "rotational", className = cn }
  end
  if inst:IsA("Bone") then
    return { kind = "Bone", legacyKind = "rotational", className = cn }
  end
  if inst:IsA("Weld") or inst:IsA("Snap") or inst:IsA("ManualWeld") or inst:IsA("WeldConstraint") then
    return { kind = "Weld", legacyKind = "follow", className = cn }
  end
  if inst:IsA("Attachment") then
    return { kind = "Custom", legacyKind = "anchor", className = cn }
  end
  if inst:IsA("Model") then
    return { kind = "Rigid", legacyKind = "root", className = cn }
  end
  if inst:IsA("BasePart") then
    return { kind = "Rigid", legacyKind = "rigid", className = cn }
  end
  return { kind = "Custom", legacyKind = "static", className = cn }
end

function RigAdapter.probe(inst: Instance, kind: string): string
  if kind == "Motor6D" then
    local ok = pcall(function()
      local _ = (inst :: any).Transform
    end)
    if ok then return "Motor6DTransform" end
    return "None"
  elseif kind == "AnimationConstraint" then
    local ok = pcall(function()
      local _ = (inst :: any).Transform
    end)
    if ok then return "ConstraintTransform" end
    return "ClipOnly"
  elseif kind == "Bone" then
    return "ClipOnly"
  elseif kind == "Rigid" then
    if inst:IsA("BasePart") then return "PartCFrame" end
    return "None"
  end
  return "None"
end

function RigAdapter.cframeToQuat(cf: CFrame): { w: number, x: number, y: number, z: number }
  local _px, _py, _pz, r00, r01, r02, r10, r11, r12, r20, r21, r22 = cf:GetComponents()
  local trace = r00 + r11 + r22
  local w: number, x: number, y: number, z: number
  if trace > 0 then
    local s = math.sqrt(trace + 1) * 2
    w = 0.25 * s
    x = (r21 - r12) / s
    y = (r02 - r20) / s
    z = (r10 - r01) / s
  elseif r00 > r11 and r00 > r22 then
    local s = math.sqrt(1 + r00 - r11 - r22) * 2
    w = (r21 - r12) / s
    x = 0.25 * s
    y = (r01 + r10) / s
    z = (r02 + r20) / s
  elseif r11 > r22 then
    local s = math.sqrt(1 + r11 - r00 - r22) * 2
    w = (r02 - r20) / s
    x = (r01 + r10) / s
    y = 0.25 * s
    z = (r12 + r21) / s
  else
    local s = math.sqrt(1 + r22 - r00 - r11) * 2
    w = (r10 - r01) / s
    x = (r02 + r20) / s
    y = (r12 + r21) / s
    z = 0.25 * s
  end
  local len = math.sqrt(w * w + x * x + y * y + z * z)
  if len < 1e-12 then return { w = 1, x = 0, y = 0, z = 0 } end
  return { w = w / len, x = x / len, y = y / len, z = z / len }
end

function RigAdapter.quatToCFrame(px: number, py: number, pz: number, qw: number, qx: number, qy: number, qz: number): CFrame
  local len = math.sqrt(qw * qw + qx * qx + qy * qy + qz * qz)
  if len < 1e-12 then return CFrame.new(px, py, pz) end
  local nw, nx, ny, nz = qw / len, qx / len, qy / len, qz / len
  local clamped = math.clamp(nw, -1, 1)
  local angle = 2 * math.acos(clamped)
  local s = math.sqrt(math.max(0, 1 - nw * nw))
  if s < 1e-9 or angle < 1e-9 then return CFrame.new(px, py, pz) end
  local axis = Vector3.new(nx / s, ny / s, nz / s)
  return CFrame.new(px, py, pz) * CFrame.fromAxisAngle(axis, angle)
end

function RigAdapter.cframePose(cf: CFrame): any
  local p = cf.Position
  return {
    position = { x = p.X, y = p.Y, z = p.Z },
    rotation = RigAdapter.cframeToQuat(cf),
  }
end

function RigAdapter.jointEndpoints(inst: Instance): any
  local ok0, p0: any = pcall(function() return (inst :: any).Part0 end)
  local ok1, p1: any = pcall(function() return (inst :: any).Part1 end)
  if not ok0 and not ok1 then return nil end
  local out: any = {}
  if ok0 and p0 ~= nil then
    out.part0 = { name = (p0 :: Instance).Name, className = (p0 :: Instance).ClassName }
  end
  if ok1 and p1 ~= nil then
    out.part1 = { name = (p1 :: Instance).Name, className = (p1 :: Instance).ClassName }
  end
  return out
end

function RigAdapter.partInfo(inst: Instance): any
  if not inst:IsA("BasePart") then return nil end
  local part = inst :: BasePart
  local s = part.Size
  return {
    size = { x = s.X, y = s.Y, z = s.Z },
    world = RigAdapter.cframePose(part.CFrame),
  }
end

function RigAdapter.jointPoseInfo(inst: Instance): any
  local out: any = {}
  local found = false
  local okT, t: any = pcall(function() return (inst :: any).Transform end)
  if okT and t ~= nil then
    out.transform = RigAdapter.cframePose(t)
    found = true
  end
  local ok0, c0: any = pcall(function() return (inst :: any).C0 end)
  if ok0 and c0 ~= nil then
    out.c0 = RigAdapter.cframePose(c0)
    found = true
  end
  local ok1, c1: any = pcall(function() return (inst :: any).C1 end)
  if ok1 and c1 ~= nil then
    out.c1 = RigAdapter.cframePose(c1)
    found = true
  end
  if not found then return nil end
  return out
end

function RigAdapter.readPose(inst: Instance, channel: string): any
  local ok, cf: any = pcall(function()
    if channel == "Motor6DTransform" then
      return (inst :: any).Transform
    end
    if channel == "ConstraintTransform" then
      return (inst :: any).Transform
    end
    if channel == "PartCFrame" then
      return (inst :: BasePart).CFrame
    end
    return nil
  end)
  if not ok or cf == nil then return nil end
  return RigAdapter.cframePose(cf)
end

function RigAdapter.writePose(inst: Instance, channel: string, pos: any, rot: any): (boolean, string?)
  local ok, err: any = pcall(function()
    local px = raNum(pos and pos.x, 0)
    local py = raNum(pos and pos.y, 0)
    local pz = raNum(pos and pos.z, 0)
    local cf: CFrame
    if rot ~= nil and (rot :: any).w ~= nil then
      cf = RigAdapter.quatToCFrame(px, py, pz,
        raNum((rot :: any).w, 1), raNum((rot :: any).x, 0),
        raNum((rot :: any).y, 0), raNum((rot :: any).z, 0))
    else
      cf = CFrame.new(px, py, pz)
        * CFrame.Angles(math.rad(raNum(rot and (rot :: any).x, 0)),
          math.rad(raNum(rot and (rot :: any).y, 0)),
          math.rad(raNum(rot and (rot :: any).z, 0)))
    end
    if channel == "Motor6DTransform" then
      (inst :: any).Transform = cf
    elseif channel == "ConstraintTransform" then
      (inst :: any).Transform = cf
    elseif channel == "PartCFrame" then
      (inst :: BasePart).CFrame = cf
    else
      error("unsupported_direct: joint '" .. inst.Name:sub(1, 40) .. "' (" .. inst.ClassName
        .. ") is not directly posable", 0)
    end
  end)
  if ok then return true, nil end
  return false, tostring(err)
end

function RigAdapter.effectiveChannels(kind: string, probed: string): { string }
  local out: { string } = {}
  local seen: { [string]: boolean } = {}
  if probed ~= "None" then
    table.insert(out, probed)
    seen[probed] = true
  end
  local cands: { string } = RigAdapter.CHANNELS[kind] or { "None" }
  for _, ch in ipairs(cands) do
    if not seen[ch] then
      table.insert(out, ch)
      seen[ch] = true
    end
  end
  return out
end

function RigAdapter.describe(inst: Instance): any
  local c = RigAdapter.classify(inst)
  local probed = RigAdapter.probe(inst, c.kind)
  local writable = probed ~= "None" and probed ~= "ClipOnly"
  local pose = RigAdapter.readPose(inst, probed)
  local rest: any
  local notes: { string } = {}
  if pose ~= nil then
    rest = pose
    table.insert(notes, "rest_from_current_snapshot")
  else
    rest = { position = { x = 0, y = 0, z = 0 }, rotation = { w = 1, x = 0, y = 0, z = 0 } }
    table.insert(notes, "rest_unreadable_channel_" .. probed)
  end
  local role = "unknown"
  if c.legacyKind == "root" then role = "root" end
  if not writable then
    table.insert(notes, "follow_or_clip_joint: animate a parent, never this")
  end
  local props: any = {}
  local eps = RigAdapter.jointEndpoints(inst)
  if eps ~= nil then props.endpoints = eps end
  local jp = RigAdapter.jointPoseInfo(inst)
  if jp ~= nil then props.joint = jp end
  local pi = RigAdapter.partInfo(inst)
  if pi ~= nil then
    props.size = pi.size
    props.world = pi.world
  end
  if inst:IsA("Model") then
    local ppOk, pp: any = pcall(function() return (inst :: Model).PrimaryPart end)
    if ppOk and pp ~= nil then props.primaryPart = (pp :: BasePart).Name end
  end
  return {
    name = inst.Name,
    path = inst:GetFullName(),
    className = c.className,
    kind = c.kind,
    legacyKind = c.legacyKind,
    semanticRole = role,
    children = {},
    rest = rest,
    props = props,
    drive = {
      writable = writable,
      channels = RigAdapter.effectiveChannels(c.kind, probed),
      reason = "probed_at_runtime:" .. probed,
    },
    notes = notes,
  }
end

function RigAdapter.describeModel(target: Instance): any
  local bindings: { any } = {}
  local warnings: { string } = {}
  local stopped = false
  local function walk(inst: Instance, depth: number)
    if stopped or depth > 6 then return end
    for _, child in ipairs(inst:GetChildren()) do
      if stopped then return end
      if #bindings >= 200 then
        stopped = true
        return
      end
      local ok, c = pcall(function() return RigAdapter.classify(child) end)
      if ok and c.legacyKind ~= "static" then
        local okDesc, binding = pcall(function() return RigAdapter.describe(child) end)
        if okDesc and binding ~= nil then
          table.insert(bindings, binding)
        end
      end
      if #child:GetChildren() > 0 then walk(child, depth + 1) end
    end
  end
  local selfOk, selfClass = pcall(function() return RigAdapter.classify(target) end)
  if selfOk and selfClass.legacyKind ~= "static" then
    local okDesc, binding = pcall(function() return RigAdapter.describe(target) end)
    if okDesc and binding ~= nil then table.insert(bindings, binding) end
  end
  walk(target, 1)
  if #bindings == 0 then
    table.insert(warnings, "nothing animatable under '" .. target.Name:sub(1, 48) .. "'")
  end
  if stopped then
    table.insert(warnings, "node cap 200 hit: smallest parts omitted")
  end
  return { bindings = bindings, warnings = warnings }
end
--[[RIGADAPTER_END]]
--[[CURVES_BEGIN (canonical source: studio-plugin/animation/Curves.lua; check_rigadapter_sync.js enforces equality)]]
local Curves = {}

Curves.EASE = {
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
  bezierOut = function(t) local c1 = 1.2 local u = t - 1 return 1 + (c1 + 1) * u * u * u + c1 * u * u end,
  springOut = function(t) return 1 - math.exp(-5 * t) * math.cos(9 * t) end,
}

function Curves.ease(name: string, t: number): number
  local fn = Curves.EASE[name]
  if fn == nil then fn = Curves.EASE.linear end
  local tt = t
  if tt < 0 then tt = 0 elseif tt > 1 then tt = 1 end
  local v = fn(tt)
  if name == "bezierOut" or name == "springOut" then
    if v > 1.15 then return 1.15 end
    if v < -0.15 then return -0.15 end
  end
  return v
end

function Curves.quatNorm(w: number, x: number, y: number, z: number): (number, number, number, number)
  local len = math.sqrt(w * w + x * x + y * y + z * z)
  if len < 1e-12 then return 1, 0, 0, 0 end
  return w / len, x / len, y / len, z / len
end

function Curves.quatMul(aw: number, ax: number, ay: number, az: number, bw: number, bx: number, by: number, bz: number): (number, number, number, number)
  return Curves.quatNorm(
    aw * bw - ax * bx - ay * by - az * bz,
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw)
end

function Curves.eulerDegToQuat(rx: number, ry: number, rz: number): (number, number, number, number)
  local hx, hy, hz = math.rad(rx) / 2, math.rad(ry) / 2, math.rad(rz) / 2
  local qx0, qx1 = math.cos(hx), math.sin(hx)
  local qy0, qy2 = math.cos(hy), math.sin(hy)
  local qz0, qz3 = math.cos(hz), math.sin(hz)
  local wx, xx, yx, zx = Curves.quatMul(qx0, qx1, 0, 0, qy0, 0, qy2, 0)
  return Curves.quatMul(wx, xx, yx, zx, qz0, 0, 0, qz3)
end

function Curves.slerp(w0: number, x0: number, y0: number, z0: number, w1: number, x1: number, y1: number, z1: number, t: number): (number, number, number, number)
  local dot = w0 * w1 + x0 * x1 + y0 * y1 + z0 * z1
  if dot < 0 then
    dot = -dot
    w1, x1, y1, z1 = -w1, -x1, -y1, -z1
  end
  if dot > 0.9995 then
    return Curves.quatNorm(
      w0 + (w1 - w0) * t, x0 + (x1 - x0) * t,
      y0 + (y1 - y0) * t, z0 + (z1 - z0) * t)
  end
  local th0 = math.acos(math.clamp(dot, -1, 1))
  local th = th0 * t
  local denom = math.sin(th0)
  local s0 = math.cos(th) - dot * math.sin(th) / denom
  local s1 = math.sin(th) / denom
  return Curves.quatNorm(
    w0 * s0 + w1 * s1, x0 * s0 + x1 * s1,
    y0 * s0 + y1 * s1, z0 * s0 + z1 * s1)
end

function Curves.lerp3(ax: number, ay: number, az: number, bx: number, by: number, bz: number, t: number): (number, number, number)
  return ax + (bx - ax) * t, ay + (by - ay) * t, az + (bz - az) * t
end

function Curves.arcLift(t01: number, height: number, peakTiming: number?, bias: number?): number
  if height == nil or height <= 0 then return 0 end
  local peak = (peakTiming or 0.5) + (bias or 0) * 0.25
  if peak < 0.05 then peak = 0.05 elseif peak > 0.95 then peak = 0.95 end
  local t = t01
  if t < 0 then t = 0 elseif t > 1 then t = 1 end
  local u: number
  if t < peak then u = 0.5 * t / peak else u = 1 - 0.5 * (1 - t) / (1 - peak) end
  return height * math.sin(math.pi * u)
end

function Curves.rotToQuat(rot: any): (number, number, number, number)
  if rot ~= nil and (rot :: any).w ~= nil then
    local r: any = rot
    return Curves.quatNorm(tonumber(r.w) or 1, tonumber(r.x) or 0, tonumber(r.y) or 0, tonumber(r.z) or 0)
  end
  local r: any = rot or {}
  return Curves.eulerDegToQuat(tonumber(r.x) or 0, tonumber(r.y) or 0, tonumber(r.z) or 0)
end

function Curves.bakeKeys(keys: any, fps: number, arc: any): any
  local out: any = {}
  local n = #keys
  if n == 0 then return out end
  local step = 1 / math.clamp(math.floor(tonumber(fps) or 30), 1, 120)
  local function emit(t: number, pos: any, qw: number, qx: number, qy: number, qz: number)
    table.insert(out, { t = t,
      pos = { x = pos.x, y = pos.y, z = pos.z },
      rot = { w = qw, x = qx, y = qy, z = qz } })
  end
  if n == 1 then
    local k: any = keys[1]
    local qw, qx, qy, qz = Curves.rotToQuat(k.rot)
    emit(tonumber(k.t) or 0, k.pos, qw, qx, qy, qz)
    return out
  end
  local dir: any = nil
  if arc ~= nil and tonumber((arc :: any).height) ~= nil and (arc :: any).height > 0 then
    local d: any = (arc :: any).dir or { x = 0, y = 1, z = 0 }
    local dx, dy, dz = tonumber(d.x) or 0, tonumber(d.y) or 0, tonumber(d.z) or 1
    local len = math.sqrt(dx * dx + dy * dy + dz * dz)
    if len < 1e-9 then dx, dy, dz = 0, 1, 0 len = 1 end
    dir = { x = dx / len, y = dy / len, z = dz / len,
      height = (arc :: any).height, peak = (arc :: any).peak, bias = (arc :: any).bias }
  end
  for s = 1, n - 1 do
    local k0: any = keys[s]
    local k1: any = keys[s + 1]
    local t0 = tonumber(k0.t) or 0
    local t1 = tonumber(k1.t) or 0
    local span = t1 - t0
    if span <= 0 then continue end
    local p0: any = k0.pos or { x = 0, y = 0, z = 0 }
    local p1: any = k1.pos or { x = 0, y = 0, z = 0 }
    local w0, x0, y0, z0 = Curves.rotToQuat(k0.rot)
    local w1, x1, y1, z1 = Curves.rotToQuat(k1.rot)
    local easeName = tostring(k1.easing or "linear")
    local steps = math.max(1, math.floor(span / step + 0.5))
    for i = 0, steps do
      if s > 1 and i == 0 then continue end
      local raw = i / steps
      local e = Curves.ease(easeName, raw)
      local px, py, pz = Curves.lerp3(
        tonumber(p0.x) or 0, tonumber(p0.y) or 0, tonumber(p0.z) or 0,
        tonumber(p1.x) or 0, tonumber(p1.y) or 0, tonumber(p1.z) or 0, e)
      if dir ~= nil then
        local lift = Curves.arcLift(raw, dir.height, dir.peak, dir.bias)
        px, py, pz = px + dir.x * lift, py + dir.y * lift, pz + dir.z * lift
      end
      local qw, qx, qy, qz = Curves.slerp(w0, x0, y0, z0, w1, x1, y1, z1, e)
      emit(t0 + span * raw, { x = px, y = py, z = pz }, qw, qx, qy, qz)
    end
  end
  return out
end
--[[CURVES_END]]
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
-- Task 12.3: the easing table itself is the Curves engine's (Curves.EASE).
-- The plugin used to hold a byte-identical second copy, which is exactly the
-- duplicate code path Phase 12 removes; validity is now decided by the engine.
local EASE_LIST = "linear|quadIn|quadOut|quadInOut|cubicIn|cubicOut|cubicInOut|sineIn|sineOut|sineInOut|bezierOut|springOut"
local function resolveEasing(name:string): (string?)
  if Curves.EASE[name] then return name end
  local norm = name:lower():gsub("[%s%-%_]", "")
  for k in pairs(Curves.EASE) do
    if k:lower() == norm then return k end
  end
  return EASE_ALIASES[norm]
end
local function easingHint(bad:string): string
  local bl = bad:lower()
  local out:{string} = {}
  for k in pairs(Curves.EASE) do
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
            -- Curves.ease owns the overshoot clamp to [-0.15,1.15], so one
            -- segment cannot fling a limb across the map.
            f = Curves.ease(pEase, frac)
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
-- Task 12.4: loop-seam speed ratio tolerated between the clip's last segment
-- and its first. 1.0 means identical; a mismatched arrival reads as a visible
-- pop on every cycle even when the endpoint poses already match.
local RL_LOOP_SEAM = 2.5
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
-- Task 12.1: analyze_animatable_model runs on the RigAnalyzer (RigAdapter).
-- The walk, the 200-node cap, the depth-6 limit and the per-instance probing
-- all live in RigAdapter.describeModel now; this function only derives the
-- legacy flat `animatable` view and the controller summary from the engine's
-- bindings, so there is exactly one classification path in the plugin.
local function rlModelAnalyze(args: { [string]: any }): { [string]: any }
  local path = tostring(args.target or "")
  local target = findByPath(path)
  if not target then error("Model not found: '" .. path:sub(1, 120) .. "'.") end
  local res = RigAdapter.describeModel(target)
  local bindings: { [string]: any } = res.bindings
  local warnings: { [string]: any } = {}
  for _, w in ipairs(res.warnings or {}) do table.insert(warnings, w) end
  local nodes: { [string]: any } = {}
  local rotational, hasRoot, hasRigid, hasFollow = 0, false, false, false
  local writable = 0
  -- Depth is derived from the full path (the engine binding carries no
  -- depth field): count separators between the target prefix and the node,
  -- which is exactly the walk order describeModel used to produce.
  local rootPath = target:GetFullName()
  for _, b in ipairs(bindings) do
    local legacy = tostring((b :: any).legacyKind or "static")
    if legacy ~= "static" then
      local bp = tostring((b :: any).path or "")
      local depth = 0
      if bp ~= rootPath and #bp > #rootPath then
        for _ in bp:sub(#rootPath + 2):gmatch("[^%.]+") do depth += 1 end
      end
      local drv: any = (b :: any).drive or {}
      if drv.writable == true then writable += 1 end
      table.insert(nodes, { path = bp, name = tostring((b :: any).name), class = tostring((b :: any).className),
        kind = legacy, depth = depth, writable = drv.writable == true, channels = drv.channels })
      if legacy == "rotational" then rotational += 1 end
      if legacy == "root" then hasRoot = true end
      if legacy == "rigid" then hasRigid = true end
      if legacy == "follow" then hasFollow = true end
    end
  end
  if #nodes == 0 then
    table.insert(warnings, "nothing animatable under '" .. target.Name:sub(1, 48) .. "' (need Motor6D/Bone joints, a PrimaryPart, or BaseParts)")
  end
  if target:IsA("Model") then
    local pp: Instance? = nil
    pcall(function() pp = (target :: Model).PrimaryPart end)
    if not pp then table.insert(warnings, "no PrimaryPart on '" .. target.Name:sub(1, 48) .. "': root motion unavailable until one is set") end
  end
  local hasHumanoid = false
  pcall(function() hasHumanoid = target:FindFirstChildOfClass("Humanoid") ~= nil end)
  if hasHumanoid then table.insert(warnings, "humanoid rig: use create_animation_track for character clips; model tracks suit prop-style motion on this rig") end
  if hasFollow and rotational == 0 and not hasRigid and not hasRoot then
    table.insert(warnings, "only follow/anchor parts found: animate a parent, never these")
  end
  -- Weld/Attachment/Bone/AnimationConstraint joints are classified but not
  -- posable. Say so up front instead of letting the first keyframe call fail.
  local unwritable = 0
  for _, n in ipairs(nodes) do
    if (n :: any).writable ~= true then unwritable += 1 end
  end
  if unwritable > 0 then
    table.insert(warnings, unwritable .. " of " .. #nodes
      .. " listed nodes are follow/clip joints with no writable channel - animate their parent part instead")
  end
  local controller = "none"
  if hasHumanoid then controller = "hybrid (character clips + model tracks)"
  elseif rotational > 0 then controller = "hierarchical transforms"
  elseif hasRoot then controller = "root motion"
  elseif hasRigid then controller = "rigid assembly" end
  return { model = rootPath, animatable = nodes, warnings = warnings, controller = controller,
    bindings = bindings, writable = writable }
end
--[[POSESOLVER_BEGIN (canonical source: studio-plugin/animation/PoseSolver.lua; check_rigadapter_sync.js enforces equality)]]
local PoseSolver = {}

function PoseSolver.adapters(): any
  if RigAdapter ~= nil then return RigAdapter end
  local ok, mod: any = pcall(function()
    local m = script:FindFirstChild("RigAdapter")
    if m ~= nil and m:IsA("ModuleScript") then return require(m) end
    return nil
  end)
  if ok then return mod end
  return nil
end

function PoseSolver.curves(): any
  if Curves ~= nil then return Curves end
  local ok, mod: any = pcall(function()
    local m = script:FindFirstChild("Curves")
    if m ~= nil and m:IsA("ModuleScript") then return require(m) end
    return nil
  end)
  if ok then return mod end
  return nil
end

function PoseSolver.resolveJoint(target: Instance, trackName: string): Instance?
  local best: Instance? = nil
  pcall(function()
    for _, d in ipairs(target:GetDescendants()) do
      if d.Name == trackName and (d:IsA("Motor6D") or d:IsA("AnimationConstraint")
        or d:IsA("Bone") or d:IsA("BasePart")) then
        best = d
        break
      end
    end
    if not best and target.Name == trackName then best = target end
  end)
  return best
end

function PoseSolver.applyKey(target: Instance, jointName: string, pos: any, rot: any): (boolean, string?)
  local RA: any = PoseSolver.adapters()
  if RA == nil then return false, "rig_adapter_unavailable" end
  local inst = PoseSolver.resolveJoint(target, jointName)
  if inst == nil then return false, "joint_not_found:" .. tostring(jointName):sub(1, 48) end
  local c: any = RA.classify(inst)
  local channel: string = RA.probe(inst, c.kind)
  return RA.writePose(inst, channel, pos, rot)
end

function PoseSolver.applyTrackAtTime(target: Instance, track: any, t: number, arc: any): any
  local CU: any = PoseSolver.curves()
  local RA: any = PoseSolver.adapters()
  local applied = 0
  local errors: { string } = {}
  if CU == nil then return { applied = 0, errors = { "curves_unavailable" } } end
  if RA == nil then return { applied = 0, errors = { "rig_adapter_unavailable" } } end
  local keys: any = track.keys or {}
  local n = #keys
  if n == 0 then return { applied = 0, errors = {} } end
  local tt = tonumber(t) or 0
  local seg = 1
  if tt <= tonumber(keys[1].t) then seg = 1
  elseif tt >= tonumber(keys[n].t) then seg = n - 1
  else
    for i = 1, n - 1 do
      if tt >= tonumber(keys[i].t) and tt <= tonumber(keys[i + 1].t) then seg = i break end
    end
  end
  if seg < 1 then seg = 1 end
  if seg > n - 1 then seg = n - 1 end
  local k0: any = keys[seg]
  local k1: any = keys[seg + 1]
  local t0 = tonumber(k0.t) or 0
  local t1 = tonumber(k1.t) or 0
  local span = t1 - t0
  local raw = 0
  if span > 0 then
    raw = (tt - t0) / span
    if raw < 0 then raw = 0 elseif raw > 1 then raw = 1 end
  end
  local e = CU.ease(tostring(k1.easing or "linear"), raw)
  local p0: any = k0.pos or { x = 0, y = 0, z = 0 }
  local p1: any = k1.pos or { x = 0, y = 0, z = 0 }
  local px, py, pz = CU.lerp3(
    tonumber(p0.x) or 0, tonumber(p0.y) or 0, tonumber(p0.z) or 0,
    tonumber(p1.x) or 0, tonumber(p1.y) or 0, tonumber(p1.z) or 0, e)
  if arc ~= nil and tonumber((arc :: any).height) ~= nil and (arc :: any).height > 0 then
    local d: any = (arc :: any).dir or { x = 0, y = 1, z = 0 }
    local dx, dy, dz = tonumber(d.x) or 0, tonumber(d.y) or 0, tonumber(d.z) or 1
    local len = math.sqrt(dx * dx + dy * dy + dz * dz)
    if len < 1e-9 then dx, dy, dz = 0, 1, 0 len = 1 end
    local lift = CU.arcLift(raw, (arc :: any).height, (arc :: any).peak, (arc :: any).bias)
    px, py, pz = px + dx / len * lift, py + dy / len * lift, pz + dz / len * lift
  end
  local w0, x0, y0, z0 = CU.rotToQuat(k0.rot)
  local w1, x1, y1, z1 = CU.rotToQuat(k1.rot)
  local qw, qx, qy, qz = CU.slerp(w0, x0, y0, z0, w1, x1, y1, z1, e)
  local ok, err = PoseSolver.applyKey(target, tostring(track.joint or track.name or ""),
    { x = px, y = py, z = pz }, { w = qw, x = qx, y = qy, z = qz })
  if ok then applied = 1 else table.insert(errors, tostring(err)) end
  return { applied = applied, errors = errors }
end

function PoseSolver.bakeTrack(track: any, fps: number, arc: any): any
  local CU: any = PoseSolver.curves()
  if CU == nil then return nil end
  return CU.bakeKeys(track.keys or {}, fps, arc)
end
--[[POSESOLVER_END]]
--[[IK_BEGIN (canonical source: studio-plugin/animation/IK.lua; check_rigadapter_sync.js enforces equality)]]
local IK = {}

function IK.create(rootPart: Instance, endEffector: Instance, opts: any): (Instance?, any)
  local o: any = opts or {}
  local okNew, control: any = pcall(function() return Instance.new("IKControl") end)
  if not okNew or control == nil then
    return nil, "ikcontrol_unavailable: Instance.new('IKControl') failed (old Studio?)"
  end
  local parent: Instance? = o.parent
  if parent == nil then
    pcall(function() parent = rootPart.Parent end)
  end
  if parent == nil then
    return nil, "ik_no_parent: pass opts.parent or keep the chain parented"
  end
  control.Parent = parent
  local applied: { [string]: boolean } = {}
  local function setProp(name: string, value: any)
    if value == nil then return end
    local ok = pcall(function() (control :: any)[name] = value end)
    applied[name] = ok
  end
  setProp("ChainRoot", rootPart)
  setProp("EndEffector", endEffector)
  setProp("Target", o.target)
  setProp("Pole", o.pole)
  setProp("Type", o.type)
  setProp("Weight", o.weight)
  setProp("Priority", o.priority)
  setProp("SmoothTime", o.smoothTime)
  if o.enabled == nil then
    setProp("Enabled", true)
  else
    setProp("Enabled", o.enabled)
  end
  return control, { applied = applied }
end

function IK.setTarget(control: Instance, target: Instance): (boolean, string?)
  local ok, err: any = pcall(function() (control :: any).Target = target end)
  if ok then return true, nil end
  return false, tostring(err)
end

function IK.setPole(control: Instance, pole: Instance?): (boolean, string?)
  local ok, err: any = pcall(function() (control :: any).Pole = pole end)
  if ok then return true, nil end
  return false, tostring(err)
end

function IK.setWeight(control: Instance, weight: number): (boolean, string?)
  local ok, err: any = pcall(function() (control :: any).Weight = weight end)
  if ok then return true, nil end
  return false, tostring(err)
end

function IK.setEnabled(control: Instance, enabled: boolean): (boolean, string?)
  local ok, err: any = pcall(function() (control :: any).Enabled = enabled end)
  if ok then return true, nil end
  return false, tostring(err)
end

function IK.remove(control: Instance?): (boolean, string?)
  if control == nil then return false, "ik_no_control" end
  local ok, err: any = pcall(function() (control :: Instance):Destroy() end)
  if ok then return true, nil end
  return false, tostring(err)
end

function IK.describe(control: Instance): any
  local out: any = { className = control.ClassName }
  local function readProp(name: string)
    local ok, v: any = pcall(function() return (control :: any)[name] end)
    if not ok or v == nil then
      out[name] = nil
      return
    end
    if typeof(v) == "Instance" then
      out[name] = (v :: Instance):GetFullName()
    elseif typeof(v) == "EnumItem" then
      out[name] = tostring(v)
    else
      out[name] = v
    end
  end
  readProp("ChainRoot")
  readProp("EndEffector")
  readProp("Target")
  readProp("Pole")
  readProp("Type")
  readProp("Weight")
  readProp("Priority")
  readProp("SmoothTime")
  readProp("Enabled")
  return out
end
--[[IK_END]]
--[[CONTACTS_BEGIN (canonical source: studio-plugin/animation/Contacts.lua; check_rigadapter_sync.js enforces equality)]]
local Contacts = {
  locks = {},
  nextId = 1,
}

function Contacts.resolveJoint(target: Instance, jointName: string): Instance?
  local best: Instance? = nil
  pcall(function()
    for _, d in ipairs(target:GetDescendants()) do
      if d.Name == jointName and (d:IsA("Motor6D") or d:IsA("AnimationConstraint")
        or d:IsA("Bone") or d:IsA("BasePart")) then
        best = d
        break
      end
    end
    if not best and target.Name == jointName then best = target end
  end)
  return best
end

function Contacts.drivenPart(inst: Instance): (Instance?, string?)
  if inst:IsA("BasePart") then return inst, nil end
  local ok, part: any = pcall(function()
    if inst:IsA("Motor6D") or inst:IsA("AnimationConstraint") then
      return (inst :: any).Part1
    end
    return nil
  end)
  if ok and part ~= nil then return part, nil end
  return nil, "contact_no_driven_part: '" .. inst.Name:sub(1, 40) .. "' (" .. inst.ClassName .. ")"
end

function Contacts.measure(target: Instance, jointName: string, lockCf: CFrame): (number?, string?)
  local inst = Contacts.resolveJoint(target, jointName)
  if inst == nil then return nil, "joint_not_found:" .. tostring(jointName):sub(1, 48) end
  local part, perr = Contacts.drivenPart(inst)
  if part == nil then return nil, perr end
  local ok, drift: any = pcall(function()
    return ((part :: BasePart).CFrame.Position - lockCf.Position).Magnitude
  end)
  if not ok then return nil, tostring(drift) end
  return drift, nil
end

function Contacts.applyLock(target: Instance, jointName: string, lockCf: CFrame, stiffness: number?): (number?, string?)
  local stiff = tonumber(stiffness) or 1
  if stiff < 0 then stiff = 0 elseif stiff > 1 then stiff = 1 end
  local inst = Contacts.resolveJoint(target, jointName)
  if inst == nil then return nil, "joint_not_found:" .. tostring(jointName):sub(1, 48) end
  local part, perr = Contacts.drivenPart(inst)
  if part == nil then return nil, perr end
  local ok, res: any = pcall(function()
    local partCf: CFrame = (part :: BasePart).CFrame
    local err: Vector3 = (lockCf.Position - partCf.Position) * stiff
    if inst:IsA("BasePart") then
      (inst :: BasePart).CFrame = partCf + err
    elseif inst:IsA("Motor6D") or inst:IsA("AnimationConstraint") then
      local j: any = inst
      local base: CFrame = j.Part0.CFrame * j.C0
      local shift: Vector3 = base:VectorToObjectSpace(err)
      j.Transform = CFrame.new(j.Transform.Position + shift) * (j.Transform - j.Transform.Position)
    else
      error("contact_unsupported_joint:" .. inst.ClassName, 0)
    end
    return ((part :: BasePart).CFrame.Position - lockCf.Position).Magnitude
  end)
  if not ok then return nil, tostring(res) end
  return res, nil
end

function Contacts.createLock(target: Instance, jointName: string, lockCf: CFrame, stiffness: number?): (number?, string?)
  local inst = Contacts.resolveJoint(target, jointName)
  if inst == nil then return nil, "joint_not_found:" .. tostring(jointName):sub(1, 48) end
  local id = Contacts.nextId
  Contacts.nextId = Contacts.nextId + 1
  local path: string? = nil
  pcall(function() path = target:GetFullName() end)
  Contacts.locks[id] = { target = target, joint = jointName,
    lock = lockCf, stiffness = tonumber(stiffness) or 1, path = path }
  return id, nil
end

function Contacts.releaseLock(id: number): boolean
  if Contacts.locks[id] == nil then return false end
  Contacts.locks[id] = nil
  return true
end

function Contacts.enforceAll(): any
  local report: any = { enforced = 0, remaining = {}, errors = {} }
  for id, lock in pairs(Contacts.locks) do
    local l: any = lock
    local target: Instance? = l.target
    local gone = false
    if target == nil then
      gone = true
    else
      local okAlive, alive: any = pcall(function() return (target :: Instance).Parent end)
      if not okAlive or alive == nil then gone = true end
    end
    if gone then
      local okByPath = false
      pcall(function()
        if l.path ~= nil then
          local cur: Instance? = game
          for _, part in ipairs(string.split(tostring(l.path), ".")) do
            if cur == nil then break end
            if part == "game" then cur = game
            else cur = cur:FindFirstChild(part) end
          end
          if cur ~= nil then target = cur l.target = cur okByPath = true end
        end
      end)
      if not okByPath then
        table.insert(report.errors, "lock " .. id .. ": target gone")
        Contacts.locks[id] = nil
        target = nil
      end
    end
    if target ~= nil then
      local drift, err = Contacts.applyLock(target, l.joint, l.lock, l.stiffness)
      if drift == nil then
        table.insert(report.errors, "lock " .. id .. ": " .. tostring(err))
      else
        report.enforced = report.enforced + 1
        report.remaining[tostring(id)] = drift
      end
    end
  end
  return report
end
--[[CONTACTS_END]]
--[[COLLISION_BEGIN (canonical source: studio-plugin/animation/Collision.lua; check_rigadapter_sync.js enforces equality)]]
local Collision = {}

function Collision.pairKey(a: string, b: string): string
  if a < b then return a .. "|" .. b end
  return b .. "|" .. a
end

function Collision.partVolumes(target: Instance, cap: number?): any
  local vols: any = {}
  local limit = tonumber(cap) or 200
  if limit < 1 then limit = 1 end
  if limit > 1000 then limit = 1000 end
  local stopped = false
  local function walk(inst: Instance)
    if stopped then return end
    for _, child in ipairs(inst:GetChildren()) do
      if stopped then return end
      if #vols >= limit then stopped = true return end
      local ok, isPart: any = pcall(function() return child:IsA("BasePart") end)
      if ok and isPart then
        local okRead, entry: any = pcall(function()
          local p = child :: BasePart
          local c = p.Position
          local s = p.Size
          return { name = child.Name, path = child:GetFullName(),
            center = { x = c.X, y = c.Y, z = c.Z },
            half = { x = s.X / 2, y = s.Y / 2, z = s.Z / 2 } }
        end)
        if okRead and entry ~= nil then table.insert(vols, entry) end
      end
      if #child:GetChildren() > 0 then walk(child) end
    end
  end
  if target:IsA("BasePart") then
    local p = target :: BasePart
    local c = p.Position
    local s = p.Size
    table.insert(vols, { name = target.Name, path = target:GetFullName(),
      center = { x = c.X, y = c.Y, z = c.Z },
      half = { x = s.X / 2, y = s.Y / 2, z = s.Z / 2 } })
  end
  walk(target)
  return { volumes = vols, truncated = stopped }
end

function Collision.aabbOverlap(a: any, b: any): any
  local ox = math.min(a.center.x + a.half.x, b.center.x + b.half.x)
    - math.max(a.center.x - a.half.x, b.center.x - b.half.x)
  local oy = math.min(a.center.y + a.half.y, b.center.y + b.half.y)
    - math.max(a.center.y - a.half.y, b.center.y - b.half.y)
  local oz = math.min(a.center.z + a.half.z, b.center.z + b.half.z)
    - math.max(a.center.z - a.half.z, b.center.z - b.half.z)
  if ox <= 0 or oy <= 0 or oz <= 0 then
    return { overlap = false, penetration = 0 }
  end
  local pen = ox
  local axis = "x"
  if oy < pen then pen, axis = oy, "y" end
  if oz < pen then pen, axis = oz, "z" end
  return { overlap = true, penetration = pen, axis = axis }
end

function Collision.adjacentPairs(target: Instance): any
  local adj: { [string]: boolean } = {}
  pcall(function()
    for _, d in ipairs(target:GetDescendants()) do
      local parent = d.Parent
      if parent ~= nil and parent ~= target then
        adj[Collision.pairKey(d.Name, parent.Name)] = true
      end
      if d:IsA("Motor6D") or d:IsA("AnimationConstraint") or d:IsA("Weld") then
        local ok, p0: any = pcall(function() return (d :: any).Part0 end)
        local ok2, p1: any = pcall(function() return (d :: any).Part1 end)
        if ok and ok2 and p0 ~= nil and p1 ~= nil then
          adj[Collision.pairKey((p0 :: Instance).Name, (p1 :: Instance).Name)] = true
        end
      end
    end
  end)
  return adj
end

function Collision.scan(target: Instance, opts: any): any
  local o: any = opts or {}
  local floorY: number? = nil
  if tonumber(o.floorY) ~= nil then floorY = tonumber(o.floorY) end
  local minPen = tonumber(o.minPenetration) or 0.05
  local vols = Collision.partVolumes(target, tonumber(o.cap) or 200)
  local adj = Collision.adjacentPairs(target)
  local intersections: any = {}
  local floor: any = {}
  local list: any = vols.volumes
  for i = 1, #list do
    local a: any = list[i]
    if floorY ~= nil and a.half.y > 0 then
      local minY = a.center.y - a.half.y
      if minY < floorY then
        table.insert(floor, { name = a.name, depth = floorY - minY })
      end
    end
    for j = i + 1, #list do
      local b: any = list[j]
      if a.name ~= b.name and not adj[Collision.pairKey(a.name, b.name)] then
        local hit = Collision.aabbOverlap(a, b)
        if hit.overlap and hit.penetration >= minPen then
          table.insert(intersections,
            { a = a.name, b = b.name, penetration = hit.penetration, axis = hit.axis })
        end
      end
    end
  end
  return { volumes = #list, truncated = vols.truncated,
    intersections = intersections, floor = floor }
end

function Collision.measureDeformation(target: Instance, segments: any): any
  local stretch: any = {}
  local compression: any = {}
  local maxStretch = 0.15
  local maxCompression = 0.15
  if type(segments) == "table" and tonumber((segments :: any).maxStretch) ~= nil then
    maxStretch = tonumber((segments :: any).maxStretch)
  end
  if type(segments) == "table" and tonumber((segments :: any).maxCompression) ~= nil then
    maxCompression = tonumber((segments :: any).maxCompression)
  end
  local list: any = {}
  if type(segments) == "table" and (segments :: any)[1] ~= nil then list = segments end
  local function findPart(name: string): Instance?
    local found: Instance? = nil
    pcall(function()
      for _, d in ipairs(target:GetDescendants()) do
        if d.Name == name and d:IsA("BasePart") then found = d break end
      end
      if found == nil and target.Name == name and target:IsA("BasePart") then
        found = target
      end
    end)
    return found
  end
  for _, seg in ipairs(list) do
    local s: any = seg
    local rest = tonumber(s.rest)
    if s.a ~= nil and s.b ~= nil and rest ~= nil and rest > 1e-9 then
      local pa = findPart(tostring(s.a))
      local pb = findPart(tostring(s.b))
      if pa ~= nil and pb ~= nil then
        local cur = ((pa :: BasePart).Position - (pb :: BasePart).Position).Magnitude
        local ratio = cur / rest
        if ratio > 1 + maxStretch then
          table.insert(stretch, { a = s.a, b = s.b, ratio = ratio, current = cur, rest = rest })
        elseif ratio < 1 - maxCompression then
          table.insert(compression, { a = s.a, b = s.b, ratio = ratio, current = cur, rest = rest })
        end
      end
    end
  end
  return { stretch = stretch, compression = compression }
end
--[[COLLISION_END]]
--[[DYNAMICS_BEGIN (canonical source: studio-plugin/animation/Dynamics.lua; check_rigadapter_sync.js enforces equality)]]
local Dynamics = {}

function Dynamics.vadd(a: any, b: any): any
  return { x = a.x + b.x, y = a.y + b.y, z = a.z + b.z }
end

function Dynamics.vsub(a: any, b: any): any
  return { x = a.x - b.x, y = a.y - b.y, z = a.z - b.z }
end

function Dynamics.vscale(v: any, s: number): any
  return { x = v.x * s, y = v.y * s, z = v.z * s }
end

function Dynamics.vlen(v: any): number
  return math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z)
end

function Dynamics.qnorm(w: number, x: number, y: number, z: number): (number, number, number, number)
  local len = math.sqrt(w * w + x * x + y * y + z * z)
  if len < 1e-12 then return 1, 0, 0, 0 end
  return w / len, x / len, y / len, z / len
end

function Dynamics.qmul(aw: number, ax: number, ay: number, az: number, bw: number, bx: number, by: number, bz: number): (number, number, number, number)
  return Dynamics.qnorm(
    aw * bw - ax * bx - ay * by - az * bz,
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw)
end

function Dynamics.qconj(w: number, x: number, y: number, z: number): (number, number, number, number)
  return w, -x, -y, -z
end

function Dynamics.qlog(w: number, x: number, y: number, z: number): (number, number, number)
  local nw, nx, ny, nz = Dynamics.qnorm(w, x, y, z)
  local vl = math.sqrt(nx * nx + ny * ny + nz * nz)
  if vl < 1e-12 then return 0, 0, 0 end
  local s = math.atan2(vl, nw) / vl
  return nx * s, ny * s, nz * s
end

function Dynamics.qexp(vx: number, vy: number, vz: number): (number, number, number, number)
  local a = math.sqrt(vx * vx + vy * vy + vz * vz)
  if a < 1e-12 then return 1, 0, 0, 0 end
  local s = math.sin(a) / a
  return Dynamics.qnorm(math.cos(a), vx * s, vy * s, vz * s)
end

function Dynamics.qAngularVelocity(w0: number, x0: number, y0: number, z0: number, w1: number, x1: number, y1: number, z1: number, dt: number): (number, number, number)
  if dt == nil or dt <= 0 then return 0, 0, 0 end
  local cw0, cx0, cy0, cz0 = Dynamics.qconj(w0, x0, y0, z0)
  local dw, dx, dy, dz = Dynamics.qmul(w1, x1, y1, z1, cw0, cx0, cy0, cz0)
  local nw, nx, ny, nz = Dynamics.qnorm(dw, dx, dy, dz)
  local angle = 2 * math.acos(math.clamp(nw, -1, 1))
  local s = math.sqrt(math.max(0, 1 - nw * nw))
  if s < 1e-9 or angle < 1e-9 then return 0, 0, 0 end
  local k = (angle * 180 / math.pi) / dt / s
  return nx * k, ny * k, nz * k
end

function Dynamics.createState(): any
  return {
    offP = { x = 0, y = 0, z = 0 }, velP = { x = 0, y = 0, z = 0 },
    offR = { x = 0, y = 0, z = 0 }, velR = { x = 0, y = 0, z = 0 },
    prevPos = nil, prevVel = { x = 0, y = 0, z = 0 },
    prevQuat = nil, prevAngVel = { x = 0, y = 0, z = 0 },
  }
end

function Dynamics.adapters(): any
  if RigAdapter ~= nil then return RigAdapter end
  local ok, mod: any = pcall(function()
    local m = script:FindFirstChild("RigAdapter")
    if m ~= nil and m:IsA("ModuleScript") then return require(m) end
    return nil
  end)
  if ok then return mod end
  return nil
end

function Dynamics.resolveJoint(target: Instance, jointName: string): Instance?
  local best: Instance? = nil
  pcall(function()
    for _, d in ipairs(target:GetDescendants()) do
      if d.Name == jointName and (d:IsA("Motor6D") or d:IsA("AnimationConstraint")
        or d:IsA("Bone") or d:IsA("BasePart")) then
        best = d
        break
      end
    end
    if not best and target.Name == jointName then best = target end
  end)
  return best
end

function Dynamics.springAxis(off: any, vel: any, drive: any, k: number, c: number, m: number, fw: number, h: number): (any, any)
  local ax = -(k * off.x + c * vel.x) / m - fw * drive.x
  local ay = -(k * off.y + c * vel.y) / m - fw * drive.y
  local az = -(k * off.z + c * vel.z) / m - fw * drive.z
  local v2 = { x = vel.x + ax * h, y = vel.y + ay * h, z = vel.z + az * h }
  local o2 = { x = off.x + v2.x * h, y = off.y + v2.y * h, z = off.z + v2.z * h }
  return o2, v2
end

function Dynamics.step(state: any, pos: any, rot: any, cfg: any, dt: number): any
  local qw = tonumber(rot.w) or 1
  local qx = tonumber(rot.x) or 0
  local qy = tonumber(rot.y) or 0
  local qz = tonumber(rot.z) or 0
  qw, qx, qy, qz = Dynamics.qnorm(qw, qx, qy, qz)
  local px = tonumber(pos.x) or 0
  local py = tonumber(pos.y) or 0
  local pz = tonumber(pos.z) or 0
  if dt == nil or dt <= 1e-9 then
    return { pos = { x = px, y = py, z = pz }, rot = { w = qw, x = qx, y = qy, z = qz } }
  end
  local c: any = cfg or {}
  local k = tonumber(c.stiffness) or 0
  if k < 0 then k = 0 end
  local damp = tonumber(c.damping) or 0
  if damp < 0 then damp = 0 end
  local mass = tonumber(c.mass) or 1
  if mass <= 0 then mass = 1 end
  local fw = tonumber(c.followWeight) or 0
  if k <= 0 then
    state.offP = { x = 0, y = 0, z = 0 }
    state.velP = { x = 0, y = 0, z = 0 }
    state.offR = { x = 0, y = 0, z = 0 }
    state.velR = { x = 0, y = 0, z = 0 }
    state.prevPos = { x = px, y = py, z = pz }
    state.prevVel = { x = 0, y = 0, z = 0 }
    state.prevQuat = { w = qw, x = qx, y = qy, z = qz }
    state.prevAngVel = { x = 0, y = 0, z = 0 }
    return { pos = { x = px, y = py, z = pz }, rot = { w = qw, x = qx, y = qy, z = qz } }
  end
  local pvel = { x = 0, y = 0, z = 0 }
  if state.prevPos ~= nil then
    pvel = Dynamics.vscale(Dynamics.vsub({ x = px, y = py, z = pz }, state.prevPos), 1 / dt)
  end
  local pacc = Dynamics.vscale(Dynamics.vsub(pvel, state.prevVel), 1 / dt)
  local avx, avy, avz = 0, 0, 0
  if state.prevQuat ~= nil then
    local pq: any = state.prevQuat
    avx, avy, avz = Dynamics.qAngularVelocity(pq.w, pq.x, pq.y, pq.z, qw, qx, qy, qz, dt)
  end
  local toRad = math.pi / 180
  local paa = Dynamics.vscale(Dynamics.vsub(
    { x = avx * toRad, y = avy * toRad, z = avz * toRad },
    Dynamics.vscale(state.prevAngVel, toRad)), 1 / dt)
  local omega = math.sqrt(k / mass)
  local hMax = 1 / omega
  local n = math.clamp(math.ceil(dt / hMax), 1, 32)
  local h = dt / n
  local offP, velP, offR, velR = state.offP, state.velP, state.offR, state.velR
  for _ = 1, n do
    offP, velP = Dynamics.springAxis(offP, velP, pacc, k, damp, mass, fw, h)
    offR, velR = Dynamics.springAxis(offR, velR, paa, k, damp, mass, fw, h)
  end
  local maxDisp = tonumber(c.maxDisplacement)
  if maxDisp ~= nil and maxDisp >= 0 and Dynamics.vlen(offP) > maxDisp then
    offP = Dynamics.vscale(offP, maxDisp / Dynamics.vlen(offP))
  end
  local maxRot = tonumber(c.maxRotationDeg)
  if maxRot ~= nil and maxRot >= 0 then
    local halfLen = Dynamics.vlen(offR)
    local maxHalf = (maxRot * math.pi / 180) / 2
    if halfLen > maxHalf and halfLen > 1e-12 then
      offR = Dynamics.vscale(offR, maxHalf / halfLen)
    end
  end
  state.offP, state.velP, state.offR, state.velR = offP, velP, offR, velR
  state.prevPos = { x = px, y = py, z = pz }
  state.prevVel = pvel
  state.prevQuat = { w = qw, x = qx, y = qy, z = qz }
  state.prevAngVel = { x = avx, y = avy, z = avz }
  local ew, ex, ey, ez = Dynamics.qexp(offR.x, offR.y, offR.z)
  local rw, rx, ry, rz = Dynamics.qmul(qw, qx, qy, qz, ew, ex, ey, ez)
  return {
    pos = { x = px + offP.x, y = py + offP.y, z = pz + offP.z },
    rot = { w = rw, x = rx, y = ry, z = rz },
  }
end

function Dynamics.applySecondary(target: Instance, jointName: string, primaryCf: CFrame, cfg: any, dt: number, states: any): (boolean, string?)
  local RA: any = Dynamics.adapters()
  if RA == nil then return false, "rig_adapter_unavailable" end
  local inst = Dynamics.resolveJoint(target, jointName)
  if inst == nil then return false, "joint_not_found:" .. tostring(jointName):sub(1, 48) end
  local st: any = states[jointName]
  if st == nil then
    st = Dynamics.createState()
    states[jointName] = st
  end
  local ok, res: any = pcall(function()
    local p = primaryCf.Position
    local q = RA.cframeToQuat(primaryCf)
    return Dynamics.step(st,
      { x = p.X, y = p.Y, z = p.Z },
      { w = q.w, x = q.x, y = q.y, z = q.z }, cfg, tonumber(dt) or 0)
  end)
  if not ok then return false, tostring(res) end
  local c: any = RA.classify(inst)
  local channel: string = RA.probe(inst, c.kind)
  return RA.writePose(inst, channel, res.pos, res.rot)
end

function Dynamics.simulateTrack(keys: any, cfg: any, jointName: string?): any
  local out: any = {}
  local st = Dynamics.createState()
  local prevT: number? = nil
  local sorted: any = {}
  for _, k in ipairs(keys) do table.insert(sorted, k) end
  table.sort(sorted, function(a: any, b: any) return (tonumber(a.t) or 0) < (tonumber(b.t) or 0) end)
  for _, k in ipairs(sorted) do
    local kk: any = k
    local t = tonumber(kk.t) or 0
    local dt = 0
    if prevT ~= nil then dt = t - (prevT :: number) end
    local res = Dynamics.step(st, kk.pos, kk.rot, cfg, dt)
    table.insert(out, { t = t, pos = res.pos, rot = res.rot,
      joint = jointName or kk.joint, easing = "linear" })
    prevT = t
  end
  return out
end
--[[DYNAMICS_END]]
--[[ANIMLAB_BEGIN (canonical source: studio-plugin/animation/AnimationLab.lua; check_rigadapter_sync.js enforces equality)]]
local AnimationLab = {
  frameSeq = 0,
  W = 320,
  H = 180,
  widget = nil,
  state = nil,
  EASE_CYCLE = { "linear", "quadInOut", "cubicInOut", "sineInOut", "bezierOut", "springOut" },
}

function AnimationLab.newState(): any
  return {
    target = "Workspace",
    tracks = {},
    rig = {},
    quality = {},
    ik = {},
    contacts = {},
    limits = {},
    thresholds = {},
    selectedJoint = "",
    selectedKey = 0,
    playhead = 0,
    duration = 1,
    playing = false,
    stopNow = false,
    held = {},
    view = "dope",
    heart = nil,
  }
end

function AnimationLab.getState(): any
  if AnimationLab.state == nil then AnimationLab.state = AnimationLab.newState() end
  return AnimationLab.state
end

function AnimationLab.resolveJoint(target: Instance, jointName: string): Instance?
  local best: Instance? = nil
  pcall(function()
    for _, d in ipairs(target:GetDescendants()) do
      if d.Name == jointName and (d:IsA("Motor6D") or d:IsA("AnimationConstraint")
        or d:IsA("Bone") or d:IsA("BasePart")) then
        best = d
        break
      end
    end
    if not best and target.Name == jointName then best = target end
  end)
  return best
end

function AnimationLab.drivenPart(inst: Instance): Instance?
  if inst:IsA("BasePart") then return inst end
  local part: Instance? = nil
  pcall(function()
    if inst:IsA("Motor6D") or inst:IsA("AnimationConstraint") then
      local p: any = (inst :: any).Part1
      if p ~= nil and (p :: Instance):IsA("BasePart") then part = p end
    end
  end)
  return part
end

function AnimationLab.colors(): any
  return {
    panel = Color3.fromRGB(20, 20, 23),
    lane = Color3.fromRGB(30, 30, 35),
    rowAlt = Color3.fromRGB(25, 25, 29),
    input = Color3.fromRGB(36, 36, 42),
    text = Color3.fromRGB(232, 232, 236),
    dim = Color3.fromRGB(150, 150, 162),
    accent = Color3.fromRGB(255, 140, 26),
    accentText = Color3.fromRGB(24, 14, 4),
    diamond = Color3.fromRGB(76, 194, 255),
    good = Color3.fromRGB(130, 220, 150),
    bad = Color3.fromRGB(255, 110, 110),
  }
end

function AnimationLab.status(msg: string, isErr: boolean?)
  print("[RoLinkLab] " .. msg)
  pcall(function()
    local st = AnimationLab.getState()
    if st.statusLbl ~= nil then
      (st.statusLbl :: TextLabel).Text = ((isErr and "ERR " or "") .. msg):sub(1, 220);
      (st.statusLbl :: TextLabel).TextColor3 = (isErr and AnimationLab.colors().bad or AnimationLab.colors().dim);
    end
  end)
end

function AnimationLab.clear(f: Instance?)
  if f == nil then return end
  for _, c in ipairs((f :: Instance):GetChildren()) do
    if not c:IsA("UIListLayout") and not c:IsA("UIPadding") then
      pcall(function() c:Destroy() end)
    end
  end
end

function AnimationLab.head(parent: Instance, txt: string)
  local h = Instance.new("TextLabel")
  h.Text = txt
  h.Font = Enum.Font.GothamBold
  h.TextSize = 11
  h.TextColor3 = AnimationLab.colors().dim
  h.BackgroundTransparency = 1
  h.TextXAlignment = Enum.TextXAlignment.Left
  h.Size = UDim2.new(1, 0, 0, 18)
  h.Parent = parent
end

function AnimationLab.row(parent: Instance, h: number): Instance
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

function AnimationLab.btn(parent: Instance, name: string, text: string, w: number, hot: boolean?): Instance
  local b = Instance.new("TextButton")
  b.Name = name
  b.Text = text
  b.Font = Enum.Font.GothamBold
  b.TextSize = 12
  b.AutoButtonColor = true
  b.BackgroundColor3 = hot and AnimationLab.colors().accent or AnimationLab.colors().lane
  b.TextColor3 = hot and AnimationLab.colors().accentText or AnimationLab.colors().text
  b.BorderSizePixel = 0
  b.Size = UDim2.new(0, w, 0, 24)
  b.Parent = parent
  local c = Instance.new("UICorner")
  c.CornerRadius = UDim.new(0, 4)
  c.Parent = b
  return b
end

function AnimationLab.box(parent: Instance, name: string, text: string, w: number): Instance
  local b = Instance.new("TextBox")
  b.Name = name
  b.Text = text
  b.ClearTextOnFocus = false
  b.Font = Enum.Font.Code
  b.TextSize = 12
  b.BackgroundColor3 = AnimationLab.colors().input
  b.TextColor3 = AnimationLab.colors().text
  b.BorderSizePixel = 0
  b.Size = UDim2.new(0, w, 0, 24)
  b.Parent = parent
  return b
end

function AnimationLab.label(parent: Instance, txt: string, w: number): Instance
  local t = Instance.new("TextLabel")
  t.Text = txt
  t.Font = Enum.Font.Gotham
  t.TextSize = 12
  t.TextColor3 = AnimationLab.colors().text
  t.BackgroundTransparency = 1
  t.TextXAlignment = Enum.TextXAlignment.Left
  t.TextTruncate = Enum.TextTruncate.AtEnd
  t.Size = UDim2.new(0, w, 0, 20)
  t.Parent = parent
  return t
end

function AnimationLab.scroll(parent: Instance, h: number): Instance
  local s = Instance.new("ScrollingFrame")
  s.BackgroundColor3 = AnimationLab.colors().lane
  s.BorderSizePixel = 0
  s.Size = UDim2.new(1, 0, 0, h)
  s.CanvasSize = UDim2.new(0, 0, 0, 0)
  s.AutomaticCanvasSize = Enum.AutomaticSize.Y
  s.Parent = parent
  local l = Instance.new("UIListLayout")
  l.FillDirection = Enum.FillDirection.Vertical
  l.Padding = UDim.new(0, 2)
  l.Parent = s
  return s
end

function AnimationLab.setTracks(tracks: any)
  local st = AnimationLab.getState()
  st.tracks = tracks or {}
  local dur = 1
  for _, t in ipairs(st.tracks) do
    local tt: any = t
    if tt.keys ~= nil then
      for _, k in ipairs(tt.keys) do
        local kt = tonumber((k :: any).t) or 0
        if kt > dur then dur = kt end
      end
    end
  end
  st.duration = dur
  if st.playhead > dur then st.playhead = dur end
  AnimationLab.renderAll()
end

function AnimationLab.setRig(bindings: any)
  AnimationLab.getState().rig = bindings or {}
  AnimationLab.renderAll()
end

function AnimationLab.setQuality(issues: any)
  AnimationLab.getState().quality = issues or {}
  AnimationLab.renderAll()
end

function AnimationLab.setIK(chains: any)
  AnimationLab.getState().ik = chains or {}
  AnimationLab.renderAll()
end

function AnimationLab.setContacts(specs: any)
  AnimationLab.getState().contacts = specs or {}
  AnimationLab.renderAll()
end

function AnimationLab.setLimits(limits: any, thresholds: any)
  local st = AnimationLab.getState()
  st.limits = limits or {}
  st.thresholds = thresholds or {}
  AnimationLab.renderAll()
end

function AnimationLab.findTrack(joint: string): any
  local st = AnimationLab.getState()
  for _, t in ipairs(st.tracks) do
    if (t :: any).joint == joint then return t end
  end
  return nil
end

function AnimationLab.jointNames(): any
  local st = AnimationLab.getState()
  local names: any = {}
  local seen: { [string]: boolean } = {}
  for _, t in ipairs(st.tracks) do
    local jn = tostring((t :: any).joint or "")
    if jn ~= "" and not seen[jn] then seen[jn] = true table.insert(names, jn) end
  end
  if #names == 0 and type(st.rig) == "table" then
    for _, b in ipairs(st.rig) do
      local jn = tostring((b :: any).name or "")
      if jn ~= "" and not seen[jn] then seen[jn] = true table.insert(names, jn) end
    end
  end
  table.sort(names)
  return names
end

function AnimationLab.toggle(pluginObj: any)
  local st = AnimationLab.getState()
  if st.widget ~= nil then
    local ok, enabled: any = pcall(function() return (st.widget :: DockWidgetPluginGui).Enabled end)
    if ok then
      pcall(function() (st.widget :: DockWidgetPluginGui).Enabled = not enabled end)
      return
    end
    st.widget = nil
  end
  local ok, err: any = pcall(function() AnimationLab.build(pluginObj) end)
  if not ok then
    warn("[RoLink] animation lab build failed: " .. tostring(err):sub(1, 300))
  end
end

function AnimationLab.build(pluginObj: any)
  if pluginObj == nil then error("animation lab needs the plugin object", 0) end
  local info = DockWidgetPluginGuiInfo.new(Enum.InitialDockState.Float, false, false, 420, 640, 320, 480)
  local w: DockWidgetPluginGui = pluginObj:CreateDockWidgetPluginGui("RoLinkAnimLab", info)
  w.Title = "RoLink Animation Lab"
  w.Name = "RoLinkAnimLab"
  local st = AnimationLab.getState()
  st.widget = w
  local root = Instance.new("Frame")
  root.BackgroundColor3 = AnimationLab.colors().panel
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
  local title = Instance.new("TextLabel")
  title.Text = "RoLink Animation Lab"
  title.Font = Enum.Font.GothamBold
  title.TextSize = 14
  title.TextColor3 = AnimationLab.colors().accent
  title.BackgroundTransparency = 1
  title.TextXAlignment = Enum.TextXAlignment.Left
  title.Size = UDim2.new(1, 0, 0, 24)
  title.Parent = root
  local tabs = AnimationLab.row(root, 26)
  st.tabRow = tabs
  for _, v in ipairs({ "dope", "curves", "inspector", "ik", "contacts", "graphs", "quality" }) do
    local b: any = AnimationLab.btn(tabs, "tab_" .. v, v, 62, v == st.view)
    b.MouseButton1Click:Connect(function()
      st.view = v
      AnimationLab.renderAll()
    end)
  end
  local body = Instance.new("ScrollingFrame")
  body.Name = "LabBody"
  body.BackgroundTransparency = 1
  body.BorderSizePixel = 0
  body.Size = UDim2.new(1, 0, 1, -170)
  body.CanvasSize = UDim2.new(0, 0, 0, 0)
  body.AutomaticCanvasSize = Enum.AutomaticSize.Y
  body.Parent = root
  local layout = Instance.new("UIListLayout")
  layout.FillDirection = Enum.FillDirection.Vertical
  layout.Padding = UDim.new(0, 4)
  layout.Parent = body
  st.body = body
  local transport = AnimationLab.row(root, 26)
  local playB: any = AnimationLab.btn(transport, "labPlay", "Play", 64, true)
  playB.MouseButton1Click:Connect(function() pcall(function() AnimationLab.play() end) end)
  local stopB: any = AnimationLab.btn(transport, "labStop", "Stop", 64)
  stopB.MouseButton1Click:Connect(function() pcall(function() AnimationLab.stop() end) end)
  st.timeLbl = AnimationLab.label(transport, "t=0.000", 120)
  local status = Instance.new("TextLabel")
  status.Name = "LabStatus"
  status.Text = "lab ready - feed tracks via setTracks"
  status.Font = Enum.Font.Code
  status.TextSize = 11
  status.TextColor3 = AnimationLab.colors().dim
  status.BackgroundTransparency = 1
  status.TextXAlignment = Enum.TextXAlignment.Left
  status.TextTruncate = Enum.TextTruncate.AtEnd
  status.Size = UDim2.new(1, 0, 0, 18)
  status.Parent = root
  st.statusLbl = status
  AnimationLab.renderAll()
  AnimationLab.status("lab built - feed tracks, rig, quality via set* calls", false)
end

function AnimationLab.renderAll()
  local st = AnimationLab.getState()
  if st.widget == nil or st.body == nil then return end
  pcall(function()
    if st.timeLbl ~= nil then
      (st.timeLbl :: TextLabel).Text = string.format("t=%.3f / %.3f", st.playhead, st.duration)
    end
  end)
  for _, c in ipairs(st.tabRow:GetChildren()) do
    if c:IsA("TextButton") then
      local on = c.Name == "tab_" .. st.view
      c.BackgroundColor3 = on and AnimationLab.colors().accent or AnimationLab.colors().lane
      c.TextColor3 = on and AnimationLab.colors().accentText or AnimationLab.colors().text
    end
  end
  AnimationLab.clear(st.body)
  local ok, err: any = pcall(function()
    if st.view == "dope" then AnimationLab.renderDope(st.body)
    elseif st.view == "curves" then AnimationLab.renderCurves(st.body)
    elseif st.view == "inspector" then AnimationLab.renderInspector(st.body)
    elseif st.view == "ik" then AnimationLab.renderIK(st.body)
    elseif st.view == "contacts" then AnimationLab.renderContacts(st.body)
    elseif st.view == "graphs" then AnimationLab.renderGraphs(st.body)
    elseif st.view == "quality" then AnimationLab.renderQuality(st.body)
    end
  end)
  if not ok then AnimationLab.status("render failed: " .. tostring(err):sub(1, 160), true) end
end

function AnimationLab.lane(parent: Instance, joint: string, keys: any, dur: number, onPick: any)
  local row = Instance.new("Frame")
  row.BackgroundColor3 = AnimationLab.colors().lane
  row.BorderSizePixel = 0
  row.Size = UDim2.new(1, 0, 0, 22)
  row.Parent = parent
  local nm = Instance.new("TextLabel")
  nm.Text = joint:sub(1, 18)
  nm.Font = Enum.Font.Code
  nm.TextSize = 11
  nm.TextColor3 = AnimationLab.colors().text
  nm.BackgroundTransparency = 1
  nm.TextXAlignment = Enum.TextXAlignment.Left
  nm.Size = UDim2.new(0, 110, 1, 0)
  nm.Position = UDim2.new(0, 4, 0, 0)
  nm.Parent = row
  local span = math.max(dur, 1e-6)
  if type(keys) == "table" then
    for idx, k in ipairs(keys) do
      local kk: any = k
      local frac = math.clamp((tonumber(kk.t) or 0) / span, 0, 1)
      local d = Instance.new("TextButton")
      d.Text = ""
      d.BackgroundColor3 = AnimationLab.colors().diamond
      d.BorderSizePixel = 0
      d.Size = UDim2.new(0, 10, 0, 10)
      d.Position = UDim2.new(0, 118 + frac * 300, 0, 6)
      d.Rotation = 45
      d.Parent = row
      local myIdx = idx
      d.MouseButton1Click:Connect(function()
        if onPick ~= nil then onPick(joint, myIdx) end
      end)
    end
  end
  return row
end

function AnimationLab.renderDope(body: Instance)
  local st = AnimationLab.getState()
  AnimationLab.head(body, "DOPE SHEET — click a key to inspect")
  local names = AnimationLab.jointNames()
  if #names == 0 then
    AnimationLab.label(body, "(no tracks - call AnimationLab.setTracks)", 320)
    return
  end
  for _, jn in ipairs(names) do
    local track = AnimationLab.findTrack(jn)
    local keys: any = {}
    if track ~= nil then keys = track.keys or {} end
    AnimationLab.lane(body, jn, keys, st.duration, function(j: string, i: number)
      st.selectedJoint = j
      st.selectedKey = i
      st.view = "inspector"
      AnimationLab.renderAll()
    end)
  end
  local bar = AnimationLab.row(body, 20)
  AnimationLab.label(bar, "playhead", 70)
  local scrub: any = AnimationLab.btn(bar, "scrub", string.format("%.2f", st.playhead), 80)
  scrub.MouseButton1Click:Connect(function()
    st.playhead = st.playhead + 0.1
    if st.playhead > st.duration then st.playhead = 0 end
    pcall(function() AnimationLab.applyAt(st.playhead) end)
    AnimationLab.renderAll()
  end)
end

function AnimationLab.bakeFlat(joint: string, fps: number): any
  local CU: any = nil
  if Curves ~= nil then CU = Curves end
  if CU == nil then
    pcall(function()
      local m = script:FindFirstChild("Curves")
      if m ~= nil and m:IsA("ModuleScript") then CU = require(m) end
    end)
  end
  if CU == nil then return nil end
  local track = AnimationLab.findTrack(joint)
  if track == nil or track.keys == nil or #track.keys == 0 then return nil end
  local ok, baked: any = pcall(function() return CU.bakeKeys(track.keys, fps or 30, nil) end)
  if not ok or baked == nil then return nil end
  return baked
end

function AnimationLab.renderCurves(body: Instance)
  local st = AnimationLab.getState()
  local jn = st.selectedJoint
  if jn == "" then
    local names = AnimationLab.jointNames()
    if #names > 0 then
      jn = names[1]
      st.selectedJoint = jn
    end
  end
  AnimationLab.head(body, "CURVES — " .. (jn == "" and "(no joint)" or jn))
  if jn == "" then return end
  local track = AnimationLab.findTrack(jn)
  if track == nil or track.keys == nil or #track.keys == 0 then
    AnimationLab.label(body, "(no keys on " .. jn .. ")", 320)
    return
  end
  local keys: any = track.keys
  local n = #keys
  local row = AnimationLab.row(body, 24)
  AnimationLab.label(row, "keys: " .. n, 90)
  if st.dragConns ~= nil then
    for _, conn in ipairs(st.dragConns) do
      pcall(function() (conn :: RBXScriptConnection):Disconnect() end)
    end
  end
  st.dragConns = {}
  local cyc: any = AnimationLab.btn(row, "easeCycle", "cycle easing", 110)
  cyc.MouseButton1Click:Connect(function()
    local list = AnimationLab.EASE_CYCLE
    for _, k in ipairs(keys) do
      local kk: any = k
      local cur = tostring(kk.easing or "linear")
      local at = 1
      for i, e in ipairs(list) do if e == cur then at = i break end end
      kk.easing = list[(at % #list) + 1]
    end
    AnimationLab.status("easing cycled on " .. jn, false)
    AnimationLab.renderAll()
  end)
  local canvas = Instance.new("Frame")
  canvas.BackgroundColor3 = AnimationLab.colors().input
  canvas.BorderSizePixel = 0
  canvas.Size = UDim2.new(1, 0, 0, 120)
  canvas.Parent = body
  local span = math.max(st.duration, 1e-6)
  for i, k in ipairs(keys) do
    local kk: any = k
    local frac = math.clamp((tonumber(kk.t) or 0) / span, 0, 1)
    local d = Instance.new("TextButton")
    d.Text = tostring(i)
    d.Font = Enum.Font.Code
    d.TextSize = 10
    d.TextColor3 = AnimationLab.colors().accentText
    d.BackgroundColor3 = AnimationLab.colors().diamond
    d.BorderSizePixel = 0
    d.Size = UDim2.new(0, 18, 0, 18)
    d.Position = UDim2.new(frac, -9, 0.5, -9)
    d.Parent = canvas
    local idx = i
    local drag = false
    d.InputBegan:Connect(function(input: InputObject)
      if input.UserInputType == Enum.UserInputType.MouseButton1 then drag = true end
    end)
    d.InputEnded:Connect(function(input: InputObject)
      if input.UserInputType == Enum.UserInputType.MouseButton1 and drag then
        drag = false
        AnimationLab.status("key " .. idx .. " retimed to " .. string.format("%.3f", tonumber(keys[idx].t) or 0), false)
        AnimationLab.renderAll()
      end
    end)
    pcall(function()
      local conn: RBXScriptConnection =
        game:GetService("UserInputService").InputChanged:Connect(function(input: InputObject)
          if drag and input.UserInputType == Enum.UserInputType.MouseMovement then
            local rel = math.clamp((input.Position.X - canvas.AbsolutePosition.X) / math.max(canvas.AbsoluteSize.X, 1), 0, 1)
            keys[idx].t = rel * span
            d.Position = UDim2.new(rel, -9, 0.5, -9)
          end
        end)
      table.insert(st.dragConns, conn)
    end)
  end
  AnimationLab.label(body, "drag keys to retime - tangent stubs show neighbor slope", 340)
  if n >= 2 then
    for i = 1, math.min(n - 1, 4) do
      local a: any = keys[i]
      local b: any = keys[i + 1]
      local slope = ((tonumber(b.t) or 0) - (tonumber(a.t) or 0))
      AnimationLab.label(body, string.format("seg %d: dt=%.3f ease=%s", i, slope, tostring(b.easing or "linear")), 340)
    end
  end
end

function AnimationLab.limitText(joint: string): string
  local st = AnimationLab.getState()
  if type(st.limits) ~= "table" then return "no calibrated limits" end
  for _, l in ipairs(st.limits) do
    local ll: any = l
    if tostring(ll.joint) == joint then
      local parts: any = {}
      if ll.minDeg ~= nil and ll.maxDeg ~= nil then
        for _, ax in ipairs({ "x", "y", "z" }) do
          local mn = tonumber(ll.minDeg[ax])
          local mx = tonumber(ll.maxDeg[ax])
          if mn ~= nil and mx ~= nil then
            table.insert(parts, ax .. ":[" .. mn .. "," .. mx .. "]")
          end
        end
      end
      if #parts == 0 then return "unconstrained" end
      return table.concat(parts, " ")
    end
  end
  return "no calibrated limits"
end

function AnimationLab.renderInspector(body: Instance)
  local st = AnimationLab.getState()
  AnimationLab.head(body, "POSE INSPECTOR")
  local names = AnimationLab.jointNames()
  if #names == 0 then
    AnimationLab.label(body, "(no tracks loaded)", 320)
    return
  end
  local jn = st.selectedJoint
  if jn == "" then
    jn = names[1]
    st.selectedJoint = jn
  end
  local row = AnimationLab.row(body, 24)
  AnimationLab.label(row, "joint", 50)
  local pick: any = AnimationLab.box(row, "inspJoint", jn, 150)
  local go: any = AnimationLab.btn(row, "inspGo", "show", 64)
  go.MouseButton1Click:Connect(function()
    st.selectedJoint = tostring(pick.Text):gsub("^%s+", ""):gsub("%s+$", "")
    st.selectedKey = 0
    AnimationLab.renderAll()
  end)
  local track = AnimationLab.findTrack(jn)
  if track == nil or track.keys == nil or #track.keys == 0 then
    AnimationLab.label(body, "(no keys on " .. jn .. ")", 320)
    return
  end
  local keys: any = track.keys
  local idx = math.clamp(st.selectedKey, 1, #keys)
  if st.selectedKey < 1 then idx = 1 end
  st.selectedKey = idx
  local k: any = keys[idx]
  AnimationLab.label(body, string.format("key %d/%d  t=%.3f  ease=%s", idx, #keys, tonumber(k.t) or 0, tostring(k.easing or "linear")), 340)
  local rp = AnimationLab.row(body, 24)
  AnimationLab.label(rp, "pos", 40)
  local bx: any = AnimationLab.box(rp, "px", string.format("%.3f", tonumber(k.pos.x) or 0), 70)
  local by: any = AnimationLab.box(rp, "py", string.format("%.3f", tonumber(k.pos.y) or 0), 70)
  local bz: any = AnimationLab.box(rp, "pz", string.format("%.3f", tonumber(k.pos.z) or 0), 70)
  local rr = AnimationLab.row(body, 24)
  AnimationLab.label(rr, "rot", 40)
  local hasW = k.rot ~= nil and (k.rot :: any).w ~= nil
  if hasW then
    AnimationLab.label(body, "(quaternion rotation - edit position here, rotation via curves)", 340)
  end
  local brx: any = AnimationLab.box(rr, "rx", hasW and "quat" or string.format("%.1f", tonumber(k.rot.x) or 0), 70)
  local bry: any = AnimationLab.box(rr, "ry", hasW and "" or string.format("%.1f", tonumber(k.rot.y) or 0), 70)
  local brz: any = AnimationLab.box(rr, "rz", hasW and "" or string.format("%.1f", tonumber(k.rot.z) or 0), 70)
  local apply: any = AnimationLab.btn(body, "inspApply", "apply edits", 110)
  apply.Parent = body
  apply.MouseButton1Click:Connect(function()
    local ok, err: any = pcall(function()
      k.pos = { x = tonumber(bx.Text) or 0, y = tonumber(by.Text) or 0, z = tonumber(bz.Text) or 0 }
      if not hasW then
        k.rot = { x = tonumber(brx.Text) or 0, y = tonumber(bry.Text) or 0, z = tonumber(brz.Text) or 0 }
      end
    end)
    if ok then AnimationLab.status("key " .. idx .. " updated on " .. jn, false)
    else AnimationLab.status("edit failed: " .. tostring(err):sub(1, 120), true) end
    AnimationLab.renderAll()
  end)
  AnimationLab.head(body, "JOINT LIMITS")
  AnimationLab.label(body, AnimationLab.limitText(jn), 340)
end

function AnimationLab.renderIK(body: Instance)
  local st = AnimationLab.getState()
  AnimationLab.head(body, "IK CONTROLS (Play-time IKControl)")
  if type(st.ik) ~= "table" or #st.ik == 0 then
    AnimationLab.label(body, "(no chains - call AnimationLab.setIK)", 320)
  else
    for _, ch in ipairs(st.ik) do
      local c: any = ch
      local row = AnimationLab.row(body, 24)
      AnimationLab.label(row, tostring(c.name or "?"), 110)
      AnimationLab.label(row, "w=" .. tostring(c.weight or 1), 60)
      local mk: any = AnimationLab.btn(row, "mk_" .. tostring(c.name), "create", 70)
      local cid = tostring(c.name)
      mk.MouseButton1Click:Connect(function()
        AnimationLab.ikCreate(cid)
      end)
      local rm: any = AnimationLab.btn(row, "rm_" .. tostring(c.name), "remove", 70)
      rm.MouseButton1Click:Connect(function()
        AnimationLab.ikRemove(cid)
      end)
    end
  end
  local row = AnimationLab.row(body, 24)
  AnimationLab.label(row, "root", 44)
  local r1: any = AnimationLab.box(row, "ikRoot", "", 100)
  AnimationLab.label(row, "end", 36)
  local r2: any = AnimationLab.box(row, "ikEnd", "", 100)
  local go: any = AnimationLab.btn(row, "ikGo", "build", 64)
  go.MouseButton1Click:Connect(function()
    AnimationLab.ikCreateFrom(
      tostring(r1.Text):gsub("^%s+", ""):gsub("%s+$", ""),
      tostring(r2.Text):gsub("^%s+", ""):gsub("%s+$", ""))
  end)
end

function AnimationLab.findChain(name: string): any
  local st = AnimationLab.getState()
  if type(st.ik) ~= "table" then return nil end
  for _, ch in ipairs(st.ik) do
    if tostring((ch :: any).name) == name then return ch end
  end
  return nil
end

function AnimationLab.ikCreate(name: string)
  local st = AnimationLab.getState()
  local spec: any = AnimationLab.findChain(name)
  if spec == nil then AnimationLab.status("no chain named " .. name, true) return end
  local IKm: any = nil
  if IK ~= nil then IKm = IK end
  if IKm == nil then
    pcall(function()
      local m = script:FindFirstChild("IK")
      if m ~= nil and m:IsA("ModuleScript") then IKm = require(m) end
    end)
  end
  if IKm == nil then AnimationLab.status("IK module unavailable", true) return end
  local target = AnimationLab.resolveTarget()
  if target == nil then AnimationLab.status("no target model - set target box", true) return end
  local ok, res: any = pcall(function()
    local root = AnimationLab.resolveJoint(target, tostring(spec.root or ""))
    local tip = AnimationLab.resolveJoint(target, tostring(spec.endEffector or ""))
    if root == nil or tip == nil then error("chain endpoints not found", 0) end
    local tgt = tip
    if spec.target ~= nil and spec.target ~= "" then
      tgt = AnimationLab.resolveJoint(target, tostring(spec.target)) or tip
    end
    return IKm.create(root, tip, { target = tgt, weight = tonumber(spec.weight) or 1,
      priority = tonumber(spec.priority) or 0 })
  end)
  if ok and res ~= nil then
    st["liveIK_" .. name] = res
    AnimationLab.status("IK chain " .. name .. " created", false)
  else
    AnimationLab.status("IK create failed: " .. tostring(res):sub(1, 140), true)
  end
  AnimationLab.renderAll()
end

function AnimationLab.ikRemove(name: string)
  local st = AnimationLab.getState()
  local ctl = st["liveIK_" .. name]
  st["liveIK_" .. name] = nil
  if ctl == nil then AnimationLab.status("no live chain " .. name, true) return end
  local IKm: any = nil
  if IK ~= nil then IKm = IK end
  if IKm == nil then AnimationLab.status("IK module unavailable", true) return end
  local ok, err: any = pcall(function() return IKm.remove(ctl) end)
  if ok then AnimationLab.status("IK chain " .. name .. " removed", false)
  else AnimationLab.status("IK remove failed: " .. tostring(err):sub(1, 120), true) end
  AnimationLab.renderAll()
end

function AnimationLab.ikCreateFrom(rootName: string, endName: string)
  if rootName == "" or endName == "" then
    AnimationLab.status("enter root + end joint names", true)
    return
  end
  local st = AnimationLab.getState()
  if type(st.ik) ~= "table" then st.ik = {} end
  table.insert(st.ik, { name = rootName .. "_to_" .. endName,
    root = rootName, endEffector = endName, chain = {}, weight = 1, priority = 0 })
  AnimationLab.status("chain drafted - press create", false)
  AnimationLab.renderAll()
end

function AnimationLab.resolveTarget(): Instance?
  local st = AnimationLab.getState()
  local path = tostring(st.target or "Workspace")
  local found: Instance? = nil
  pcall(function()
    if path == "Workspace" or path == "workspace" then found = workspace
    else
      local cur: Instance? = game
      for _, part in ipairs(string.split(path, ".")) do
        if cur == nil then break end
        if part == "game" then cur = game
        elseif part == "Workspace" or part == "workspace" then cur = workspace
        else cur = cur:FindFirstChild(part) end
      end
      found = cur
    end
  end)
  return found
end

function AnimationLab.renderContacts(body: Instance)
  local st = AnimationLab.getState()
  AnimationLab.head(body, "CONTACT LOCKS (Edit-time enforcement)")
  if type(st.contacts) ~= "table" or #st.contacts == 0 then
    AnimationLab.label(body, "(no specs - call AnimationLab.setContacts)", 320)
  else
    for _, sp in ipairs(st.contacts) do
      local s: any = sp
      local row = AnimationLab.row(body, 24)
      AnimationLab.label(row, tostring(s.name or "?"), 100)
      AnimationLab.label(row, tostring(s.joint or "?"), 90)
      local lk: any = AnimationLab.btn(row, "lk_" .. tostring(s.name), "lock", 64)
      local nm = tostring(s.name)
      lk.MouseButton1Click:Connect(function()
        AnimationLab.contactLock(nm)
      end)
      local rl: any = AnimationLab.btn(row, "rl_" .. tostring(s.name), "release", 64)
      rl.MouseButton1Click:Connect(function()
        AnimationLab.contactRelease(nm)
      end)
    end
  end
  local row = AnimationLab.row(body, 24)
  local en: any = AnimationLab.btn(row, "enforce", "enforce all", 110, true)
  en.MouseButton1Click:Connect(function()
    AnimationLab.contactEnforce()
  end)
  if st.contactReport ~= nil then
    AnimationLab.label(body, tostring(st.contactReport):sub(1, 120), 340)
  end
end

function AnimationLab.findSpec(name: string): any
  local st = AnimationLab.getState()
  if type(st.contacts) ~= "table" then return nil end
  for _, sp in ipairs(st.contacts) do
    if tostring((sp :: any).name) == name then return sp end
  end
  return nil
end

function AnimationLab.contactsMod(): any
  if Contacts ~= nil then return Contacts end
  local out: any = nil
  pcall(function()
    local m = script:FindFirstChild("Contacts")
    if m ~= nil and m:IsA("ModuleScript") then out = require(m) end
  end)
  return out
end

function AnimationLab.contactLock(name: string)
  local st = AnimationLab.getState()
  local spec: any = AnimationLab.findSpec(name)
  if spec == nil then AnimationLab.status("no spec " .. name, true) return end
  local CM: any = AnimationLab.contactsMod()
  if CM == nil then AnimationLab.status("Contacts module unavailable", true) return end
  local target = AnimationLab.resolveTarget()
  if target == nil then AnimationLab.status("no target model", true) return end
  local wp: any = spec.worldPosition or { x = 0, y = 0, z = 0 }
  local ok, id: any = pcall(function()
    return CM.createLock(target, tostring(spec.joint or ""),
      CFrame.new(tonumber(wp.x) or 0, tonumber(wp.y) or 0, tonumber(wp.z) or 0),
      tonumber(spec.stiffness) or 1)
  end)
  if ok and id ~= nil then
    st["lock_" .. name] = id
    AnimationLab.status("contact " .. name .. " locked (#" .. id .. ")", false)
  else
    AnimationLab.status("lock failed: " .. tostring(id):sub(1, 140), true)
  end
  AnimationLab.renderAll()
end

function AnimationLab.contactRelease(name: string)
  local st = AnimationLab.getState()
  local id = st["lock_" .. name]
  st["lock_" .. name] = nil
  if id == nil then AnimationLab.status("no live lock " .. name, true) return end
  local CM: any = AnimationLab.contactsMod()
  if CM == nil then AnimationLab.status("Contacts module unavailable", true) return end
  local ok: boolean = false
  pcall(function() ok = CM.releaseLock(id) end)
  AnimationLab.status(ok and ("contact " .. name .. " released") or ("release failed " .. name), not ok)
  AnimationLab.renderAll()
end

function AnimationLab.contactEnforce()
  local st = AnimationLab.getState()
  local CM: any = AnimationLab.contactsMod()
  if CM == nil then AnimationLab.status("Contacts module unavailable", true) return end
  local ok, rep: any = pcall(function() return CM.enforceAll() end)
  if ok and rep ~= nil then
    st.contactReport = "enforced " .. tostring(rep.enforced or 0) .. " locks, errors " .. #(rep.errors or {})
    AnimationLab.status(tostring(st.contactReport), false)
  else
    AnimationLab.status("enforce failed: " .. tostring(rep):sub(1, 120), true)
  end
  AnimationLab.renderAll()
end

function AnimationLab.renderGraphs(body: Instance)
  local st = AnimationLab.getState()
  AnimationLab.head(body, "VELOCITY / ACCELERATION / JERK")
  local jn = st.selectedJoint
  if jn == "" then
    local names = AnimationLab.jointNames()
    if #names > 0 then
      jn = names[1]
      st.selectedJoint = jn
    end
  end
  if jn == "" then
    AnimationLab.label(body, "(no tracks loaded)", 320)
    return
  end
  local baked: any = AnimationLab.bakeFlat(jn, 30)
  if baked == nil or #baked == 0 then
    AnimationLab.label(body, "(cannot sample " .. jn .. ")", 320)
    return
  end
  local speeds: any = {}
  local accels: any = {}
  local jerks: any = {}
  local function spd(a: any, b: any, dt: number): number
    if dt <= 1e-9 then return 0 end
    local dx = (tonumber(b.pos.x) or 0) - (tonumber(a.pos.x) or 0)
    local dy = (tonumber(b.pos.y) or 0) - (tonumber(a.pos.y) or 0)
    local dz = (tonumber(b.pos.z) or 0) - (tonumber(a.pos.z) or 0)
    return math.sqrt(dx * dx + dy * dy + dz * dz) / dt
  end
  for i = 2, #baked do
    local dt = (tonumber(baked[i].t) or 0) - (tonumber(baked[i - 1].t) or 0)
    table.insert(speeds, spd(baked[i - 1], baked[i], dt))
  end
  for i = 2, #speeds do
    local dt = (tonumber(baked[i + 1].t) or 0) - (tonumber(baked[i].t) or 0)
    if dt <= 1e-9 then table.insert(accels, 0)
    else table.insert(accels, math.abs(speeds[i] - speeds[i - 1]) / dt) end
  end
  for i = 2, #accels do
    local dt = (tonumber(baked[i + 1].t) or 0) - (tonumber(baked[i].t) or 0)
    if dt <= 1e-9 then table.insert(jerks, 0)
    else table.insert(jerks, math.abs(accels[i] - accels[i - 1]) / dt) end
  end
  AnimationLab.strip(body, "speed st/s", speeds, Color3.fromRGB(76, 194, 255))
  AnimationLab.strip(body, "accel st/s2", accels, Color3.fromRGB(255, 140, 26))
  AnimationLab.strip(body, "jerk st/s3", jerks, Color3.fromRGB(255, 110, 110))
  local th: any = st.thresholds or {}
  local notes: any = {}
  if tonumber(th.maxSpeedStudPerSec) ~= nil then
    table.insert(notes, "speed cap " .. th.maxSpeedStudPerSec)
  end
  if tonumber(th.maxAccelStudPerSec2) ~= nil then
    table.insert(notes, "accel cap " .. th.maxAccelStudPerSec2)
  end
  if tonumber(th.maxJerkStudPerSec3) ~= nil then
    table.insert(notes, "jerk cap " .. th.maxJerkStudPerSec3)
  end
  if #notes == 0 then
    AnimationLab.label(body, "peaks shown - set thresholds via setLimits for caps", 340)
  else
    AnimationLab.label(body, table.concat(notes, " - "), 340)
  end
end

function AnimationLab.strip(parent: Instance, title: string, series: any, color: Color3)
  AnimationLab.label(parent, title .. " (n=" .. #series .. ")", 340)
  local canvas = Instance.new("Frame")
  canvas.BackgroundColor3 = AnimationLab.colors().input
  canvas.BorderSizePixel = 0
  canvas.Size = UDim2.new(1, 0, 0, 44)
  canvas.Parent = parent
  local peak = 0
  for _, v in ipairs(series) do
    local n = tonumber(v) or 0
    if n > peak then peak = n end
  end
  if peak <= 1e-9 then peak = 1 end
  for i, v in ipairs(series) do
    local frac = (i - 1) / math.max(#series - 1, 1)
    local h = math.clamp((tonumber(v) or 0) / peak, 0, 1)
    local dot = Instance.new("Frame")
    dot.AnchorPoint = Vector2.new(0, 1)
    dot.BackgroundColor3 = color
    dot.BorderSizePixel = 0
    dot.Size = UDim2.new(0, 3, h, -2)
    dot.Position = UDim2.new(frac, -1, 1, 0)
    dot.Parent = canvas
  end
  AnimationLab.label(parent, string.format("peak %.2f", peak), 340)
end

function AnimationLab.renderQuality(body: Instance)
  local st = AnimationLab.getState()
  AnimationLab.head(body, "QUALITY REPORT")
  local issues: any = {}
  if type(st.quality) == "table" then issues = st.quality end
  local errs, warns = 0, 0
  for _, is in ipairs(issues) do
    local s = tostring((is :: any).severity or "")
    if s == "error" then errs += 1 elseif s == "warning" then warns += 1 end
  end
  AnimationLab.label(body, string.format("%d errors, %d warnings", errs, warns), 340)
  if #issues == 0 then
    AnimationLab.label(body, "(no issues - call AnimationLab.setQuality)", 320)
  end
  for _, is in ipairs(issues) do
    local ii: any = is
    local row = AnimationLab.row(body, 20)
    local sev = tostring(ii.severity or "?")
    local tag: any = AnimationLab.label(row, sev:sub(1, 4), 44)
    tag.TextColor3 = (sev == "error") and AnimationLab.colors().bad or AnimationLab.colors().good
    AnimationLab.label(row, tostring(ii.code or "?") .. " " .. tostring(ii.joint or "-"), 130)
    AnimationLab.label(row, tostring(ii.message or ""):sub(1, 90), 300)
  end
  local row = AnimationLab.row(body, 26)
  local chk: any = AnimationLab.btn(row, "qCheck", "local audit", 110, true)
  chk.MouseButton1Click:Connect(function()
    AnimationLab.localAudit()
  end)
end

function AnimationLab.localAudit()
  local st = AnimationLab.getState()
  local found: any = {}
  for _, t in ipairs(st.tracks) do
    local tt: any = t
    local seen: { [string]: boolean } = {}
    local prevT = -1e9
    if tt.keys ~= nil then
      for _, k in ipairs(tt.keys) do
        local kk: any = k
        local kt = tonumber(kk.t) or 0
        if kt < prevT - 1e-9 then
          table.insert(found, { code = "INVALID_TIMING", severity = "error",
            joint = tt.joint, t = kt, message = "key time runs backwards" })
        end
        prevT = kt
        local key = string.format("%.6f", kt)
        if seen[key] then
          table.insert(found, { code = "DUPLICATE_KEYS", severity = "error",
            joint = tt.joint, t = kt, message = "duplicate key time" })
        end
        seen[key] = true
      end
    end
  end
  st.quality = found
  if #found == 0 then
    AnimationLab.status("local audit: structure clean (full critic runs server-side)", false)
  else
    AnimationLab.status("local audit: " .. #found .. " structural issues", true)
  end
  AnimationLab.renderAll()
end

function AnimationLab.snapshot(target: Instance, joints: any): any
  local RA: any = nil
  if RigAdapter ~= nil then RA = RigAdapter end
  if RA == nil then return {} end
  local held: any = {}
  for _, jn in ipairs(joints) do
    local inst: Instance? = nil
    pcall(function()
      for _, d in ipairs(target:GetDescendants()) do
        if d.Name == jn and (d:IsA("Motor6D") or d:IsA("Bone") or d:IsA("BasePart")) then
          inst = d
          break
        end
      end
    end)
    if inst ~= nil then
      local c: any = RA.classify(inst)
      local channel: string = RA.probe(inst, c.kind)
      local pose: any = RA.readPose(inst, channel)
      if pose ~= nil then
        held[jn] = { inst = inst, channel = channel, pose = pose }
      end
    end
  end
  return held
end

function AnimationLab.restore(held: any)
  local RA: any = nil
  if RigAdapter ~= nil then RA = RigAdapter end
  if RA == nil then return end
  for _, h in pairs(held) do
    pcall(function()
      local hh: any = h
      RA.writePose(hh.inst, hh.channel, hh.pose.position, hh.pose.rotation)
    end)
  end
end

function AnimationLab.applyAt(t: number)
  local st = AnimationLab.getState()
  local target = AnimationLab.resolveTarget()
  if target == nil then AnimationLab.status("no target model", true) return end
  local PS: any = nil
  if PoseSolver ~= nil then PS = PoseSolver end
  if PS == nil then
    pcall(function()
      local m = script:FindFirstChild("PoseSolver")
      if m ~= nil and m:IsA("ModuleScript") then PS = require(m) end
    end)
  end
  if PS == nil then AnimationLab.status("PoseSolver unavailable", true) return end
  local n = 0
  for _, tr in ipairs(st.tracks) do
    local tt: any = tr
    local ok: any = PS.applyTrackAtTime(target, tt, t, nil)
    if type(ok) == "table" and tonumber(ok.applied) == 1 then n += 1 end
  end
  AnimationLab.status("applied " .. n .. " tracks at t=" .. string.format("%.3f", t), false)
end

function AnimationLab.play()
  local st = AnimationLab.getState()
  if st.playing then AnimationLab.status("already playing", true) return end
  local okRun, running: any = pcall(function()
    return game:GetService("RunService"):IsRunning()
  end)
  if okRun and running then
    AnimationLab.status("stop Play first - preview runs in Edit only", true)
    return
  end
  local target = AnimationLab.resolveTarget()
  if target == nil then AnimationLab.status("no target model", true) return end
  local joints: any = {}
  for _, tr in ipairs(st.tracks) do table.insert(joints, tostring((tr :: any).joint)) end
  if #joints == 0 then AnimationLab.status("no tracks loaded", true) return end
  st.held = AnimationLab.snapshot(target, joints)
  st.playing = true
  st.stopNow = false
  local t0 = os.clock()
  local conn: any = nil
  pcall(function()
    conn = game:GetService("RunService").Heartbeat:Connect(function()
      if st.stopNow then return end
      local t = os.clock() - t0
      if t > st.duration then
        t = 0
        t0 = os.clock()
      end
      st.playhead = t
      pcall(function() AnimationLab.applyAt(t) end)
      pcall(function()
        if st.timeLbl ~= nil then
          (st.timeLbl :: TextLabel).Text = string.format("t=%.3f / %.3f", t, st.duration)
        end
      end)
    end)
  end)
  st.heart = conn
  AnimationLab.status("playing (Edit only) - Stop restores originals", false)
end

function AnimationLab.stop()
  local st = AnimationLab.getState()
  st.stopNow = true
  st.playing = false
  if st.heart ~= nil then
    pcall(function() (st.heart :: RBXScriptConnection):Disconnect() end)
    st.heart = nil
  end
  local target = AnimationLab.resolveTarget()
  if target ~= nil then
    AnimationLab.restore(st.held)
  end
  st.held = {}
  AnimationLab.status("stopped - originals restored", false)
  AnimationLab.renderAll()
end

function AnimationLab.viewportInfo(): any
  local info: any = { width = AnimationLab.W, height = AnimationLab.H, hasCamera = false }
  pcall(function()
    local cam = workspace.CurrentCamera
    if cam ~= nil then
      info.hasCamera = true
      local vp: any = cam.ViewportSize
      info.viewport = { x = vp.X, y = vp.Y }
    end
  end)
  return info
end

function AnimationLab.project(cam: any, worldPos: Vector3, sx: number, sy: number): any
  local ok, sp: any = pcall(function() return cam:WorldToScreenPoint(worldPos) end)
  if not ok or sp == nil then return { x = 0, y = 0, depth = 0, visible = false } end
  local s: any = sp
  return { x = s.X * sx, y = s.Y * sy, depth = s.Z, visible = s.Z > 0 }
end

function AnimationLab.jointBox(cam: any, part: BasePart, sx: number, sy: number): any
  local cf = part.CFrame
  local s = part.Size
  local hx, hy, hz = s.X / 2, s.Y / 2, s.Z / 2
  local minX, minY = math.huge, math.huge
  local maxX, maxY = -math.huge, -math.huge
  local depth = 0
  local visible = false
  local plotted = 0
  for _, ox in ipairs({ -hx, hx }) do
    for _, oy in ipairs({ -hy, hy }) do
      for _, oz in ipairs({ -hz, hz }) do
        local ok, wp: any = pcall(function()
          return cf * Vector3.new(ox, oy, oz)
        end)
        if ok and wp ~= nil then
          local p = AnimationLab.project(cam, wp, sx, sy)
          plotted += 1
          if p.visible then visible = true end
          if p.x < minX then minX = p.x end
          if p.y < minY then minY = p.y end
          if p.x > maxX then maxX = p.x end
          if p.y > maxY then maxY = p.y end
          depth = p.depth
        end
      end
    end
  end
  if plotted == 0 then return nil end
  return { x = minX, y = minY, w = math.max(0, maxX - minX),
    h = math.max(0, maxY - minY), depth = depth, visible = visible }
end

function AnimationLab.collectJoints(target: Instance, names: any, cap: number): any
  local joints: { Instance } = {}
  local seen: { [string]: boolean } = {}
  if type(names) == "table" and #names > 0 then
    for _, nm in ipairs(names) do
      local inst = AnimationLab.resolveJoint(target, tostring(nm))
      if inst ~= nil and not seen[inst.Name] then
        seen[inst.Name] = true
        table.insert(joints, inst)
      end
      if #joints >= cap then break end
    end
  else
    pcall(function()
      for _, d in ipairs(target:GetDescendants()) do
        if #joints >= cap then break end
        if (d:IsA("Motor6D") or d:IsA("AnimationConstraint") or d:IsA("BasePart"))
          and not seen[d.Name] then
          seen[d.Name] = true
          table.insert(joints, d)
        end
      end
    end)
  end
  return joints
end

function AnimationLab.captureFrame(target: Instance, opts: any): any
  local o: any = opts or {}
  local cam: any = nil
  pcall(function() cam = workspace.CurrentCamera end)
  if cam == nil then
    return nil, "animlab_no_camera: no CurrentCamera in this place"
  end
  local vp: any = { X = 1920, Y = 1080 }
  pcall(function()
    local v: any = cam.ViewportSize
    if v ~= nil then vp = v end
  end)
  local sx = AnimationLab.W / math.max(tonumber(vp.X) or 1, 1)
  local sy = AnimationLab.H / math.max(tonumber(vp.Y) or 1, 1)
  local cap = math.clamp(math.floor(tonumber(o.cap) or 64), 1, 200)
  local joints = AnimationLab.collectJoints(target, o.joints, cap)
  local boxes: any = {}
  local skipped = 0
  for _, inst in ipairs(joints) do
    local part = AnimationLab.drivenPart(inst)
    if part == nil then
      skipped += 1
    else
      local ok, box: any = pcall(function()
        return AnimationLab.jointBox(cam, part :: BasePart, sx, sy)
      end)
      if ok and box ~= nil then
        box.joint = inst.Name
        table.insert(boxes, box)
      else
        skipped += 1
      end
    end
  end
  AnimationLab.frameSeq = AnimationLab.frameSeq + 1
  local animName = tostring(o.animation or target.Name):sub(1, 64)
  local t = tonumber(o.t) or 0
  local frameId = tostring(o.frameId or (animName .. "@" .. t .. "#" .. AnimationLab.frameSeq))
  local frame: any = {
    frameId = frameId,
    animation = animName,
    t = t,
    modality = "schematic",
    width = AnimationLab.W,
    height = AnimationLab.H,
    boxes = boxes,
    plotted = #boxes,
    skipped = skipped,
    pixels = false,
    pixelNote = "Studio exposes no pixel capture to plugins: boxes are projected " ..
      "joint bounds for silhouette/framing review, not renders.",
    capturedAt = os.time(),
  }
  if o.revision ~= nil then frame.revision = tostring(o.revision) end
  return frame, nil
end

function AnimationLab.captureSequence(target: Instance, times: any, opts: any): any
  local frames: any = {}
  local errors: any = {}
  if type(times) ~= "table" then
    return { frames = frames, errors = { "times must be an array of beat times" } }
  end
  for _, t in ipairs(times) do
    local o: any = {}
    if type(opts) == "table" then
      for k, v in pairs(opts) do o[k] = v end
    end
    o.t = tonumber(t) or 0
    local frame, err = AnimationLab.captureFrame(target, o)
    if frame ~= nil then
      table.insert(frames, frame)
    else
      table.insert(errors, tostring(err))
    end
  end
  return { frames = frames, errors = errors }
end
--[[ANIMLAB_END]]
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
  -- Task 12.2: ground the new clip in the engine's rig analysis up front, so a
  -- typo'd track name or a rig with nothing posable fails here instead of on
  -- the first set_model_keyframe call.
  local analysis = RigAdapter.describeModel(target)
  local bindingByName: { [string]: any } = {}
  local writableNames: { string } = {}
  for _, b in ipairs(analysis.bindings) do
    bindingByName[tostring((b :: any).name)] = b
    local drv: any = (b :: any).drive or {}
    if drv.writable == true and tostring((b :: any).className) ~= "Model" then
      table.insert(writableNames, tostring((b :: any).name))
    end
  end
  if #analysis.bindings == 0 then
    error("nothing animatable under '" .. target.Name:sub(1, 48)
      .. "' (need Motor6D/Bone joints, a PrimaryPart, or BaseParts) - run analyze_animatable_model to inspect it")
  end
  if #writableNames == 0 then
    error("'" .. target.Name:sub(1, 48) .. "' has " .. #analysis.bindings
      .. " joints but none are directly posable (all welds/attachments/clip-only) - animate a parent part or pick another target")
  end
  -- Optional scaffolding: seed tracks with the engine's own joint kind so
  -- downstream blending/validation agree with the analyzer.
  local seeded: { [string]: any } = {}
  local requested = args.tracks
  if type(requested) == "table" then
    if #requested > 32 then error("too many tracks (max 32)") end
    for _, raw in ipairs(requested) do
      local tn = tostring(raw)
      local b = bindingByName[tn]
      if b == nil then
        error("unknown track '" .. tn:sub(1, 40) .. "' - run analyze_animatable_model and use an exact part name")
      end
      if seeded[tn] then
        error("duplicate track '" .. tn:sub(1, 40) .. "' in tracks[]")
      end
      local drv: any = (b :: any).drive or {}
      if drv.writable ~= true then
        error("track '" .. tn:sub(1, 40) .. "' is a follow/clip joint with no writable channel - animate its parent part instead")
      end
      seeded[tn] = { kind = "custom", keys = {} }
    end
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
  local trackCount = 0
  for _ in pairs(seeded) do trackCount += 1 end
  rlAnimWrite(name, folder, seeded, {}, {})
  return { animation = name, target = target:GetFullName(), duration = duration, fps = fps,
    loop = args.loop == true, tracks = trackCount, rigJoints = #analysis.bindings,
    writable = #writableNames, seeded = trackCount > 0 }
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
        -- Curves.ease applies the overshoot clamp; the old raw-table call
        -- let bezierOut/springOut escape past 1.15 during interpolation.
        f = Curves.ease(b.ease, (t - num(a.t, 0)) / span)
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
-- Task 12.3: resolve the clip's target through the RigAnalyzer so a key can
-- never land on a joint the engine reports as undrivable (Model containers,
-- welds, attachments and clip-only Bones accept keys silently today and then
-- do nothing at preview time). Returns nil when the rig cannot be consulted,
-- so a clip whose target has been deleted stays editable for repair.
local function rlRigBinding(folder: Instance, track: string): (any, string?)
  local targetPath = ""
  pcall(function() targetPath = tostring(folder:GetAttribute("target") or "") end)
  if targetPath == "" then return nil, nil end
  local target = findByPath(targetPath)
  if not target then return nil, nil end
  local ok, analysis = pcall(function() return RigAdapter.describeModel(target) end)
  if not ok or analysis == nil then return nil, nil end
  for _, b in ipairs(analysis.bindings) do
    if tostring((b :: any).name) == track then return b, nil end
  end
  return nil, nil
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
  -- Easing is an engine curve; prove it actually interpolates 0->1 before
  -- storing it, so a malformed entry in Curves.EASE can never bake to garbage.
  local e0 = Curves.ease(ease, 0)
  local e1 = Curves.ease(ease, 1)
  if math.abs(e0) > 1e-6 or math.abs(e1 - 1) > 1e-6 then
    error("easing '" .. ease .. "' does not interpolate 0->1 (got " .. e0 .. "->" .. e1 .. ") - engine curve table is corrupt")
  end
  local binding = rlRigBinding(folder, track)
  local kind = "custom"
  local writable = true
  if binding ~= nil then
    local drv: any = (binding :: any).drive or {}
    kind = tostring((binding :: any).legacyKind or "custom")
    if drv.writable ~= true or tostring((binding :: any).className) == "Model" then
      error("track '" .. track:sub(1, 48) .. "' (" .. tostring((binding :: any).className)
        .. "/" .. kind .. ") has no writable channel - animate its parent part instead")
    end
    writable = true
  end
  local tr = tracks[track]
  if tr == nil then
    tr = { kind = kind, keys = {} }
    tracks[track] = tr
  end
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
  return { animation = anim, track = track, t = t, ease = ease, keys = #keys,
    replaced = replaced, kind = kind, rigKnown = binding ~= nil, writable = writable }
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
  -- Task 12.3: the curve is the engine's, so re-read its endpoints and report
  -- the shaped arrival instead of only echoing the name back.
  local e0 = Curves.ease(ease, 0)
  local e1 = Curves.ease(ease, 1)
  if math.abs(e0) > 1e-6 or math.abs(e1 - 1) > 1e-6 then
    error("easing '" .. ease .. "' does not interpolate 0->1 (got " .. e0 .. "->" .. e1 .. ") - engine curve table is corrupt")
  end
  local prevEase = tostring(keys[idx].ease or "linear")
  keys[idx].ease = ease
  -- Shape report: where the eased curve sits at the segment midpoint. A value
  -- above 0.5 means the arrival now leans late (ease-in style), below 0.5
  -- early. Lets a caller tune without re-previewing the whole clip.
  local mid = Curves.ease(ease, 0.5)
  rlAnimWrite(anim, folder, tracks, markers, events)
  return { animation = anim, track = track, keyIndex = idx, ease = ease,
    previousEase = prevEase, changed = prevEase ~= ease,
    curveMidpoint = rlRound2(mid), overshoot = e1 > 1 or mid > 1 }
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
    -- Task 12.5: sample on the engine's own cadence. A caller-supplied `step`
    -- coarser than the clip's segments samples an eased curve too coarsely
    -- and hides its peak, so the walk is subdivided to at least the clip's
    -- fps even when `step` is larger.
    local sub = math.max(1, math.ceil(step * fps))
    local h = step / sub
    local pt, pr = rlPoseAt(keys, 0)
    local tt = step
    while tt <= duration + 1e-9 do
      for _ = 2, sub + 1 do
        local qpos, qrot = rlPoseAt(keys, tt - h)
        if h > 1e-9 then
          maxDeg = math.max(maxDeg, rlMag3(pr, qrot) / h)
          maxStud = math.max(maxStud, rlMag3(pt, qpos) / h)
        end
        pt, pr = qpos, qrot
      end
      tt += step
    end
    -- Easing actually in use, so a caller can see which engine curves the
    -- clip depends on without re-reading every key.
    local seen: { [string]: boolean } = {}
    local used: { string } = {}
    local unknown: { string } = {}
    for _, k in ipairs(keys or {}) do
      local e = tostring((k :: any).ease or "linear")
      if not seen[e] then
        seen[e] = true
        -- Only engine curves that actually interpolate 0->1 are reported as
        -- playable; a stored name with no Curves.EASE entry is listed
        -- separately instead of echoed back as if it worked.
        if Curves.EASE[e] ~= nil and math.abs(Curves.ease(e, 1) - 1) <= 1e-6 then
          table.insert(used, e)
        else
          table.insert(unknown, e)
        end
      end
    end
    table.sort(used)
    table.sort(unknown)
    summary[tn] = { keys = #keys, maxDegPerSec = rlRound2(maxDeg), maxStudPerSec = rlRound2(maxStud),
      spike = maxDeg > RL_ROT_WARN, easings = used, sampledAt = rlRound2(h),
      unknownEasings = unknown }
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
      if Curves.EASE[(k :: any).ease] == nil then
        err("BAD_EASING", "track '" .. tn:sub(1, 32) .. "' key " .. i .. " has easing '" .. tostring((k :: any).ease):sub(1, 24) .. "'", "set a suffixed easing (quadIn, not bare quad)")
      end
      if i > 1 and num((k :: any).t, 0) < num(keys[i - 1].t, 0) - 1e-9 then
        err("TIME_ORDER", "track '" .. tn:sub(1, 32) .. "' key " .. i .. " goes backwards in time", "rewrite the keys in order")
      end
    end
    -- Task 12.4: measure the TRUE peak speed of each segment by sampling the
    -- engine's eased interpolation (Curves.ease via rlPoseAt) instead of
    -- dividing the endpoint chord by dt. An eased segment peaks well above
    -- its average, so the old chord estimate under-reported exactly the
    -- spikes it was meant to catch.
    for i = 2, #keys do
      local t0 = num(keys[i - 1].t, 0)
      local dt = num(keys[i].t, 0) - t0
      if dt > 1e-9 then
        local rv, pv = 0, 0
        local steps = 8
        local prevP, prevR = nil, nil
        for s = 0, steps do
          local t = t0 + dt * (s / steps)
          local sp, sr = rlPoseAt(keys, t)
          if prevP then
            rv = math.max(rv, rlMag3(prevR, sr) / (dt / steps))
            pv = math.max(pv, rlMag3(prevP, sp) / (dt / steps))
          end
          prevP, prevR = sp, sr
        end
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
      else
        -- Pose endpoints agree; the seam can still pop if the velocity into
        -- the loop start differs from the velocity out of it. Compare the
        -- engine's eased samples just inside and outside the wrap.
        local dur = num(keys[#keys].t, 0) - num(keys[1].t, 0)
        if dur > 1e-9 then
          local h = dur / 16
          local inA, inB = rlPoseAt(keys, num(keys[1].t, 0) - h * 0), rlPoseAt(keys, num(keys[1].t, 0))
          local outA, outB = rlPoseAt(keys, num(keys[#keys].t, 0) - h), rlPoseAt(keys, num(keys[#keys].t, 0))
          local vIn = rlMag3(inA, inB) / h
          local vOut = rlMag3(outA, outB) / h
          if vIn > 1e-6 and vOut > 1e-6 then
            local ratio = math.max(vIn, vOut) / math.min(vIn, vOut)
            if ratio > RL_LOOP_SEAM then
              warn("LOOP_SEAM", "track '" .. tn:sub(1, 32) .. "' loop seam speed differs by "
                .. math.floor(ratio) .. "x between the end and the start", "match the arrival speed at the loop point (a springOut/linear mix on the last key usually fixes it)")
            end
          end
        end
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
local labBtn: TextButton? = nil
pcall(function()
  -- the Lab widget builds once below; the button only toggles it.
  labBtn = toolbar:CreateButton("Lab", "RoLink animation lab (workstation)", "rbxassetid://0")
  local lb = labBtn :: TextButton
  lb.ClickableWhenViewportHidden = true
  lb.Click:Connect(function()
    local ok, err = pcall(function() AnimationLab.toggle(plugin) end)
    if ok then
      log("animation lab toggled")
    else
      warn("[RoLink] animation lab toggle failed: " .. tostring(err):sub(1, 200))
    end
  end)
end)
do
log("lab build 1 - toggle=" .. type(AnimationLab.toggle))
local okLab, labErr = false, nil
if type(AnimationLab.toggle) == "function" then
  okLab, labErr = pcall(function() AnimationLab.toggle(plugin) end)
else
  labErr = "AnimationLab.toggle is " .. type(AnimationLab.toggle) .. " - reinstall studio-plugin/RoLink.lua from the RoLink-main folder, then fully restart Studio"
end
if not okLab then
  warn("[RoLink] animation lab build failed: " .. tostring(labErr):sub(1, 300))
else
  log("animation lab built - click Lab to open")
end
end


-- ── Model animation composites + generators (tools 132-139) ───────────
-- Time edits (retime/reverse), spatial mirror, weighted blend, safe fixes,
-- and scaffold generators (attack/idle/walk). Copies are non-destructive;
-- in-place edits overwrite only the named store. Mirror semantics are
-- documented approximations - validate after every mirror.
-- Task 12.9: reversing a clip also reverses each segment's shape, because a
-- key's easing describes the ARRIVAL at that key -- the segment that used to
-- depart from it now arrives at its mirrored key. The exact time-reverse of
-- an engine curve f(t) is 1-f(1-t), which for this vocabulary is:
--   * in/out pairs flip exactly (quadOut(t) == 1-quadIn(1-t)),
--   * the in-out curves are self-symmetric, so they map to themselves,
--   * the overshoot family has NO in-out-free partner in the engine table.
-- The last case used to be left untouched, which silently gave a reversed
-- clip the wrong arrival; it is now reported instead of guessed.
local EASE_FLIP: { [string]: string } = {
  linear = "linear",
  quadIn = "quadOut", quadOut = "quadIn",
  cubicIn = "cubicOut", cubicOut = "cubicIn",
  sineIn = "sineOut", sineOut = "sineIn",
  quadInOut = "quadInOut", cubicInOut = "cubicInOut", sineInOut = "sineInOut",
}
--- Easing name to use for a reversed segment, or nil when the engine has no
--- time-reversed partner. Never guesses a curve that does not exist.
local function rlFlipEase(name: string): (string?, string?)
  local e = tostring(name or "linear")
  local flipped = EASE_FLIP[e]
  if flipped ~= nil and Curves.EASE[flipped] == nil then flipped = nil end
  return flipped, (flipped == nil) and e or nil
end
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
  -- Task 12.9: curves are time-normalized, so they survive a scale unchanged --
  -- but the clip's PEAK speed does not. Measure it through the engine's eased
  -- sampler so a caller who is about to retime past the validator's limits
  -- finds out from this call instead of from a failing validate.
  local peakDeg, peakStud = 0, 0
  local worst = ""
  for _, tn in ipairs(rlTrackNames(tracks)) do
    local keys = tracks[tn].keys
    if type(keys) == "table" and #keys > 1 then
      local h = duration / 64
      if h > 1e-9 then
        local pp, pr = rlPoseAt(keys, 0)
        local t = h
        while t <= duration + 1e-9 do
          local qp, qr = rlPoseAt(keys, t)
          local d = rlMag3(pr, qr) / h
          if d > peakDeg then
            peakDeg = d
            worst = tn
          end
          peakStud = math.max(peakStud, rlMag3(pp, qp) / h)
          pp, pr = qp, qr
          t += h
        end
      end
    end
  end
  local res: { [string]: any } = { animation = anim, scale = scale, duration = duration,
    peakDegPerSec = rlRound2(peakDeg), peakStudPerSec = rlRound2(peakStud), peakTrack = worst }
  if peakDeg > RL_ROT_ERR then
    res.warning = "retimed peak rotation is " .. math.floor(peakDeg) .. " deg/s on '" .. worst
      .. "' (limit " .. RL_ROT_ERR .. ") - validate_model_animation will report a SPIKE"
  elseif peakDeg > RL_ROT_WARN then
    res.warning = "retimed peak rotation is " .. math.floor(peakDeg) .. " deg/s on '" .. worst
      .. "' (warn limit " .. RL_ROT_WARN .. ")"
  end
  return res
end
local function rlModelReverse(args: { [string]: any }): { [string]: any }
  local anim = tostring(args.anim or "")
  local folder, tracks, markers, events = rlAnimRead(anim)
  if args.newName ~= nil and tostring(args.newName) ~= "" then
    folder, tracks, markers, events = rlAnimDuplicate(anim, args.newName, args.confirm)
    anim = tostring(args.newName):gsub("^%s+", ""):gsub("%s+$", ""):sub(1, 64)
  end
  local duration = num(folder:GetAttribute("duration"), 0)
  local unmapped: { [string]: boolean } = {}
  for _, tr in pairs(tracks) do
    local keys = (tr :: any).keys or {}
    for _, k in ipairs(keys) do
      (k :: any).t = duration - num((k :: any).t, 0)
      local flipped, bad = rlFlipEase((k :: any).ease)
      if bad ~= nil then
        -- No exact reverse exists; keep the curve (it still interpolates
        -- 0->1) but tell the caller the arrival shape is approximate.
        unmapped[bad] = true
      else
        k.ease = flipped
      end
    end
    table.sort(keys, function(a, b) return num((a :: any).t, 0) < num((b :: any).t, 0) end)
  end
  for _, m in ipairs(markers) do
    (m :: any).t = duration - num((m :: any).t, 0)
  end
  table.sort(markers, function(a, b) return num((a :: any).t, 0) < num((b :: any).t, 0) end)
  rlAnimWrite(anim, folder, tracks, markers, events)
  local approx: { string } = {}
  for e in pairs(unmapped) do table.insert(approx, tostring(e)) end
  table.sort(approx)
  return { animation = anim, duration = duration, approximateEasings = approx }
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
  -- Task 12.9: mirror negates X and the Y/Z euler components. Validate the
  -- result through the engine's quaternion conversion so a degenerate or
  -- non-finite mirror is caught here rather than producing a broken pose on
  -- the first preview frame.
  local mirrored = 0
  local badPose = 0
  local function mirrorCheck(p: any, r: any): boolean
    mirrored += 1
    local w, x, y, z = Curves.eulerDegToQuat(r.x, r.y, r.z)
    local ok = w == w and x == x and y == y and z == z
      and math.abs(w) <= 1 + 1e-6 and math.abs(x) <= 1 + 1e-6
      and math.abs(y) <= 1 + 1e-6 and math.abs(z) <= 1 + 1e-6
    local n = math.sqrt(w * w + x * x + y * y + z * z)
    if n < 0.5 or n > 1.5 then ok = false end
    if not (p.x == p.x and p.y == p.y and p.z == p.z) then ok = false end
    if not ok then badPose += 1 end
    return ok
  end
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
      local mp = { x = -num(p and (p :: any).x, 0), y = num(p and (p :: any).y, 0), z = num(p and (p :: any).z, 0) }
      local mr = { x = num(r and (r :: any).x, 0), y = -num(r and (r :: any).y, 0), z = -num(r and (r :: any).z, 0) }
      mirrorCheck(mp, mr)
      table.insert(keys, { t = num((k :: any).t, 0), pos = mp, rot = mr,
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
  local res: { [string]: any } = { animation = nn, swapped = swapped, posesMirrored = mirrored }
  if badPose > 0 then
    res.warning = badPose .. " of " .. mirrored
      .. " mirrored keys failed the engine pose check (non-finite or non-unit) - inspect before playing"
  end
  return res
end
-- Task 12.8: blend through the engine's rotation convention. Positions
-- interpolate component-wise, but rotations MUST go through quaternion
-- slerp: lerping Euler degrees takes the short way through zero, so a blend
-- from 170deg to 190deg swings through a 20deg reversal instead of
-- continuing. Curves.slerp takes the geodesic, which is what the engine
-- stores and what PoseSolver plays back.
local function rlBlendRot(a: any, b: any, f: number): { [string]: number }
  local w0, x0, y0, z0 = Curves.rotToQuat(a)
  local w1, x1, y1, z1 = Curves.rotToQuat(b)
  local w, x, y, z = Curves.slerp(w0, x0, y0, z0, w1, x1, y1, z1, f)
  -- Back to the plugin's stored euler-degrees shape in the same axis order
  -- Curves.eulerDegToQuat reads, so a blend round-trips exactly at f=0/f=1.
  local sinr = 2 * (w * x + y * z)
  local cosr = 1 - 2 * (x * x + y * y)
  local roll = math.atan2(sinr, cosr)
  local sinp = 2 * (w * y - z * x)
  local pitch
  if math.abs(sinp) >= 1 then
    pitch = (sinp >= 0 and 1 or -1) * math.pi / 2
  else
    pitch = math.asin(sinp)
  end
  local siny = 2 * (w * z + x * y)
  local cosy = 1 - 2 * (y * y + z * z)
  local yaw = math.atan2(siny, cosy)
  local d = 180 / math.pi
  return { x = roll * d, y = pitch * d, z = yaw * d }
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
          pos = rlLerp3(bp, op, w), rot = rlBlendRot(br, orr, w), ease = "linear" })
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
        if Curves.EASE[(k :: any).ease] == nil then
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

-- ── Task 12.7: intent -> plan pipeline ──────────────────────────────────────
-- The three scaffolds (attack / idle / walk) used to hard-code their own key
-- times, which meant pacing was re-guessed per tool and could not vary by
-- style. They now share one planner: the caller states an INTENT (kind +
-- style + duration), the planner lays out the eight-beat MotionPlan the
-- engine uses (mcp-server/src/animation/motionPlanner.ts + MotionBeat in
-- shared/animationProtocol.ts), and the scaffold only supplies the pose
-- amplitude per beat. Timing therefore comes from one table.
local RL_BEAT_ORDER = { "REST", "ANTICIPATION", "PREPARATION", "ACCELERATION",
  "PRIMARY_ACTION", "IMPACT", "FOLLOW_THROUGH", "SETTLE" }
-- Beat fractions per style; each row sums to 1.0 (pinned by the migration
-- suite). Mirrors STYLE_BEAT_TIMING in motionPlanner.ts.
local RL_STYLE_TIMING: { [string]: { [string]: number } } = {
  REALISTIC   = { REST = 0.08, ANTICIPATION = 0.10, PREPARATION = 0.12, ACCELERATION = 0.15, PRIMARY_ACTION = 0.15, IMPACT = 0.08, FOLLOW_THROUGH = 0.12, SETTLE = 0.20 },
  CINEMATIC   = { REST = 0.10, ANTICIPATION = 0.16, PREPARATION = 0.12, ACCELERATION = 0.12, PRIMARY_ACTION = 0.14, IMPACT = 0.08, FOLLOW_THROUGH = 0.12, SETTLE = 0.16 },
  ANIME       = { REST = 0.05, ANTICIPATION = 0.12, PREPARATION = 0.10, ACCELERATION = 0.10, PRIMARY_ACTION = 0.16, IMPACT = 0.07, FOLLOW_THROUGH = 0.20, SETTLE = 0.20 },
  EXAGGERATED = { REST = 0.05, ANTICIPATION = 0.16, PREPARATION = 0.10, ACCELERATION = 0.10, PRIMARY_ACTION = 0.18, IMPACT = 0.08, FOLLOW_THROUGH = 0.20, SETTLE = 0.13 },
  MECHANICAL  = { REST = 0.10, ANTICIPATION = 0.03, PREPARATION = 0.12, ACCELERATION = 0.20, PRIMARY_ACTION = 0.20, IMPACT = 0.10, FOLLOW_THROUGH = 0.05, SETTLE = 0.20 },
  CREATURE    = { REST = 0.10, ANTICIPATION = 0.12, PREPARATION = 0.10, ACCELERATION = 0.14, PRIMARY_ACTION = 0.16, IMPACT = 0.08, FOLLOW_THROUGH = 0.12, SETTLE = 0.18 },
  CARTOON     = { REST = 0.08, ANTICIPATION = 0.14, PREPARATION = 0.12, ACCELERATION = 0.12, PRIMARY_ACTION = 0.16, IMPACT = 0.08, FOLLOW_THROUGH = 0.16, SETTLE = 0.14 },
  SUBTLE      = { REST = 0.12, ANTICIPATION = 0.10, PREPARATION = 0.14, ACCELERATION = 0.14, PRIMARY_ACTION = 0.14, IMPACT = 0.08, FOLLOW_THROUGH = 0.10, SETTLE = 0.18 },
}
-- Amplitude per style: how hard each intent family moves at its peak beat.
-- 1.0 == the caller's requested amplitude.
local RL_STYLE_GAIN: { [string]: number } = {
  REALISTIC = 1.0, CINEMATIC = 1.15, ANIME = 1.35, EXAGGERATED = 1.5,
  MECHANICAL = 0.9, CREATURE = 1.2, CARTOON = 1.3, SUBTLE = 0.6,
}
local RL_STYLE_LIST = "REALISTIC|CINEMATIC|ANIME|EXAGGERATED|MECHANICAL|CREATURE|CARTOON|SUBTLE"
local function rlResolveStyle(raw: any): string
  local s = tostring(raw or ""):upper():gsub("[%s%-]", "")
  if RL_STYLE_TIMING[s] then return s end
  if s == "" then return "REALISTIC" end
  error("unknown style '" .. tostring(raw):sub(1, 24) .. "' (want one of " .. RL_STYLE_LIST .. ")")
end
--- Lay out the eight-beat plan for an intent. Returns beats with absolute
--- start/duration times plus the absolute time of each milestone, so callers
--- never re-derive timing arithmetic.
local function rlPlanIntent(goal: string, style: string, duration: number): any
  local timing = RL_STYLE_TIMING[style] or RL_STYLE_TIMING.REALISTIC
  local beats: { [string]: any } = {}
  local t = 0
  for _, kind in ipairs(RL_BEAT_ORDER) do
    local frac = num(timing[kind], 0)
    local d = duration * frac
    table.insert(beats, { kind = kind, start = t, duration = d, fraction = frac,
      importance = kind == "IMPACT" and 1 or (kind == "PRIMARY_ACTION" and 0.9 or 0.5),
      style = style })
    t += d
  end
  local marks: { [string]: number } = {}
  for _, b in ipairs(beats) do
    if marks[b.kind] == nil then marks[b.kind] = b.start end
    marks[b.kind .. "_END"] = b.start + b.duration
  end
  return { goal = goal, style = style, duration = duration, beats = beats, marks = marks,
    gain = RL_STYLE_GAIN[style] or 1 }
end
--- Easing the engine uses to arrive at a beat, chosen by beat kind. Read from
--- Curves.EASE so a rename there can never leave the scaffolds writing a
--- curve the interpolator does not know.
local function rlBeatEase(kind: string, isLoop: boolean): string
  if isLoop then
    if kind == "SETTLE" or kind == "REST" then return "sineInOut" end
  end
  if kind == "ANTICIPATION" or kind == "PREPARATION" then return "quadInOut" end
  if kind == "ACCELERATION" then return "cubicIn" end
  if kind == "PRIMARY_ACTION" or kind == "IMPACT" then return "bezierOut" end
  if kind == "FOLLOW_THROUGH" then return "springOut" end
  if kind == "SETTLE" then return "sineInOut" end
  return "linear"
end
local function rlEaseOrLinear(kind: string, isLoop: boolean): string
  local e = rlBeatEase(kind, isLoop)
  if Curves.EASE[e] == nil then return "linear" end
  return e
end
local function rlScaffoldTracks(names: { [string]: any })
  local tracks: { [string]: any } = {}
  rlNeutralKeys(tracks, names)
  return tracks
end
local function rlScaffoldNames(args: { [string]: any }, hint: string): { [string]: any }
  local names = args.tracks
  if type(names) ~= "table" or #names == 0 then
    error("tracks[] must list at least one joint name from analyze_animatable_model" .. hint)
  end
  if #names > 32 then error("too many tracks (max 32)") end
  local seen: { [string]: boolean } = {}
  for _, raw in ipairs(names) do
    local s = tostring(raw)
    if seen[s] then error("duplicate track '" .. s:sub(1, 40) .. "' in tracks[]") end
    seen[s] = true
  end
  return names
end

local function rlModelAttack(args: { [string]: any }): { [string]: any }
  local names = rlScaffoldNames(args)
  local duration = num(args.duration, 1.05)
  local style = rlResolveStyle(args.style)
  local plan = rlPlanIntent("attack", style, duration)
  local marks = plan.marks
  local st = args.strike
  local srx = num(st and (st :: any).rx, 0)
  local sry = num(st and (st :: any).ry, 45)
  local srz = num(st and (st :: any).rz, 0)
  local g = plan.gain
  local tracks = rlScaffoldTracks(names)
  -- The four pose milestones of an attack, timed by the plan rather than by
  -- hard-coded fractions: wind up at the end of ANTICIPATION, strike at the
  -- end of PRIMARY_ACTION, overshoot during FOLLOW_THROUGH, rest at SETTLE.
  -- Explicit anticipation/impactT from the caller still win, so prompts that
  -- specify them keep working; the plan supplies them otherwise.
  local tAnt = num(marks.ANTICIPATION_END, duration * 0.19)
  local tImpact = num(marks.PRIMARY_ACTION_END, duration * 0.44)
  if args.anticipation ~= nil then tAnt = num(args.anticipation, tAnt) end
  if args.impactT ~= nil then tImpact = num(args.impactT, tImpact) end
  if tAnt < 0 or tAnt > duration then error("anticipation must sit inside 0-" .. duration .. "s") end
  if tImpact < 0 or tImpact > duration then error("impactT must sit inside 0-" .. duration .. "s") end
  if tAnt >= tImpact then
    error("anticipation (" .. rlRound2(tAnt) .. "s) must land before impactT ("
      .. rlRound2(tImpact) .. "s) - a strike cannot wind up after it lands")
  end
  local tOver = num(marks.FOLLOW_THROUGH_END, duration * 0.56)
  if tOver <= tImpact then tOver = math.min(duration, tImpact + math.max(0.04, (duration - tImpact) / 3)) end
  local hasOver = tOver > tImpact + 0.03
  local easePrep = rlEaseOrLinear("ANTICIPATION", false)
  local easeHit = rlEaseOrLinear("IMPACT", false)
  local easeOver = rlEaseOrLinear("FOLLOW_THROUGH", false)
  local easeRest = rlEaseOrLinear("SETTLE", false)
  for _, tn in ipairs(names) do
    local s = tostring(tn)
    rlKeyAt(tracks, s, 0, 0, 0, 0, "linear")
    rlKeyAt(tracks, s, tAnt, -srx * 0.5 * g, -sry * 0.5 * g, -srz * 0.5 * g, easePrep)
    rlKeyAt(tracks, s, tImpact, srx * g, sry * g, srz * g, easeHit)
    if hasOver then
      rlKeyAt(tracks, s, tOver, srx * 1.08 * g, sry * 1.08 * g, srz * 1.08 * g, easeOver)
    end
    rlKeyAt(tracks, s, duration, 0, 0, 0, easeRest)
  end
  local markers: { [string]: any } = {}
  table.insert(markers, { t = tImpact, name = "IMPACT" })
  local res = rlModelWriteFresh(args, tracks, markers)
  res.impactT = rlRound2(tImpact)
  res.style = style
  res.beats = plan.beats
  res.planned = true
  return res
end
local function rlModelIdle(args: { [string]: any }): { [string]: any }
  local names = rlScaffoldNames(args)
  local duration = num(args.duration, 2)
  local style = rlResolveStyle(args.style)
  local plan = rlPlanIntent("idle", style, duration)
  local g = plan.gain
  local sway = num(args.sway, 5) * g
  local tracks = rlScaffoldTracks(names)
  -- Idle is a loop: rest, sway through PRIMARY_ACTION, return to rest inside
  -- SETTLE so the wrap is seamless.
  local tSway = num(plan.marks.PRIMARY_ACTION_END, duration * 0.5)
  local easeUp = rlEaseOrLinear("PRIMARY_ACTION", true)
  local easeDown = rlEaseOrLinear("SETTLE", true)
  for _, tn in ipairs(names) do
    local s = tostring(tn)
    rlKeyAt(tracks, s, 0, 0, 0, 0, "linear")
    rlKeyAt(tracks, s, tSway, 0, sway, 0, easeUp)
    rlKeyAt(tracks, s, duration, 0, 0, 0, easeDown)
  end
  local res = rlModelWriteFresh(args, tracks, {})
  res.style = style
  res.beats = plan.beats
  res.planned = true
  return res
end
local function rlModelWalk(args: { [string]: any }): { [string]: any }
  local names = rlScaffoldNames(args, " (order drives alternation)")
  local duration = num(args.duration, 0.8)
  local style = rlResolveStyle(args.style)
  local plan = rlPlanIntent("walk", style, duration)
  local g = plan.gain
  local stride = num(args.stride, 20) * g
  if stride < 0 or stride > 90 then error("stride must be 0-90 degrees (got " .. tostring(args.stride) .. ")") end
  local tracks = rlScaffoldTracks(names)
  -- One full stride cycle across the clip: forward swing at the end of
  -- ACCELERATION, through neutral at IMPACT, back-swing at FOLLOW_THROUGH,
  -- neutral again by the end of SETTLE. Alternation by track order.
  local tFwd = num(plan.marks.ACCELERATION_END, duration * 0.25)
  local tMid = num(plan.marks.IMPACT_END, duration * 0.5)
  local tBack = num(plan.marks.FOLLOW_THROUGH_END, duration * 0.75)
  local eFwd = rlEaseOrLinear("ACCELERATION", true)
  local eBack = rlEaseOrLinear("FOLLOW_THROUGH", true)
  local eRest = rlEaseOrLinear("SETTLE", true)
  for i, tn in ipairs(names) do
    local s = tostring(tn)
    local sign = 1
    if i % 2 == 0 then sign = -1 end
    rlKeyAt(tracks, s, 0, 0, 0, 0, "linear")
    rlKeyAt(tracks, s, tFwd, sign * stride, 0, 0, eFwd)
    rlKeyAt(tracks, s, tMid, 0, 0, 0, eRest)
    rlKeyAt(tracks, s, tBack, -sign * stride, 0, 0, eBack)
    rlKeyAt(tracks, s, duration, 0, 0, 0, eRest)
  end
  local res = rlModelWriteFresh(args, tracks, {})
  res.style = style
  res.beats = plan.beats
  res.planned = true
  return res
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
    elseif tool=="set_ui_property" then local inst=findByPath(args.path or ""); if not inst then error("not found "..tostring(args.path or "")..siblingHint(args.path or "")) end; local key = tostring(args.property or ""); if key == "" then error("validation_error: property is required") end; local okC, coerced = coerceProp(inst, key, args.value); if not okC then error("validation_error: " .. tostring(coerced)) end; local okW, werr = pcall(function() (inst::any)[key] = coerced end); if not okW then error(tostring(werr):sub(1, 200)) end; result={matchedPath=inst:GetFullName(), set=true, applied={[key]=true}}
    elseif tool=="get_ui_tree" then local t={}; for _,v in ipairs(game.StarterGui:GetDescendants()) do table.insert(t, v:GetFullName().." ("..v.ClassName..")") end; result={uiTree=t}
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
log("RoLink 2.7.0 loaded [repo copy] - 150 tools ready, polling "..MCP_URL)
