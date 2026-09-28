-- Curves.lua — Studio-side curve math (Animation Engine v3, Task 3.5).
-- Canonical source. The SAME core is inlined in RoLink.lua between
--   --[[CURVES_BEGIN]] and --[[CURVES_END]]
-- scripts/check_rigadapter_sync.js enforces equality (all animation modules).
--
-- PARITY RULE: easing formulas are copied 1:1 from EASE_FNS in RoLink.lua,
-- including the [-0.15, 1.15] overshoot clamp. TS curves.ts is the
-- authoring truth; this file replays the same math in-Studio.
-- Rotation is always spherical (slerp) — never Euler lerp.
-- Standalone: requires nothing. Inline: needs nothing.

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

return Curves
