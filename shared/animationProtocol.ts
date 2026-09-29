/**
 * RoLink Animation Protocol v1 — shared Animation Intermediate Representation (IR)
 *
 * Shared between extension, bridge, MCP server, and Studio plugin tooling.
 * Pure TypeScript with zero dependencies (same constraint as shared/protocol.ts)
 * so it stays importable from Node (mcp-server), the browser extension, and
 * any Python-side JSON validation that mirrors these shapes.
 *
 * Task 1.1 scope: TYPES ONLY. No solving, no interpolation, no IK math.
 * Full quaternion/curve/IK engines land in mcp-server/src/animation/* (Tasks 1.2+).
 * This file defines the data contract every later phase operates on.
 *
 * Core rules (from the retired Animation Engine v3 plan; kept inline so the
 * invariants stay documented at the contract they govern):
 *  - R1: quaternions are authoritative internally; Euler degrees are input-only.
 *  - R2: every tool operates on this IR; no per-tool ad-hoc formats.
 *  - R24/R30: terminal states are CREATED → SOLVING → VALIDATING → REPAIRING
 *    → READY_DATA → READY_VISUAL → FAILED. Never report "done" without one.
 */

export const ANIMATION_IR_VERSION = 1;

// ── Primitives ─────────────────────────────────────────────────────────────

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Unit quaternion (w + xi + yj + zk). Always normalized when produced by factories. */
export interface Quaternion {
  w: number;
  x: number;
  y: number;
  z: number;
}

/** Human/AI-facing Euler angles in degrees. Input convenience only. */
export interface EulerDegrees {
  x: number;
  y: number;
  z: number;
}

export interface Transform3D {
  position: Vec3;
  rotation: Quaternion;
  scale?: Vec3;
}

// ── Enumerations (string unions keep JSON stable) ───────────────────────────

export type JointKind =
  | "Motor6D"
  | "AnimationConstraint"
  | "Bone"
  | "Weld"
  | "Rigid"
  | "Custom";

export type SemanticRole =
  | "root"
  | "locomotionRoot"
  | "pelvis"
  | "spine"
  | "chest"
  | "neck"
  | "head"
  | "shoulder"
  | "elbow"
  | "wrist"
  | "hand"
  | "hip"
  | "knee"
  | "ankle"
  | "foot"
  | "limb"
  | "endEffector"
  | "hinge"
  | "slider"
  | "rotational"
  | "rigid"
  | "follow"
  | "mechanical"
  | "decorative"
  | "unknown";

export type ContactKind =
  | "GROUND"
  | "FOOT"
  | "HAND"
  | "OBJECT"
  | "WALL"
  | "CUSTOM";

export type StyleKind =
  | "REALISTIC"
  | "CINEMATIC"
  | "ANIME"
  | "EXAGGERATED"
  | "MECHANICAL"
  | "CREATURE"
  | "CARTOON"
  | "SUBTLE";

export type AnimationStatus =
  | "CREATED"
  | "SOLVING"
  | "VALIDATING"
  | "REPAIRING"
  | "READY_DATA"
  | "READY_VISUAL"
  | "FAILED";

export type MotionBeatKind =
  | "REST"
  | "ANTICIPATION"
  | "PREPARATION"
  | "ACCELERATION"
  | "PRIMARY_ACTION"
  | "IMPACT"
  | "FOLLOW_THROUGH"
  | "SETTLE";

export type LayerKind =
  | "BASE"
  | "LOCOMOTION"
  | "UPPER_BODY"
  | "LOWER_BODY"
  | "HEAD"
  | "HANDS"
  | "FACE"
  | "SECONDARY"
  | "PROCEDURAL"
  | "IK";

export type BlendMode = "override" | "additive" | "multiply";

export type InterpolationKind =
  | "step"
  | "linear"
  | "slerp"
  | "squad"
  | "cubic"
  | "bezier";

/** Easing vocabulary — must stay in sync with the registry tool schemas. */
export type EasingName =
  | "linear"
  | "quadIn"
  | "quadOut"
  | "quadInOut"
  | "cubicIn"
  | "cubicOut"
  | "cubicInOut"
  | "sineIn"
  | "sineOut"
  | "sineInOut"
  | "bezierOut"
  | "springOut";

export type ValidationCategory =
  | "STRUCTURE"
  | "KINEMATICS"
  | "CONTACT"
  | "GEOMETRY"
  | "LOOP"
  | "STYLE";

export type ValidationSeverity = "info" | "warning" | "error";

