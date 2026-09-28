import { describe, expect, it } from "vitest";
import {
  BENCH_EXIT_CRITERIA,
  BENCH_STYLES,
  allExitCriterionFailures,
  benchmarkAll,
  benchmarkStyle,
  buildFixture,
  exitCriterionFailures,
} from "../src/animation/benchmarks.js";

describe("Task 11.2 — benchmark suite produces reproducible metrics", () => {
  it("is deterministic across runs", () => {
    expect(JSON.stringify(benchmarkAll())).toBe(JSON.stringify(benchmarkAll()));
  });

  it("reports every metric for all 8 styles", () => {
    const all = benchmarkAll();
    expect(Object.keys(all).sort()).toEqual([...BENCH_STYLES].sort());
    for (const style of BENCH_STYLES) {
      const m = all[style];
      for (const k of [
        "contactMaxDriftStud",
        "contactMeanDriftStud",
        "loopPositionSeamStud",
        "loopVelocitySeamRatio",
        "peakSpeedStudPerSec",
        "peakJerkStudPerSec3",
        "velocityContinuity",
        "repairIterations",
        "totalErrors",
      ] as const) {
        expect(Number.isFinite(m[k]), `${style}.${k}=${m[k]}`).toBe(true);
        expect(m[k]).toBeGreaterThanOrEqual(0);
      }
      expect(typeof m.contactLocked).toBe("boolean");
    }
  });

  it("meets every Phase 11 exit criterion on every style", () => {
    expect(allExitCriterionFailures()).toEqual([]);
  });

  it("holds the Phase 4 contact exit criterion", () => {
    for (const style of BENCH_STYLES) {
      const m = benchmarkStyle(style);
      expect(m.contactMaxDriftStud, style).toBeLessThanOrEqual(BENCH_EXIT_CRITERIA.contactMaxDriftStud);
      expect(m.contactLocked, style).toBe(true);
    }
  });

  it("converges every style inside the repair budget", () => {
    for (const style of BENCH_STYLES) {
      expect(benchmarkStyle(style).repairIterations, style).toBeLessThanOrEqual(
        BENCH_EXIT_CRITERIA.repairIterations,
      );
    }
  });

  it("keeps the loop seam continuous on every style", () => {
    for (const style of BENCH_STYLES) {
      const m = benchmarkStyle(style);
      expect(m.loopPositionSeamStud, style).toBeLessThanOrEqual(
        BENCH_EXIT_CRITERIA.loopPositionSeamStud,
      );
      // A pop at the wrap shows up as a velocity discontinuity near peak speed.
      expect(m.loopVelocitySeamRatio, style).toBeLessThanOrEqual(
        BENCH_EXIT_CRITERIA.loopVelocitySeamRatio,
      );
    }
  });

  it("separates styles by kinematic profile", () => {
    const real = benchmarkStyle("REALISTIC");
    const anime = benchmarkStyle("ANIME");
    const subtle = benchmarkStyle("SUBTLE");
    // Same rig, same beat layout: only the style profile differs, so anime
    // should out-peak a subtle style and realistic should stay bounded.
    expect(anime.peakSpeedStudPerSec).toBeGreaterThan(subtle.peakSpeedStudPerSec);
    expect(subtle.peakSpeedStudPerSec).toBeGreaterThan(0);
    expect(real.peakSpeedStudPerSec).toBeGreaterThan(0);
  });

  it("reports non-finite metrics as criterion failures rather than passing silently", () => {
    const broken = { ...benchmarkStyle("ANIME"), contactMaxDriftStud: Number.NaN };
    expect(exitCriterionFailures(broken).join(" ")).toContain("contactMaxDriftStud");
    expect(exitCriterionFailures({ ...benchmarkStyle("ANIME"), contactLocked: false }).join(" ")).toContain(
      "contactLocked=false",
    );
    expect(
      exitCriterionFailures({ ...benchmarkStyle("ANIME"), repairIterations: 99 }).join(" "),
    ).toContain("repairIterations=99 exceeds 5");
  });

  it("generates the same tracks for the same style", () => {
    const a = buildFixture("ANIME");
    const b = buildFixture("ANIME");
    expect(JSON.stringify(a.tracks)).toBe(JSON.stringify(b.tracks));
  });
});
