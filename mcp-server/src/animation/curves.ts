/**
 * RoLink curve solver — Tasks 3.2 + 3.3.
 *
 * Easing, quaternion interpolation, dense sampling, and motion arcs.
 *
 * PARITY RULE: easing formulas are mirrored 1:1 from the Studio plugin
 * (EASE_FNS in studio-plugin/RoLink.lua), including the [-0.15, 1.15]
 * overshoot clamp. The TS side is the authoring truth; Curves.lua replays
 * the same math in-Studio. If either changes, update both + the parity
 * tests (mcp-server/tests/curves.test.ts, tests/test_animation_curves.py).
 *
 * Rotation is ALWAYS spherical (slerp family) — never Euler lerp — so
 * baked motion has no gimbal-lock artifacts by construction.
 */

import type {
  EasingName,
  PoseKeyframe,
  PoseTrack,
  Quaternion,
  TrajectorySpec,
  Vec3,
} from "../../../shared/animationProtocol.js";
import {
  quatNlerp,
  quatNormalize,
  quatSlerp,
  quatSquad,
  quatSquadTangent,
} from "./quaternion.js";

export type InterpolationName = NonNullable<PoseKeyframe["interpolation"]>;

// ── Easing (1:1 with plugin EASE_FNS) ───────────────────────────────────────

export const EASING_FNS: Record<EasingName, (t: number) => number> = {
  linear: (t) => t,
  quadIn: (t) => t * t,
  quadOut: (t) => 1 - (1 - t) * (1 - t),
  quadInOut: (t) => {
    if (t < 0.5) return 2 * t * t;
    return 1 - ((-2 * t + 2) * (-2 * t + 2)) / 2;
  },
  cubicIn: (t) => t * t * t,
  cubicOut: (t) => 1 - (1 - t) * (1 - t) * (1 - t),
  cubicInOut: (t) => {
    if (t < 0.5) return 4 * t * t * t;
    return 1 - ((-2 * t + 2) * (-2 * t + 2) * (-2 * t + 2)) / 2;
  },
  sineIn: (t) => 1 - Math.cos((t * Math.PI) / 2),
  sineOut: (t) => Math.sin((t * Math.PI) / 2),
  sineInOut: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
  bezierOut: (t) => {
    const c1 = 1.2;
    const u = t - 1;
    return 1 + (c1 + 1) * u * u * u + c1 * u * u;
  },
  springOut: (t) => 1 - Math.exp(-5 * t) * Math.cos(9 * t),
};

const OVERSHOOT_EASINGS: ReadonlySet<string> = new Set(["bezierOut", "springOut"]);

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/** Eased fraction for a segment; overshoot family clamped like the plugin. */
export function applyEasing(name: EasingName | string | undefined, t: number): number {
  const key = (name ?? "linear") as EasingName;
  const fn = EASING_FNS[key] ?? EASING_FNS.linear;
  const v = fn(clamp01(t));
  if (OVERSHOOT_EASINGS.has(key)) {
    if (v > 1.15) return 1.15;
    if (v < -0.15) return -0.15;
  }
  return v;
}

// ── Vector helpers ──────────────────────────────────────────────────────────

export function lerpVec3(a: Vec3, b: Vec3, t: number): Vec3 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}

export function vecDistance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

// ── Key evaluation ──────────────────────────────────────────────────────────

export interface SampledPose {
  t: number;
  position: Vec3;
  rotation: Quaternion;
}

/**
 * Evaluate the segment k0→k1 at absolute time t.
 * Position: eased lerp. Rotation: selected spherical method
 * (step holds k0; linear→nlerp; everything else→slerp).
 */
