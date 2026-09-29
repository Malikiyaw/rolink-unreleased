import { describe, expect, it } from "vitest";
import type { PoseKeyframe, SecondarySpec } from "../../shared/animationProtocol.js";
import { makeJointPose } from "../../shared/animationProtocol.js";
import {
  createSecondaryState,
  simulateSecondaryTrack,
  stepSecondaryMotion,
} from "../src/animation/dynamics.js";

const CFG: SecondarySpec = {
  joint: "Ponytail",
  lag: 0.12,
  stiffness: 60,
  damping: 8,
  mass: 1,
  maxDisplacement: 1.5,
  maxRotationDeg: 30,
  followWeight: 1,
};

function key(t: number, y: number): PoseKeyframe {
  return {
    t,
    pose: makeJointPose("Head", { position: { x: 0, y, z: 0 }, semanticRole: "head" }),
    easing: "linear",
    interpolation: "linear",
  };
}

describe("Task 6.1 — trailing spring dynamics", () => {
  it("lags a step input, then settles back", () => {
    const state = createSecondaryState();
    const dt = 1 / 30;
    // Hold at 0, then jump the primary to y=2 and hold.
    for (let i = 0; i < 10; i += 1) {
      stepSecondaryMotion(state, { position: { x: 0, y: 0, z: 0 }, rotation: { w: 1, x: 0, y: 0, z: 0 } }, CFG, dt);
    }
    let peakLag = 0;
    let finalOffset = Infinity;
    for (let i = 0; i < 120; i += 1) {
      const res = stepSecondaryMotion(
        state,
        { position: { x: 0, y: 2, z: 0 }, rotation: { w: 1, x: 0, y: 0, z: 0 } },
        CFG,
        dt,
      );
      peakLag = Math.max(peakLag, 2 - res.position.y);
      if (i === 119) finalOffset = Math.abs(2 - res.position.y);
    }
    expect(peakLag).toBeGreaterThan(0.1);
    expect(finalOffset).toBeLessThan(0.05);
  });

  it("reaches halfway later with softer springs", () => {
    const run = (stiffness: number): number => {
      const state = createSecondaryState();
      const dt = 1 / 60;
      const cfg = { ...CFG, stiffness, damping: 2 * Math.sqrt(stiffness) };
      const at0 = { position: { x: 0, y: 0, z: 0 }, rotation: { w: 1, x: 0, y: 0, z: 0 } };
      for (let i = 0; i < 30; i += 1) stepSecondaryMotion(state, at0, cfg, dt);
      const at1 = { position: { x: 0, y: 1, z: 0 }, rotation: { w: 1, x: 0, y: 0, z: 0 } };
      for (let i = 0; i < 300; i += 1) {
        const res = stepSecondaryMotion(state, at1, cfg, dt);
        if (res.position.y >= 0.5) return i;
      }
      return Infinity;
    };
    // Critical damping: higher stiffness settles sooner (fewer frames).
    expect(run(200)).toBeLessThan(run(30));
  });

  it("clamps displacement and stays stable at high stiffness", () => {
    const state = createSecondaryState();
    const cfg = { ...CFG, stiffness: 2000, damping: 20, maxDisplacement: 0.25 };
    let worst = 0;
    for (let i = 0; i < 120; i += 1) {
      const res = stepSecondaryMotion(
        state,
        {
          position: { x: 0, y: i < 60 ? 0 : 5, z: 0 },
          rotation: { w: 1, x: 0, y: 0, z: 0 },
        },
        cfg,
        1 / 30,
      );
      worst = Math.max(worst, Math.hypot(res.position.x, res.position.y - (i < 60 ? 0 : 5), res.position.z));
      for (const v of [res.position.x, res.position.y, res.position.z]) {
        expect(Number.isFinite(v)).toBe(true);
      }
    }
    expect(worst).toBeLessThanOrEqual(0.25 + 1e-9);
  });

  it("rigid-follows at zero stiffness", () => {
    const state = createSecondaryState();
    const cfg = { ...CFG, stiffness: 0 };
    const res = stepSecondaryMotion(
      state,
      { position: { x: 1, y: 2, z: 3 }, rotation: { w: 0, x: 1, y: 0, z: 0 } },
      cfg,
      1 / 30,
    );
    expect(res.position).toMatchObject({ x: 1, y: 2, z: 3 });
  });

  it("simulates a track with delay and bounded offsets", () => {
    const primary = [0, 0.1, 0.2, 0.3, 0.4, 0.5].map((t, i) => key(t, i < 3 ? 0 : 1));
    const out = simulateSecondaryTrack(primary, CFG);
    expect(out).toHaveLength(primary.length);
    expect(out.map((k) => k.t)).toEqual(primary.map((k) => k.t));
    // Secondary trails: at the step instant it still reads the old level.
    expect(out[3].pose.position.y).toBeLessThan(1);
    expect(out[out.length - 1].pose.position.y).toBeGreaterThan(out[3].pose.position.y);
    for (const k of out) {
      const q = k.pose.rotation;
      expect(Math.hypot(q.w, q.x, q.y, q.z)).toBeCloseTo(1, 6);
      expect(k.pose.joint).toBe("Ponytail");
    }
  });
});
