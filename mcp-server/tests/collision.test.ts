import { describe, expect, it } from "vitest";
import {
  aabbOverlap,
  buildAdjacency,
  detectDeformation,
  detectFloorPenetration,
  detectSelfIntersection,
  pairKey,
  scanSampleOverlaps,
} from "../src/animation/collision.js";
import { adaptersFromAnalyzeNodes } from "../src/animation/jointAdapter.js";

const NODES = [
  { path: "Workspace.M", name: "M", class: "Model", kind: "root", depth: 0 },
  { path: "Workspace.M.Torso", name: "Torso", class: "Part", kind: "rigid", depth: 1 },
  { path: "Workspace.M.Torso.Neck", name: "Neck", class: "Motor6D", kind: "rotational", depth: 2 },
  { path: "Workspace.M.Head", name: "Head", class: "Part", kind: "rigid", depth: 1 },
  { path: "Workspace.M.Arm", name: "Arm", class: "Part", kind: "rigid", depth: 1 },
];

function vol(name: string, x: number, y: number, z: number, h = 0.5) {
  return { name, center: { x, y, z }, half: { x: h, y: h, z: h } };
}

describe("Task 5.4 — broad-phase with joint-aware filtering", () => {
  it("detects overlap with penetration depth", () => {
    const hit = aabbOverlap(vol("A", 0, 0, 0), vol("B", 0.5, 0, 0));
    expect(hit.overlap).toBe(true);
    expect(hit.penetrationStud).toBeCloseTo(0.5, 9);
    expect(aabbOverlap(vol("A", 0, 0, 0), vol("B", 5, 0, 0)).overlap).toBe(false);
  });

  it("filters parent-child and endpoint pairs", () => {
    const adj = buildAdjacency(adaptersFromAnalyzeNodes(NODES), [["Torso", "Head"]]);
    expect(adj.has(pairKey("Torso", "Neck"))).toBe(true);
    expect(adj.has(pairKey("Torso", "Head"))).toBe(true);
    expect(adj.has(pairKey("Arm", "Head"))).toBe(false);
    const sample = { t: 0, volumes: [vol("Torso", 0, 0, 0, 1), vol("Neck", 0, 0, 0, 2), vol("Arm", 2.5, 0, 0, 1)] };
    const hits = scanSampleOverlaps(sample, adj);
    expect(hits.map((h) => pairKey(h.a, h.b))).toEqual([pairKey("Arm", "Neck")]);
  });
});

describe("Task 5.5 — interpenetration detectors", () => {
  it("reports self-intersection once per pair", () => {
    const samples = [
      { t: 0, volumes: [vol("Hand", 0, 0, 0), vol("Torso", 0, 0, 0)] },
      { t: 0.5, volumes: [vol("Hand", 0, 0, 0), vol("Torso", 0, 0, 0)] },
    ];
    const issues = detectSelfIntersection(samples, new Set());
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe("SELF_INTERSECTION");
    expect(issues[0].severity).toBe("warning");
  });

  it("flags floor penetration with depth", () => {
    const samples = [{ t: 0.3, volumes: [vol("Foot", 0, 0.1, 0, 0.5)] }];
    const issues = detectFloorPenetration(samples, 0, ["Foot"]);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe("GROUND_PENETRATION");
    expect(issues[0].measured).toBeCloseTo(0.4, 9);
    expect(detectFloorPenetration(samples, 0, ["Head"])).toHaveLength(0);
  });

  it("detects impossible stretch and compression", () => {
    const samples = [
      { t: 0, positions: { A: { x: 0, y: 0, z: 0 }, B: { x: 0, y: -2, z: 0 } } },
      { t: 1, positions: { A: { x: 0, y: 0, z: 0 }, B: { x: 0, y: -3, z: 0 } } },
    ];
    const segs = [{ a: "A", b: "B", restStud: 2 }];
    const stretch = detectDeformation(samples, segs);
    expect(stretch.map((i) => i.code)).toContain("EXCESSIVE_STRETCH");
    const squashed = [{ t: 0, positions: { A: { x: 0, y: 0, z: 0 }, B: { x: 0, y: -1, z: 0 } } }];
    const squash = detectDeformation(squashed, segs);
    expect(squash.map((i) => i.code)).toContain("EXCESSIVE_COMPRESSION");
    const fine = detectDeformation(samples.slice(0, 1), segs);
    expect(fine).toHaveLength(0);
  });
});
