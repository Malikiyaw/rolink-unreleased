/**
 * Regression tests for the truth/consistency fixes.
 *
 * Every case here corresponds to a bug that shipped: a tool that reported
 * success it could not substantiate, a queue waiter that leaked, or a security
 * boundary that did not exist. They are written against the public handlers so
 * a future refactor cannot quietly restore the old behaviour.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { tools } from "../src/tools/registry.js";
import { rollbackManager } from "../src/rollback.js";
import { commandQueue } from "../src/commandQueue.js";
import { isToolAllowed, knownToolCount, registerKnownTools } from "../src/security/policy.js";
import { simulateEconomy, suggestBalance } from "../src/economySim.js";

const tool = (name: string) => {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool: ${name}`);
  return t;
};

/** Handlers return JSON inside content[0].text; parse it for assertions. */
async function callJson(name: string, args: Record<string, unknown> = {}) {
  const out = await tool(name).handler(args);
  const text = out.content[0].text;
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  return { body, isError: !!out.isError };
}

describe("rollback can no longer certify an undo it never had", () => {
  beforeEach(() => rollbackManager.clear());

  it("refuses to record a history entry without a snapshot", () => {
    expect(() =>
      rollbackManager.push({
        id: "x",
        projectId: "p",
        timestamp: Date.now(),
        tool: "set_script_content",
        command: "…",
        // snapshotBefore deliberately omitted
      } as any)
    ).toThrow(/without a snapshotBefore/);
  });

  it("reports an honest error when there is nothing recorded", async () => {
    const { body, isError } = await callJson("rollback", { projectId: "empty-project" });
    expect(isError).toBe(true);
    expect(body.ok).toBe(false);
    expect(body.status).toBe("error");
    expect(body.error.code).toBe("VERIFY_FAILED");
    expect(body.result.rolledBack).toBe(0);
  });

  it("rollback outcome distinguishes restored from skipped", () => {
    rollbackManager.push({
      id: "s1",
      projectId: "p2",
      timestamp: Date.now(),
      tool: "take_snapshot",
      command: "--snapshot",
      snapshotBefore: "{\"tree\":\"fake\"}",
    });
    const outcome = rollbackManager.rollback("p2", 5);
    expect(outcome.ok).toBe(true);
    expect(outcome.restored).toHaveLength(1);
    expect(outcome.skipped).toHaveLength(0);
    // Second rollback finds nothing left: it must not claim success again.
    const again = rollbackManager.rollback("p2", 5);
    expect(again.ok).toBe(false);
    expect(again.reason).toMatch(/nothing was recorded/i);
  });
});

describe("export_project / import_project round-trip", () => {
  it("returns a complete archive that import_project can decode", async () => {
    const exp = await callJson("export_project", { projectId: "roundtrip" });
    expect(exp.isError).toBe(false);
    expect(exp.body.ok).toBe(true);
    const archive: string = exp.body.result.archive;
    // The old handler truncated to 200 chars; a real context is bigger.
    expect(archive.length).toBeGreaterThan(200);

    const imp = await callJson("import_project", { archive, projectId: "roundtrip" });
    expect(imp.isError).toBe(false);
    expect(imp.body.ok).toBe(true);
    expect(imp.body.result.imported).toBe(true);
    expect(Array.isArray(imp.body.result.sections)).toBe(true);
  });

  it("rejects a truncated archive instead of claiming an import", async () => {
    const exp = await callJson("export_project", { projectId: "trunc" });
    const truncated = String(exp.body.result.archive).slice(0, 200);
    const imp = await callJson("import_project", { archive: truncated });
    expect(imp.isError).toBe(true);
    expect(imp.body.ok).toBe(false);
    expect(imp.body.verification.passed).toBe(false);
  });

  it("fails loudly when the context exceeds the archive limit", async () => {
    const exp = await callJson("export_project", { projectId: "big", maxBytes: 1024 });
    // Either it fits (small context) or it must be an explicit error, never a
    // silent truncation that still says exported:true.
    if (exp.body.ok) {
      expect(exp.body.result.archive.length).toBeGreaterThan(200);
    } else {
      expect(exp.isError).toBe(true);
      expect(exp.body.error.code).toBe("VALIDATION");
    }
  });
});

