-- Dynamics.lua — Studio-side secondary motion (Animation Engine v3, Task 6.4).
-- Canonical source. The SAME core is inlined in RoLink.lua between
--   --[[DYNAMICS_BEGIN]] and --[[DYNAMICS_END]]
-- scripts/check_rigadapter_sync.js enforces equality (all animation modules).
--
-- Trailing-spring solver mirroring dynamics.ts: the secondary joint chases
-- the primary through a damped spring on the OFFSET, driven by primary
-- acceleration (inertia). Pure-math entry points (step/simulateTrack) work
-- standalone; joint application reuses RigAdapter channels and errors
-- honestly when RigAdapter is absent. Rotations spring in rotation-vector
-- space (axis x half-angle), positions in studs, semi-implicit Euler with
-- automatic substepping, zero stiffness means rigid follow.

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

return Dynamics