export type DefectCode =
  | "FOOT_SLIDE"
  | "HAND_CONTACT_BREAK"
  | "GROUND_PENETRATION"
  | "CONTACT_JUMP"
  | "CONTACT_ROTATION_DRIFT"
  | "CONTACT_BREAK"
  | "SPEED_SPIKE"
  | "ACCELERATION_SPIKE"
  | "JERK_SPIKE"
  | "DISCONTINUITY"
  | "JOINT_LIMIT"
  | "OVEREXTENSION"
  | "IMPOSSIBLE_ROTATION"
  | "CHAIN_COLLAPSE"
  | "SELF_INTERSECTION"
  | "EXCESSIVE_STRETCH"
  | "EXCESSIVE_COMPRESSION"
  | "LOOP_SEAM_POSITION"
  | "LOOP_SEAM_ROTATION"
  | "LOOP_SEAM_VELOCITY"
  | "MISSING_TRACK"
  | "INVALID_JOINT"
  | "DUPLICATE_KEYS"
  | "INVALID_TIMING"
  | "ORPHAN_EVENT"
  | "LAYER_CONFLICT"
  | "WEAK_ANTICIPATION"
  | "WEAK_IMPACT"
  | "WEAK_FOLLOW_THROUGH"
  | "ROBOTIC_TIMING"
  | "WEAK_SILHOUETTE"
  | "STIFF_MOTION"
  | "BAD_FRAMING"
  | "VISIBLE_SNAPPING"
  | "INTERPENETRATION_VISIBLE"
  | "DETACHED_LIMB"
  | "HIDDEN_ACTION"
  | "TIMING_OFF";

// ── Joint pose (authoritative unit) ─────────────────────────────────────────

/**
 * JointPose — the authoritative per-joint sample.
 * Rotation is ALWAYS a normalized quaternion internally.
 * AI input in degrees must be converted via eulerDegToQuat() at the boundary.
 */
export interface JointPose {
  /** Stable joint/track name as reported by the rig analyzer (e.g. "Head"). */
  joint: string;
  position: Vec3;
  rotation: Quaternion;
  scale?: Vec3;
  /** Parent joint name; undefined for the rig root. */
  parent?: string;
  /** Rest-pose local transform (bind pose). Used for limit + retarget math. */
  localRestTransform?: Transform3D;
  /** Optional cached world transform at sample time (diagnostics only). */
  worldTransform?: Transform3D;
  /** Linear velocity in studs/sec at sample time (filled by analysis). */
  velocity?: Vec3;
  /** Angular velocity in deg/sec as an axis-angle vector (filled by analysis). */
  angularVelocity?: Vec3;
  /** Name of the active contact lock holding this joint, if any. */
  contactState?: string | null;
  /** Name of the active constraint/IK chain driving this joint, if any. */
  constraintState?: string | null;
  semanticRole: SemanticRole;
}

export interface PoseKeyframe {
  t: number;
  pose: JointPose;
  easing?: EasingName;
  interpolation?: InterpolationKind;
}

export interface PoseTrack {
  /** Joint/track name — must match a SemanticJoint name. */
  joint: string;
  jointKind: JointKind;
  semanticRole: SemanticRole;
  keys: PoseKeyframe[];
  locked?: boolean;
}

export interface TrajectorySpec {
  direction?: Vec3;
  arcHeight?: number;
  arcBias?: number;
  peakTiming?: number;
  easing?: EasingName;
}

export interface AnimationClip {
  name: string;
  duration: number;
  fps: number;
  loop: boolean;
  tracks: PoseTrack[];
  /** Optional per-track arc overrides, keyed by joint name. */
  arcs?: Record<string, TrajectorySpec>;
}

// ── Rig ─────────────────────────────────────────────────────────────────────

export interface SemanticJoint {
  name: string;
  path: string;
  jointKind: JointKind;
  semanticRole: SemanticRole;
  parent?: string;
  children: string[];
  isEndEffector: boolean;
}

export interface SemanticSkeleton {
  root: string;
  joints: SemanticJoint[];
  probableHead?: string;
  probableHands?: string[];
  probableFeet?: string[];
  spineChain?: string[];
}

export interface RigAnalysis {
  target: string;
  jointCount: number;
  maxDepth: number;
  skeleton: SemanticSkeleton;
  warnings: string[];
  analyzedAt: number;
}

// ── Motion plan ─────────────────────────────────────────────────────────────

export interface MotionBeat {
  kind: MotionBeatKind;
  start: number;
  duration: number;
  importance: number;
  rootMotion?: Vec3;
  majorJoints?: string[];
  contacts?: string[];
  style?: StyleKind;
  cameraNote?: string;
}

export interface MotionPlan {
  goal: string;
  target: string;
  style: StyleKind;
  duration: number;
  beats: MotionBeat[];
}

// ── Constraints ─────────────────────────────────────────────────────────────

