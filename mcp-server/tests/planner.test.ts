import { describe, expect, it } from "vitest";
import { STYLE_KINDS } from "../../shared/animationProtocol.js";
import {
  beatDuration,
  MOTION_BEAT_SEQUENCE,
  planMotion,
  STYLE_BEAT_TIMING,
} from "../src/animation/motionPlanner.js";

describe("Task 6.3 — style-dependent motion timing", () => {
  it("covers all eight styles with fractions summing to 1", () => {
    expect(STYLE_KINDS).toHaveLength(8);
    for (const style of STYLE_KINDS) {
      const table = STYLE_BEAT_TIMING[style];
      expect(Object.keys(table)).toHaveLength(8);
      const sum = Object.values(table).reduce((a, b) => a + b.fraction, 0);
      expect(sum, style).toBeCloseTo(1, 9);
    }
  });

  it("paces anime sharper and more exaggerated than realistic", () => {
    const total = 2;
    // Anime impact is a shorter slice of the clip than realistic impact.
    expect(beatDuration("ANIME", "IMPACT", total)).toBeLessThan(
      beatDuration("REALISTIC", "IMPACT", total),
    );
    // Anime follow-through runs longer than realistic.
    expect(beatDuration("ANIME", "FOLLOW_THROUGH", total)).toBeGreaterThan(
      beatDuration("REALISTIC", "FOLLOW_THROUGH", total),
    );
    // Mechanical barely anticipates; cartoon anticipates hard.
    expect(beatDuration("MECHANICAL", "ANTICIPATION", total)).toBeLessThan(
      beatDuration("CARTOON", "ANTICIPATION", total),
    );
  });

  it("builds ordered plans that end exactly on time", () => {
    const plan = planMotion("landing", "Workspace/NPC", "ANIME", 1.8, {
      majorJoints: ["Torso", "Head"],
    });
    expect(plan.beats.map((b) => b.kind)).toEqual([...MOTION_BEAT_SEQUENCE]);
    for (let i = 1; i < plan.beats.length; i += 1) {
      expect(plan.beats[i].start).toBeGreaterThanOrEqual(plan.beats[i - 1].start);
    }
    const last = plan.beats[plan.beats.length - 1];
    expect(last.start + last.duration).toBeCloseTo(1.8, 9);
    expect(plan.beats[0].start).toBe(0);
    expect(plan.beats.every((b) => b.style === "ANIME")).toBe(true);
    expect(plan.beats[0].majorJoints).toEqual(["Torso", "Head"]);
  });

  it("rejects unknown styles and bad durations", () => {
    expect(() => planMotion("x", "T", "NOPE" as never, 1)).toThrow(/unknown style/);
    expect(() => planMotion("x", "T", "ANIME", 0)).toThrow(/positive/);
  });
});
