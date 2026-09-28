/**
 * RoLink animation critic — Task 8.1.
 *
 * Single structured entry point over every detector built so far:
 * joint limits, kinematics (style-aware spikes), contacts (mapped to
 * FOOT_SLIDE / HAND_CONTACT_BREAK / CONTACT_BREAK by contact type),
 * deformation, and self-intersection. Each suite runs only when its
 * data is present; the report lists exactly what ran and what was
 * SKIPPED and why — an unchecked box is never reported as passed.
 *
 * The critic judges; it never modifies tracks (see repair.ts).
 */

import type {
  ContactSpec,
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
  detectContactBreak,
  type WorldPositionFn,
} from "./contacts.js";
import {
  detectDeformation,
  detectFloorPenetration,
  detectSelfIntersection,
  type PositionSample,
  type SegmentRestLength,
  type VolumeSample,
} from "./collision.js";
import {
  analyzeKinematics,
  inferJointLimits,
  validateJointLimits,
  type LimitCheckInput,
} from "./validator.js";
import type { JointBinding } from "./jointAdapter.js";

export interface CriticInput {
  animation: string;
  tracks: Array<{ joint: string; keys: PoseKeyframe[] }>;
  bindings: JointBinding[];
  roles: Map<string, SemanticRole> | Record<string, SemanticRole>;
  style: StyleKind;
  contacts?: ContactSpec[];
  worldPos?: WorldPositionFn;
  volumes?: VolumeSample[];
  floorY?: number;
  segments?: SegmentRestLength[];
  /** Override inferred joint limits (per-rig calibration). */
  limits?: JointLimit[];
}

export interface CriticReport {
  animation: string;
  checkedAt: number;
  issues: ValidationIssue[];
  counts: Partial<Record<DefectCode, number>>;
  /** Suites that ran with real data. */
  checked: string[];
  /** Suites skipped for lack of data, with reasons. */
  skipped: Array<{ suite: string; reason: string }>;
  errorCount: number;
  warningCount: number;
}

function contactCode(spec: ContactSpec): DefectCode {
  if (spec.type === "FOOT" || spec.type === "GROUND") return "FOOT_SLIDE";
  if (spec.type === "HAND" || spec.type === "OBJECT") return "HAND_CONTACT_BREAK";
  return "CONTACT_BREAK";
}

