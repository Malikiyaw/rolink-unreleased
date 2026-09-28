/**
 * RoLink semantic rig layer — Tasks 2.2 + 2.3.
 *
 * Turns JointBindings into a SemanticSkeleton: every joint gets a
 * SemanticRole, landmarks (head/hands/feet/spine) are detected by
 * name + hierarchy + symmetry heuristics, and the rig gets a RigType
 * so the future AnimationCompiler can select the correct solver
 * (humanoid ≠ creature ≠ mechanical ≠ vehicle).
 *
 * Rules are ordered and conservative: joint KIND wins for Weld/follow and
 * unknown classes (never invent articulation), NAME wins for Motor6D /
 * AnimationConstraint / Bone / Rigid parts (a "LeftUpperArm" part IS a
 * limb segment even though it is rigid geometry).
 */

import type {
  SemanticJoint,
  SemanticRole,
  SemanticSkeleton,
  Vec3,
} from "../../../shared/animationProtocol.js";
import {
  buildJointGraph,
  chainBetween,
  type JointBinding,
} from "./jointAdapter.js";

export type Side = "left" | "right" | "center";

export type RigType =
  | "humanoid"
  | "creature"
  | "vehicle"
  | "mechanical"
  | "prop"
  | "unknown";

// ── Name tokens (matched on whole words after camel/snake splitting) ────────

const HEAD_TOKENS = new Set(["head", "heads", "skull", "face", "cranium"]);
const NECK_TOKENS = new Set(["neck"]);
const HAND_TOKENS = new Set([
  "hand", "hands", "palm", "palms", "finger", "fingers", "thumb", "thumbs",
  "claw", "claws", "gripper", "grippers", "mitt", "mitts",
]);
const FOOT_TOKENS = new Set([
  "foot", "feet", "toe", "toes", "hoof", "hooves", "paw", "paws", "talon", "talons",
]);
const SPINE_TOKENS = new Set(["spine", "torso", "waist", "back", "abdomen", "belly"]);
const PELVIS_WORDS = new Set(["pelvis", "hips"]);
const CHEST_WORDS = new Set(["chest"]);
export const ARM_WORDS = new Set([
  "arm", "arms", "shoulder", "shoulders", "elbow", "elbows", "wrist", "wrists",
  "upperarm", "lowerarm", "forearm", "forearms",
]);
export const LEG_WORDS = new Set([
  "leg", "legs", "thigh", "thighs", "shin", "shins", "calf", "calves",
  "knee", "knees", "ankle", "ankles", "hip", "hips", "upperleg", "lowerleg",
]);
const LIMB_EXTRA = new Set([
  "limb", "limbs", "wing", "wings", "tail", "tails", "tentacle", "tentacles",
  "flipper", "flippers", "fin", "fins", "appendage",
]);
const HINGE_TOKENS = new Set([
  "hinge", "hinges", "door", "doors", "lid", "lids", "flap", "flaps",
  "hatch", "gate", "gates", "cover", "covers", "bonnet", "trunk",
]);
const SLIDER_TOKENS = new Set([
  "slider", "sliders", "piston", "pistons", "drawer", "drawers", "bolt", "bolts",
  "carriage", "slide", "slides",
]);
const MECHANICAL_TOKENS = new Set([
  "wheel", "wheels", "tire", "tires", "gear", "gears", "rotor", "rotors",
  "propeller", "propellers", "engine", "engines", "motor", "motors",
  "axle", "axles", "blade", "blades", "drill", "saw",
]);
const TIP_TOKENS = new Set(["tip", "tips", "muzzle", "muzzles", "barrel", "barrels", "nozzle", "nozzles"]);
const DECORATIVE_TOKENS = new Set([
  "trim", "trims", "ornament", "ornaments", "decoration", "decorations",
  "stripe", "stripes", "emblem", "emblems",
]);

/** Rank for gross root→head ordering when topology is flat. Lower = closer to root. */
const SPINE_RANK: Record<string, number> = {
  root: 0,
  locomotionRoot: 0,
  pelvis: 1,
  spine: 2,
  chest: 3,
  neck: 4,
  head: 5,
};

