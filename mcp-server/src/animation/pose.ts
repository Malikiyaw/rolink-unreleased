/**
 * RoLink pose generator — Task 3.1.
 *
 * Converts a MotionPlan + analyzed rig into SPARSE key poses, one per
 * motion beat per driven joint. This is deliberately NOT an LLM guessing
 * rotations: beat recipes are deterministic procedural offsets from each
 * joint's rest transform, scaled by intensity, style profile, and a seeded
 * RNG (reproducible; breaks robotic left/right symmetry).
 *
 * Pipeline position: poses → inbetween densify → curve bake → tracks.
 * Contact-accurate posing (IK-grounded hands/feet) arrives in Phase 4;
 * these poses are the meaningful extremes the solvers refine, replacing
 * the old attack/idle/walk scaffolds as the quality path (Phase 12).
 */

import type {
  EasingName,
  EulerDegrees,
  MotionBeatKind,
  MotionPlan,
  PoseKeyframe,
  Quaternion,
  SemanticRole,
  SemanticSkeleton,
  StyleKind,
  Vec3,
} from "../../../shared/animationProtocol.js";
import { DEFAULT_STYLE_PROFILES, eulerDegToQuat, makeJointPose } from "../../../shared/animationProtocol.js";
import type { JointBinding } from "./jointAdapter.js";
import { ARM_WORDS, LEG_WORDS, wordsOf } from "./semanticRig.js";
import { quatMultiply, quatNormalize } from "./quaternion.js";

export type GeneratedPoseRole =
  | "contact"
  | "extreme"
  | "anticipation"
  | "passing"
  | "impact"
  | "settle"
  | "key";

export type LimbSelector = "arm" | "leg" | "any";

export interface JointOffsetRecipe {
  roles: SemanticRole[];
  limb?: LimbSelector;
  position?: Vec3;
  rotationDeg?: EulerDegrees;
  easing?: EasingName;
  poseRole: GeneratedPoseRole;
}

export interface BeatRecipe {
  offsets: JointOffsetRecipe[];
  /** Emit a second key at beat end (used by REST/hold beats). */
  endKey?: boolean;
}

const ROOT_ROLES: SemanticRole[] = ["root", "locomotionRoot", "pelvis"];
const SPINE_ROLES: SemanticRole[] = ["spine", "chest"];
const ARM_ROLES: SemanticRole[] = ["limb", "hand", "endEffector"];
const LEG_ROLES: SemanticRole[] = ["limb", "foot", "endEffector"];
const HEAD_ROLES: SemanticRole[] = ["neck", "head"];

/**
 * Canonical beat recipes. Units: studs + degrees, applied in joint-local
 * space on top of the rest transform. Signs follow the R15 convention used
 * by the existing attack scaffold (negative X rotation swings arms
 * forward/up); per-rig calibration belongs to Phase 4 IK grounding.
 */
