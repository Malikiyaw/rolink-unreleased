-- RigAdapter.lua — Studio-side joint adapter (Animation Engine v3, Task 1.4).
-- Canonical source. The SAME core is inlined in RoLink.lua between
--   --[[RIGADAPTER_BEGIN]] and --[[RIGADAPTER_END]]
-- (single-file installs only ship RoLink.lua). Keep the two in sync;
-- scripts/check_rigadapter_sync.js enforces it mechanically.
--
-- Contract mirror: mcp-server/src/animation/jointAdapter.ts (DRIVE_CHANNELS).
-- Ground truth reused from RoLink.lua: rlJointKind kinds, rlAnimApplyPose
-- write semantics (Motor6D .Transform, BasePart .CFrame, rest refused).
-- This module is standalone: it requires nothing and duplicates only the
-- ~6-line classifier + num-coercion so Rojo layouts can use it alone.
--
-- Honesty rule: AnimationConstraint/Bone direct-write channels are PROBED
-- at runtime via pcall. A failed probe returns "unsupported_direct", never
-- a silent no-op and never a faked success.

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

return RigAdapter
