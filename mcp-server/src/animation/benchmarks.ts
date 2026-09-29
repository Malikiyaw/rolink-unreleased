/**
 * RoLink Animation Engine benchmark suite — Task 11.2.
 *
 * Measures reproducible QUALITY metrics (not wall-clock, which is
 * machine-dependent): contact accuracy, loop continuity, velocity
 * continuity, and repair iterations across the full compile pipeline.
 * Every metric is deterministic for a given input, so these numbers
 * can gate regressions in CI exactly like unit assertions.
 *
 * Wall-clock timing lives in benchmarks.perf.ts (Task 11.3) and is
 * reported separately — never asserted, only printed.
 */

import type { ContactSpec, PoseKeyframe, StyleKind, Vec3 } from "../../../shared/animationProtocol.js";
import { makeJointPose, eulerDegToQuat } from "../../../shared/animationProtocol.js";
import { type AnalyzeNodeInput } from "./jointAdapter.js";
import { analyzeRig } from "./rigAnalyzer.js";
import { buildSemanticSkeleton } from "./semanticRig.js";
import { planMotion } from "./motionPlanner.js";
import { generateSparsePoses } from "./pose.js";
import { densifyKeys } from "./inbetween.js";
import { bakeTrackDense } from "./curves.js";
import { detectContactBreak, rigidWorldSource, solveContactLock } from "./contacts.js";
import { analyzeKinematics, computeKinematics } from "./validator.js";
import { compileAnimation } from "./compiler.js";

export interface BenchMetrics {
  contactMaxDriftStud: number;
  contactLocked: boolean;
  contactMeanDriftStud: number;
  loopPositionSeamStud: number;
  loopVelocitySeamRatio: number;
  peakSpeedStudPerSec: number;
  peakJerkStudPerSec3: number;
  velocityContinuity: number;
  repairIterations: number;
  totalErrors: number;
}

/**
 * Phase 11 exit criteria — the single source of truth for every quality
 * bound. Both tests/benchmarks.test.ts and tests/test_animation_bench.py
 * read these numbers rather than restating them, so a threshold change
 * cannot silently drift between the two layers.
 *
 * Headroom over the measured worst case is roughly 2x so these act as
 * regression tripwires, not as snapshot locks.
 */
export const BENCH_EXIT_CRITERIA = {
  /** Phase 4 contact criterion: post-solve drift must stay inside spec tolerance. */
  contactMaxDriftStud: 0.05,
  /** Wrap-around position gap on a looping pose track. */
  loopPositionSeamStud: 1.0,
  /**
   * Wrap-around velocity discontinuity / track peak speed. 2.0 is the
   * mathematical ceiling (|a-b| <= |a|+|b| <= 2*peak); 0.75 catches a real
   * seam pop without pinning a snapshot.
   */
  loopVelocitySeamRatio: 0.75,
  /** Runaway-motion ceilings, ~2x the worst measured style. */
  peakSpeedStudPerSec: 12,
  peakJerkStudPerSec3: 1200,
  /** Phase 8 repair budget: the compiler must converge inside its own cap. */
  repairIterations: 5,
} as const;

export type BenchExitKey = keyof typeof BENCH_EXIT_CRITERIA;

const RIG: AnalyzeNodeInput[] = [
  { path: "W.N", name: "N", class: "Model", kind: "root", depth: 0 },
  { path: "W.N.HumanoidRootPart", name: "HumanoidRootPart", class: "Part", kind: "rigid", depth: 1 },
  { path: "W.N.LowerTorso", name: "LowerTorso", class: "MeshPart", kind: "rigid", depth: 1 },
  { path: "W.N.UpperTorso", name: "UpperTorso", class: "MeshPart", kind: "rigid", depth: 1 },
  { path: "W.N.Head", name: "Head", class: "Part", kind: "rigid", depth: 1 },
  { path: "W.N.UpperTorso.Neck", name: "Neck", class: "Motor6D", kind: "rotational", depth: 2 },
  { path: "W.N.LeftUpperArm", name: "LeftUpperArm", class: "MeshPart", kind: "rigid", depth: 1 },
  { path: "W.N.UpperTorso.LeftShoulder", name: "LeftShoulder", class: "Motor6D", kind: "rotational", depth: 2 },
  { path: "W.N.LeftHand", name: "LeftHand", class: "MeshPart", kind: "rigid", depth: 1 },
  { path: "W.N.RightUpperArm", name: "RightUpperArm", class: "MeshPart", kind: "rigid", depth: 1 },
  { path: "W.N.UpperTorso.RightShoulder", name: "RightShoulder", class: "Motor6D", kind: "rotational", depth: 2 },
  { path: "W.N.RightHand", name: "RightHand", class: "MeshPart", kind: "rigid", depth: 1 },
  { path: "W.N.LeftUpperLeg", name: "LeftUpperLeg", class: "MeshPart", kind: "rigid", depth: 1 },
  { path: "W.N.LowerTorso.LeftHip", name: "LeftHip", class: "Motor6D", kind: "rotational", depth: 2 },
  { path: "W.N.LeftFoot", name: "LeftFoot", class: "MeshPart", kind: "rigid", depth: 1 },
  { path: "W.N.RightUpperLeg", name: "RightUpperLeg", class: "MeshPart", kind: "rigid", depth: 1 },
  { path: "W.N.LowerTorso.RightHip", name: "RightHip", class: "Motor6D", kind: "rotational", depth: 2 },
  { path: "W.N.RightFoot", name: "RightFoot", class: "MeshPart", kind: "rigid", depth: 1 },
];