export interface IKChain {
  name: string;
  root: string;
  endEffector: string;
  /** Intermediate joints root → … → endEffector (may be empty for direct chains). */
  chain: string[];
  target: Vec3;
  targetOrientation?: Quaternion;
  pole?: Vec3;
  /** 0..1 — 0 ignores the target, 1 fully constrains. */
  weight: number;
  priority: number;
  /** 0..1 smoothing applied when solving/baking. */
  smoothing?: number;
}

export interface ContactSpec {
  name: string;
  type: ContactKind;
  joint: string;
  target?: string;
  worldPosition: Vec3;
  worldOrientation?: Quaternion;
  startTime: number;
  endTime: number;
  /** 0..1 solver stiffness while locked. */
  stiffness: number;
  /** Allowed drift in studs before CONTACT_BREAK is raised. */
  tolerance: number;
}

export interface JointLimit {
  joint: string;
  /** Degrees, XYZ Euler box around the rest pose. Undefined axis = unconstrained. */
  minDeg?: EulerDegrees;
  maxDeg?: EulerDegrees;
  maxStretch?: number;
  maxCompression?: number;
}

// ── Layers / secondary / style ──────────────────────────────────────────────

export interface AnimationLayer {
  kind: LayerKind;
  /** Joints this layer may write; empty = all joints. */
  mask: string[];
  weight: number;
  priority: number;
  blendMode: BlendMode;
  fadeIn?: number;
  fadeOut?: number;
  enabled: boolean;
}

export interface SecondarySpec {
  joint: string;
  lag: number;
  stiffness: number;
  damping: number;
  mass?: number;
  maxDisplacement?: number;
  maxRotationDeg?: number;
  followWeight: number;
}

export interface KinematicThresholds {
  maxSpeedStudPerSec: number;
  maxAccelStudPerSec2: number;
  maxJerkStudPerSec3: number;
  maxAngularSpeedDegPerSec: number;
}

export interface StyleProfile {
  kind: StyleKind;
  anticipationScale: number;
  impactSharpness: number;
  followThroughScale: number;
  overshoot: number;
  secondaryMotionScale: number;
  contactStiffness: number;
  thresholds: KinematicThresholds;
}

export const STYLE_KINDS: readonly StyleKind[] = [
  "REALISTIC",
  "CINEMATIC",
  "ANIME",
  "EXAGGERATED",
  "MECHANICAL",
  "CREATURE",
  "CARTOON",
  "SUBTLE",
] as const;

/**
 * Default style profiles. Anime intentionally tolerates higher jerk/accel
 * (snap + impact) while realistic stays tightly bounded. Tuned values — the
 * validator compares measured kinematics against the active profile.
 */
export const DEFAULT_STYLE_PROFILES: Record<StyleKind, StyleProfile> = {
  REALISTIC: {
    kind: "REALISTIC",
    anticipationScale: 0.6,
    impactSharpness: 0.4,
    followThroughScale: 0.5,
    overshoot: 0.0,
    secondaryMotionScale: 0.6,
    contactStiffness: 1.0,
    thresholds: {
      maxSpeedStudPerSec: 16,
      maxAccelStudPerSec2: 60,
      maxJerkStudPerSec3: 400,
      maxAngularSpeedDegPerSec: 360,
    },
  },
  CINEMATIC: {
    kind: "CINEMATIC",
    anticipationScale: 1.2,
    impactSharpness: 0.6,
    followThroughScale: 1.0,
    overshoot: 0.05,
    secondaryMotionScale: 1.0,
    contactStiffness: 1.0,
    thresholds: {
      maxSpeedStudPerSec: 14,
      maxAccelStudPerSec2: 50,
      maxJerkStudPerSec3: 320,
      maxAngularSpeedDegPerSec: 300,
    },
  },
  ANIME: {
    kind: "ANIME",
    anticipationScale: 1.4,
    impactSharpness: 1.6,
    followThroughScale: 1.4,
    overshoot: 0.18,
    secondaryMotionScale: 1.1,
    contactStiffness: 0.9,
    thresholds: {
      maxSpeedStudPerSec: 40,
      maxAccelStudPerSec2: 220,
      maxJerkStudPerSec3: 1800,
      maxAngularSpeedDegPerSec: 1080,
    },
  },
  EXAGGERATED: {
    kind: "EXAGGERATED",
    anticipationScale: 1.6,
    impactSharpness: 1.4,
    followThroughScale: 1.6,
    overshoot: 0.25,
    secondaryMotionScale: 1.4,
    contactStiffness: 0.8,
    thresholds: {
      maxSpeedStudPerSec: 36,
      maxAccelStudPerSec2: 200,
      maxJerkStudPerSec3: 1600,
      maxAngularSpeedDegPerSec: 900,
    },
  },
  MECHANICAL: {
    kind: "MECHANICAL",
    anticipationScale: 0.3,
    impactSharpness: 1.0,
    followThroughScale: 0.1,
    overshoot: 0.0,
    secondaryMotionScale: 0.0,
    contactStiffness: 1.0,
    thresholds: {
      maxSpeedStudPerSec: 20,
      maxAccelStudPerSec2: 120,
      maxJerkStudPerSec3: 1200,
      maxAngularSpeedDegPerSec: 540,
    },
  },
  CREATURE: {
    kind: "CREATURE",
    anticipationScale: 1.0,
    impactSharpness: 0.8,
    followThroughScale: 1.2,
    overshoot: 0.1,
    secondaryMotionScale: 1.3,
    contactStiffness: 0.9,
    thresholds: {
      maxSpeedStudPerSec: 24,
      maxAccelStudPerSec2: 110,
      maxJerkStudPerSec3: 800,
      maxAngularSpeedDegPerSec: 540,
    },
  },
  CARTOON: {
    kind: "CARTOON",
    anticipationScale: 1.3,
    impactSharpness: 1.1,
    followThroughScale: 1.3,
    overshoot: 0.2,
    secondaryMotionScale: 1.2,
    contactStiffness: 0.85,
    thresholds: {
      maxSpeedStudPerSec: 30,
      maxAccelStudPerSec2: 160,
      maxJerkStudPerSec3: 1200,
      maxAngularSpeedDegPerSec: 720,
    },
  },
  SUBTLE: {
    kind: "SUBTLE",
    anticipationScale: 0.4,
    impactSharpness: 0.2,
    followThroughScale: 0.3,
    overshoot: 0.0,
    secondaryMotionScale: 0.3,
    contactStiffness: 1.0,
    thresholds: {
      maxSpeedStudPerSec: 6,
      maxAccelStudPerSec2: 24,
      maxJerkStudPerSec3: 160,
      maxAngularSpeedDegPerSec: 120,
    },
  },
};

