import { describe, expect, it } from "vitest";
import { adaptersFromAnalyzeNodes } from "../src/animation/jointAdapter.js";
import { generateSparsePoses } from "../src/animation/pose.js";
import { buildSemanticSkeleton } from "../src/animation/semanticRig.js";

const NODES = [
  { path: "Workspace.NPC", name: "NPC", class: "Model", kind: "root", depth: 0 },
  { path: "Workspace.NPC.HumanoidRootPart", name: "HumanoidRootPart", class: "Part", kind: "rigid", depth: 1 },
  { path: "Workspace.NPC.Torso", name: "Torso", class: "Part", kind: "rigid", depth: 1 },
  { path: "Workspace.NPC.Torso.Neck", name: "Neck", class: "Motor6D", kind: "rotational", depth: 2 },
  { path: "Workspace.NPC.Head", name: "Head", class: "Part", kind: "rigid", depth: 1 },
  { path: "Workspace.NPC.LeftUpperArm", name: "LeftUpperArm", class: "MeshPart", kind: "rigid", depth: 1 },
  { path: "Workspace.NPC.Torso.LeftShoulder", name: "LeftShoulder", class: "Motor6D", kind: "rotational", depth: 2 },
  { path: "Workspace.NPC.LeftHand", name: "LeftHand", class: "MeshPart", kind: "rigid", depth: 1 },
  { path: "Workspace.NPC.RightHand", name: "RightHand", class: "MeshPart", kind: "rigid", depth: 1 },
  { path: "Workspace.NPC.SwordWeld", name: "SwordWeld", class: "Weld", kind: "follow", depth: 1 },
];

const PLAN = {
  goal: "test strike",
  target: "Workspace/NPC",
  style: "ANIME" as const,
  duration: 1.2,
  beats: [
    { kind: "ANTICIPATION" as const, start: 0, duration: 0.3, importance: 1 },
    { kind: "PRIMARY_ACTION" as const, start: 0.3, duration: 0.4, importance: 1 },
    { kind: "SETTLE" as const, start: 0.7, duration: 0.5, importance: 0.5 },
  ],
};

function setup() {
  const bindings = adaptersFromAnalyzeNodes(NODES);
  const skeleton = buildSemanticSkeleton(bindings);
  return { bindings, skeleton };
}

describe("Task 3.1 — sparse pose generation", () => {
  it("emits sorted, normalized keys for driven joints only", () => {
    const { bindings, skeleton } = setup();
    const tracks = generateSparsePoses(bindings, skeleton, PLAN, { seed: 7 });
    expect(tracks.length).toBeGreaterThan(0);
    const names = tracks.map((t) => t.joint);
    expect(names).not.toContain("SwordWeld");
    expect(names).not.toContain("NPC");
    expect(names).toContain("LeftShoulder");
    for (const t of tracks) {
      const times = t.keys.map((k) => k.t);
      expect([...times].sort((a, b) => a - b)).toEqual(times);
      for (const k of t.keys) {
        const q = k.pose.rotation;
        expect(Math.hypot(q.w, q.x, q.y, q.z)).toBeCloseTo(1, 6);
        expect(k.interpolation).toBe("slerp");
      }
    }
  });

  it("closes the clip at plan duration", () => {
    const { bindings, skeleton } = setup();
    const tracks = generateSparsePoses(bindings, skeleton, PLAN, { seed: 7 });
    for (const t of tracks) {
      expect(t.keys[t.keys.length - 1].t).toBeCloseTo(PLAN.duration, 9);
    }
  });

  it("scales anticipation with style and is deterministic per seed", () => {
    const { bindings, skeleton } = setup();
    const anime = generateSparsePoses(bindings, skeleton, PLAN, { seed: 3, style: "ANIME" });
    const real = generateSparsePoses(bindings, skeleton, PLAN, { seed: 3, style: "REALISTIC" });
    const rootOf = (tracks: typeof anime): number => {
      const t = tracks.find((x) => x.joint === "HumanoidRootPart");
      const k = t?.keys.find((x) => Math.abs(x.t - 0) < 1e-9);
      return Math.abs(k?.pose.position.y ?? 0);
    };
    expect(rootOf(anime)).toBeGreaterThan(rootOf(real));
    const again = generateSparsePoses(bindings, skeleton, PLAN, { seed: 3, style: "ANIME" });
    expect(JSON.stringify(again)).toBe(JSON.stringify(anime));
    const other = generateSparsePoses(bindings, skeleton, PLAN, { seed: 4, style: "ANIME" });
    expect(JSON.stringify(other)).not.toBe(JSON.stringify(anime));
  });

  it("goes limp at zero intensity", () => {
    const { bindings, skeleton } = setup();
    const tracks = generateSparsePoses(bindings, skeleton, PLAN, { seed: 1, intensity: 0 });
    for (const t of tracks) {
      for (const k of t.keys) {
        expect(Math.abs(k.pose.rotation.w)).toBeCloseTo(1, 6);
      }
    }
  });

  it("respects majorJoints filtering", () => {
    const { bindings, skeleton } = setup();
    const plan = {
      ...PLAN,
      beats: [{ kind: "PRIMARY_ACTION" as const, start: 0, duration: 0.5, importance: 1, majorJoints: ["Neck"] }],
    };
    const tracks = generateSparsePoses(bindings, skeleton, plan, { seed: 1 });
    expect(tracks.map((t) => t.joint)).toEqual(["Neck"]);
  });

  it("adds follow-through overshoot keys for high-overshoot styles", () => {
    const { bindings, skeleton } = setup();
    const plan = {
      ...PLAN,
      beats: [{ kind: "FOLLOW_THROUGH" as const, start: 0, duration: 0.5, importance: 1 }],
      duration: 0.6,
    };
    const anime = generateSparsePoses(bindings, skeleton, plan, { seed: 1, style: "ANIME" });
    // Overshoot keys land at start + duration*0.6 with bezierOut easing.
    const overKeys = anime.flatMap((t) => t.keys.filter((k) => Math.abs(k.t - 0.3) < 1e-9));
    expect(overKeys.length).toBeGreaterThan(0);
    expect(overKeys.every((k) => k.easing === "bezierOut")).toBe(true);
    const subtle = generateSparsePoses(bindings, skeleton, plan, { seed: 1, style: "SUBTLE" });
    expect(subtle.flatMap((t) => t.keys.filter((k) => Math.abs(k.t - 0.3) < 1e-9))).toHaveLength(0);
  });
});
