/**
 * RoLink IK solver — Tasks 4.1 + 4.2.
 *
 * Deterministic, Studio-independent inverse kinematics over an explicit
 * chain model (rest offsets + rest orientations + pose deltas).
 *
 *  - 2-joint chains: closed-form two-bone analytic solution (law of
 *    cosines) with pole-vector bend-plane control — the arm/leg case.
 *  - N-joint chains: bounded CCD fallback with convergence report.
 *  - bakeIKToKeys: solved local deltas → PoseKeyframe tracks.
 *
 * ROTATION CONVENTION (engine-wide): PoseKeyframe.rotation is the TOTAL
 * joint-local rotation (rest composed). Solvers output local DELTAS;
 * bakers compose rest ⊗ delta. Motor6D.Transform receives the delta;
 * the Studio side (IK.lua / PoseSolver) owns that split.
 *
 * Geometry (offsets/lengths) must be supplied explicitly or derived from
 * Task 2.4 enriched payloads by the caller — this module never guesses
 * bone lengths. Missing geometry is an Error, not a silent default.
 */

import type {
  EasingName,
  IKChain,
  PoseKeyframe,
  Quaternion,
  SemanticRole,
  Transform3D,
  Vec3,
} from "../../../shared/animationProtocol.js";
import {
  quatFromAxisAngle,
  quatFromTo,
  quatInverse,
  quatMultiply,
  quatNormalize,
  quatRotateVec,
  quatSlerp,
} from "./quaternion.js";
import type { JointBinding } from "./jointAdapter.js";
import type { GeneratedTrack } from "./pose.js";

export interface IKJointModel {
  name: string;
  /** Rest offset from the parent joint origin, in the parent's rotated frame. */
  offset: Vec3;
  /** Rest local orientation. */
  rest: Quaternion;
  /** Current/solved local pose delta (what Motor6D.Transform carries). */
  pose: Quaternion;
}

export interface IKChainModel {
  joints: IKJointModel[];
  /** End-effector tip offset from the last joint, in the last joint's frame. */
  endOffset: Vec3;
}

export interface IKSolution {
  /** Solved local pose deltas by joint name. */
  rotations: Record<string, Quaternion>;
  /** Achieved tip position (chain space). */
  tip: Vec3;
  /** |achieved tip − target| in studs. */
  residualStud: number;
  /** True when the raw target lay outside the reachable shell. */
  clamped: boolean;
  /** True when residualStud < 0.1 (the Phase 4 exit criterion). */
  converged: boolean;
  /** Sweeps used (1 for the analytic path). */
  iterations: number;
}

export interface IKGoal {
  target: Vec3;
  pole?: Vec3;
  weight?: number;
}

// ── Chain construction ──────────────────────────────────────────────────────

function vecLen(v: Vec3): number {
  return Math.hypot(v.x, v.y, v.z);
}

