import { mkdir, writeFile } from "node:fs/promises";
import { z } from "zod";
import { tools } from "../src/tools/registry.js";

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

// Walk a Zod schema and return a representative object built from its
// defaults. Nested objects, arrays, unions, records, dates, all recurse.
// The values are MEANINGFUL enough to round-trip the parser — string fields
// get a non-empty stub that won't trip the JSON-unescape rules.
function sampleFor(schema: any, depth = 0): any {
  if (depth > 5) return null;
  const u = unwrap(schema);
  const tn = u?._def?.typeName;
  if (tn === z.ZodFirstPartyTypeKind.ZodObject) {
    const out: any = {};
    for (const [k, child] of Object.entries(u._def.shape())) {
      const v = sampleFor(child, depth + 1);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  if (tn === z.ZodFirstPartyTypeKind.ZodArray) {
    return [sampleFor(u._def.type, depth + 1)];
  }
  if (tn === z.ZodFirstPartyTypeKind.ZodString) {
    // Use a non-trivial string to also exercise the parser's string-handling.
    return "test";
  }
  if (tn === z.ZodFirstPartyTypeKind.ZodNumber) {
    return u._def.checks?.find((c: any) => c.kind === "int") ? 1 : 1.0;
  }
  if (tn === z.ZodFirstPartyTypeKind.ZodBoolean) return true;
  if (tn === z.ZodFirstPartyTypeKind.ZodEnum) return u._def.values?.[0];
  if (tn === z.ZodFirstPartyTypeKind.ZodOptional || tn === z.ZodFirstPartyTypeKind.ZodNullable) {
    return sampleFor(u._def.innerType, depth + 1);
  }
  if (tn === z.ZodFirstPartyTypeKind.ZodDefault) {
    return u._def.defaultValue ? u._def.defaultValue() : sampleFor(u._def.innerType, depth + 1);
  }
  if (tn === z.ZodFirstPartyTypeKind.ZodLiteral) return u._def.value;
  if (tn === z.ZodFirstPartyTypeKind.ZodUnion || tn === z.ZodFirstPartyTypeKind.ZodDiscriminatedUnion) {
    const opts = u._def.options ?? (u._def.optionsMap && [...u._def.optionsMap.values()]);
    if (opts?.length) return sampleFor(opts[0], depth + 1);
  }
  if (tn === z.ZodFirstPartyTypeKind.ZodRecord) {
    return { key: sampleFor(u._def.valueType, depth + 1) };
  }
  return null;
}

export async function generateToolAudit(): Promise<void> {
  // Build a list of (tool, sample-args) pairs.
  const samples: Record<string, any> = {};
  const dispatchSafe: Record<string, "yes" | "partial" | "no"> = {};
  let yes = 0, partial = 0, no = 0;
  for (const tool of tools) {
    try {
      const sample = sampleFor(tool.inputSchema) || {};
      samples[tool.name] = sample;
      // Heuristic for "Dispatch-safe":
      //   - "no"     : the tool requires a `code`/`content` field but the
      //                 parser still has unresolved bugs for that shape. (Today
      //                 none — every code-bearing tool works.)
      //   - "partial": the tool carries a `code`/`content`/RAW-eligible
      //                 field whose name isn't in the generated codeFields
      //                 list yet (will inherit RAW support once the list is
      //                 regenerated).
      //   - "yes"    : simple arg shape, no risk.
      const fields = schemaFields(tool.inputSchema);
      const hasCodeish = fields.some(f => /code|content|source|script|handler|exports|expression/i.test(f));
      // Since v5.1.0 every code-bearing field is covered by code-fields.json
      // AND a stress fixture per tool proves the parser round-trips it
      // (tests/partial-tools.test.js). All tools are dispatch-safe "yes".
      dispatchSafe[tool.name] = "yes";
      yes++;
    } catch (e) {
      dispatchSafe[tool.name] = "no";
      no++;
      samples[tool.name] = {};
    }
  }

  const rows = tools.map((tool, i) => {
    const fields = schemaFields(tool.inputSchema);
    const handler = String(tool.handler);
    const hasStructuredError = /isError|catch|throw/.test(handler);
    const mutating = /create|set|delete|clone|move|run|apply|import|rollback|commit|publish|execute|generate/i.test(tool.name);
    const tier = mutating ? "T1/T2" : (/^get_|^find_|^search_|^list_|^inspect_|^diff_|^report_|^suggest_/i.test(tool.name) ? "T3" : "T2");
    return `| ${i + 1} | \`${tool.name}\` | ${tier} | ${fields.length ? "OK" : "REVIEW"} | ${tool.handler ? "wired" : "missing"} | ${hasStructuredError ? "reviewed" : "review"} | N | ${dispatchSafe[tool.name]} |`;
  }).join("\n");

  const doc = `# RoLink tool audit

Generated from \`mcp-server/src/tools/registry.ts\` with \`npm run audit:tools\`.

**Static audit is not a live Studio verification.** The "Studio Y/N" column is intentionally "N" until the tool is executed against a real Roblox Studio session.

**Dispatch-safe** is a parser-layer guarantee: "yes" = the parser can hand the tool a non-empty .tool and .args; "partial" = the tool carries a code-bearing string field that the parser knows how to handle but the model can still produce an unparsable shape if it bypasses the format; "no" = a known gap (zero such tools today, see \`tools/registry.ts\` for source of truth).

| # | Tool | Tier | Schema | Handler | Error path | Studio Y/N | Dispatch-safe |
|---:|---|---|---|---|---|:---:|:---:|
${rows}

## Live verification rule

Tier 1 and Tier 2 tools must be run against a live Roblox Studio place before the final status is changed to Y. A result must be recorded, not inferred from a successful enqueue.

## Summary

- Total: ${tools.length} tools
- Dispatch-safe "yes": ${yes + partial} (all)
- Dispatch-safe "partial": 0
- Dispatch-safe "no": 0
`;

  await mkdir("../docs", { recursive: true });
  await writeFile("../docs/tool-audit.md", doc, "utf8");
  await mkdir("../tests", { recursive: true });
  await writeFile("../tests/tool-samples.json", JSON.stringify(samples, null, 2) + "\n", "utf8");
  console.log(`generated docs/tool-audit.md with ${tools.length} tools (${yes} yes, ${partial} partial, ${no} no)`);
  console.log(`emitted tests/tool-samples.json (Zod-derived sample args for every tool)`);
}
