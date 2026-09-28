/**
 * RoLink JointAdapter — Task 1.3.
 *
 * Universal joint abstraction so the animation engine never assumes Motor6D.
 * Supports Motor6D, AnimationConstraint, Bone, Weld-derived follow joints,
 * rigid parts, and future custom joint types.
 *
 * Two ground truths this file mirrors (do not drift from them):
 *  1. studio-plugin/RoLink.lua rlJointKind(): Motor6D/Bone → "rotational",
 *     Weld/WeldConstraint → "follow", Attachment → "anchor",
 *     Model+PrimaryPart → "root", BasePart → "rigid", else "static".
 *  2. rlAnimApplyPose(): Motor6D writes .Transform, BasePart writes .CFrame,
 *     everything else errors "not directly posable" (Bone included).
 *
 * Honesty rule for uncertain hardware: AnimationConstraint/Bone direct-write
 * channels are declared as ORDERED CANDIDATES, not facts. The Studio side
 * (Task 1.4, RigAdapter.lua) probes each candidate at runtime via pcall and
 * reports `unsupported_direct` with a clear diagnostic when none resolve —
 * it must never pretend a write landed. This table stays the contract both
 * sides implement; if Roblox behavior differs, fix the table, not call sites.
 */

import type {
  JointKind,
  Quaternion,
  SemanticRole,
  Transform3D,
  Vec3,
} from "../../../shared/animationProtocol.js";
import { makeQuaternionIdentity, makeVec3 } from "../../../shared/animationProtocol.js";

export type { JointKind, SemanticRole, Transform3D } from "../../../shared/animationProtocol.js";

/** Legacy rlJointKind vocabulary — kept so analyze payloads stay compatible. */
export type LegacyJointKind =
  | "rotational"
  | "follow"
  | "anchor"
  | "root"
  | "rigid"
  | "static";

/**
 * Drive channels, in the order the Studio side must probe them.
 *  - Motor6DTransform: joint.Transform (proven: rlAnimApplyPose)
 *  - ConstraintTransform: AnimationConstraint-equivalent .Transform (PROBED at
 *    runtime — not yet verified against Creator docs in this repo)
 *  - PartCFrame: owning BasePart .CFrame (proven: rlAnimApplyPose)
 *  - ClipOnly: no direct write channel; must be baked via AnimationClip track
 *    (current Bone reality: resolvable by rlAnimResolveJoint, not posable)
 *  - None: static/decorative — never driven
 */
export type DriveChannel =
  | "Motor6DTransform"
  | "ConstraintTransform"
  | "PartCFrame"
  | "ClipOnly"
  | "None";

export interface DriveSpec {
  /** False → follow/read-only; the engine must animate a parent instead. */
  writable: boolean;
  /** Candidate channels, highest priority first. Studio probes in order. */
  channels: DriveChannel[];
  /** Human-readable rationale (surfaced in diagnostics). */
  reason: string;
}

export interface JointBinding {
  /** Track/joint name as the AI addresses it (e.g. "Head"). */
  name: string;
  /** Full instance path (e.g. "Workspace.NPC.Head"). */
  path: string;
  /** Actual Roblox ClassName (e.g. "Motor6D", "MeshPart"). */
  className: string;
  kind: JointKind;
  legacyKind: LegacyJointKind;
  semanticRole: SemanticRole;
  parent?: string;
  children: string[];
  /** JointInstance endpoints, when known. */
  part0?: string;
  part1?: string;
  /** Rest-pose local transform (bind pose). */
  rest: Transform3D;
  drive: DriveSpec;
  notes: string[];
}

/** Raw node shape produced by rlModelAnalyze (the compat input). */
export interface AnalyzeNodeInput {
  path: string;
  name: string;
  class: string;
  kind: string;
  depth: number;
}

// ── Classification tables (the contract; Task 1.4 mirrors these) ───────────

/** Ordered drive candidates per joint kind. */
export const DRIVE_CHANNELS: Record<JointKind, DriveChannel[]> = {
  Motor6D: ["Motor6DTransform"],
  AnimationConstraint: ["ConstraintTransform", "ClipOnly"],
  Bone: ["ClipOnly"],
  Weld: ["None"],
  Rigid: ["PartCFrame"],
  Custom: ["None"],
};