export const BEAT_RECIPES: Record<MotionBeatKind, BeatRecipe> = {
  REST: { offsets: [], endKey: true },
  ANTICIPATION: {
    offsets: [
      { roles: ROOT_ROLES, position: { x: 0, y: -0.25, z: 0 }, poseRole: "anticipation", easing: "quadOut" },
      { roles: SPINE_ROLES, rotationDeg: { x: 8, y: 0, z: 0 }, poseRole: "anticipation" },
      { roles: ARM_ROLES, limb: "arm", rotationDeg: { x: -12, y: 0, z: 0 }, poseRole: "anticipation" },
      { roles: LEG_ROLES, limb: "leg", rotationDeg: { x: 14, y: 0, z: 0 }, poseRole: "anticipation" },
      { roles: HEAD_ROLES, rotationDeg: { x: 4, y: 0, z: 0 }, poseRole: "anticipation" },
    ],
  },
  PREPARATION: {
    offsets: [
      { roles: ROOT_ROLES, position: { x: 0, y: -0.12, z: 0 }, poseRole: "key", easing: "quadInOut" },
      { roles: ARM_ROLES, limb: "arm", rotationDeg: { x: 22, y: 0, z: 0 }, poseRole: "passing" },
      { roles: SPINE_ROLES, rotationDeg: { x: -5, y: 0, z: 0 }, poseRole: "passing" },
    ],
  },
  ACCELERATION: {
    offsets: [
      { roles: ROOT_ROLES, position: { x: 0, y: 0.08, z: 0.2 }, poseRole: "passing", easing: "quadIn" },
      { roles: SPINE_ROLES, rotationDeg: { x: -6, y: 0, z: 0 }, poseRole: "passing" },
      { roles: ARM_ROLES, limb: "arm", rotationDeg: { x: -20, y: 0, z: 0 }, poseRole: "passing" },
    ],
  },
  PRIMARY_ACTION: {
    offsets: [
      { roles: ROOT_ROLES, position: { x: 0, y: 0.4, z: 0 }, poseRole: "extreme", easing: "quadOut" },
      { roles: ARM_ROLES, limb: "arm", rotationDeg: { x: -48, y: 0, z: 0 }, poseRole: "extreme" },
      { roles: SPINE_ROLES, rotationDeg: { x: -10, y: 0, z: 0 }, poseRole: "extreme" },
      { roles: HEAD_ROLES, rotationDeg: { x: -10, y: 0, z: 0 }, poseRole: "extreme" },
      { roles: LEG_ROLES, limb: "leg", rotationDeg: { x: -18, y: 0, z: 0 }, poseRole: "extreme" },
    ],
  },
  IMPACT: {
    offsets: [
      { roles: ROOT_ROLES, position: { x: 0, y: -0.35, z: 0 }, poseRole: "impact", easing: "quadIn" },
      { roles: SPINE_ROLES, rotationDeg: { x: 12, y: 0, z: 0 }, poseRole: "impact" },
      { roles: ARM_ROLES, limb: "arm", rotationDeg: { x: 30, y: 0, z: 0 }, poseRole: "impact" },
      { roles: LEG_ROLES, limb: "leg", rotationDeg: { x: 22, y: 0, z: 0 }, poseRole: "impact" },
    ],
  },
  FOLLOW_THROUGH: {
    offsets: [
      { roles: ROOT_ROLES, position: { x: 0, y: -0.1, z: 0 }, poseRole: "key", easing: "bezierOut" },
      { roles: ARM_ROLES, limb: "arm", rotationDeg: { x: 52, y: 0, z: 0 }, poseRole: "key" },
      { roles: SPINE_ROLES, rotationDeg: { x: 8, y: 0, z: 0 }, poseRole: "key" },
    ],
  },
  SETTLE: {
    offsets: [
      { roles: ROOT_ROLES, position: { x: 0, y: -0.04, z: 0 }, poseRole: "settle", easing: "springOut" },
      { roles: [...SPINE_ROLES, ...HEAD_ROLES], rotationDeg: { x: 2, y: 0, z: 0 }, poseRole: "settle" },
    ],
  },
};

export const POSE_ROLE_EASING: Record<GeneratedPoseRole, EasingName> = {
  contact: "quadInOut",
  extreme: "quadOut",
  anticipation: "quadOut",
  passing: "quadInOut",
  impact: "quadIn",
  settle: "springOut",
  key: "linear",
};

export interface PoseGenOptions {
  intensity?: number;
  seed?: number;
  style?: StyleKind;
}

export interface GeneratedTrack {
  joint: string;
  jointKind: JointBinding["kind"];
  semanticRole: SemanticRole;
  keys: PoseKeyframe[];
}

// ── Deterministic RNG (mulberry32 + string hash) ────────────────────────────

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Recipe matching ─────────────────────────────────────────────────────────

function limbMatches(name: string, limb: LimbSelector | undefined): boolean {
  if (!limb || limb === "any") return true;
  const words = wordsOf(name);
  const set = limb === "arm" ? ARM_WORDS : LEG_WORDS;
  return words.some((w) => set.has(w));
}

