import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { toolPrompts, HOT_PROMPT_TOOLS } from "../mcp-server/src/tools/toolPrompts.js";
import { tools } from "../mcp-server/src/tools/registry.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

export async function generateToolPrompts(): Promise<void> {
  const names = Object.keys(toolPrompts);
  const registryNames = new Set(tools.map((t) => t.name));
  const orphans = names.filter((n) => !registryNames.has(n));
  if (orphans.length) throw new Error(`toolPrompts has unknown tools: ${orphans.join(", ")}`);
  const missing = [...registryNames].filter((n) => !toolPrompts[n]);
  if (missing.length) throw new Error(`toolPrompts is missing registry tools: ${missing.join(", ")}`);

  const payload = {
    version: 1,
    source: "mcp-server/src/tools/toolPrompts.ts",
    generatedAt: new Date().toISOString(),
    promptCount: names.length,
    toolCount: tools.length,
    coverage: `${names.length}/${tools.length}`,
    prompts: toolPrompts,
  };
  await mkdir(join(ROOT, "generated"), { recursive: true });
  await writeFile(join(ROOT, "generated", "tool-prompts.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  // Full set shipped to the extension bundle (lazy lookup; ~60KB one-time parse).
  const hot: Record<string, (typeof toolPrompts)[string]> = {};
  for (const n of HOT_PROMPT_TOOLS) if (toolPrompts[n]) hot[n] = toolPrompts[n];
  const js =
    `// rolink-extension/core/tool-prompts.js — GENERATED. Do not edit by hand.\n` +
    `// Re-emit with: npm run generate:prompts (from mcp-server/)\n` +
    `//\n` +
    `// Source of truth: mcp-server/src/tools/toolPrompts.ts (all ${tools.length} tools; lazy lookup, ~60KB one-time parse).\n` +
    `// Loaded by content scripts (see rolink-extension/manifest.json) AFTER\n` +
    `// core/code-fields.js. main.js consults window.ROLINK_TOOL_PROMPTS on the\n` +
    `// error-recovery path (failed tool -> usage + pitfalls fed back to model).\n` +
    `window.ROLINK_TOOL_PROMPTS = ${JSON.stringify(hot, null, 2)};\n` +
    `// Additive lookup shim (Sprint A): window.RLPrompts.get(name) returns the\n` +
    `// full record including persona. Old window.ROLINK_TOOL_PROMPTS readers\n` +
    `// keep working unchanged.\n` +
    `window.RLPrompts = window.RLPrompts || {\n` +
    `  get: function(name){ var p = window.ROLINK_TOOL_PROMPTS || {}; return p[name] || null; },\n` +
    `  has: function(name){ var p = window.ROLINK_TOOL_PROMPTS || {}; return !!p[name]; },\n` +
    `  names: function(){ return Object.keys(window.ROLINK_TOOL_PROMPTS || {}); }\n` +
    `};\n`;
  await writeFile(join(ROOT, "rolink-extension", "core", "tool-prompts.js"), js, "utf8");
  console.log(`generated/tool-prompts.json: ${names.length}/${tools.length} tools`);
  console.log(`rolink-extension/core/tool-prompts.js: ${Object.keys(hot).length} hot prompts`);

  // Compact name -> persona-first-line map for popup.js tooltips (the popup
  // page cannot reach content-script window.ROLINK_TOOL_PROMPTS).
  const firstLine = (s: string): string => {
    const m = String(s).match(/^.*?[.!?](?=\s|$)/s);
    return (m ? m[0] : String(s)).trim();
  };
  const lines: Record<string, string> = {};
  for (const n of names) lines[n] = firstLine(toolPrompts[n].persona);
  const pj =
    `// rolink-extension/core/persona-lines.js — GENERATED. Do not edit by hand.\n` +
    `// Re-emit with: npm run generate:prompts (from mcp-server/)\n` +
    `// Compact name -> persona-first-line map for popup.js tooltips (popup has\n` +
    `// no access to content-script window.ROLINK_TOOL_PROMPTS).\n` +
    `window.ROLINK_PERSONA_LINES = ${JSON.stringify(lines, null, 2)};\n`;
  await writeFile(join(ROOT, "rolink-extension", "core", "persona-lines.js"), pj, "utf8");
  console.log(`rolink-extension/core/persona-lines.js: ${names.length} persona lines`);
}
