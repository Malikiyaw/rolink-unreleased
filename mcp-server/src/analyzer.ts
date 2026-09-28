// analyzer.ts – S3/S20 static analysis (Pro Max, offline)
import { validateLuau } from "./sandbox.js";
export function analyze(code: string){
  const v = validateLuau(code);
  const lines = code.split("\n");
  const warnings: string[] = [...v.warnings];
  if(code.includes("while true do") && !code.includes("task.wait")) warnings.push("Infinite loop without wait – will freeze Studio");
  if(lines.length > 500) warnings.push("Large script (>500 lines) – consider splitting into modules");
  const complexity = Math.min(100, lines.length + v.errors.length*10);
  return { valid: v.ok, errors:v.errors, warnings, complexity, lines: lines.length };
}
