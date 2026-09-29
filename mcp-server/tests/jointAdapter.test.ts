import { describe, expect, it } from "vitest";
import {
  DRIVE_CHANNELS,
  adaptersFromAnalyzeNodes,
  buildJointGraph,
  chainBetween,
  classifyRobloxClass,
  createJointBinding,
  findEndEffectors,
  findRootBindings,
  isJointBinding,
  resolveLegacyCandidate,
  validateBindings,
} from "../src/animation/jointAdapter.js";

const NODES = [
  { path: "Workspace.NPC", name: "NPC", class: "Model", kind: "root", depth: 0 },
  { path: "Workspace.NPC.HumanoidRootPart", name: "HumanoidRootPart", class: "Part", kind: "rigid", depth: 1 },
  { path: "Workspace.NPC.Torso", name: "Torso", class: "Part", kind: "rigid", depth: 1 },
  { path: "Workspace.NPC.Torso.Neck", name: "Neck", class: "Motor6D", kind: "rotational", depth: 2 },
  { path: "Workspace.NPC.Torso.Left Shoulder", name: "Left Shoulder", class: "Motor6D", kind: "rotational", depth: 2 },
  { path: "Workspace.NPC.SwordWeld", name: "SwordWeld", class: "Weld", kind: "follow", depth: 1 },
];

