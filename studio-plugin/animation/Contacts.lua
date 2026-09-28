-- Contacts.lua — Studio-side contact enforcement (Animation Engine v3, Task 4.7).
-- Canonical source. The SAME core is inlined in RoLink.lua between
--   --[[CONTACTS_BEGIN]] and --[[CONTACTS_END]]
-- scripts/check_rigadapter_sync.js enforces equality (all animation modules).
--
-- Edit-time contact locks: measure world-position drift of a driven part
-- against a locked CFrame and apply stiffness-scaled local corrections.
-- Locks are one-shot corrections plus a registry the timeline/preview loop
-- (Phase 10) calls per frame via enforceAll — this module never pretends a
-- background loop exists. Orientation is intentionally untouched: contacts
-- lock POSITION; orientation constraints arrive with Phase 4 IK layering.
--
-- Standalone: requires nothing. Inline: needs nothing.

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

return Contacts
