/**
 * S20 Code Review & Refactoring Assistant — static analysis + fix suggestions
 */
export interface ReviewIssue {
  severity: "info"|"warn"|"error";
  line?: number;
  message: string;
  fix?: string;
}

export function reviewLuau(code: string): { issues: ReviewIssue[]; fixedCode?: string; score: number } {
  const lines = code.split("\n");
  const issues: ReviewIssue[] = [];
  let fixed = code;

  lines.forEach((l,i)=>{
    if (l.includes(":connect(")) issues.push({ severity:"warn", line:i+1, message:"Use :Connect (capital C) — :connect deprecated", fix: l.replace(":connect(", ":Connect(") });
    if (/\bwait\s*\(/.test(l)) issues.push({ severity:"warn", line:i+1, message:"Use task.wait() instead of wait()", fix: l.replace(/\bwait\s*\(/, "task.wait(") });
    if (l.trim().startsWith("Instance.new") && !code.includes("Parent")) issues.push({ severity:"info", line:i+1, message:"Instance created without Parent — consider parenting immediately" });
    if (l.length > 120) issues.push({ severity:"info", line:i+1, message:"Long line >120 chars" });
    if (l.includes("GetChildren") && !l.includes("ipairs")) issues.push({ severity:"info", line:i+1, message:"Prefer `for _,v in ipairs(t:GetChildren()) do`" });
  });

  if (code.match(/\bfunction\b/g)?.length !== code.match(/\bend\b/g)?.length) issues.push({ severity:"error", message:"Mismatched function/end count" });

  // auto-fixes
  fixed = fixed.replace(/:connect\(/g, ":Connect(").replace(/\bwait\s*\(/g, "task.wait(");

  const score = Math.max(0, 100 - issues.filter(i=>i.severity==="error").length*20 - issues.filter(i=>i.severity==="warn").length*5);
  return { issues, fixedCode: fixed !== code ? fixed : undefined, score };
}

export function refactoringPlan(code: string): string[] {
  const steps: string[] = [];
  if (code.includes("Instance.new") && code.split("Instance.new").length > 4) steps.push("Extract instance creation into factory function createPart(pos, size)");
  if (/PlayerAdded:Connect.*IntValue/.test(code)) steps.push("Move leaderstats setup to ModuleScript for reusability");
  if (code.length > 800) steps.push("Split long script into Modules (e.g., Shop, Combat, Leaderboard)");
  if (!code.includes("task.wait") && code.includes("while true")) steps.push("Add task.wait() inside infinite loops");
  if (steps.length===0) steps.push("No major refactoring needed — code is modular");
  return steps;
}
