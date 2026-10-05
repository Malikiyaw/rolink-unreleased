/**
 * S10 AI Training on Your Codebase — stylometry from command history to personalize code style
 */
import { commandQueue } from "./commandQueue.js";

export interface StyleProfile {
  projectId: string;
  avgLineLength: number;
  usesWaitForChild: boolean;
  usesCamelCase: boolean;
  indent: string; // "\t" or "  "
  commonPatterns: string[];
  sampleCount: number;
}

class AiTraining {
  profile(projectId = "default"): StyleProfile {
    const items = commandQueue.status(projectId).items.slice(0, 50);
    const codes = items.map(i=> i.command).join("\n");
    const lines = codes.split("\n").filter(Boolean);
    const avgLineLength = lines.length ? lines.reduce((s,l)=> s + l.length,0)/lines.length : 0;
    const usesWaitForChild = codes.includes("WaitForChild");
    const usesCamelCase = /[a-z]+[A-Z]/.test(codes);
    const indent = codes.includes("\t") ? "\t" : "  ";
    const patterns: string[] = [];
    if (codes.includes("Instance.new")) patterns.push("Instance.new");
    if (codes.includes(":Connect")) patterns.push(":Connect");
    if (codes.includes("leaderstats")) patterns.push("leaderstats");
    return { projectId, avgLineLength: Math.round(avgLineLength*10)/10, usesWaitForChild, usesCamelCase, indent, commonPatterns: patterns, sampleCount: items.length };
  }

  /**
   * Apply fn to code segments only (outside "...", '...', [[...]] and
   * -- comments). The old global replaces rewrote string literals too
   * ("a  b" -> "a\tb"), changing diagnostics vs what the model wrote and
   * causing Studio parse mismatches.
   */
  private mapCodeSegments(code: string, fn: (seg: string) => string): string {
    let out = "", buf = "", i = 0; const n = code.length;
    let str: string | null = null;
    const flush = () => { if (buf) { out += fn(buf); buf = ""; } };
    while (i < n) {
      const c = code[i];
      if (str === '"' || str === "'") {
        if (c === "\\") { out += code.slice(i, i + 2); i += 2; continue; }
        out += c; if (c === str) str = null;
        i++; continue;
      }
      if (str === "]]") {
        out += c;
        if (c === "]" && code[i + 1] === "]") { out += "]"; str = null; i += 2; continue; }
        i++; continue;
      }
      if (c === "-" && code[i + 1] === "-") {
        flush();
        if (code[i + 2] === "[" && code[i + 3] === "[") {
          const end = code.indexOf("]]", i + 4); const stop = end === -1 ? n : end + 2;
          out += code.slice(i, stop); i = stop; continue;
        }
        const nl = code.indexOf("\n", i + 2); const stop = nl === -1 ? n : nl;
        out += code.slice(i, stop); i = stop; continue;
      }
      if (c === '"' || c === "'") { flush(); str = c; out += c; i++; continue; }
      if (c === "[" && code[i + 1] === "[") { flush(); str = "]]"; out += "[["; i += 2; continue; }
      buf += c; i++;
    }
    flush();
    return out;
  }

  personalize(code: string, projectId = "default"): string {
    const p = this.profile(projectId);
    // enforce indent style — code segments only, never string contents
    let out = p.indent === "\t"
      ? this.mapCodeSegments(code, (s) => s.replace(/ {2}/g, "\t"))
      : this.mapCodeSegments(code, (s) => s.replace(/\t/g, "  "));
    // if user prefers WaitForChild, ensure usage — code segments only
    if (p.usesWaitForChild && !out.includes("WaitForChild") && out.includes("FindFirstChild")) {
      out = this.mapCodeSegments(out, (s) =>
        s.replace(/FindFirstChild\("([^"]+)"\)/g, 'WaitForChild("$1")'));
    }
    return out;
  }

  // training is implicit from history; export dataset for future LLM fine-tune
  exportDataset(projectId = "default") {
    const items = commandQueue.status(projectId).items;
    return items.map(i=> ({ prompt: i.tool, completion: i.command, projectId }));
  }
}

export const aiTraining = new AiTraining();
