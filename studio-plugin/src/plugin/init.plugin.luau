-- RoLink Studio Plugin — polls MCP every 200ms, executes, snapshots, heals, reports timings
-- Place this file as Script named "RoLink.plugin.luau" in Studio Plugins folder, or use Rojo

local HttpService = game:GetService("HttpService")
local ChangeHistoryService = game:GetService("ChangeHistoryService")
local RunService = game:GetService("RunService")

local MCP_URL = "http://127.0.0.1:3001"
local POLL_INTERVAL = 0.2
local PLUGIN_NAME = "RoLink"

local toolbar = plugin:CreateToolbar(PLUGIN_NAME)
local btn = toolbar:CreateButton("RoLink", "AI bridge to Studio (polls MCP)", "rbxassetid://0")
btn.ClickableWhenViewportHidden = true

local enabled = true
local statusText = "RoLink: connecting..."

-- P3 hologram HUD (optional): src/toolVisualizer.luau as a sibling module.
-- Single-file installs (no sibling) degrade gracefully to no HUD.
local hudBtn = toolbar:CreateButton("HUD", "RoLink hologram HUD — tool visuals (P3)", "rbxassetid://0")
hudBtn.ClickableWhenViewportHidden = true
local ToolVisualizer: any = nil
pcall(function()
	local sib = script:FindFirstChild("toolVisualizer")
		or (script.Parent and script.Parent:FindFirstChild("toolVisualizer"))
		or (script.Parent and script.Parent.Parent and script.Parent.Parent:FindFirstChild("toolVisualizer"))
	if sib and sib:IsA("ModuleScript") then
		ToolVisualizer = require(sib)
	end
end)
local wsClient: any = nil
local useWS = false

-- try WebSocket (2025+)
pcall(function()
	if HttpService:FindFirstChild("CreateWebStreamClient") or (HttpService :: any).CreateWebStreamClient then
		local ok, client = pcall(function()
			return (HttpService :: any):CreateWebStreamClient(Enum.WebStreamClientType.WebSocket, { Url = "ws://127.0.0.1:17613/ws?role=plugin&token=dummy" })
		end)
		if ok and client then
			wsClient = client
			useWS = true
			print("[RoLink] WebStreamClient available, will use WS")
		end
	end
end)

local function log(msg: string)
	print("[RoLink] " .. msg)
end

if ToolVisualizer then
	pcall(function()
		ToolVisualizer.init({
			resolve = function(path: string): Instance?
				local ok, res = pcall(function()
					if path == "workspace" then return workspace end
					if path:sub(1, 5) == "game." then path = path:sub(6) end
					return game:FindFirstChild(path, true)
				end)
				return (ok and res) or nil
			end,
			log = function(m: string) log(m) end,
		})
	end)
	hudBtn.Click:Connect(function()
		pcall(function()
			ToolVisualizer.setEnabled(not ToolVisualizer.isEnabled())
			hudBtn:SetActive(ToolVisualizer.isEnabled())
		end)
	end)
	hudBtn:SetActive(true)
end

-- Sandbox env allowlist
local safeEnv = {
	print = print, warn = warn, error = error,
	pairs = pairs, ipairs = ipairs, next = next, type = type, tostring = tostring, tonumber = tonumber,
	-- Standard builtins user code expects (a missing entry reads as
	-- "attempt to call a nil value" on the calling line).
	pcall = pcall, xpcall = xpcall, assert = assert, select = select, unpack = unpack,
	require = require, setmetatable = setmetatable, getmetatable = getmetatable,
	rawget = rawget, rawset = rawset, rawequal = rawequal, rawlen = rawlen,
	math = math, string = string, table = table, vector = vector,
	game = game, workspace = workspace, Instance = Instance, Enum = Enum,
	task = task, tick = tick, time = time, os = { clock = os.clock, date = os.date, time = os.time },
}

