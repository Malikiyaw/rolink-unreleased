import { describe, expect, it } from "vitest";
import { adaptersFromAnalyzeNodes, createJointBinding } from "../src/animation/jointAdapter.js";
import { analyzeRig, summarizeRigAnalysis } from "../src/animation/rigAnalyzer.js";
import {
  buildSemanticSkeleton,
  classifyRigType,
  classifySemanticRole,
  detectLandmarks,
  detectSide,
  splitWords,
} from "../src/animation/semanticRig.js";

const R15_NODES = [
  { path: "Workspace.NPC", name: "NPC", class: "Model", kind: "root", depth: 0 },
  { path: "Workspace.NPC.HumanoidRootPart", name: "HumanoidRootPart", class: "Part", kind: "rigid", depth: 1 },
  { path: "Workspace.NPC.LowerTorso", name: "LowerTorso", class: "MeshPart", kind: "rigid", depth: 1 },
  { path: "Workspace.NPC.LowerTorso.Root", name: "Root", class: "Motor6D", kind: "rotational", depth: 2 },
  { path: "Workspace.NPC.UpperTorso", name: "UpperTorso", class: "MeshPart", kind: "rigid", depth: 1 },
  { path: "Workspace.NPC.UpperTorso.Waist", name: "Waist", class: "Motor6D", kind: "rotational", depth: 2 },
  { path: "Workspace.NPC.Head", name: "Head", class: "Part", kind: "rigid", depth: 1 },
  { path: "Workspace.NPC.UpperTorso.Neck", name: "Neck", class: "Motor6D", kind: "rotational", depth: 2 },
  { path: "Workspace.NPC.LeftUpperArm", name: "LeftUpperArm", class: "MeshPart", kind: "rigid", depth: 1 },
  { path: "Workspace.NPC.UpperTorso.LeftShoulder", name: "LeftShoulder", class: "Motor6D", kind: "rotational", depth: 2 },
  { path: "Workspace.NPC.LeftLowerArm", name: "LeftLowerArm", class: "MeshPart", kind: "rigid", depth: 1 },
  { path: "Workspace.NPC.LeftUpperArm.LeftElbow", name: "LeftElbow", class: "Motor6D", kind: "rotational", depth: 2 },
  { path: "Workspace.NPC.LeftHand", name: "LeftHand", class: "MeshPart", kind: "rigid", depth: 1 },
  { path: "Workspace.NPC.RightUpperArm", name: "RightUpperArm", class: "MeshPart", kind: "rigid", depth: 1 },
  { path: "Workspace.NPC.UpperTorso.RightShoulder", name: "RightShoulder", class: "Motor6D", kind: "rotational", depth: 2 },
  { path: "Workspace.NPC.RightHand", name: "RightHand", class: "MeshPart", kind: "rigid", depth: 1 },
  { path: "Workspace.NPC.LeftUpperLeg", name: "LeftUpperLeg", class: "MeshPart", kind: "rigid", depth: 1 },
  { path: "Workspace.NPC.LowerTorso.LeftHip", name: "LeftHip", class: "Motor6D", kind: "rotational", depth: 2 },
  { path: "Workspace.NPC.LeftFoot", name: "LeftFoot", class: "MeshPart", kind: "rigid", depth: 1 },
  { path: "Workspace.NPC.RightUpperLeg", name: "RightUpperLeg", class: "MeshPart", kind: "rigid", depth: 1 },
  { path: "Workspace.NPC.LowerTorso.RightHip", name: "RightHip", class: "Motor6D", kind: "rotational", depth: 2 },
  { path: "Workspace.NPC.RightFoot", name: "RightFoot", class: "MeshPart", kind: "rigid", depth: 1 },
];

