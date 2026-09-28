import { describe, expect, it } from "vitest";
import type { ContactSpec, PoseKeyframe } from "../../shared/animationProtocol.js";
import { eulerDegToQuat, makeJointPose } from "../../shared/animationProtocol.js";
import {
  detectContactBreak,
  rigidWorldSource,
  solveContactLock,
  validateContactSpec,
} from "../src/animation/contacts.js";
import { inferJointLimit, inferJointLimits, validateJointLimits } from "../src/animation/validator.js";

function footKey(t: number, y: number): PoseKeyframe {
  return {
    t,
    pose: makeJointPose("Foot", { position: { x: 0, y, z: 0 }, semanticRole: "foot" }),
    easing: "linear",
    interpolation: "linear",
  };
}

function footSpec(): ContactSpec {
  return {
    name: "FootPlant",
    type: "FOOT",
    joint: "Foot",
    worldPosition: { x: 0, y: 0, z: 0 },
    startTime: 0.2,
    endTime: 0.8,
    stiffness: 1,
    tolerance: 0.05,
  };
}

describe("Tasks 4.3/4.4 — contacts", () => {
  it("validates specs and flags unknown joints", () => {
    expect(validateContactSpec(footSpec(), ["Foot"]).ok).toBe(true);
    expect(validateContactSpec(footSpec(), ["Hand"]).ok).toBe(false);
    expect(validateContactSpec({ nope: true }).ok).toBe(false);
    expect(validateContactSpec({ ...footSpec(), startTime: 1, endTime: 0.5 }).ok).toBe(false);
  });

  it("detects drift outside the window as clean", () => {
    const keys = [footKey(0, 0.5), footKey(0.5, 0), footKey(1, 0.5)];
    const src = rigidWorldSource({ Foot: keys });
    const verdict = detectContactBreak(footSpec(), keys, src);
    expect(verdict.locked).toBe(true);
    expect(verdict.samples).toBe(1);
    expect(verdict.maxDriftStud).toBeCloseTo(0, 9);
  });

  it("locks drifting contacts under tolerance", () => {
    const keys = [footKey(0.2, 0), footKey(0.5, 0.18), footKey(0.8, 0.3)];
    const tracks: Record<string, PoseKeyframe[]> = { Foot: keys };
    const report = solveContactLock(
      footSpec(),
      keys,
      rigidWorldSource(tracks),
      (joint, t, delta) => {
        const k = tracks[joint].find((x) => Math.abs(x.t - t) < 1e-9);
        if (k) {
          k.pose.position.x += delta.x;
          k.pose.position.y += delta.y;
          k.pose.position.z += delta.z;
        }
      },
    );
    expect(report.keysAdjusted).toBe(2);
    expect(report.maxDriftBeforeStud).toBeCloseTo(0.3, 6);
    expect(report.maxDriftAfterStud).toBeLessThan(0.05);
    const verdict = detectContactBreak(footSpec(), keys, rigidWorldSource(tracks));
    expect(verdict.locked).toBe(true);
  });

  it("respects partial stiffness with smaller corrections", () => {
    const keys = [footKey(0.5, 0.2)];
    const tracks: Record<string, PoseKeyframe[]> = { Foot: keys };
    const soft = { ...footSpec(), stiffness: 0.5 };
    const report = solveContactLock(soft, keys, rigidWorldSource(tracks), (joint, t, delta) => {
      const k = tracks[joint].find((x) => Math.abs(x.t - t) < 1e-9);
      if (k) k.pose.position.y += delta.y;
    }, 1);
    expect(report.passes).toBe(1);
    expect(keys[0].pose.position.y).toBeCloseTo(0.1, 9);
  });
});

describe("Task 4.5 — joint limits are reported, never clamped", () => {
  it("infers limits for known joints and skips the rest", () => {
    expect(inferJointLimit("Neck", "neck", "Motor6D")?.joint).toBe("Neck");
    expect(inferJointLimit("LeftElbow", "limb", "Motor6D")?.maxDeg?.x).toBe(145);
    expect(inferJointLimit("LeftKnee", "limb", "Motor6D")?.maxDeg?.x).toBe(150);
    expect(inferJointLimit("NPC", "root", "Rigid")).toBeUndefined();
    expect(inferJointLimit("HumanoidRootPart", "locomotionRoot", "Rigid")).toBeUndefined();
    expect(inferJointLimit("SwordWeld", "follow", "Weld")).toBeUndefined();
    expect(inferJointLimit("Hinge", "hinge", "Motor6D")).toBeUndefined();
    expect(inferJointLimit("Mystery", "rotational", "Motor6D")).toBeUndefined();
    expect(inferJointLimit("LeftUpperArm", "limb", "Motor6D")).toBeUndefined();
  });

  it("collects limits across a rig", () => {
    const limits = inferJointLimits(
      [
        { name: "Neck", kind: "Motor6D" },
        { name: "NPC", kind: "Rigid" },
      ] as never,
      { Neck: "neck", NPC: "root" },
    );
    expect(limits.map((l) => l.joint)).toEqual(["Neck"]);
  });

  it("flags violations with joint, time, and fix — inputs untouched", () => {
    const bent: PoseKeyframe = {
      t: 0.5,
      pose: makeJointPose("LeftElbow", {
        rotation: eulerDegToQuat({ x: 170, y: 0, z: 0 }),
        semanticRole: "limb",
      }),
      easing: "linear",
      interpolation: "slerp",
    };
    const tracks = [{ joint: "LeftElbow", keys: [bent] }];
    const before = JSON.stringify(tracks);
    const limits = inferJointLimits(
      [{ name: "LeftElbow", kind: "Motor6D" }] as never,
      { LeftElbow: "limb" },
    );
    const issues = validateJointLimits(tracks, limits, {});
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].joint).toBe("LeftElbow");
    expect(issues[0].t).toBe(0.5);
    expect(issues[0].severity).toBe("error");
    expect(issues[0].suggestedFix).toContain("clamp");
    expect(["JOINT_LIMIT", "OVEREXTENSION"]).toContain(issues[0].code);
    expect(JSON.stringify(tracks)).toBe(before);
  });

  it("passes valid poses and catches non-finite rotations", () => {
    const ok: PoseKeyframe = {
      t: 0,
      pose: makeJointPose("Neck", { rotation: eulerDegToQuat({ x: 10, y: 0, z: 0 }), semanticRole: "neck" }),
      easing: "linear",
      interpolation: "slerp",
    };
    const limits = inferJointLimits([{ name: "Neck", kind: "Motor6D" }] as never, { Neck: "neck" });
    expect(validateJointLimits([{ joint: "Neck", keys: [ok] }], limits, {})).toHaveLength(0);
    // Raw (unsanitized) key: makeJointPose would normalize NaN to identity,
    // so the suite bypasses the factory to prove the validator sees corruption.
    const nan: PoseKeyframe = {
      t: 0,
      pose: {
        joint: "Neck",
        position: { x: 0, y: 0, z: 0 },
        rotation: { w: NaN, x: 0, y: 0, z: 0 },
        semanticRole: "neck",
      },
      easing: "linear",
      interpolation: "slerp",
    };
    const bad = validateJointLimits([{ joint: "Neck", keys: [nan] }], limits, {});
    expect(bad).toHaveLength(1);
    expect(bad[0].code).toBe("IMPOSSIBLE_ROTATION");
  });
});
