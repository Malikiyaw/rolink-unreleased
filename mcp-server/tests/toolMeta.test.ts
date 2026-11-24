import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { categoryOfTool, commandQueue } from "../src/commandQueue.js";

// The catalogue is a product file. It used to live at tests/__registry__.json,
// which made a test fixture the runtime source of truth for the bridge.
const catalogRaw = JSON.parse(
  readFileSync(new URL("../../catalog/tools.json", import.meta.url), "utf8")
);
const names: string[] = Array.isArray(catalogRaw) ? catalogRaw : catalogRaw.tools;
const VALID = ["read", "edit", "inspect", "generate", "asset", "visual", "test", "tool"];

describe("P3 queue tool meta", () => {
  it("catalog is non-empty and has no duplicates", () => {
    // Deliberately no fixed count: the catalogue is expected to grow. A magic
    // number here only ever fails on a legitimate addition while catching
    // nothing - the drift that DID happen (retarget_animation missing from the
    // catalogue) is caught by the coverage test below.
    expect(names.length).toBeGreaterThan(100);
    expect(new Set(names).size).toBe(names.length);
  });

  it("catalog covers every implemented registry tool", async () => {
    const { tools } = await import("../src/tools/registry.js");
    const implemented = tools.map((t) => t.name);
    const missing = implemented.filter((n) => !names.includes(n));
    expect(missing, `implemented but absent from catalog/tools.json: ${missing}`).toEqual([]);
  });

  it("maps every tool to a valid HUD category", () => {
    for (const n of names) {
      expect(VALID).toContain(categoryOfTool(n));
    }
  });

  it("enqueue stamps meta.eventId (= queue id) and category", () => {
    const cmd = commandQueue.enqueue({ tool: "create_instance", command: "--p3", args: {} });
    expect(cmd.meta?.eventId).toBe(cmd.id);
    expect(cmd.meta?.category).toBe("edit");
    expect(commandQueue.cancel(cmd.id)).toBe(true);
  });

  it("keeps a caller-supplied authoritative category", () => {
    const cmd = commandQueue.enqueue({
      tool: "create_instance",
      command: "--p3",
      args: {},
      meta: { category: "visual", sessionId: "s1" },
    });
    expect(cmd.meta?.category).toBe("visual");
    expect(cmd.meta?.sessionId).toBe("s1");
    expect(cmd.meta?.eventId).toBe(cmd.id);
    expect(commandQueue.cancel(cmd.id)).toBe(true);
  });
});
