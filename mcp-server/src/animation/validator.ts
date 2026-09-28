/**
 * RoLink motion validator — joint limits (Task 4.5) + kinematics (Phase 5).
 *
 * RULE: the validator REPORTS; it never clamps, rewrites, or "fixes"
 * anything. Every violation carries joint, time, measured value, limit,
 * and a suggested fix for the repair loop (Phase 8) to approve. Silent
 * clamping would fake success — the exact failure mode this engine
 * exists to eliminate.
 *
 * Thresholds are STYLE-DEPENDENT (Task 5.3): anime snap that passes
 * would fail a realistic profile. Profiles live in shared/
 * animationProtocol.ts (DEFAULT_STYLE_PROFILES).
 */

import type {
  DefectCode,
  JointLimit,
  PoseKeyframe,
  SemanticRole,
  StyleKind,
  Transform3D,
  ValidationIssue,
  Vec3,
} from "../../../shared/animationProtocol.js";
import {
  DEFAULT_STYLE_PROFILES,
  quatToEulerDeg,
} from "../../../shared/animationProtocol.js";
import {
  quatAngularVelocity,
  quatInverse,
  quatMultiply,
  quatNormalize,
} from "./quaternion.js";
import type { JointBinding } from "./jointAdapter.js";
import { wordsOf } from "./semanticRig.js";

export interface AxisRange {
  min: number;
  max: number;
}

export interface RoleLimitTemplate {
  x?: AxisRange;
  y?: AxisRange;
  z?: AxisRange;
}

/**
 * Approximate safe ranges in rest-relative DEGREES. Inferred defaults —
 * per-rig calibration overrides them via explicit JointLimit entries.
 * Sources: standard humanoid joint ranges (elbow 0–145° flexion,
 * knee 0–150°, neck ±80° yaw); hinge/slider/mechanical stay unconstrained
 * until measured because their axes are rig-specific.
 */
export const ROLE_LIMIT_TEMPLATES: Record<string, RoleLimitTemplate> = {
  neck: { x: { min: -60, max: 60 }, y: { min: -80, max: 80 }, z: { min: -45, max: 45 } },
  head: { x: { min: -50, max: 50 }, y: { min: -70, max: 70 }, z: { min: -40, max: 40 } },
  spine: { x: { min: -30, max: 30 }, y: { min: -25, max: 25 }, z: { min: -20, max: 20 } },
  chest: { x: { min: -30, max: 30 }, y: { min: -25, max: 25 }, z: { min: -20, max: 20 } },
  shoulder: { x: { min: -100, max: 100 }, y: { min: -100, max: 100 }, z: { min: -100, max: 100 } },
  hip: { x: { min: -100, max: 100 }, y: { min: -100, max: 100 }, z: { min: -100, max: 100 } },
  elbow: { x: { min: -5, max: 145 }, y: { min: -15, max: 15 }, z: { min: -15, max: 15 } },
  knee: { x: { min: -5, max: 150 }, y: { min: -15, max: 15 }, z: { min: -15, max: 15 } },
  wrist: { x: { min: -45, max: 45 }, y: { min: -45, max: 45 }, z: { min: -45, max: 45 } },
  ankle: { x: { min: -45, max: 45 }, y: { min: -45, max: 45 }, z: { min: -45, max: 45 } },
};

const LIMB_SUBROLE_WORDS: Record<string, string[]> = {
  shoulder: ["shoulder"],
  elbow: ["elbow"],
  wrist: ["wrist"],
  hip: ["hip"],
  knee: ["knee"],
  ankle: ["ankle"],
};

function limbSubrole(name: string): string | undefined {
  const words = wordsOf(name);
  for (const [sub, tokens] of Object.entries(LIMB_SUBROLE_WORDS)) {
    if (words.some((w) => tokens.includes(w))) return sub;
  }
  return undefined;
}

/**
 * Infer an approximate JointLimit for one joint, or undefined when the
 * joint is unconstrained by default (roots, hinges, sliders, mechanical
 * parts, unknown hardware). Undefined means "validator skips", never
 * "validator assumes zero".
 */
