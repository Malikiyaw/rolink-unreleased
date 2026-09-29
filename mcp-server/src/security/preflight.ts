// Risk preflight for execute_luau-class tools (offline, heuristic).
// Mirrors bridge.py _luau_risk — keep the two in sync when adding detectors.
// Estimates are honest approximations (counts + breadth), never fake precision.
// Non-undoable operations (DataStore writes, HTTP, broad destroy) require
// an explicit confirm:true from the model.

export interface RiskDanger {
  id: string;
  severity: "LOW" | "MEDIUM" | "HIGH";
  detail: string;
  confirm: boolean;
}

export interface LuauRisk {
  level: "LOW" | "MEDIUM" | "HIGH";
  dangers: RiskDanger[];
  services: string[];
  scope: Record<string, unknown>;
  requiresConfirm: boolean;
}

function stripNoise(code: string): string {
  const out = code.split("");
  const blank = (a: number, b: number) => {
    for (let k = a; k < Math.min(b, out.length); k++) if (out[k] !== "\n") out[k] = " ";
  };
  let i = 0;
  const n = code.length;
  while (i < n) {
    const c = code[i];
    if (c === "-" && code[i + 1] === "-") {
      if (code[i + 2] === "[" && code[i + 3] === "[") {
        const end = code.indexOf("]]", i + 4);
        blank(i, end === -1 ? n : end + 2);
        i = end === -1 ? n : end + 2;
        continue;
      }
      const nl = code.indexOf("\n", i + 2);
      blank(i, nl === -1 ? n : nl);
      i = nl === -1 ? n : nl;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n) {
        if (code[j] === "\\") { j += 2; continue; }
        if (code[j] === c) break;
        j++;
      }
      blank(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === "[" && code[i + 1] === "[") {
      const end = code.indexOf("]]", i + 2);
      blank(i, end === -1 ? n : end + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    i++;
  }
  return out.join("");
}

const count = (low: string, pat: RegExp): number => (low.match(pat) || []).length;

// True when a :Destroy() call sits inside a for/while/repeat body, so a
// scan-then-delete-one-target (Destroy outside any loop) passes without
// confirmation while real wipes stay gated. Runs on noise-stripped code;
// confusion gates (confirm), it never silently passes.
function destroyInLoop(clean: string): boolean {
  const destroys: number[] = [];
  for (const m of clean.matchAll(/:destroy\s*\(/g)) destroys.push(m.index ?? 0);
  if (!destroys.length) return false;
  const toks: Array<[number, string]> = [];
  for (const m of clean.matchAll(/\b(for|while|repeat|function|if|until|end)\b/g)) {
    toks.push([m.index ?? 0, m[1]]);
  }
  const stack: string[] = [];
  let di = 0;
  for (const [pos, kw] of toks) {
    while (di < destroys.length && destroys[di] < pos) {
      if (stack.includes("loop")) return true;
      di++;
    }
    if (kw === "for" || kw === "while" || kw === "repeat") stack.push("loop");
    else if (kw === "function" || kw === "if") stack.push("block");
    else if (kw === "end" || kw === "until") stack.pop();
  }
  while (di < destroys.length) {
    if (stack.includes("loop")) return true;
    di++;
  }
  return false;
}

export function analyzeRisk(code: unknown): LuauRisk {
  const empty: LuauRisk = { level: "LOW", dangers: [], services: [], scope: {}, requiresConfirm: false };
  if (typeof code !== "string" || !code.trim()) return empty;
  const low = stripNoise(code).toLowerCase();
  const dangers: RiskDanger[] = [];
  const scope: Record<string, unknown> = {};
  // Service names live inside string literals (blanked above) — extract from raw source.
  const services = [...new Set([...code.matchAll(/getservice\(\s*['"]([\w]+)['"]/gi)].map(m => m[1]))];

  const hasDs = low.includes("getdatastore") || low.includes("getordereddatastore");
  const dsWrite = hasDs && ["setasync", "updateasync", "removeasync", "incrementasync"].some(k => low.includes(k));
  if (dsWrite) dangers.push({ id: "datastore-write", severity: "HIGH", detail: "writes live player data (Set/Update/RemoveAsync) - cannot be undone via rollback", confirm: true });
  else if (hasDs) dangers.push({ id: "datastore-read", severity: "LOW", detail: "reads player data only", confirm: false });

  if (low.includes("httpservice") || low.includes("requestasync") || low.includes("httpget") || low.includes("httppost")) {
    dangers.push({ id: "http-request", severity: "HIGH", detail: "contacts the external network - side effects leave Studio", confirm: true });
  }

  const destroys = count(low, /:destroy\s*\(/g);
  const clears = count(low, /clearallchildren\s*\(/g);
  const scan = low.includes("getdescendants") || low.includes("getchildren");
  const broad = clears > 0 ||
    (destroys > 0 && ["workspace:destroy", "game:destroy", "game.workspace:destroy"].some(k => low.includes(k))) ||
    (destroys > 0 && scan && destroyInLoop(low));
  scope["destroyCalls"] = destroys;
  if (broad) dangers.push({ id: "broad-destroy", severity: "HIGH", detail: `${destroys} Destroy call(s) over a subtree (GetDescendants/ClearAllChildren) - confirm scope before running`, confirm: true });
  else if (destroys > 0) dangers.push({ id: "targeted-destroy", severity: "MEDIUM", detail: `${destroys} targeted Destroy call(s) - undoable via rollback`, confirm: false });

  const news = count(low, /instance\.new\s*\(/g);
  const inLoop = news > 0 && (low.includes("for ") || low.includes("while "));
  const bounds: number[] = [];
  for (const m of low.matchAll(/for\s+\w+\s*=\s*[^,]+,\s*(\d+)/g)) bounds.push(parseInt(m[1], 10));
  scope["instanceNewCalls"] = news;
  const estimated = inLoop ? news * (bounds.length ? Math.max(...bounds) : 100) : news;
  if (news > 0 && estimated > 50) dangers.push({ id: "mass-create", severity: "HIGH", detail: `~${news} Instance.new call site(s) inside loops (~${estimated} estimated instances) - may stall the viewport; split into smaller batches`, confirm: false });
  else if (news > 0) scope["instancesAffected"] = `~${news} new instance(s)`;

  if (low.includes(".source") && low.includes("=")) {
    dangers.push({ id: "script-write", severity: "MEDIUM", detail: "modifies script source at runtime - undoable via rollback, prefer set_script_content for kept changes", confirm: false });
    scope["scriptsAffected"] = ">=1";
  }

  let big = false;
  for (const m of low.matchAll(/for\s+\w+\s*=\s*[^,]+,\s*(\d+)/g)) {
    if (parseInt(m[1], 10) > 10000) { big = true; break; }
  }
  if (big) dangers.push({ id: "large-loop", severity: "MEDIUM", detail: "loop bound over 10000 iterations - must still terminate in seconds (20s budget)", confirm: false });

  if (low.includes("getobjects") || low.includes("loadstring")) {
    dangers.push({ id: "external-content", severity: "MEDIUM", detail: "loads external/by-id content or dynamic code - verify the source", confirm: false });
  }

  if (services.length) scope["servicesAffected"] = services;
  const level = dangers.some(d => d.severity === "HIGH") ? "HIGH" : dangers.length ? "MEDIUM" : "LOW";
  return { level, dangers, services, scope, requiresConfirm: dangers.some(d => d.confirm) };
}

export function riskSummary(risk: LuauRisk): string {
  const ds = risk.dangers.map(d => `${d.id}: ${d.detail}`).join("; ");
  const bits: string[] = [];
  const s = risk.scope;
  if (Array.isArray(s["servicesAffected"])) bits.push(`${(s["servicesAffected"] as string[]).length} service(s): ${(s["servicesAffected"] as string[]).slice(0, 5).join(", ")}`);
  if (typeof s["instanceNewCalls"] === "number" && (s["instanceNewCalls"] as number) > 0) bits.push(`~${s["instanceNewCalls"]} Instance.new`);
  if (typeof s["destroyCalls"] === "number" && (s["destroyCalls"] as number) > 0) bits.push(`${s["destroyCalls"]} Destroy`);
  let head = `Preflight risk ${risk.level}`;
  if (bits.length) head += " (" + bits.join(", ") + ")";
  if (ds) head += " - " + ds;
  if (risk.requiresConfirm) head += " [CONFIRM REQUIRED: re-send with confirm:true]";
  return head;
}
