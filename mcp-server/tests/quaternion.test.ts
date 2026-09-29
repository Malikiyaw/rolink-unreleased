import { describe, expect, it } from "vitest";
import { eulerDegToQuat } from "../../shared/animationProtocol.js";
import {
  quatAngleBetween,
  quatAngleDegBetween,
  quatAngularVelocity,
  quatConjugate,
  quatDot,
  quatEnsureShortestPath,
  quatEqualsApprox,
  quatExp,
  quatFixTrackContinuity,
  quatFromAngularVelocity,
  quatFromAxisAngle,
  quatInverse,
  quatIsNormalized,
  quatLog,
  quatMultiply,
  quatNlerp,
  quatPow,
  quatSlerp,
  quatSquad,
  quatSquadTangent,
  quatToAxisAngle,
} from "../src/animation/quaternion.js";

const ID = { w: 1, x: 0, y: 0, z: 0 };
const QX90 = quatFromAxisAngle({ x: 1, y: 0, z: 0 }, Math.PI / 2);
const QY90 = quatFromAxisAngle({ x: 0, y: 1, z: 0 }, Math.PI / 2);

describe("Task 1.2 — quaternion math library", () => {
  it("slerp hits both endpoints and the midpoint", () => {
    expect(quatEqualsApprox(quatSlerp(QX90, QY90, 0), QX90)).toBe(true);
    expect(quatEqualsApprox(quatSlerp(QX90, QY90, 1), QY90)).toBe(true);
    const mid = quatSlerp(ID, QX90, 0.5);
    const expected = quatFromAxisAngle({ x: 1, y: 0, z: 0 }, Math.PI / 4);
    expect(quatEqualsApprox(mid, expected, 1e-5)).toBe(true);
  });

  it("slerp is degenerate-safe for identical and antipodal inputs", () => {
    expect(quatEqualsApprox(quatSlerp(QX90, QX90, 0.37), QX90)).toBe(true);
    const anti = { w: -QX90.w, x: -QX90.x, y: -QX90.y, z: -QX90.z };
    expect(quatAngleDegBetween(QX90, anti)).toBeCloseTo(0, 6);
    expect(quatEqualsApprox(quatSlerp(QX90, anti, 0.5), QX90)).toBe(true);
  });

  it("slerp sweeps the angle monotonically", () => {
    const total = quatAngleBetween(ID, QY90);
    let prev = 0;
    for (const t of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      const swept = quatAngleBetween(ID, quatSlerp(ID, QY90, t));
      expect(swept).toBeGreaterThan(prev);
      expect(swept).toBeCloseTo(total * t, 5);
      prev = swept;
    }
  });

  it("nlerp agrees with slerp on small angles", () => {
    const small = quatFromAxisAngle({ x: 0, y: 1, z: 0 }, 0.05);
    expect(quatAngleDegBetween(quatNlerp(ID, small, 0.5), quatSlerp(ID, small, 0.5))).toBeLessThan(0.01);
    expect(quatIsNormalized(quatNlerp(QX90, QY90, 0.3))).toBe(true);
  });

  it("squad passes through its endpoints", () => {
    const a = ID;
    const b = QX90;
    const c = QY90;
    const tanA = quatSquadTangent(ID, a, b);
    const tanB = quatSquadTangent(a, b, c);
    expect(quatIsNormalized(tanA)).toBe(true);
    expect(quatIsNormalized(tanB)).toBe(true);
    expect(quatEqualsApprox(quatSquad(a, tanA, tanB, b, 0), a)).toBe(true);
    expect(quatEqualsApprox(quatSquad(a, tanA, tanB, b, 1), b)).toBe(true);
    const mid = quatSquad(a, tanA, tanB, b, 0.5);
    expect(quatIsNormalized(mid)).toBe(true);
    expect(quatAngleDegBetween(a, mid)).toBeGreaterThan(0);
    expect(quatAngleDegBetween(mid, b)).toBeGreaterThan(0);
  });

  it("log/exp and pow round-trip", () => {
    const back = quatExp(quatLog(QX90));
    expect(quatEqualsApprox(back, QX90, 1e-6)).toBe(true);
    expect(quatEqualsApprox(quatPow(QX90, 0), ID, 1e-6)).toBe(true);
    expect(quatEqualsApprox(quatPow(QX90, 1), QX90, 1e-6)).toBe(true);
    expect(quatEqualsApprox(quatPow(QX90, 0.5), quatSlerp(ID, QX90, 0.5), 1e-5)).toBe(true);
  });

  it("axis-angle converts losslessly", () => {
    const { axis, angleRad } = quatToAxisAngle(QY90);
    expect(angleRad).toBeCloseTo(Math.PI / 2, 6);
    expect(Math.hypot(axis.x, axis.y, axis.z)).toBeCloseTo(1, 6);
    expect(Math.abs(axis.y)).toBeCloseTo(1, 6);
    expect(quatEqualsApprox(quatFromAxisAngle(axis, angleRad), QY90, 1e-6)).toBe(true);
    expect(quatFromAxisAngle({ x: 0, y: 0, z: 0 }, 1)).toMatchObject(ID);
  });

  it("measures angular velocity and integrates it back", () => {
    const omega = quatAngularVelocity(ID, QX90, 0.5);
    expect(Math.hypot(omega.x, omega.y, omega.z)).toBeCloseTo(180, 4);
    expect(Math.abs(omega.x)).toBeCloseTo(180, 4);
    const dq = quatFromAngularVelocity(omega, 0.5);
    expect(quatEqualsApprox(dq, QX90, 1e-4)).toBe(true);
    expect(quatAngularVelocity(ID, ID, 1)).toMatchObject({ x: 0, y: 0, z: 0 });
    expect(quatAngularVelocity(ID, QX90, 0)).toMatchObject({ x: 0, y: 0, z: 0 });
  });

  it("inverse undoes composition", () => {
    const fwd = quatMultiply(QX90, QY90);
    const back = quatMultiply(quatInverse(QY90), quatInverse(QX90));
    expect(quatEqualsApprox(quatMultiply(fwd, back), ID, 1e-5)).toBe(true);
    expect(quatEqualsApprox(quatMultiply(QX90, quatInverse(QX90)), ID, 1e-6)).toBe(true);
    expect(quatDot(QX90, quatConjugate(QX90))).toBeCloseTo(
      QX90.w * QX90.w - QX90.x * QX90.x - QX90.y * QX90.y - QX90.z * QX90.z,
      6,
    );
  });

  it("keeps quaternion tracks continuous across sign flips", () => {
    const flipped = quatEnsureShortestPath(QX90, {
      w: -QY90.w, x: -QY90.x, y: -QY90.y, z: -QY90.z,
    });
    expect(quatDot(QX90, flipped)).toBeGreaterThan(0);
    const track = [ID, { ...QX90 }, { w: -QY90.w, x: -QY90.x, y: -QY90.y, z: -QY90.z }];
    const fixed = quatFixTrackContinuity(track);
    expect(fixed).toHaveLength(3);
    for (let i = 1; i < fixed.length; i += 1) {
      expect(quatDot(fixed[i - 1], fixed[i])).toBeGreaterThanOrEqual(0);
    }
    expect(track[2].w).toBeLessThan(0);
  });

  it("stays consistent with the shared Euler convention", () => {
    const e = { x: -30, y: 10, z: 20 };
    const q = eulerDegToQuat(e);
    expect(quatIsNormalized(q)).toBe(true);
    expect(quatAngleDegBetween(q, quatSlerp(q, q, 0.5))).toBeCloseTo(0, 6);
  });
});