// ── Events / revisions / validation ─────────────────────────────────────────

export interface AnimationMarker {
  t: number;
  name: string;
  event?: string;
}

export interface RevisionInfo {
  revision: string;
  parentRevision?: string;
  changes: string[];
  createdAt: number;
}

export interface ValidationIssue {
  code: DefectCode;
  category: ValidationCategory;
  severity: ValidationSeverity;
  joint?: string;
  t?: number;
  message: string;
  measured?: number;
  threshold?: number;
  suggestedFix?: string;
}

export interface ValidationReport {
  animation: string;
  revision: string;
  status: AnimationStatus;
  checkedAt: number;
  passed: boolean;
  issues: ValidationIssue[];
  metrics?: {
    keyframeCount: number;
    trackCount: number;
    duration: number;
    fps: number;
    repairIterations: number;
  };
  visualVerification: "passed" | "failed" | "required";
}

export interface AnimationMetadata {
  name: string;
  target: string;
  goal?: string;
  style: StyleKind;
  duration: number;
  fps: number;
  loop: boolean;
  createdAt: number;
  updatedAt: number;
}

/**
 * AnimationIR — the single shared representation for one animation build.
 * Every pipeline stage reads/writes this shape; tools must not invent
 * parallel formats (rule R2, above).
 */
export interface AnimationIR {
  v: number;
  metadata: AnimationMetadata;
  status: AnimationStatus;
  rig?: RigAnalysis;
  clips: AnimationClip[];
  layers?: AnimationLayer[];
  contacts?: ContactSpec[];
  ikChains?: IKChain[];
  jointLimits?: JointLimit[];
  secondary?: SecondarySpec[];
  markers?: AnimationMarker[];
  revision: RevisionInfo;
  validation?: ValidationReport;
  errors: string[];
  warnings: string[];
}

// ── Legacy compatibility (existing RoLink tools) ────────────────────────────

export interface LegacyPoseInput {
  part: string;
  position: Vec3;
  rotation: EulerDegrees;
  easing?: string;
  scale?: Vec3;
}

export interface LegacyKeyframeInput {
  time: number;
  easing?: string;
  poses: LegacyPoseInput[];
}

// ── Constants ───────────────────────────────────────────────────────────────

export const MOTION_BEAT_ORDER: readonly MotionBeatKind[] = [
  "REST",
  "ANTICIPATION",
  "PREPARATION",
  "ACCELERATION",
  "PRIMARY_ACTION",
  "IMPACT",
  "FOLLOW_THROUGH",
  "SETTLE",
] as const;

export const EASING_NAMES: readonly EasingName[] = [
  "linear",
  "quadIn",
  "quadOut",
  "quadInOut",
  "cubicIn",
  "cubicOut",
  "cubicInOut",
  "sineIn",
  "sineOut",
  "sineInOut",
  "bezierOut",
  "springOut",
] as const;

