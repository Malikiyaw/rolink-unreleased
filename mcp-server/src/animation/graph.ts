/**
 * RoLink animation graphs — Tasks 7.3 + 7.4.
 *
 * Data model + structural validation for Roblox-style animation graphs:
 * clips wired through Blend1D/Blend2D, Sequence, RandomSequence, Mask,
 * Over, Add, Subtract, and Speed nodes into one Output sink. Connections
 * are named input ports, validated per node kind — a graph that passes
 * validateGraph has no cycles, no dangling or double-driven inputs, no
 * unknown nodes, and kind-correct parameters.
 *
 * Scope honesty: this phase builds CONSTRUCTION + VALIDATION (+ topological
 * order and Blend1D weight queries for future previews). Full pose-level
 * evaluation against baked clips belongs to the runtime/compiler work
 * (Phase 8+), which will consume topoSort + validated topology here.
 */

export type GraphNodeKind =
  | "Clip"
  | "Blend1D"
  | "Blend2D"
  | "Sequence"
  | "RandomSequence"
  | "Mask"
  | "Over"
  | "Add"
  | "Subtract"
  | "Speed"
  | "Output";

export type GraphParam = number | string | boolean | string[];

export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  params?: Record<string, GraphParam>;
}

export interface GraphEdge {
  /** Source node id (its single output). */
  from: string;
  /** Destination node id. */
  to: string;
  /** Named input port on the destination. */
  input: string;
}

export interface AnimationGraph {
  name: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Declared scalar parameters (Blend1D selectors, Speed factors...). */
  parameters: Record<string, number>;
  /** Node id feeding the final Output sink. */
  output: string;
}

export interface GraphValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

// ── Port model ──────────────────────────────────────────────────────────────

/** Required input ports per kind ("*" = variadic ordered 0..n). */
const REQUIRED_INPUTS: Record<GraphNodeKind, string[]> = {
  Clip: [],
  Blend1D: ["a", "b"],
  Blend2D: ["a", "b", "c"],
  Sequence: ["*"],
  RandomSequence: ["*"],
  Mask: ["base", "overlay"],
  Over: ["base", "layer"],
  Add: ["base", "layer"],
  Subtract: ["base", "layer"],
  Speed: ["source"],
  Output: ["source"],
};

function portAllowed(kind: GraphNodeKind, input: string, index: number): boolean {
  const req = REQUIRED_INPUTS[kind];
  if (req.includes("*")) return /^\d+$/.test(input) && Number(input) === index;
  return req.includes(input);
}

// ── Construction ────────────────────────────────────────────────────────────

let graphNodeCounter = 0;

export function makeNode(kind: GraphNodeKind, id?: string, params?: Record<string, GraphParam>): GraphNode {
  const nodeId = id ?? `${kind}_${(graphNodeCounter += 1)}`;
  return { id: nodeId, kind, ...(params ? { params: { ...params } } : {}) };
}

export function makeEdge(from: string, to: string, input: string): GraphEdge {
  return { from, to, input };
}

export function makeGraph(name: string, output = ""): AnimationGraph {
  return { name, nodes: [], edges: [], parameters: {}, output };
}

// ── Validation (Task 7.4) ───────────────────────────────────────────────────

