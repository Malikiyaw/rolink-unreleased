import { describe, expect, it } from "vitest";
import type { PoseKeyframe } from "../../shared/animationProtocol.js";
import { eulerDegToQuat, makeJointPose } from "../../shared/animationProtocol.js";
import {
  analyzeKinematics,
  computeKinematics,
  kinematicPeaks,
} from "../src/animation/validator.js";

function posKey(joint: string, t: number, x: number, y = 0, z = 0): PoseKeyframe {
  return {
    t,
    pose: makeJointPose(joint, { position: { x, y, z }, semanticRole: "limb" }),
    easing: "linear",
    interpolation: "linear",
  };
}

function rotKey(joint: string, t: number, degX: number): PoseKeyframe {
  return {
    t,
    pose: makeJointPose(joint, { rotation: eulerDegToQuat({ x: degX, y: 0, z: 0 }), semanticRole: "limb" }),
    easing: "linear",
    interpolation: "slerp",
  };
}

describe("Tasks 5.1/5.2 — kinematic derivatives", () => {
  it("measures constant velocity exactly", () => {
    const keys = [posKey("A", 0, 0), posKey("A", 0.5, 1), posKey("A", 1, 2)];
    const samples = computeKinematics(keys);
    expect(samples).toHaveLength(3);
    expect(samples[1].vel.x).toBeCloseTo(2, 9);
    expect(Math.hypot(samples[1].acc.x, samples[1].acc.y, samples[1].acc.z)).toBeCloseTo(0, 9);
  });

  it("differentiates angular velocity through quaternions", () => {
    const keys = [rotKey("A", 0, 0), rotKey("A", 0.5, 90)];
    const samples = computeKinematics(keys);
    expect(Math.hypot(samples[0].angVel.x, samples[0].angVel.y, samples[0].angVel.z)).toBeCloseTo(180, 3);
  });

  it("summarizes peaks", () => {
    const peaks = kinematicPeaks(computeKinematics([posKey("A", 0, 0), posKey("A", 1, 10)]));
    expect(peaks.peakSpeedStudPerSec).toBeCloseTo(10, 9);
    expect(peaks.peakJerkStudPerSec3).toBeCloseTo(0, 9);
  });
});

describe("Task 5.3 — style-dependent spike detection", () => {
  // A violent snap: 8 studs in 0.1s between near-static holds.
  const snap = [
    posKey("Arm", 0, 0),
    posKey("Arm", 0.45, 0),
    posKey("Arm", 0.55, 8),
    posKey("Arm", 1, 8),
  ];

  it("flags the snap under REALISTIC", () => {
    const issues = analyzeKinematics([{ joint: "Arm", keys: snap }], "REALISTIC");
    const codes = issues.map((i) => i.code);
    expect(codes).toContain("SPEED_SPIKE");
    expect(issues[0].measured).toBeGreaterThan(issues[0].threshold ?? 0);
    expect(issues[0].suggestedFix).toBeTruthy();
  });

  it("tolerates anime snap that realistic rejects", () => {
    // Moderate snap: exceeds REALISTIC jerk (400) but fits ANIME (1800).
    const mild = [posKey("Arm", 0, 0), posKey("Arm", 0.4, 0), posKey("Arm", 0.5, 3), posKey("Arm", 1, 3)];
    const strict = analyzeKinematics([{ joint: "Arm", keys: mild }], "REALISTIC");
    const loose = analyzeKinematics([{ joint: "Arm", keys: mild }], "ANIME");
    expect(strict.length).toBeGreaterThan(loose.length);
  });

  it("catches teleports as discontinuities", () => {
    const keys = [posKey("A", 0, 0), posKey("A", 0.1, 0), posKey("A", 0.2, 50)];
    const issues = analyzeKinematics([{ joint: "A", keys }], "EXAGGERATED");
    expect(issues.map((i) => i.code)).toContain("DISCONTINUITY");
  });

  it("flags non-finite positions", () => {
    const bad: PoseKeyframe = {
      t: 0,
      pose: makeJointPose("A", { position: { x: NaN, y: 0, z: 0 }, semanticRole: "limb" }),
      easing: "linear",
      interpolation: "linear",
    };
    // makeJointPose keeps the NaN position (only rotations normalize).
    const issues = analyzeKinematics([{ joint: "A", keys: [bad, posKey("A", 1, 1)] }], "REALISTIC");
    expect(issues.map((i) => i.code)).toContain("IMPOSSIBLE_ROTATION");
  });
});
