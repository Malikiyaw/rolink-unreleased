/**
 * RoLink auto-repair — Task 8.2.
 *
 * One pure strategy per defect code. Every strategy returns NEW key
 * arrays — inputs are never mutated (the no-silent-clamp rule extends
 * to repair: the compiler diffs before/after and reports both).
 * Anything without a safe automatic fix (self-intersection, loop
 * seams, contacts without a world source) comes back UNREPAIRED with
 * an explicit reason instead of a guess.
 */

import type {
  DefectCode,
  JointLimit,
  PoseKeyframe,
  Transform3D,
  ValidationIssue,
  Vec3,
} from "../../../shared/animationProtocol.js";
import { eulerDegToQuat, quatToEulerDeg } from "../../../shared/animationProtocol.js";
import { quatInverse, quatMultiply, quatNormalize } from "./quaternion.js";
import { sampleSegment } from "./curves.js";
import { solveContactLock, type WorldPositionFn } from "./contacts.js";
import type { ContactSpec } from "../../../shared/animationProtocol.js";

export interface RepairedTrack {
  joint: string;
  keys: PoseKeyframe[];
}

export interface RepairContext {
  rests?: Record<string, Transform3D>;
  limits?: JointLimit[];
  contacts?: ContactSpec[];
  /**
   * World positions for the REPAIRED copies. Prefer makeWorldSource
   * (built over the working copies, e.g. rigidWorldSource); worldPos
   * is used directly when the source is live or analytic. Without
   * either, contact issues come back unrepaired.
   */
  worldPos?: WorldPositionFn;
  makeWorldSource?: (tracks: RepairedTrack[]) => WorldPositionFn;
}

export interface RepairAction {
  issueCode: DefectCode;
  joint?: string;
  t?: number;
  strategy: string;
  detail: string;
}

export interface UnrepairedIssue {
  issue: ValidationIssue;
  reason: string;
}

export interface RepairOutcome {
  tracks: RepairedTrack[];
  applied: RepairAction[];
  unrepaired: UnrepairedIssue[];
}

function cloneTracks(tracks: RepairedTrack[]): RepairedTrack[] {
  return tracks.map((t) => ({
    joint: t.joint,
    keys: t.keys.map((k) => ({
      t: k.t,
      pose: {
        joint: k.pose.joint,
        position: { ...k.pose.position },
        rotation: { ...k.pose.rotation },
        ...(k.pose.scale ? { scale: { ...k.pose.scale } } : {}),
        semanticRole: k.pose.semanticRole ?? "unknown",
      },
      ...(k.easing ? { easing: k.easing } : {}),
      ...(k.interpolation ? { interpolation: k.interpolation } : {}),
    })),
  }));
}

function findKey(keys: PoseKeyframe[], t: number): PoseKeyframe | undefined {
  let best: PoseKeyframe | undefined;
  for (const k of keys) {
    if (Math.abs(k.t - (t ?? 0)) < 1e-9) return k;
    if (!best || Math.abs(k.t - (t ?? 0)) < Math.abs(best.t - (t ?? 0))) best = k;
  }
  return best;
}

function neighbors(keys: PoseKeyframe[], t: number): { prev?: PoseKeyframe; next?: PoseKeyframe } {
  const sorted = [...keys].sort((a, b) => a.t - b.t);
  let prev: PoseKeyframe | undefined;
  let next: PoseKeyframe | undefined;
  for (const k of sorted) {
    if (k.t < t - 1e-9) prev = k;
    if (k.t > t + 1e-9 && !next) next = k;
  }
  return { prev, next };
}

// ── Strategies ──────────────────────────────────────────────────────────────

