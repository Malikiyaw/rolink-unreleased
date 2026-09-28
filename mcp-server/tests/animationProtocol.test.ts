import { describe, expect, it } from "vitest";
import {
  ANIMATION_IR_VERSION,
  DEFAULT_STYLE_PROFILES,
  EASING_NAMES,
  MOTION_BEAT_ORDER,
  STYLE_KINDS,
  eulerDegToQuat,
  isAnimationClip,
  isAnimationIR,
  isContactSpec,
  isEasingName,
  isIKChain,
  isJointPose,
  isMotionPlan,
  isQuaternion,
  isReadyState,
  isStyleProfile,
  isTerminalStatus,
  isValidationReport,
  isVec3,
  legacyPoseToJointPose,
  makeAnimationIR,
  makeContactSpec,
  makeIKChain,
  makeJointPose,
  makeMotionPlan,
  makeQuaternionIdentity,
  makeValidationIssue,
  makeValidationReport,
  normalizeEasing,
  quatNormalize,
  quatToEulerDeg,
} from "../../shared/animationProtocol.js";

describe("Task 1.1 — Animation IR protocol", () => {
  it("pins the IR version", () => {
    expect(ANIMATION_IR_VERSION).toBe(1);
  });

  it("validates Vec3 and quaternion shapes", () => {
    expect(isVec3({ x: 1, y: 2, z: 3 })).toBe(true);
    expect(isVec3({ x: 1, y: 2 })).toBe(false);
    expect(isVec3({ x: NaN, y: 0, z: 0 })).toBe(false);
    expect(isQuaternion(makeQuaternionIdentity())).toBe(true);
    expect(isQuaternion({ w: 0, x: 0, y: 0, z: 0 })).toBe(false);
    expect(isQuaternion({ w: 2, x: 0, y: 0, z: 0 })).toBe(false);
  });

  it("creates a JointPose with normalized identity rotation by default", () => {
    const p = makeJointPose("Head");
    expect(p.joint).toBe("Head");
    expect(p.semanticRole).toBe("unknown");
    expect(isJointPose(p)).toBe(true);
    const len = Math.hypot(p.rotation.w, p.rotation.x, p.rotation.y, p.rotation.z);
    expect(len).toBeCloseTo(1, 6);
  });

  it("rejects malformed JointPose values", () => {
    expect(isJointPose(null)).toBe(false);
    expect(isJointPose({ joint: "", position: { x: 0, y: 0, z: 0 }, rotation: makeQuaternionIdentity() })).toBe(false);
    expect(isJointPose({ joint: "A", position: { x: 0, y: 0, z: 0 }, rotation: { w: 0, x: 0, y: 0, z: 0 } })).toBe(false);
  });

  it("round-trips Euler degrees through quaternions", () => {
    for (const e of [{ x: 0, y: 45, z: 0 }, { x: -30, y: 10, z: 20 }, { x: 90, y: 0, z: 0 }]) {
      const q = eulerDegToQuat(e);
      expect(isQuaternion(q)).toBe(true);
      const back = quatToEulerDeg(q);
      const q2 = eulerDegToQuat(back);
      const dot = Math.abs(q.w * q2.w + q.x * q2.x + q.y * q2.y + q.z * q2.z);
      expect(dot).toBeGreaterThan(0.999);
    }
  });

  it("normalizes arbitrary quaternions instead of throwing", () => {
    const q = quatNormalize({ w: 2, x: 0, y: 0, z: 0 });
    expect(q).toMatchObject({ w: 1, x: 0, y: 0, z: 0 });
    expect(quatNormalize({ w: 0, x: 0, y: 0, z: 0 })).toMatchObject(makeQuaternionIdentity());
  });

  it("converts legacy Euler poses to authoritative JointPose", () => {
    const p = legacyPoseToJointPose({
      part: "Torso",
      position: { x: 0, y: 3, z: 0 },
      rotation: { x: 0, y: 45, z: 0 },
    });
    expect(p.joint).toBe("Torso");
    expect(isJointPose(p)).toBe(true);
    const back = quatToEulerDeg(p.rotation);
    expect(back.y).toBeCloseTo(45, 3);
  });

  it("keeps the easing vocabulary in sync with the registry", () => {
    expect(EASING_NAMES).toContain("linear");
    expect(EASING_NAMES).toContain("bezierOut");
    expect(EASING_NAMES).toContain("springOut");
    expect(EASING_NAMES).toHaveLength(12);
    expect(isEasingName("quadIn")).toBe(true);
    expect(isEasingName("quad")).toBe(false);
    expect(normalizeEasing("quad")).toBe("quadInOut");
    expect(normalizeEasing("cubic")).toBe("cubicInOut");
    expect(normalizeEasing("bezier")).toBe("bezierOut");
    expect(normalizeEasing("nope")).toBe("linear");
  });

  it("creates an AnimationIR with clamped duration/fps and CREATED status", () => {
    const ir = makeAnimationIR("Wave", "Workspace/NPC", { duration: 999, fps: 999 });
    expect(ir.v).toBe(ANIMATION_IR_VERSION);
    expect(ir.status).toBe("CREATED");
    expect(ir.metadata.duration).toBeLessThanOrEqual(60);
    expect(ir.metadata.fps).toBeLessThanOrEqual(120);
    expect(ir.revision.revision).toBe("Wave_v001");
    expect(isAnimationIR(ir)).toBe(true);
  });

  it("rejects AnimationIR with wrong version or bad clips", () => {
    const ir = makeAnimationIR("X", "Workspace/Y");
    expect(isAnimationIR({ ...ir, v: 999 })).toBe(false);
    expect(isAnimationIR({ ...ir, clips: [{ name: "", duration: -1, fps: 0, loop: false, tracks: [] }] })).toBe(false);
    expect(isAnimationClip({ name: "C", duration: 1, fps: 30, loop: false, tracks: [] })).toBe(true);
  });

  it("serializes through JSON without losing validity", () => {
    const ir = makeAnimationIR("Slash", "Workspace/NPC", { goal: "anime landing", style: "ANIME" });
    const revived: unknown = JSON.parse(JSON.stringify(ir));
    expect(isAnimationIR(revived)).toBe(true);
  });

  it("validates MotionPlan beat ordering", () => {
    const good = makeMotionPlan("landing", "Workspace/NPC", "ANIME", 1.8, [
      { kind: "ANTICIPATION", start: 0, duration: 0.3, importance: 1 },
      { kind: "PRIMARY_ACTION", start: 0.3, duration: 0.5, importance: 1 },
      { kind: "SETTLE", start: 0.8, duration: 1.0, importance: 0.5 },
    ]);
    expect(isMotionPlan(good)).toBe(true);
    expect(isMotionPlan({ ...good, beats: [...good.beats].reverse() })).toBe(false);
    expect(isMotionPlan({ ...good, style: "NOPE" })).toBe(false);
    expect(MOTION_BEAT_ORDER).toContain("IMPACT");
    expect(MOTION_BEAT_ORDER).toContain("FOLLOW_THROUGH");
  });

  it("validates ContactSpec time windows and tolerance", () => {
    const c = makeContactSpec({
      name: "LFootPlant",
      type: "FOOT",
      joint: "LeftFoot",
      worldPosition: { x: 0, y: 0, z: 0 },
      startTime: 0.2,
      endTime: 0.8,
    });
    expect(isContactSpec(c)).toBe(true);
    expect(c.stiffness).toBe(1);
    expect(c.tolerance).toBeCloseTo(0.05, 6);
    expect(isContactSpec({ ...c, endTime: c.startTime })).toBe(false);
    expect(isContactSpec({ ...c, stiffness: 5 })).toBe(false);
  });

  it("validates IKChain endpoints and weight range", () => {
    const ik = makeIKChain({
      name: "RArmReach",
      root: "RShoulder",
      endEffector: "RHand",
      chain: ["RElbow"],
      target: { x: 1, y: 2, z: 3 },
    });
    expect(isIKChain(ik)).toBe(true);
    expect(isIKChain({ ...ik, root: "Same", endEffector: "Same" })).toBe(false);
    expect(isIKChain({ ...ik, weight: 2 })).toBe(false);
  });

  it("ships all eight style profiles with sane thresholds", () => {
    expect(STYLE_KINDS).toHaveLength(8);
    for (const kind of STYLE_KINDS) {
      const profile = DEFAULT_STYLE_PROFILES[kind];
      expect(isStyleProfile(profile)).toBe(true);
    }
    expect(DEFAULT_STYLE_PROFILES.ANIME.thresholds.maxJerkStudPerSec3).toBeGreaterThan(
      DEFAULT_STYLE_PROFILES.REALISTIC.thresholds.maxJerkStudPerSec3,
    );
  });

  it("builds validation reports with terminal-state helpers", () => {
    const ok = makeValidationReport("Wave", "Wave_v001", [], { keyframeCount: 10, trackCount: 2, duration: 1, fps: 30, repairIterations: 0 });
    expect(ok.passed).toBe(true);
    expect(isValidationReport(ok)).toBe(true);
    const bad = makeValidationReport("Wave", "Wave_v001", [
      makeValidationIssue("FOOT_SLIDE", "CONTACT", "error", "foot drifted 0.18 studs", { joint: "LFoot", measured: 0.18, threshold: 0.05 }),
    ]);
    expect(bad.passed).toBe(false);
    expect(bad.status).toBe("FAILED");
    expect(isValidationReport({ ...bad, visualVerification: "bogus" })).toBe(false);
    expect(isTerminalStatus("READY_DATA")).toBe(true);
    expect(isTerminalStatus("READY_VISUAL")).toBe(true);
    expect(isTerminalStatus("FAILED")).toBe(true);
    expect(isTerminalStatus("SOLVING")).toBe(false);
    expect(isReadyState("READY_DATA")).toBe(true);
    expect(isReadyState("CREATED")).toBe(false);
  });
});