describe("Task 2.2/2.3 — semantic roles and landmarks", () => {
  it("splits names into words without substring false positives", () => {
    expect(splitWords("LeftUpperArm")).toEqual(["left", "upper", "arm"]);
    expect(splitWords("Left Shoulder")).toEqual(["left", "shoulder"]);
    expect(splitWords("SwordWeld")).toEqual(["sword", "weld"]);
    expect(detectSide("LeftUpperArm")).toBe("left");
    expect(detectSide("RightHand")).toBe("right");
    expect(detectSide("Head")).toBe("center");
    expect(detectSide("ArmL")).toBe("left");
  });

  it("classifies humanoid roles on R15 and R6 naming", () => {
    const role = (name: string, kind: "Motor6D" | "Rigid" = "Motor6D", leaf = false): string =>
      classifySemanticRole({ name, kind, legacyKind: kind === "Rigid" ? "rigid" : "rotational", isLeaf: leaf });
    expect(role("Head", "Rigid")).toBe("head");
    expect(role("Neck")).toBe("neck");
    expect(role("LeftShoulder")).toBe("limb");
    expect(role("LeftHand", "Rigid", true)).toBe("hand");
    expect(role("LeftFoot", "Rigid", true)).toBe("foot");
    expect(role("LeftHip")).toBe("limb");
    expect(role("UpperTorso", "Rigid")).toBe("chest");
    expect(role("LowerTorso", "Rigid")).toBe("spine");
    expect(role("HumanoidRootPart", "Rigid")).toBe("locomotionRoot");
    expect(role("Left Arm", "Rigid", true)).toBe("hand");
    expect(role("Left Leg", "Rigid", true)).toBe("foot");
    expect(role("Torso", "Rigid")).toBe("spine");
  });

  it("never invents articulation for follow/static hardware", () => {
    expect(classifySemanticRole({ name: "SwordWeld", kind: "Weld", legacyKind: "follow", isLeaf: true })).toBe("follow");
    expect(classifySemanticRole({ name: "Grip", kind: "Custom", legacyKind: "anchor", isLeaf: true })).toBe("follow");
    expect(classifySemanticRole({ name: "Script", kind: "Custom", legacyKind: "static", isLeaf: true })).toBe("unknown");
    expect(classifySemanticRole({ name: "Handle", kind: "Weld", legacyKind: "follow", isLeaf: true })).toBe("follow");
    expect(classifySemanticRole({ name: "Mystery", kind: "Motor6D", legacyKind: "rotational", isLeaf: false })).toBe("rotational");
    expect(classifySemanticRole({ name: "Panel", kind: "Rigid", legacyKind: "rigid", isLeaf: false })).toBe("rigid");
  });

  it("handles mechanical, hinge, slider, and tip roles", () => {
    const role = (name: string, kind: "Motor6D" | "Rigid" = "Motor6D", leaf = false): string =>
      classifySemanticRole({ name, kind, legacyKind: kind === "Rigid" ? "rigid" : "rotational", isLeaf: leaf });
    expect(role("Hinge")).toBe("hinge");
    expect(role("DoorPanel", "Rigid")).toBe("hinge");
    expect(role("Piston")).toBe("slider");
    expect(role("Wheel")).toBe("mechanical");
    expect(role("Muzzle", "Motor6D", true)).toBe("endEffector");
    expect(role("Barrel")).toBe("mechanical");
    expect(role("TailTip", "Motor6D", true)).toBe("endEffector");
    expect(role("Trim", "Rigid")).toBe("decorative");
  });

  it("pairs bilateral landmarks and prefers exact head names", () => {
    const marks = detectLandmarks([
      { name: "Head", role: "head", depth: 2, isLeaf: true, side: "center" },
      { name: "LeftHand", role: "hand", depth: 3, isLeaf: true, side: "left" },
      { name: "RightHand", role: "hand", depth: 3, isLeaf: true, side: "right" },
      { name: "LeftFoot", role: "foot", depth: 3, isLeaf: true, side: "left" },
    ]);
    expect(marks.head).toBe("Head");
    expect(marks.hands).toEqual(["LeftHand", "RightHand"]);
    expect(marks.feet).toEqual(["LeftFoot"]);
    const empty = detectLandmarks([]);
    expect(empty.head).toBeUndefined();
    expect(empty.hands).toEqual([]);
  });

  it("builds an R15 skeleton with root, landmarks, and spine", () => {
    const bindings = adaptersFromAnalyzeNodes(R15_NODES);
    const skel = buildSemanticSkeleton(bindings);
    expect(skel.root).toBe("NPC");
    expect(skel.probableHead).toBe("Head");
    expect(skel.probableHands).toEqual(["LeftHand", "RightHand"]);
    expect(skel.probableFeet).toEqual(["LeftFoot", "RightFoot"]);
    expect(skel.spineChain?.[0]).toBe("NPC");
    expect(skel.spineChain?.[skel.spineChain.length - 1]).toBe("Head");
    expect(skel.spineChain).toContain("Neck");
    const roles = new Map(skel.joints.map((j) => [j.name, j.semanticRole]));
    expect(roles.get("Neck")).toBe("neck");
    expect(roles.get("LeftShoulder")).toBe("limb");
    expect(roles.get("HumanoidRootPart")).toBe("locomotionRoot");
  });

  it("disables R6 leaf promotion when true hands/feet exist", () => {
    const wolf = adaptersFromAnalyzeNodes([
      { path: "Workspace.Wolf", name: "Wolf", class: "Model", kind: "root", depth: 0 },
      { path: "Workspace.Wolf.Body", name: "Body", class: "Part", kind: "rigid", depth: 1 },
      { path: "Workspace.Wolf.FLLeg", name: "FLLeg", class: "Part", kind: "rigid", depth: 1 },
      { path: "Workspace.Wolf.FLPaw", name: "FLPaw", class: "Part", kind: "rigid", depth: 1 },
    ]);
    const roles = new Map(buildSemanticSkeleton(wolf).joints.map((j) => [j.name, j.semanticRole]));
    expect(roles.get("FLPaw")).toBe("foot");
    expect(roles.get("FLLeg")).toBe("limb");
  });

  it("distinguishes rig types", () => {
    const kinds = R15_NODES.map((n) =>
      n.class === "Motor6D" ? "Motor6D" : ("Rigid" as const),
    );
    const skel = buildSemanticSkeleton(adaptersFromAnalyzeNodes(R15_NODES));
    expect(
      classifyRigType({
        roles: skel.joints.map((j) => j.semanticRole),
        names: skel.joints.map((j) => j.name),
        kinds,
        head: skel.probableHead,
        hands: skel.probableHands ?? [],
        feet: skel.probableFeet ?? [],
      }),
    ).toBe("humanoid");
  });
});

