#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// scripts/emit-tool-registry.js — regenerate the HUD tool list in
// rolink-extension/ui/toolHud/toolRegistry.js from catalog/tools.json.
//
// Why this exists: toolRegistry.js used to carry a hand-maintained copy of the
// catalogue and it silently fell 9 tools behind (run_task, import_distinctus_build,
// revise_import, get_model_graph and five animation tools never got an icon or a
// category). Generating it makes that drift impossible.
//
// Run: node scripts/emit-tool-registry.js
// Exits non-zero when a rewrite is needed but --check was passed, so CI can
// enforce that the committed file matches the catalogue.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CATALOG = join(ROOT, "catalog", "tools.json");
const TARGET = join(ROOT, "rolink-extension", "ui", "toolHud", "toolRegistry.js");

const PER_LINE = 4;

export function buildBlock(tools) {
  const lines = [];
  let row = [];
  for (const name of tools) {
    row.push(JSON.stringify(name));
    if (row.length === PER_LINE) {
      lines.push("    " + row.join(", ") + ",");
      row = [];
    }
  }
  if (row.length) lines.push("    " + row.join(", "));
  return (
    "  // Full catalogue — GENERATED from catalog/tools.json. Do not edit by hand.\n" +
    "  // Regenerate with: node scripts/emit-tool-registry.js\n" +
    "  var TOOL_NAMES = [\n" +
    lines.join("\n") +
    "\n  ];"
  );
}

function replaceList(src, block) {
  const decl = src.indexOf("  var TOOL_NAMES = [");
  if (decl < 0) throw new Error("TOOL_NAMES block not found in toolRegistry.js");
  const end = src.indexOf("  ];", decl);
  if (end < 0) throw new Error("unterminated TOOL_NAMES block in toolRegistry.js");

  // Also consume the hand-written comment lines directly above the block, so
  // re-running the emitter cannot stack duplicate headers.
  let start = src.lastIndexOf("\n", decl - 1) + 1;
  for (;;) {
    const prevLineEnd = start > 0 ? start - 1 : -1;
    if (prevLineEnd < 0) break;
    const prevLineStart = src.lastIndexOf("\n", prevLineEnd - 1) + 1;
    const line = src.slice(prevLineStart, prevLineEnd);
    if (/^\s*\/\//.test(line)) {
      start = prevLineStart;
      continue;
    }
    break;
  }
  return src.slice(0, start) + block + src.slice(end + "  ];".length);
}

async function main() {
  const check = process.argv.includes("--check");
  const catalog = JSON.parse(await readFile(CATALOG, "utf8"));
  const tools = Array.isArray(catalog) ? catalog : catalog.tools;
  if (!Array.isArray(tools) || !tools.length) {
    throw new Error(`catalog has no tools: ${CATALOG}`);
  }
  const src = await readFile(TARGET, "utf8");
  const next = replaceList(src, buildBlock(tools));
  if (next === src) {
    console.log(`toolRegistry.js already in sync (${tools.length} tools).`);
    return;
  }
  if (check) {
    console.error(
      `toolRegistry.js is STALE vs catalog/tools.json (${tools.length} tools).\n` +
        "Run: node scripts/emit-tool-registry.js"
    );
    process.exit(1);
  }
  await writeFile(TARGET, next, "utf8");
  console.log(`toolRegistry.js: ${tools.length} tools emitted.`);
}

if (process.argv[1] && process.argv[1].endsWith("emit-tool-registry.js")) {
  main().catch((e) => {
    console.error(String(e && e.message ? e.message : e));
    process.exit(1);
  });
}