// ── Name utilities ──────────────────────────────────────────────────────────

export function splitWords(name: string): string[] {
  const words: string[] = [];
  for (const chunk of name.split(/[^A-Za-z0-9]+/)) {
    if (!chunk) continue;
    for (const part of chunk.split(/(?=[A-Z][a-z])|(?<=[a-z])(?=[A-Z])|(?<=\D)(?=\d)|(?<=\d)(?=\D)/)) {
      if (part) words.push(part.toLowerCase());
    }
  }
  return words;
}

/**
 * Memoized splitWords. The lookbehind split above is the single hottest
 * primitive in rig analysis (called 3-4x per joint across role
 * classification, side detection, and rig typing), and rig names repeat
 * within a build, so a bounded cache removes most of that cost.
 */
const WORDS_CACHE = new Map<string, readonly string[]>();
const WORDS_CACHE_MAX = 512;

export function wordsOf(name: string): readonly string[] {
  const hit = WORDS_CACHE.get(name);
  if (hit) return hit;
  const words = splitWords(name);
  if (WORDS_CACHE.size >= WORDS_CACHE_MAX) WORDS_CACHE.clear();
  WORDS_CACHE.set(name, words);
  return words;
}

export function clearWordsCache(): void {
  WORDS_CACHE.clear();
}

/** Current cache occupancy — exported so leak tests can assert the bound. */
export function wordsCacheSize(): number {
  return WORDS_CACHE.size;
}

export const WORDS_CACHE_LIMIT = WORDS_CACHE_MAX;

export function detectSide(name: string): Side {
  const words = wordsOf(name);
  if (words.includes("left")) return "left";
  if (words.includes("right")) return "right";
  const norm = name.replace(/[^A-Za-z]/g, "");
  if (/(^|[_\-. ])l([_\-. ]|$)/i.test(name) && !/(^|[_\-. ])r([_\-. ]|$)/i.test(name)) return "left";
  if (/(^|[_\-. ])r([_\-. ]|$)/i.test(name)) return "right";
  if (/[a-z]L$/.test(norm)) return "left";
  if (/[a-z]R$/.test(norm)) return "right";
  if (/^L(?=[A-Z])/.test(norm)) return "left";
  if (/^R(?=[A-Z])/.test(norm)) return "right";
  return "center";
}

// ── Role classification (Task 2.2) ──────────────────────────────────────────

export interface RoleInput {
  name: string;
  kind: JointBinding["kind"];
  legacyKind: JointBinding["legacyKind"];
  isLeaf: boolean;
}

/**
 * Rig-wide context for role classification. R6-style leaf promotion
 * (a terminal "Left Leg" part IS the foot) applies only when the rig has
 * no true hands/feet — otherwise wolf legs would double-count as feet.
 */
export interface RoleContext {
  hasTrueHands?: boolean;
  hasTrueFeet?: boolean;
}

export function rigRoleContext(names: string[]): RoleContext {
  const words = names.flatMap(splitWords);
  return {
    hasTrueHands: words.some((w) => HAND_TOKENS.has(w)),
    hasTrueFeet: words.some((w) => FOOT_TOKENS.has(w)),
  };
}

function has(words: readonly string[], set: Set<string>): boolean {
  return words.some((w) => set.has(w));
}

