import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tools } from "../mcp-server/src/tools/registry.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function unwrap(schema: any): any {
  let s = schema;
  while (s?._def?.innerType) s = s._def.innerType;
  while (s?._def?.schema && s?._def?.typeName === "ZodEffects") s = s._def.schema;
  return s;
}

function schemaFields(schema: any): string[] {
  const s = unwrap(schema);
  if (s?._def?.typeName !== "ZodObject") return [];
  return Object.keys(s._def.shape()).sort();
}

export async function generateToolAudit(): Promise<void> {
  const rows = tools.map((tool, i) => {
    const fields = schemaFields(tool.inputSchema);
    const handler = String(tool.handler);
    const hasStructuredError = /isError|catch|throw/.test(handler);
    const mutating = /create|set|delete|clone|move|run|apply|import|rollback|commit|publish|execute|generate/i.test(tool.name);
    const tier = mutating ? "T1/T2" : (/^get_|^find_|^search_|^list_|^inspect_|^diff_|^report_|^suggest_/i.test(tool.name) ? "T3" : "T2");
    return `| ${i + 1} | \`${tool.name}\` | ${tier} | ${fields.length ? "OK" : "REVIEW"} | ${tool.handler ? "wired" : "missing"} | ${hasStructuredError ? "reviewed" : "review"} | N |`;
  }).join("\n");

  const doc = `# RoLink tool audit

Generated from \`mcp-server/src/tools/registry.ts\` with \`npm run audit:tools\`.

**Static audit is not a live Studio verification.** The "Studio Y/N" column is intentionally "N" until the tool is executed against a real Roblox Studio session.

| # | Tool | Tier | Schema | Handler | Error path | Studio Y/N |
|---:|---|---|---|---|---|:---:|
${rows}

## Live verification rule

Tier 1 and Tier 2 tools must be run against a live Roblox Studio place before the final status is changed to Y. A result must be recorded, not inferred from a successful enqueue.
`;

  await mkdir(join(ROOT, "docs"), { recursive: true });
  await writeFile(join(ROOT, "docs", "tool-audit.md"), doc, "utf8");
  console.log(`generated docs/tool-audit.md with ${tools.length} tools`);
}
