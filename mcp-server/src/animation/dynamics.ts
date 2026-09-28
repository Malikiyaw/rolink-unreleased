/**
 * RoLink secondary motion — Task 6.1.
 *
 * Trailing-spring solver for follow/overlap/drag: head sway, arm lag,
 * accessory drag. The secondary joint chases the primary transform
 * through a damped spring on the OFFSET (not the absolute pose), driven
 * by primary acceleration (inertia) — so a jerked primary leaves the
 * secondary behind, then overshoot and settle follow automatically.
 *
 * Position springs integrate in studs; rotation springs integrate in
 * rotation-vector space (axis × half-angle via quatLog/quatExp), which
 * gives real rotational overshoot instead of exponential easing.
 * Semi-implicit Euler with automatic substepping keeps any stiffness
 * stable; zero stiffness means rigid follow (documented, not NaN).
 *
 * Scope honesty: this is trailing dynamics, not pendulum/cloth
 * simulation — no gravity direction or collision response. Good for
 * lag/drag/settle; not for ropes.
 */

import type {
  PoseKeyframe,
  Quaternion,
  SecondarySpec,
  Vec3,
} from "../../../shared/animationProtocol.js";
import {
  quatAngularVelocity,
  quatExp,
  quatLog,
  quatMultiply,
  quatNormalize,
} from "./quaternion.js";

export interface SecondaryTarget {
  position: Vec3;
  rotation: Quaternion;
}

export interface SecondaryResult {
  position: Vec3;
  rotation: Quaternion;
}

export interface SecondaryState {
  offP: Vec3;
  velP: Vec3;
  offR: Vec3;
  velR: Vec3;
  prevPos: Vec3 | undefined;
  prevVel: Vec3;
  prevQuat: Quaternion | undefined;
  prevAngVel: Vec3;
}

export function createSecondaryState(): SecondaryState {
  const zero = (): Vec3 => ({ x: 0, y: 0, z: 0 });
  return {
    offP: zero(),
    velP: zero(),
    offR: zero(),
    velR: zero(),
    prevPos: undefined,
    prevVel: zero(),
    prevQuat: undefined,
    prevAngVel: zero(),
  };
}