function clampKeyToLimit(
  key: PoseKeyframe,
  limit: JointLimit,
  rest: Transform3D | undefined,
): PoseKeyframe {
  const rot = key.pose.rotation;
  if (![rot.w, rot.x, rot.y, rot.z].every(Number.isFinite)) {
    // Corrupt rotation: fall back to rest (documented, reported).
    const fallback = rest
      ? { ...rest.rotation }
      : { w: 1, x: 0, y: 0, z: 0 };
    return { ...key, pose: { ...key.pose, rotation: quatNormalize(fallback) } };
  }
  const base = rest ? quatNormalize(rest.rotation) : { w: 1, x: 0, y: 0, z: 0 };
  const rel = quatMultiply(quatInverse(base), quatNormalize(rot));
  const e = quatToEulerDeg(rel);
  const clampAxis = (v: number, min: number | undefined, max: number | undefined): number => {
    if (min === undefined || max === undefined || !Number.isFinite(v)) return v;
    return Math.min(max, Math.max(min, v));
  };
  const fixed = {
    x: clampAxis(e.x, limit.minDeg?.x, limit.maxDeg?.x),
    y: clampAxis(e.y, limit.minDeg?.y, limit.maxDeg?.y),
    z: clampAxis(e.z, limit.minDeg?.z, limit.maxDeg?.z),
  };
  return {
    ...key,
    pose: { ...key.pose, rotation: quatNormalize(quatMultiply(base, eulerDegToQuat(fixed))) },
  };
}

function smoothKeyAt(track: RepairedTrack, t: number): boolean {
  const { prev, next } = neighbors(track.keys, t);
  if (!prev || !next) return false;
  const target = findKey(track.keys, t);
  if (!target) return false;
  const approx = sampleSegment(prev, next, t);
  target.pose.position = { ...approx.position };
  target.pose.rotation = { ...approx.rotation };
  return true;
}

function retimeWindow(track: RepairedTrack, tCenter: number, factor: number, window: number): boolean {
  const sorted = [...track.keys].sort((a, b) => a.t - b.t);
  const inside = sorted.filter((k) => Math.abs(k.t - tCenter) <= window);
  if (inside.length === 0) return false;
  const lo = Math.min(...inside.map((k) => k.t));
  const hi = Math.max(...inside.map((k) => k.t));
  const before = sorted.filter((k) => k.t < lo - 1e-9).pop();
  const after = sorted.find((k) => k.t > hi + 1e-9);
  // Order-preserving clamp, floored at t=0 (retime must never emit
  // negative key times — PoseKeyframe requires t >= 0).
  const loBound = Math.max(before ? before.t + 1e-6 : 0, 0);
  const hiBound = after ? after.t - 1e-6 : Infinity;
  let moved = false;
  for (const k of inside) {
    const nt = tCenter + (k.t - tCenter) * factor;
    const clamped = Math.min(hiBound, Math.max(loBound, nt));
    if (Math.abs(clamped - k.t) > 1e-12) {
      k.t = clamped;
      moved = true;
    }
  }
  track.keys.sort((a, b) => a.t - b.t);
  return moved;
}

function liftKeys(track: RepairedTrack, tCenter: number, amount: number, window: number): boolean {
  let moved = false;
  for (const k of track.keys) {
    if (Math.abs(k.t - tCenter) <= window) {
      k.pose.position = { ...k.pose.position, y: k.pose.position.y + amount };
      moved = true;
    }
  }
  return moved;
}

// ── Dispatcher ──────────────────────────────────────────────────────────────

