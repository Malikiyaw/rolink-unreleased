/**
 * RoLink animation compiler — Task 8.3: the critic → repair → critic loop.
 *
 * GENERATE → ANALYZE → CRITIQUE → REPAIR → REANALYZE → FINALIZE, bounded
 * by a repair budget (default 5). Terminal states reuse the engine's
 * execution truth: READY_DATA (no errors remain; warnings ride along
 * listed) or FAILED (budget exhausted, no progress possible, or nothing
 * to repair with). The loop CANNOT hang: every iteration either consumes
 * budget or exits, and a pass that applies nothing exits immediately.
 *
 * Pass zero densifies sparse tracks so contact windows and spike repair
 * have keys to work on. Every pass re-criticizes from scratch — repairs
 * are verified, never assumed.
 */

import type {
  ContactSpec,
  JointLimit,
  SemanticRole,
  StyleKind,
  Transform3D,
  ValidationIssue,
} from "../../../shared/animationProtocol.js";
import { criticize, reviewVisuals, type CriticReport, type VisualCritique, type VisualFrame } from "./critic.js";
import { densifyKeys } from "./inbetween.js";
import { inferJointLimits } from "./validator.js";
import { repairIssues, type RepairAction, type RepairContext, type RepairedTrack } from "./repair.js";
import type { JointBinding } from "./jointAdapter.js";
import type { SegmentRestLength, VolumeSample } from "./collision.js";
import { rigidWorldSource, type WorldPositionFn } from "./contacts.js";

export interface CompilerInput {
  animation: string;
  tracks: RepairedTrack[];
  bindings: JointBinding[];
  roles: Map<string, SemanticRole> | Record<string, SemanticRole>;
  style: StyleKind;
  contacts?: ContactSpec[];
  /** Rigid-assembly world source is built internally when true. */
  rigidAssembly?: boolean;
  worldPos?: WorldPositionFn;
  volumes?: VolumeSample[];
  floorY?: number;
  segments?: SegmentRestLength[];
  limits?: JointLimit[];
  rests?: Record<string, Transform3D>;
  /** Repair budget. Default 5 (the Phase 8 exit criterion). */
  maxIterations?: number;
  densify?: { maxGapSec?: number; maxAngleDeg?: number; maxMoveStud?: number };
  /**
   * Visual review (Task 9.4). Frames from AnimationLab capture, critiques
   * from a vision-capable AI via the extension. Absent → the result stays
   * honestly at READY_DATA with visual "required" (never pretends pixels
   * were reviewed).
   */
  visual?: { frames: VisualFrame[]; critiques: VisualCritique[] };
}

export interface CompilerPass {
  iteration: number;
  errorCount: number;
  warningCount: number;
  applied: RepairAction[];
  unrepaired: Array<{ code: string; reason: string }>;
}

export interface CompilerResult {
  animation: string;
  status: "READY_DATA" | "READY_VISUAL" | "FAILED";
  tracks: RepairedTrack[];
  passes: CompilerPass[];
  iterations: number;
  converged: boolean;
  remainingIssues: ValidationIssue[];
  /** Visual verification state (Task 9.4). */
  visual: "passed" | "failed" | "required";
  failReason?: string;
}

const DEFAULT_BUDGET = 5;

