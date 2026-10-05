import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { z } from "zod";
import { tools } from "../mcp-server/src/tools/registry.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// This generator lives outside mcp-server, so a runtime `import "zod"` would
// resolve from the repository root (where dependencies are intentionally not
// installed). The registry owns the runtime zod instance; compare stable type
// names as strings here and keep zod types type-only.
const ZOD = {
  ZodOptional: "ZodOptional", ZodNullable: "ZodNullable", ZodDefault: "ZodDefault",
  ZodBranded: "ZodBranded", ZodCatch: "ZodCatch", ZodReadonly: "ZodReadonly",
  ZodEffects: "ZodEffects", ZodString: "ZodString", ZodObject: "ZodObject",
  ZodArray: "ZodArray", ZodSet: "ZodSet", ZodRecord: "ZodRecord",
  ZodUnion: "ZodUnion", ZodDiscriminatedUnion: "ZodDiscriminatedUnion",
} as const;

function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current = schema;
  while (true) {
    const typeName = (current as any)?._def?.typeName;
    if (typeName === ZOD.ZodOptional ||
        typeName === ZOD.ZodNullable ||
        typeName === ZOD.ZodDefault ||
        typeName === ZOD.ZodBranded ||
        typeName === ZOD.ZodCatch ||
        typeName === ZOD.ZodReadonly) {
      current = (current as any)._def.innerType ?? (current as any)._def.type;
      continue;
    }
    if (typeName === ZOD.ZodEffects) {
      current = (current as any)._def.schema;
      continue;
    }
    return current;
  }
}

function isString(schema: z.ZodTypeAny): boolean {
  return unwrap(schema)?._def?.typeName === ZOD.ZodString;
}

function codeLike(name: string): boolean {
  return /(?:code|content|source|script|text|string|handler|exports|prompt|query|description|label|message|expression|command)$/i.test(name);
}

function collect(schema: z.ZodTypeAny, prefix = "", out = new Set<string>()): Set<string> {
  const u = unwrap(schema);
  const typeName = (u as any)?._def?.typeName;
  if (typeName === ZOD.ZodObject) {
    const shape = (u as z.AnyZodObject)._def.shape();
    for (const [key, child] of Object.entries(shape)) {
      const path = prefix ? `${prefix}.${key}` : key;
      const unwrapped = unwrap(child as z.ZodTypeAny);
      if (isString(unwrapped)) out.add(path);
      else collect(unwrapped, path, out);
    }
  } else if (typeName === ZOD.ZodArray || typeName === ZOD.ZodSet) {
    collect((u as any)._def.type, `${prefix}[]`, out);
  } else if (typeName === ZOD.ZodRecord) {
    collect((u as any)._def.valueType, `${prefix}{}`, out);
  } else if (typeName === ZOD.ZodUnion || typeName === ZOD.ZodDiscriminatedUnion) {
    for (const option of (u as any)._def.options ?? (u as any)._def.optionsMap?.values?.() ?? []) collect(option, prefix, out);
  }
  return out;
}

export async function generateCodeFields(): Promise<void> {
  const toolFields: Record<string, string[]> = {};
  const stringFields = new Set<string>();
  for (const tool of tools) {
    const fields = [...collect(tool.inputSchema)].sort();
    toolFields[tool.name] = fields;
    for (const field of fields) stringFields.add(field.split(".").pop()!.replace(/\[\]$|\{\}$/g, ""));
  }

  const result = {
    version: 2,
    source: "mcp-server/src/tools/registry.ts",
    generatedAt: new Date().toISOString(),
    toolCount: tools.length,
    toolFields,
    stringFields: [...stringFields].sort(),
    codeLikeFields: [...stringFields].filter(codeLike).sort(),
  };

  await mkdir(join(ROOT, "generated"), { recursive: true });
  await writeFile(join(ROOT, "generated", "code-fields.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(`generated/code-fields.json: ${tools.length} tools, ${stringFields.size} string field names`);
}