export function repairIssues(
  tracks: RepairedTrack[],
  issues: ValidationIssue[],
  ctx?: RepairContext,
): RepairOutcome {
  const work = cloneTracks(tracks);
  const byJoint = new Map(work.map((t) => [t.joint, t]));
  const limits = new Map((ctx?.limits ?? []).map((l) => [l.joint, l]));
  const applied: RepairAction[] = [];
  const unrepaired: UnrepairedIssue[] = [];

  const resolveSource = (): WorldPositionFn | undefined => {
    if (ctx?.makeWorldSource) return ctx.makeWorldSource(work);
    return ctx?.worldPos;
  };

  for (const issue of issues) {
    const track = issue.joint ? byJoint.get(issue.joint) : undefined;
    switch (issue.code) {
      case "JOINT_LIMIT":
      case "OVEREXTENSION":
      case "IMPOSSIBLE_ROTATION": {
        if (!track || issue.t === undefined) {
          unrepaired.push({ issue, reason: "no matching joint key" });
          break;
        }
        const limit = issue.joint ? limits.get(issue.joint) : undefined;
        if (!limit && issue.code !== "IMPOSSIBLE_ROTATION") {
          unrepaired.push({ issue, reason: "no limit calibrated for joint" });
          break;
        }
        const key = findKey(track.keys, issue.t);
        if (!key) {
          unrepaired.push({ issue, reason: "key vanished under repair" });
          break;
        }
        const fixed = clampKeyToLimit(
          key,
          limit ?? { joint: track.joint },
          ctx?.rests?.[track.joint],
        );
        key.pose.rotation = { ...fixed.pose.rotation };
        applied.push({
          issueCode: issue.code,
          joint: track.joint,
          t: issue.t,
          strategy: "clamp-to-limit",
          detail: `clamped "${track.joint}" at t=${issue.t} into calibrated range`,
        });
        break;
      }
      case "ACCELERATION_SPIKE":
      case "JERK_SPIKE":
      case "DISCONTINUITY": {
        if (!track || issue.t === undefined) {
          unrepaired.push({ issue, reason: "no matching joint key" });
          break;
        }
        if (smoothKeyAt(track, issue.t)) {
          applied.push({
            issueCode: issue.code,
            joint: track.joint,
            t: issue.t,
            strategy: "neighbor-smooth",
            detail: `rebuilt "${track.joint}" at t=${issue.t} from eased neighbors`,
          });
        } else {
          unrepaired.push({ issue, reason: "no surrounding keys to smooth from" });
        }
        break;
      }
      case "SPEED_SPIKE": {
        if (!track || issue.t === undefined) {
          unrepaired.push({ issue, reason: "no matching joint key" });
          break;
        }
        if (retimeWindow(track, issue.t, 1.25, 0.3)) {
          applied.push({
            issueCode: issue.code,
            joint: track.joint,
            t: issue.t,
            strategy: "retime-window",
            detail: `stretched ±0.3s around t=${issue.t} by 1.25x (order preserved)`,
          });
        } else {
          unrepaired.push({ issue, reason: "retime window immovable (pinned by neighbors)" });
        }
        break;
      }
      case "FOOT_SLIDE":
      case "CONTACT_BREAK":
      case "HAND_CONTACT_BREAK": {
        const spec = ctx?.contacts?.find(
          (s) => s.joint === issue.joint &&
            issue.t !== undefined &&
            issue.t >= s.startTime - 1e-9 &&
            issue.t <= s.endTime + 1e-9,
        );
        const src = resolveSource();
        if (!spec || !src || !track) {
          unrepaired.push({ issue, reason: !spec ? "no contact spec covers joint+time" : "no world source for repair" });
          break;
        }
        const shift = (joint: string, t: number, delta: Vec3): void => {
          const k = byJoint.get(joint)?.keys.find((x) => Math.abs(x.t - t) < 1e-9);
          if (k) {
            k.pose.position.x += delta.x;
            k.pose.position.y += delta.y;
            k.pose.position.z += delta.z;
          }
        };
        const report = solveContactLock(spec, track.keys, src, shift);
        applied.push({
          issueCode: issue.code,
          joint: track.joint,
          t: issue.t,
          strategy: "relock-contact",
          detail: `"${spec.name}": ${report.keysAdjusted} keys, ` +
            `${report.maxDriftBeforeStud.toFixed(3)}→${report.maxDriftAfterStud.toFixed(3)} studs`,
        });
        break;
      }
      case "GROUND_PENETRATION": {
        if (!track || issue.t === undefined || issue.measured === undefined) {
          unrepaired.push({ issue, reason: "no matching joint key or depth" });
          break;
        }
        if (liftKeys(track, issue.t, issue.measured + 0.05, 0.25)) {
          applied.push({
            issueCode: issue.code,
            joint: track.joint,
            t: issue.t,
            strategy: "lift-above-floor",
            detail: `lifted "${track.joint}" by ${(issue.measured + 0.05).toFixed(3)} studs near t=${issue.t}`,
          });
        } else {
          unrepaired.push({ issue, reason: "no keys near penetration time" });
        }
        break;
      }
      default: {
        unrepaired.push({ issue, reason: `no repair strategy for ${issue.code} (needs judgment or visual confirm)` });
        break;
      }
    }
  }
  return { tracks: work, applied, unrepaired };
}