-- S1 local heal helpers
local function balanceParens(code: string): string
	local o = select(2, code:gsub("%(", ""))
	local c = select(2, code:gsub("%)", ""))
	if o > c then return code .. string.rep(")", o - c) end
	if c > o then return string.rep("(", c - o) .. code end
	return code
end

local function healMissingEnds(code: string): string
	local opens = 0
	for _ in code:gmatch("%f[%w]function%f[%W]") do opens += 1 end
	for _ in code:gmatch("%f[%w]if%f[%W]") do opens += 1 end
	for _ in code:gmatch("%f[%w]for%f[%W]") do opens += 1 end
	for _ in code:gmatch("%f[%w]while%f[%W]") do opens += 1 end
	for _ in code:gmatch("%f[%w]do%f[%W]") do opens += 1 end
	local ends = select(2, code:gsub("%f[%w]end%f[%W]", ""))
	if opens > ends then return code .. string.rep("\nend", opens - ends) end
	return code
end

-- Error context: a runtime message carries only a chunk line number
-- ([string "RoLink"]:460) - attach the failing line (plus neighbours) so the
-- model can fix the actual expression instead of guessing from a code head.
local function errLineCtx(code: string, err: string): string
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
	local function trim(s: string): string
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

-- Wall-clock budget (mirrors RoLink.lua runWithDeadline): a never-resolving
-- yield would wedge the single-flight queue, so abandon past the deadline.
local EXEC_BUDGET_S = 20
local function runWithDeadline(fn: any, code: string): (boolean, any)
	local done, okRun, ret = false, false, nil
	local co = coroutine.create(function()
		okRun, ret = pcall(fn)
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
				.. "s (likely a hung require or wait without timeout - verify modules singly) [code: " .. head .. ( #code > 120 and "..." or "") .. "]"
				.. errLineCtx(code, "")
		end
		task.wait(0.1)
	end
	return okRun, ret
end

local function sandboxRun(code: string): (boolean, any)
	-- try loadstring if enabled, else ModuleScript fallback
	local fn: any
	local ok, res = pcall(function()
		return loadstring(code, "RoLink")
	end)
	if ok and res then
		fn = res
		pcall(function() setfenv(fn, safeEnv) end)
		local ok2, ret = runWithDeadline(fn, code)
		if ok2 then return true, ret end
		-- S1 auto-heal retry: balance parens / missing ends / deprecated connect
		local errMsg: string = tostring(ret)
		local healed = code
		if errMsg:find("expected") or errMsg:find("unfinished") or errMsg:find("%) expected") then
			healed = balanceParens(healed)
			healed = healMissingEnds(healed)
		end
		if errMsg:find(":connect") then healed = healed:gsub(":connect%(", ":Connect(") end
		healed = healed:gsub("WatiForChild", "WaitForChild"):gsub("Instnace", "Instance")
		if healed ~= code then
			log("S1 heal retry: " .. errMsg:sub(1,120))
			local okH, resH = pcall(function() return loadstring(healed, "RoLinkHeal") end)
			if okH and resH then
				pcall(function() setfenv(resH, safeEnv) end)
				local ok2h, retH = pcall(resH)
				if ok2h then return true, retH end
				return false, tostring(retH) .. " (heal attempted: " .. healed:sub(1,200) .. ")"
			end
		end
		return false, errMsg .. errLineCtx(code, errMsg)
	else
		-- ModuleScript fallback
		local ok3, ret2 = pcall(function()
			local mod = Instance.new("ModuleScript")
			mod.Name = "RoLinkTemp_" .. tostring(math.random(1000,9999))
			mod.Source = code .. "\nreturn true"
			local reqOk, reqRet = pcall(require, mod)
			mod:Destroy()
			if not reqOk then error(reqRet) end
			return reqRet
		end)
		if ok3 then return true, ret2 end
		return false, tostring(ret2)
	end
end

local function captureSnapshot(maxDepth: number?, filter: string?): string
	local function walk(inst: Instance, depth: number, acc: { string })
		if depth > (maxDepth or 3) then return end
		if not filter or inst.Name:lower():find(filter:lower()) or inst.ClassName:lower():find(filter:lower()) then
			table.insert(acc, string.format("%s (%s) [%d children]", inst:GetFullName(), inst.ClassName, #inst:GetChildren()))
		end
		for _, c in ipairs(inst:GetChildren()) do
			walk(c, depth + 1, acc)
			if #acc > 800 then break end
		end
	end
	local acc: { string } = {}
	pcall(function() walk(game, 0, acc) end)
	-- S3 include FPS/memory hint
	local fps = 60
	pcall(function() fps = math.floor(1 / RunService.Heartbeat:Wait()) end)
	table.insert(acc, 1, string.format("-- snapshot %s | FPS~%d | total %d", os.date("%X"), fps, #acc))
	return table.concat(acc, "\n"):sub(1, 8000)
end

local function executeCommand(cmd: any): (any, string?)
	local tool = cmd.tool
	local args = cmd.args or {}
	local start = os.clock()
	local result: any = nil
	local err: string? = nil

	ChangeHistoryService:SetWaypoint("RoLink before " .. tool)

	local ok, ret = pcall(function()
		if tool == "create_instance" then
			local cl = args.className or "Part"
			local parentPath = args.parent or "workspace"
			local parent: Instance? = workspace
			-- resolve parent path naive
			if parentPath ~= "workspace" then
				pcall(function() parent = game:FindFirstChild(parentPath) or workspace end)
			end
			local inst = Instance.new(cl)
			inst.Name = args.name or cl
			if args.properties then
				for k, v in pairs(args.properties :: any) do
					pcall(function() (inst :: any)[k] = v end)
				end
			end
			inst.Parent = parent
			result = { created = inst:GetFullName(), className = cl }
		elseif tool == "delete_instance" then
			local inst = game:FindFirstChild(args.path or "")
			if inst then inst:Destroy(); result = { deleted = args.path } else error("not found " .. tostring(args.path)) end
		elseif tool == "set_property" then
			local inst = game:FindFirstChild(args.path or "")
			if not inst then error("not found " .. tostring(args.path)) end
			;(inst :: any)[args.property] = args.value
			result = { set = args.path .. "." .. args.property }
		elseif tool == "get_property" then
			local inst = game:FindFirstChild(args.path or "")
			if not inst then error("not found") end
			result = { value = (inst :: any)[args.property] }
		elseif tool == "run_code" then
			local code: string = cmd.command
			local ok2, ret2 = sandboxRun(code)
			if not ok2 then error(ret2) end
			result = { returned = ret2, codePreview = code:sub(1, 200) }
		elseif tool == "get_snapshot" then
			result = { snapshot = captureSnapshot(args.maxDepth or 3, args.filter) }
		elseif tool == "undo" then
			for _ = 1, (args.steps or 1) do pcall(function() ChangeHistoryService:Undo() end) end
			result = { undone = true, steps = args.steps or 1 }
		elseif tool == "play_sound" then
			local snd = game:FindFirstChild(args.path or "")
			if snd and (snd :: any).Play then (snd :: any):Play(); result = { played = args.path } else error("sound not found") end
		elseif tool == "adjust_difficulty" or tool == "set_difficulty_profile" then
			-- S45 DDA: apply via NumberValue in ReplicatedStorage
			pcall(function()
				local rs = game:GetService("ReplicatedStorage")
				local f = rs:FindFirstChild("RoLinkDDA") or Instance.new("Folder", rs)
				f.Name = "RoLinkDDA"
				for k,v in pairs(args :: any) do
					local val = f:FindFirstChild(k) or Instance.new("NumberValue", f)
					val.Name = k; (val :: any).Value = tonumber(v) or 0
				end
			end)
			result = { ddaApplied = true, args = args }
		elseif tool == "run_sandbox_tests" then
			-- S5 harness already wrapped server-side; just run
			local code: string = cmd.command
			local ok2, ret2 = sandboxRun(code)
			if not ok2 then error(ret2) end
			result = { testsPassed = true, returned = ret2 }
		else
			-- generic: try run_code fallback
			local ok2, ret2 = sandboxRun(cmd.command)
			if not ok2 then error(ret2) end
			result = { tool = tool, returned = ret2 }
		end
	end)

	if not ok then err = tostring(ret) end

	ChangeHistoryService:SetWaypoint("RoLink after " .. tool)
	local elapsed = os.clock() - start
	return result, err, elapsed
end

local function reportResult(id: string, result: any, err: string?, elapsed: number)
	pcall(function()
		HttpService:RequestAsync({
			Url = MCP_URL .. "/queue/result",
			Method = "POST",
			Headers = { ["Content-Type"] = "application/json" },
			Body = HttpService:JSONEncode({ id = id, result = result, error = err, timings = { elapsed = elapsed } }),
		})
	end)
	-- auto-heal: if error contains syntax, try simple fix (append end)
	if err and err:find("expected") then
		log("auto-heal hint: " .. err)
	end
end

local function poll()
	if not enabled then return end
	local ok, res = pcall(function()
		return HttpService:RequestAsync({
			Url = MCP_URL .. "/queue/next?projectId=default",
			Method = "GET",
		})
	end)
	if not ok then
		statusText = "RoLink: MCP down"
		return
	end
	local body = res.Body
	local data: any
	local ok2, parsed = pcall(function() return HttpService:JSONDecode(body) end)
	if not ok2 then return end
	data = parsed
	local cmd = data.command
	if not cmd then
		statusText = "RoLink: idle (poll)"
		return
	end
	statusText = "RoLink: executing " .. tostring(cmd.tool)
	log("executing " .. cmd.id .. " tool=" .. cmd.tool)
	if ToolVisualizer then pcall(function() ToolVisualizer.onClaim(cmd) end) end
	local result, err, elapsed = executeCommand(cmd)
	if ToolVisualizer then pcall(function() ToolVisualizer.onDone(cmd, result, err, elapsed) end) end
	reportResult(cmd.id, result, err, elapsed)
	if err then
		warn("[RoLink] error " .. tostring(err))
		statusText = "RoLink: error " .. err:sub(1, 80)
	else
		statusText = "RoLink: done " .. tostring(cmd.tool)
	end
end

-- main loop
btn.Click:Connect(function()
	enabled = not enabled
	btn:SetActive(enabled)
	log(enabled and "enabled" or "disabled")
end)

-- poll every 200ms via heartbeat
local last = 0
RunService.Heartbeat:Connect(function(dt)
	last += dt
	if last >= POLL_INTERVAL then
		last = 0
		-- don't block heartbeat
		task.spawn(poll)
	end
end)

-- S16/S23: push gameplay metrics every 20s (FPS, part count, deaths hint)
task.spawn(function()
	while true do
		task.wait(20)
		if enabled then
			pcall(function()
				local fps = 60
				-- estimate fps via heartbeat wait is unsafe here; use 60 fallback and part count as load
				local partCount = #workspace:GetDescendants()
				local metrics = {
					projectId = "default",
					avgFPS = fps,
					activePlayers = #game.Players:GetPlayers(),
				}
				-- part count as proxy for perf
				if partCount > 600 then metrics.avgFPS = 35 end
				HttpService:RequestAsync({
					Url = MCP_URL .. "/metrics",
					Method = "POST",
					Headers = { ["Content-Type"] = "application/json" },
					Body = HttpService:JSONEncode(metrics),
				})
			end)
		end
	end
end)

-- also push snapshot every 10s for context injection (future)
task.spawn(function()
	while true do
		task.wait(10)
		if enabled then
			pcall(function()
				-- could push to /snapshot endpoint if MCP adds it
			end)
		end
	end
end)

log("loaded — polling " .. MCP_URL .. " every " .. tostring(POLL_INTERVAL * 1000) .. "ms (WS=" .. tostring(useWS) .. ")")
