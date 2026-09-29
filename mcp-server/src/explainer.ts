// S43 — explain_code: static Luau explanation without a real AST library.
// Produces an overview, key-functions, dependencies and a Mermaid graph
// from regex-based extraction. Deterministic, offline, no API key.

import { reviewLuau } from "./codeReview.js";

const FN_RE = /(?:\bfunction\s+([A-Za-z0-9_.:]+)\s*\(([^)]*)\)|([A-Za-z0-9_.]+)\s*[:.]\s*function\s*\(([^)]*)\)|\blocal\s+function\s+([A-Za-z0-9_.]+)\s*\(([^)]*)\))/g;
const EVT_RE = /\b([A-Za-z0-9_.]+)\s*[:.][A-Za-z0-9_]*[Aa]ddEvent\b|\bevent\s*[:.]\s*(?:connect|Connect)\s*\(\s*function\s*\(([^)]*)\)/g;
const REQ_RE = /\b(?:require|game:GetService|script:WaitForChild)\s*\(\s*["']([^"']+)["']\s*\)/g;
const REMOTE_RE = /\b(RemoteEvent|RemoteFunction|Remote)\s*[:.](\w+)/g;

export async function explain_code(scriptPath: string, code?: string) {
  const src = (code || "").toString();
  const fns = [];
  let m;
  while ((m = FN_RE.exec(src))) {
    const name = m[1] || m[3] || m[5] || "?";
    const params = (m[2] || m[4] || m[6] || "").split(",").map(s => s.trim()).filter(Boolean);
    fns.push({ name, params, line: lineOf(src, m.index) });
  }
  const events = [];
  while ((m = EVT_RE.exec(src))) {
    events.push({ at: m[1] || "?", line: lineOf(src, m.index) });
  }
  const deps = new Set();
  while ((m = REQ_RE.exec(src))) deps.add(m[1]);
  const remotes = [];
  while ((m = REMOTE_RE.exec(src))) remotes.push({ kind: m[1], method: m[2], line: lineOf(src, m.index) });

  const review = reviewLuau(src);
  const lineCount = src.split(/\n/).length;
  const overview = fns.length
    ? `Script defines ${fns.length} function${fns.length === 1 ? "" : "s"} and uses ${deps.size} dependency ${deps.size === 1 ? "module" : "modules"}.`
    : `Script is ${lineCount} lines, no top-level functions detected.`;

  // Build a small Mermaid graph: Script -> deps -> events -> outputs.
  const depList = [...deps].map(String);
  const nodes: string[] = ["S([Script])"];
  for (const d of depList) nodes.push(`D_${safe(d)}[${safe(d)}]`);
  for (const e of events.slice(0, 5)) nodes.push(`E_${safe(e.at)}[event ${safe(e.at)}]`);
  const lineList: string[] = [];
  for (const d of depList) lineList.push(`S --> D_${safe(d)}`);
  for (const e of events.slice(0, 5)) lineList.push(`S --> E_${safe(e.at)}`);
  const mermaid = `graph LR\n  ${nodes.slice(0, 12).join("\n  ")}\n  ${lineList.slice(0, 12).join("\n  ")}`;

  return {
    scriptPath,
    overview,
    lineCount,
    keyFunctions: fns.slice(0, 20),
    events: events.slice(0, 20),
    dependencies: [...deps].slice(0, 20),
    remotes: remotes.slice(0, 20),
    issues: review.issues.slice(0, 10),
    mermaid
  };
}

function lineOf(src: string, idx: number): number {
  let line = 1;
  for (let i = 0; i < idx && i < src.length; i++) if (src[i] === "\n") line++;
  return line;
}
function safe(s: string): string { return String(s).replace(/[^A-Za-z0-9_]/g, "_").slice(0, 32) || "x"; }