describe("Task 2.1 — rig analyzer pipeline", () => {
  it("analyzes an R15 rig end to end", () => {
    const res = analyzeRig("Workspace/NPC", R15_NODES);
    expect(res.rigType).toBe("humanoid");
    expect(res.analysis.target).toBe("Workspace/NPC");
    expect(res.analysis.jointCount).toBe(R15_NODES.length);
    expect(res.analysis.maxDepth).toBeGreaterThan(0);
    expect(res.analysis.skeleton.probableHead).toBe("Head");
    expect(res.bindings).toHaveLength(R15_NODES.length);
    const summary = summarizeRigAnalysis(res);
    expect(summary).toContain("humanoid");
    expect(summary).toContain("Head");
  });

  it("merges enriched rest poses and warns on partial coverage", () => {
    const res = analyzeRig("Workspace/NPC", R15_NODES.slice(0, 4), {
      enriched: [
        {
          path: "Workspace.NPC.LowerTorso.Root",
          props: {
            joint: {
              transform: {
                position: { x: 0, y: 1, z: 0 },
                rotation: { w: 1, x: 0, y: 0, z: 0 },
              },
            },
          },
        },
      ],
    });
    const root = res.bindings.find((b) => b.name === "Root");
    expect(root?.rest.position).toMatchObject({ x: 0, y: 1, z: 0 });
    expect(res.analysis.warnings.join(" ")).toContain("enriched payload covered 1/4");
  });

  it("flags unruggable and rootless rigs", () => {
    const dead = analyzeRig("Workspace/Static", [
      { path: "Workspace.Static.W", name: "W", class: "Weld", kind: "follow", depth: 1 },
    ]);
    expect(dead.analysis.warnings.join(" ")).toContain("no writable joints");
    const lonely = analyzeRig("Workspace/X", []);
    expect(lonely.analysis.jointCount).toBe(0);
    expect(lonely.rigType).toBe("prop");
  });

  it("creates bindings for Bone rigs without inventing drive channels", () => {
    const boned = createJointBinding({ name: "Spine", path: "Workspace/Mesh.Spine", className: "Bone" });
    expect(boned.drive.writable).toBe(false);
    expect(boned.drive.channels).toEqual(["ClipOnly"]);
  });
});