function validateNodeParams(node: GraphNode, parameters: Record<string, number>): string[] {
  const errors: string[] = [];
  const p = node.params ?? {};
  const num = (key: string): number | undefined =>
    typeof p[key] === "number" ? (p[key] as number) : undefined;
  switch (node.kind) {
    case "Clip": {
      if (typeof p["clip"] !== "string" || (p["clip"] as string).length === 0) {
        errors.push(`Clip "${node.id}": params.clip must name a clip`);
      }
      break;
    }
    case "Blend1D": {
      if (typeof p["parameter"] !== "string" || (p["parameter"] as string).length === 0) {
        errors.push(`Blend1D "${node.id}": params.parameter must name a graph parameter`);
      } else if (!(p["parameter"] as string in parameters)) {
        errors.push(`Blend1D "${node.id}": parameter "${p["parameter"]}" is not declared`);
      }
      break;
    }
    case "Blend2D": {
      for (const key of ["px", "py", "ax", "ay", "bx", "by", "cx", "cy"]) {
        if (num(key) === undefined) errors.push(`Blend2D "${node.id}": params.${key} must be a number`);
      }
      break;
    }
    case "RandomSequence": {
      if (p["weights"] !== undefined && !Array.isArray(p["weights"])) {
        errors.push(`RandomSequence "${node.id}": params.weights must be a number array`);
      }
      break;
    }
    case "Mask": {
      if (!Array.isArray(p["joints"]) || (p["joints"] as unknown[]).length === 0) {
        errors.push(`Mask "${node.id}": params.joints must list at least one joint`);
      }
      break;
    }
    case "Over": {
      const w = num("weight");
      if (w === undefined || w < 0 || w > 1) {
        errors.push(`Over "${node.id}": params.weight must be in [0, 1]`);
      }
      break;
    }
    case "Speed": {
      const s = num("speed");
      if (s === undefined || !Number.isFinite(s) || s === 0) {
        errors.push(`Speed "${node.id}": params.speed must be a finite non-zero number`);
      }
      break;
    }
    case "Sequence":
    case "Add":
    case "Subtract":
    case "Output": {
      break;
    }
  }
  return errors;
}

