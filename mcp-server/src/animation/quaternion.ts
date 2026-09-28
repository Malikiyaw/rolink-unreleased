/**
 * RoLink quaternion math library — Task 1.2.
 *
 * Solver-grade rotation operations for the Animation Engine. Boundary
 * conversions (Euler degrees ⇄ quaternion) live in shared/animationProtocol.ts
 * and are re-exported here so solvers have a single import; they are NOT
 * reimplemented (one source of truth for the XYZ convention).
 *
 * Conventions (must match shared/animationProtocol.ts):
 *  - w-first Hamilton quaternions; all inputs are normalized defensively.
 *  - Composition q = a ⊗ b applies b first (column-vector convention).
 *  - EulerDegrees are intrinsic XYZ (Tait-Bryan).
 *  - Angular velocities are Vec3 axis-angle vectors in DEGREES/second,
 *    matching JointPose.angularVelocity in the shared IR.
 */

import type { EulerDegrees, Quaternion, Vec3 } from "../../../shared/animationProtocol.js";
import { quatMultiply, quatNormalize } from "../../../shared/animationProtocol.js";

export type { EulerDegrees, Quaternion, Vec3 } from "../../../shared/animationProtocol.js";
export {
  eulerDegToQuat,
  makeQuaternionIdentity,
  quatMultiply,
  quatNormalize,
  quatToEulerDeg,
} from "../../../shared/animationProtocol.js";

const RAD2DEG = 180 / Math.PI;
const DEG2RAD = Math.PI / 180;

function clamp1(x: number): number {
  return x < -1 ? -1 : x > 1 ? 1 : x;
}

function vecScale(v: Vec3, s: number): Vec3 {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}

