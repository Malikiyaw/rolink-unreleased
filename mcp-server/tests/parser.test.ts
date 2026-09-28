import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tools } from "../src/tools/registry.js";

// parser.js is intentionally a classic content-script IIFE (it is loaded by
// manifest.json, not as an ES module). Load it the same way the extension's
// Node smoke tests do instead of asking Vitest for a nonexistent ESM default.
const parserSource = readFileSync(
  fileURLToPath(new URL("../../rolink-extension/core/parser.js", import.meta.url)),
  "utf8",
);
const parse = new Function(`${parserSource}; return RLParse;`)() as typeof import("../../rolink-extension/core/parser.js");
const first = (text: string) => parse.parseToolCalls(text)[0] ?? null;

describe("RoLink tool parser", () => {
  it("parses a normal MCP JSON command", () => {
    const result = first(`###MCP_TOOL###\n{"tool":"get_instances","args":{"path":"workspace"}}`);
    expect(result).toMatchObject({ tool: "get_instances", arguments: { path: "workspace" } });
  });

  it("accepts raw source blocks with quotes, braces, and newlines", () => {
    const result = first(`###MCP_TOOL###\n{"tool":"set_script_content","args":{"path":"Workspace/Script"}}\n###RAW:content###\nlocal p = Instance.new("Part")\np.Name = "Hello"\n###END_RAW###`);
    expect(result).toMatchObject({
      tool: "set_script_content",
      arguments: { path: "Workspace/Script", content: 'local p = Instance.new("Part")\np.Name = "Hello"' },
      rawFields: { content: 'local p = Instance.new("Part")\np.Name = "Hello"' },
    });
  });

  it("infers the field for a generic RAW marker", () => {
    const result = first(`###MCP_TOOL###\n{"tool":"create_module","args":{"path":"ReplicatedStorage/M"}}\n###RAW###\nreturn {}\n###END_RAW###\n###END_MCP_TOOL###`);
    expect(result?.arguments.exports).toBe("return {}");
    const incomplete = first(`###MCP_TOOL###\n{"tool":"set_script_content","args":{"path":"Workspace/Script"}}\n###RAW:content###\nreturn 1`);
    expect(incomplete?.rawError).toContain("END_RAW");
  });

  it("salvages a cut-off object only when the string is complete", () => {
    const result = parse.salvageCutOff(`{"tool":"create_instance","args":{"className":"Part","name":"Crate"}`);
    expect(result).toMatchObject({ tool: "create_instance", arguments: { className: "Part", name: "Crate" } });

    const truncated = parse.salvageCutOff(`{"tool":"execute_luau","args":{"code":"print("still typing`);
    expect(truncated).toBeNull();
  });

  it("rejects a JSON Luau block with no closing marker", () => {
    const result = first('{"tool":"execute_luau","args":{"code":"###LUA###\\nreturn 1"}}');
    expect(result?.parseError).toContain("END_LUA");
  });

  it("supports command/params and legacy tool/arguments shapes", () => {
    expect(first('```json\n{"command":"get_instances","params":{"path":"workspace"}}\n```')).toMatchObject({
      tool: "get_instances", arguments: { path: "workspace" },
    });
    expect(first('{"tool":"find_instance","args":{"query":"SpawnLocation"}}')).toMatchObject({
      tool: "find_instance", arguments: { query: "SpawnLocation" },
    });
  });

  it("does not regress the full tool catalog", () => {
    expect(tools.length).toBeGreaterThanOrEqual(140);
    for (const tool of tools) {
      const fixture = `###MCP_TOOL###\n${JSON.stringify({ tool: tool.name, args: {} })}\n###END_MCP_TOOL###`;
      const result = first(fixture);
      expect(result?.tool, `failed parsing ${tool.name}`).toBe(tool.name);
    }
  });

  it("keeps the parser's RAW contract in the shipped source", () => {
    expect(parserSource).toContain("attachRawFields");
    expect(parserSource).toContain("###\\s*RAW");
    const manifest = readFileSync(
      fileURLToPath(new URL("../../rolink-extension/manifest.json", import.meta.url)),
      "utf8",
    );
    expect(manifest).toContain("core/code-fields.js");
    const parserPositions = [...manifest.matchAll(/"core\/parser\.js"/g)].map((m) => m.index ?? -1);
    const fieldPositions = [...manifest.matchAll(/"core\/code-fields\.js"/g)].map((m) => m.index ?? -1);
    expect(fieldPositions.length).toBe(parserPositions.length);
    for (let i = 0; i < parserPositions.length; i += 1) {
      expect(fieldPositions[i]).toBeLessThan(parserPositions[i]);
    }
  });
});
