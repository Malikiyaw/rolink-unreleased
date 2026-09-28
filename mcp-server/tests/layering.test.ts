import { describe, expect, it } from "vitest";
import type { AnimationLayer, PoseKeyframe } from "../../shared/animationProtocol.js";
import { eulerDegToQuat, makeJointPose } from "../../shared/animationProtocol.js";
import {
  compositeLayers,
  defaultLayer,
  detectLayerConflicts,
  resolveLayerWeight,
} from "../src/animation/layering.js";

function track(joint: string, stops: Array<[number, number]>): { joint: string; keys: PoseKeyframe[] } {
  return {
    joint,
    keys: stops.map(([t, deg]) => ({
      t,
      pose: makeJointPose(joint, {
        position: { x: deg / 10, y: 0, z: 0 },
        rotation: eulerDegToQuat({ x: deg, y: 0, z: 0 }),
        semanticRole: "limb",
      }),
      easing: "linear" as const,
      interpolation: "slerp" as const,
    })),
  };
}

function layer(kind: AnimationLayer["kind"], mask: string[], weight = 1, priority?: number): AnimationLayer {
  const base = defaultLayer(kind, mask);
  base.enabled = true;
  base.weight = weight;
  if (priority !== undefined) base.priority = priority;
  return base;
}

describe("Task 7.1/7.2 — layer blending without fighting", () => {
  it("lets a higher-priority override win at full weight", () => {
    const out = compositeLayers(
      [
        { layer: layer("BASE", [], 1), tracks: [track("A", [[0, 0], [1, 0]])] },
        { layer: layer("UPPER_BODY", ["A"], 1), tracks: [track("A", [[0, 0], [1, 90]])] },
      ],
      { fps: 10, duration: 1 },
    );
    expect(out).toHaveLength(1);
    const end = out[0].keys[out[0].keys.length - 1];
    expect(end.pose.position.x).toBeCloseTo(9, 6);
  });

  it("blends midpoints at half weight", () => {
    const out = compositeLayers(
      [
        { layer: layer("BASE", [], 1), tracks: [track("A", [[0, 0], [1, 0]])] },
        { layer: layer("UPPER_BODY", ["A"], 0.5), tracks: [track("A", [[0, 0], [1, 90]])] },
      ],
      { fps: 10, duration: 1 },
    );
    const end = out[0].keys[out[0].keys.length - 1];
    expect(end.pose.position.x).toBeCloseTo(4.5, 6);
  });

  it("adds secondary deltas onto the base", () => {
    const out = compositeLayers(
      [
        { layer: layer("BASE", [], 1), tracks: [track("A", [[0, 0], [1, 0]])] },
        {
          layer: { ...layer("SECONDARY", ["A"], 1), blendMode: "additive" as const },
          tracks: [track("A", [[0, 10], [1, 10]])],
        },
      ],
      {
        fps: 10,
        duration: 1,
        rests: { A: { position: { x: 0, y: 0, z: 0 }, rotation: { w: 1, x: 0, y: 0, z: 0 } } },
      },
    );
    const end = out[0].keys[out[0].keys.length - 1];
    expect(end.pose.position.x).toBeCloseTo(1, 6);
  });

  it("restricts masked layers to their joints", () => {
    const out = compositeLayers(
      [
        { layer: layer("BASE", [], 1), tracks: [track("A", [[0, 0], [1, 0]]), track("B", [[0, 0], [1, 0]])] },
        { layer: layer("HANDS", ["B"], 1), tracks: [track("B", [[0, 0], [1, 90]])] },
      ],
      { fps: 10, duration: 1 },
    );
    const a = out.find((t) => t.joint === "A");
    const b = out.find((t) => t.joint === "B");
    expect(a?.keys[a.keys.length - 1].pose.position.x).toBeCloseTo(0, 9);
    expect(b?.keys[b.keys.length - 1].pose.position.x).toBeCloseTo(9, 6);
  });

  it("ramps weight through fades", () => {
    const l = { ...layer("UPPER_BODY", [], 1), fadeIn: 0.5, fadeOut: 0.5 };
    expect(resolveLayerWeight(l, 0, 1)).toBeCloseTo(0, 9);
    expect(resolveLayerWeight(l, 0.5, 1)).toBeCloseTo(1, 9);
    expect(resolveLayerWeight(l, 1, 1)).toBeCloseTo(0, 9);
    expect(resolveLayerWeight({ ...l, enabled: false }, 0.5, 1)).toBe(0);
  });

  it("reports override contests with the priority winner", () => {
    const conflicts = detectLayerConflicts([
      layer("BASE", [], 1),
      layer("UPPER_BODY", ["A"], 1),
      { ...layer("HANDS", ["A"], 1), priority: 99 },
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].joint).toBe("A");
    expect(conflicts[0].winner).toBe("HANDS");
    // Additive layers never conflict; disabled layers are invisible.
    expect(
      detectLayerConflicts([
        layer("BASE", [], 1),
        { ...layer("SECONDARY", ["A"], 1), blendMode: "additive" as const },
        { ...layer("UPPER_BODY", ["A"], 1), enabled: false },
      ]),
    ).toHaveLength(0);
  });

  it("ships a sane default stack", () => {
    const kinds = ["BASE", "LOCOMOTION", "UPPER_BODY", "IK"] as const;
    const stack = kinds.map((k) => defaultLayer(k));
    expect(stack.find((l) => l.kind === "BASE")?.enabled).toBe(true);
    expect(stack.find((l) => l.kind === "IK")?.enabled).toBe(false);
    const pri = stack.map((l) => l.priority);
    expect([...pri].sort((a, b) => a - b)).toEqual(pri);
  });
});
