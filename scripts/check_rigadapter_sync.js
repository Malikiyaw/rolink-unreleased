// scripts/check_rigadapter_sync.js — animation module sync guard.
// Verifies for every module in MODULES:
//  1. BEGIN/END markers each appear exactly once in RoLink.lua.
//  2. The inlined core equals the module core (module minus leading
//     comment block and trailing `return <Table>`).
// Plus: the Luau RigAdapter CHANNELS table matches TS DRIVE_CHANNELS.
// Run: node scripts/check_rigadapter_sync.js (exit 0 = in sync)
//      node scripts/check_rigadapter_sync.js --fix (copy module cores into
//        RoLink.lua markers; use after editing animation/*.lua)
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const PLUGIN = path.join(ROOT, "studio-plugin", "RoLink.lua");
const TS = path.join(ROOT, "mcp-server", "src", "animation", "jointAdapter.ts");

const MODULES = [
  { file: "studio-plugin/animation/RigAdapter.lua", begin: "--[[RIGADAPTER_BEGIN", end: "--[[RIGADAPTER_END]]", ret: "return RigAdapter" },
  { file: "studio-plugin/animation/Curves.lua", begin: "--[[CURVES_BEGIN", end: "--[[CURVES_END]]", ret: "return Curves" },
  { file: "studio-plugin/animation/PoseSolver.lua", begin: "--[[POSESOLVER_BEGIN", end: "--[[POSESOLVER_END]]", ret: "return PoseSolver" },
  { file: "studio-plugin/animation/IK.lua", begin: "--[[IK_BEGIN", end: "--[[IK_END]]", ret: "return IK" },
  { file: "studio-plugin/animation/Contacts.lua", begin: "--[[CONTACTS_BEGIN", end: "--[[CONTACTS_END]]", ret: "return Contacts" },
  { file: "studio-plugin/animation/Collision.lua", begin: "--[[COLLISION_BEGIN", end: "--[[COLLISION_END]]", ret: "return Collision" },
  { file: "studio-plugin/animation/Dynamics.lua", begin: "--[[DYNAMICS_BEGIN", end: "--[[DYNAMICS_END]]", ret: "return Dynamics" },
  { file: "studio-plugin/animation/AnimationLab.lua", begin: "--[[ANIMLAB_BEGIN", end: "--[[ANIMLAB_END]]", ret: "return AnimationLab" },
];

function moduleCore(mod, ret) {
  const modLines = mod.split("\n");
  let start = 0;
  while (start < modLines.length && modLines[start].startsWith("--")) start += 1;
  while (start < modLines.length && modLines[start].trim() === "") start += 1;
  let end = modLines.length;
  while (end > start && modLines[end - 1].trim() === "") end -= 1;
  if (modLines[end - 1].trim() === ret) end -= 1;
  while (end > start && modLines[end - 1].trim() === "") end -= 1;
  return modLines.slice(start, end).join("\n");
}

function inlineCore(plugin, begin, end) {
  return plugin
    .split(begin)[1]
    .split(end)[0]
    .split("\n")
    .slice(1) // drop remainder of the BEGIN marker line
    .join("\n")
    .replace(/\s+$/, "");
}

if (process.argv.includes("--fix")) {
  let plugin = fs.readFileSync(PLUGIN, "utf8");
  for (const m of MODULES) {
    const mod = fs.readFileSync(path.join(ROOT, m.file), "utf8");
    const beginIdx = plugin.indexOf(m.begin);
    const endIdx = plugin.indexOf(m.end);
    if (beginIdx < 0 || endIdx < 0 || endIdx < beginIdx) {
      console.error(`FAIL ${m.file}: markers missing or out of order`);
      process.exit(1);
    }
    const beginLineEnd = plugin.indexOf("\n", beginIdx);
    const endLineStart = plugin.lastIndexOf("\n", endIdx) + 1;
    plugin = plugin.slice(0, beginLineEnd + 1) + moduleCore(mod, m.ret) + "\n" + plugin.slice(endLineStart);
  }
  fs.writeFileSync(PLUGIN, plugin);
  console.log("OK   RoLink.lua inline sections replaced from modules");
  process.exit(0);
}

let failures = 0;
function fail(msg) {
  failures += 1;
  console.error("FAIL " + msg);
}

const plugin = fs.readFileSync(PLUGIN, "utf8");
const ts = fs.readFileSync(TS, "utf8");

for (const m of MODULES) {
  const mod = fs.readFileSync(path.join(ROOT, m.file), "utf8");
  const begins = plugin.split(m.begin).length - 1;
  const ends = plugin.split(m.end).length - 1;
  if (begins !== 1) fail(`${m.file}: BEGIN markers: expected 1, found ${begins}`);
  if (ends !== 1) fail(`${m.file}: END markers: expected 1, found ${ends}`);
  if (begins === 1 && ends === 1) {
    const inline = inlineCore(plugin, m.begin, m.end);
    const core = moduleCore(mod, m.ret).replace(/\s+$/, "");
    if (inline !== core) {
      fail(`inlined core differs from ${m.file} core`);
      const a = inline.split("\n");
      const b = core.split("\n");
      const n = Math.max(a.length, b.length);
      let shown = 0;
      for (let i = 0; i < n && shown < 10; i += 1) {
        if (a[i] !== b[i]) {
          console.error(`  line ${i + 1} inline: ${(a[i] ?? "<missing>").slice(0, 120)}`);
          console.error(`  line ${i + 1} module: ${(b[i] ?? "<missing>").slice(0, 120)}`);
          shown += 1;
        }
      }
      console.error(`  (inline ${a.length} lines, module ${b.length} lines)`);
    }
  }
}

// CHANNELS parity (Luau RigAdapter vs TS DRIVE_CHANNELS)
function parseLuauChannels(src) {
  const out = {};
  const block = src.split("CHANNELS = {")[1].split("\n  },")[0];
  for (const m of block.matchAll(/(\w+)\s*=\s*\{([^}]*)\}/g)) {
    out[m[1]] = m[2].split(",").map((s) => s.trim().replace(/^"|"$/g, "")).filter(Boolean);
  }
  return out;
}
function parseTsChannels(src) {
  const out = {};
  const block = src.split("DRIVE_CHANNELS")[1].split("};")[0];
  for (const m of block.matchAll(/(\w+):\s*\[([^\]]*)\]/g)) {
    out[m[1]] = m[2].split(",").map((s) => s.trim().replace(/^"|"$/g, "")).filter(Boolean);
  }
  return out;
}
const luau = parseLuauChannels(plugin);
const tsCh = parseTsChannels(ts);
for (const kind of Object.keys(tsCh)) {
  const a = JSON.stringify(luau[kind]);
  const b = JSON.stringify(tsCh[kind]);
  if (a !== b) fail(`channel mismatch for ${kind}: luau=${a} ts=${b}`);
}
for (const kind of Object.keys(luau)) {
  if (!(kind in tsCh)) fail(`luau-only channel kind: ${kind}`);
}

if (failures === 0) {
  console.log("OK   animation modules in sync (inline == module, CHANNELS == DRIVE_CHANNELS)");
  process.exit(0);
} else {
  process.exit(1);
}
