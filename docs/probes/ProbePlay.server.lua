--!strict
-- ProbePlay.server.lua
-- Paste into a Script named "ProbePlay" inside ServerScriptService, then press Play.
--
-- WHY THIS EXISTS
-- play_animation (plugin, Edit mode) reports success but renders nothing, because
-- Studio's Edit DataModel never renders animation playback. Worse, entering Play
-- does NOT carry that track over: Studio clones the place into a fresh Play
-- DataModel whose Animator has no track loaded. So "just press Play" cannot show
-- the arm move no matter whether the plugin is fixed.
--
-- This script does the registration and the LoadAnimation INSIDE the Play
-- DataModel, so it tests the one thing still unproven: does a KeyframeSequence
-- whose Pose.Name matches "RightShoulder" actually drive an AnimationConstraint
-- rig? It prints the joint's rotation over time, so the answer is a number,
-- not an impression.

local KeyframeSequenceProvider = game:GetService("KeyframeSequenceProvider")
local Workspace = game:GetService("Workspace")

local RIG_NAME = "Rig_A"
local SEQ_NAME = "Probe_RightArm"
local JOINT_NAME = "RightShoulder"

local function fail(msg: string)
	warn("[probe] FAIL: " .. msg)
end

local rig = Workspace:WaitForChild(RIG_NAME, 10) :: Model?
if not rig then
	fail(RIG_NAME .. " not found in Workspace")
	return
end

local humanoid = rig:FindFirstChildOfClass("Humanoid")
if not humanoid then
	fail(RIG_NAME .. " has no Humanoid")
	return
end

local animator = humanoid:FindFirstChildOfClass("Animator")
if not animator then
	animator = Instance.new("Animator")
	animator.Parent = humanoid
end

local folder = Workspace:WaitForChild("RoLinkAnimations", 10)
if not folder then
	fail("Workspace/RoLinkAnimations missing - was the track built in THIS place?")
	return
end

local seq = folder:WaitForChild(SEQ_NAME, 10) :: KeyframeSequence?
if not seq or not seq:IsA("KeyframeSequence") then
	fail(SEQ_NAME .. " KeyframeSequence missing (found: " .. tostring(seq and seq.ClassName) .. ")")
	return
end

local kfs = seq:GetKeyframes()
local lastTime = 0
for _, kf in ipairs(kfs) do
	if kf.Time > lastTime then
		lastTime = kf.Time
	end
end
print(string.format("[probe] seq=%s keyframes=%d duration=%.2fs loop=%s", seq:GetFullName(), #kfs, lastTime, tostring(seq.Loop)))

-- Does the joint the Pose names actually exist, and what kind is it?
local joint = rig:FindFirstChild(JOINT_NAME)
if not joint then
	fail("rig has no child named '" .. JOINT_NAME .. "'; children are: " .. table.concat((function()
		local names = {}
		for _, c in ipairs(rig:GetChildren()) do
			if not c:IsA("BasePart") then
				table.insert(names, c.Name .. "(" .. c.ClassName .. ")")
			end
		end
		return names
	end)(), ", "))
	return
end
print(string.format("[probe] joint %s class = %s", JOINT_NAME, joint.ClassName))

local hash = KeyframeSequenceProvider:RegisterKeyframeSequence(seq)
print("[probe] runtime hash = " .. tostring(hash))

local animation = Instance.new("Animation")
animation.AnimationId = hash
local okLoad, track = pcall(function()
	return animator:LoadAnimation(animation)
end)
if not okLoad then
	fail("LoadAnimation threw: " .. tostring(track))
	return
end
local loadedTrack = track :: AnimationTrack
loadedTrack.Looped = false
loadedTrack:Play()
print("[probe] track playing")

-- Read the joint's current rotation, in degrees. AnimationConstraint exposes
-- Transform; Motor6D exposes Transform too; fall back to C0 for older rigs.
local function jointY(): (number?, string)
	local kind = joint.ClassName
	local cf: any = nil
	local okT, t = pcall(function()
		return (joint :: any).Transform
	end)
	if okT and typeof(t) == "CFrame" then
		cf = t
	else
		local okC, c = pcall(function()
			return (joint :: any).C0
		end)
		if okC and typeof(c) == "CFrame" then
			cf = c
		end
	end
	if not cf then
		return nil, kind .. " exposes no readable CFrame (Transform/C0)"
	end
	local _, y, _ = (cf :: CFrame):ToEulerAnglesYXZ()
	return math.deg(y), kind
end

local function sample(label: string)
	local y, why = jointY()
	if y then
		print(string.format("[probe] %s  %s Y = %+.1f deg", label, JOINT_NAME, y))
	else
		print(string.format("[probe] %s  unreadable: %s", label, why))
	end
end

sample("t=0.00")
task.wait(0.25)
sample("t=0.25")
task.wait(0.25)
sample("t=0.50")
task.wait(0.50)
sample("t=1.00")
task.wait(0.50)
print("[probe] done. VERDICT: if Y moved away from 0 and came back, the " .. joint.ClassName .. " rig animates and the duel will work. If Y stayed 0 the whole time, Pose.Name does not drive " .. joint.ClassName .. " and the rig needs Motor6Ds (or a different playback path).")
