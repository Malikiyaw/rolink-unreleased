-- AnimationLab.lua — RoLink Animation Lab panel (Animation Engine v3, Phase 10).
-- Canonical source. The SAME core is inlined in RoLink.lua between
--   --[[ANIMLAB_BEGIN]] and --[[ANIMLAB_END]]
-- scripts/check_rigadapter_sync.js enforces equality (all animation modules).
--
-- A data-driven animation workstation: rig tree, dope sheet, curve editor
-- with key dragging, pose inspector with joint limits, IK controls, contact
-- locks, velocity/acceleration/jerk graphs, and a quality report — plus
-- Edit-only transport with snapshot/restore. All views render from plain
-- data set via setTracks/setRig/setQuality/setIK/setContacts/setLimits
-- (future dispatch wiring in Phase 12 feeds these; the command bar can
-- feed them today). Live posing goes through PoseSolver/RigAdapter/IK/
-- Contacts channels; every Studio call is pcall-guarded with a status
-- line instead of a silent failure. No dispatch branches live here.
--
-- Standalone: requires nothing (pass the plugin object to toggle).
-- Inline: needs nothing (uses its own Lab.* kit, not rlAnim* locals).

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

return AnimationLab
