--!strict
-- ProbePlay.server.lua  (v5)  -- CLIENT-SIDE. This is a LocalScript.
--
-- WHERE IT GOES:  StarterPlayer > StarterPlayerScripts, as a LocalScript.
--                 Press F5. Delete any older probe Script first - several of
--                 them fighting over one joint makes every reading worthless.
--
-- WHY CLIENT-SIDE
-- Animation assets load and evaluate on the CLIENT. An AnimationTrack on the
-- server reports Length = 0 and never applies poses, so a server-side probe
-- measures a clip that has no content - it cannot answer the question.
--
-- WHY THE POSE TREE IS BUILT BY HAND HERE
-- Roblox's Animator matches a Pose to a joint by PART names:
--   Pose.Name       == joint.Part1.Name   (the channel / "child")
--   Pose.Parent.Name == joint.Part0.Name  (the hierarchy / "parent")
-- Joint names are IGNORED. Naming a Pose "RightShoulder" matches nothing, and
-- the clip then loads, plays at full weight for its full duration and delivers
-- zero rotation - which looks exactly like a broken rig.
--
-- This probe builds the tree correctly and includes a CONTROL test: it drives
-- joint.Transform directly first, so a still arm can never be misread as a
-- pose problem. Verified on an AnimationConstraint R15 rig: control moved the
-- arm 0.383 studs, and the built tree swept it 0 -> -43.5 degrees.

local KSP = game:GetService("KeyframeSequenceProvider")
local Workspace = game:GetService("Workspace")
local RunService = game:GetService("RunService")

local RIG_NAME = "Rig_A"
local SEQ_NAME = "Probe_RightArm" -- reused only to report what RoLink built
local JOINT_NAME = "RightShoulder"
local ANGLES = { 0, -15, -30, -45 } -- degrees about Y, one per keyframe

local function fail(msg: string)
	warn("[probe] FAIL: " .. msg)
end

print(string.format("[probe] IsClient=%s IsServer=%s", tostring(RunService:IsClient()), tostring(RunService:IsServer())))

local rig = Workspace:WaitForChild(RIG_NAME, 15) :: Model?
if not rig then
	fail(RIG_NAME .. " never appeared in Workspace")
	return
end

-- Joints can replicate AFTER the model that contains them: read the tree
-- once and you may snapshot a rig with no joints. Wait for the joint itself.
local joint: Instance? = nil
local deadline = os.clock() + 15
while os.clock() < deadline do
	local found = rig:FindFirstChild(JOINT_NAME, true)
	if found and (found:IsA("AnimationConstraint") or found:IsA("Motor6D") or found:IsA("Bone")) then
		joint = found
		break
	end
	task.wait(0.1)
end
if not joint then
	local counts: { [string]: number } = {}
	for _, d in ipairs(rig:GetDescendants()) do
		counts[d.ClassName] = (counts[d.ClassName] or 0) + 1
	end
	local lines: { string } = {}
	for cls, n in pairs(counts) do
		table.insert(lines, cls .. "x" .. tostring(n))
	end
	table.sort(lines)
	fail("no animatable '" .. JOINT_NAME .. "' on the CLIENT rig after 15s. Classes seen: " .. table.concat(lines, ", "))
	return
end

local humanoid = rig:FindFirstChildOfClass("Humanoid")
local animator = humanoid and humanoid:FindFirstChildOfClass("Animator")
if not (humanoid and animator) then
	fail("no Humanoid/Animator on the client rig")
	return
end

local j: any = joint
local childPart: BasePart? = j.Part1
local parentPart: BasePart? = j.Part0
if not childPart then
	fail("joint has no Part1, so it has no pose channel")
	return
end
print(string.format("[probe] joint=%s(%s) Part0=%s Part1=%s", joint.Name, joint.ClassName,
	tostring(parentPart and parentPart.Name), childPart.Name))

-- Every animatable joint, so the chain can be walked Part0-up to the root.
local joints: { any } = {}
for _, d in ipairs(rig:GetDescendants()) do
	if d:IsA("AnimationConstraint") or d:IsA("Motor6D") or d:IsA("Bone") then
		table.insert(joints, d)
	end
end

local function parentOf(part: BasePart): BasePart?
	for _, other in ipairs(joints) do
		if other.Part1 == part then
			return other.Part0
		end
	end
	return nil
