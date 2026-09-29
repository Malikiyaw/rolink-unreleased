import { describe, expect, it } from "vitest";
import type { Quaternion } from "../../shared/animationProtocol.js";
import {
  bakeIKToKeys,
  createIKChain,
  createIKChainModel,
  fkChain,
  setIKTarget,
  smoothRotations,
  solveCCD,
  solveIKChain,
  solveTwoBone,
  sortChainsByPriority,
} from "../src/animation/ik.js";
import { adaptersFromAnalyzeNodes } from "../src/animation/jointAdapter.js";
import { quatAngleDegBetween } from "../src/animation/quaternion.js";

const ID: Quaternion = { w: 1, x: 0, y: 0, z: 0 };

function armModel() {
  return createIKChainModel({ names: ["Shoulder", "Elbow"], lengths: [1, 1], endLength: 1 });
}

describe("Task 4.1 — chain models and forward kinematics", () => {
  it("stacks -Y segments at rest", () => {
    const fk = fkChain(armModel(), { x: 0, y: 0, z: 0 });
    expect(fk.origins[0]).toMatchObject({ x: 0, y: -1, z: 0 });
    expect(fk.origins[1]).toMatchObject({ x: 0, y: -2, z: 0 });
    expect(fk.tip).toMatchObject({ x: 0, y: -3, z: 0 });
  });

  it("refuses guessed geometry", () => {
    expect(() => createIKChainModel({ names: ["A"] })).toThrow(/insufficient_data/);
    expect(() => createIKChainModel({ names: ["A", "B"], lengths: [1] })).toThrow(/insufficient_data/);
    expect(() => createIKChainModel({ names: [], lengths: [] })).toThrow(/insufficient_data/);
    expect(() => createIKChainModel({ names: ["A"], lengths: [1] })).toThrow(/insufficient_data/);
  });
});

describe("Task 4.1 — two-bone analytic IK", () => {
  it("reaches targets within 0.1 studs", () => {
    const model = armModel();
    for (const target of [
      { x: 1.5, y: -1.5, z: 0 },
      { x: 0, y: -2.9, z: 0 },
      { x: -1, y: -1, z: 0.5 },
    ]) {
      const sol = solveTwoBone(model, { x: 0, y: 0, z: 0 }, target, {
        pole: { x: 0, y: 0, z: -1 },
      });
      expect(sol.converged, JSON.stringify(sol)).toBe(true);
      expect(sol.residualStud).toBeLessThan(0.1);
      expect(sol.clamped).toBe(false);
      expect(sol.iterations).toBe(1);
    }
  });

  it("reports clamping honestly on unreachable targets", () => {
    const sol = solveTwoBone(armModel(), { x: 0, y: 0, z: 0 }, { x: 0, y: -10, z: 0 });
    expect(sol.clamped).toBe(true);
    expect(sol.converged).toBe(false);
    expect(sol.residualStud).toBeGreaterThan(0);
  });

  it("bends toward the pole vector", () => {
    const model = armModel();
    const base = { x: 0, y: 0, z: 0 };
    const target = { x: 1.5, y: -1.5, z: 0 };
    const front = solveTwoBone(model, base, target, { pole: { x: 0, y: 0, z: 1 } });
    const back = solveTwoBone(model, base, target, { pole: { x: 0, y: 0, z: -1 } });
    expect(quatAngleDegBetween(front.rotations["Elbow"], back.rotations["Elbow"])).toBeGreaterThan(5);
  });

  it("blends with weight and respects current pose", () => {
    const model = armModel();
    const target = { x: 1.5, y: -1.5, z: 0 };
    const none = solveTwoBone(model, { x: 0, y: 0, z: 0 }, target, { weight: 0 });
    expect(quatAngleDegBetween(none.rotations["Shoulder"], ID)).toBeCloseTo(0, 6);
    expect(none.converged).toBe(false);
  });

  it("dispatches two-bone chains analytically", () => {
    const sol = solveIKChain(armModel(), { x: 0, y: 0, z: 0 }, { x: 1, y: -2, z: 0 });
    expect(sol.iterations).toBe(1);
    expect(sol.converged).toBe(true);
  });
});

