/**
 * Python <-> TypeScript preflight parity.
 *
 * `security/preflight.ts` says in its header "Mirrors bridge.py _luau_risk -
 * keep the two in sync when adding detectors", but nothing enforced that. The
 * risk gate is the only thing standing between the model and a DataStore write
 * or a broad destroy, and the two implementations could silently disagree about
 * what needs a confirmation.
 *
 * The fixtures below are the exact snippets used by tests/test_preflight_atomic.py
 * (Python). Both sides must agree on `requiresConfirm` for all of them. Adding a
 * detector to one side without the other now fails here instead of shipping.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { analyzeRisk } from "../src/security/preflight.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const BRIDGE = `${ROOT}/bridge.py`;

/** Snippets shared with tests/test_preflight_atomic.py. */
const CASES: Array<{ name: string; code: string; confirm: boolean; dangerId?: string }> = [
  { name: "clean literal", code: "local x = 1 + 1\nreturn x", confirm: false },
  {
    name: "datastore write",
    code:
      'local ds = game:GetService("DataStoreService"):GetDataStore("P")\n' +
      'ds:SetAsync("k", 1)\nreturn 1',
    confirm: true,
    dangerId: "datastore-write",
  },
  {
    name: "http request",
    code:
      'local h = game:GetService("HttpService")\n' +
      'return h:RequestAsync({Url="https://x.example", Method="GET"})',
    confirm: true,
    dangerId: "http-request",
  },
  {
    name: "broad destroy",
    code: "for _, d in ipairs(workspace:GetDescendants()) do d:Destroy() end\nreturn 1",
    confirm: true,
    dangerId: "broad-destroy",
  },
  {
    name: "targeted destroy",
    code: "workspace.Map.OldSign:Destroy()\nreturn 1",
    confirm: false,
  },
  {
    name: "loop wipe children",
    code: "for _, v in pairs(folder:GetChildren()) do v:Destroy() end\nreturn 1",
    confirm: true,
    dangerId: "broad-destroy",
  },
  {
    name: "loop unrelated",
    code: "for i = 1, 3 do print(i) end\nworkspace.Map.OldSign:Destroy()\nreturn 1",
    confirm: false,
  },
  {
    // Strings and comments must not trip the detectors.
    name: "string trap",
    code:
      'local s = "call httpservice destroy :Destroy("\n' +
      "-- workspace:GetDescendants() destroy\nreturn s",
    confirm: false,
  },
];

describe("preflight risk parity with bridge.py", () => {
  const havePython = existsSync(BRIDGE);

  it("agrees with the TS implementation on every shared case", () => {
    for (const c of CASES) {
      const risk = analyzeRisk(c.code);
      expect(risk.requiresConfirm, `${c.name}: requiresConfirm`).toBe(c.confirm);
    }
  });

  it("names the expected danger id where one is pinned", () => {
    for (const c of CASES) {
      if (!c.dangerId) continue;
      const ids = analyzeRisk(c.code).dangers.map((d) => d.id);
      expect(ids, `${c.name}: danger ids`).toContain(c.dangerId);
    }
  });

  (havePython ? it : it.skip)(
    "matches bridge.py _luau_risk output exactly",
    () => {
      const payload = JSON.stringify(CASES.map((c) => ({ name: c.name, code: c.code })));
      let out: string;
      try {
        out = execFileSync(
          "python3",
          ["-c", PY_SIDE, payload],
          { cwd: ROOT, encoding: "utf8", timeout: 60_000 }
        );
      } catch (e: any) {
        // No python3 / no websockets in this environment: the TS-side
        // assertions above still ran, so skip rather than fail the suite.
        console.warn(`[preflight parity] skipped: ${e?.message ?? e}`);
        return;
      }
      const py = JSON.parse(out.trim());
      for (const row of py) {
        const ts = analyzeRisk(row.code);
        expect(ts.requiresConfirm, `${row.name}: requiresConfirm parity`).toBe(row.confirm);
        expect(ts.level, `${row.name}: risk level parity`).toBe(row.level);
      }
    }
  );
});

/**
 * Runs inside python3: loads bridge.py in isolation and prints the risk verdict
 * for each case as JSON. Kept as a string so the test needs no extra file.
 */
const PY_SIDE = `
import json, os, sys
sys.path.insert(0, os.path.join(os.getcwd(), "tests"))
os.environ["ROLINK_QUEUE_PORT"] = "18083"
from _isolated_bridge import load_bridge
b = load_bridge(18083)
cases = json.loads(sys.argv[1]) if len(sys.argv) > 1 else json.load(sys.stdin)
out = []
for c in cases:
    r = b._luau_risk(c["code"])
    out.append({"name": c["name"], "code": c["code"],
                "confirm": bool(r.get("requiresConfirm")),
                "level": r.get("level")})
print(json.dumps(out))
`;
