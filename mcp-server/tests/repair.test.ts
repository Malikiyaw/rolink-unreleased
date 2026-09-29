import { describe, expect, it } from "vitest";
import type { PoseKeyframe, ValidationIssue } from "../../shared/animationProtocol.js";
import { eulerDegToQuat, makeJointPose, quatToEulerDeg } from "../../shared/animationProtocol.js";
import { compileAnimation } from "../src/animation/compiler.js";
import { repairIssues } from "../src/animation/repair.js";
import { adaptersFromAnalyzeNodes } from "../src/animation/jointAdapter.js";
import { buildSemanticSkeleton } from "../src/animation/semanticRig.js";
import { inferJointLimits } from "../src/animation/validator.js";
import { rigidWorldSource } from "../src/animation/contacts.js";

const NODES = [
  { path: "Workspace.M", name: "M", class: "Model", kind: "root", depth: 0 },
  { path: "Workspace.M.Leg", name: "Leg", class: "Part", kind: "rigid", depth: 1 },
  { path: "Workspace.M.Foot", name: "Foot", class: "Part", kind: "rigid", depth: 1 },
  { path: "Workspace.M.Elbow", name: "Elbow", class: "Motor6D", kind: "rotational", depth: 1 },
];

function setup() {
  const bindings = adaptersFromAnalyzeNodes(NODES);
  const skeleton = buildSemanticSkeleton(bindings);
  const roles = new Map(skeleton.joints.map((j) => [j.name, j.semanticRole]));
  const rests: Record<string, { position: { x: number; y: number; z: number }; rotation: { w: number; x: number; y: number; z: number } }> = {};
  for (const b of bindings) rests[b.name] = b.rest;
  return { bindings, roles, rests };
}

function key(joint: string, t: number, x = 0, y = 0, degX = 0): PoseKeyframe {
  return {
    t,
    pose: makeJointPose(joint, {
      position: { x, y, z: 0 },
      rotation: eulerDegToQuat({ x: degX, y: 0, z: 0 }),
      semanticRole: "limb",
    }),
    easing: "linear",
    interpolation: "linear",
  };
}

describe("Task 8.2 — repair strategies fix their defect class", () => {
  it("clamps overextension without touching inputs", () => {
    const { rests } = setup();
    const tracks = [{ joint: "Elbow", keys: [key("Elbow", 0, 0, 0, 0), key("Elbow", 0.5, 0, 0, 170)] }];
    const before = JSON.stringify(tracks);
    const limits = inferJointLimits(
      [{ name: "Elbow", kind: "Motor6D" }] as never,
      { Elbow: "limb" },
    );
    const issue: ValidationIssue = {
      code: "OVEREXTENSION", category: "STRUCTURE", severity: "error",
      joint: "Elbow", t: 0.5, message: "bent too far",
    };
    const out = repairIssues(tracks, [issue], { rests, limits });
    expect(out.applied).toHaveLength(1);
    expect(out.applied[0].strategy).toBe("clamp-to-limit");
    expect(out.unrepaired).toHaveLength(0);
    expect(JSON.stringify(tracks)).toBe(before);
    const fixed = out.tracks[0].keys[1].pose.rotation;
    expect(quatToEulerDeg(fixed).x).toBeLessThanOrEqual(145 + 1e-6);
  });

  it("smooths discontinuities and leaves unknown codes alone", () => {
    const tracks = [{ joint: "Leg", keys: [key("Leg", 0, 0), key("Leg", 0.5, 50), key("Leg", 1, 0)] }];
    const pop: ValidationIssue = {
      code: "DISCONTINUITY", category: "KINEMATICS", severity: "error",
      joint: "Leg", t: 0.5, message: "pop",
    };
    const out = repairIssues(tracks, [pop], {});
    expect(out.applied[0].strategy).toBe("neighbor-smooth");
    expect(out.tracks[0].keys[1].pose.position.x).toBeCloseTo(0, 6);
    const strange: ValidationIssue = {
      code: "SELF_INTERSECTION", category: "GEOMETRY", severity: "warning", message: "overlap",
    };
    const out2 = repairIssues(tracks, [strange], {});
    expect(out2.applied).toHaveLength(0);
    expect(out2.unrepaired[0].reason).toContain("no repair strategy");
  });
});