function vecAdd(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function vecSub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function vecScale(v: Vec3, s: number): Vec3 {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}

function vecLen(v: Vec3): number {
  return Math.hypot(v.x, v.y, v.z);
}

function springStep(
  off: Vec3,
  vel: Vec3,
  driveAcc: Vec3,
  k: number,
  c: number,
  m: number,
  followWeight: number,
  h: number,
): { off: Vec3; vel: Vec3 } {
  // off'' = -(k*off + c*vel)/m - followWeight*driveAcc ; semi-implicit Euler.
  const acc = vecSub(vecScale(vecAdd(vecScale(off, k), vecScale(vel, c)), -1 / m), vecScale(driveAcc, followWeight));
  const vel2 = vecAdd(vel, vecScale(acc, h));
  const off2 = vecAdd(off, vecScale(vel2, h));
  return { off: off2, vel: vel2 };
}

export function stepSecondaryMotion(
  state: SecondaryState,
  primary: SecondaryTarget,
  cfg: SecondarySpec,
  dt: number,
): SecondaryResult {
  const quat = quatNormalize(primary.rotation);
  if (!(dt > 1e-9)) {
    return { position: { ...primary.position }, rotation: quat };
  }
  const k = Math.max(0, cfg.stiffness);
  const c = Math.max(0, cfg.damping);
  const m = Math.max(1e-6, cfg.mass ?? 1);
  const followWeight = cfg.followWeight;

  if (k <= 0) {
    // Rigid follow: no spring, no lag. Reset offsets so a zero-stiffness
    // joint never accumulates drift from earlier steps.
    state.offP = { x: 0, y: 0, z: 0 };
    state.velP = { x: 0, y: 0, z: 0 };
    state.offR = { x: 0, y: 0, z: 0 };
    state.velR = { x: 0, y: 0, z: 0 };
    state.prevPos = { ...primary.position };
    state.prevVel = { x: 0, y: 0, z: 0 };
    state.prevQuat = { ...quat };
    state.prevAngVel = { x: 0, y: 0, z: 0 };
    return { position: { ...primary.position }, rotation: quat };
  }

  const primaryVel = state.prevPos
    ? vecScale(vecSub(primary.position, state.prevPos), 1 / dt)
    : { x: 0, y: 0, z: 0 };
  const primaryAcc = vecScale(vecSub(primaryVel, state.prevVel), 1 / dt);
  const primaryAngVel = state.prevQuat
    ? quatAngularVelocity(state.prevQuat, quat, dt)
    : { x: 0, y: 0, z: 0 };
  // quatAngularVelocity reports deg/sec; the spring runs in SI-ish units —
  // convert the drive to rad/sec so rotation offsets stay meaningful.
  const toRad = Math.PI / 180;
  const angVelRad = vecScale(primaryAngVel, toRad);
  const prevAngVelRad = vecScale(state.prevAngVel, toRad);
  const primaryAngAcc = vecScale(vecSub(angVelRad, prevAngVelRad), 1 / dt);

  // Substep for stability: semi-implicit Euler needs h < ~2/sqrt(k/m).
  const omega = Math.sqrt(k / m);
  const hMax = omega > 1e-9 ? 1 / omega : dt;
  const n = Math.min(32, Math.max(1, Math.ceil(dt / Math.max(hMax, 1e-6))));
  const h = dt / n;
  let { offP, velP, offR, velR } = {
    offP: state.offP,
    velP: state.velP,
    offR: state.offR,
    velR: state.velR,
  };
  for (let i = 0; i < n; i += 1) {
    const p = springStep(offP, velP, primaryAcc, k, c, m, followWeight, h);
    offP = p.off;
    velP = p.vel;
    const r = springStep(offR, velR, primaryAngAcc, k, c, m, followWeight, h);
    offR = r.off;
    velR = r.vel;
  }

  if (cfg.maxDisplacement !== undefined && cfg.maxDisplacement >= 0) {
    const len = vecLen(offP);
    if (len > cfg.maxDisplacement) {
      offP = vecScale(offP, cfg.maxDisplacement / len);
    }
  }
  if (cfg.maxRotationDeg !== undefined && cfg.maxRotationDeg >= 0) {
    // |offR| is a half-angle magnitude: full angle = 2|r| rad.
    const halfLen = vecLen(offR);
    const maxHalf = ((cfg.maxRotationDeg * Math.PI) / 180) / 2;
    if (halfLen > maxHalf && halfLen > 1e-12) {
      offR = vecScale(offR, maxHalf / halfLen);
    }
  }

  state.offP = offP;
  state.velP = velP;
  state.offR = offR;
  state.velR = velR;
  state.prevPos = { ...primary.position };
  state.prevVel = primaryVel;
  state.prevQuat = { ...quat };
  state.prevAngVel = primaryAngVel;

  return {
    position: vecAdd(primary.position, offP),
    rotation: quatNormalize(quatMultiply(quat, quatExp(offR))),
  };
}

/**
 * Run a primary key track through the spring and return the secondary
 * joint's track (same timestamps, linear/slerp samples). The joint name,
 * role, and rest position come from the primary keys; cfg.joint names
 * the driven secondary (informational — keys carry cfg.joint).
 */
export function simulateSecondaryTrack(
  primaryKeys: PoseKeyframe[],
  cfg: SecondarySpec,
  semanticRole?: PoseKeyframe["pose"]["semanticRole"],
): PoseKeyframe[] {
  const sorted = [...primaryKeys].sort((a, b) => a.t - b.t);
  const state = createSecondaryState();
  const out: PoseKeyframe[] = [];
  let prevT: number | undefined;
  for (const k of sorted) {
    const dt = prevT === undefined ? 0 : k.t - prevT;
    const res = stepSecondaryMotion(
      state,
      { position: k.pose.position, rotation: k.pose.rotation },
      cfg,
      dt,
    );
    out.push({
      t: k.t,
      pose: {
        joint: cfg.joint,
        position: res.position,
        rotation: res.rotation,
        semanticRole: semanticRole ?? k.pose.semanticRole,
      },
      easing: "linear",
      interpolation: "slerp",
    });
    prevT = k.t;
  }
  return out;
}