describe("Task 1.3 — JointAdapter", () => {
  it("classifies Roblox classes like rlJointKind", () => {
    expect(classifyRobloxClass("Motor6D")).toMatchObject({ kind: "Motor6D", legacyKind: "rotational" });
    expect(classifyRobloxClass("AnimationConstraint")).toMatchObject({
      kind: "AnimationConstraint",
      legacyKind: "rotational",
    });
    expect(classifyRobloxClass("Bone")).toMatchObject({ kind: "Bone", legacyKind: "rotational" });
    expect(classifyRobloxClass("Weld")).toMatchObject({ kind: "Weld", legacyKind: "follow" });
    expect(classifyRobloxClass("WeldConstraint")).toMatchObject({ kind: "Weld", legacyKind: "follow" });
    expect(classifyRobloxClass("Attachment")).toMatchObject({ kind: "Custom", legacyKind: "anchor" });
    expect(classifyRobloxClass("Model")).toMatchObject({ kind: "Rigid", legacyKind: "root" });
    expect(classifyRobloxClass("MeshPart")).toMatchObject({ kind: "Rigid", legacyKind: "rigid" });
    expect(classifyRobloxClass("Script")).toMatchObject({ kind: "Custom", legacyKind: "static" });
  });

  it("assigns drive channels per joint technology", () => {
    expect(DRIVE_CHANNELS.Motor6D).toEqual(["Motor6DTransform"]);
    const motor = createJointBinding({ name: "Neck", path: "Workspace.NPC.Neck", className: "Motor6D" });
    expect(motor.drive.writable).toBe(true);
    expect(motor.drive.channels[0]).toBe("Motor6DTransform");

    const bone = createJointBinding({ name: "Bone", path: "Workspace.Mesh.Bone", className: "Bone" });
    expect(bone.drive.writable).toBe(false);
    expect(bone.drive.channels).toEqual(["ClipOnly"]);

    const weld = createJointBinding({ name: "W", path: "Workspace.M.W", className: "Weld" });
    expect(weld.drive.writable).toBe(false);

    const part = createJointBinding({ name: "Torso", path: "Workspace.NPC.Torso", className: "Part" });
    expect(part.drive.writable).toBe(true);
    expect(part.drive.channels).toEqual(["PartCFrame"]);

    const constraint = createJointBinding({
      name: "Neck",
      path: "Workspace.Avatar.Neck",
      className: "AnimationConstraint",
    });
    expect(constraint.drive.writable).toBe(true);
    expect(constraint.drive.channels[0]).toBe("ConstraintTransform");

    const unknown = createJointBinding({ name: "X", path: "Workspace.X", className: "Humanoid" });
    expect(unknown.drive.writable).toBe(false);
    expect(unknown.drive.channels).toEqual(["None"]);
  });

  it("builds bindings from rlModelAnalyze nodes with parent links", () => {
    const bindings = adaptersFromAnalyzeNodes(NODES);
    expect(bindings).toHaveLength(NODES.length);
    const neck = bindings.find((b) => b.name === "Neck") as NonNullable<ReturnType<typeof bindings.find>>;
    expect(neck.kind).toBe("Motor6D");
    expect(neck.parent).toBe("Torso");
    const roots = findRootBindings(bindings);
    expect(roots.map((r) => r.name)).toContain("NPC");
    for (const b of bindings) expect(isJointBinding(b)).toBe(true);
    const revived: unknown = JSON.parse(JSON.stringify(bindings));
    expect(Array.isArray(revived) && (revived as unknown[]).every(isJointBinding)).toBe(true);
  });

  it("resolves legacy track candidates with Motor6D priority", () => {
    const bindings = adaptersFromAnalyzeNodes([
      { path: "Workspace.M.Head", name: "Head", class: "Part", kind: "rigid", depth: 1 },
      { path: "Workspace.M.Neck.Head", name: "Head", class: "Motor6D", kind: "rotational", depth: 2 },
    ]);
    const hit = resolveLegacyCandidate(bindings, "Head");
    expect(hit?.className).toBe("Motor6D");
    expect(resolveLegacyCandidate(bindings, "Missing")).toBeUndefined();
  });

  it("finds chains and end effectors for future IK use", () => {
    const bindings = adaptersFromAnalyzeNodes(NODES);
    const graph = buildJointGraph(bindings);
    const chain = chainBetween(graph, "Torso", "Left Shoulder");
    expect(chain?.map((b) => b.name)).toEqual(["Torso", "Left Shoulder"]);
    expect(chainBetween(graph, "Torso", "Nope")).toBeUndefined();
    expect(chainBetween(graph, "Nope", "Torso")).toBeUndefined();
    const ends = findEndEffectors(bindings).map((b) => b.name);
    expect(ends).toContain("Neck");
    expect(ends).toContain("Left Shoulder");
    expect(ends).not.toContain("SwordWeld");
  });

  it("validates duplicate names, mixed tech, and unwritable rigs", () => {
    const dupes = adaptersFromAnalyzeNodes([
      { path: "Workspace.A.Head", name: "Head", class: "Motor6D", kind: "rotational", depth: 1 },
      { path: "Workspace.B.Head", name: "Head", class: "Motor6D", kind: "rotational", depth: 1 },
    ]);
    const dupReport = validateBindings(dupes);
    expect(dupReport.ok).toBe(false);
    expect(dupReport.errors.join(" ")).toContain("duplicate joint name");

    const mixed = adaptersFromAnalyzeNodes([
      { path: "Workspace.M.A", name: "A", class: "Motor6D", kind: "rotational", depth: 1 },
      { path: "Workspace.M.B", name: "B", class: "AnimationConstraint", kind: "rotational", depth: 1 },
    ]);
    const mixedReport = validateBindings(mixed);
    expect(mixedReport.ok).toBe(true);
    expect(mixedReport.warnings.join(" ")).toContain("mixed rig technology");

    const dead = adaptersFromAnalyzeNodes([
      { path: "Workspace.M.W", name: "W", class: "Weld", kind: "follow", depth: 1 },
    ]);
    expect(validateBindings(dead).ok).toBe(false);

    const bony = adaptersFromAnalyzeNodes([
      { path: "Workspace.Mesh.Root", name: "Root", class: "Bone", kind: "rotational", depth: 1 },
      { path: "Workspace.Mesh.Hip", name: "Hip", class: "Motor6D", kind: "rotational", depth: 1 },
    ]);
    const bonyReport = validateBindings(bony);
    expect(bonyReport.ok).toBe(true);
    expect(bonyReport.warnings.join(" ")).toContain("ClipOnly");
  });

  it("rejects malformed bindings at the JSON boundary", () => {
    expect(isJointBinding(null)).toBe(false);
    expect(isJointBinding({ name: "", path: "P", className: "Motor6D" })).toBe(false);
    expect(
      isJointBinding({ name: "N", path: "P", className: "Motor6D", kind: "Motor6D", legacyKind: "rotational" }),
    ).toBe(false);
  });
});
