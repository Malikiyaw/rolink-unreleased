import { describe, expect, it } from "vitest";
import type { PoseKeyframe } from "../../shared/animationProtocol.js";
import { eulerDegToQuat, makeJointPose } from "../../shared/animationProtocol.js";
import { criticize } from "../src/animation/critic.js";
import { adaptersFromAnalyzeNodes } from "../src/animation/jointAdapter.js";
import { buildSemanticSkeleton } from "../src/animation/semanticRig.js";
import { rigidWorldSource } from "../src/animation/contacts.js";

const NODES = [
  { path: "Workspace.M", name: "M", class: "Model", kind: "root", depth: 0 },
  { path: "Workspace.M.Hip", name: "Hip", class: "Motor6D", kind: "rotational", depth: 1 },
  { path: "Workspace.M.Leg", name: "Leg", class: "Part", kind: "rigid", depth: 1 },
  { path: "Workspace.M.Foot", name: "Foot", class: "Part", kind: "rigid", depth: 1 },
  { path: "Workspace.M.Elbow", name: "Elbow", class: "Motor6D", kind: "rotational", depth: 1 },
];

function setup() {
  const bindings = adaptersFromAnalyzeNodes(NODES);
  const skeleton = buildSemanticSkeleton(bindings);
  const roles = new Map(skeleton.joints.map((j) => [j.name, j.semanticRole]));
  return { bindings, roles };
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

describe("Task 8.1 — the critic catches injected defects", () => {
  it("catches 95%+ of a mixed defect injection", () => {
    const { bindings, roles } = setup();
    const tracks = [
      { joint: "Elbow", keys: [key("Elbow", 0, 0, 0, 0), key("Elbow", 0.5, 0, 0, 170)] },
      { joint: "Foot", keys: [key("Foot", 0.2, 0, 0), key("Foot", 0.5, 0, 0.3), key("Foot", 0.8, 0, 0)] },
      { joint: "Leg", keys: [key("Leg", 0, 0), key("Leg", 0.5, 0), key("Leg", 0.55, 8), key("Leg", 1, 8)] },
    ];
    const byJoint: Record<string, PoseKeyframe[]> = {};
    for (const t of tracks) byJoint[t.joint] = t.keys;
    const report = criticize({
      animation: "Injected",
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
      worldPos: rigidWorldSource(byJoint),
      floorY: 0,
      volumes: [{ t: 0.5, volumes: [{ name: "Foot", center: { x: 0, y: -1, z: 0 }, half: { x: 0.5, y: 0.5, z: 0.5 } }] }],
    });
    const codes = report.issues.map((i) => i.code);
    // Injected: elbow over-flex, foot slide, speed snap, floor penetration.
    expect(codes).toContain("JOINT_LIMIT");
    expect(codes).toContain("FOOT_SLIDE");
    expect(codes).toContain("SPEED_SPIKE");
    expect(codes).toContain("GROUND_PENETRATION");
    const caught = ["JOINT_LIMIT", "FOOT_SLIDE", "SPEED_SPIKE", "GROUND_PENETRATION"]
      .filter((c) => codes.includes(c as never)).length;
    expect(caught / 4).toBeGreaterThanOrEqual(0.95);
    expect(report.checked.length).toBeGreaterThan(0);
    expect(report.errorCount).toBeGreaterThan(0);
  });

  it("escalates gross violations to OVEREXTENSION", () => {
    const { bindings, roles } = setup();
    const tracks = [
      {
        joint: "Elbow",
        keys: [
          key("Elbow", 0, 0, 0, 0),
          {
            t: 0.5,
            pose: {
              joint: "Elbow",
              position: { x: 0, y: 0, z: 0 },
              rotation: { w: 0.984807753012208, x: 0, y: 0.17364817766693033, z: 0 },
              semanticRole: "limb" as const,
            },
            easing: "linear" as const,
            interpolation: "slerp" as const,
          },
        ],
      },
    ];
    const report = criticize({
      animation: "Over",
      tracks,
      bindings,
      roles,
      style: "REALISTIC",
    });
    // 20° yaw on a ±15° elbow axis = 33% over → OVEREXTENSION.
    expect(report.issues.map((i) => i.code)).toContain("OVEREXTENSION");
  });

  it("reports skipped suites honestly instead of passing them", () => {
    const { bindings, roles } = setup();
    const report = criticize({
      animation: "Bare",
      tracks: [{ joint: "Leg", keys: [key("Leg", 0), key("Leg", 1, 1)] }],
      bindings,
      roles,
      style: "REALISTIC",
      contacts: [
        {
          name: "Plant", type: "FOOT", joint: "Foot",
          worldPosition: { x: 0, y: 0, z: 0 },
          startTime: 0, endTime: 1, stiffness: 1, tolerance: 0.05,
        },
      ],
    });
    expect(report.skipped.map((s) => s.suite)).toContain("contacts");
    expect(report.skipped.map((s) => s.suite)).toContain("volumes");
    expect(report.skipped.map((s) => s.suite)).toContain("deformation");
    expect(report.checked.join(" ")).toContain("kinematics");
  });

  it("maps contact types to defect codes", () => {
    const { bindings, roles } = setup();
    const drifting = [key("Foot", 0.2, 0, 0), key("Foot", 0.5, 0, 0.4)];
    const byJoint = { Foot: drifting };
    const run = (type: "FOOT" | "HAND" | "WALL"): string[] =>
      criticize({
        animation: "C",
        tracks: [{ joint: "Foot", keys: drifting }],
        bindings,
        roles,
        style: "REALISTIC",
        contacts: [
          {
            name: "X", type, joint: "Foot",
            worldPosition: { x: 0, y: 0, z: 0 },
            startTime: 0, endTime: 1, stiffness: 1, tolerance: 0.05,
          },
        ],
        worldPos: rigidWorldSource(byJoint),
      }).issues.map((i) => i.code);
    expect(run("FOOT")).toContain("FOOT_SLIDE");
    expect(run("HAND")).toContain("HAND_CONTACT_BREAK");
    expect(run("WALL")).toContain("CONTACT_BREAK");
  });
});