function vecAdd(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function vecLength(v: Vec3): number {
  return Math.hypot(v.x, v.y, v.z);
}

export function quatDot(a: Quaternion, b: Quaternion): number {
  return a.w * b.w + a.x * b.x + a.y * b.y + a.z * b.z;
}

export function quatNegate(q: Quaternion): Quaternion {
  return { w: -q.w, x: -q.x, y: -q.y, z: -q.z };
}

export function quatConjugate(q: Quaternion): Quaternion {
  return { w: q.w, x: -q.x, y: -q.y, z: -q.z };
}

/** Inverse rotation. Inputs are normalized defensively, so conjugate suffices. */
export function quatInverse(q: Quaternion): Quaternion {
  return quatConjugate(quatNormalize(q));
}

export function quatEqualsApprox(a: Quaternion, b: Quaternion, tol = 1e-6): boolean {
  const na = quatNormalize(a);
  const nb = quatNormalize(b);
  const d = Math.abs(quatDot(na, nb));
  return 1 - d <= tol;
}

/** True when |q| is within tol of 1. */
export function quatIsNormalized(q: Quaternion, tol = 1e-3): boolean {
  const len = Math.hypot(q.w, q.x, q.y, q.z);
  return Math.abs(len - 1) <= tol;
}

/**
 * Shortest-path angular distance between two rotations, in radians.
 * Antipodal quaternions (q and -q) encode the same rotation → distance 0.
 */
export function quatAngleBetween(a: Quaternion, b: Quaternion): number {
  const d = clamp1(Math.abs(quatDot(quatNormalize(a), quatNormalize(b))));
  return 2 * Math.acos(d);
}

export function quatAngleDegBetween(a: Quaternion, b: Quaternion): number {
  return quatAngleBetween(a, b) * RAD2DEG;
}

function quatLerpRaw(a: Quaternion, b: Quaternion, t: number): Quaternion {
  return quatNormalize({
    w: a.w + (b.w - a.w) * t,
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
  });
}

/**
 * Normalized lerp — cheaper than slerp, fine for small angles.
 * Takes the shortest path (flips b when dot < 0).
 */
export function quatNlerp(a: Quaternion, b: Quaternion, t: number): Quaternion {
  const na = quatNormalize(a);
  let nb = quatNormalize(b);
  if (quatDot(na, nb) < 0) nb = quatNegate(nb);
  return quatLerpRaw(na, nb, t);
}

/**
 * Spherical linear interpolation with shortest-path handling.
 * Falls back to nlerp when the inputs are near-identical (avoids div-by-zero).
 */
export function quatSlerp(a: Quaternion, b: Quaternion, t: number): Quaternion {
  const na = quatNormalize(a);
  let nb = quatNormalize(b);
  let dot = quatDot(na, nb);
  if (dot < 0) {
    dot = -dot;
    nb = quatNegate(nb);
  }
  if (dot > 0.9995) return quatLerpRaw(na, nb, t);
  const theta0 = Math.acos(clamp1(dot));
  const sinTheta0 = Math.sin(theta0);
  const theta = theta0 * t;
  const s0 = Math.cos(theta) - dot * (Math.sin(theta) / sinTheta0);
  const s1 = Math.sin(theta) / sinTheta0;
  return quatNormalize({
    w: na.w * s0 + nb.w * s1,
    x: na.x * s0 + nb.x * s1,
    y: na.y * s0 + nb.y * s1,
    z: na.z * s0 + nb.z * s1,
  });
}

/** Log of a unit quaternion → rotation vector (axis * half-angle), radians. */
export function quatLog(q: Quaternion): Vec3 {
  const n = quatNormalize(q);
  const vLen = Math.hypot(n.x, n.y, n.z);
  if (vLen < 1e-12) return { x: 0, y: 0, z: 0 };
  const halfAngle = Math.atan2(vLen, n.w);
  const s = halfAngle / vLen;
  return { x: n.x * s, y: n.y * s, z: n.z * s };
}

/** Exp of a rotation vector → unit quaternion. Inverse of quatLog. */
export function quatExp(v: Vec3): Quaternion {
  const angle = vecLength(v);
  if (angle < 1e-12) return { w: 1, x: 0, y: 0, z: 0 };
  const s = Math.sin(angle) / angle;
  return quatNormalize({ w: Math.cos(angle), x: v.x * s, y: v.y * s, z: v.z * s });
}

/** q^t for a unit quaternion (t=0 → identity, t=1 → q). */
export function quatPow(q: Quaternion, t: number): Quaternion {
  return quatExp(vecScale(quatLog(q), t));
}

/**
 * Squad control point for the middle of (qPrev, q, qNext):
 *   s = q · exp(-(log(q⁻¹·qPrev) + log(q⁻¹·qNext)) / 4)
 */
export function quatSquadTangent(qPrev: Quaternion, q: Quaternion, qNext: Quaternion): Quaternion {
  const nq = quatNormalize(q);
  const inv = quatInverse(nq);
  const a = quatLog(quatMultiply(inv, qPrev));
  const b = quatLog(quatMultiply(inv, qNext));
  const sum = vecScale(vecAdd(a, b), -0.25);
  return quatMultiply(nq, quatExp(sum));
}

/**
 * Spherical quadrangle interpolation through (a → b) with tangents.
 * squad(a, tanA, tanB, b, 0) = a and (…, 1) = b exactly.
 */
export function quatSquad(
  a: Quaternion,
  tanA: Quaternion,
  tanB: Quaternion,
  b: Quaternion,
  t: number,
): Quaternion {
  const p = quatSlerp(a, b, t);
  const q = quatSlerp(tanA, tanB, t);
  return quatSlerp(p, q, 2 * t * (1 - t));
}

export function quatFromAxisAngle(axis: Vec3, angleRad: number): Quaternion {
  const len = vecLength(axis);
  if (len < 1e-12 || !Number.isFinite(angleRad)) return { w: 1, x: 0, y: 0, z: 0 };
  const half = angleRad / 2;
  const s = Math.sin(half) / len;
  return quatNormalize({ w: Math.cos(half), x: axis.x * s, y: axis.y * s, z: axis.z * s });
}

export function quatToAxisAngle(q: Quaternion): { axis: Vec3; angleRad: number } {
  const n = quatNormalize(q);
  const angleRad = 2 * Math.acos(clamp1(n.w));
  const s = Math.sqrt(Math.max(0, 1 - n.w * n.w));
  if (s < 1e-9) return { axis: { x: 1, y: 0, z: 0 }, angleRad: 0 };
  return { axis: { x: n.x / s, y: n.y / s, z: n.z / s }, angleRad };
}

/**
 * Average angular velocity taking q0 → q1 over dt seconds.
 * Returns an axis-angle vector in DEGREES/second (matches the shared IR).
 * dt <= 0 or a negligible rotation yields the zero vector.
 */
export function quatAngularVelocity(q0: Quaternion, q1: Quaternion, dtSec: number): Vec3 {
  if (!Number.isFinite(dtSec) || dtSec <= 0) return { x: 0, y: 0, z: 0 };
  const dq = quatMultiply(quatNormalize(q1), quatInverse(q0));
  const { axis, angleRad } = quatToAxisAngle(dq);
  if (angleRad < 1e-9) return { x: 0, y: 0, z: 0 };
  return vecScale(axis, (angleRad * RAD2DEG) / dtSec);
}

/**
 * Integrate a DEGREES/second axis-angle velocity over dt seconds
 * into a delta rotation. Inverse of quatAngularVelocity.
 */
export function quatFromAngularVelocity(omegaDegPerSec: Vec3, dtSec: number): Quaternion {
  if (!Number.isFinite(dtSec) || dtSec <= 0) return { w: 1, x: 0, y: 0, z: 0 };
  const angleDeg = vecLength(omegaDegPerSec) * dtSec;
  if (angleDeg < 1e-9) return { w: 1, x: 0, y: 0, z: 0 };
  return quatFromAxisAngle(omegaDegPerSec, angleDeg * DEG2RAD);
}

/**
 * Flip `next` when it is antipodal to `prev` so a keyframe sequence
 * never takes the long way around. Returns a (possibly negated) copy.
 */
export function quatEnsureShortestPath(prev: Quaternion, next: Quaternion): Quaternion {
  if (quatDot(prev, next) < 0) return quatNegate(next);
  return { ...next };
}

/**
 * Walk a quaternion track and flip signs for shortest-path continuity.
 * Pure (returns a new array); inputs are normalized defensively.
 */
export function quatFixTrackContinuity(track: Quaternion[]): Quaternion[] {
  const out: Quaternion[] = [];
  for (let i = 0; i < track.length; i += 1) {
    const n = quatNormalize(track[i]);
    if (i === 0) {
      out.push(n);
    } else {
      out.push(quatDot(out[i - 1], n) < 0 ? quatNegate(n) : n);
    }
  }
  return out;
}

/** Rotate a vector by a unit quaternion (defensively normalized). */
export function quatRotateVec(q: Quaternion, v: Vec3): Vec3 {
  const n = quatNormalize(q);
  const ux = n.x;
  const uy = n.y;
  const uz = n.z;
  // t = 2 * cross(u, v); v' = v + w*t + cross(u, t)
  const tx = 2 * (uy * v.z - uz * v.y);
  const ty = 2 * (uz * v.x - ux * v.z);
  const tz = 2 * (ux * v.y - uy * v.x);
  return {
    x: v.x + n.w * tx + (uy * tz - uz * ty),
    y: v.y + n.w * ty + (uz * tx - ux * tz),
    z: v.z + n.w * tz + (ux * ty - uy * tx),
  };
}

/**
 * Shortest-arc rotation taking unit vector u to unit vector v.
 * Antiparallel inputs pick a deterministic orthogonal axis.
 */
export function quatFromTo(u: Vec3, v: Vec3): Quaternion {
  const lu = Math.hypot(u.x, u.y, u.z);
  const lv = Math.hypot(v.x, v.y, v.z);
  if (lu < 1e-9 || lv < 1e-9) return { w: 1, x: 0, y: 0, z: 0 };
  const nu = { x: u.x / lu, y: u.y / lu, z: u.z / lu };
  const nv = { x: v.x / lv, y: v.y / lv, z: v.z / lv };
  const d = nu.x * nv.x + nu.y * nv.y + nu.z * nv.z;
  if (d > 1 - 1e-9) return { w: 1, x: 0, y: 0, z: 0 };
  if (d < -1 + 1e-9) {
    const ax = Math.abs(nu.x) <= Math.abs(nu.y) && Math.abs(nu.x) <= Math.abs(nu.z)
      ? { x: 1, y: 0, z: 0 }
      : Math.abs(nu.y) <= Math.abs(nu.z)
        ? { x: 0, y: 1, z: 0 }
        : { x: 0, y: 0, z: 1 };
    const cx = nu.y * ax.z - nu.z * ax.y;
    const cy = nu.z * ax.x - nu.x * ax.z;
    const cz = nu.x * ax.y - nu.y * ax.x;
    const l = Math.hypot(cx, cy, cz);
    return { w: 0, x: cx / l, y: cy / l, z: cz / l };
  }
  const cx = nu.y * nv.z - nu.z * nv.y;
  const cy = nu.z * nv.x - nu.x * nv.z;
  const cz = nu.x * nv.y - nu.y * nv.x;
  const w = 1 + d;
  const l = Math.hypot(w, cx, cy, cz);
  return { w: w / l, x: cx / l, y: cy / l, z: cz / l };
}