function styleScaleForBeat(profile: (typeof DEFAULT_STYLE_PROFILES)[StyleKind], kind: MotionBeatKind): number {
  switch (kind) {
    case "ANTICIPATION":
      return profile.anticipationScale;
    case "IMPACT":
      return profile.impactSharpness;
    case "FOLLOW_THROUGH":
      return profile.followThroughScale;
    default:
      return 1;
  }
}

// ── Generator ───────────────────────────────────────────────────────────────

export function generateSparsePoses(
  bindings: JointBinding[],
  skeleton: SemanticSkeleton,
  plan: MotionPlan,
  opts?: PoseGenOptions,
): GeneratedTrack[] {
  const intensity = Math.min(Math.max(opts?.intensity ?? 1, 0), 2);
  const seed = opts?.seed ?? 0;
  const style: StyleKind = opts?.style ?? plan.style;
  const profile = DEFAULT_STYLE_PROFILES[style] ?? DEFAULT_STYLE_PROFILES.REALISTIC;

  const roleByName = new Map(skeleton.joints.map((j) => [j.name, j.semanticRole]));
  const kindByName = new Map(bindings.map((b) => [b.name, b.kind]));
  const restByName = new Map(bindings.map((b) => [b.name, b.rest]));
  // Index by name once: the recipe loops below call applyRecipe for every
  // (beat x offset x joint) triple, so a linear scan here is O(n^3).
  const bindingByName = new Map(bindings.map((b) => [b.name, b]));

  const beats = [...plan.beats].sort((a, b) => a.start - b.start);
  const tracks = new Map<string, PoseKeyframe[]>();
  const meta = new Map<string, { jointKind: JointBinding["kind"]; semanticRole: SemanticRole }>();

  const ensureTrack = (joint: string): PoseKeyframe[] => {
    let t = tracks.get(joint);
    if (!t) {
      t = [];
      tracks.set(joint, t);
      meta.set(joint, {
        jointKind: kindByName.get(joint) ?? "Motor6D",
        semanticRole: roleByName.get(joint) ?? "unknown",
      });
    }
    return t;
  };

  const emitKey = (
    joint: string,
    t: number,
    pos: Vec3,
    rot: Quaternion,
    easing: EasingName,
  ): void => {
    ensureTrack(joint).push({
      t,
      pose: makeJointPose(joint, {
        position: pos,
        rotation: rot,
        semanticRole: roleByName.get(joint) ?? "unknown",
      }),
      easing,
      interpolation: "slerp",
    });
  };

  const applyRecipe = (
    joint: string,
    recipe: JointOffsetRecipe,
    t: number,
    scale: number,
  ): boolean => {
    const binding = bindingByName.get(joint);
    if (!binding) return false;
    // Model containers are never directly posable (PartCFrame needs a
    // BasePart); root motion belongs to the locomotionRoot part instead.
    if (binding.className === "Model") return false;
    if (!binding.drive.writable && binding.kind !== "Bone") return false;
    const role = roleByName.get(joint) ?? "unknown";
    if (!recipe.roles.includes(role)) return false;
    if (!limbMatches(joint, recipe.limb)) return false;
    const rng = mulberry32(hashString(`${seed}:${joint}:${t.toFixed(4)}`));
    const jitter = 1 + (rng() - 0.5) * 0.1;
    const k = intensity * scale * jitter;
    const rest = restByName.get(joint) ?? {
      position: { x: 0, y: 0, z: 0 },
      rotation: { w: 1, x: 0, y: 0, z: 0 },
    };
    const dp = recipe.position ?? { x: 0, y: 0, z: 0 };
    const dr = recipe.rotationDeg ?? { x: 0, y: 0, z: 0 };
    const pos: Vec3 = {
      x: rest.position.x + dp.x * k,
      y: rest.position.y + dp.y * k,
      z: rest.position.z + dp.z * k,
    };
    const drot = eulerDegToQuat({ x: dr.x * k, y: dr.y * k, z: dr.z * k });
    const rot = quatNormalize(quatMultiply(rest.rotation, drot));
    emitKey(joint, t, pos, rot, recipe.easing ?? POSE_ROLE_EASING[recipe.poseRole]);
    return true;
  };

  for (const beat of beats) {
    const recipe = BEAT_RECIPES[beat.kind];
    if (!recipe) continue;
    const scale = styleScaleForBeat(profile, beat.kind);
    const targets = beat.majorJoints && beat.majorJoints.length > 0
      ? bindings.filter((b) => beat.majorJoints?.includes(b.name)).map((b) => b.name)
      : bindings.map((b) => b.name);
    for (const offset of recipe.offsets) {
      for (const joint of targets) applyRecipe(joint, offset, beat.start, scale);
    }
    if (recipe.endKey) {
      const endT = beat.start + beat.duration;
      for (const joint of targets) {
        const track = tracks.get(joint);
        const last = track?.[track.length - 1];
        if (last && Math.abs(last.t - endT) > 1e-9) {
          emitKey(
            joint,
            endT,
            { ...last.pose.position },
            { ...last.pose.rotation },
            "linear",
          );
        }
      }
    }
    // Style overshoot: one key past the follow-through at 108% amplitude
    // (mirrors the plugin attack scaffold's strike overshoot).
    if (beat.kind === "FOLLOW_THROUGH" && profile.overshoot > 0) {
      const overT = beat.start + beat.duration * 0.6;
      for (const offset of recipe.offsets) {
        for (const joint of targets) {
          const binding = bindingByName.get(joint);
          if (!binding || binding.className === "Model") continue;
          if (!binding.drive.writable && binding.kind !== "Bone") continue;
          const role = roleByName.get(joint) ?? "unknown";
          if (!offset.roles.includes(role) || !limbMatches(joint, offset.limb)) continue;
          const rest = restByName.get(joint);
          if (!rest) continue;
          const k = intensity * scale * (1 + profile.overshoot);
          const dp = offset.position ?? { x: 0, y: 0, z: 0 };
          const dr = offset.rotationDeg ?? { x: 0, y: 0, z: 0 };
          emitKey(
            joint,
            overT,
            {
              x: rest.position.x + dp.x * k,
              y: rest.position.y + dp.y * k,
              z: rest.position.z + dp.z * k,
            },
            quatNormalize(
              quatMultiply(rest.rotation, eulerDegToQuat({ x: dr.x * k, y: dr.y * k, z: dr.z * k })),
            ),
            "bezierOut",
          );
        }
      }
    }
  }

  // Closing key: damped return toward rest at plan end so clips never
  // end mid-extreme.
  for (const [joint, keys] of tracks) {
    if (keys.length === 0) continue;
    const rest = restByName.get(joint);
    if (!rest) continue;
    // Single pass for lastT/last: keys are already time-sorted, so the last
    // element is the latest key (Math.max + reduce both re-scanned).
    const last = keys[keys.length - 1];
    const lastT = last.t;
    if (plan.duration - lastT > 1e-9) {
      const blend = 0.15 * intensity;
      emitKey(
        joint,
        plan.duration,
        {
          x: last.pose.position.x + (rest.position.x - last.pose.position.x) * blend,
          y: last.pose.position.y + (rest.position.y - last.pose.position.y) * blend,
          z: last.pose.position.z + (rest.position.z - last.pose.position.z) * blend,
        },
        quatNormalize({
          w: last.pose.rotation.w + (rest.rotation.w - last.pose.rotation.w) * blend,
          x: last.pose.rotation.x + (rest.rotation.x - last.pose.rotation.x) * blend,
          y: last.pose.rotation.y + (rest.rotation.y - last.pose.rotation.y) * blend,
          z: last.pose.rotation.z + (rest.rotation.z - last.pose.rotation.z) * blend,
        }),
        "springOut",
      );
    }
  }

  return [...tracks.entries()]
    .filter(([, keys]) => keys.length > 0)
    .map(([joint, keys]) => ({
      joint,
      jointKind: meta.get(joint)?.jointKind ?? "Motor6D",
      semanticRole: meta.get(joint)?.semanticRole ?? "unknown",
      keys: [...keys].sort((a, b) => a.t - b.t),
    }));
}