export const TERMINAL_STATUSES: readonly AnimationStatus[] = [
  "READY_DATA",
  "READY_VISUAL",
  "FAILED",
] as const;

export const MAX_ANIMATION_DURATION_S = 60;
export const MAX_TRACKS_PER_CLIP = 64;
export const MAX_KEYS_PER_TRACK = 1024;

// ── Minimal math (full solver libs land in Task 1.2+) ───────────────────────

export function makeVec3(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z };
}

export function makeQuaternionIdentity(): Quaternion {
  return { w: 1, x: 0, y: 0, z: 0 };
}

export function quatNormalize(q: Quaternion): Quaternion {
  const len = Math.hypot(q.w, q.x, q.y, q.z);
  if (!Number.isFinite(len) || len < 1e-12) return makeQuaternionIdentity();
  return { w: q.w / len, x: q.x / len, y: q.y / len, z: q.z / len };
}

export function quatMultiply(a: Quaternion, b: Quaternion): Quaternion {
  return quatNormalize({
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  });
}

function quatFromAxisAngle(ax: number, ay: number, az: number, angleRad: number): Quaternion {
  const half = angleRad / 2;
  const s = Math.sin(half);
  return quatNormalize({ w: Math.cos(half), x: ax * s, y: ay * s, z: az * s });
}

/**
 * Convert AI-facing Euler degrees → authoritative unit quaternion.
 * Intrinsic XYZ (Tait-Bryan) order: q = Qx ⊗ Qy ⊗ Qz.
 * NOTE: the Studio plugin applies the final CFrame conversion; this function
 * is the canonical boundary conversion so every caller agrees on semantics.
 */
export function eulerDegToQuat(e: EulerDegrees): Quaternion {
  const rx = quatFromAxisAngle(1, 0, 0, (e.x * Math.PI) / 180);
  const ry = quatFromAxisAngle(0, 1, 0, (e.y * Math.PI) / 180);
  const rz = quatFromAxisAngle(0, 0, 1, (e.z * Math.PI) / 180);
  return quatMultiply(quatMultiply(rx, ry), rz);
}

/**
 * Convert a unit quaternion back to Euler degrees (XYZ order).
 * Exact algebraic inverse of eulerDegToQuat's intrinsic-XYZ composition,
 * so euler → quat → euler round-trips (except at Y = ±90° gimbal lock,
 * where X+Z are reported combined in X with Z = 0).
 * Inspector/display use only — never feed back into the solver path.
 */
export function quatToEulerDeg(q: Quaternion): EulerDegrees {
  const n = quatNormalize(q);
  const { w, x, y, z } = n;
  // R = Rx·Ry·Rz ⇒ R[0][2] = sin(y).
  const m02 = 2 * (x * z + w * y);
  const yAng = Math.asin(Math.max(-1, Math.min(1, m02)));
  let xAng: number;
  let zAng: number;
  if (Math.abs(m02) >= 1 - 1e-9) {
    // Gimbal lock: x+z = atan2(R[1][0], R[1][1]); report it in x.
    xAng = Math.atan2(2 * (x * y + z * w), 1 - 2 * (x * x + z * z));
    zAng = 0;
  } else {
    xAng = Math.atan2(2 * (w * x - y * z), 1 - 2 * (x * x + y * y));
    zAng = Math.atan2(2 * (w * z - x * y), 1 - 2 * (y * y + z * z));
  }
  const toDeg = (r: number): number => (r * 180) / Math.PI;
  return { x: toDeg(xAng), y: toDeg(yAng), z: toDeg(zAng) };
}

// ── Factories ───────────────────────────────────────────────────────────────

export function makeJointPose(joint: string, init?: Partial<JointPose>): JointPose {
  return {
    joint,
    position: init?.position ?? makeVec3(),
    rotation: quatNormalize(init?.rotation ?? makeQuaternionIdentity()),
    ...(init?.scale ? { scale: init.scale } : {}),
    ...(init?.parent !== undefined ? { parent: init.parent } : {}),
    ...(init?.localRestTransform ? { localRestTransform: init.localRestTransform } : {}),
    ...(init?.worldTransform ? { worldTransform: init.worldTransform } : {}),
    ...(init?.velocity ? { velocity: init.velocity } : {}),
    ...(init?.angularVelocity ? { angularVelocity: init.angularVelocity } : {}),
    ...(init?.contactState !== undefined ? { contactState: init.contactState } : {}),
    ...(init?.constraintState !== undefined ? { constraintState: init.constraintState } : {}),
    semanticRole: init?.semanticRole ?? "unknown",
  };
}