export function criticize(input: CriticInput): CriticReport {
  const issues: ValidationIssue[] = [];
  const checked: string[] = [];
  const skipped: Array<{ suite: string; reason: string }> = [];
  const rests: Record<string, Transform3D> = {};
  for (const b of input.bindings) rests[b.name] = b.rest;

  // Joint limits (always available: inferred when not calibrated).
  const limits = input.limits ?? inferJointLimits(input.bindings, input.roles);
  const limitTracks: LimitCheckInput[] = input.tracks.map((t) => ({ joint: t.joint, keys: t.keys }));
  issues.push(...validateJointLimits(limitTracks, limits, rests));
  checked.push(limits.length > 0 ? `joint-limits (${limits.length} joints)` : "joint-limits (no constrained joints)");

  // Kinematics (always available: baked or sparse keys + style profile).
  issues.push(...analyzeKinematics(input.tracks, input.style));
  checked.push(`kinematics (${input.style})`);

  // Contacts (need specs + a world-position source).
  if (input.contacts && input.contacts.length > 0 && input.worldPos) {
    const byJoint = new Map(input.tracks.map((t) => [t.joint, t.keys]));
    for (const spec of input.contacts) {
      const keys = byJoint.get(spec.joint) ?? [];
      const verdict = detectContactBreak(
        { ...spec },
        keys,
        input.worldPos,
      );
      for (const b of verdict.breaks) {
        issues.push({
          code: contactCode(spec),
          category: "CONTACT",
          severity: "error",
          joint: spec.joint,
          t: b.t,
          message:
            `contact "${spec.name}" (${spec.type}) drifts ${b.driftStud.toFixed(3)} studs ` +
            `at t=${b.t} (tolerance ${spec.tolerance})`,
          measured: b.driftStud,
          threshold: spec.tolerance,
          suggestedFix: `re-lock "${spec.name}" around t=${b.t} (stiffness ${spec.stiffness})`,
        });
      }
    }
    checked.push(`contacts (${input.contacts.length} specs)`);
  } else if (input.contacts && input.contacts.length > 0) {
    skipped.push({ suite: "contacts", reason: "specs present but no world-position source" });
  }

  // Volumes: self-intersection + floor.
  if (input.volumes && input.volumes.length > 0) {
    issues.push(...detectSelfIntersection(input.volumes));
    checked.push(`self-intersection (${input.volumes.length} samples)`);
    if (input.floorY !== undefined) {
      issues.push(...detectFloorPenetration(input.volumes, input.floorY));
      checked.push(`floor (y=${input.floorY})`);
    }
  } else {
    skipped.push({ suite: "volumes", reason: "no volume samples (needs Studio/FK sampling)" });
  }

  // Deformation (needs rest segment lengths).
  if (input.segments && input.segments.length > 0) {
    const positionSamples: PositionSample[] = [];
    // Sort each track's key times once and advance a cursor per track, so
    // building samples is O(total keys) instead of O(times x keys).
    // Sort (key, time) PAIRS per track — sorting a parallel times array and
    // indexing back into the unsorted keys would misalign.
    const sortedByJoint = new Map<string, Array<{ t: number; pos: Vec3 }>>();
    const cursors = new Map<string, number>();
    for (const t of input.tracks) {
      const pairs = t.keys.map((k) => ({ t: k.t, pos: k.pose.position }));
      pairs.sort((a, b) => a.t - b.t);
      sortedByJoint.set(t.joint, pairs);
      cursors.set(t.joint, 0);
    }
    const times = new Set<number>();
    for (const t of input.tracks) for (const k of t.keys) times.add(k.t);
    for (const t of [...times].sort((a, b) => a - b)) {
      const positions: Record<string, { x: number; y: number; z: number }> = {};
      for (const [joint, pairs] of sortedByJoint) {
        let i = cursors.get(joint) ?? 0;
        while (i < pairs.length && pairs[i].t < t - 1e-6) i += 1;
        cursors.set(joint, i);
        if (i >= pairs.length) continue;
        if (Math.abs(pairs[i].t - t) >= 1e-6) continue;
        positions[joint] = { ...pairs[i].pos };
      }
      positionSamples.push({ t, positions });
    }
    issues.push(...detectDeformation(positionSamples, input.segments));
    checked.push(`deformation (${input.segments.length} segments)`);
  } else {
    skipped.push({ suite: "deformation", reason: "no rest segment lengths" });
  }

  const counts: Partial<Record<DefectCode, number>> = {};
  let errorCount = 0;
  let warningCount = 0;
  for (const i of issues) {
    counts[i.code] = (counts[i.code] ?? 0) + 1;
    if (i.severity === "error") errorCount += 1;
    else if (i.severity === "warning") warningCount += 1;
  }
  return {
    animation: input.animation,
    checkedAt: Date.now(),
    issues,
    counts,
    checked,
    skipped,
    errorCount,
    warningCount,
  };
}

// ── Visual review: frames, critiques, taxonomy (Tasks 9.2 + 9.3) ────────────
// Frames arrive from Studio (AnimationLab.captureFrame: schematic joint
// boxes today; raster pixels if a capture path ever exists) or from the
// extension's chat-page context. Critiques arrive from a vision-capable
// AI through the extension, validated here before they can block anything.

export type VisualModality = "pixels" | "schematic";

export type VisualDefectCode =
  | "WEAK_SILHOUETTE"
  | "STIFF_MOTION"
  | "BAD_FRAMING"
  | "VISIBLE_SNAPPING"
  | "INTERPENETRATION_VISIBLE"
  | "DETACHED_LIMB"
  | "HIDDEN_ACTION"
  | "TIMING_OFF";

export interface ViewportBox {
  joint: string;
  x: number;
  y: number;
  w: number;
  h: number;
  depth: number;
  visible: boolean;
}

export interface VisualFrame {
  frameId: string;
  animation: string;
  t: number;
  revision?: string;
  modality: VisualModality;
  width: number;
  height: number;
  mimeType?: "image/png" | "image/jpeg";
  /** Raster pixels when a capture path exists; absent for schematics. */
  dataBase64?: string;
  boxes?: ViewportBox[];
  capturedAt: number;
  pixels: boolean;
}

export interface VisualDefect {
  code: VisualDefectCode;
  severity: "error" | "warning";
  joint?: string;
  t?: number;
  message: string;
}

export interface VisualCritique {
  frameId: string;
  verdict: "pass" | "fail" | "inconclusive";
  defects: VisualDefect[];
  notes?: string;
  model?: string;
  modality: VisualModality;
}

export interface VisualReview {
  verification: "passed" | "failed" | "required";
  issues: ValidationIssue[];
  framesReviewed: number;
  unmatchedCritiques: string[];
}

/**
 * Defects a schematic can FLAG but never CERTIFY: without pixels, a
 * clean bill on these is downgraded to inconclusive (never to pass).
 */
export const PIXEL_ONLY_DEFECTS: ReadonlySet<VisualDefectCode> = new Set([
  "INTERPENETRATION_VISIBLE",
  "DETACHED_LIMB",
]);

