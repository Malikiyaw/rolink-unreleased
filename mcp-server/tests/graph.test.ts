import { describe, expect, it } from "vitest";
import {
  blend1DWeights,
  makeEdge,
  makeGraph,
  makeNode,
  topoSort,
  validateGraph,
  type AnimationGraph,
} from "../src/animation/graph.js";

function locomotionGraph(): AnimationGraph {
  const g = makeGraph("loco", "out");
  g.parameters = { speed: 0.5 };
  g.nodes.push(
    makeNode("Clip", "idle", { clip: "Idle" }),
    makeNode("Clip", "walk", { clip: "Walk" }),
    makeNode("Blend1D", "blend", { parameter: "speed" }),
    makeNode("Output", "out"),
  );
  g.edges.push(
    makeEdge("idle", "blend", "a"),
    makeEdge("walk", "blend", "b"),
    makeEdge("blend", "out", "source"),
  );
  return g;
}

describe("Task 7.3 — graph construction", () => {
  it("validates a clean locomotion graph", () => {
    const v = validateGraph(locomotionGraph());
    expect(v.ok).toBe(true);
    expect(v.errors).toEqual([]);
  });

  it("orders sources before sinks", () => {
    const order = topoSort(locomotionGraph());
    expect(order.indexOf("idle")).toBeLessThan(order.indexOf("blend"));
    expect(order.indexOf("blend")).toBeLessThan(order.indexOf("out"));
  });

  it("computes Blend1D weights that always sum to 1", () => {
    expect(blend1DWeights(0)).toEqual({ a: 1, b: 0 });
    expect(blend1DWeights(1)).toEqual({ a: 0, b: 1 });
    expect(blend1DWeights(0.5)).toEqual({ a: 0.5, b: 0.5 });
    expect(blend1DWeights(-2)).toEqual({ a: 1, b: 0 });
    expect(blend1DWeights(7)).toEqual({ a: 0, b: 1 });
  });
});

describe("Task 7.4 — graph validation catches defects", () => {
  it("catches cycles", () => {
    const g = makeGraph("cyclic", "out");
    g.nodes.push(makeNode("Clip", "a", { clip: "A" }), makeNode("Speed", "s", { speed: 1 }), makeNode("Output", "out"));
    g.edges.push(makeEdge("a", "s", "source"), makeEdge("s", "a", "source"), makeEdge("s", "out", "source"));
    const v = validateGraph(g);
    expect(v.ok).toBe(false);
    expect(v.errors.join(" ")).toContain("cycle");
    expect(() => topoSort(g)).toThrow(/cycle/);
  });

  it("catches unknown nodes, bad ports, and double-driven inputs", () => {
    const g = locomotionGraph();
    g.edges.push(makeEdge("ghost", "blend", "a"));
    g.edges.push(makeEdge("idle", "blend", "sideways"));
    const v = validateGraph(g);
    expect(v.ok).toBe(false);
    expect(v.errors.join(" ")).toContain('unknown source "ghost"');
    expect(v.errors.join(" ")).toContain("not an input");
    expect(v.errors.join(" ")).toContain("driven 2 times");
  });

  it("catches missing inputs, bad params, and duplicate ids", () => {
    const g = makeGraph("bad", "out");
    g.parameters = {};
    g.nodes.push(
      makeNode("Clip", "c", {}),
      makeNode("Blend1D", "b", { parameter: "speed" }),
      makeNode("Over", "o", { weight: 5 }),
      makeNode("Speed", "s", { speed: 0 }),
      makeNode("Output", "out"),
      makeNode("Clip", "c", { clip: "Dup" }),
    );
    g.edges.push(makeEdge("c", "o", "base"));
    const v = validateGraph(g);
    expect(v.ok).toBe(false);
    const all = v.errors.join(" | ");
    expect(all).toContain("params.clip");
    expect(all).toContain("not declared");
    expect(all).toContain("weight");
    expect(all).toContain("non-zero");
    expect(all).toContain("unconnected");
    expect(all).toContain("duplicate node id");
  });

  it("warns (not errors) on dead subgraphs", () => {
    const g = locomotionGraph();
    g.nodes.push(makeNode("Clip", "unused", { clip: "Unused" }));
    const v = validateGraph(g);
    expect(v.ok).toBe(true);
    expect(v.warnings.join(" ")).toContain('"unused"');
  });

  it("requires exactly one output sink", () => {
    const g = makeGraph("no-out");
    g.nodes.push(makeNode("Clip", "c", { clip: "C" }));
    expect(validateGraph(g).ok).toBe(false);
  });
});
