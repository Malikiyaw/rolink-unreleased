/**
 * RoLink contact system — Tasks 4.3 + 4.4.
 *
 * Contacts lock a joint's WORLD position/orientation over a time window
 * (planted feet, hands on props, hips on chairs). The solver is rig
 * agnostic by design: world positions flow through injectable callbacks,
 * so the same code measures Studio-sampled data, FK models, or synthetic
 * test rigs — and the lock correction is pure translation math that the
 * Studio side (Contacts.lua) replays against live CFrames.
 *
 * A locked contact does NOT freeze the joint: it translates the joint's
 * LOCAL position each key so the world point holds while the rest of the
 * rig moves around it (downstream IK re-poses the limb in Phase 8 repair).
 */

import type { ContactSpec, PoseKeyframe, Vec3 } from "../../../shared/animationProtocol.js";
import { isContactSpec } from "../../../shared/animationProtocol.js";

export type WorldPositionFn = (joint: string, t: number) => Vec3 | undefined;

export interface ContactBreak {
  t: number;
  driftStud: number;
}

export interface ContactVerdict {
  spec: string;
  samples: number;
  maxDriftStud: number;
  breaks: ContactBreak[];
  /** True when every in-window sample holds within tolerance. */
  locked: boolean;
}

export interface LockReport {
  spec: string;
  keysAdjusted: number;
  maxDriftBeforeStud: number;
  maxDriftAfterStud: number;
  passes: number;
}

function vecSub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function vecLen(v: Vec3): number {
  return Math.hypot(v.x, v.y, v.z);
}

export function validateContactSpec(
  spec: unknown,
  jointNames?: string[],
): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!isContactSpec(spec)) {
    return { ok: false, errors: ["not a valid ContactSpec (see isContactSpec)"] };
  }
  if (jointNames && !jointNames.includes(spec.joint)) {
    errors.push(`contact "${spec.name}": joint "${spec.joint}" not in rig`);
  }
  if (spec.endTime - spec.startTime <= 0) {
    errors.push(`contact "${spec.name}": empty time window`);
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Measure how well a contact holds over its window. Keys outside
 * [startTime, endTime] are ignored; missing world samples are skipped
 * (counted, never treated as zero).
 */
export function detectContactBreak(
  spec: ContactSpec,
  keys: PoseKeyframe[],
  getWorldPos: WorldPositionFn,
): ContactVerdict {
  const breaks: ContactBreak[] = [];
  let samples = 0;
  let maxDrift = 0;
  const sorted = [...keys].sort((a, b) => a.t - b.t);
  for (const k of sorted) {
    if (k.t < spec.startTime - 1e-9 || k.t > spec.endTime + 1e-9) continue;
    const world = getWorldPos(spec.joint, k.t);
    if (!world) continue;
    samples += 1;
    const drift = vecLen(vecSub(world, spec.worldPosition));
    maxDrift = Math.max(maxDrift, drift);
    if (drift > spec.tolerance) breaks.push({ t: k.t, driftStud: drift });
  }
  return {
    spec: spec.name,
    samples,
    maxDriftStud: maxDrift,
    breaks,
    locked: samples > 0 && breaks.length === 0,
  };
}

/**
 * Iteratively correct local joint positions so the world contact holds.
 * getWorldPos reflects the CURRENT keys (callers re-derive per pass);
 * applyLocalShift(joint, t, deltaStud) must move the key's local position.
 * Returns the before/after drift for the proof envelope.
 */
export function solveContactLock(
  spec: ContactSpec,
  keys: PoseKeyframe[],
  getWorldPos: WorldPositionFn,
  applyLocalShift: (joint: string, t: number, delta: Vec3) => void,
  maxPasses = 3,
): LockReport {
  const before = detectContactBreak(spec, keys, getWorldPos);
  let passes = 0;
  const adjusted = new Set<number>();
  for (let pass = 0; pass < Math.min(Math.max(maxPasses, 1), 8); pass += 1) {
    passes += 1;
    const verdict = detectContactBreak(spec, keys, getWorldPos);
    if (verdict.locked) break;
    for (const b of verdict.breaks) {
      const world = getWorldPos(spec.joint, b.t);
      if (!world) continue;
      const delta = vecSub(spec.worldPosition, world);
      applyLocalShift(spec.joint, b.t, {
        x: delta.x * spec.stiffness,
        y: delta.y * spec.stiffness,
        z: delta.z * spec.stiffness,
      });
      adjusted.add(b.t);
    }
  }
  const after = detectContactBreak(spec, keys, getWorldPos);
  return {
    spec: spec.name,
    keysAdjusted: adjusted.size,
    maxDriftBeforeStud: before.maxDriftStud,
    maxDriftAfterStud: after.maxDriftStud,
    passes,
  };
}

/**
 * In-memory world-position source backed by per-joint key lists, for
 * tests and for FK-backed solvers: world(t) = local(t) + rigOffset.
 * Models a rigid assembly (translations only) — rotation-coupled rigs
 * supply their own WorldPositionFn.
 */
export function rigidWorldSource(
  tracks: Record<string, PoseKeyframe[]>,
  rigOffset?: Vec3,
): WorldPositionFn {
  const off = rigOffset ?? { x: 0, y: 0, z: 0 };
  return (joint, t) => {
    const keys = tracks[joint];
    if (!keys || keys.length === 0) return undefined;
    let best = keys[0];
    for (const k of keys) {
      if (Math.abs(k.t - t) < Math.abs(best.t - t)) best = k;
    }
    if (Math.abs(best.t - t) > 1e-6) return undefined;
    return {
      x: best.pose.position.x + off.x,
      y: best.pose.position.y + off.y,
      z: best.pose.position.z + off.z,
    };
  };
}
