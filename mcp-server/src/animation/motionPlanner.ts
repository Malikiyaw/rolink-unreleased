/**
 * RoLink motion planner — Task 6.3.
 *
 * Converts a user goal + style + duration into a structured MotionPlan:
 * eight ordered beats with style-dependent timing. The LLM authors intent
 * ("cinematic anime landing"); this module authors the TIMING, so pacing
 * is deterministic per style instead of guessed per prompt.
 *
 * Beat fractions sum to 1.0 per style (pinned by tests). Anime runs a
 * short anticipation, fast action, sharp impact, and long exaggerated
 * follow-through; realistic damps everything toward even pacing with a
 * long settle; mechanical barely anticipates at all.
 *
 * Style PROFILE definitions (thresholds, overshoot, secondary scale)
 * live in shared/animationProtocol.ts — this file adds only TIMING.
 */

import type {
  MotionBeat,
  MotionBeatKind,
  MotionPlan,
  StyleKind,
} from "../../../shared/animationProtocol.js";
import { STYLE_KINDS } from "../../../shared/animationProtocol.js";

export interface BeatTiming {
  /** Fraction of total duration. All eight sum to 1.0. */
  fraction: number;
  importance: number;
}

export const STYLE_BEAT_TIMING: Record<StyleKind, Record<MotionBeatKind, BeatTiming>> = {
  REALISTIC: {
    REST: { fraction: 0.08, importance: 0.2 },
    ANTICIPATION: { fraction: 0.10, importance: 0.5 },
    PREPARATION: { fraction: 0.12, importance: 0.5 },
    ACCELERATION: { fraction: 0.15, importance: 0.7 },
    PRIMARY_ACTION: { fraction: 0.15, importance: 0.9 },
    IMPACT: { fraction: 0.08, importance: 1 },
    FOLLOW_THROUGH: { fraction: 0.12, importance: 0.6 },
    SETTLE: { fraction: 0.20, importance: 0.4 },
  },
  CINEMATIC: {
    REST: { fraction: 0.10, importance: 0.3 },
    ANTICIPATION: { fraction: 0.16, importance: 0.7 },
    PREPARATION: { fraction: 0.12, importance: 0.6 },
    ACCELERATION: { fraction: 0.12, importance: 0.6 },
    PRIMARY_ACTION: { fraction: 0.14, importance: 0.9 },
    IMPACT: { fraction: 0.08, importance: 1 },
    FOLLOW_THROUGH: { fraction: 0.12, importance: 0.7 },
    SETTLE: { fraction: 0.16, importance: 0.5 },
  },
  ANIME: {
    REST: { fraction: 0.05, importance: 0.2 },
    ANTICIPATION: { fraction: 0.12, importance: 0.9 },
    PREPARATION: { fraction: 0.10, importance: 0.6 },
    ACCELERATION: { fraction: 0.10, importance: 0.7 },
    PRIMARY_ACTION: { fraction: 0.16, importance: 1 },
    IMPACT: { fraction: 0.07, importance: 1 },
    FOLLOW_THROUGH: { fraction: 0.20, importance: 0.9 },
    SETTLE: { fraction: 0.20, importance: 0.5 },
  },
  EXAGGERATED: {
    REST: { fraction: 0.05, importance: 0.2 },
    ANTICIPATION: { fraction: 0.16, importance: 0.9 },
    PREPARATION: { fraction: 0.10, importance: 0.6 },
    ACCELERATION: { fraction: 0.10, importance: 0.7 },
    PRIMARY_ACTION: { fraction: 0.18, importance: 1 },
    IMPACT: { fraction: 0.08, importance: 1 },
    FOLLOW_THROUGH: { fraction: 0.20, importance: 0.9 },
    SETTLE: { fraction: 0.13, importance: 0.4 },
  },
  MECHANICAL: {
    REST: { fraction: 0.10, importance: 0.2 },
    ANTICIPATION: { fraction: 0.03, importance: 0.1 },
    PREPARATION: { fraction: 0.12, importance: 0.5 },
    ACCELERATION: { fraction: 0.20, importance: 0.8 },
    PRIMARY_ACTION: { fraction: 0.20, importance: 0.9 },
    IMPACT: { fraction: 0.10, importance: 1 },
    FOLLOW_THROUGH: { fraction: 0.05, importance: 0.2 },
    SETTLE: { fraction: 0.20, importance: 0.3 },
  },
  CREATURE: {
    REST: { fraction: 0.10, importance: 0.3 },
    ANTICIPATION: { fraction: 0.12, importance: 0.7 },
    PREPARATION: { fraction: 0.10, importance: 0.5 },
    ACCELERATION: { fraction: 0.14, importance: 0.7 },
    PRIMARY_ACTION: { fraction: 0.16, importance: 0.9 },
    IMPACT: { fraction: 0.08, importance: 1 },
    FOLLOW_THROUGH: { fraction: 0.14, importance: 0.7 },
    SETTLE: { fraction: 0.16, importance: 0.5 },
  },
  CARTOON: {
    REST: { fraction: 0.06, importance: 0.2 },
    ANTICIPATION: { fraction: 0.14, importance: 0.8 },
    PREPARATION: { fraction: 0.10, importance: 0.6 },
    ACCELERATION: { fraction: 0.12, importance: 0.7 },
    PRIMARY_ACTION: { fraction: 0.16, importance: 1 },
    IMPACT: { fraction: 0.08, importance: 1 },
    FOLLOW_THROUGH: { fraction: 0.18, importance: 0.8 },
    SETTLE: { fraction: 0.16, importance: 0.5 },
  },
  SUBTLE: {
    REST: { fraction: 0.15, importance: 0.3 },
    ANTICIPATION: { fraction: 0.08, importance: 0.4 },
    PREPARATION: { fraction: 0.12, importance: 0.4 },
    ACCELERATION: { fraction: 0.12, importance: 0.5 },
    PRIMARY_ACTION: { fraction: 0.12, importance: 0.7 },
    IMPACT: { fraction: 0.06, importance: 0.8 },
    FOLLOW_THROUGH: { fraction: 0.10, importance: 0.5 },
    SETTLE: { fraction: 0.25, importance: 0.4 },
  },
};