export function classifySemanticRole(input: RoleInput, ctx?: RoleContext): SemanticRole {
  const { kind, legacyKind, isLeaf } = input;
  const words = wordsOf(input.name);

  // KIND wins for non-articulated hardware: never invent motion.
  if (kind === "Weld") return "follow";
  if (kind === "Custom") {
    if (legacyKind === "anchor") return "follow";
    if (has(words, DECORATIVE_TOKENS)) return "decorative";
    return "unknown";
  }
  if (legacyKind === "root" && kind === "Rigid") {
    if (words.includes("humanoidrootpart") || words.includes("primarypart")) return "locomotionRoot";
    if (words.length === 1 && words[0] === "root") return "locomotionRoot";
    return "root";
  }

  // NAME wins for articulated/rigid bodies.
  if (has(words, HEAD_TOKENS)) return "head";
  if (has(words, NECK_TOKENS)) return "neck";
  if (has(words, HAND_TOKENS)) return "hand";
  if (has(words, FOOT_TOKENS)) return "foot";
  if (has(words, TIP_TOKENS)) return isLeaf ? "endEffector" : "mechanical";
  if (words.includes("root") || has(words, PELVIS_WORDS)) {
    // A root-named BONE is the chain root itself; a root-named Motor6D
    // (R15 "Root": HRP→LowerTorso) sits at pelvis level.
    if (kind === "Bone") return "root";
    return kind === "Rigid" && legacyKind !== "root" ? "locomotionRoot" : "pelvis";
  }
  if (has(words, CHEST_WORDS)) return "chest";
  if (has(words, SPINE_TOKENS)) {
    if (words.includes("upper") || words.includes("chest")) return "chest";
    return "spine";
  }
  if (has(words, HINGE_TOKENS)) return "hinge";
  if (has(words, SLIDER_TOKENS)) return "slider";
  if (has(words, MECHANICAL_TOKENS)) return "mechanical";
  if (
    has(words, ARM_WORDS) ||
    has(words, LEG_WORDS) ||
    has(words, LIMB_EXTRA)
  ) {
    // R6-style terminal limb segments ARE the hand/foot (no finer joints) —
    // unless the rig names true hands/feet elsewhere (then legs stay limbs).
    if (isLeaf && kind === "Rigid") {
      if (has(words, ARM_WORDS) && !ctx?.hasTrueHands) return "hand";
      if (has(words, LEG_WORDS) && !ctx?.hasTrueFeet) return "foot";
    }
    return "limb";
  }
  if (has(words, DECORATIVE_TOKENS)) return "decorative";

  // KIND fallback: articulated but unnamed joints stay generic.
  if (kind === "Motor6D" || kind === "AnimationConstraint" || kind === "Bone") return "rotational";
  if (kind === "Rigid") return "rigid";
  return "unknown";
}

// ── Landmarks (Task 2.3) ────────────────────────────────────────────────────

export interface LandmarkCandidate {
  name: string;
  role: SemanticRole;
  depth: number;
  isLeaf: boolean;
  side: Side;
}

export interface LandmarkSet {
  head?: string;
  hands: string[];
  feet: string[];
  spineChain: string[];
  /** How each landmark was found (name | hierarchy | position | none). */
  methods: Record<string, "name" | "hierarchy" | "position" | "none">;
}

function pickHead(cands: LandmarkCandidate[]): LandmarkCandidate | undefined {
  const heads = cands.filter((c) => c.role === "head");
  if (heads.length === 0) return undefined;
  return [...heads].sort((a, b) => {
    const exactA = wordsOf(a.name).includes("head") ? 0 : 1;
    const exactB = wordsOf(b.name).includes("head") ? 0 : 1;
    if (exactA !== exactB) return exactA - exactB;
    return b.depth - a.depth;
  })[0];
}

function pickPair(cands: LandmarkCandidate[], role: SemanticRole): LandmarkCandidate[] {
  const pool = cands.filter((c) => c.role === role);
  if (pool.length === 0) return [];
  const left = pool.filter((c) => c.side === "left");
  const right = pool.filter((c) => c.side === "right");
  if (left.length > 0 && right.length > 0) {
    const byDepth = (list: LandmarkCandidate[]): LandmarkCandidate =>
      [...list].sort((a, b) => b.depth - a.depth)[0];
    return [byDepth(left), byDepth(right)];
  }
  return [...pool].sort((a, b) => b.depth - a.depth).slice(0, 2);
}

export function detectLandmarks(cands: LandmarkCandidate[]): Omit<LandmarkSet, "spineChain"> & {
  methods: LandmarkSet["methods"];
} {
  const head = pickHead(cands);
  const hands = pickPair(cands, "hand");
  const feet = pickPair(cands, "foot");
  return {
    ...(head ? { head: head.name } : {}),
    hands: hands.map((h) => h.name),
    feet: feet.map((f) => f.name),
    methods: {
      head: head ? "name" : "none",
      hands: hands.length > 0 ? "name" : "none",
      feet: feet.length > 0 ? "name" : "none",
    },
  };
}