export function inferJointLimit(
  name: string,
  role: SemanticRole,
  kind: JointBinding["kind"],
): JointLimit | undefined {
  if (kind === "Weld" || kind === "Custom") return undefined;
  if (role === "root" || role === "locomotionRoot") return undefined;
  if (role === "hinge" || role === "slider" || role === "mechanical") return undefined;
  if (role === "follow" || role === "rigid" || role === "decorative" || role === "unknown") {
    return undefined;
  }
  let template = ROLE_LIMIT_TEMPLATES[role];
  if (role === "limb" || role === "hand" || role === "foot" || role === "endEffector") {
    const sub = limbSubrole(name);
    if (!sub) return undefined;
    template = ROLE_LIMIT_TEMPLATES[sub];
  }
  if (!template) return undefined;
  const limit: JointLimit = { joint: name };
  if (template.x) limit.minDeg = { ...(limit.minDeg ?? { x: 0, y: 0, z: 0 }), x: template.x.min };
  if (template.y) limit.minDeg = { ...(limit.minDeg ?? { x: 0, y: 0, z: 0 }), y: template.y.min };
  if (template.z) limit.minDeg = { ...(limit.minDeg ?? { x: 0, y: 0, z: 0 }), z: template.z.min };
  if (template.x) limit.maxDeg = { ...(limit.maxDeg ?? { x: 0, y: 0, z: 0 }), x: template.x.max };
  if (template.y) limit.maxDeg = { ...(limit.maxDeg ?? { x: 0, y: 0, z: 0 }), y: template.y.max };
  if (template.z) limit.maxDeg = { ...(limit.maxDeg ?? { x: 0, y: 0, z: 0 }), z: template.z.max };
  return limit;
}

export function inferJointLimits(
  bindings: JointBinding[],
  roles: Map<string, SemanticRole> | Record<string, SemanticRole>,
): JointLimit[] {
  const get = (n: string): SemanticRole => {
    if (roles instanceof Map) return roles.get(n) ?? "unknown";
    return roles[n] ?? "unknown";
  };
  const out: JointLimit[] = [];
  for (const b of bindings) {
    const limit = inferJointLimit(b.name, get(b.name), b.kind);
    if (limit) out.push(limit);
  }
  return out;
}

export interface LimitCheckInput {
  joint: string;
  keys: PoseKeyframe[];
}

function restRelativeEuler(
  rest: Transform3D | undefined,
  rotation: { w: number; x: number; y: number; z: number },
): { x: number; y: number; z: number } | undefined {
  // Finiteness is checked BEFORE any normalization: the solver's defensive
  // normalize would otherwise launder NaN into identity and hide corruption.
  if (![rotation.w, rotation.x, rotation.y, rotation.z].every(Number.isFinite)) {
    return undefined;
  }
  const q = quatNormalize(rotation);
  const base = rest ? quatNormalize(rest.rotation) : { w: 1, x: 0, y: 0, z: 0 };
  const rel = quatMultiply(quatInverse(base), q);
  const e = quatToEulerDeg(rel);
  if (![e.x, e.y, e.z].every(Number.isFinite)) return undefined;
  return e;
}

/**
 * Check tracks against limits. Returns issues only — inputs are never
 * mutated (callers asserting immutability pin the no-silent-clamp rule).
 */