export function validateGraph(graph: AnimationGraph): GraphValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  // Index ids once: duplicate detection and per-node edge lookups both ran a
  // full scan per item (O(n^2) / O(E^2) on large graphs).
  const idCounts = new Map<string, number>();
  for (const n of graph.nodes) idCounts.set(n.id, (idCounts.get(n.id) ?? 0) + 1);
  for (const [id, count] of idCounts) {
    if (count > 1) errors.push(`duplicate node id "${id}"`);
  }
  const edgesByTarget = new Map<string, GraphEdge[]>();
  for (const e of graph.edges) {
    const list = edgesByTarget.get(e.to);
    if (list) list.push(e);
    else edgesByTarget.set(e.to, [e]);
  }
  const outputs = graph.nodes.filter((n) => n.kind === "Output");
  if (outputs.length === 0) errors.push("graph has no Output node");
  if (outputs.length > 1) errors.push(`graph has ${outputs.length} Output nodes (need exactly 1)`);
  if (!graph.output) {
    errors.push("graph.output is empty");
  } else if (!byId.has(graph.output)) {
    errors.push(`graph.output "${graph.output}" names no node`);
  }

  // Edge integrity + per-port occupancy.
  const driven = new Map<string, number>();
  graph.edges.forEach((e, i) => {
    if (!byId.has(e.from)) errors.push(`edge ${i}: unknown source "${e.from}"`);
    if (!byId.has(e.to)) errors.push(`edge ${i}: unknown destination "${e.to}"`);
    if (e.from === e.to) errors.push(`edge ${i}: self-loop on "${e.from}"`);
    if (byId.has(e.to)) {
      const target = byId.get(e.to) as GraphNode;
      const siblings = edgesByTarget.get(e.to) ?? [];
      const portIndex = siblings.findIndex((x) => x.input === e.input && x.from === e.from);
      if (!portAllowed(target.kind, e.input, portIndex)) {
        errors.push(`edge ${i}: "${e.input}" is not an input of ${target.kind} "${e.to}"`);
      }
      const key = `${e.to}.${e.input}`;
      driven.set(key, (driven.get(key) ?? 0) + 1);
    }
  });
  for (const [key, count] of driven) {
    if (count > 1) errors.push(`input "${key}" is driven ${count} times (dataflow must be single-source)`);
  }
  for (const n of graph.nodes) {
    const req = REQUIRED_INPUTS[n.kind];
    if (req.includes("*")) {
      const idx = (edgesByTarget.get(n.id) ?? []).map((e) => e.input);
      const nums = idx.map((s) => Number(s)).filter((v) => Number.isInteger(v) && v >= 0).sort((a, b) => a - b);
      if (nums.length === 0) {
        errors.push(`${n.kind} "${n.id}": needs at least one numbered input`);
      } else {
        for (let k = 0; k < nums.length; k += 1) {
          if (nums[k] !== k) {
            errors.push(`${n.kind} "${n.id}": inputs must be dense from 0 (gap at ${k})`);
            break;
          }
        }
      }
    } else {
      for (const port of req) {
        if (!driven.has(`${n.id}.${port}`)) {
          errors.push(`${n.kind} "${n.id}": required input "${port}" is unconnected`);
        }
      }
    }
  }

  for (const n of graph.nodes) {
    for (const e of validateNodeParams(n, graph.parameters)) errors.push(e);
  }

  // Cycle detection over the whole graph (dataflow direction).
  const visiting = new Set<string>();
  const done = new Set<string>();
  const adjacency = new Map<string, string[]>();
  for (const n of graph.nodes) adjacency.set(n.id, []);
  for (const e of graph.edges) {
    if (byId.has(e.from) && byId.has(e.to)) adjacency.get(e.from)?.push(e.to);
  }
  const stack: string[] = [];
  const visit = (id: string): boolean => {
    if (done.has(id)) return true;
    if (visiting.has(id)) {
      const cycle = [...stack.slice(stack.indexOf(id)), id].join(" → ");
      errors.push(`cycle detected: ${cycle}`);
      return false;
    }
    visiting.add(id);
    stack.push(id);
    for (const next of adjacency.get(id) ?? []) {
      if (!visit(next)) return false;
    }
    stack.pop();
    visiting.delete(id);
    done.add(id);
    return true;
  };
  for (const n of graph.nodes) {
    if (!done.has(n.id)) visit(n.id);
  }

  // Reachability from the declared output (dead subgraphs warn, not error).
  if (graph.output && byId.has(graph.output)) {
    const upstream = new Map<string, string[]>();
    for (const n of graph.nodes) upstream.set(n.id, []);
    for (const e of graph.edges) {
      if (byId.has(e.from) && byId.has(e.to)) upstream.get(e.to)?.push(e.from);
    }
    const live = new Set<string>();
    const flood: string[] = [graph.output];
    while (flood.length > 0) {
      const cur = flood.pop() as string;
      if (live.has(cur)) continue;
      live.add(cur);
      for (const prev of upstream.get(cur) ?? []) flood.push(prev);
    }
    for (const n of graph.nodes) {
      if (!live.has(n.id)) warnings.push(`node "${n.id}" (${n.kind}) feeds no output and never runs`);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

// ── Structural queries ──────────────────────────────────────────────────────

/** Sources-first topological order (throws on cycles). */
export function topoSort(graph: AnimationGraph): string[] {
  const indegree = new Map<string, number>();
  const downstream = new Map<string, string[]>();
  for (const n of graph.nodes) {
    indegree.set(n.id, 0);
    downstream.set(n.id, []);
  }
  for (const e of graph.edges) {
    if (!indegree.has(e.from) || !indegree.has(e.to)) continue;
    indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);
    downstream.get(e.from)?.push(e.to);
  }
  const queue = [...indegree.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  const order: string[] = [];
  while (queue.length > 0) {
    const cur = queue.shift() as string;
    order.push(cur);
    for (const next of downstream.get(cur) ?? []) {
      indegree.set(next, (indegree.get(next) ?? 1) - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  }
  if (order.length !== graph.nodes.length) {
    throw new Error("topoSort: graph has a cycle");
  }
  return order;
}

/**
 * Blend1D child weights at a parameter value: children sit at 0 ("a")
 * and 1 ("b"), clamped outside. Pure and total — sums to 1.
 */
export function blend1DWeights(value: number): { a: number; b: number } {
  const b = Math.min(1, Math.max(0, value));
  return { a: 1 - b, b };
}