// ── Rig type ────────────────────────────────────────────────────────────────

export interface RigTypeInput {
  roles: SemanticRole[];
  names: string[];
  kinds: JointBinding["kind"][];
  head?: string;
  hands: string[];
  feet: string[];
}

function isArmRole(role: SemanticRole, name: string): boolean {
  if (role === "hand" || role === "endEffector") return true;
  if (role !== "limb") return false;
  return wordsOf(name).some((w) => ARM_WORDS.has(w));
}

function isLegRole(role: SemanticRole, name: string): boolean {
  if (role === "foot") return true;
  if (role !== "limb") return false;
  return wordsOf(name).some((w) => LEG_WORDS.has(w));
}

export function classifyRigType(input: RigTypeInput): RigType {
  const { roles, names, kinds, head, hands, feet } = input;
  const count = (r: SemanticRole): number => roles.filter((x) => x === r).length;
  const wheels = names.filter((n) => wordsOf(n).some((w) => w === "wheel" || w === "wheels")).length;
  const hinges = count("hinge") + count("slider");
  const limbs = count("limb");
  const writables = kinds.filter(
    (k) => k === "Motor6D" || k === "AnimationConstraint" || k === "Bone" || k === "Rigid",
  ).length;

  const upperSides = new Set<Side>();
  const lowerSides = new Set<Side>();
  names.forEach((n, i) => {
    if (isArmRole(roles[i], n)) upperSides.add(detectSide(n));
    if (isLegRole(roles[i], n)) lowerSides.add(detectSide(n));
  });
  const upperBilateral =
    (upperSides.has("left") && upperSides.has("right")) || hands.length >= 2;
  const lowerBilateral =
    (lowerSides.has("left") && lowerSides.has("right")) || feet.length >= 2;

  if (head && upperBilateral && lowerBilateral) return "humanoid";
  if (head && hands.length === 0 && (feet.length >= 2 || limbs >= 3)) return "creature";
  if (!head && wheels >= 2) return "vehicle";
  if (!head && limbs === 0 && hinges > 0) return "mechanical";
  if (writables === 0 || roles.length <= 2) return "prop";
  if (!head && limbs === 0 && writables > 0) return "mechanical";
  return "unknown";
}

// ── Skeleton assembly ───────────────────────────────────────────────────────

export interface SkeletonOptions {
  /** World positions keyed by binding path (2.4 enriched payload). */
  positions?: Record<string, Vec3>;
}

function rankOrderedSpine(joints: SemanticJoint[]): string[] {
  return joints
    .filter((j) => j.semanticRole in SPINE_RANK)
    .sort((a, b) => {
      const ra = SPINE_RANK[a.semanticRole] ?? 99;
      const rb = SPINE_RANK[b.semanticRole] ?? 99;
      if (ra !== rb) return ra - rb;
      // Rank 0 holds both the Model container ("root") and the moving
      // part ("locomotionRoot"): the container leads the chain.
      const ca = a.semanticRole === "root" ? 0 : 1;
      const cb = b.semanticRole === "root" ? 0 : 1;
      if (ca !== cb) return ca - cb;
      return a.name.localeCompare(b.name);
    })
    .map((j) => j.name);
}

/** Hierarchy depths (binding path → depth) via BFS from parentless roots. */
export function computeDepths(bindings: JointBinding[]): Map<string, number> {
  const graph = buildJointGraph(bindings);
  const depths = new Map<string, number>();
  const queue: string[] = [];
  for (const b of bindings) {
    if (b.parent === undefined) {
      depths.set(b.path, 0);
      queue.push(b.path);
    }
  }
  while (queue.length > 0) {
    const cur = queue.shift() as string;
    const curDepth = depths.get(cur) ?? 0;
    const curBinding = graph.byPath.get(cur);
    if (!curBinding) continue;
    for (const childName of curBinding.children) {
      for (const c of graph.byName.get(childName) ?? []) {
        if (!depths.has(c.path)) {
          depths.set(c.path, curDepth + 1);
          queue.push(c.path);
        }
      }
    }
  }
  for (const b of bindings) {
    if (!depths.has(b.path)) depths.set(b.path, 0);
  }
  return depths;
}

