"""The pose-tree contract that every RoLink animation depends on.

Roblox's Animator docs: a Pose matches a joint by PART names -
`Pose.Name == joint.Part1.Name` and `Pose.Parent.Name == joint.Part0.Name`.
Joint names are ignored. `create_animation_track` used to write flat Poses
named after JOINTS ("RightShoulder"), so the clip loaded, played at full
weight for its full duration and delivered zero rotation.

Verified live in Studio: the same rig, with the tree built this way, swept an
arm from 0 to -43.5 degrees.
"""
import importlib.util
import os
import shutil
import subprocess
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PLUGIN = os.path.join(ROOT, "studio-plugin", "RoLink.lua")
HARNESS = os.path.join(ROOT, "tests", "fixtures", "anim_pose_tree.lua")


def _lupa():
    try:
        import lupa  # noqa: F401
    except ImportError:
        return None
    import lupa
    return lupa


class AnimPoseTreeTest(unittest.TestCase):
    def test_pose_tree_contract_holds(self):
        lupa = _lupa()
        if lupa is None:
            self.skipTest("lupa not installed (pip install lupa)")
        rt = lupa.LuaRuntime(unpack_returned_tuples=True)
        with open(HARNESS, encoding="utf-8") as f:
            rt.execute(f.read())

    def test_joint_alias_still_resolves(self):
        # Backwards compatibility: prompts written before this fix use joint
        # names ("RightShoulder"). Those must keep working, because the plugin
        # treats a joint name as an alias for its Part1.
        lupa = _lupa()
        if lupa is None:
            self.skipTest("lupa not installed")
        rt = lupa.LuaRuntime(unpack_returned_tuples=True)
        with open(HARNESS, encoding="utf-8") as f:
            rt.execute(f.read())
        # The harness publishes these so a joint name ("RightShoulder") is
        # proven to resolve to the Part1 channel name ("RightUpperArm").
        self.assertEqual(rt.eval('chain2[4]'), 'RightUpperArm')
        self.assertEqual(rt.eval('#chain2'), 4)

    def test_plugin_names_poses_after_parts_not_joints(self):
        # Structural guard on the shipped source: createAnimationTrack must
        # build a chain from Motion.PoseChain, and must not assign pose.Name
        # straight from the requested `part` (which is what produced the
        # inert clips).
        with open(PLUGIN, encoding="utf-8") as f:
            src = f.read()
        self.assertIn("Motion.PoseChain(", src)
        self.assertIn("Motion.JointFor(", src)
        self.assertIn("AnimationConstraint = true", src)
        # the old flat-pose line must be gone
        self.assertNotIn('pose.Name = tostring((pD::any).part or "Torso")', src)
        # the chain must be walked, and ancestors must be pass-through
        self.assertIn("local isLeaf = depth == #chain", src)
        self.assertIn("pose.CFrame = CFrame.new()", src)

    def test_animation_constraint_is_a_rotational_joint(self):
        # rlJointKind gated the timeline editor on Motor6D/Bone, so every joint
        # on an AnimationConstraint rig read as "static" and RoLink's own editor
        # showed nothing to animate.
        with open(PLUGIN, encoding="utf-8") as f:
            src = f.read()
        self.assertIn('inst:IsA("AnimationConstraint") then return "rotational"', src)
        self.assertNotIn('if inst:IsA("Motor6D") then\n    (inst :: Motor6D).Transform = cf', src)

    def test_motion_rig_walks_every_joint_class(self):
        # motionRigInfo built its parent map from Motor6D only, so on a
        # 15-AnimationConstraint rig the map came back empty and the pose tree
        # collapsed to one pose.
        with open(PLUGIN, encoding="utf-8") as f:
            src = f.read()
        self.assertIn("if Motion.IsJoint(d) then", src)
        self.assertNotIn("if d:IsA(\"Motor6D\") then\n        local p0, p1 = d.Part0, d.Part1", src)

    def test_pose_name_errors_name_the_real_parts(self):
        # MOTION_TRACK_NOT_FOUND used to say "run analyze_animatable_model",
        # which maps AnimationConstraint to "static" - a guaranteed false
        # negative on exactly the rigs that hit this error.
        with open(PLUGIN, encoding="utf-8") as f:
            src = f.read()
        self.assertNotIn("run analyze_animatable_model and use an exact part name", src)
        self.assertIn("Pose channels are PART names", src)


if __name__ == "__main__":
    unittest.main()