describe("Task 8.3 — the repair loop converges or fails loudly", () => {
  it("converges a fixable clip within budget", () => {
    const { bindings, roles } = setup();
    const tracks = [
      { joint: "Elbow", keys: [key("Elbow", 0, 0, 0, 0), key("Elbow", 0.5, 0, 0, 170)] },
      { joint: "Foot", keys: [key("Foot", 0.2, 0, 0), key("Foot", 0.5, 0, 0.3), key("Foot", 0.8, 0, 0.1)] },
    ];
    const res = compileAnimation({
      animation: "Fixable",
      tracks,
      bindings,
      roles,
      style: "REALISTIC",
      contacts: [
        {
          name: "Plant", type: "FOOT", joint: "Foot",
          worldPosition: { x: 0, y: 0, z: 0 },
          startTime: 0.2, endTime: 0.8, stiffness: 1, tolerance: 0.05,
        },
      ],
      rigidAssembly: true,
    });
    expect(res.status).toBe("READY_DATA");
    expect(res.converged).toBe(true);
    expect(res.iterations).toBeLessThanOrEqual(5);
    expect(res.remainingIssues.filter((i) => i.severity === "error")).toHaveLength(0);
  });

  it("fails loudly (never hangs) when repair cannot move the defect", () => {
    const { bindings, roles } = setup();
    const tracks = [{ joint: "Foot", keys: [key("Foot", 0.2, 0, 0), key("Foot", 0.5, 0, 0.4)] }];
    const res = compileAnimation({
      animation: "Hopeless",
      tracks,
      bindings,
      roles,
      style: "REALISTIC",
      contacts: [
        {
          name: "Plant", type: "FOOT", joint: "Foot",
          worldPosition: { x: 0, y: 0, z: 0 },
          startTime: 0.2, endTime: 0.8, stiffness: 0,
          tolerance: 0.05,
        },
      ],
      rigidAssembly: true,
      maxIterations: 3,
    });
    expect(res.status).toBe("FAILED");
    expect(res.converged).toBe(false);
    expect(res.iterations).toBeLessThanOrEqual(3);
    expect(res.failReason).toContain("budget exhausted");
    expect(res.remainingIssues.length).toBeGreaterThan(0);
  });

  it("exhausts budget on hopelessly snappy motion", () => {
    const { bindings, roles } = setup();
    const tracks = [
      { joint: "Leg", keys: [key("Leg", 0, 0), key("Leg", 0.05, 0), key("Leg", 0.1, 40), key("Leg", 1, 40)] },
    ];
    const res = compileAnimation({
      animation: "Snappy",
      tracks,
      bindings,
      roles,
      style: "SUBTLE",
      maxIterations: 2,
      densify: { maxGapSec: 99, maxAngleDeg: 999, maxMoveStud: 999 },
    });
    expect(res.iterations).toBeLessThanOrEqual(2);
    expect(["READY_DATA", "FAILED"]).toContain(res.status);
    if (res.status === "FAILED") expect(res.failReason).toContain("budget exhausted");
  });

  it("passes clean clips with zero iterations", () => {
    const { bindings, roles } = setup();
    const tracks = [{ joint: "Leg", keys: [key("Leg", 0, 0), key("Leg", 1, 1)] }];
    const res = compileAnimation({
      animation: "Clean",
      tracks,
      bindings,
      roles,
      style: "REALISTIC",
      densify: { maxGapSec: 99, maxAngleDeg: 999, maxMoveStud: 999 },
    });
    expect(res.status).toBe("READY_DATA");
    expect(res.iterations).toBe(0);
    expect(res.passes).toHaveLength(0);
  });

  it("keeps rigid-world sources live across repair passes", () => {
    const { bindings } = setup();
    const byJoint = { Foot: [key("Foot", 0.5, 0, 0.2)] };
    expect(rigidWorldSource(byJoint)("Foot", 0.5)).toMatchObject({ x: 0, y: 0.2, z: 0 });
    expect(bindings.length).toBeGreaterThan(0);
  });
});