function pickRoot(bindings: JointBinding[], joints: SemanticJoint[]): string {
  const byRole = (r: string): string | undefined =>
    joints.find((j) => j.semanticRole === r)?.name;
  const parentless = bindings.find((b) => b.parent === undefined);
  const parentlessJoint = parentless
    ? joints.find((j) => j.path === parentless.path)?.name
    : undefined;
  return byRole("root") ?? byRole("locomotionRoot") ?? parentlessJoint ?? joints[0]?.name ?? "";
}

export function buildSemanticSkeleton(
  bindings: JointBinding[],
  opts?: SkeletonOptions,
): SemanticSkeleton {
  const graph = buildJointGraph(bindings);
  const roleCtx = rigRoleContext(bindings.map((b) => b.name));
  const joints: SemanticJoint[] = bindings.map((b) => {
    // Leaf = drives nothing below it (no children). Note: being someone's
    // child is irrelevant — only outgoing links count.
    const isLeaf = b.children.length === 0;
    const role = classifySemanticRole(
      {
        name: b.name,
        kind: b.kind,
        legacyKind: b.legacyKind,
        isLeaf,
      },
      roleCtx,
    );
    return {
      name: b.name,
      path: b.path,
      jointKind: b.kind,
      semanticRole: role,
      ...(b.parent !== undefined ? { parent: b.parent } : {}),
      children: [...b.children],
      isEndEffector: isLeaf && b.drive.writable && b.kind !== "Weld" && b.kind !== "Custom",
    };
  });

  // Real hierarchy depths via BFS from parentless roots (drives landmark
  // tie-breaks). Dangling-parent bindings fall back to depth 0.
  const depths = computeDepths(bindings);

  const cands: LandmarkCandidate[] = joints.map((j) => ({
    name: j.name,
    role: j.semanticRole,
    depth: depths.get(j.path) ?? 0,
    isLeaf: j.children.length === 0,
    side: detectSide(j.name),
  }));
  const marks = detectLandmarks(cands);

  // Positional fallback for the head: highest writable joint when naming fails
  // AND at least half the bindings carry positions (else it is a guess).
  const methods = { ...marks.methods };
  let head = marks.head;
  if (!head && opts?.positions) {
    const positioned = bindings.filter((b) => opts.positions?.[b.path] !== undefined);
    if (positioned.length >= Math.ceil(bindings.length / 2) && positioned.length > 0) {
      const top = [...positioned].sort(
        (a, b) => (opts.positions?.[b.path]?.y ?? 0) - (opts.positions?.[a.path]?.y ?? 0),
      )[0];
      if (top.drive.writable) {
        head = top.name;
        methods.head = "position";
      }
    }
  }

  const root = pickRoot(bindings, joints);

  let spineChain: string[] = [];
  if (head && root) {
    const chain = chainBetween(graph, root, head);
    if (chain) spineChain = chain.map((b) => b.name);
  }
  // Flat hierarchies (parts parented straight to the Model) yield a trivial
  // 2-node topological chain that skips the neck/spine joints. Whenever the
  // ranked spine covers more ground, it is the useful answer for solvers.
  const ranked = rankOrderedSpine(joints);
  if (ranked.length > spineChain.length) spineChain = ranked;

  const probableHands = marks.hands.length > 0 ? marks.hands : undefined;
  const probableFeet = marks.feet.length > 0 ? marks.feet : undefined;
  return {
    root,
    joints,
    ...(head ? { probableHead: head } : {}),
    ...(probableHands ? { probableHands } : {}),
    ...(probableFeet ? { probableFeet } : {}),
    ...(spineChain.length > 0 ? { spineChain } : {}),
  };
}