describe("simulate_economy computes its numbers", () => {
  it("is deterministic for identical input (no randomness)", () => {
    const a = simulateEconomy({ faucetPerDay: 100, sinkPerDay: 80 }, 500);
    const b = simulateEconomy({ faucetPerDay: 100, sinkPerDay: 80 }, 500);
    expect(a).toEqual(b);
  });

  it("actually uses the iteration count", () => {
    const short = simulateEconomy({ faucetPerDay: 100, sinkPerDay: 80 }, 10);
    const long = simulateEconomy({ faucetPerDay: 100, sinkPerDay: 80 }, 1000);
    expect(short.iterations).toBe(10);
    expect(long.iterations).toBe(1000);
    // Totals must scale with the number of iterations, not be a constant.
    expect(long.totalFaucet).toBeGreaterThan(short.totalFaucet * 50);
  });

  it("detects inflation and deflation from the actual flows", () => {
    const inflating = simulateEconomy(
      { faucetPerDay: 200, sinkPerDay: 50, startingBalance: 100 },
      1000
    );
    expect(inflating.balance).toBe("inflationary");
    expect(inflating.inflationPct).toBeGreaterThan(0);
    expect(inflating.faucetToSinkRatio).toBeGreaterThan(1);

    const draining = simulateEconomy(
      { faucetPerDay: 50, sinkPerDay: 200, startingBalance: 100 },
      1000
    );
    expect(draining.balance).toBe("deflationary");
    expect(draining.inflationPct).toBeLessThan(0);
  });

  it("reports stable when faucets and sinks match", () => {
    const balanced = simulateEconomy(
      { faucetPerDay: 100, sinkPerDay: 100, startingBalance: 1000 },
      1000
    );
    expect(balanced.balance).toBe("stable");
  });

  it("suggest_balance refuses to invent advice without a report", async () => {
    const { body, isError } = await callJson("suggest_balance", {});
    expect(isError).toBe(true);
    expect(body.error.code).toBe("VALIDATION");
    expect(suggestBalance("p", null)[0]).toMatch(/run simulate_economy first/);
  });

  it("the tool envelope exposes the computed config for auditability", async () => {
    const { body } = await callJson("simulate_economy", {
      config: { faucetPerDay: 120, sinkPerDay: 90 },
      iterations: 50,
    });
    expect(body.result.iterations).toBe(50);
    expect(body.result.config.faucetPerDay).toBe(120);
    expect(body.verification.checked).toBe(true);
  });
});

describe("commandQueue does not leak waiters or grow without bound", () => {
  it("rejects immediately for an already-failed command", async () => {
    const cmd = commandQueue.enqueue({ tool: "create_instance", command: "--t", args: {} });
    commandQueue.complete(cmd.id, null, "boom");
    const started = Date.now();
    await expect(commandQueue.waitForResult(cmd.id, 5000)).rejects.toThrow(/boom/);
    expect(Date.now() - started).toBeLessThan(1000); // did not wait the timeout
  });

  it("resolves a waiter registered before completion", async () => {
    const cmd = commandQueue.enqueue({ tool: "create_instance", command: "--t2", args: {} });
    const p = commandQueue.waitForResult(cmd.id, 5000);
    commandQueue.complete(cmd.id, { done: true });
    await expect(p).resolves.toEqual({ done: true });
  });

  it("keeps the result on the command even when no waiter is attached", () => {
    const cmd = commandQueue.enqueue({ tool: "create_instance", command: "--t3", args: {} });
    commandQueue.complete(cmd.id, { late: true });
    const stored = commandQueue.get(cmd.id);
    expect(stored?.status).toBe("done");
    expect(stored?.result).toEqual({ late: true });
  });

  it("purges failed commands too, not just done ones", () => {
    const cmd = commandQueue.enqueue({ tool: "create_instance", command: "--t4", args: {} });
    commandQueue.complete(cmd.id, null, "nope");
    (cmd as any).createdAt = Date.now() - 10 * 60 * 1000;
    commandQueue.clearDone(1000);
    expect(commandQueue.get(cmd.id)).toBeUndefined();
  });
});

describe("tool policy is default-deny", () => {
  it("allows registered tools", () => {
    expect(isToolAllowed("create_instance")).toBe(true);
    expect(isToolAllowed("execute_luau")).toBe(true);
  });

  it("rejects unknown names instead of allowing anything matching /^[a-z_]+$/", () => {
    expect(isToolAllowed("totally_made_up_tool")).toBe(false);
    expect(isToolAllowed("")).toBe(false);
    expect(isToolAllowed("Drop_Table")).toBe(false);
  });

  it("is backed by the real registry, not a stale hand-written list", () => {
    registerKnownTools(["only_in_test_tool"]);
    expect(isToolAllowed("only_in_test_tool")).toBe(true);
    expect(knownToolCount()).toBeGreaterThan(100);
  });
});

describe("registry.ts contains no fabricated receipts", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../src/tools/registry.ts", import.meta.url)),
    "utf8"
  );

  it("does not stand a random number in for a computed result", () => {
    // Math.random is fine for id minting; it is not fine as an "inflation" value.
    const suspicious = /inflation\s*[:=]\s*\(?\s*Math\.random/;
    expect(suspicious.test(src)).toBe(false);
  });

  it("does not truncate an archive it reports as exported", () => {
    expect(/toString\("base64"\)\.slice\(/.test(src)).toBe(false);
  });
});