/** Boundary helper: legacy Euler-degree pose → authoritative JointPose. */
export function legacyPoseToJointPose(p: LegacyPoseInput): JointPose {
  return makeJointPose(p.part, {
    position: { ...p.position },
    rotation: eulerDegToQuat(p.rotation),
    ...(p.scale ? { scale: { ...p.scale } } : {}),
    semanticRole: "unknown",
  });
}

export function normalizeEasing(easing: string | undefined, fallback: EasingName = "linear"): EasingName {
  if (!easing) return fallback;
  if ((EASING_NAMES as readonly string[]).includes(easing)) return easing as EasingName;
  const bare = easing.toLowerCase();
  if (bare === "quad" || bare === "quad inout") return "quadInOut";
  if (bare === "cubic") return "cubicInOut";
  if (bare === "sine") return "sineInOut";
  if (bare === "bezier" || bare === "bezierout") return "bezierOut";
  if (bare === "spring" || bare === "springout") return "springOut";
  return fallback;
}

export function makeMotionBeat(kind: MotionBeatKind, start: number, duration: number): MotionBeat {
  return { kind, start, duration, importance: 0.5 };
}

export function makeMotionPlan(
  goal: string,
  target: string,
  style: StyleKind,
  duration: number,
  beats?: MotionBeat[],
): MotionPlan {
  return { goal, target, style, duration, beats: beats ?? [] };
}

export function makeContactSpec(init: {
  name: string;
  type: ContactKind;
  joint: string;
  worldPosition: Vec3;
  startTime: number;
  endTime: number;
  target?: string;
  worldOrientation?: Quaternion;
  stiffness?: number;
  tolerance?: number;
}): ContactSpec {
  return {
    name: init.name,
    type: init.type,
    joint: init.joint,
    ...(init.target !== undefined ? { target: init.target } : {}),
    worldPosition: { ...init.worldPosition },
    ...(init.worldOrientation ? { worldOrientation: quatNormalize(init.worldOrientation) } : {}),
    startTime: init.startTime,
    endTime: init.endTime,
    stiffness: init.stiffness ?? 1,
    tolerance: init.tolerance ?? 0.05,
  };
}

export function makeIKChain(init: {
  name: string;
  root: string;
  endEffector: string;
  target: Vec3;
  chain?: string[];
  targetOrientation?: Quaternion;
  pole?: Vec3;
  weight?: number;
  priority?: number;
  smoothing?: number;
}): IKChain {
  return {
    name: init.name,
    root: init.root,
    endEffector: init.endEffector,
    chain: init.chain ? [...init.chain] : [],
    target: { ...init.target },
    ...(init.targetOrientation ? { targetOrientation: quatNormalize(init.targetOrientation) } : {}),
    ...(init.pole ? { pole: { ...init.pole } } : {}),
    weight: init.weight ?? 1,
    priority: init.priority ?? 0,
    ...(init.smoothing !== undefined ? { smoothing: init.smoothing } : {}),
  };
}

export function makeRevision(name: string, count = 1, parentRevision?: string): RevisionInfo {
  const revision = `${name}_v${String(count).padStart(3, "0")}`;
  return {
    revision,
    ...(parentRevision ? { parentRevision } : {}),
    changes: [],
    createdAt: Date.now(),
  };
}

export function makeValidationIssue(
  code: DefectCode,
  category: ValidationCategory,
  severity: ValidationSeverity,
  message: string,
  extra?: Partial<ValidationIssue>,
): ValidationIssue {
  return { code, category, severity, message, ...extra };
}

export function makeValidationReport(
  animation: string,
  revision: string,
  issues: ValidationIssue[],
  metrics?: ValidationReport["metrics"],
  visualVerification: ValidationReport["visualVerification"] = "required",
): ValidationReport {
  const hasError = issues.some((i) => i.severity === "error");
  return {
    animation,
    revision,
    status: hasError ? "FAILED" : "VALIDATING",
    checkedAt: Date.now(),
    passed: !hasError,
    issues: [...issues],
    ...(metrics ? { metrics } : {}),
    visualVerification,
  };
}

export function makeAnimationIR(
  name: string,
  target: string,
  init?: {
    goal?: string;
    style?: StyleKind;
    duration?: number;
    fps?: number;
    loop?: boolean;
  },
): AnimationIR {
  const now = Date.now();
  const duration = Math.min(Math.max(init?.duration ?? 1, 0.1), MAX_ANIMATION_DURATION_S);
  const fps = Math.min(Math.max(init?.fps ?? 30, 1), 120);
  return {
    v: ANIMATION_IR_VERSION,
    metadata: {
      name,
      target,
      ...(init?.goal !== undefined ? { goal: init.goal } : {}),
      style: init?.style ?? "REALISTIC",
      duration,
      fps,
      loop: init?.loop ?? false,
      createdAt: now,
      updatedAt: now,
    },
    status: "CREATED",
    clips: [],
    revision: makeRevision(name, 1),
    errors: [],
    warnings: [],
  };
}

