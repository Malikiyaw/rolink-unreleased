import { describe, expect, it } from "vitest";
import type { PoseKeyframe } from "../../shared/animationProtocol.js";
import { eulerDegToQuat, makeJointPose } from "../../shared/animationProtocol.js";
import {
  applyEasing,
  arcLiftFactor,
  bakeTrackDense,
  EASING_FNS,
  evaluateTrack,
  maxBakedAngleStep,
  normalizeKeys,
  resolveArc,
  sampleSegment,
} from "../src/animation/curves.js";
import { densifyKeys, pruneKeys } from "../src/animation/inbetween.js";
import { quatFromAxisAngle } from "../src/animation/quaternion.js";

function key(joint: string, t: number, degX: number, easing?: PoseKeyframe["easing"]): PoseKeyframe {
  return {
    t,
    pose: makeJointPose(joint, { rotation: eulerDegToQuat({ x: degX, y: 0, z: 0 }), semanticRole: "limb" }),
    easing: easing ?? "linear",
    interpolation: "slerp",
  };
}

describe("Task 3.2 — easing parity and evaluation", () => {
  it("pins all 12 easing endpoints like the plugin", () => {
    for (const [name, fn] of Object.entries(EASING_FNS)) {
      expect(fn(0), name).toBeCloseTo(0, 9);
    }
    // f(1) is exactly 1 except springOut, whose oscillation settles at
    // ~1.0061 (same value in-Studio — the formula is shared, not the rest).
    for (const [name, fn] of Object.entries(EASING_FNS)) {
      if (name === "springOut") {
        expect(fn(1), name).toBeCloseTo(1.0061, 3);
      } else {
        expect(fn(1), name).toBeCloseTo(1, 6);
      }
    }
  });

  it("keeps non-overshoot easings monotonic", () => {
    for (const [name, fn] of Object.entries(EASING_FNS)) {
      if (name === "bezierOut" || name === "springOut") continue;
      let prev = -Infinity;
      for (let i = 0; i <= 20; i += 1) {
        const v = fn(i / 20);
        expect(v, `${name}@${i}`).toBeGreaterThanOrEqual(prev - 1e-12);
        prev = v;
      }
    }
  });

  it("matches plugin overshoot values and clamps", () => {
    expect(EASING_FNS.bezierOut(0.5)).toBeCloseTo(1.025, 9);
    expect(EASING_FNS.springOut(0)).toBe(0);
    expect(applyEasing("bezierOut", 0.5)).toBeCloseTo(1.025, 9);
    for (let i = 0; i <= 40; i += 1) {
      for (const e of ["bezierOut", "springOut"] as const) {
        const v = applyEasing(e, i / 40);
        expect(v).toBeLessThanOrEqual(1.15);
        expect(v).toBeGreaterThanOrEqual(-0.15);
      }
    }
    expect(applyEasing("nope" as never, 0.3)).toBeCloseTo(0.3, 9);
  });

  it("samples segments at endpoints and eased midpoints", () => {
    const k0 = key("A", 0, 0);
    const k1 = key("A", 1, 90, "quadInOut");
    expect(sampleSegment(k0, k1, 0).rotation.w).toBeCloseTo(1, 6);
    const end = sampleSegment(k0, k1, 1);
    expect(Math.abs(end.rotation.w)).toBeCloseTo(Math.SQRT1_2, 4);
    const mid = sampleSegment(k0, k1, 0.5);
    const expected = quatFromAxisAngle({ x: 1, y: 0, z: 0 }, Math.PI / 4);
    const dot = Math.abs(
      mid.rotation.w * expected.w + mid.rotation.x * expected.x +
      mid.rotation.y * expected.y + mid.rotation.z * expected.z,
    );
    expect(dot).toBeGreaterThan(0.99999);
  });

  it("holds step segments and clamps out-of-range evaluation", () => {
    const keys = [key("A", 0, 0), { ...key("A", 1, 90), interpolation: "step" as const }];
    const held = evaluateTrack(keys, 0.7);
    expect(held.rotation.w).toBeCloseTo(1, 6);
    expect(evaluateTrack(keys, -1).rotation.w).toBeCloseTo(1, 6);
    expect(Math.abs(evaluateTrack(keys, 5).rotation.w)).toBeCloseTo(Math.SQRT1_2, 4);
  });

  it("normalizes and dedupes key lists", () => {
    const keys = [key("A", 1, 10), key("A", 0, 0), key("A", 1, 20)];
    const norm = normalizeKeys(keys);
    expect(norm.map((k) => k.t)).toEqual([0, 1]);
    expect(norm[1].pose.rotation).toEqual(keys[2].pose.rotation);
  });
});