export function validateJointLimits(
  tracks: LimitCheckInput[],
  limits: JointLimit[],
  rests?: Record<string, Transform3D>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const byJoint = new Map(limits.map((l) => [l.joint, l]));
  for (const track of tracks) {
    const limit = byJoint.get(track.joint);
    if (!limit) continue;
    const rest = rests?.[track.joint];
    const sorted = [...track.keys].sort((a, b) => a.t - b.t);
    for (const k of sorted) {
      const e = restRelativeEuler(rest, k.pose.rotation);
      if (!e) {
        issues.push({
          code: "IMPOSSIBLE_ROTATION",
          category: "STRUCTURE",
          severity: "error",
          joint: track.joint,
          t: k.t,
          message: `joint "${track.joint}" has a non-finite rotation at t=${k.t}`,
          suggestedFix: `replace the key at t=${k.t} with a normalized quaternion`,
        });
        continue;
      }
      const axes = [
        { axis: "x" as const, value: e.x, min: limit.minDeg?.x, max: limit.maxDeg?.x },
        { axis: "y" as const, value: e.y, min: limit.minDeg?.y, max: limit.maxDeg?.y },
        { axis: "z" as const, value: e.z, min: limit.minDeg?.z, max: limit.maxDeg?.z },
      ];
      for (const { axis, value, min, max } of axes) {
        if (min === undefined || max === undefined) continue;
        if (value < min - 1e-6 || value > max + 1e-6) {
          const over = value < (min ?? 0)
            ? ((min ?? 0) - value) / Math.max(1, Math.abs((min ?? 0)))
            : (value - (max ?? 0)) / Math.max(1, Math.abs((max ?? 0)));
          const code: DefectCode = over > 0.25 ? "OVEREXTENSION" : "JOINT_LIMIT";
          const bound = value < (min ?? 0) ? min : max;
          issues.push({
            code,
            category: "STRUCTURE",
            severity: "error",
            joint: track.joint,
            t: k.t,
            message:
              `joint "${track.joint}" ${axis}-rotation ${value.toFixed(1)}° at t=${k.t} ` +
              `exceeds [${min}, ${max}]°`,
            measured: value,
            threshold: bound,
            suggestedFix:
              `clamp ${axis}-rotation of "${track.joint}" at t=${k.t} into [${min}, ${max}]° ` +
              `and re-validate`,
          });
        }
      }
    }
  }
  return issues;
}

// ── Kinematics: velocity / acceleration / jerk (Tasks 5.1–5.3) ─────────────

export interface KinematicSample {
  t: number;
  pos: Vec3;
  vel: Vec3;
  acc: Vec3;
  jerk: Vec3;
  angVel: Vec3;
  angAcc: Vec3;
}

export interface KinematicPeaks {
  peakSpeedStudPerSec: number;
  peakAccelStudPerSec2: number;
  peakJerkStudPerSec3: number;
  peakAngularSpeedDegPerSec: number;
}

function vecLen(v: Vec3): number {
  return Math.hypot(v.x, v.y, v.z);
}

function vecSub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function vecScale(v: Vec3, s: number): Vec3 {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}