// ── Status helpers ──────────────────────────────────────────────────────────

export function isTerminalStatus(s: AnimationStatus): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(s);
}

export function isReadyState(s: AnimationStatus): boolean {
  return s === "READY_DATA" || s === "READY_VISUAL";
}

// ── Runtime type guards (JSON boundary validation) ──────────────────────────

function isRecord(o: unknown): o is Record<string, unknown> {
  return typeof o === "object" && o !== null && !Array.isArray(o);
}

function isFiniteNum(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

export function isVec3(o: unknown): o is Vec3 {
  return isRecord(o) && isFiniteNum(o.x) && isFiniteNum(o.y) && isFiniteNum(o.z);
}

export function isQuaternion(o: unknown): o is Quaternion {
  if (!isRecord(o) || !isFiniteNum(o.w) || !isFiniteNum(o.x) || !isFiniteNum(o.y) || !isFiniteNum(o.z)) {
    return false;
  }
  const len = Math.hypot(o.w as number, o.x as number, o.y as number, o.z as number);
  return len > 1e-6 && Math.abs(len - 1) < 0.05;
}

export function isEulerDegrees(o: unknown): o is EulerDegrees {
  return isRecord(o) && isFiniteNum(o.x) && isFiniteNum(o.y) && isFiniteNum(o.z);
}

export function isEasingName(o: unknown): o is EasingName {
  return typeof o === "string" && (EASING_NAMES as readonly string[]).includes(o);
}

export function isJointPose(o: unknown): o is JointPose {
  if (!isRecord(o) || typeof o.joint !== "string" || o.joint.length === 0) return false;
  if (!isVec3(o.position) || !isQuaternion(o.rotation)) return false;
  if (o.scale !== undefined && !isVec3(o.scale)) return false;
  if (o.parent !== undefined && typeof o.parent !== "string") return false;
  if (o.contactState !== undefined && o.contactState !== null && typeof o.contactState !== "string") {
    return false;
  }
  if (o.constraintState !== undefined && o.constraintState !== null && typeof o.constraintState !== "string") {
    return false;
  }
  return true;
}

export function isPoseKeyframe(o: unknown): o is PoseKeyframe {
  if (!isRecord(o) || !isFiniteNum(o.t) || (o.t as number) < 0) return false;
  if (!isJointPose(o.pose)) return false;
  if (o.easing !== undefined && !isEasingName(o.easing)) return false;
  return true;
}

export function isPoseTrack(o: unknown): o is PoseTrack {
  if (!isRecord(o) || typeof o.joint !== "string" || (o.joint as string).length === 0) return false;
  if (typeof o.jointKind !== "string" || typeof o.semanticRole !== "string") return false;
  if (!Array.isArray(o.keys)) return false;
  if ((o.keys as unknown[]).length > MAX_KEYS_PER_TRACK) return false;
  return (o.keys as unknown[]).every(isPoseKeyframe);
}

export function isAnimationClip(o: unknown): o is AnimationClip {
  if (!isRecord(o) || typeof o.name !== "string" || (o.name as string).length === 0) return false;
  if (!isFiniteNum(o.duration) || (o.duration as number) <= 0 || (o.duration as number) > MAX_ANIMATION_DURATION_S) {
    return false;
  }
  if (!isFiniteNum(o.fps) || (o.fps as number) < 1 || (o.fps as number) > 120) return false;
  if (typeof o.loop !== "boolean") return false;
  if (!Array.isArray(o.tracks)) return false;
  if ((o.tracks as unknown[]).length > MAX_TRACKS_PER_CLIP) return false;
  return (o.tracks as unknown[]).every(isPoseTrack);
}

export function isMotionBeat(o: unknown): o is MotionBeat {
  if (!isRecord(o) || typeof o.kind !== "string") return false;
  if (!(MOTION_BEAT_ORDER as readonly string[]).includes(o.kind as string)) return false;
  if (!isFiniteNum(o.start) || (o.start as number) < 0) return false;
  if (!isFiniteNum(o.duration) || (o.duration as number) <= 0) return false;
  if (!isFiniteNum(o.importance)) return false;
  return true;
}

export function isMotionPlan(o: unknown): o is MotionPlan {
  if (!isRecord(o)) return false;
  if (typeof o.goal !== "string" || typeof o.target !== "string") return false;
  if (typeof o.style !== "string" || !(STYLE_KINDS as readonly string[]).includes(o.style as string)) return false;
  if (!isFiniteNum(o.duration) || (o.duration as number) <= 0) return false;
  if (!Array.isArray(o.beats)) return false;
  const beats = o.beats as unknown[];
  if (!beats.every(isMotionBeat)) return false;
  for (let i = 1; i < beats.length; i += 1) {
    const prev = beats[i - 1] as MotionBeat;
    const cur = beats[i] as MotionBeat;
    if (cur.start < prev.start) return false;
  }
  return true;
}

export function isContactSpec(o: unknown): o is ContactSpec {
  if (!isRecord(o) || typeof o.name !== "string" || (o.name as string).length === 0) return false;
  if (typeof o.type !== "string") return false;
  if (typeof o.joint !== "string" || (o.joint as string).length === 0) return false;
  if (!isVec3(o.worldPosition)) return false;
  if (!isFiniteNum(o.startTime) || !isFiniteNum(o.endTime)) return false;
  if ((o.endTime as number) <= (o.startTime as number)) return false;
  if (!isFiniteNum(o.stiffness) || (o.stiffness as number) < 0 || (o.stiffness as number) > 1) return false;
  if (!isFiniteNum(o.tolerance) || (o.tolerance as number) < 0) return false;
  return true;
}

export function isIKChain(o: unknown): o is IKChain {
  if (!isRecord(o) || typeof o.name !== "string" || (o.name as string).length === 0) return false;
  if (typeof o.root !== "string" || typeof o.endEffector !== "string") return false;
  if ((o.root as string).length === 0 || (o.endEffector as string).length === 0) return false;
  if (o.root === o.endEffector) return false;
  if (!Array.isArray(o.chain)) return false;
  if (!isVec3(o.target)) return false;
  if (!isFiniteNum(o.weight) || (o.weight as number) < 0 || (o.weight as number) > 1) return false;
  if (!isFiniteNum(o.priority)) return false;
  return true;
}

export function isStyleProfile(o: unknown): o is StyleProfile {
  if (!isRecord(o) || typeof o.kind !== "string") return false;
  if (!(STYLE_KINDS as readonly string[]).includes(o.kind as string)) return false;
  for (const k of ["anticipationScale", "impactSharpness", "followThroughScale", "overshoot", "secondaryMotionScale", "contactStiffness"] as const) {
    if (!isFiniteNum(o[k])) return false;
  }
  const t = o.thresholds as Record<string, unknown>;
  if (!isRecord(t)) return false;
  for (const k of ["maxSpeedStudPerSec", "maxAccelStudPerSec2", "maxJerkStudPerSec3", "maxAngularSpeedDegPerSec"] as const) {
    if (!isFiniteNum(t[k]) || (t[k] as number) <= 0) return false;
  }
  return true;
}

export function isValidationIssue(o: unknown): o is ValidationIssue {
  if (!isRecord(o) || typeof o.code !== "string" || typeof o.category !== "string") return false;
  if (o.severity !== "info" && o.severity !== "warning" && o.severity !== "error") return false;
  if (typeof o.message !== "string" || (o.message as string).length === 0) return false;
  return true;
}

export function isValidationReport(o: unknown): o is ValidationReport {
  if (!isRecord(o) || typeof o.animation !== "string" || typeof o.revision !== "string") return false;
  if (typeof o.status !== "string" || typeof o.passed !== "boolean") return false;
  if (!isFiniteNum(o.checkedAt)) return false;
  if (!Array.isArray(o.issues) || !(o.issues as unknown[]).every(isValidationIssue)) return false;
  if (o.visualVerification !== "passed" && o.visualVerification !== "failed" && o.visualVerification !== "required") {
    return false;
  }
  return true;
}

export function isAnimationIR(o: unknown): o is AnimationIR {
  if (!isRecord(o)) return false;
  if (o.v !== ANIMATION_IR_VERSION) return false;
  const m = o.metadata as Record<string, unknown>;
  if (!isRecord(m)) return false;
  if (typeof m.name !== "string" || (m.name as string).length === 0) return false;
  if (typeof m.target !== "string" || (m.target as string).length === 0) return false;
  if (typeof m.style !== "string" || !(STYLE_KINDS as readonly string[]).includes(m.style as string)) return false;
  if (typeof o.status !== "string") return false;
  if (!Array.isArray(o.clips)) return false;
  if (!(o.clips as unknown[]).every(isAnimationClip)) return false;
  if (!isRecord(o.revision)) return false;
  if (!Array.isArray(o.errors) || !Array.isArray(o.warnings)) return false;
  if (o.contacts !== undefined && (!Array.isArray(o.contacts) || !(o.contacts as unknown[]).every(isContactSpec))) {
    return false;
  }
  if (o.ikChains !== undefined && (!Array.isArray(o.ikChains) || !(o.ikChains as unknown[]).every(isIKChain))) {
    return false;
  }
  if (o.validation !== undefined && !isValidationReport(o.validation)) return false;
  return true;
}