export function buildFixture(style: StyleKind, duration = 1.2, fps = 30) {
  const { analysis, bindings } = analyzeRig("W.N", RIG);
  const skeleton = buildSemanticSkeleton(bindings);
  const plan = planMotion("bench strike", "W.N", style, duration);
  const generated = generateSparsePoses(bindings, skeleton, plan, { seed: 42, style });
  const tracks = generated.map((t) => ({
    joint: t.joint,
    jointKind: t.jointKind,
    semanticRole: t.semanticRole,
    keys: densifyKeys(t.keys, {}).keys,
  }));
  return { analysis, bindings, skeleton, plan, tracks, fps, style, duration };
}

function contactSpec(duration: number): ContactSpec {
  return {
    name: "RFootPlant",
    type: "FOOT",
    joint: "RightFoot",
    worldPosition: { x: 0, y: 0, z: 0 },
    startTime: 0.15 * duration,
    endTime: 0.6 * duration,
    stiffness: 1,
    tolerance: 0.05,
  };
}

/** Full metric sweep over one style. Deterministic given (style, duration). */
export function benchmarkStyle(style: StyleKind, duration = 1.2, fps = 30): BenchMetrics {
  const fx = buildFixture(style, duration, fps);
  const roles = new Map(fx.skeleton.joints.map((j) => [j.name, j.semanticRole]));

  // ── Contact accuracy ────────────────────────────────────────────────
  const foot = fx.tracks.find((t) => t.joint === "RightFoot") ?? fx.tracks[0];
  const spec = contactSpec(duration);
  const world = rigidWorldSource({ RightFoot: foot.keys });
  const before = detectContactBreak(spec, foot.keys, world);
  const shifted = foot.keys.map((k) => ({
    ...k,
    pose: { ...k.pose, position: { ...k.pose.position } },
  }));
  const lockReport = solveContactLock(spec, shifted, rigidWorldSource({ RightFoot: shifted }), (joint, t, d) => {
    const k = shifted.find((x) => Math.abs(x.t - t) < 1e-9);
    if (k) {
      k.pose.position.x += d.x;
      k.pose.position.y += d.y;
      k.pose.position.z += d.z;
    }
  });
  const after = detectContactBreak(spec, shifted, rigidWorldSource({ RightFoot: shifted }));
  const drifts: number[] = [];
  for (const k of shifted) {
    if (k.t < spec.startTime - 1e-9 || k.t > spec.endTime + 1e-9) continue;
    const w = rigidWorldSource({ RightFoot: shifted })("RightFoot", k.t);
    if (!w) continue;
    drifts.push(Math.hypot(w.x, w.y, w.z));
  }

  // ── Loop seam (first key vs last key on a looping pose) ──────────────
  const loopTrack = fx.tracks.find((t) => t.joint === "LeftHand") ?? foot;
  const first = loopTrack.keys[0];
  const last = loopTrack.keys[loopTrack.keys.length - 1];
  const loopPositionSeamStud = Math.hypot(
    first.pose.position.x - last.pose.position.x,
    first.pose.position.y - last.pose.position.y,
    first.pose.position.z - last.pose.position.z,
  );
  const loopK = computeKinematics(loopTrack.keys);
  // Seam DISCONTINUITY normalized by the track's own peak speed. Dividing by
  // the first sample's velocity (the obvious formula) divides by ~0 for
  // low-energy styles like SUBTLE and reports noise as a ratio.
  let loopPeakSpeed = 0;
  for (const s of loopK) {
    loopPeakSpeed = Math.max(loopPeakSpeed, Math.hypot(s.vel.x, s.vel.y, s.vel.z));
  }
  const seamRatio =
    loopK.length >= 2
      ? Math.hypot(
          loopK[loopK.length - 1].vel.x - loopK[0].vel.x,
          loopK[loopK.length - 1].vel.y - loopK[0].vel.y,
          loopK[loopK.length - 1].vel.z - loopK[0].vel.z,
        ) / Math.max(loopPeakSpeed, 1e-6)
      : 0;

  // ── Velocity continuity + peaks ──────────────────────────────────────
  let peakSpeed = 0;
  let peakJerk = 0;
  let continuityHits = 0;
  let continuityTotal = 0;
  for (const t of fx.tracks) {
    const k = computeKinematics(t.keys);
    for (const s of k) {
      peakSpeed = Math.max(peakSpeed, Math.hypot(s.vel.x, s.vel.y, s.vel.z));
      peakJerk = Math.max(peakJerk, Math.hypot(s.jerk.x, s.jerk.y, s.jerk.z));
    }
    continuityTotal += analyzeKinematics([{ joint: t.joint, keys: t.keys }], style).length;
  }
  continuityHits = continuityTotal;

  // ── Repair iterations via the real compiler ──────────────────────────
  const compiled = compileAnimation({
    animation: `bench_${style}`,
    tracks: fx.tracks.map((t) => ({ joint: t.joint, keys: t.keys })),
    bindings: fx.bindings,
    roles,
    style,
    contacts: [spec],
    rigidAssembly: true,
    densify: { maxGapSec: 99, maxAngleDeg: 999, maxMoveStud: 999 },
    maxIterations: 5,
  });

  return {
    contactMaxDriftStud: lockReport.maxDriftAfterStud,
    contactLocked: after.locked,
    contactMeanDriftStud: drifts.length > 0 ? drifts.reduce((a, b) => a + b, 0) / drifts.length : 0,
    loopPositionSeamStud,
    loopVelocitySeamRatio: seamRatio,
    peakSpeedStudPerSec: peakSpeed,
    peakJerkStudPerSec3: peakJerk,
    velocityContinuity: continuityHits,
    repairIterations: compiled.iterations,
    totalErrors: compiled.remainingIssues.filter((i) => i.severity === "error").length,
  };
}

