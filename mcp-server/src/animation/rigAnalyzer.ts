/**
 * RoLink rig analyzer — Task 2.1.
 *
 * Upgrades `analyze_animatable_model` data (flat node lists) into a
 * RigAnalysis with a full SemanticSkeleton: hierarchy depths, joint kinds,
 * semantic roles, end effectors, root, spine chain, and landmarks —
 * plus a RigType so the future AnimationCompiler can pick the solver.
 *
 * Inputs stay JSON-plain so they can travel bridge → MCP untouched:
 *  - nodes: the exact rlModelAnalyze shape (Task 1.3 AnalyzeNodeInput);
 *  - enriched: optional Task 2.4 RigAdapter.describe payloads (Part0/Part1,
 *    C0/C1/Transform rest poses, part sizes, world transforms), matched
 *    by path (falling back to name).
 */

import type {
  Quaternion,
  RigAnalysis,
  SemanticRole,
  Vec3,
} from "../../../shared/animationProtocol.js";
import {
  adaptersFromAnalyzeNodes,
  validateBindings,
  type AnalyzeNodeInput,
  type JointBinding,
} from "./jointAdapter.js";
import {
  buildSemanticSkeleton,
  classifyRigType,
  computeDepths,
  type RigType,
} from "./semanticRig.js";

export interface PoseSample {
  position: Vec3;
  rotation: Quaternion;
}

export interface JointPropertyPayload {
  endpoints?: {
    part0?: { name: string; className: string };
    part1?: { name: string; className: string };
  };
  joint?: {
    transform?: PoseSample;
    c0?: PoseSample;
    c1?: PoseSample;
  };
  size?: Vec3;
  world?: PoseSample;
  primaryPart?: string;
}

export interface EnrichedJointInput {
  path: string;
  name?: string;
  className?: string;
  props: JointPropertyPayload;
}

export interface AnalyzeRigOptions {
  enriched?: EnrichedJointInput[];
  semanticRoles?: Record<string, SemanticRole>;
}

export interface RigAnalysisResult {
  analysis: RigAnalysis;
  rigType: RigType;
  bindings: JointBinding[];
}

function findEnriched(
  enriched: EnrichedJointInput[] | undefined,
  b: JointBinding,
): EnrichedJointInput | undefined {
  if (!enriched) return undefined;
  return (
    enriched.find((e) => e.path === b.path) ??
    enriched.find((e) => e.name !== undefined && e.name === b.name)
  );
}

function mergeEnriched(bindings: JointBinding[], enriched?: EnrichedJointInput[]): Record<string, Vec3> {
  const positions: Record<string, Vec3> = {};
  if (!enriched) return positions;
  for (const b of bindings) {
    const e = findEnriched(enriched, b);
    if (!e) continue;
    const rest = e.props.joint?.transform ?? e.props.joint?.c0;
    if (rest) {
      b.rest = {
        position: { ...rest.position },
        rotation: { ...rest.rotation },
      };
    }
    if (e.props.world) positions[b.path] = { ...e.props.world.position };
  }
  return positions;
}

export function analyzeRig(
  target: string,
  nodes: AnalyzeNodeInput[],
  opts?: AnalyzeRigOptions,
): RigAnalysisResult {
  const bindings = adaptersFromAnalyzeNodes(nodes, {
    semanticRoles: opts?.semanticRoles,
  });
  const positions = mergeEnriched(bindings, opts?.enriched);

  const validation = validateBindings(bindings);
  const warnings: string[] = [...validation.warnings];
  for (const e of validation.errors) warnings.push("error: " + e);

  const skeleton = buildSemanticSkeleton(bindings, {
    ...(Object.keys(positions).length > 0 ? { positions } : {}),
  });
  const depths = computeDepths(bindings);
  let maxDepth = 0;
  for (const d of depths.values()) maxDepth = Math.max(maxDepth, d);

  const rigType = classifyRigType({
    roles: skeleton.joints.map((j) => j.semanticRole),
    names: skeleton.joints.map((j) => j.name),
    kinds: bindings.map((b) => b.kind),
    ...(skeleton.probableHead ? { head: skeleton.probableHead } : {}),
    hands: skeleton.probableHands ?? [],
    feet: skeleton.probableFeet ?? [],
  });

  if (!skeleton.root) warnings.push("no rig root resolved: parent links form no hierarchy");
  if (maxDepth >= 6) {
    warnings.push(
      `depth ${maxDepth} reaches the plugin walk cap (6): deeper joints were truncated at inspection`,
    );
  }
  if (opts?.enriched && opts.enriched.length > 0) {
    const matched = bindings.filter((b) => findEnriched(opts.enriched, b) !== undefined).length;
    if (matched < bindings.length) {
      warnings.push(
        `enriched payload covered ${matched}/${bindings.length} bindings; the rest use snapshot defaults`,
      );
    }
  }

  return {
    analysis: {
      target,
      jointCount: bindings.length,
      maxDepth,
      skeleton,
      warnings,
      analyzedAt: Date.now(),
    },
    rigType,
    bindings,
  };
}

/** Compact human/AI-readable summary for logs and future tool prompts. */
export function summarizeRigAnalysis(result: RigAnalysisResult): string {
  const a = result.analysis;
  const lines = [
    `rig: ${a.target} (${result.rigType}, ${a.jointCount} joints, depth ${a.maxDepth})`,
    `root: ${a.skeleton.root || "(none)"}`,
  ];
  if (a.skeleton.probableHead) lines.push(`head: ${a.skeleton.probableHead}`);
  if (a.skeleton.probableHands?.length) lines.push(`hands: ${a.skeleton.probableHands.join(", ")}`);
  if (a.skeleton.probableFeet?.length) lines.push(`feet: ${a.skeleton.probableFeet.join(", ")}`);
  if (a.skeleton.spineChain?.length) lines.push(`spine: ${a.skeleton.spineChain.join(" > ")}`);
  for (const w of a.warnings) lines.push(`warning: ${w}`);
  return lines.join("\n");
}