export function sampleSegment(k0: PoseKeyframe, k1: PoseKeyframe, t: number): SampledPose {
  const span = k1.t - k0.t;
  const local = span <= 0 ? 1 : clamp01((t - k0.t) / span);
  const e = applyEasing(k1.easing ?? "linear", local);
  const interp: InterpolationName = k1.interpolation ?? "slerp";
  let rotation: Quaternion;
  if (interp === "step") {
    rotation = e < 1 ? { ...k0.pose.rotation } : { ...k1.pose.rotation };
  } else if (interp === "linear") {
    rotation = quatNlerp(k0.pose.rotation, k1.pose.rotation, e);
  } else {
    rotation = quatSlerp(k0.pose.rotation, k1.pose.rotation, e);
  }
  return { t, position: lerpVec3(k0.pose.position, k1.pose.position, e), rotation };
}

/**
 * Evaluate a full key list at time t with neighbor-aware squad support.
 * Out-of-range times clamp to the first/last pose.
 */
export function evaluateTrack(keys: PoseKeyframe[], t: number): SampledPose {
  if (keys.length === 0) {
    throw new Error("evaluateTrack: no keys");
  }
  const sorted = [...keys].sort((a, b) => a.t - b.t);
  if (t <= sorted[0].t) {
    return {
      t,
      position: { ...sorted[0].pose.position },
      rotation: { ...sorted[0].pose.rotation },
    };
  }
  const last = sorted[sorted.length - 1];
  if (t >= last.t) {
    return { t, position: { ...last.pose.position }, rotation: { ...last.pose.rotation } };
  }
  let i = 0;
  while (i < sorted.length - 2 && sorted[i + 1].t <= t) i += 1;
  const k0 = sorted[i];
  const k1 = sorted[i + 1];
  const interp: InterpolationName = k1.interpolation ?? "slerp";
  if (interp === "squad" && sorted.length >= 2) {
    const qPrev = i > 0 ? sorted[i - 1].pose.rotation : k0.pose.rotation;
    const qNext = i + 2 < sorted.length ? sorted[i + 2].pose.rotation : k1.pose.rotation;
    const span = k1.t - k0.t;
    const local = span <= 0 ? 1 : clamp01((t - k0.t) / span);
    const e = applyEasing(k1.easing ?? "linear", local);
    const tanA = quatSquadTangent(qPrev, k0.pose.rotation, k1.pose.rotation);
    const tanB = quatSquadTangent(k0.pose.rotation, k1.pose.rotation, qNext);
    return {
      t,
      position: lerpVec3(k0.pose.position, k1.pose.position, e),
      rotation: quatSquad(k0.pose.rotation, tanA, tanB, k1.pose.rotation, e),
    };
  }
  return sampleSegment(k0, k1, t);
}

// ── Motion arcs (Task 3.3) ──────────────────────────────────────────────────

export interface ResolvedArc {
  direction: Vec3;
  height: number;
  peak: number;
}

export function resolveArc(spec: TrajectorySpec | undefined): ResolvedArc | undefined {
  if (!spec) return undefined;
  const height = spec.arcHeight ?? 0;
  if (!(height > 0)) return undefined;
  const peak = Math.min(0.95, Math.max(0.05, (spec.peakTiming ?? 0.5) + (spec.arcBias ?? 0) * 0.25));
  const d = spec.direction ?? { x: 0, y: 1, z: 0 };
  const len = Math.hypot(d.x, d.y, d.z);
  if (!(len > 1e-9)) return undefined;
  return { direction: { x: d.x / len, y: d.y / len, z: d.z / len }, height, peak };
}

/**
 * Arc lift factor in [0,1]: 0 at both ends, 1 at the peak.
 * Asymmetric sine so arcBias/peakTiming move the apex honestly.
 */
export function arcLiftFactor(t01: number, peak: number): number {
  const t = clamp01(t01);
  const u = t < peak ? (0.5 * t) / peak : 1 - (0.5 * (1 - t)) / (1 - peak);
  return Math.sin(Math.PI * u);
}