describe("Task 4.1 — CCD fallback", () => {
  it("converges a 3-joint chain", () => {
    const model = createIKChainModel({ names: ["A", "B", "C"], lengths: [1, 1, 1], endLength: 1 });
    const sol = solveCCD(model, { x: 0, y: 0, z: 0 }, { x: 1.5, y: -2, z: 0.5 });
    expect(sol.converged).toBe(true);
    expect(sol.residualStud).toBeLessThan(0.1);
    expect(sol.iterations).toBeGreaterThanOrEqual(1);
    expect(Object.keys(sol.rotations)).toEqual(["A", "B", "C"]);
  });

  it("reports non-convergence instead of hanging", () => {
    const model = createIKChainModel({ names: ["A", "B", "C"], lengths: [1, 1, 1], endLength: 1 });
    const sol = solveCCD(model, { x: 0, y: 0, z: 0 }, { x: 0, y: -20, z: 0 }, { maxIterations: 4 });
    expect(sol.converged).toBe(false);
    expect(sol.iterations).toBe(4);
    expect(sol.residualStud).toBeGreaterThan(1);
  });
});

describe("Task 4.1/4.2 — chain management and baking", () => {
  const BINDINGS = [
    { path: "Workspace.R", name: "R", class: "Model", kind: "root", depth: 0 },
    { path: "Workspace.R.UpperArm", name: "UpperArm", class: "MeshPart", kind: "rigid", depth: 1 },
    { path: "Workspace.R.UpperArm.Shoulder", name: "Shoulder", class: "Motor6D", kind: "rotational", depth: 2 },
    { path: "Workspace.R.Forearm", name: "Forearm", class: "MeshPart", kind: "rigid", depth: 1 },
    { path: "Workspace.R.Forearm.Elbow", name: "Elbow", class: "Motor6D", kind: "rotational", depth: 2 },
    { path: "Workspace.R.Hand", name: "Hand", class: "MeshPart", kind: "rigid", depth: 1 },
  ];

  it("walks up from the end effector and needs geometry", () => {
    const bindings = adaptersFromAnalyzeNodes(BINDINGS);
    expect(() => createIKChain("reach", bindings, "Hand")).toThrow(/insufficient_data/);
    const { spec, model } = createIKChain("reach", bindings, "Hand", {
      joints: ["Shoulder", "Elbow"],
      lengths: [1, 1],
      endLength: 0.5,
      weight: 0.8,
      priority: 2,
    });
    expect(spec.root).toBe("Shoulder");
    expect(spec.chain).toEqual(["Elbow"]);
    expect(spec.endEffector).toBe("Hand");
    expect(spec.weight).toBe(0.8);
    expect(model.joints.map((j) => j.name)).toEqual(["Shoulder", "Elbow"]);
    expect(() => createIKChain("bad", bindings, "Hand", { joints: ["Hand"] })).toThrow(/insufficient_data/);
  });

  it("retargets, sorts, and smooths", () => {
    const spec = setIKTarget(
      {
        name: "a", root: "R", endEffector: "E", chain: [],
        target: { x: 0, y: 0, z: 0 }, weight: 1, priority: 1,
      },
      { x: 1, y: 2, z: 3 },
    );
    expect(spec.target).toMatchObject({ x: 1, y: 2, z: 3 });
    const lo = { ...spec, name: "lo", priority: 0 };
    expect(sortChainsByPriority([lo, spec]).map((c) => c.name)).toEqual(["a", "lo"]);
    const smoothed = smoothRotations({ J: ID }, { J: { w: 0, x: 1, y: 0, z: 0 } }, 0);
    expect(quatAngleDegBetween(smoothed["J"], { w: 0, x: 1, y: 0, z: 0 })).toBeCloseTo(0, 6);
    const frozen = smoothRotations({ J: ID }, { J: { w: 0, x: 1, y: 0, z: 0 } }, 1);
    expect(quatAngleDegBetween(frozen["J"], ID)).toBeCloseTo(0, 6);
  });

  it("bakes solved deltas to rest-composed keys", () => {
    const joints = [
      {
        name: "Shoulder",
        rest: { position: { x: 0, y: 0, z: 0 }, rotation: { ...ID } },
        semanticRole: "limb" as const,
      },
    ];
    const rot = { w: 0.9239, x: 0.3827, y: 0, z: 0 };
    const tracks = bakeIKToKeys(joints, [
      { t: 0, rotations: {} },
      { t: 0.5, rotations: { Shoulder: rot }, easing: "quadInOut" },
    ]);
    expect(tracks).toHaveLength(1);
    expect(tracks[0].keys).toHaveLength(1);
    expect(tracks[0].keys[0].t).toBe(0.5);
    expect(tracks[0].keys[0].easing).toBe("quadInOut");
    expect(quatAngleDegBetween(tracks[0].keys[0].pose.rotation, rot)).toBeLessThan(0.01);
  });
});
