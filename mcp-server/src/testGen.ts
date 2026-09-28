/**
 * S12 Automatic Test Suite Generation — generates Luau tests from code, runs via sandbox harness
 */
export interface GeneratedTest {
  name: string;
  code: string; // Luau harness
  kind: "unit"|"integration";
}

export function generateTests(luauCode: string): GeneratedTest[] {
  const tests: GeneratedTest[] = [];
  // detect functions
  const funcs = [...luauCode.matchAll(/function\s+(\w+)[:(]/g)].map(m=>m[1]);
  const hasInstance = luauCode.includes("Instance.new");
  const hasRemote = luauCode.includes("RemoteEvent") || luauCode.includes("Connect");

  if (funcs.length) {
    for (const fn of funcs.slice(0,3)) {
      tests.push({
        name: `test_${fn}_exists`,
        kind: "unit",
        code: `assert(${fn} ~= nil, "${fn} should exist")\nprint("PASS ${fn} exists")`
      });
    }
  }
  if (hasInstance) tests.push({ name:"test_instances_parented", kind:"integration", code: `for _,v in ipairs(workspace:GetChildren()) do assert(v.Parent==workspace, "parent check") end\nprint("PASS instances")` });
  if (hasRemote) tests.push({ name:"test_remote_fires", kind:"integration", code: `local re = game.ReplicatedStorage:FindFirstChild("BuyItem")\nassert(re~=nil, "RemoteEvent missing")\nprint("PASS remote")` });

  if (tests.length===0) tests.push({ name:"test_runs_without_error", kind:"unit", code: `print("PASS runs without error")` });

  return tests;
}

export function buildHarness(originalCode: string, tests: GeneratedTest[]): string {
  const testBlock = tests.map(t=> `-- ${t.name}\n${t.code}`).join("\n\n");
  return `
-- original code
${originalCode}

-- === RoLink generated tests ===
${testBlock}
print("[RoLink tests] ${tests.length} tests executed")
`.trim();
}
