/**
 * S1 Self-Healing — parses Studio errors, applies deterministic fixes, retries
 * Heuristics: missing `end`, unmatched parentheses, WaitForChild typo, deprecated :connect -> :Connect
 */
export interface HealResult {
  healed: boolean;
  original: string;
  fixed?: string;
  reason?: string;
  attempts: number;
}

const FIXES: Array<{ test: RegExp; apply: (code: string, err: string) => string | null; reason: string }> = [
  {
    test: /'end' expected|expected.*end/i,
    reason: "Missing 'end'",
    apply: (code) => {
      const opens = (code.match(/\b(function|if|for|while|do)\b/g) || []).length;
      const ends = (code.match(/\bend\b/g) || []).length;
      if (opens > ends) return code + "\n" + Array(opens - ends).fill("end").join("\n");
      return null;
    },
  },
  {
    test: /unfinished string|unclosed string/i,
    reason: "Unclosed string",
    apply: (code) => (code.includes('"') && (code.match(/"/g) || []).length % 2 === 1 ? code + '"' : null),
  },
  {
    test: /attempt to index nil|nil value/i,
    reason: "Nil guard insertion",
    apply: (code) => {
      // wrap WaitForChild without timeout check
      if (code.includes("WaitForChild")) return code.replace(/:WaitForChild\(([^)]+)\)/g, ':WaitForChild($1, 10)');
      return null;
    },
  },
  {
    test: /:connect is deprecated/i,
    reason: "Deprecated :connect",
    apply: (code) => code.replace(/:connect\(/g, ":Connect("),
  },
  {
    test: /unknown global/i,
    reason: "Typo correction (WatiForChild etc)",
    apply: (code) => code.replace(/WatiForChild/g, "WaitForChild").replace(/Instnace/g, "Instance"),
  },
  {
    test: /\) expected|\( expected/i,
    reason: "Unbalanced parentheses",
    apply: (code) => {
      const o = (code.match(/\(/g) || []).length;
      const c = (code.match(/\)/g) || []).length;
      if (o > c) return code + ")".repeat(o - c);
      if (c > o) return "(".repeat(c - o) + code;
      return null;
    },
  },
];

export function healCode(code: string, error: string): HealResult {
  let current = code;
  let attempts = 0;
  for (const fix of FIXES) {
    if (fix.test.test(error) || fix.test.test(code)) {
      const applied = fix.apply(current, error);
      if (applied && applied !== current) {
        attempts++;
        return { healed: true, original: code, fixed: applied, reason: fix.reason, attempts };
      }
    }
  }
  // generic syntactic: trim trailing comma before end
  if (error.includes("',' expected") || error.includes("unexpected symbol")) {
    const fixed = current.replace(/,\s*\n\s*end/g, "\nend");
    if (fixed !== current) return { healed: true, original: code, fixed, reason: "Trailing comma", attempts: 1 };
  }
  return { healed: false, original: code, reason: "No heuristic matched", attempts: 0 };
}

// called from queue result path
export function shouldAutoHeal(error: string): boolean {
  return FIXES.some(f => f.test.test(error));
}
