-- Harness: exercises studio-plugin's pose-tree resolver against a mocked
-- AnimationConstraint rig. Run with lupa. Aborts (error) on any violation,
-- so a nonzero exit means the contract broke.
--
-- The contract, from Roblox's Animator docs: a Pose matches a joint by PART
-- names - Pose.Name == joint.Part1.Name, Pose.Parent.Name == joint.Part0.Name.
-- Joint names are IGNORED by the engine, which is why building Poses named
-- "RightShoulder" produced a clip that played and moved nothing.

local CF = {}
CF.__index = CF
function CF.new() return setmetatable({}, CF) end
function CF.__mul() return CF.new() end
CF.identity = CF.new()

function mkPart(name)
  local p = { Name = name, ClassName = "Part" }
  function p:IsA(c) return self.ClassName == c or (c == "BasePart" and self.ClassName == "Part") end
  function p:GetDescendants() return {} end
  function p:GetChildren() return {} end
  return p
end

function mkJoint(cls, name, p0, p1)
  local j = { Name = name, ClassName = cls, Part0 = p0, Part1 = p1 }
  function j:IsA(c) return self.ClassName == c end
  return j
end

local root  = mkPart("HumanoidRootPart")
local lower = mkPart("LowerTorso")
local upper = mkPart("UpperTorso")
local rua   = mkPart("RightUpperArm")
local rla   = mkPart("RightLowerArm")

local joints = {
  mkJoint("AnimationConstraint", "Root",  root,  lower),
  mkJoint("AnimationConstraint", "Waist", lower, upper),
  mkJoint("AnimationConstraint", "RightShoulder", upper, rua),
  mkJoint("AnimationConstraint", "RightElbow",   rua,   rla),
}

local rig = { Name = "Rig_A", ClassName = "Model" }
function rig:IsA(c) return self.ClassName == c end
function rig:GetDescendants()
  local out = {}
  for _, p in ipairs({ root, lower, upper, rua, rla }) do table.insert(out, p) end
  for _, j in ipairs(joints) do table.insert(out, j) end
  return out
end

-- ── the resolver under test (mirrors Motion.PoseChain) ─────────────────
local JOINT_CLASSES = { Motor6D = true, AnimationConstraint = true, Bone = true }
local function IsJoint(inst) return JOINT_CLASSES[inst.ClassName] == true end
local function JointsOf(r) local o = {} for _, d in ipairs(r:GetDescendants()) do if IsJoint(d) then table.insert(o, d) end end return o end
local function JointFor(r, wanted)
  local match = nil
  for _, j in ipairs(JointsOf(r)) do
    if j.Part1 and j.Part1.Name == wanted then return j end
    if not match and j.Name == wanted then match = j end
  end
  return match
end
local function PoseChain(r, wanted)
  local joint = JointFor(r, wanted)
  if not joint then return nil, nil, "no joint" end
  local child = joint.Part1
  if not child then return nil, joint, "no Part1" end
  local all = JointsOf(r)
  local function parentOf(part)
    for _, other in ipairs(all) do
      if other.Part1 == part then return other.Part0 end
    end
  end
  local chain = { child.Name }
  local cursor = joint.Part0
  local guard = 0
  while cursor and guard < 64 do
    guard = guard + 1
    table.insert(chain, 1, cursor.Name)
    cursor = parentOf(cursor)
  end
  return chain, joint, nil
end

-- ── assertions ─────────────────────────────────────────────────────────
local function eq(actual, expected, what)
  if actual ~= expected then
    error(("FAIL %s: expected %q, got %q"):format(what, tostring(expected), tostring(actual)), 2)
  end
end

-- 1. the canonical name is the CHILD PART, not the joint
chain, joint = PoseChain(rig, "RightUpperArm")
eq(#chain, 4, "chain length for RightUpperArm")
eq(chain[1], "HumanoidRootPart", "chain[1]")
eq(chain[2], "LowerTorso", "chain[2]")
eq(chain[3], "UpperTorso", "chain[3]")
eq(chain[4], "RightUpperArm", "chain[4] (leaf = Part1)")
eq(joint.Name, "RightShoulder", "resolved joint")

-- 2. a JOINT name must still resolve (backwards compatibility for old prompts)
chain2 = PoseChain(rig, "RightShoulder")
eq(#chain2, 4, "chain length for joint-name alias")
eq(chain2[4], "RightUpperArm", "joint alias maps to Part1 name")

-- 3. Part names win over joint names when both could match
eq(PoseChain(rig, "RightUpperArm")[4], "RightUpperArm", "part name precedence")

-- 4. an unknown name must fail rather than silently build a bad pose
local bad, _, why = PoseChain(rig, "Torso")
if bad ~= nil then error("FAIL: unknown part 'Torso' resolved to a chain") end
if not why then error("FAIL: unknown part produced no reason") end

-- 5. the leaf of a deeper joint still ends at its own Part1
chain3 = PoseChain(rig, "RightLowerArm")
eq(chain3[5], "RightLowerArm", "leaf of nested joint")
eq(#chain3, 5, "chain length for RightLowerArm")

print("anim_pose_tree: all assertions passed")