export const BENCH_STYLES: readonly StyleKind[] = [
  "REALISTIC",
  "CINEMATIC",
  "ANIME",
  "EXAGGERATED",
  "MECHANICAL",
  "CREATURE",
  "CARTOON",
  "SUBTLE",
];

export function benchmarkAll(): Record<StyleKind, BenchMetrics> {
  const out = {} as Record<StyleKind, BenchMetrics>;
  for (const s of BENCH_STYLES) out[s] = benchmarkStyle(s);
  return out;
}

/** Exit-criteria violations for one style. Empty means it passed. */
export function exitCriterionFailures(metrics: BenchMetrics): string[] {
  const bad: string[] = [];
  for (const [key, limit] of Object.entries(BENCH_EXIT_CRITERIA)) {
    const v = metrics[key as BenchExitKey];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      bad.push(`${key}=${v} (not a finite number)`);
    } else if (v > limit) {
      bad.push(`${key}=${v} exceeds ${limit}`);
    }
  }
  if (!metrics.contactLocked) bad.push("contactLocked=false");
  return bad;
}

/** Exit-criteria violations across every style, prefixed by style name. */
export function allExitCriterionFailures(): string[] {
  const all = benchmarkAll();
  return Object.entries(all).flatMap(([style, m]) =>
    exitCriterionFailures(m).map((f) => `${style}: ${f}`),
  );
}

/** Bake every track once — used by the perf benchmark for timing only. */
export function bakeFixture(style: StyleKind, fps = 30) {
  const fx = buildFixture(style);
  return fx.tracks.map((t) => bakeTrackDense(t, { fps }));
}

export function fixtureKeyCounts(style: StyleKind): { joint: string; keys: number }[] {
  return buildFixture(style).tracks.map((t) => ({ joint: t.joint, keys: t.keys.length }));
}

export function makeKey(joint: string, t: number, pos: Vec3, degX: number): PoseKeyframe {
  return {
    t,
    pose: makeJointPose(joint, {
      position: pos,
      rotation: eulerDegToQuat({ x: degX, y: 0, z: 0 }),
      semanticRole: "limb",
    }),
    easing: "linear",
    interpolation: "slerp",
  };
}