export const MOTION_BEAT_SEQUENCE: readonly MotionBeatKind[] = [
  "REST",
  "ANTICIPATION",
  "PREPARATION",
  "ACCELERATION",
  "PRIMARY_ACTION",
  "IMPACT",
  "FOLLOW_THROUGH",
  "SETTLE",
];

export interface PlanMotionOptions {
  majorJoints?: string[];
  cameraNote?: string;
}

/**
 * Build a full 8-beat MotionPlan from goal + style + duration.
 * Deterministic: same inputs always produce the same plan.
 */
export function planMotion(
  goal: string,
  target: string,
  style: StyleKind,
  duration: number,
  opts?: PlanMotionOptions,
): MotionPlan {
  if (!(STYLE_KINDS as readonly string[]).includes(style)) {
    throw new Error(`planMotion: unknown style "${style}"`);
  }
  if (!(duration > 0)) throw new Error("planMotion: duration must be positive");
  const timing = STYLE_BEAT_TIMING[style];
  const beats: MotionBeat[] = [];
  let start = 0;
  for (const kind of MOTION_BEAT_SEQUENCE) {
    const t = timing[kind];
    const beatDuration = duration * t.fraction;
    beats.push({
      kind,
      start,
      duration: beatDuration,
      importance: t.importance,
      style,
      ...(opts?.majorJoints && opts.majorJoints.length > 0 ? { majorJoints: [...opts.majorJoints] } : {}),
      ...(opts?.cameraNote ? { cameraNote: opts.cameraNote } : {}),
    });
    start += beatDuration;
  }
  // Absorb float residue into the final beat so the plan ends exactly on time.
  const residue = duration - start;
  if (Math.abs(residue) > 1e-12) {
    beats[beats.length - 1].duration += residue;
  }
  return { goal, target, style, duration, beats };
}

/** Duration of one beat kind under a style (seconds, for tests/prompts). */
export function beatDuration(style: StyleKind, kind: MotionBeatKind, total: number): number {
  return total * (STYLE_BEAT_TIMING[style]?.[kind]?.fraction ?? 0);
}
