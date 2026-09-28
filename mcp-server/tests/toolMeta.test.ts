import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { categoryOfTool, commandQueue } from "../src/commandQueue.js";

const names: string[] = JSON.parse(
  readFileSync(new URL("../../tests/__registry__.json", import.meta.url), "utf8")
);
const VALID = ["read", "edit", "inspect", "generate", "asset", "visual", "test", "tool"];

describe("P3 queue tool meta", () => {
  it("registry has 150 tools", () => {
    expect(names.length).toBe(150);
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
