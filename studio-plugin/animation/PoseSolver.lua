-- PoseSolver.lua — Studio-side pose application (Animation Engine v3, Task 3.5).
-- Canonical source. The SAME core is inlined in RoLink.lua between
--   --[[POSESOLVER_BEGIN]] and --[[POSESOLVER_END]]
-- scripts/check_rigadapter_sync.js enforces equality (all animation modules).
--
-- Applies sparse/dense pose tracks to live joints through RigAdapter drive
-- channels (quaternion-authoritative; Euler degrees accepted at the door
-- and converted). Curve math comes from Curves.lua (sibling section).
-- No dispatch branches here: Phase 12 wires these into migrated tools.
--
-- RigAdapter resolution: inline chunk upvalue when inlined in RoLink.lua,
-- Rojo sibling ModuleScript otherwise, honest error when neither exists.

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

return PoseSolver
