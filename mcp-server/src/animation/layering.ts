/**
 * RoLink animation layering — Tasks 7.1 + 7.2.
 *
 * Composites per-joint tracks from stacked layers (BASE → … → IK) into
 * one final track per joint by sampling every layer and applying, in
 * priority order, override / additive / multiply blending under per-layer
 * masks and fade envelopes.
 *
 * Conflict policy (deterministic, no fighting): enabled override layers
 * covering the same joint resolve by priority — highest wins, and
 * detectLayerConflicts REPORTS every such contest for the critic
 * (Phase 8). Additive layers compose and never conflict. Disabled layers
 * are invisible. Fades ramp weight linearly from the clip edges.
 *
 * Reuses shared AnimationLayer (kind/mask/weight/priority/blendMode/
 * fadeIn/fadeOut/enabled) and curves.evaluateTrack, so layer tracks keep
 * their easing, slerp, and squad behavior through the composite.
 */

import type {
  AnimationLayer,
  BlendMode,
  LayerKind,
  PoseKeyframe,
  Quaternion,
  Vec3,
} from "../../../shared/animationProtocol.js";
import { evaluateTrack } from "./curves.js";
import { quatMultiply, quatNormalize, quatSlerp } from "./quaternion.js";

export interface LayerTrackInput {
  layer: AnimationLayer;
  tracks: Array<{ joint: string; keys: PoseKeyframe[] }>;
}

export interface CompositeOptions {
  fps?: number;
  duration?: number;
  rests?: Record<string, { position: Vec3; rotation: Quaternion }>;
}

export interface LayerConflict {
  joint: string;
  layers: string[];
  winner: string;
  reason: string;
}

// ── Layer defaults ──────────────────────────────────────────────────────────

export const DEFAULT_LAYER_PRIORITY: Record<LayerKind, number> = {
  BASE: 0,
  LOCOMOTION: 10,
  LOWER_BODY: 20,
  UPPER_BODY: 30,
  HEAD: 40,
  HANDS: 50,
  FACE: 60,
  SECONDARY: 70,
  PROCEDURAL: 80,
  IK: 90,
};

export const DEFAULT_LAYER_BLEND: Record<LayerKind, BlendMode> = {
  BASE: "override",
  LOCOMOTION: "override",
  LOWER_BODY: "override",
  UPPER_BODY: "override",
  HEAD: "override",
  HANDS: "override",
  FACE: "override",
  SECONDARY: "additive",
  PROCEDURAL: "override",
  IK: "override",
};

export function defaultLayer(kind: LayerKind, mask?: string[]): AnimationLayer {
  return {
    kind,
    mask: mask ? [...mask] : [],
    weight: 1,
    priority: DEFAULT_LAYER_PRIORITY[kind],
    blendMode: DEFAULT_LAYER_BLEND[kind],
    enabled: kind === "BASE",
  };
}

// ── Weight envelopes ────────────────────────────────────────────────────────

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/** Effective weight at time t over a clip of `duration` seconds. */
export function resolveLayerWeight(layer: AnimationLayer, t: number, duration: number): number {
  if (!layer.enabled) return 0;
  const w = layer.weight;
  const fadeIn = Math.max(0, layer.fadeIn ?? 0);
  const fadeOut = Math.max(0, layer.fadeOut ?? 0);
  let f = 1;
  if (fadeIn > 0 && duration > 0) f = Math.min(f, clamp01(t / fadeIn));
  if (fadeOut > 0 && duration > 0) f = Math.min(f, clamp01((duration - t) / fadeOut));
  return w * f;
}

// ── Conflict detection ──────────────────────────────────────────────────────

function layerCovers(layer: AnimationLayer, joint: string, maskSet?: Set<string>): boolean {
  if (layer.mask.length === 0) return true;
  if (maskSet) return maskSet.has(joint);
  return layer.mask.includes(joint);
}

/** Mask as a Set — the composite loop calls this per sample per layer. */
function maskSetOf(layer: AnimationLayer): Set<string> | undefined {
  return layer.mask.length > 0 ? new Set(layer.mask) : undefined;
}

export function detectLayerConflicts(layers: AnimationLayer[]): LayerConflict[] {
  const active = layers.filter((l) => l.enabled && l.weight > 0 && l.blendMode === "override");
  // Universe = every joint any override layer covers. Unmasked (global)
  // layers cover each of them, so they contest everywhere.
  const universe = new Set<string>();
  for (const l of active) {
    for (const j of l.mask) universe.add(j);
  }
  const conflicts: LayerConflict[] = [];
  for (const joint of universe) {
    const contenders = active.filter((l) => layerCovers(l, joint));
    if (contenders.length > 1) {
      const winner = [...contenders].sort((a, b) => b.priority - a.priority)[0];
      conflicts.push({
        joint,
        layers: contenders.map((l) => l.kind),
        winner: winner.kind,
        reason: `${contenders.map((l) => l.kind).join(" vs ")} write "${joint}" — priority wins (${winner.kind})`,
      });
    }
  }
  return conflicts;
}

// ── Compositing ─────────────────────────────────────────────────────────────

export interface CompositedTrack {
  joint: string;
  keys: PoseKeyframe[];
}

