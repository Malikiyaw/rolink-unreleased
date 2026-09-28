-- Collision.lua — Studio-side geometry checks (Animation Engine v3, Task 5.6).
-- Canonical source. The SAME core is inlined in RoLink.lua between
--   --[[COLLISION_BEGIN]] and --[[COLLISION_END]]
-- scripts/check_rigadapter_sync.js enforces equality (all animation modules).
--
-- Per-part AABB volumes from live instances, overlap scanning with
-- topology-aware filtering (parent/child and joint endpoints always
-- overlap by design and are never reported), floor penetration, and
-- segment deformation against rest lengths. Mirrors the TS collision
-- module's math so Studio samples and offline analysis agree.
-- No dispatch branches here: validators consume these in Phase 8+.
--
-- Standalone: requires nothing. Inline: needs nothing.

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

return Collision