export function applyArc(position: Vec3, t01: number, arc: ResolvedArc): Vec3 {
  const lift = arc.height * arcLiftFactor(t01, arc.peak);
  return {
    x: position.x + arc.direction.x * lift,
    y: position.y + arc.direction.y * lift,
    z: position.z + arc.direction.z * lift,
  };
}

// ── Dense sampling ──────────────────────────────────────────────────────────

export interface BakeOptions {
  fps?: number;
  /** Per-joint arc overrides, keyed by joint name. */
  arcs?: Record<string, TrajectorySpec>;
}

export interface BakedTrack {
  joint: string;
  keys: PoseKeyframe[];
  samples: number;
}

/** Sort keys by time (stable) and drop exact-duplicate times (keep last). */
export function normalizeKeys(keys: PoseKeyframe[]): PoseKeyframe[] {
  const sorted = [...keys].sort((a, b) => a.t - b.t);
  const out: PoseKeyframe[] = [];
  for (const k of sorted) {
    const prev = out[out.length - 1];
    if (prev && Math.abs(prev.t - k.t) < 1e-9) {
      out[out.length - 1] = k;
    } else {
      out.push(k);
    }
  }
  return out;
}

export function trackDuration(track: PoseTrack): number {
  if (track.keys.length === 0) return 0;
  return Math.max(...track.keys.map((k) => k.t));
}

/**
 * Bake a sparse track to dense linear keys at fps. Rotations stay
 * quaternion throughout; arcs lift positions per segment.
 */
export function bakeTrackDense(track: PoseTrack, opts?: BakeOptions): BakedTrack {
  const fps = Math.min(Math.max(opts?.fps ?? 30, 1), 120);
  const keys = normalizeKeys(track.keys);
  if (keys.length === 0) return { joint: track.joint, keys: [], samples: 0 };
  if (keys.length === 1) {
    const k = keys[0];
    return {
      joint: track.joint,
      keys: [
        {
          t: k.t,
          pose: {
            joint: track.joint,
            position: { ...k.pose.position },
            rotation: quatNormalize(k.pose.rotation),
            semanticRole: k.pose.semanticRole,
          },
          easing: "linear",
          interpolation: "linear",
        },
      ],
      samples: 1,
    };
  }
  const arc = resolveArc(opts?.arcs?.[track.joint]);
  const t0 = keys[0].t;
  const t1 = keys[keys.length - 1].t;
  const step = 1 / fps;
  const out: PoseKeyframe[] = [];
  let seg = 0;
  for (let t = t0; t <= t1 + 1e-9; t += step) {
    const tc = Math.min(t, t1);
    while (seg < keys.length - 2 && keys[seg + 1].t <= tc) seg += 1;
    const k0 = keys[seg];
    const k1 = keys[seg + 1];
    const span = k1.t - k0.t;
    const local = span <= 0 ? 1 : clamp01((tc - k0.t) / span);
    const s = sampleSegment(k0, k1, tc);
    const position = arc ? applyArc(s.position, local, arc) : s.position;
    out.push({
      t: tc,
      pose: {
        joint: track.joint,
        position,
        rotation: s.rotation,
        semanticRole: k1.pose.semanticRole,
      },
      easing: "linear",
      interpolation: "linear",
    });
  }
  return { joint: track.joint, keys: out, samples: out.length };
}

/** Largest rotation step (degrees) between adjacent baked keys. */
export function maxBakedAngleStep(baked: PoseKeyframe[]): number {
  let max = 0;
  for (let i = 1; i < baked.length; i += 1) {
    const a = (baked[i - 1].pose.rotation.w * baked[i].pose.rotation.w +
      baked[i - 1].pose.rotation.x * baked[i].pose.rotation.x +
      baked[i - 1].pose.rotation.y * baked[i].pose.rotation.y +
      baked[i - 1].pose.rotation.z * baked[i].pose.rotation.z);
    const ang = (2 * Math.acos(Math.min(1, Math.abs(a))) * 180) / Math.PI;
    max = Math.max(max, ang);
  }
  return max;
}
