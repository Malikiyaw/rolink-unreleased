--!strict
-- ProbePlay.client.lua  (v7)  -- CLIENT-SIDE. This is a LocalScript.
--
-- WHERE IT GOES:  StarterPlayer > StarterPlayerScripts, as a LocalScript.
--                 Press F5. Delete any older probe first - several probes
--                 fighting over one joint makes every reading worthless.
--
-- WHY CLIENT-SIDE
-- Animation assets load and evaluate on the CLIENT. An AnimationTrack on the
-- server reports Length = 0 and never applies poses, so a server-side probe
-- measures a clip that has no content - it cannot answer the question.
--
-- WHY THIS VERSION WAITS *AND* RE-RESOLVES
-- The rig models in this place replicate WITHOUT their bodies first: at t=0
-- Workspace.Rig_A exists with 3 children (Humanoid, Animate, Body Colors) and
-- 0 parts. Around t=2s it has 19 children, 16 parts and 15 joints. Two earlier
-- probes failed because of how they held on to that model:
--   * an instant scan simply ran too early, and
--   * a probe that cached the Model from WaitForChild kept a stale reference
--     and never saw the body arrive.
-- So this probe re-resolves Workspace[RIG_NAME] on every poll and reports if
-- the instance itself gets replaced mid-wait.
--
-- WHY THE POSE TREE IS BUILT BY HAND HERE
-- Roblox's Animator matches a Pose to a joint by PART names:
--   Pose.Name        == joint.Part1.Name   (the channel / "child")
--   Pose.Parent.Name == joint.Part0.Name   (the hierarchy / "parent")
-- Joint names are IGNORED. Naming a Pose "RightShoulder" matches nothing, and
-- the clip then loads, plays at full weight for its full duration and delivers
-- zero rotation - which looks exactly like a broken rig.
--
-- The CONTROL block drives joint.Transform directly first, so a still arm can
-- never be misread as a pose-naming problem.

local KSP = game:GetService("KeyframeSequenceProvider")
local Workspace = game:GetService("Workspace")
local RunService = game:GetService("RunService")

local RIG_NAME = "Rig_A"
local JOINT_NAME = "RightShoulder"
local ANGLES = { 0, -15, -30, -45 } -- degrees about Y, one per keyframe
local READY_TIMEOUT = 25
local MIN_PARTS = 10

local function fail(msg: string)
	warn("[probe] FAIL: " .. msg)
end

-- A multi-return call must never be wrapped in parentheses and then unpacked:
--   local _, y, _ = ((cf):ToEulerAnglesYXZ())  -->  y is the X angle or nil
-- Wrapping truncates to one value. Always land the call in plain locals.
local function yawDeg(cf: CFrame): number
	local _, y, _ = cf:ToEulerAnglesYXZ()
	return math.deg(y)
end

local function partsOf(model: Instance): number
	local n = 0
	for _, d in ipairs(model:GetDescendants()) do
		if d:IsA("BasePart") then
			n += 1
		end
	end
	return n
end

local function isJoint(d: Instance): boolean
	return d:IsA("AnimationConstraint") or d:IsA("Motor6D") or d:IsA("Bone")
end

print(string.format("[probe] IsClient=%s IsServer=%s", tostring(RunService:IsClient()), tostring(RunService:IsServer())))
print(string.format("[probe] waiting up to %ds for %s to replicate its body (needs >=%d parts)",
	READY_TIMEOUT, RIG_NAME, MIN_PARTS))

-- ── wait for the rig to become animatable, re-resolving by name ──────────
local startClock = os.clock()
local deadline = startClock + READY_TIMEOUT
local current: Instance? = nil
local firstInstance: Instance? = nil
local replaced = 0
local joint: Instance? = nil
local lastReport = -1

while os.clock() < deadline do
	local found = Workspace:FindFirstChild(RIG_NAME)
	if found and found:IsA("Model") then
		current = found
		if firstInstance == nil then
			firstInstance = found
		elseif found ~= firstInstance then
			replaced += 1
			firstInstance = found
			print(string.format("[probe] t=%.1fs RIG INSTANCE REPLACED (now %s, %d parts)",
				os.clock() - startClock, found:GetFullName(), partsOf(found)))
		end
		local parts = partsOf(found)
		local tried = found:FindFirstChild(JOINT_NAME, true)
		if tried and isJoint(tried) then
			joint = tried
			if parts >= MIN_PARTS then
				break
			end
		end
		local sec = math.floor(os.clock() - startClock)
		if sec ~= lastReport then
			lastReport = sec
			print(string.format("[probe] t=%02ds %s parts=%d joint=%s", sec, RIG_NAME, parts, joint and "found" or "none"))
		end
	end
	task.wait(0.2)
end

local rig = current
if not rig then
	fail(RIG_NAME .. " never appeared in Workspace")
	return
end
if not joint then
	fail("no animatable '" .. JOINT_NAME .. "' on " .. RIG_NAME .. " after " .. READY_TIMEOUT .. "s")
	return
end

local parts = partsOf(rig)
print(string.format("[probe] READY t=%.2fs parts=%d instanceReplaced=%d", os.clock() - startClock, parts, replaced))
if parts < MIN_PARTS then
	fail(RIG_NAME .. " has only " .. parts .. " parts - the body never arrived, so there is nothing to animate")
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
	if isJoint(d) then
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
		local container: any = parentPose or kf
		local okSub = pcall(function()
			container:AddSubPose(pose)
		end)
		if not okSub then
			pose.Parent = container
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
	local armY = yawDeg(arm.CFrame)
	local jointY = 0
	local tf: any = j.Transform
	if typeof(tf) == "CFrame" then
		jointY = yawDeg(tf)
	end
	print(string.format("[probe] %-9s delta=%.3f  armY=%+.1f  jointY=%+.1f  weight=%.2f",
		tag, delta, armY, jointY, track.WeightCurrent))
end

report("t=0.00")
for i = 1, 12 do
	task.wait(0.1)
	report(string.format("t=%.2f", i * 0.1))
end

print("[probe] VERDICT: armY sweeping toward -45 and back = the pose tree is correct.")
print("[probe] This is the tree create_animation_track builds since 2.12.0.")