end

local chain: { BasePart } = { childPart }
local cursor = parentPart
local guard = 0
while cursor and guard < 64 do
	guard += 1
	table.insert(chain, 1, cursor)
	cursor = parentOf(cursor)
end
local names: { string } = {}
for _, p in ipairs(chain) do
	table.insert(names, p.Name)
end
print("[probe] pose chain (root -> leaf): " .. table.concat(names, " > "))
print("[probe] Pose.Name must be '" .. childPart.Name .. "', under '" .. tostring(parentPart and parentPart.Name) .. "'")

-- ── CONTROL: drive the joint directly, bypassing any animation ──────────
-- A rig that cannot move on command can never animate, so this separates a
-- rig problem from a naming problem.
local arm: BasePart = childPart
local originControl = arm.Position
pcall(function()
	j.Transform = CFrame.Angles(0, math.rad(-45), 0)
end)
task.wait(0.2)
local controlDelta = (arm.Position - originControl).Magnitude
pcall(function()
	j.Transform = CFrame.new()
end)
task.wait(0.2)
print(string.format("[probe] CONTROL delta=%.3f studs -> %s", controlDelta,
	controlDelta > 0.001 and "joint CAN drive the part (rig is fine)"
	or "joint is INERT (wirings/IsKinematic) - fix the rig before the animation"))

-- ── build the sequence with a NESTED pose tree ─────────────────────────
local seq = Instance.new("KeyframeSequence")
seq.Name = "Probe_Built"
seq.Loop = false
seq.Priority = Enum.AnimationPriority.Action4

for i, deg in ipairs(ANGLES) do
	local kf = Instance.new("Keyframe")
	kf.Name = "K" .. tostring(i)
	kf.Time = (i - 1) * 0.25
	local parentPose: Pose? = nil
	for depth, part in ipairs(chain) do
		local pose = Instance.new("Pose")
		pose.Name = part.Name
		local isLeaf = depth == #chain
		pose.CFrame = if isLeaf then CFrame.Angles(0, math.rad(deg), 0) else CFrame.new()
		local okSub = pcall(function()
			(parentPose or kf :: any):AddSubPose(pose)
		end)
		if not okSub then
			pose.Parent = parentPose or kf
		end
		parentPose = pose
	end
	kf.Parent = seq
end

local function dump(inst: Instance, prefix: string)
	print("[probe] " .. prefix .. inst.Name .. " (" .. inst.ClassName .. ")")
	for _, c in ipairs(inst:GetChildren()) do
		if c:IsA("Pose") then
			dump(c, prefix .. "  ")
		end
	end
end
dump(seq:GetKeyframes()[1], "  ")

-- ── play it, client-side ───────────────────────────────────────────────
local id = KSP:RegisterKeyframeSequence(seq)
local anim = Instance.new("Animation")
anim.AnimationId = id
local track = animator:LoadAnimation(anim)
track.Looped = false
track.Priority = Enum.AnimationPriority.Action4
track:Play()

local t0 = os.clock()
while track.Length <= 0 and os.clock() - t0 < 5 do
	task.wait(0.05)
end
print(string.format("[probe] Length=%.3f (waited %.2fs)", track.Length, os.clock() - t0))
if track.Length <= 0 then
	fail("Length never left 0 on the CLIENT - the clip did not load. Asset/hash problem, not a pose-name problem.")
	return
end

local origin = arm.Position
local function report(tag: string)
	local delta = (arm.Position - origin).Magnitude
	local _, ay, _ = arm.CFrame:ToEulerAnglesYXZ()
	local _, jy, _ = ((j.Transform :: CFrame):ToEulerAnglesYXZ())
	print(string.format("[probe] %-9s delta=%.3f  armY=%+.1f  jointY=%+.1f  weight=%.2f",
		tag, delta, math.deg(ay), math.deg(jy), track.WeightCurrent))
end

report("t=0.00")
for i = 1, 12 do
	task.wait(0.1)
	report(string.format("t=%.2f", i * 0.1))
end

print("[probe] VERDICT: armY sweeping toward -45 and back = the pose tree is correct.")
print("[probe] This is the tree create_animation_track now builds; compare with " .. SEQ_NAME .. " if present.")
