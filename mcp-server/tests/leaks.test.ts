import { describe, expect, it } from "vitest";
import {
  bakeFixture,
  BENCH_STYLES,
  buildFixture,
  makeKey,
  benchmarkStyle,
} from "../src/animation/benchmarks.js";
import { analyzeRig } from "../src/animation/rigAnalyzer.js";
import {
  clearWordsCache,
  wordsOf,
  wordsCacheSize,
  WORDS_CACHE_LIMIT,
  splitWords,
  buildSemanticSkeleton,
} from "../src/animation/semanticRig.js";
import { compileAnimation } from "../src/animation/compiler.js";
import { makeGraph, makeNode, makeEdge, validateGraph } from "../src/animation/graph.js";
import { adaptersFromAnalyzeNodes } from "../src/animation/jointAdapter.js";

const NODES = [
  { path: "W.N", name: "N", class: "Model", kind: "root", depth: 0 },
  { path: "W.N.HumanoidRootPart", name: "HumanoidRootPart", class: "Part", kind: "rigid", depth: 1 },
  { path: "W.N.LowerTorso", name: "LowerTorso", class: "MeshPart", kind: "rigid", depth: 1 },
  { path: "W.N.UpperTorso", name: "UpperTorso", class: "MeshPart", kind: "rigid", depth: 1 },
  { path: "W.N.Head", name: "Head", class: "Part", kind: "rigid", depth: 1 },
  { path: "W.N.UpperTorso.Neck", name: "Neck", class: "Motor6D", kind: "rotational", depth: 2 },
  { path: "W.N.LeftUpperArm", name: "LeftUpperArm", class: "MeshPart", kind: "rigid", depth: 1 },
  { path: "W.N.UpperTorso.LeftShoulder", name: "LeftShoulder", class: "Motor6D", kind: "rotational", depth: 2 },
  { path: "W.N.LeftHand", name: "LeftHand", class: "MeshPart", kind: "rigid", depth: 1 },
  { path: "W.N.LeftUpperLeg", name: "LeftUpperLeg", class: "MeshPart", kind: "rigid", depth: 1 },
  { path: "W.N.LowerTorso.LeftHip", name: "LeftHip", class: "Motor6D", kind: "rotational", depth: 2 },
  { path: "W.N.LeftFoot", name: "LeftFoot", class: "MeshPart", kind: "rigid", depth: 1 },
];

function fullPipelinePass(runId: number): void {
  // Distinct part names per run: a per-run cache keyed by name would grow
  // without bound here, which is exactly the leak shape we want to catch.
  const nodes = NODES.map((n) => ({
    ...n,
    name: `${n.name}R${runId}`,
    path: `${n.path}R${runId}`,
  }));
  const { bindings } = analyzeRig("W.N", nodes);
  const skeleton = buildSemanticSkeleton(bindings);
  const roles = new Map(skeleton.joints.map((j) => [j.name, j.semanticRole]));
  const tracks = bindings
    .filter((b) => b.drive.writable && b.className !== "Model")
    .map((b, i) => ({
      joint: b.name,
      keys: [makeKey(b.name, 0, { x: 0, y: 0, z: 0 }, 0), makeKey(b.name, 0.5, { x: 0, y: i * 0.01, z: 0 }, 5)],
    }));
  compileAnimation({
    animation: "leak",
    tracks,
    bindings,
    roles,
    style: "ANIME",
    rigidAssembly: true,
    maxIterations: 2,
  });
}

function heapUsedMb(): number {
  const mem = process.memoryUsage();
  return (mem.heapUsed + mem.external) / (1024 * 1024);
}