/** Codes only the visual review may emit (the repair loop never iterates on these). */
export const VISUAL_CODES: ReadonlySet<string> = new Set([
  "WEAK_SILHOUETTE",
  "STIFF_MOTION",
  "BAD_FRAMING",
  "VISIBLE_SNAPPING",
  "INTERPENETRATION_VISIBLE",
  "DETACHED_LIMB",
  "HIDDEN_ACTION",
  "TIMING_OFF",
]);

const VISUAL_CODES_LIST: readonly string[] = [
  "WEAK_SILHOUETTE",
  "STIFF_MOTION",
  "BAD_FRAMING",
  "VISIBLE_SNAPPING",
  "INTERPENETRATION_VISIBLE",
  "DETACHED_LIMB",
  "HIDDEN_ACTION",
  "TIMING_OFF",
];

function isRecord(u: unknown): u is Record<string, unknown> {
  return typeof u === "object" && u !== null && !Array.isArray(u);
}

export function validateVisualCritique(u: unknown): u is VisualCritique {
  if (!isRecord(u)) return false;
  if (typeof u.frameId !== "string" || u.frameId.length === 0) return false;
  if (u.verdict !== "pass" && u.verdict !== "fail" && u.verdict !== "inconclusive") return false;
  if (u.modality !== "pixels" && u.modality !== "schematic") return false;
  if (!Array.isArray(u.defects)) return false;
  for (const d of u.defects) {
    if (!isRecord(d)) return false;
    if (typeof d.code !== "string" || !VISUAL_CODES_LIST.includes(d.code)) return false;
    if (d.severity !== "error" && d.severity !== "warning") return false;
    if (typeof d.message !== "string" || d.message.length === 0) return false;
  }
  if (u.verdict === "fail" && (u.defects as unknown[]).length === 0) return false;
  return true;
}

export function packageVisualFrame(init: {
  frameId: string;
  animation: string;
  t: number;
  revision?: string;
  width: number;
  height: number;
  boxes?: ViewportBox[];
  mimeType?: "image/png" | "image/jpeg";
  dataBase64?: string;
}): VisualFrame {
  const pixels = !!init.dataBase64;
  return {
    frameId: init.frameId,
    animation: init.animation,
    t: init.t,
    ...(init.revision !== undefined ? { revision: init.revision } : {}),
    modality: pixels ? "pixels" : "schematic",
    width: init.width,
    height: init.height,
    ...(init.mimeType ? { mimeType: init.mimeType } : {}),
    ...(init.dataBase64 ? { dataBase64: init.dataBase64 } : {}),
    ...(init.boxes ? { boxes: init.boxes.map((b) => ({ ...b })) } : {}),
    capturedAt: Date.now(),
    pixels,
  };
}

/**
 * Merge frame critiques into a terminal visual verdict.
 * Precedence: failed (a blocking defect was found) > required
 * (frames unreviewed, critiques inconclusive, or schematic overreach
 * on pixel-only codes) > passed.
 */
export function reviewVisuals(frames: VisualFrame[], critiques: VisualCritique[]): VisualReview {
  const byFrame = new Map(frames.map((f) => [f.frameId, f]));
  const unmatchedCritiques: string[] = [];
  const issues: ValidationIssue[] = [];
  let reviewed = 0;
  let failed = false;
  let incomplete = frames.length === 0;
  const seen = new Set<string>();

  for (const c of critiques) {
    const frame = byFrame.get(c.frameId);
    if (!frame) {
      unmatchedCritiques.push(c.frameId);
      continue;
    }
    if (seen.has(c.frameId)) continue;
    seen.add(c.frameId);
    reviewed += 1;
    let verdict = c.verdict;
    let defects = c.defects;
    if (c.modality === "schematic" || frame.modality === "schematic") {
      // Schematic PASS on pixel-only codes is not certification.
      const certifiable = defects.filter((d) => !PIXEL_ONLY_DEFECTS.has(d.code));
      if (verdict === "pass" && certifiable.length < defects.length) {
        verdict = "inconclusive";
        defects = certifiable;
      }
    }
    if (verdict === "fail") {
      failed = true;
      for (const d of defects) {
        issues.push({
          code: d.code,
          category: "STYLE",
          severity: d.severity,
          ...(d.joint ? { joint: d.joint } : {}),
          ...(d.t !== undefined ? { t: d.t } : {}),
          message: `[visual ${c.frameId}] ${d.message}`,
        });
      }
    } else if (verdict === "inconclusive") {
      incomplete = true;
    }
  }
  for (const f of frames) {
    if (!seen.has(f.frameId)) incomplete = true;
  }
  return {
    verification: failed ? "failed" : incomplete ? "required" : "passed",
    issues,
    framesReviewed: reviewed,
    unmatchedCritiques,
  };
}