export function compileAnimation(input: CompilerInput): CompilerResult {
  const budget = Math.min(Math.max(input.maxIterations ?? DEFAULT_BUDGET, 1), 25);
  const rests: Record<string, Transform3D> = { ...(input.rests ?? {}) };
  for (const b of input.bindings) {
    if (!rests[b.name]) rests[b.name] = b.rest;
  }

  // Pass zero: densify so windows and spikes have keys to work on.
  let tracks: RepairedTrack[] = input.tracks.map((t) => {
    const dense = densifyKeys(t.keys, input.densify ?? {});
    return { joint: t.joint, keys: dense.keys };
  });

  const worldPosFor = (current: RepairedTrack[]): WorldPositionFn | undefined => {
    if (input.worldPos) return input.worldPos;
    if (input.rigidAssembly) {
      const map: Record<string, RepairedTrack["keys"]> = {};
      for (const t of current) map[t.joint] = t.keys;
      return rigidWorldSource(map);
    }
    return undefined;
  };
  // Repair needs the same calibrated limits the critic judged by —
  // inference here keeps the two consistent when no override is given.
  const repairLimits = input.limits ?? inferJointLimits(input.bindings, input.roles);

  const runCritic = (current: RepairedTrack[]): CriticReport =>
    criticize({
      animation: input.animation,
      tracks: current,
      bindings: input.bindings,
      roles: input.roles,
      style: input.style,
      ...(input.contacts ? { contacts: input.contacts } : {}),
      ...(worldPosFor(current) ? { worldPos: worldPosFor(current) as WorldPositionFn } : {}),
      ...(input.volumes ? { volumes: input.volumes } : {}),
      ...(input.floorY !== undefined ? { floorY: input.floorY } : {}),
      ...(input.segments ? { segments: input.segments } : {}),
      ...(input.limits ? { limits: input.limits } : {}),
    });

  const passes: CompilerPass[] = [];
  let report = runCritic(tracks);
  let iteration = 0;
  // Visual review is a terminal judgment, never loop input: the repair
  // strategies cannot fix framing or silhouettes, so visual issues must
  // not spin the data loop (or insta-fail it).
  const visualReview = input.visual
    ? reviewVisuals(input.visual.frames, input.visual.critiques)
    : undefined;
  const visualState = visualReview ? visualReview.verification : "required";

  while (report.errorCount > 0 && iteration < budget) {
    iteration += 1;
    const errors = report.issues.filter((i) => i.severity === "error");
    const repairCtx: RepairContext = {
      rests,
      contacts: input.contacts,
      limits: repairLimits,
      ...(worldPosFor(tracks)
        ? {
          makeWorldSource: (current: RepairedTrack[]): WorldPositionFn => {
            if (input.worldPos) return input.worldPos;
            const map: Record<string, RepairedTrack["keys"]> = {};
            for (const t of current) map[t.joint] = t.keys;
            return rigidWorldSource(map);
          },
        }
        : {}),
    };
    const outcome = repairIssues(tracks, errors, repairCtx);
    const pass: CompilerPass = {
      iteration,
      errorCount: errors.length,
      warningCount: report.warningCount,
      applied: outcome.applied,
      unrepaired: outcome.unrepaired.map((u) => ({ code: u.issue.code, reason: u.reason })),
    };
    passes.push(pass);
    if (outcome.applied.length === 0) {
      return {
        animation: input.animation,
        status: "FAILED",
        tracks,
        passes,
        iterations: iteration,
        converged: false,
        remainingIssues: [...report.issues, ...(visualReview?.issues ?? [])],
        visual: visualState,
        failReason: `no repair applied on iteration ${iteration}: ` +
          `${outcome.unrepaired.map((u) => `${u.issue.code} (${u.reason})`).join("; ") || "nothing repairable"}`,
      };
    }
    tracks = outcome.tracks;
    report = runCritic(tracks);
  }

  if (report.errorCount > 0) {
    return {
      animation: input.animation,
      status: "FAILED",
      tracks,
      passes,
      iterations: iteration,
      converged: false,
      remainingIssues: [...report.issues, ...(visualReview?.issues ?? [])],
      visual: visualState,
      failReason: `repair budget exhausted (${budget} iterations): ` +
        `${report.issues.filter((i) => i.severity === "error").map((i) => i.code).join(", ")} remain`,
    };
  }
  const remaining = [...report.issues, ...(visualReview?.issues ?? [])];
  if (!visualReview) {
    return {
      animation: input.animation,
      status: "READY_DATA",
      tracks,
      passes,
      iterations: iteration,
      converged: true,
      remainingIssues: remaining,
      visual: "required",
    };
  }
  if (visualReview.verification === "failed") {
    return {
      animation: input.animation,
      status: "FAILED",
      tracks,
      passes,
      iterations: iteration,
      converged: false,
      remainingIssues: remaining,
      visual: "failed",
      failReason: `visual review failed: ` +
        `${visualReview.issues.map((i) => `${i.code}${i.joint ? ` on ${i.joint}` : ""}`).join("; ")}`,
    };
  }
  if (visualReview.verification === "passed") {
    return {
      animation: input.animation,
      status: "READY_VISUAL",
      tracks,
      passes,
      iterations: iteration,
      converged: true,
      remainingIssues: remaining,
      visual: "passed",
    };
  }
  return {
    animation: input.animation,
    status: "READY_DATA",
    tracks,
    passes,
    iterations: iteration,
    converged: true,
    remainingIssues: remaining,
    visual: "required",
  };
}