describe("Task 11.4 — memory leak detection", () => {
  it("keeps the word cache bounded under unique-name pressure", () => {
    clearWordsCache();
    expect(wordsCacheSize()).toBe(0);
    // 5000 distinct names: occupancy must plateau at the cap, not track
    // the number of names seen (this is the assertion that actually
    // catches an unbounded cache — verified by fault injection).
    for (let i = 0; i < 5000; i += 1) wordsOf(`UniquePartName${i}_${i * 7}`);
    expect(wordsCacheSize()).toBeLessThanOrEqual(WORDS_CACHE_LIMIT);
    // Correctness must survive eviction.
    expect([...wordsOf("LeftUpperArm")]).toEqual(splitWords("LeftUpperArm"));
    expect([...wordsOf("LeftUpperArm")]).toEqual(["left", "upper", "arm"]);
    clearWordsCache();
    expect(wordsCacheSize()).toBe(0);
  });

  it("produces identical results before and after cache eviction", () => {
    clearWordsCache();
    const a = buildSemanticSkeleton(adaptersFromAnalyzeNodes(NODES));
    clearWordsCache();
    const b = buildSemanticSkeleton(adaptersFromAnalyzeNodes(NODES));
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it("does not grow the heap across repeated full pipeline runs", () => {
    // Warm up so JIT/one-time allocations are not counted as a leak.
    for (let i = 0; i < 20; i += 1) fullPipelinePass(i);
    if (typeof globalThis.gc === "function") (globalThis.gc as () => void)();
    const before = heapUsedMb();
    for (let i = 0; i < 200; i += 1) fullPipelinePass(1000 + i);
    if (typeof globalThis.gc === "function") (globalThis.gc as () => void)();
    const after = heapUsedMb();
    // 200 runs x 12 joints x fresh names = 2400 distinct names fed through
    // the name-keyed cache. A bounded cache holds flat; an unbounded one
    // grows by thousands of retained strings.
    expect(after - before, `heap grew ${(after - before).toFixed(2)} MB over 200 runs`).toBeLessThan(16);
    // Direct occupancy check: the cache must not hold every name it saw.
    expect(wordsCacheSize()).toBeLessThanOrEqual(WORDS_CACHE_LIMIT);
  }, 60_000);

  it("does not retain per-run data in the graph node counter", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 2000; i += 1) ids.add(makeNode("Clip").id);
    expect(ids.size).toBe(2000);
    const g = makeGraph("fresh", "o");
    g.parameters = { speed: 0 };
    g.nodes.push(
      makeNode("Clip", "i", { clip: "Idle" }),
      makeNode("Clip", "w", { clip: "Walk" }),
      makeNode("Blend1D", "b", { parameter: "speed" }),
      makeNode("Output", "o"),
    );
    g.edges.push(
      makeEdge("i", "b", "a"),
      makeEdge("w", "b", "b"),
      makeEdge("b", "o", "source"),
    );
    expect(validateGraph(g).ok).toBe(true);
  });

  it("leaves caller tracks untouched so repeated compiles do not accumulate", () => {
    const fx = buildFixture("ANIME");
    const { bindings } = analyzeRig("W.N", NODES);
    const roles = new Map(buildSemanticSkeleton(bindings).joints.map((j) => [j.name, j.semanticRole]));
    const tracks = fx.tracks.map((t) => ({ joint: t.joint, keys: t.keys }));
    const before = JSON.stringify(tracks);
    for (let i = 0; i < 10; i += 1) {
      compileAnimation({
        animation: "pure",
        tracks,
        bindings,
        roles,
        style: "ANIME",
        rigidAssembly: true,
        maxIterations: 2,
      });
    }
    expect(JSON.stringify(tracks)).toBe(before);
  });

  it("bakes every style without unbounded key growth", () => {
    for (const style of BENCH_STYLES) {
      const baked = bakeFixture(style, 30);
      expect(baked.length).toBeGreaterThan(0);
      for (const b of baked) {
        // 1.2s at 30fps => ~37 samples per track. A runaway baker would
        // produce thousands.
        expect(b.keys.length, `${style}/${b.joint}`).toBeLessThan(200);
        expect(b.keys.length).toBeGreaterThan(1);
      }
    }
  });

  it("keeps helper output free of shared mutable state", () => {
    const k = makeKey("A", 0.5, { x: 1, y: 2, z: 3 }, 45);
    const m = benchmarkStyle("REALISTIC");
    // Mutating a returned pose must not corrupt later reads.
    k.pose.position.x = 999;
    const again = makeKey("A", 0.5, { x: 1, y: 2, z: 3 }, 45);
    expect(again.pose.position.x).toBe(1);
    expect(m.contactMaxDriftStud).toBeGreaterThanOrEqual(0);
  });
});
