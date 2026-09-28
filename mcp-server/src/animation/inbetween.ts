/**
 * RoLink in-between solver — Task 3.4.
 *
 * Two inverse operations on sparse key lists:
 *  - densifyKeys: insert evaluated midpoint keys until every segment fits
 *    inside gap/angle/move budgets (long segments would otherwise cut
 *    corners or pop through eased motion).
 *  - pruneKeys: drop keys that already lie on their neighbors' eased curve
 *    within tolerance (keeps sparse regions sparse for the 1024-key cap).
 *
 * Inserted keys carry the evaluated pose with the segment's easing tag, so
 * downstream sampling treats them as native curve points. Splitting an
 * eased segment is an approximation whose error shrinks quadratically with
 * the gap — the budgets below keep it far under validator thresholds.
 */

import type { PoseKeyframe } from "../../../shared/animationProtocol.js";
import { quatAngleBetween } from "./quaternion.js";
import { normalizeKeys, sampleSegment, vecDistance } from "./curves.js";

export interface DensifyOptions {
  maxGapSec?: number;
  maxAngleDeg?: number;
  maxMoveStud?: number;
  maxPasses?: number;
}

export interface DensifyReport {
  inserted: number;
  passes: number;
  longestGapSec: number;
}

export interface PruneOptions {
  posTolStud?: number;
  angleTolDeg?: number;
}

export interface PruneReport {
  removed: number;
}

function segmentNeedsSplit(
  k0: PoseKeyframe,
  k1: PoseKeyframe,
  opts: Required<Pick<DensifyOptions, "maxGapSec" | "maxAngleDeg" | "maxMoveStud">>,
): boolean {
  if (k1.t - k0.t > opts.maxGapSec) return true;
  if (quatAngleBetween(k0.pose.rotation, k1.pose.rotation) > (opts.maxAngleDeg * Math.PI) / 180) {
    return true;
  }
  if (vecDistance(k0.pose.position, k1.pose.position) > opts.maxMoveStud) return true;
  return false;
}

export function densifyKeys(keys: PoseKeyframe[], opts?: DensifyOptions): {
  keys: PoseKeyframe[];
  report: DensifyReport;
} {
  const budget = {
    maxGapSec: opts?.maxGapSec ?? 0.15,
    maxAngleDeg: opts?.maxAngleDeg ?? 25,
    maxMoveStud: opts?.maxMoveStud ?? 2,
  };
  const maxPasses = Math.min(Math.max(opts?.maxPasses ?? 8, 1), 16);
  let cur = normalizeKeys(keys);
  let inserted = 0;
  let passes = 0;
  for (let pass = 0; pass < maxPasses; pass += 1) {
    const next: PoseKeyframe[] = [];
    let splitInPass = false;
    for (let i = 0; i < cur.length; i += 1) {
      next.push(cur[i]);
      if (i + 1 < cur.length && segmentNeedsSplit(cur[i], cur[i + 1], budget)) {
        const tm = (cur[i].t + cur[i + 1].t) / 2;
        const mid = sampleSegment(cur[i], cur[i + 1], tm);
        next.push({
          t: tm,
          pose: {
            joint: cur[i + 1].pose.joint,
            position: mid.position,
            rotation: mid.rotation,
            semanticRole: cur[i + 1].pose.semanticRole,
          },
          easing: cur[i + 1].easing,
          interpolation: cur[i + 1].interpolation,
        });
        inserted += 1;
        splitInPass = true;
      }
    }
    cur = next;
    passes += 1;
    if (!splitInPass) break;
  }
  let longestGapSec = 0;
  for (let i = 1; i < cur.length; i += 1) {
    longestGapSec = Math.max(longestGapSec, cur[i].t - cur[i - 1].t);
  }
  return { keys: cur, report: { inserted, passes, longestGapSec } };
}

export function pruneKeys(keys: PoseKeyframe[], opts?: PruneOptions): {
  keys: PoseKeyframe[];
  report: PruneReport;
} {
  const posTol = opts?.posTolStud ?? 0.02;
  const angleTol = ((opts?.angleTolDeg ?? 1) * Math.PI) / 180;
  const cur = normalizeKeys(keys);
  if (cur.length <= 2) return { keys: cur, report: { removed: 0 } };
  const keep: boolean[] = cur.map(() => true);
  let removed = 0;
  for (let i = 1; i < cur.length - 1; i += 1) {
    const approx = sampleSegment(cur[i - 1], cur[i + 1], cur[i].t);
    const posErr = vecDistance(approx.position, cur[i].pose.position);
    const angErr = quatAngleBetween(approx.rotation, cur[i].pose.rotation);
    if (posErr <= posTol && angErr <= angleTol) {
      keep[i] = false;
      removed += 1;
    }
  }
  return { keys: cur.filter((_, i) => keep[i]), report: { removed } };
}
