/**
 * S5 Sandbox — server-side static checks before enqueue, plus Luau harness generation for plugin tests
 */
const BLOCKED = [
  /os\.execute/i,
  /io\.popen/i,
  /require\s*\(\s*["']http/i,
  /getfenv|setfenv\s*\(\s*_G/i,
  /--\s*hydroxide/i,
];

const WARN_PATTERNS: Array<{ re: RegExp; msg: string }> = [
  { re: /while\s+true\s+do\s*[^]*?end/i, msg: "Infinite loop without wait() — may hang Studio" },
  { re: /Instance\.new\([^)]+\)\s*[^]*?Parent\s*=\s*nil/i, msg: "Instance created but never parented — will leak" },
  { re: /:GetService\("HttpService"\).*HttpGet/i, msg: "External Http request — ensure allowlist" },
];

export interface SandboxResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  sanitized: string;
}

/**
 * Normalize render bleed before any check: BOM/ZWSP/NBSP, smart quotes.
 * Returns the code Studio will actually receive.
 */
export function normalizeLuau(code: string): string {
  return String(code || "")
    .replace(/[\u200b\u200c\u200d\ufeff]/g, "").replace(/^\uFEFF/, "")
    .replace(/[\u201c\u201d]/g, '"').replace(/[\u2018\u2019]/g, "'").replace(/\u00a0/g, " ");
}

/** String/comment-aware balance scan: braces inside literals never count. */
function scanBalance(code: string): { paren: number; brace: number; bracket: number; unterminated: string | null } {
  let paren = 0, brace = 0, bracket = 0;
  let i = 0; const n = code.length;
  let str: string | null = null; // '"', "'", or "]]" (long string)
  while (i < n) {
    const c = code[i];
    if (str === '"' || str === "'") {
      if (c === "\\") { i += 2; continue; }
      if (c === str) str = null;
      i++; continue;
    }
    if (str === "]]") {
      if (c === "]" && code[i + 1] === "]") { str = null; i += 2; continue; }
      i++; continue;
    }
    if (c === "-" && code[i + 1] === "-") {
      if (code[i + 2] === "[" && code[i + 3] === "[") {
        const end = code.indexOf("]]", i + 4); i = end === -1 ? n : end + 2; continue;
      }
      const nl = code.indexOf("\n", i + 2); i = nl === -1 ? n : nl + 1; continue;
    }
    if (c === '"' || c === "'") { str = c; i++; continue; }
    if (c === "[" && code[i + 1] === "[") { str = "]]"; i += 2; continue; }
    if (c === "(") paren++; else if (c === ")") paren--;
    else if (c === "{") brace++; else if (c === "}") brace--;
    else if (c === "[") bracket++; else if (c === "]") bracket--;
    i++;
  }
  return { paren, brace, bracket, unterminated: str };
}

export function validateLuau(code: string): SandboxResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const norm = normalizeLuau(code);

  if (!norm.trim()) {
    errors.push("empty code after stripping render chrome");
    return { ok: false, errors, warnings, sanitized: norm };
  }
  if (norm.length > 50000) errors.push("code too large (max 50k)");
  const lowNorm = norm.toLowerCase();
  if (/###\s*lua/.test(lowNorm) || /###\s*end[_\- ]?lua/.test(lowNorm))
    errors.push("render chrome: Luau transport markers (###LUA###) leaked into code - strip them before sending");
  if (norm.startsWith("```") || /^(?:copy\s+code|copy|json)(?![A-Za-z0-9_(])[\s]/i.test(norm))
    errors.push("render chrome prefix (Copy/fence) — strip before sending to Studio");
  if (norm.trimEnd().endsWith("```"))
    errors.push("render chrome suffix (fence) — strip before sending to Studio");
  const bal = scanBalance(norm);
  if (bal.unterminated) errors.push(`unterminated ${bal.unterminated === "]]" ? "long string" : "string literal"}`);
  if (bal.paren !== 0) errors.push("unbalanced parentheses");
  if (bal.brace !== 0) errors.push("unbalanced braces");
  if (bal.bracket !== 0) errors.push("unbalanced brackets");
  // check end count roughly
  const opens = (norm.match(/\b(function|if|for|while|do)\b/g) || []).length;
  const ends = (norm.match(/\bend\b/g) || []).length;
  if (opens > ends + 2) warnings.push(`Possible missing 'end' (opens ${opens} > ends ${ends})`);

  for (const b of BLOCKED) if (b.test(norm)) errors.push(`blocked pattern ${b}`);

  for (const w of WARN_PATTERNS) if (w.re.test(norm)) warnings.push(w.msg);

  // Tight-loop guard: Studio has no preemptive kill (no debug.sethook), so a
  // yield-less infinite loop hangs the plugin poll. Fail fast as an error.
  const low = norm.toLowerCase();
  if ((/while\s+true\s+do/.test(low) || /while\s+1\s+do/.test(low))
    && !/task\.wait|task\.delay|heartbeat|:wait\s*\(|wait\s*\(/.test(low)) {
    errors.push("probable infinite loop with no yield - add task.wait() inside the loop");
  }

  return { ok: errors.length === 0, errors, warnings, sanitized: norm };
}

export function makeSandboxTestHarness(code: string, tests: string): string {
  // Wrap code + tests in pcall harness for plugin
  return `
local __code = [==[${code}]==]
local ok, fn = pcall(loadstring, __code)
if not ok or not fn then error("loadstring failed: "..tostring(fn)) end
local env = {print=print, math=math, string=string, table=table, Instance=Instance, game=game, workspace=workspace}
pcall(function() setfenv(fn, env) end)
local ok2, res = pcall(fn)
if not ok2 then error("exec failed: "..tostring(res)) end
-- tests
${tests}
print("[sandbox] tests passed")
return res
`.trim();
}