const CLASS_TO_KIND: Record<string, { kind: JointKind; legacyKind: LegacyJointKind }> = {
  Motor6D: { kind: "Motor6D", legacyKind: "rotational" },
  AnimationConstraint: { kind: "AnimationConstraint", legacyKind: "rotational" },
  Bone: { kind: "Bone", legacyKind: "rotational" },
  Weld: { kind: "Weld", legacyKind: "follow" },
  Snap: { kind: "Weld", legacyKind: "follow" },
  ManualWeld: { kind: "Weld", legacyKind: "follow" },
  WeldConstraint: { kind: "Weld", legacyKind: "follow" },
  Attachment: { kind: "Custom", legacyKind: "anchor" },
  Model: { kind: "Rigid", legacyKind: "root" },
  Part: { kind: "Rigid", legacyKind: "rigid" },
  MeshPart: { kind: "Rigid", legacyKind: "rigid" },
  UnionOperation: { kind: "Rigid", legacyKind: "rigid" },
  CornerWedgePart: { kind: "Rigid", legacyKind: "rigid" },
  WedgePart: { kind: "Rigid", legacyKind: "rigid" },
  TrussPart: { kind: "Rigid", legacyKind: "rigid" },
  SpawnLocation: { kind: "Rigid", legacyKind: "rigid" },
  Seat: { kind: "Rigid", legacyKind: "rigid" },
  VehicleSeat: { kind: "Rigid", legacyKind: "rigid" },
};

export function classifyRobloxClass(className: string): {
  kind: JointKind;
  legacyKind: LegacyJointKind;
} {
  const hit = CLASS_TO_KIND[className];
  if (hit) return { ...hit };
  return { kind: "Custom", legacyKind: "static" };
}

function driveSpecFor(kind: JointKind, className: string): DriveSpec {
  switch (kind) {
    case "Motor6D":
      return {
        writable: true,
        channels: [...DRIVE_CHANNELS.Motor6D],
        reason: "Motor6D.Transform is the proven animation channel (rlAnimApplyPose)",
      };
    case "AnimationConstraint":
      return {
        writable: true,
        channels: [...DRIVE_CHANNELS.AnimationConstraint],
        reason:
          "candidate .Transform probed at runtime; falls back to ClipOnly with " +
          "unsupported_direct diagnostic when absent",
      };
    case "Bone":
      return {
        writable: false,
        channels: [...DRIVE_CHANNELS.Bone],
        reason: "Bone has no direct write channel in the current plugin — bake via AnimationClip",
      };
    case "Weld":
      return {
        writable: false,
        channels: [...DRIVE_CHANNELS.Weld],
        reason: `follow joint (${className}): animate the parent, never this`,
      };
    case "Rigid":
      return {
        writable: true,
        channels: [...DRIVE_CHANNELS.Rigid],
        reason: "rigid part driven via BasePart.CFrame (rlAnimApplyPose)",
      };
    case "Custom":
      return {
        writable: false,
        channels: [...DRIVE_CHANNELS.Custom],
        reason: `unsupported joint technology (${className}): read-only`,
      };
  }
}

// ── Factories ───────────────────────────────────────────────────────────────

export function makeRestTransform(position?: Vec3, rotation?: Quaternion): Transform3D {
  return {
    position: position ? { ...position } : makeVec3(),
    rotation: rotation ? { ...rotation } : makeQuaternionIdentity(),
  };
}

export function createJointBinding(input: {
  name: string;
  path: string;
  className: string;
  parent?: string;
  children?: string[];
  part0?: string;
  part1?: string;
  rest?: Transform3D;
  semanticRole?: SemanticRole;
  note?: string;
}): JointBinding {
  const { kind, legacyKind } = classifyRobloxClass(input.className);
  const notes: string[] = input.note ? [input.note] : [];
  return {
    name: input.name,
    path: input.path,
    className: input.className,
    kind,
    legacyKind,
    semanticRole: input.semanticRole ?? (legacyKind === "root" ? "root" : "unknown"),
    ...(input.parent !== undefined ? { parent: input.parent } : {}),
    children: input.children ? [...input.children] : [],
    ...(input.part0 !== undefined ? { part0: input.part0 } : {}),
    ...(input.part1 !== undefined ? { part1: input.part1 } : {}),
    rest: input.rest ?? makeRestTransform(),
    drive: driveSpecFor(kind, input.className),
    notes,
  };
}

