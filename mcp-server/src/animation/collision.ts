/**
 * RoLink interpenetration detection — Tasks 5.4 + 5.5.
 *
 * Broad-phase AABB overlap over caller-supplied body volumes, narrowed by
 * joint-aware topology filtering: parent/child parts and the two ends of
 * one joint ALWAYS overlap by design and are never reported. What remains
 * is suspicious until proven intentional — SELF_INTERSECTION stays a
 * warning (clothing and hair intersect legitimately; pixels decide in
 * Phase 9), while floor penetration and impossible stretch are errors.
 *
 * This module never sees live instances: volumes come from enriched
 * Studio payloads (Collision.lua partVolumes), FK models, or tests.
 */

import type { DefectCode, ValidationIssue, Vec3 } from "../../../shared/animationProtocol.js";
import type { JointBinding } from "./jointAdapter.js";

export interface BodyVolume {
  name: string;
  center: Vec3;
  half: Vec3;
}

export interface VolumeSample {
  t: number;
  volumes: BodyVolume[];
}

export interface OverlapFinding {
  a: string;
  b: string;
  t: number;
  penetrationStud: number;
  volumeRatio: number;
}

/** Canonical unordered pair key. */
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Intentional-connection set from rig topology: parent↔child links plus
 * joint endpoint pairs (Part0/Part1, from enriched payloads when known).
 * Pairs in this set are skipped by every detector below.
 */
export function buildAdjacency(
  bindings: JointBinding[],
  endpointPairs?: Array<[string, string]>,
): Set<string> {
  const adj = new Set<string>();
  const byName = new Map(bindings.map((b) => [b.name, b]));
  for (const b of bindings) {
    if (b.parent !== undefined && byName.has(b.parent)) {
      adj.add(pairKey(b.name, b.parent));
    }
    for (const c of b.children) {
      if (byName.has(c)) adj.add(pairKey(b.name, c));
    }
  }
  for (const [p0, p1] of endpointPairs ?? []) {
    adj.add(pairKey(p0, p1));
  }
  return adj;
}

export function aabbOverlap(
  a: BodyVolume,
  b: BodyVolume,
): { overlap: boolean; penetrationStud: number; volumeRatio: number } {
  const ox = Math.min(a.center.x + a.half.x, b.center.x + b.half.x) -
    Math.max(a.center.x - a.half.x, b.center.x - b.half.x);
  const oy = Math.min(a.center.y + a.half.y, b.center.y + b.half.y) -
    Math.max(a.center.y - a.half.y, b.center.y - b.half.y);
  const oz = Math.min(a.center.z + a.half.z, b.center.z + b.half.z) -
    Math.max(a.center.z - a.half.z, b.center.z - b.half.z);
  if (ox <= 0 || oy <= 0 || oz <= 0) {
    return { overlap: false, penetrationStud: 0, volumeRatio: 0 };
  }
  const overlapVol = ox * oy * oz;
  const volA = 8 * a.half.x * a.half.y * a.half.z;
  const volB = 8 * b.half.x * b.half.y * b.half.z;
  const smaller = Math.min(volA, volB);
  return {
    overlap: true,
    penetrationStud: Math.min(ox, oy, oz),
    volumeRatio: smaller > 1e-9 ? overlapVol / smaller : 0,
  };
}

/** All non-adjacent overlaps at one timestamp. */
export function scanSampleOverlaps(
  sample: VolumeSample,
  adjacency?: Set<string>,
): OverlapFinding[] {
  const out: OverlapFinding[] = [];
  const vols = sample.volumes;
  for (let i = 0; i < vols.length; i += 1) {
    for (let j = i + 1; j < vols.length; j += 1) {
      const a = vols[i];
      const b = vols[j];
      if (a.name === b.name) continue;
      if (adjacency?.has(pairKey(a.name, b.name))) continue;
      const hit = aabbOverlap(a, b);
      if (hit.overlap) {
        out.push({ a: a.name, b: b.name, t: sample.t, penetrationStud: hit.penetrationStud, volumeRatio: hit.volumeRatio });
      }
    }
  }
  return out;
}

function issue(
  code: DefectCode,
  category: ValidationIssue["category"],
  severity: ValidationIssue["severity"],
  message: string,
  extra?: Partial<ValidationIssue>,
): ValidationIssue {
  return { code, category, severity, message, ...extra };
}

