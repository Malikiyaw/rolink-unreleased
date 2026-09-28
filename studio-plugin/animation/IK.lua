-- IK.lua — Studio-side IKControl wrappers (Animation Engine v3, Task 4.6).
-- Canonical source. The SAME core is inlined in RoLink.lua between
--   --[[IK_BEGIN]] and --[[IK_END]]
-- scripts/check_rigadapter_sync.js enforces equality (all animation modules).
--
-- These wrap Roblox IKControl for RUNTIME (Play-mode) procedural posing:
-- reach targets, terrain-adapting feet, look-at. Edit-time keyframe baking
-- is the TS solver's job (ik.ts); IKControl only solves at runtime, so this
-- module never claims baked output. Every property set is pcall-guarded and
-- reported — callers see exactly what landed on the constraint.
--
-- Standalone: requires nothing. Inline: needs nothing.

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

return IK