/**
 * Build bindings from rlModelAnalyze nodes (backward-compat bridge).
 * Parent links are derived from path prefixes when depth allows; nodes the
 * analyzer marked "static" never arrive here (the plugin filters them out),
 * but unknown `kind` strings are tolerated and classified via ClassName.
 */
export function adaptersFromAnalyzeNodes(
  nodes: AnalyzeNodeInput[],
  opts?: { semanticRoles?: Record<string, SemanticRole> },
): JointBinding[] {
  const byPath = new Map<string, AnalyzeNodeInput>();
  for (const n of nodes) byPath.set(n.path, n);
  return nodes.map((n) => {
    let parent: string | undefined;
    const dot = n.path.lastIndexOf(".");
    if (dot > 0) {
      const parentPath = n.path.slice(0, dot);
      const parentNode = byPath.get(parentPath);
      if (parentNode) parent = parentNode.name;
    }
    const semanticRole = opts?.semanticRoles?.[n.name] ?? opts?.semanticRoles?.[n.path];
    return createJointBinding({
      name: n.name,
      path: n.path,
      className: n.class,
      ...(parent !== undefined ? { parent } : {}),
      ...(semanticRole !== undefined ? { semanticRole } : {}),
    });
  });
}

// ── Hierarchy queries (IK chain construction consumes these in Phase 4) ─────

export interface JointGraph {
  byName: Map<string, JointBinding[]>;
  byPath: Map<string, JointBinding>;
}

export function buildJointGraph(bindings: JointBinding[]): JointGraph {
  const byName = new Map<string, JointBinding[]>();
  const byPath = new Map<string, JointBinding>();
  for (const b of bindings) {
    const list = byName.get(b.name) ?? [];
    list.push(b);
    byName.set(b.name, list);
    byPath.set(b.path, b);
  }
  // Populate children from parent links when the source omitted them.
  for (const b of bindings) {
    if (b.parent === undefined) continue;
    const parents = byName.get(b.parent) ?? [];
    for (const p of parents) {
      if (!p.children.includes(b.name)) p.children.push(b.name);
    }
  }
  return { byName, byPath };
}

/**
 * Legacy resolution order mirroring rlAnimResolveJoint (name match among
 * Motor6D | Bone | BasePart). When several bindings share a name, prefer
 * Motor6D > AnimationConstraint > Bone > Rigid part — documented
 * approximation; the plugin remains source of truth at runtime.
 */
const LEGACY_CLASS_PRIORITY = ["Motor6D", "AnimationConstraint", "Bone"] as const;

export function resolveLegacyCandidate(bindings: JointBinding[], track: string): JointBinding | undefined {
  const named = bindings.filter((b) => b.name === track);
  if (named.length === 0) return undefined;
  const rank = (b: JointBinding): number => {
    const i = LEGACY_CLASS_PRIORITY.indexOf(b.className as (typeof LEGACY_CLASS_PRIORITY)[number]);
    if (i >= 0) return i;
    if (b.kind === "Rigid") return LEGACY_CLASS_PRIORITY.length;
    return LEGACY_CLASS_PRIORITY.length + 1;
  };
  return [...named].sort((a, b) => rank(a) - rank(b))[0];
}

/**
 * Shortest joint chain root → … → end (inclusive) via BFS over parent links.
 * Returns undefined when either endpoint is missing or unconnected.
 */