export function detectSelfIntersection(
  samples: VolumeSample[],
  adjacency?: Set<string>,
  minPenetrationStud = 0.05,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const seen = new Set<string>();
  for (const s of samples) {
    for (const f of scanSampleOverlaps(s, adjacency)) {
      if (f.penetrationStud < minPenetrationStud) continue;
      const key = `${pairKey(f.a, f.b)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      issues.push(
        issue(
          "SELF_INTERSECTION",
          "GEOMETRY",
          "warning",
          `"${f.a}" intersects "${f.b}" (${f.penetrationStud.toFixed(2)} studs, ` +
            `${Math.round(f.volumeRatio * 100)}% of smaller volume) — verify visually`,
          { t: f.t, measured: f.penetrationStud },
        ),
      );
    }
  }
  return issues;
}

export function detectFloorPenetration(
  samples: VolumeSample[],
  floorY: number,
  joints?: string[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const seen = new Set<string>();
  // Set lookup: this runs per volume per sample (samples x volumes x
  // joints with Array.includes).
  const jointFilter = joints ? new Set(joints) : undefined;
  for (const s of samples) {
    for (const v of s.volumes) {
      if (jointFilter && !jointFilter.has(v.name)) continue;
      if (!(v.half.x > 0 && v.half.y > 0 && v.half.z > 0)) continue;
      const minY = v.center.y - v.half.y;
      if (minY < floorY - 1e-9 && !seen.has(v.name)) {
        seen.add(v.name);
        issues.push(
          issue("GROUND_PENETRATION", "GEOMETRY", "error",
            `"${v.name}" sinks ${(floorY - minY).toFixed(2)} studs below floor y=${floorY} at t=${s.t}`,
            { joint: v.name, t: s.t, measured: floorY - minY, threshold: 0,
              suggestedFix: `lift "${v.name}" by ${(floorY - minY).toFixed(2)} studs or lock a foot contact` }),
        );
      }
    }
  }
  return issues;
}

export interface SegmentRestLength {
  a: string;
  b: string;
  restStud: number;
}

export interface PositionSample {
  t: number;
  positions: Record<string, Vec3>;
}

export function detectDeformation(
  samples: PositionSample[],
  segments: SegmentRestLength[],
  opts?: { maxStretch?: number; maxCompression?: number },
): ValidationIssue[] {
  const maxStretch = opts?.maxStretch ?? 0.15;
  const maxCompression = opts?.maxCompression ?? 0.15;
  const issues: ValidationIssue[] = [];
  const seen = new Set<string>();
  for (const s of samples) {
    for (const seg of segments) {
      const pa = s.positions[seg.a];
      const pb = s.positions[seg.b];
      if (!pa || !pb || !(seg.restStud > 1e-9)) continue;
      const cur = Math.hypot(pa.x - pb.x, pa.y - pb.y, pa.z - pb.z);
      const ratio = cur / seg.restStud;
      const key = `${seg.a}|${seg.b}`;
      if (ratio > 1 + maxStretch && !seen.has(`+${key}`)) {
        seen.add(`+${key}`);
        issues.push(
          issue("EXCESSIVE_STRETCH", "GEOMETRY", "error",
            `"${seg.a}"→"${seg.b}" stretched to ${Math.round(ratio * 100)}% of rest ` +
              `(${cur.toFixed(2)} vs ${seg.restStud.toFixed(2)} studs) at t=${s.t}`,
            { t: s.t, measured: ratio, threshold: 1 + maxStretch,
              suggestedFix: `shorten the "${seg.a}"→"${seg.b}" span or move the keys closer` }),
        );
      }
      if (ratio < 1 - maxCompression && !seen.has(`-${key}`)) {
        seen.add(`-${key}`);
        issues.push(
          issue("EXCESSIVE_COMPRESSION", "GEOMETRY", "error",
            `"${seg.a}"→"${seg.b}" compressed to ${Math.round(ratio * 100)}% of rest ` +
              `(${cur.toFixed(2)} vs ${seg.restStud.toFixed(2)} studs) at t=${s.t}`,
            { t: s.t, measured: ratio, threshold: 1 - maxCompression,
              suggestedFix: `separate "${seg.a}" and "${seg.b}" toward rest length` }),
        );
      }
    }
  }
  return issues;
}