function vecSub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function vecAdd(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function vecScale(v: Vec3, s: number): Vec3 {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}

export function createIKChainModel(opts: {
  names: string[];
  offsets?: Vec3[];
  lengths?: number[];
  rests?: Quaternion[];
  endOffset?: Vec3;
  endLength?: number;
}): IKChainModel {
  const { names } = opts;
  if (names.length === 0) throw new Error("insufficient_data: IK chain needs at least one joint");
  let offsets = opts.offsets;
  if (!offsets && opts.lengths) {
    if (opts.lengths.length !== names.length) {
      throw new Error(
        `insufficient_data: ${opts.lengths.length} lengths for ${names.length} joints`,
      );
    }
    offsets = opts.lengths.map((len) => {
      if (!(len > 0)) throw new Error(`insufficient_data: segment length must be positive (got ${len})`);
      return { x: 0, y: -len, z: 0 };
    });
  }
  if (!offsets || offsets.length !== names.length) {
    throw new Error(
      "insufficient_data: IK needs explicit offsets[] or lengths[] (bone lengths are never guessed)",
    );
  }
  let endOffset = opts.endOffset;
  if (!endOffset && opts.endLength !== undefined) {
    if (!(opts.endLength > 0)) throw new Error("insufficient_data: endLength must be positive");
    endOffset = { x: 0, y: -opts.endLength, z: 0 };
  }
  if (!endOffset) {
    throw new Error("insufficient_data: IK needs an explicit endOffset/endLength to the tip");
  }
  return {
    joints: names.map((name, i) => ({
      name,
      offset: { ...offsets[i] },
      rest: quatNormalize(opts.rests?.[i] ?? { w: 1, x: 0, y: 0, z: 0 }),
      pose: { w: 1, x: 0, y: 0, z: 0 },
    })),
    endOffset: { ...endOffset },
  };
}

// ── Forward kinematics ──────────────────────────────────────────────────────

export interface FKResult {
  origins: Vec3[];
  orientations: Quaternion[];
  tip: Vec3;
}

export function fkChain(model: IKChainModel, basePos?: Vec3): FKResult {
  const base = basePos ?? { x: 0, y: 0, z: 0 };
  const origins: Vec3[] = [];
  const orientations: Quaternion[] = [];
  let wParent: Quaternion = { w: 1, x: 0, y: 0, z: 0 };
  let p = { ...base };
  for (const j of model.joints) {
    p = vecAdd(p, quatRotateVec(wParent, j.offset));
    const w = quatMultiply(quatMultiply(wParent, j.rest), j.pose);
    origins.push({ ...p });
    orientations.push(w);
    wParent = w;
  }
  const tip = vecAdd(p, quatRotateVec(wParent, model.endOffset));
  return { origins, orientations, tip };
}

// ── Two-bone analytic solver ────────────────────────────────────────────────

const DEFAULT_POLE: Vec3 = { x: 0, y: 0, z: 1 };

export function solveTwoBone(
  model: IKChainModel,
  basePos: Vec3 | undefined,
  target: Vec3,
  goal?: IKGoal & { current?: Record<string, Quaternion> },
): IKSolution {
  if (model.joints.length !== 2) {
    throw new Error(`solveTwoBone needs exactly 2 joints (got ${model.joints.length}); use solveCCD`);
  }
  const [S, E] = model.joints;
  const a = vecLen(S.offset);
  const b = vecLen(model.endOffset);
  if (!(a > 1e-6) || !(b > 1e-6)) {
    throw new Error("insufficient_data: two-bone IK needs non-zero segment lengths");
  }
  const base = basePos ?? { x: 0, y: 0, z: 0 };
  // Reach is measured from the SHOULDER joint origin (base + root offset),
  // not from the chain-space origin — the root offset is rigid translation.
  const shoulderOrigin = vecAdd(base, S.offset);
  const toT = vecSub(target, shoulderOrigin);
  const draw = vecLen(toT);
  const dMax = a + b - 1e-4;
  const dMin = Math.abs(a - b) + 1e-4;
  const D = Math.min(dMax, Math.max(dMin, draw));
  const clamped = D !== draw;
  const aim = draw > 1e-9
    ? vecScale(toT, 1 / draw)
    : (() => {
      const d = vecLen(model.endOffset);
      return { x: model.endOffset.x / d, y: model.endOffset.y / d, z: model.endOffset.z / d };
    })();
  const targetEff = vecAdd(shoulderOrigin, vecScale(aim, D));

  const cosA = Math.min(1, Math.max(-1, (a * a + D * D - b * b) / (2 * a * D)));
  const A = Math.acos(cosA);

  const pole = goal?.pole ?? DEFAULT_POLE;
  const pd = pole.x * aim.x + pole.y * aim.y + pole.z * aim.z;
  let side = vecSub(pole, vecScale(aim, pd));
  if (vecLen(side) < 1e-6) {
    // Pole parallel to aim: deterministic perpendicular fallback.
    const ax = Math.abs(aim.x) <= Math.abs(aim.y) && Math.abs(aim.x) <= Math.abs(aim.z)
      ? { x: 1, y: 0, z: 0 }
      : Math.abs(aim.y) <= Math.abs(aim.z)
        ? { x: 0, y: 1, z: 0 }
        : { x: 0, y: 0, z: 1 };
    side = {
      x: aim.y * ax.z - aim.z * ax.y,
      y: aim.z * ax.x - aim.x * ax.z,
      z: aim.x * ax.y - aim.y * ax.x,
    };
  }
  const sl = vecLen(side);
  const sideN = vecScale(side, 1 / sl);
  // Bend axis ⟂ aim in the aim–pole plane; pick the elbow side facing the pole.
  let axis = {
    x: aim.y * sideN.z - aim.z * sideN.y,
    y: aim.z * sideN.x - aim.x * sideN.z,
    z: aim.x * sideN.y - aim.y * sideN.x,
  };
  const dirPos = quatRotateVec(quatFromAxisAngle(axis, A), aim);
  const dirNeg = quatRotateVec(quatFromAxisAngle(axis, -A), aim);
  const scorePos = (dirPos.x - aim.x) * sideN.x + (dirPos.y - aim.y) * sideN.y + (dirPos.z - aim.z) * sideN.z;
  const scoreNeg = (dirNeg.x - aim.x) * sideN.x + (dirNeg.y - aim.y) * sideN.y + (dirNeg.z - aim.z) * sideN.z;
  if (scoreNeg > scorePos) {
    axis = vecScale(axis, -1);
  }
  const dirElbow = scoreNeg > scorePos ? dirNeg : dirPos;

  const restDirS = vecScale(S.offset, 1 / a);
  const wS = quatFromTo(restDirS, dirElbow);
  const pE = vecAdd(shoulderOrigin, vecScale(dirElbow, a));
  const toTip = vecSub(targetEff, pE);
  const tipLen = vecLen(toTip);
  const restDirE = vecScale(model.endOffset, 1 / b);
  const dirTip = tipLen > 1e-9 ? vecScale(toTip, 1 / tipLen) : restDirE;
  const wE = quatFromTo(restDirE, dirTip);

  const sPose = quatMultiply(quatInverse(S.rest), wS);
  const ePose = quatMultiply(quatMultiply(quatInverse(E.rest), quatInverse(wS)), wE);

  const w = Math.min(1, Math.max(0, goal?.weight ?? 1));
  const cur = goal?.current;
  const sFinal = quatSlerp(cur?.[S.name] ?? { w: 1, x: 0, y: 0, z: 0 }, sPose, w);
  const eFinal = quatSlerp(cur?.[E.name] ?? { w: 1, x: 0, y: 0, z: 0 }, ePose, w);

  const solved: IKChainModel = {
    joints: [
      { ...S, pose: sFinal },
      { ...E, pose: eFinal },
    ],
    endOffset: { ...model.endOffset },
  };
  const tip = fkChain(solved, base).tip;
  const residualStud = vecLen(vecSub(tip, target));
  return {
    rotations: { [S.name]: sFinal, [E.name]: eFinal },
    tip,
    residualStud,
    clamped,
    converged: residualStud < 0.1,
    iterations: 1,
  };
}

// ── CCD fallback ────────────────────────────────────────────────────────────

export interface CCDOptions extends IKGoal {
  current?: Record<string, Quaternion>;
  toleranceStud?: number;
  maxIterations?: number;
}

export function solveCCD(
  model: IKChainModel,
  basePos: Vec3 | undefined,
  target: Vec3,
  opts?: CCDOptions,
): IKSolution {
  if (model.joints.length === 0) throw new Error("insufficient_data: CCD needs at least one joint");
  const base = basePos ?? { x: 0, y: 0, z: 0 };
  const tol = opts?.toleranceStud ?? 0.05;
  const maxIter = Math.min(Math.max(opts?.maxIterations ?? 12, 1), 64);
  const w = Math.min(1, Math.max(0, opts?.weight ?? 1));
  const start: Record<string, Quaternion> = {};
  const work: IKChainModel = {
    joints: model.joints.map((j) => {
      const s0 = quatNormalize(opts?.current?.[j.name] ?? { ...j.pose });
      start[j.name] = { ...s0 };
      return { ...j, offset: { ...j.offset }, rest: { ...j.rest }, pose: s0 };
    }),
    endOffset: { ...model.endOffset },
  };

  let tip = fkChain(work, base).tip;
  let residual = vecLen(vecSub(tip, target));
  let iter = 0;
  let converged = residual <= tol;
  while (!converged && iter < maxIter) {
    iter += 1;
    for (let i = work.joints.length - 1; i >= 0; i -= 1) {
      const fk = fkChain(work, base);
      const pI = fk.origins[i];
      const v1 = vecSub(fk.tip, pI);
      const v2 = vecSub(target, pI);
      if (vecLen(v1) < 1e-9 || vecLen(v2) < 1e-9) continue;
      const dq = quatFromTo(v1, v2);
      // Parent full world orientation (rest + pose up to the parent).
      let wParent: Quaternion = { w: 1, x: 0, y: 0, z: 0 };
      for (let k = 0; k < i; k += 1) {
        wParent = quatMultiply(quatMultiply(wParent, work.joints[k].rest), work.joints[k].pose);
      }
      const jnt = work.joints[i];
      const sNew = quatMultiply(
        quatMultiply(quatMultiply(quatInverse(jnt.rest), quatInverse(wParent)), dq),
        quatMultiply(quatMultiply(wParent, jnt.rest), jnt.pose),
      );
      jnt.pose = quatNormalize(sNew);
    }
    tip = fkChain(work, base).tip;
    residual = vecLen(vecSub(tip, target));
    converged = residual <= tol;
  }

  const rotations: Record<string, Quaternion> = {};
  for (const j of work.joints) {
    rotations[j.name] = quatSlerp(start[j.name], j.pose, w);
  }
  const blended: IKChainModel = {
    joints: work.joints.map((j) => ({ ...j, pose: rotations[j.name] })),
    endOffset: { ...work.endOffset },
  };
  const finalTip = fkChain(blended, base).tip;
  const finalResidual = vecLen(vecSub(finalTip, target));
  return {
    rotations,
    tip: finalTip,
    residualStud: finalResidual,
    clamped: false,
    converged: finalResidual < 0.1,
    iterations: iter,
  };
}

/** Dispatcher: analytic for 2-joint chains, CCD otherwise. */
export function solveIKChain(
  model: IKChainModel,
  basePos: Vec3 | undefined,
  target: Vec3,
  opts?: CCDOptions,
): IKSolution {
  if (model.joints.length === 2) return solveTwoBone(model, basePos, target, opts);
  return solveCCD(model, basePos, target, opts);
}

// ── Bake to keyframes (Task 4.2) ────────────────────────────────────────────

export interface IKFrame {
  t: number;
  rotations: Record<string, Quaternion>;
  easing?: EasingName;
}

export function bakeIKToKeys(
  joints: Array<{ name: string; rest: Transform3D; semanticRole: SemanticRole }>,
  frames: IKFrame[],
): GeneratedTrack[] {
  const byJoint = new Map<string, PoseKeyframe[]>();
  for (const j of joints) byJoint.set(j.name, []);
  const restByName = new Map(joints.map((j) => [j.name, j.rest]));
  const roleByName = new Map(joints.map((j) => [j.name, j.semanticRole]));
  const sorted = [...frames].sort((a, b) => a.t - b.t);
  for (const f of sorted) {
    for (const j of joints) {
      const delta = f.rotations[j.name];
      if (!delta) continue;
      const rest = restByName.get(j.name) ?? {
        position: { x: 0, y: 0, z: 0 },
        rotation: { w: 1, x: 0, y: 0, z: 0 },
      };
      byJoint.get(j.name)?.push({
        t: f.t,
        pose: {
          joint: j.name,
          position: { ...rest.position },
          rotation: quatNormalize(quatMultiply(rest.rotation, delta)),
          semanticRole: roleByName.get(j.name) ?? "unknown",
        },
        easing: f.easing ?? "linear",
        interpolation: "slerp",
      });
    }
  }
  return joints
    .filter((j) => (byJoint.get(j.name)?.length ?? 0) > 0)
    .map((j) => ({
      joint: j.name,
      jointKind: "Motor6D" as const,
      semanticRole: j.semanticRole,
      keys: (byJoint.get(j.name) ?? []).sort((a, b) => a.t - b.t),
    }));
}

// ── Chain management (Task 4.1) ─────────────────────────────────────────────

export interface CreateChainOpts {
  rootName?: string;
  maxJoints?: number;
  /** Explicit joint names (root-first), bypassing the upward walk.
   * Required for flat hierarchies where parts parent straight to the
   * Model; the walk only finds joints on nested paths. */
  joints?: string[];
  pole?: Vec3;
  weight?: number;
  priority?: number;
  smoothing?: number;
  target?: Vec3;
  lengths?: number[];
  offsets?: Vec3[];
  endLength?: number;
  endOffset?: Vec3;
}

const DRIVABLE_KINDS: ReadonlySet<string> = new Set(["Motor6D", "AnimationConstraint", "Bone"]);

/**
 * Build an IKChain spec + solver model by walking up from the end effector.
 * Geometry (lengths/offsets/endLength/endOffset) is REQUIRED — bone lengths
 * are never guessed. Throws insufficient_data errors otherwise.
 */
export function createIKChain(
  name: string,
  bindings: JointBinding[],
  endEffector: string,
  opts?: CreateChainOpts,
): { spec: IKChain; model: IKChainModel } {
  const byName = new Map(bindings.map((b) => [b.name, b]));
  if (!byName.has(endEffector)) {
    throw new Error(`IK chain "${name}": end effector "${endEffector}" not found in bindings`);
  }
  const maxJoints = Math.min(Math.max(opts?.maxJoints ?? 2, 1), 8);
  let collected: JointBinding[];
  if (opts?.joints) {
    collected = opts.joints.map((jn) => {
      const b = byName.get(jn);
      if (!b) throw new Error(`insufficient_data: IK chain "${name}": joint "${jn}" not in bindings`);
      if (!DRIVABLE_KINDS.has(b.kind)) {
        throw new Error(
          `insufficient_data: IK chain "${name}": "${jn}" is ${b.kind}, not a drivable joint`,
        );
      }
      return b;
    });
    if (collected.length === 0 || collected.length > maxJoints) {
      throw new Error(
        `insufficient_data: IK chain "${name}": need 1–${maxJoints} explicit joints`,
      );
    }
  } else {
    collected = [];
    let at: string | undefined = endEffector;
    const seen = new Set<string>();
    while (at !== undefined && collected.length < maxJoints && !seen.has(at)) {
      seen.add(at);
      const b = byName.get(at);
      if (!b) break;
      if (DRIVABLE_KINDS.has(b.kind)) collected.unshift(b);
      if (opts?.rootName !== undefined && b.name === opts.rootName) break;
      at = b.parent;
    }
  }
  if (collected.length === 0) {
    throw new Error(
      `insufficient_data: IK chain "${name}": no drivable joints above "${endEffector}" ` +
        `(need Motor6D/AnimationConstraint/Bone on nested paths, or pass explicit joints[])`,
    );
  }
  const model = createIKChainModel({
    names: collected.map((b) => b.name),
    ...(opts?.offsets ? { offsets: opts.offsets } : {}),
    ...(opts?.lengths ? { lengths: opts.lengths } : {}),
    rests: collected.map((b) => b.rest.rotation),
    ...(opts?.endOffset ? { endOffset: opts.endOffset } : {}),
    ...(opts?.endLength !== undefined ? { endLength: opts.endLength } : {}),
  });
  const weight = Math.min(1, Math.max(0, opts?.weight ?? 1));
  const smoothing = opts?.smoothing !== undefined ? Math.min(1, Math.max(0, opts.smoothing)) : undefined;
  const spec: IKChain = {
    name,
    root: collected[0].name,
    endEffector,
    chain: collected.slice(1).map((b) => b.name),
    target: opts?.target ? { ...opts.target } : { x: 0, y: 0, z: 0 },
    ...(opts?.pole ? { pole: { ...opts.pole } } : {}),
    weight,
    priority: opts?.priority ?? 0,
    ...(smoothing !== undefined ? { smoothing } : {}),
  };
  return { spec, model };
}

export function setIKTarget(spec: IKChain, target: Vec3, pole?: Vec3): IKChain {
  return {
    ...spec,
    target: { ...target },
    ...(pole ? { pole: { ...pole } } : spec.pole ? { pole: { ...spec.pole } } : {}),
  };
}

export function sortChainsByPriority(chains: IKChain[]): IKChain[] {
  return [...chains].sort((a, b) => b.priority - a.priority);
}

/** Temporal smoothing: 0 = snap to solved, 1 = frozen on previous. */
export function smoothRotations(
  prev: Record<string, Quaternion>,
  next: Record<string, Quaternion>,
  smoothing: number,
): Record<string, Quaternion> {
  const s = Math.min(1, Math.max(0, smoothing));
  const out: Record<string, Quaternion> = {};
  for (const [name, q] of Object.entries(next)) {
    out[name] = prev[name] ? quatSlerp(prev[name], q, 1 - s) : quatNormalize(q);
  }
  return out;
}