export function chainBetween(
  graph: JointGraph,
  rootName: string,
  endName: string,
): JointBinding[] | undefined {
  const roots = graph.byName.get(rootName) ?? [];
  const ends = graph.byName.get(endName) ?? [];
  if (roots.length === 0 || ends.length === 0) return undefined;
  const start = roots[0];
  const targetPaths = new Set(ends.map((e) => e.path));
  const prev = new Map<string, string>();
  const seen = new Set<string>([start.path]);
  const queue: string[] = [start.path];
  while (queue.length > 0) {
    const cur = queue.shift() as string;
    if (targetPaths.has(cur)) {
      const chain: JointBinding[] = [];
      let at: string | undefined = cur;
      while (at !== undefined) {
        const b = graph.byPath.get(at) as JointBinding;
        chain.unshift(b);
        at = prev.get(at);
      }
      return chain;
    }
    const curBinding = graph.byPath.get(cur) as JointBinding;
    const neighbors: string[] = [];
    if (curBinding.parent !== undefined) {
      for (const p of graph.byName.get(curBinding.parent) ?? []) neighbors.push(p.path);
    }
    for (const childName of curBinding.children) {
      for (const c of graph.byName.get(childName) ?? []) neighbors.push(c.path);
    }
    for (const nx of neighbors) {
      if (!seen.has(nx)) {
        seen.add(nx);
        prev.set(nx, cur);
        queue.push(nx);
      }
    }
  }
  return undefined;
}

export function findRootBindings(bindings: JointBinding[]): JointBinding[] {
  return bindings.filter((b) => b.parent === undefined || b.legacyKind === "root");
}

export function findEndEffectors(bindings: JointBinding[]): JointBinding[] {
  return bindings.filter((b) => {
    if (b.children.length > 0) return false;
    if (b.kind === "Weld" || b.kind === "Custom") return false;
    return true;
  });
}

// ── Validation ──────────────────────────────────────────────────────────────

export interface BindingValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export function validateBindings(bindings: JointBinding[]): BindingValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const seenByName = new Map<string, number>();
  for (const b of bindings) seenByName.set(b.name, (seenByName.get(b.name) ?? 0) + 1);
  for (const [name, count] of seenByName) {
    if (count > 1) {
      errors.push(
        `duplicate joint name "${name}" (${count} bindings): legacy track resolution is ambiguous — rename or qualify paths`,
      );
    }
  }
  const names = new Set(bindings.map((b) => b.name));
  for (const b of bindings) {
    if (b.parent !== undefined && !names.has(b.parent)) {
      warnings.push(`dangling parent "${b.parent}" on "${b.name}" (${b.path})`);
    }
  }
  const kinds = new Set(bindings.map((b) => b.kind));
  if (kinds.has("Motor6D") && kinds.has("AnimationConstraint")) {
    warnings.push(
      "mixed rig technology (Motor6D + AnimationConstraint): drive channels differ per joint — verify each binding's probed channel",
    );
  }
  if (bindings.length > 0 && !bindings.some((b) => b.drive.writable)) {
    errors.push("rig has no writable joints: nothing can be posed (animate a parent or add Motor6D joints)");
  }
  const bones = bindings.filter((b) => b.kind === "Bone");
  if (bones.length > 0) {
    warnings.push(
      `${bones.length} Bone joint(s) (${bones.slice(0, 3).map((b) => b.name).join(", ")}${
        bones.length > 3 ? ", …" : ""
      }): ClipOnly — not directly posable by the current plugin`,
    );
  }
  return { ok: errors.length === 0, errors, warnings };
}

// ── Runtime guard (JSON boundary) ───────────────────────────────────────────

function isRecord(o: unknown): o is Record<string, unknown> {
  return typeof o === "object" && o !== null && !Array.isArray(o);
}

export function isJointBinding(o: unknown): o is JointBinding {
  if (!isRecord(o)) return false;
  if (typeof o.name !== "string" || o.name.length === 0) return false;
  if (typeof o.path !== "string" || o.path.length === 0) return false;
  if (typeof o.className !== "string") return false;
  if (typeof o.kind !== "string" || typeof o.legacyKind !== "string") return false;
  if (!Array.isArray(o.children)) return false;
  if (!isRecord(o.rest)) return false;
  if (!isRecord(o.drive)) return false;
  const drive = o.drive as Record<string, unknown>;
  if (typeof drive.writable !== "boolean" || !Array.isArray(drive.channels)) return false;
  if (!Array.isArray(o.notes)) return false;
  return true;
}
