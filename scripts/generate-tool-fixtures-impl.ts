import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tools } from "../mcp-server/src/tools/registry.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export async function generateToolFixtures(): Promise<void> {
  const dir = join(ROOT, "rolink-extension", "core", "__fixtures__", "tool-calls");
  await mkdir(dir, { recursive: true });
  for (const tool of tools) {
    const safe = tool.name.replace(/[^A-Za-z0-9_.-]/g, "_");
    const payload = { tool: tool.name, args: {} };
    const text = `###MCP_TOOL###\n${JSON.stringify(payload, null, 2)}\n`;
    await writeFile(join(dir, `${safe}.txt`), text, "utf8");
  }
  console.log(`generated ${tools.length} parser fixtures in ${dir}`);
  console.log(`registry contains ${new Set(tools.map((t) => t.name)).size} unique tool names`);
}
