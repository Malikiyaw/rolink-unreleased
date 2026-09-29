/**
 * RoLink Animation Engine wall-clock benchmark — Task 11.3.
 *
 * Timing only. Never asserted (machine-dependent); run it to compare
 * before/after a hot-path change. Quality metrics live in benchmarks.ts
 * and ARE asserted in CI.
 *
 *   node --import tsx src/animation/benchmarks.perf.ts
 */

import type { StyleKind } from "../../../shared/animationProtocol.js";
import { bakeTrackDense, sampleSegment } from "./curves.js";
import { densifyKeys } from "./inbetween.js";
import { analyzeKinematics } from "./validator.js";
import { analyzeRig } from "./rigAnalyzer.js";
import { generateSparsePoses } from "./pose.js";
import { type AnalyzeNodeInput } from "./jointAdapter.js";
import { buildFixture } from "./benchmarks.js";

const RIG_NODES: AnalyzeNodeInput[] = [
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

function nowMs(): number {
  return Number(process.hrtime.bigint()) / 1e6;
}

interface Row {
  name: string;
  iterations: number;
  totalMs: number;
  perOpUs: number;
  opsPerSec: number;
}

function measure(name: string, iterations: number, fn: () => unknown): Row {
  // Warmup so JIT state is comparable across rows.
  for (let i = 0; i < Math.min(3, iterations); i += 1) fn();
  const t0 = nowMs();
  for (let i = 0; i < iterations; i += 1) fn();
  const totalMs = nowMs() - t0;
  const perOpUs = (totalMs * 1000) / iterations;
  return {
    name,
    iterations,
    totalMs,
    perOpUs,
    opsPerSec: perOpUs > 0 ? 1e6 / perOpUs : Infinity,
  };
}

function fmt(r: Row): string {
  return `  ${r.name.padEnd(38)} ${r.perOpUs.toFixed(1).padStart(10)} us/op` +
    `  ${(r.totalMs).toFixed(1).padStart(9)} ms total  ${Math.round(r.opsPerSec).toLocaleString()} ops/s`;
}

const STYLE: StyleKind = "ANIME";

function main(): void {
  const fx = buildFixture(STYLE);
  const track = fx.tracks[0];
  const totalKeys = fx.tracks.reduce((a, t) => a + t.keys.length, 0);

  console.log("RoLink Animation Engine — wall-clock benchmark (timing only, not asserted)");
  console.log(`fixture: ${fx.tracks.length} tracks, ${totalKeys} keys, style=${STYLE}\n`);

  const rows: Row[] = [];

  rows.push(measure("analyzeRig + skeleton (18 joints)", 200, () => {
    analyzeRig("W.N", RIG_NODES);
  }));

  rows.push(measure("generateSparsePoses (full plan)", 200, () => {
    generateSparsePoses(fx.bindings, fx.skeleton, fx.plan, { seed: 42, style: STYLE });
  }));

  rows.push(measure("densifyKeys", 200, () => {
    densifyKeys(track.keys, {});
  }));

  rows.push(measure("bakeTrackDense 30fps (all tracks)", 100, () => {
    for (const t of fx.tracks) bakeTrackDense(t, { fps: 30 });
  }));

  rows.push(measure("bakeTrackDense 60fps (all tracks)", 100, () => {
    for (const t of fx.tracks) bakeTrackDense(t, { fps: 60 });
  }));

  rows.push(measure("analyzeKinematics (all tracks)", 200, () => {
    analyzeKinematics(fx.tracks.map((t) => ({ joint: t.joint, keys: t.keys })), STYLE);
  }));

  rows.push(measure("sampleSegment x10k", 100, () => {
    for (let i = 0; i < 10000; i += 1) sampleSegment(track.keys[0], track.keys[1], 0.5);
  }));

  for (const r of rows) console.log(fmt(r));
  console.log(
    "\nCompare against a baseline run before/after optimizing a hot path;",
  );
  console.log("quality regressions are caught by tests/benchmarks.test.ts instead.");
}

main();
