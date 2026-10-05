-- studio-plugin/src/toolVisualizer.luau
-- P3 ToolVisualizer — In-Studio hologram HUD for the 1000x Tool Visibility System.
--
-- SOURCE OF TRUTH for Studio-side visuals. RoLink.lua embeds a copy (see its
-- "VISUALIZER SYNC" block); keep the two in sync when changing categories,
-- chip layout, or sound ids.
--
-- Design rules:
--   * Every public entry point is pcall-guarded internally and NEVER throws:
--     a HUD failure must never fail a tool command.
--   * Nothing persists in the place: temp pins/ghosts are Debris-cleaned,
--     HUD lives in CoreGui (plugin context), sounds are PlayLocalSound.
--   * Works degraded: if CoreGui/SoundService are unavailable, counters and
--     log calls become no-ops and commands still execute.
local ToolVisualizer = {}

-- Category colors mirror rolink-extension/ui/toolHud/toolRegistry.js
-- (read #5B8DEF, edit #FFB800, inspect #00E5FF, generate #FF6B35,
--  asset #F472B6, visual #A855F7, test #00FF88, tool #94A3B8).
local CATEGORY_COLORS: { [string]: Color3 } = {
	read = Color3.fromRGB(91, 141, 239),
	edit = Color3.fromRGB(255, 184, 0),
	inspect = Color3.fromRGB(0, 229, 255),
	generate = Color3.fromRGB(255, 107, 53),
	asset = Color3.fromRGB(244, 114, 182),
	visual = Color3.fromRGB(168, 85, 247),
	test = Color3.fromRGB(0, 255, 136),
	tool = Color3.fromRGB(148, 163, 184),
}

-- Explicit 111-tool map (mirrors config.js toolCategory distribution:
-- inspect 5, edit 33, read 36, generate 8, asset 3, visual 7, test 13,
-- tool 6). Unknown/dynamic tools (list_roblox_studios, get_studio_state,
-- aliases) fall through to the substring fallback in categoryOf().
local TOOL_CATEGORY: { [string]: string } = {
	-- inspect (5)
	take_snapshot = "inspect", rollback = "inspect", diff_snapshots = "inspect",
	get_instances = "inspect", find_instance = "inspect",
	-- edit (33)
	execute_luau = "edit", set_script_content = "edit", create_module = "edit",
	create_instance = "edit", set_properties = "edit", delete_instance = "edit",
	clone_instance = "edit", move_instance = "edit", run_function = "edit",
	add_event_handler = "edit", remove_event_handler = "edit", ensure_path = "edit",
	resolve_path = "edit", place_parts = "edit", create_model_from_table = "edit",
	set_terrain_region = "edit", set_ui_property = "edit", bind_ui_click = "edit",
	set_datastore_value = "edit", setup_datastore = "edit", create_project = "edit",
	import_project = "edit", switch_project = "edit", set_breakpoint = "edit",
	remove_breakpoint = "edit", apply_template = "edit", add_template = "edit",
	refactor_code = "edit", load_plugin = "edit", git_commit = "edit",
	git_rollback = "edit", adjust_difficulty = "edit", set_difficulty_profile = "edit",
	-- read (36)
	get_script_content = "read", get_context_summary = "read", get_function_signatures = "read",
	get_property_value = "read", get_all_properties = "read", search_by_attribute = "read",
	get_referenced_instances = "read", get_global_variables = "read", get_dependency_graph = "read",
	get_ui_tree = "read", get_datastore_value = "read", get_projects = "read",
	get_suggestions = "read", get_analytics = "read", get_metrics = "read",
	get_memory_usage = "read", get_performance_stats = "read", get_time = "read",
	list_templates = "read", list_plugins = "read", list_sessions = "read",
	git_log = "read", explain_code = "read", validate_command = "read",
	suggest_ordering = "read", suggest_design = "read", suggest_balance = "read",
	export_session_log = "read", replay_session = "read", compare_sessions = "read",
	session_users = "read", report_metrics = "read", report_analytics = "read",
	predict_bug = "read", review_code = "read", export_project = "read",
	-- generate (8)
	generate_terrain = "generate", generate_asset = "generate", generate_level = "generate",
	generate_quest = "generate", generate_sound = "generate", generate_sound_pack = "generate",
	generate_test = "generate", compile_visual_graph = "generate",
	-- asset (3)
	search_asset = "asset", import_asset = "asset", apply_material = "asset",
	-- visual (9)
	create_ui = "visual", create_animation_track = "visual", play_animation = "visual",
	get_animation_info = "visual", delete_animation = "visual",
	set_lighting = "visual", add_particle_emitter = "visual", play_sound = "visual",
	send_notification = "visual",
	-- test (13)
	run_tests = "test", simulate_ticks = "test", simulate_economy = "test",
	run_in_sandbox = "test", run_playtest = "test", confirm_sandbox_apply = "test",
	discard_sandbox = "test", step_through = "test", continue_execution = "test",
	watch_variable = "test", analyze_performance = "test",
	set_performance_threshold = "test", optimize_performance = "test",
	-- tool / ops (6)
	batch_queue = "tool", cancel_command = "tool", train_model = "tool",
	plan_game = "tool", execute_plan = "tool", learning_mode = "tool",
}

local function categoryOf(tool: string): string
	if not tool or type(tool) ~= "string" then return "tool" end
	local hit = TOOL_CATEGORY[tool]
	if hit then return hit end
	local n = tool:lower()
	if n:find("generate", 1, true) or n == "compile_visual_graph" then return "generate" end
	if n:find("search_asset", 1, true) or n:find("import_asset", 1, true) then return "asset" end
	if n:find("animation", 1, true) or n:find("lighting", 1, true) or n:find("particle", 1, true) then return "visual" end
	if n:find("test", 1, true) or n:find("simulat", 1, true) or n:find("sandbox", 1, true)
		or n:find("playtest", 1, true) or n:find("breakpoint", 1, true) then return "test" end
	if n:sub(1, 4) == "get_" or n:sub(1, 5) == "list_" or n:find("suggest", 1, true)
		or n:find("search", 1, true) or n:find("review", 1, true) then return "read" end
	return "tool"
end

-- Built-in sounds (rbxasset:// works offline, no library id needed).
local SOUND_TICK = "rbxasset://sounds/electronicpingshort.wav"
local SOUND_OK = "rbxasset://sounds/bass.wav"
local SOUND_ERR = "rbxasset://sounds/electronicpingshort.wav"

local state = {
	enabled = true,
	soundOn = true,
	hud = nil :: ScreenGui?,
	headText = nil :: TextLabel?,
	logFrame = nil :: ScrollingFrame?,
	diffFrame = nil :: Frame?,
	diffText = nil :: TextLabel?,
	pending = {} :: { [string]: any },
	stats = { total = 0, running = 0, errors = 0 },
	resolve = nil :: ((string) -> Instance?)?,
	logFn = nil :: ((string) -> ())?,
}

local function getServices()
	local ok, coreGui = pcall(function() return game:GetService("CoreGui") end)
	local ok2, sound = pcall(function() return game:GetService("SoundService") end)
	local ok3, debris = pcall(function() return game:GetService("Debris") end)
	return (ok and coreGui) or nil, (ok2 and sound) or nil, (ok3 and debris) or nil
end

local function playSound(id: string, volume: number, speed: number)
	if not state.soundOn then return end
	pcall(function()
		local _, soundSvc, _ = getServices()
		if not soundSvc then return end
		local s = Instance.new("Sound")
		s.SoundId = id
		s.Volume = volume
		s.PlaybackSpeed = speed
		soundSvc:PlayLocalSound(s)
		s.Destroying:Connect(function() end)
		task.delay(3, function() pcall(function() s:Destroy() end) end)
	end)
end

local function hudLog(text: string, color: Color3?)
	pcall(function()
		if not state.logFrame then return end
		local line = Instance.new("TextLabel")
		line.BackgroundTransparency = 1
		line.Font = Enum.Font.Code
		line.TextSize = 11
		line.TextXAlignment = Enum.TextXAlignment.Left
		line.Text = text:sub(1, 120)
		line.TextColor3 = color or Color3.fromRGB(230, 237, 243)
		line.Size = UDim2.new(1, -8, 0, 16)
		line.Parent = state.logFrame
		local kids = state.logFrame:GetChildren()
		local count = 0
		for _, k in ipairs(kids) do
			if k:IsA("TextLabel") then
				count += 1
				if count > 30 then k:Destroy() break end
			end
		end
	end)
end

local function updateHead()
	pcall(function()
		if state.headText then
			state.headText.Text = string.format(
				"RoLink • 111 Tools   |   running %d   |   done %d   |   errors %d",
				state.stats.running, state.stats.total, state.stats.errors)
		end
	end)
end

local function ensureHud(): boolean
	if state.hud and state.hud.Parent then return true end
	local coreGui, _, _ = getServices()
	if not coreGui then return false end
	local ok = pcall(function()
		local old = coreGui:FindFirstChild("RoLinkHUD")
		if old then old:Destroy() end
		local gui = Instance.new("ScreenGui")
		gui.Name = "RoLinkHUD"
		gui.ResetOnSpawn = false
		gui.DisplayOrder = 999
		gui.Parent = coreGui

		local panel = Instance.new("Frame")
		panel.AnchorPoint = Vector2.new(1, 0)
		panel.Position = UDim2.new(1, -12, 0, 40)
		panel.Size = UDim2.new(0, 300, 0, 30)
		panel.BackgroundColor3 = Color3.fromRGB(14, 17, 24)
		panel.BackgroundTransparency = 0.08
		panel.BorderSizePixel = 0
		panel.Parent = gui
		local corner = Instance.new("UICorner")
		corner.CornerRadius = UDim.new(0, 10)
		corner.Parent = panel

		local head = Instance.new("TextLabel")
		head.BackgroundTransparency = 1
		head.Font = Enum.Font.GothamBold
		head.TextSize = 11
		head.TextColor3 = Color3.fromRGB(230, 237, 243)
		head.TextXAlignment = Enum.TextXAlignment.Left
		head.Size = UDim2.new(1, -16, 1, 0)
		head.Position = UDim2.new(0, 8, 0, 0)
		head.Text = "RoLink • 111 Tools"
		head.Parent = panel

		local log = Instance.new("ScrollingFrame")
		log.Position = UDim2.new(0, 0, 1, 4)
		log.Size = UDim2.new(1, 0, 0, 0)
		log.AutomaticCanvasSize = Enum.AutomaticSize.Y
		log.CanvasSize = UDim2.new(0, 0, 0, 0)
		log.ScrollBarThickness = 4
		log.BackgroundColor3 = Color3.fromRGB(14, 17, 24)
		log.BackgroundTransparency = 0.08
		log.BorderSizePixel = 0
		log.Visible = false
		log.Parent = panel
		local pad = Instance.new("UIPadding")
		pad.PaddingLeft = UDim.new(0, 8)
		pad.PaddingTop = UDim.new(0, 4)
		pad.Parent = log
		local layout = Instance.new("UIListLayout")
		layout.SortOrder = Enum.SortOrder.LayoutOrder
		layout.Parent = log

		state.hud = gui
		state.headText = head
		state.logFrame = log
	end)
	if ok then updateHead() end
	return ok
end

local function resolveTarget(path: string?): Instance?
	if not path or path == "" then return nil end
	if state.resolve then
		local ok, inst = pcall(state.resolve, path)
		if ok and inst then return inst end
	end
	return nil
end

local function anchorPart(position: Vector3, tag: string): BasePart?
	local pin: BasePart? = nil
	pcall(function()
		local p = Instance.new("Part")
		p.Name = tag
		p.Anchored = true
		p.CanCollide = false
		p.CanQuery = false
		p.CanTouch = false
		p.Transparency = 1
		p.Size = Vector3.new(1, 1, 1)
		p.Position = position
		p.Parent = workspace
		local _, _, debris = getServices()
		if debris then debris:AddItem(p, 12) end
		pin = p
	end)
	return pin
end

local function focusPosition(): Vector3
	local pos = Vector3.new(0, 20, 0)
	pcall(function()
		local cam = workspace.CurrentCamera
		if cam then pos = cam.Focus.Position end
	end)
	return pos
end

local function showChip(cmd: any, category: string, color: Color3, phase: string, note: string?): BillboardGui?
	local chip: BillboardGui? = nil
	pcall(function()
		local args = cmd.args or {}
		local target: Instance? = resolveTarget(args.path or args.parent)
		local anchor: Instance? = nil
		if target and target:IsA("BasePart") then
			anchor = target
		elseif target then
			local ok, pivot = pcall(function() return (target :: Model):GetPivot() end)
			local pos = (ok and pivot and (pivot :: CFrame).Position) or focusPosition()
			anchor = anchorPart(pos + Vector3.new(0, 3, 0), "RoLinkPin_" .. tostring(cmd.id))
		else
			anchor = anchorPart(focusPosition(), "RoLinkPin_" .. tostring(cmd.id))
		end
		if not anchor then return end
		local gui = Instance.new("BillboardGui")
		gui.Name = "RoLinkChip_" .. tostring(cmd.id)
		gui.Adornee = anchor
		gui.Size = UDim2.fromOffset(230, 56)
		gui.StudsOffset = Vector3.new(0, 3, 0)
		gui.AlwaysOnTop = true
		gui.LightInfluence = 0
		gui.Parent = anchor
		local frame = Instance.new("Frame")
		frame.Size = UDim2.fromScale(1, 1)
		frame.BackgroundColor3 = Color3.fromRGB(14, 17, 24)
		frame.BackgroundTransparency = 0.12
		frame.BorderSizePixel = 0
		frame.Parent = gui
		local fc = Instance.new("UICorner")
		fc.CornerRadius = UDim.new(0, 8)
		fc.Parent = frame
		local stroke = Instance.new("UIStroke")
		stroke.Color = color
		stroke.Thickness = 1.5
		stroke.Parent = frame
		local name = Instance.new("TextLabel")
		name.BackgroundTransparency = 1
		name.Font = Enum.Font.Code
		name.TextSize = 13
		name.TextColor3 = color
		name.TextXAlignment = Enum.TextXAlignment.Left
		name.Text = (phase == "done" and "✓ " or (phase == "error" and "✗ " or "◌ ")) .. tostring(cmd.tool)
		name.Size = UDim2.new(1, -12, 0, 20)
		name.Position = UDim2.new(0, 6, 0, 4)
		name.Parent = frame
		local sub = Instance.new("TextLabel")
		sub.BackgroundTransparency = 1
		sub.Font = Enum.Font.Gotham
		sub.TextSize = 11
		sub.TextColor3 = Color3.fromRGB(170, 178, 190)
		sub.TextXAlignment = Enum.TextXAlignment.Left
		sub.Text = note or category
		sub.Size = UDim2.new(1, -12, 0, 16)
		sub.Position = UDim2.new(0, 6, 0, 26)
		sub.Parent = frame
		local _, _, debris = getServices()
		if debris then debris:AddItem(gui, phase == "run" and 30 or 8) end
		chip = gui
	end)
	return chip
end

local function ghostHighlight(createdPath: string?, color: Color3)
	pcall(function()
		if not createdPath then return end
		local inst = resolveTarget(createdPath)
		if not inst or not inst:IsA("BasePart") then return end
		local box = Instance.new("SelectionBox")
		box.Adornee = inst
		box.Color3 = color
		box.LineThickness = 0.08
		box.SurfaceTransparency = 0.6
		box.Parent = inst
		-- Holographic beam from above: ghost shimmer on the new instance.
		local beam = Instance.new("Beam")
		local a0 = Instance.new("Attachment")
		a0.Position = Vector3.new(0, 6, 0)
		a0.Parent = inst
		local a1 = Instance.new("Attachment")
		a1.Position = Vector3.new(0, -2, 0)
		a1.Parent = inst
		beam.Attachment0 = a0
		beam.Attachment1 = a1
		beam.Color = ColorSequence.new(color)
		beam.Width0 = 0.4
		beam.Width1 = 1.6
		beam.Transparency = NumberSequence.new(0.4)
		beam.Parent = inst
		local _, _, debris = getServices()
		if debris then
			debris:AddItem(box, 6)
			debris:AddItem(beam, 6)
			debris:AddItem(a0, 6)
			debris:AddItem(a1, 6)
		end
	end)
end

local function splitLines(s: string): { string }
	local out: { string } = {}
	for line in (s .. "\n"):gmatch("([^\n]*)\n") do
		table.insert(out, line)
	end
	return out
end

local function compactDiff(before: string, after: string): string
	-- Trim common prefix/suffix, then show removed vs added blocks (≤10 lines each).
	local a = splitLines(before)
	local b = splitLines(after)
	local pre = 0
	while pre < #a and pre < #b and a[pre + 1] == b[pre + 1] do pre += 1 end
	local suf = 0
	while suf < (#a - pre) and suf < (#b - pre) and a[#a - suf] == b[#b - suf] do suf += 1 end
	local lines: { string } = {}
	for i = pre + 1, #a - suf do
		if #lines >= 10 then table.insert(lines, "- …"); break end
		table.insert(lines, "- " .. a[i]:sub(1, 90))
	end
	for i = pre + 1, #b - suf do
		if #lines >= 22 then table.insert(lines, "+ …"); break end
		table.insert(lines, "+ " .. b[i]:sub(1, 90))
	end
	if #lines == 0 then return "= no line changes" end
	return table.concat(lines, "\n")
end

local function showDiff(tool: string, path: string, diff: string)
	pcall(function()
		if not ensureHud() or not state.hud then return end
		if state.diffFrame then pcall(function() (state.diffFrame :: Frame):Destroy() end) end
		local frame = Instance.new("Frame")
		frame.Name = "RoLinkDiff"
		frame.AnchorPoint = Vector2.new(1, 0)
		frame.Position = UDim2.new(1, -12, 0, 76)
		frame.Size = UDim2.new(0, 300, 0, 170)
		frame.BackgroundColor3 = Color3.fromRGB(14, 17, 24)
		frame.BackgroundTransparency = 0.08
		frame.BorderSizePixel = 0
		frame.Parent = state.hud
		local c = Instance.new("UICorner")
		c.CornerRadius = UDim.new(0, 10)
		c.Parent = frame
		local title = Instance.new("TextLabel")
		title.BackgroundTransparency = 1
		title.Font = Enum.Font.GothamBold
		title.TextSize = 11
		title.TextColor3 = Color3.fromRGB(255, 184, 0)
		title.TextXAlignment = Enum.TextXAlignment.Left
		title.Text = "✎ " .. tool .. "  " .. path:sub(1, 40)
		title.Size = UDim2.new(1, -12, 0, 20)
		title.Position = UDim2.new(0, 6, 0, 4)
		title.Parent = frame
		local body = Instance.new("TextLabel")
		body.BackgroundTransparency = 1
		body.Font = Enum.Font.Code
		body.TextSize = 10
		body.TextColor3 = Color3.fromRGB(230, 237, 243)
		body.TextXAlignment = Enum.TextXAlignment.Left
		body.TextYAlignment = Enum.TextYAlignment.Top
		body.TextWrapped = false
		body.Text = diff:sub(1, 1200)
		body.Size = UDim2.new(1, -12, 1, -28)
		body.Position = UDim2.new(0, 6, 0, 24)
		body.Parent = frame
		state.diffFrame = frame
		task.delay(10, function()
			pcall(function()
				if state.diffFrame == frame then frame:Destroy() end
			end)
		end)
	end)
end

function ToolVisualizer.init(opts: any?): boolean
	local ok, res = pcall(function()
		opts = opts or {}
		if type(opts.resolve) == "function" then state.resolve = opts.resolve end
		if type(opts.log) == "function" then state.logFn = opts.log end
		if opts.enabled ~= nil then state.enabled = opts.enabled ~= false end
		if opts.sound ~= nil then state.soundOn = opts.sound ~= false end
		return ensureHud()
	end)
	return ok and res
end

function ToolVisualizer.setEnabled(v: boolean)
	state.enabled = v ~= false
	pcall(function()
		if state.hud then state.hud.Enabled = state.enabled end
	end)
end

function ToolVisualizer.isEnabled(): boolean
	return state.enabled
end

function ToolVisualizer.setSound(v: boolean)
	state.soundOn = v ~= false
end

function ToolVisualizer.getStats()
	return { total = state.stats.total, running = state.stats.running, errors = state.stats.errors }
end

function ToolVisualizer.categoryOf(tool: string): string
	return categoryOf(tool)
end

function ToolVisualizer.compactDiff(before: string, after: string): string
	return compactDiff(before or "", after or "")
end

function ToolVisualizer.onClaim(cmd: any)
	pcall(function()
		if not state.enabled then return end
		if not cmd then return end
		local category = (cmd.meta and cmd.meta.category) or categoryOf(cmd.tool)
		local color = CATEGORY_COLORS[category] or CATEGORY_COLORS.tool
		state.stats.running += 1
		updateHead()
		playSound(SOUND_TICK, 0.25, 1.2)
		ensureHud()
		if state.logFrame then state.logFrame.Visible = true end
		hudLog("◌ " .. tostring(cmd.tool), color)
		-- Capture pre-image for script diffs.
		local args = cmd.args or {}
		if cmd.tool == "set_script_content" and args.path then
			local inst = resolveTarget(args.path)
			if inst then
				local ok, src = pcall(function() return (inst :: any).Source end)
				state.pending[tostring(cmd.id)] = { before = (ok and type(src) == "string") and src or "" }
			end
		end
		local chip = showChip(cmd, category, color, "run", category .. " · running…")
		if chip then state.pending[tostring(cmd.id) .. ":chip"] = chip end
	end)
end

function ToolVisualizer.onDone(cmd: any, _result: any, err: string?, elapsed: number?)
	pcall(function()
		if not cmd then return end
		local category = (cmd.meta and cmd.meta.category) or categoryOf(cmd.tool)
		local color = CATEGORY_COLORS[category] or CATEGORY_COLORS.tool
		state.stats.running = math.max(0, state.stats.running - 1)
		state.stats.total += 1
		local okDone = err == nil
		if not okDone then state.stats.errors += 1 end
		updateHead()
		if state.enabled then
			playSound(okDone and SOUND_OK or SOUND_ERR, okDone and 0.22 or 0.35, okDone and 1.4 or 0.55)
		end
		local ms = ""
		if type(elapsed) == "number" then
			ms = elapsed < 1 and string.format(" · %dms", math.floor(elapsed * 1000)) or string.format(" · %.1fs", elapsed)
		end
		hudLog((okDone and "✓ " or "✗ ") .. tostring(cmd.tool) .. ms, okDone and color or Color3.fromRGB(248, 81, 73))
		if not state.enabled then return end
		-- Retire the running chip, show the settled one.
		local key = tostring(cmd.id) .. ":chip"
		local old = state.pending[key]
		if old then
			pcall(function() (old :: BillboardGui):Destroy() end)
			state.pending[key] = nil
		end
		local note = category .. (okDone and " · done" or " · failed") .. ms
		showChip(cmd, category, okDone and color or Color3.fromRGB(248, 81, 73), okDone and "done" or "error", note)
		-- Ghost highlight on whatever the tool created.
		if okDone and _result and type(_result) == "table" then
			local created = (_result :: any).created or (_result :: any).cloned or (_result :: any).model
			if type(created) == "string" then ghostHighlight(created, color) end
		end
		-- Script diff popup.
		if okDone and cmd.tool == "set_script_content" then
			local args = cmd.args or {}
			local pend = state.pending[tostring(cmd.id)]
			local before = (pend and pend.before) or ""
			state.pending[tostring(cmd.id)] = nil
			local afterText = args.content
			if type(afterText) == "string" then
				showDiff(cmd.tool, tostring(args.path or ""), compactDiff(before, afterText))
			end
		end
	end)
end

return ToolVisualizer