function vecAdd(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

/**
 * Per-joint kinematics from baked keys. Derivatives use central
 * differences (non-uniform-dt aware); endpoints are one-sided. Angular
 * velocity reuses the quaternion solver primitive (deg/sec axis-angle);
 * angular acceleration/jerk differentiate that series.
 */
export function computeKinematics(keys: PoseKeyframe[]): KinematicSample[] {
  const sorted = [...keys].sort((a, b) => a.t - b.t);
  const n = sorted.length;
  if (n === 0) return [];
  const pos = (i: number): Vec3 => ({ ...sorted[i].pose.position });
  const velAt = (i: number): Vec3 => {
    if (n === 1) return { x: 0, y: 0, z: 0 };
    if (i === 0) {
      const dt = sorted[1].t - sorted[0].t;
      return dt > 1e-9 ? vecScale(vecSub(pos(1), pos(0)), 1 / dt) : { x: 0, y: 0, z: 0 };
    }
    if (i === n - 1) {
      const dt = sorted[n - 1].t - sorted[n - 2].t;
      return dt > 1e-9 ? vecScale(vecSub(pos(n - 1), pos(n - 2)), 1 / dt) : { x: 0, y: 0, z: 0 };
    }
    const h0 = sorted[i].t - sorted[i - 1].t;
    const h1 = sorted[i + 1].t - sorted[i].t;
    if (h0 < 1e-9 || h1 < 1e-9) return { x: 0, y: 0, z: 0 };
    const d0 = vecScale(vecSub(pos(i), pos(i - 1)), 1 / h0);
    const d1 = vecScale(vecSub(pos(i + 1), pos(i)), 1 / h1);
    return vecScale(vecAdd(d0, d1), 0.5);
  };
  const vels = sorted.map((_, i) => velAt(i));
  const accAt = (i: number): Vec3 => {
    if (n === 1) return { x: 0, y: 0, z: 0 };
    if (i === 0 || i === n - 1) {
      const j = i === 0 ? 1 : n - 1;
      const dt = Math.abs(sorted[j].t - sorted[i].t);
      return dt > 1e-9 ? vecScale(vecSub(vels[j], vels[i]), 1 / dt) : { x: 0, y: 0, z: 0 };
    }
    const h0 = sorted[i].t - sorted[i - 1].t;
    const h1 = sorted[i + 1].t - sorted[i].t;
    if (h0 < 1e-9 || h1 < 1e-9) return { x: 0, y: 0, z: 0 };
    const d0 = vecScale(vecSub(vels[i], vels[i - 1]), 1 / h0);
    const d1 = vecScale(vecSub(vels[i + 1], vels[i]), 1 / h1);
    return vecScale(vecAdd(d0, d1), 0.5);
  };
  const accs = sorted.map((_, i) => accAt(i));
  const jerkAt = (i: number): Vec3 => {
    if (n <= 2) return { x: 0, y: 0, z: 0 };
    if (i === 0 || i === n - 1) {
      const j = i === 0 ? 1 : n - 1;
      const dt = Math.abs(sorted[j].t - sorted[i].t);
      return dt > 1e-9 ? vecScale(vecSub(accs[j], accs[i]), 1 / dt) : { x: 0, y: 0, z: 0 };
    }
    const h0 = sorted[i].t - sorted[i - 1].t;
    const h1 = sorted[i + 1].t - sorted[i].t;
    if (h0 < 1e-9 || h1 < 1e-9) return { x: 0, y: 0, z: 0 };
    const d0 = vecScale(vecSub(accs[i], accs[i - 1]), 1 / h0);
    const d1 = vecScale(vecSub(accs[i + 1], accs[i]), 1 / h1);
    return vecScale(vecAdd(d0, d1), 0.5);
  };
  const angVelAt = (i: number): Vec3 => {
    if (n === 1) return { x: 0, y: 0, z: 0 };
    if (i === n - 1) {
      const dt = sorted[n - 1].t - sorted[n - 2].t;
      return quatAngularVelocity(sorted[n - 2].pose.rotation, sorted[n - 1].pose.rotation, dt);
    }
    const dt = sorted[i + 1].t - sorted[i].t;
    return quatAngularVelocity(sorted[i].pose.rotation, sorted[i + 1].pose.rotation, dt);
  };
  const angVels = sorted.map((_, i) => angVelAt(i));
  const angAccAt = (i: number): Vec3 => {
    if (n === 1) return { x: 0, y: 0, z: 0 };
    if (i === 0 || i === n - 1) {
      const j = i === 0 ? 1 : n - 1;
      const dt = Math.abs(sorted[j].t - sorted[i].t);
      return dt > 1e-9 ? vecScale(vecSub(angVels[j], angVels[i]), 1 / dt) : { x: 0, y: 0, z: 0 };
    }
    return vecScale(vecSub(angVels[i + 1], angVels[i - 1]), 1 / (sorted[i + 1].t - sorted[i - 1].t || 1));
  };
  return sorted.map((k, i) => ({
    t: k.t,
    pos: pos(i),
    vel: vels[i],
    acc: accs[i],
    jerk: jerkAt(i),
    angVel: angVels[i],
    angAcc: angAccAt(i),
  }));
}

export function kinematicPeaks(samples: KinematicSample[]): KinematicPeaks {
  let peakSpeed = 0;
  let peakAccel = 0;
  let peakJerk = 0;
  let peakAng = 0;
  for (const s of samples) {
    peakSpeed = Math.max(peakSpeed, vecLen(s.vel));
    peakAccel = Math.max(peakAccel, vecLen(s.acc));
    peakJerk = Math.max(peakJerk, vecLen(s.jerk));
    peakAng = Math.max(peakAng, vecLen(s.angVel));
  }
  return {
    peakSpeedStudPerSec: peakSpeed,
    peakAccelStudPerSec2: peakAccel,
    peakJerkStudPerSec3: peakJerk,
    peakAngularSpeedDegPerSec: peakAng,
  };
}

export interface KinematicTrackInput {
  joint: string;
  keys: PoseKeyframe[];
}

/**
 * Spike + discontinuity analysis against a style profile. Identical motion
 * can pass ANIME and fail REALISTIC — that is the point (Task 5.3).
 */
export function analyzeKinematics(
  tracks: KinematicTrackInput[],
  style: StyleKind,
): ValidationIssue[] {
  const profile = DEFAULT_STYLE_PROFILES[style] ?? DEFAULT_STYLE_PROFILES.REALISTIC;
  const th = profile.thresholds;
  const issues: ValidationIssue[] = [];
  for (const track of tracks) {
    const sorted = [...track.keys].sort((a, b) => a.t - b.t);
    for (const k of sorted) {
      const p = k.pose.position;
      if (![p.x, p.y, p.z].every(Number.isFinite)) {
        issues.push({
          code: "IMPOSSIBLE_ROTATION",
          category: "KINEMATICS",
          severity: "error",
          joint: track.joint,
          t: k.t,
          message: `joint "${track.joint}" has a non-finite position at t=${k.t}`,
          suggestedFix: `replace the key at t=${k.t} with finite coordinates`,
        });
      }
    }
    if (sorted.length < 2) continue;
    const samples = computeKinematics(sorted);
    // Segment speeds: central differences average neighbors away, so a
    // fast segment between static holds would read half speed. The
    // segment suffering is the honest motion measure — check it directly.
    for (let i = 0; i + 1 < sorted.length; i += 1) {
      const dt = sorted[i + 1].t - sorted[i].t;
      if (dt < 1e-9) continue;
      const segSpeed = vecLen(vecSub(sorted[i + 1].pose.position, sorted[i].pose.position)) / dt;
      if (segSpeed > th.maxSpeedStudPerSec) {
        issues.push({
          code: "SPEED_SPIKE",
          category: "KINEMATICS",
          severity: "error",
          joint: track.joint,
          t: sorted[i + 1].t,
          message:
            `joint "${track.joint}" covers ${vecLen(vecSub(sorted[i + 1].pose.position, sorted[i].pose.position)).toFixed(2)} studs ` +
            `in ${dt.toFixed(3)}s (${segSpeed.toFixed(1)} st/s) at t=${sorted[i + 1].t}, ` +
            `exceeds ${style} limit ${th.maxSpeedStudPerSec}`,
          measured: segSpeed,
          threshold: th.maxSpeedStudPerSec,
          suggestedFix: `retime the segment ending at t=${sorted[i + 1].t} or ease the keys (style ${style})`,
        });
      }
      const segAng = vecLen(
        quatAngularVelocity(sorted[i].pose.rotation, sorted[i + 1].pose.rotation, dt),
      );
      if (segAng > th.maxAngularSpeedDegPerSec) {
        issues.push({
          code: "SPEED_SPIKE",
          category: "KINEMATICS",
          severity: "error",
          joint: track.joint,
          t: sorted[i + 1].t,
          message:
            `joint "${track.joint}" rotates ${segAng.toFixed(1)}°/s across t=${sorted[i].t}→${sorted[i + 1].t}, ` +
            `exceeds ${style} limit ${th.maxAngularSpeedDegPerSec}°/s`,
          measured: segAng,
          threshold: th.maxAngularSpeedDegPerSec,
          suggestedFix: `spread the rotation of "${track.joint}" over more keys near t=${sorted[i + 1].t}`,
        });
      }
    }
    for (let i = 0; i < samples.length; i += 1) {
      const s = samples[i];
      const speed = vecLen(s.vel);
      const accel = vecLen(s.acc);
      const jerk = vecLen(s.jerk);
      const angSpeed = vecLen(s.angVel);
      if (speed > th.maxSpeedStudPerSec) {
        issues.push({
          code: "SPEED_SPIKE",
          category: "KINEMATICS",
          severity: "error",
          joint: track.joint,
          t: s.t,
          message:
            `joint "${track.joint}" speed ${speed.toFixed(1)} st/s at t=${s.t} ` +
            `exceeds ${style} limit ${th.maxSpeedStudPerSec}`,
          measured: speed,
          threshold: th.maxSpeedStudPerSec,
          suggestedFix: `retime the segment around t=${s.t} or ease the keys (style ${style})`,
        });
      }
      if (accel > th.maxAccelStudPerSec2) {
        issues.push({
          code: "ACCELERATION_SPIKE",
          category: "KINEMATICS",
          severity: "error",
          joint: track.joint,
          t: s.t,
          message:
            `joint "${track.joint}" acceleration ${accel.toFixed(1)} st/s² at t=${s.t} ` +
            `exceeds ${style} limit ${th.maxAccelStudPerSec2}`,
          measured: accel,
          threshold: th.maxAccelStudPerSec2,
          suggestedFix: `smooth the keys around t=${s.t} (wider easing, extra in-between)`,
        });
      }
      if (jerk > th.maxJerkStudPerSec3) {
        issues.push({
          code: "JERK_SPIKE",
          category: "KINEMATICS",
          severity: "error",
          joint: track.joint,
          t: s.t,
          message:
            `joint "${track.joint}" jerk ${jerk.toFixed(1)} st/s³ at t=${s.t} ` +
            `exceeds ${style} limit ${th.maxJerkStudPerSec3}`,
          measured: jerk,
          threshold: th.maxJerkStudPerSec3,
          suggestedFix: `soften the transition at t=${s.t} (squad interpolation, arc lift)`,
        });
      }
      if (angSpeed > th.maxAngularSpeedDegPerSec) {
        issues.push({
          code: "SPEED_SPIKE",
          category: "KINEMATICS",
          severity: "error",
          joint: track.joint,
          t: s.t,
          message:
            `joint "${track.joint}" angular speed ${angSpeed.toFixed(1)}°/s at t=${s.t} ` +
            `exceeds ${style} limit ${th.maxAngularSpeedDegPerSec}°/s`,
          measured: angSpeed,
          threshold: th.maxAngularSpeedDegPerSec,
          suggestedFix: `spread the rotation of "${track.joint}" over more keys near t=${s.t}`,
        });
      }
      // Teleport check: a single step covering far more than the local
      // speed profile allows is a discontinuity, not fast motion. Two
      // shapes: out-and-back pops (local profile stays calm) and absurd
      // sustained jumps (fast even against the style ceiling).
      if (i + 1 < samples.length) {
        const dt = samples[i + 1].t - s.t;
        const step = vecLen(vecSub(samples[i + 1].pos, s.pos));
        const expected = speed * dt;
        const absurd = dt > 1e-9 && step > 10 && step / dt > 8 * th.maxSpeedStudPerSec;
        if ((dt > 1e-9 && step > Math.max(0.5, expected * 4 + 0.25)) || absurd) {
          issues.push({
            code: "DISCONTINUITY",
            category: "KINEMATICS",
            severity: "error",
            joint: track.joint,
            t: samples[i + 1].t,
            message:
              `joint "${track.joint}" jumps ${step.toFixed(2)} studs between t=${s.t} and ` +
              `t=${samples[i + 1].t} (local speed profile allows ~${expected.toFixed(2)})`,
            measured: step,
            threshold: expected,
            suggestedFix: `insert in-between keys or fix the keyframe at t=${samples[i + 1].t}`,
          });
        }
      }
    }
  }
  return issues;
}
