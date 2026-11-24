--!strict
-- ProbePlay.server.lua  (v2)
-- Paste into a Script named "ProbePlay" inside ServerScriptService, then press Play (F5).
--
-- WHY v2 EXISTS
-- v1 did `rig:FindFirstChild("RightShoulder")` - a NON-recursive lookup - and
-- reported "rig has no child named 'RightShoulder'". That result is
-- uninformative: joints live inside the rig's part hierarchy (or in a
-- subfolder), so a direct-child search finds nothing even on a perfectly valid
-- rig. v1's own error message proved it was only looking at direct children:
-- it listed Humanoid, Animate, Body Colors and nothing else.
--
-- So v2 never assumes where a joint lives. It walks the whole rig, prints what
-- is actually there (parts, classes, and every joint object), then picks the
-- joint that the Pose names and samples its rotation.
--
-- WHAT IT SETTLES
-- Whether a KeyframeSequence whose Pose.Name matches a joint actually rotates
-- that joint. The verdict is a number, not an impression.

local KeyframeSequenceProvider = game:GetService("KeyframeSequenceProvider")
local Workspace = game:GetService("Workspace")

local RIG_NAME = "Rig_A"
local SEQ_NAME = "Probe_RightArm"
local JOINT_HINT = "RightShoulder"

local JOINT_CLASSES = { Motor6D = true, AnimationConstraint = true, Bone = true }

local function fail(msg: string)
	warn("[probe] FAIL: " .. msg)
end

local function describe(inst: Instance): string
	return inst.Name .. "(" .. inst.ClassName .. ")"
end

-- ── 1. the rig ──────────────────────────────────────────────────────────
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

-- ── 2. walk the whole rig: parts + every joint, wherever they live ──────
-- Parented joints under one part is the common shape; a rig can also keep
-- them in a folder or under the Model directly. Walk, never guess.
local allJoints: { any } = {}
local jointsByName: { [string]: any } = {}
local partCount = 0
local skipFolders = { Humanoid = true, Animator = true, HumanoidRootPart = false }

for _, d in ipairs(rig:GetDescendants()) do
	if d:IsA("BasePart") then
		partCount += 1
	elseif JOINT_CLASSES[d.ClassName] then
		table.insert(allJoints, d)
		if not jointsByName[d.Name] then
			jointsByName[d.Name] = d
		end
	end
end

print(string.format("[probe] rig=%s parts=%d joints=%d", rig:GetFullName(), partCount, #allJoints))

if #allJoints == 0 then
	-- Print the tree so the log itself explains what this rig is made of.
	local parts: { string } = {}
	local others: { string } = {}
	for _, d in ipairs(rig:GetDescendants()) do
		if d:IsA("BasePart") then
			table.insert(parts, d.Name)
		else
			table.insert(others, describe(d))
		end
	end
	table.sort(parts)
	fail(RIG_NAME .. " contains NO Motor6D / AnimationConstraint / Bone - nothing for a Pose to drive.")
	print("[probe] parts: " .. table.concat(parts, ", "))
	print("[probe] non-part children: " .. table.concat(others, ", "))
	print("[probe] If those parts are welded rigidly (no joint objects), this rig cannot be "
		.. "posed by a KeyframeSequence at all - it needs real joints.")
	return
end

-- One line per joint, so the mapping Pose.Name -> joint is visible.
local jointNames: { string } = {}
for name, j in pairs(jointsByName) do
	table.insert(jointNames, name .. "=" .. j.ClassName)
end
table.sort(jointNames)
print("[probe] joints: " .. table.concat(jointNames, ", "))

-- ── 3. the sequence ─────────────────────────────────────────────────────
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
print(string.format("[probe] seq=%s keyframes=%d duration=%.2fs loop=%s",
	seq:GetFullName(), #kfs, lastTime, tostring(seq.Loop)))

-- Which Pose names does the sequence actually animate? A Pose whose Name
-- matches no joint is silently ignored by the engine - that is the failure
-- mode worth surfacing, so compare rather than assume.
local poseNames: { [string]: boolean } = {}
for _, kf in ipairs(kfs) do
	for _, d in ipairs(kf:GetDescendants()) do
		if d:IsA("Pose") then
			poseNames[d.Name] = true
		end
	end
end
local unmatched: { string } = {}
local matched: { string } = {}
for name in pairs(poseNames) do
	if jointsByName[name] then
		table.insert(matched, name)
	else
		table.insert(unmatched, name)
	end
end
table.sort(matched)
table.sort(unmatched)
print("[probe] Pose names WITH a matching joint: " .. (if #matched > 0 then table.concat(matched, ", ") else "(none)"))
if #unmatched > 0 then
	print("[probe] Pose names with NO matching joint: " .. table.concat(unmatched, ", ")
		.. "  <- these poses do nothing")
end

if #matched == 0 then
	-- Definitive and actionable: every Pose targets a name with no joint behind
	-- it, so playback cannot move anything. Stop before sampling - a still rig
	-- here would be a rig fact, not an animation fact.
	fail("no Pose name matches any joint on " .. rig.Name .. " - this clip cannot animate this rig.")
	local valid: { string } = {}
	for name in pairs(jointsByName) do
		table.insert(valid, name)
	end
	table.sort(valid)
	print("[probe] Use these joint names as Pose.part instead: " .. table.concat(valid, ", "))
	return
end

-- ── 4. pick the joint to measure ────────────────────────────────────────
local joint = jointsByName[JOINT_HINT]
if not joint then
	-- Fall back to any pose that DOES have a joint, else the first joint.
	for _, name in ipairs(matched) do
		joint = jointsByName[name]
		break
	end
	joint = joint or allJoints[1]
	print("[probe] '" .. JOINT_HINT .. "' not found - measuring " .. describe(joint) .. " instead")
end
print("[probe] measuring joint = " .. describe(joint))

-- Read the joint's rotation in degrees. AnimationConstraint and Motor6D both
-- expose Transform; Motor6D also has C0. Bone exposes Transform too. Wrap
-- each read: an unreadable property must not abort the probe.
local function jointY(): (number?, string)
	for _, prop in ipairs({ "Transform", "C0" }) do
		local ok, cf = pcall(function()
			return (joint :: any)[prop]
		end)
		if ok and typeof(cf) == "CFrame" then
			local _, y, _ = (cf :: CFrame):ToEulerAnglesYXZ()
			return math.deg(y), prop
		end
	end
	return nil, joint.ClassName .. " exposes no readable CFrame (Transform/C0)"
end

-- ── 5. play it, inside the Play DataModel ───────────────────────────────
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

local baseline, propUsed = jointY()
print(string.format("[probe] baseline %s = %s", propUsed, baseline and string.format("%+.1f deg", baseline) or "unreadable"))

local function sample(label: string)
	local y, why = jointY()
	if y then
		print(string.format("[probe] %s  Y = %+.1f deg", label, y))
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
sample("t=1.50")

print("[probe] VERDICT: if Y moved away from the baseline and came back, this joint class animates.")
print("[probe] If Y never moved, the Pose name matched but did not drive the joint - see the matched/unmatched lines above.")