function blendPoses(
  basePos: Vec3,
  baseRot: Quaternion,
  layerPos: Vec3,
  layerRot: Quaternion,
  rest: { position: Vec3; rotation: Quaternion } | undefined,
  mode: BlendMode,
  w: number,
): { position: Vec3; rotation: Quaternion } {
  if (w <= 0) return { position: { ...basePos }, rotation: { ...baseRot } };
  if (mode === "override") {
    return {
      position: {
        x: basePos.x + (layerPos.x - basePos.x) * w,
        y: basePos.y + (layerPos.y - basePos.y) * w,
        z: basePos.z + (layerPos.z - basePos.z) * w,
      },
      rotation: quatSlerp(baseRot, layerRot, w),
    };
  }
  if (mode === "additive") {
    const r = rest ?? { position: { x: 0, y: 0, z: 0 }, rotation: { w: 1, x: 0, y: 0, z: 0 } };
    const invRest = quatNormalize({ w: r.rotation.w, x: -r.rotation.x, y: -r.rotation.y, z: -r.rotation.z });
    const layerDelta = quatMultiply(invRest, layerRot);
    const scaled = quatSlerp({ w: 1, x: 0, y: 0, z: 0 }, layerDelta, w);
    return {
      position: {
        x: basePos.x + (layerPos.x - r.position.x) * w,
        y: basePos.y + (layerPos.y - r.position.y) * w,
        z: basePos.z + (layerPos.z - r.position.z) * w,
      },
      rotation: quatMultiply(baseRot, scaled),
    };
  }
  // multiply: positional scale about rest, rotational slerp toward layer.
  const r = rest ?? { position: { x: 0, y: 0, z: 0 }, rotation: { w: 1, x: 0, y: 0, z: 0 } };
  const scale = (layer: number, base: number): number => {
    if (Math.abs(base) < 1e-9) return layer * w;
    return base * (1 + (layer / base - 1) * w);
  };
  return {
    position: {
      x: r.position.x + (scale(layerPos.x, basePos.x) - r.position.x),
      y: r.position.y + (scale(layerPos.y, basePos.y) - r.position.y),
      z: r.position.z + (scale(layerPos.z, basePos.z) - r.position.z),
    },
    rotation: quatSlerp(baseRot, layerRot, w),
  };
}

export function compositeLayers(
  inputs: LayerTrackInput[],
  opts?: CompositeOptions,
): CompositedTrack[] {
  const fps = Math.min(Math.max(opts?.fps ?? 30, 1), 120);
  const enabled = inputs.filter((i) => i.layer.enabled);
  if (enabled.length === 0) return [];
  let duration = opts?.duration;
  if (duration === undefined) {
    duration = 0;
    for (const input of enabled) {
      for (const track of input.tracks) {
        for (const k of track.keys) duration = Math.max(duration ?? 0, k.t);
      }
    }
  }
  const joints = new Set<string>();
  for (const input of enabled) {
    for (const track of input.tracks) joints.add(track.joint);
  }
  const ordered = [...enabled].sort((a, b) => a.layer.priority - b.layer.priority);
  const maskSets = new Map<AnimationLayer, Set<string> | undefined>();
  for (const input of ordered) maskSets.set(input.layer, maskSetOf(input.layer));
  const byJointLayer = new Map<string, Map<string, PoseKeyframe[]>>();
  for (const input of ordered) {
    for (const track of input.tracks) {
      let m = byJointLayer.get(track.joint);
      if (!m) {
        m = new Map();
        byJointLayer.set(track.joint, m);
      }
      m.set(input.layer.kind, track.keys);
    }
  }
  const step = 1 / fps;
  const out: CompositedTrack[] = [];
  for (const joint of joints) {
    const perLayer = byJointLayer.get(joint) ?? new Map<string, PoseKeyframe[]>();
    const rest = opts?.rests?.[joint];
    let role: CompositedTrack["keys"][number]["pose"]["semanticRole"] = "unknown";
    for (const input of ordered) {
      const tk = perLayer.get(input.layer.kind);
      if (tk && tk.length > 0) {
        role = tk[0].pose.semanticRole;
        break;
      }
    }
    const keys: PoseKeyframe[] = [];
    for (let t = 0; t <= (duration ?? 0) + 1e-9; t += step) {
      const tc = Math.min(t, duration ?? 0);
      // Seed from rest when known (fades stay exact); otherwise the first
      // contributing layer seeds at full value (its weight is then moot —
      // provide rests for exact faded seeding).
      let pos: Vec3 | undefined = rest ? { ...rest.position } : undefined;
      let rot: Quaternion | undefined = rest ? { ...rest.rotation } : undefined;
      for (const input of ordered) {
        const keysForLayer = perLayer.get(input.layer.kind);
        if (!keysForLayer || keysForLayer.length === 0) continue;
        if (!layerCovers(input.layer, joint, maskSets.get(input.layer))) continue;
        const w = resolveLayerWeight(input.layer, tc, duration ?? 0);
        if (w <= 0) continue;
        const sample = evaluateTrack(keysForLayer, tc);
        if (!pos || !rot) {
          pos = { ...sample.position };
          rot = { ...sample.rotation };
          continue;
        }
        const blended = blendPoses(pos, rot, sample.position, sample.rotation, rest, input.layer.blendMode, w);
        pos = blended.position;
        rot = blended.rotation;
      }
      if (pos && rot) {
        keys.push({
          t: tc,
          pose: { joint, position: pos, rotation: rot, semanticRole: role },
          easing: "linear",
          interpolation: "linear",
        });
      }
    }
    if (keys.length > 0) out.push({ joint, keys });
  }
  return out;
}
