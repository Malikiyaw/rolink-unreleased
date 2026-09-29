import { describe, expect, it } from "vitest";
import {
  packageVisualFrame,
  PIXEL_ONLY_DEFECTS,
  reviewVisuals,
  validateVisualCritique,
  VISUAL_CODES,
  type VisualCritique,
  type VisualFrame,
} from "../src/animation/critic.js";
import { compileAnimation } from "../src/animation/compiler.js";
import { adaptersFromAnalyzeNodes } from "../src/animation/jointAdapter.js";
import { buildSemanticSkeleton } from "../src/animation/semanticRig.js";
import { makeJointPose } from "../../shared/animationProtocol.js";

function frame(frameId: string, modality: "pixels" | "schematic" = "schematic"): VisualFrame {
  return packageVisualFrame({
    frameId,
    animation: "Wave",
    t: 0.5,
    width: 320,
    height: 180,
    ...(modality === "pixels"
      ? { mimeType: "image/png" as const, dataBase64: "aGVsbG8=" }
      : { boxes: [{ joint: "Head", x: 10, y: 10, w: 40, h: 40, depth: 5, visible: true }] }),
  });
}

function critique(frameId: string, verdict: VisualCritique["verdict"], modality: VisualCritique["modality"] = "schematic"): VisualCritique {
  return {
    frameId,
    verdict,
    defects: verdict === "fail"
      ? [{ code: "WEAK_SILHOUETTE", severity: "error", message: "pose reads as a blob" }]
      : [],
    modality,
  };
}

describe("Tasks 9.2/9.3 — frames, critiques, taxonomy", () => {
  it("packages pixel vs schematic frames honestly", () => {
    const px = frame("a", "pixels");
    expect(px.modality).toBe("pixels");
    expect(px.pixels).toBe(true);
    const sch = frame("b", "schematic");
    expect(sch.modality).toBe("schematic");
    expect(sch.pixels).toBe(false);
    expect(sch.boxes).toHaveLength(1);
  });

  it("validates critiques and rejects malformed ones", () => {
    expect(validateVisualCritique(critique("a", "pass"))).toBe(true);
    expect(validateVisualCritique(critique("a", "fail"))).toBe(true);
    expect(validateVisualCritique({ ...critique("a", "fail"), defects: [] })).toBe(false);
    expect(validateVisualCritique({ ...critique("a", "pass"), verdict: "maybe" })).toBe(false);
    expect(validateVisualCritique({
      frameId: "a", verdict: "fail", modality: "pixels",
      defects: [{ code: "NOPE", severity: "error", message: "x" }],
    })).toBe(false);
    expect(validateVisualCritique(null)).toBe(false);
    expect(VISUAL_CODES.has("WEAK_SILHOUETTE")).toBe(true);
    expect(PIXEL_ONLY_DEFECTS.has("INTERPENETRATION_VISIBLE")).toBe(true);
  });

  it("never lets schematics certify pixel-only defects", () => {
    const f = frame("a", "schematic");
    const passPixelsOnly: VisualCritique = {
      frameId: "a", verdict: "pass", modality: "schematic",
      defects: [{ code: "INTERPENETRATION_VISIBLE", severity: "error", message: "looks clean" }],
    };
    const r = reviewVisuals([f], [passPixelsOnly]);
    expect(r.verification).toBe("required");
    expect(r.issues).toHaveLength(0);
    // Flagging (fail) on pixel-only codes IS allowed schematically.
    const flag: VisualCritique = {
      frameId: "a", verdict: "fail", modality: "schematic",
      defects: [{ code: "DETACHED_LIMB", severity: "error", message: "arm floats free" }],
    };
    const r2 = reviewVisuals([f], [flag]);
    expect(r2.verification).toBe("failed");
    expect(r2.issues[0].code).toBe("DETACHED_LIMB");
  });

  it("requires review for unreviewed frames and tracks unmatched critiques", () => {
    const r = reviewVisuals([frame("a"), frame("b")], [critique("a", "pass")]);
    expect(r.verification).toBe("required");
    expect(r.framesReviewed).toBe(1);
    const r2 = reviewVisuals([frame("a")], [critique("a", "pass"), critique("ghost", "pass")]);
    expect(r2.unmatchedCritiques).toEqual(["ghost"]);
    expect(r2.verification).toBe("passed");
  });

  it("lets failure win over incompleteness", () => {
    const r = reviewVisuals([frame("a"), frame("b")], [critique("a", "fail")]);
    expect(r.verification).toBe("failed");
    expect(r.framesReviewed).toBe(1);
  });
});

describe("Task 9.4 — compiler visual states", () => {
  const NODES = [
    { path: "Workspace.M", name: "M", class: "Model", kind: "root", depth: 0 },
    { path: "Workspace.M.Leg", name: "Leg", class: "Part", kind: "rigid", depth: 1 },
  ];

  function cleanInput() {
    const bindings = adaptersFromAnalyzeNodes(NODES);
    const skeleton = buildSemanticSkeleton(bindings);
    const roles = new Map(skeleton.joints.map((j) => [j.name, j.semanticRole]));
    return {
      animation: "Clean",
      tracks: [{
        joint: "Leg",
        keys: [0, 1].map((t) => ({
          t,
          pose: makeJointPose("Leg", { position: { x: t, y: 0, z: 0 }, semanticRole: "limb" }),
          easing: "linear" as const,
          interpolation: "linear" as const,
        })),
      }],
      bindings,
      roles,
      style: "REALISTIC" as const,
      densify: { maxGapSec: 99, maxAngleDeg: 999, maxMoveStud: 999 },
    };
  }

  it("stays READY_DATA with visual required when no visuals exist", () => {
    const res = compileAnimation(cleanInput());
    expect(res.status).toBe("READY_DATA");
    expect(res.visual).toBe("required");
  });

  it("promotes to READY_VISUAL on passing review", () => {
    const res = compileAnimation({
      ...cleanInput(),
      visual: { frames: [frame("f1")], critiques: [critique("f1", "pass")] },
    });
    expect(res.status).toBe("READY_VISUAL");
    expect(res.visual).toBe("passed");
  });

  it("fails on failing review with the visual reason", () => {
    const res = compileAnimation({
      ...cleanInput(),
      visual: { frames: [frame("f1")], critiques: [critique("f1", "fail")] },
    });
    expect(res.status).toBe("FAILED");
    expect(res.visual).toBe("failed");
    expect(res.failReason).toContain("visual review failed");
    expect(res.remainingIssues.map((i) => i.code)).toContain("WEAK_SILHOUETTE");
  });

  it("holds READY_DATA when review is inconclusive", () => {
    const res = compileAnimation({
      ...cleanInput(),
      visual: { frames: [frame("f1")], critiques: [critique("f1", "inconclusive")] },
    });
    expect(res.status).toBe("READY_DATA");
    expect(res.visual).toBe("required");
  });
});