describe("Task 3.3 — motion arcs", () => {
  it("lifts the apex and grounds the endpoints", () => {
    const arc = resolveArc({ direction: { x: 0, y: 1, z: 0 }, arcHeight: 2, peakTiming: 0.5 });
    expect(arc?.peak).toBeCloseTo(0.5, 9);
    expect(arcLiftFactor(0, 0.5)).toBeCloseTo(0, 9);
    expect(arcLiftFactor(1, 0.5)).toBeCloseTo(0, 9);
    expect(arcLiftFactor(0.5, 0.5)).toBeCloseTo(1, 9);
  });

  it("shifts the apex with bias and normalizes direction", () => {
    const arc = resolveArc({ direction: { x: 0, y: 0, z: 0 }, arcHeight: 1, arcBias: 1 });
    expect(arc).toBeUndefined();
    const biased = resolveArc({ direction: { x: 2, y: 0, z: 0 }, arcHeight: 1, peakTiming: 0.5, arcBias: 1 });
    expect(biased?.peak).toBeCloseTo(0.75, 9);
    expect(biased?.direction.x).toBeCloseTo(1, 9);
    expect(resolveArc(undefined)).toBeUndefined();
    expect(resolveArc({ direction: { x: 0, y: 1, z: 0 }, arcHeight: 0 })).toBeUndefined();
  });

  it("bakes arced tracks through the apex", () => {
    const track = {
      joint: "Hand",
      jointKind: "Motor6D" as const,
      semanticRole: "hand" as const,
      keys: [key("Hand", 0, 0), key("Hand", 1, 0)],
    };
    const baked = bakeTrackDense(track, {
      fps: 10,
      arcs: { Hand: { direction: { x: 0, y: 1, z: 0 }, arcHeight: 2, peakTiming: 0.5 } },
    });
    expect(baked.samples).toBe(11);
    const ys = baked.keys.map((k) => k.pose.position.y);
    expect(Math.max(...ys)).toBeCloseTo(2, 6);
    expect(ys[0]).toBeCloseTo(0, 9);
    expect(ys[ys.length - 1]).toBeCloseTo(0, 9);
  });
});

describe("Task 3.2 — dense baking quality", () => {
  it("bakes smooth quaternion motion with small angle steps", () => {
    const track = {
      joint: "Arm",
      jointKind: "Motor6D" as const,
      semanticRole: "limb" as const,
      keys: [key("Arm", 0, 0, "quadInOut"), key("Arm", 1, 90, "quadInOut")],
    };
    const baked = bakeTrackDense(track, { fps: 30 });
    expect(baked.samples).toBe(31);
    // quadInOut peaks at 2x mean velocity mid-segment: 90deg * 2 / 30fps.
    expect(maxBakedAngleStep(baked.keys)).toBeLessThan(6.5);
    const steps: number[] = [];
    for (let i = 1; i < baked.keys.length; i += 1) {
      const a = baked.keys[i - 1].pose.rotation;
      const b = baked.keys[i].pose.rotation;
      const dot = Math.abs(a.w * b.w + a.x * b.x + a.y * b.y + a.z * b.z);
      steps.push((2 * Math.acos(Math.min(1, dot)) * 180) / Math.PI);
    }
    expect(steps[0]).toBeLessThan(steps[15]);
    expect(steps[steps.length - 1]).toBeLessThan(steps[15]);
    for (const k of baked.keys) {
      const q = k.pose.rotation;
      expect(Math.hypot(q.w, q.x, q.y, q.z)).toBeCloseTo(1, 6);
      expect(k.easing).toBe("linear");
    }
  });

  it("handles single-key tracks", () => {
    const track = {
      joint: "A",
      jointKind: "Rigid" as const,
      semanticRole: "rigid" as const,
      keys: [key("A", 0.5, 10)],
    };
    const baked = bakeTrackDense(track, { fps: 30 });
    expect(baked.samples).toBe(1);
    expect(baked.keys[0].t).toBe(0.5);
  });
});

describe("Task 3.4 — in-between densify and prune", () => {
  it("splits long segments until budgets hold", () => {
    const keys = [key("A", 0, 0), key("A", 1, 120)];
    const { keys: dense, report } = densifyKeys(keys, { maxGapSec: 0.2, maxAngleDeg: 30, maxMoveStud: 99 });
    expect(report.inserted).toBeGreaterThan(0);
    expect(report.longestGapSec).toBeLessThanOrEqual(0.2 + 1e-9);
    expect(dense[0].t).toBe(0);
    expect(dense[dense.length - 1].t).toBe(1);
    expect(maxBakedAngleStep(dense)).toBeLessThanOrEqual(30 + 1e-6);
  });

  it("leaves conforming segments alone", () => {
    const keys = [key("A", 0, 0), key("A", 0.1, 10)];
    const { report } = densifyKeys(keys, {});
    expect(report.inserted).toBe(0);
    expect(report.passes).toBe(1);
  });

  it("prunes keys already on the curve and keeps real extremes", () => {
    const keys = [key("A", 0, 0), key("A", 0.5, 45), key("A", 1, 90)];
    const { keys: pruned, report } = pruneKeys(keys, {});
    expect(report.removed).toBe(1);
    expect(pruned).toHaveLength(2);
    const bent = [key("A", 0, 0), key("A", 0.5, 80, "quadIn"), key("A", 1, 90)];
    expect(pruneKeys(bent, {}).report.removed).toBe(0);
  });
});
