import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assetCategory, importInstruction, isValidAssetImportResult, searchAssets } from "../src/assetStore.js";

const fixture = {
  creatorStoreAssets: [
    {
      asset: { id: 12345678, name: "Medieval Sword", description: "Sharp", assetTypeId: 10,
        hasScripts: true, scriptCount: 2 },
      creator: { name: "Swordsmith" },
      creatorStoreProduct: { purchasePrice: { quantity: { significand: 0, exponent: 0 } } },
    },
    {
      asset: { id: 87654321, name: "Rusty Axe", description: "Old", assetTypeId: 10 },
      creator: { name: "Axeman" },
    },
  ],
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("live Creator Store asset search", () => {
  it("normalizes the v2 creatorStoreAssets response", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(fixture), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const assets = await searchAssets("medieval sword", 5, "model");
    expect(assets).toHaveLength(2);
    expect(assets[0]).toMatchObject({
      id: 12345678,
      name: "Medieval Sword",
      creator: "Swordsmith",
      assetType: "Model",
      hasScripts: true,
      scriptCount: 2,
      isFree: true,
      priceCents: 0,
    });
    expect(assets[0].url).toContain("/library/12345678/redirect");
    expect(String(fetchMock.mock.calls[0][0])).toContain("searchCategoryType=Model");
    expect(String(fetchMock.mock.calls[0][0])).toContain("query=medieval+sword");
  });

  it("maps user-friendly categories to v2 names", () => {
    expect(assetCategory("mesh")).toBe("MeshPart");
    expect(assetCategory("models")).toBe("Model");
    expect(assetCategory("tools")).toBe("Model");
    expect(assetCategory("unknown-category")).toBe("Model");
  });

  it("rejects invalid input before making a network request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(searchAssets("", 5)).rejects.toThrow("asset_search_invalid");
    await expect(searchAssets("x".repeat(65), 5)).rejects.toThrow("64 characters");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces upstream failure instead of returning mock rows", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("upstream down", { status: 503 })));
    await expect(searchAssets("sword", 3)).rejects.toThrow("asset_search_unavailable");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "rate limited" }), { status: 200 })));
    await expect(searchAssets("sword", 3)).rejects.toThrow("asset_search_unavailable");
  });

  it("returns an empty list for an empty catalog response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ creatorStoreAssets: [] }), { status: 200 })));
    await expect(searchAssets("no-such-asset", 3)).resolves.toEqual([]);
  });

  it("returns a verified terminal result from the registry import handler", async () => {
    const { tools } = await import("../src/tools/registry.js");
    const { commandQueue } = await import("../src/commandQueue.js");
    const originalEnqueue = commandQueue.enqueue;
    const originalWait = commandQueue.waitForResult;
    commandQueue.enqueue = (() => ({ id: "import-test" })) as any;
    commandQueue.waitForResult = (async () => ({
      imported: true, assetId: 123, id: 123, path: "Workspace.Imported", className: "Model", parent: "Workspace",
    })) as any;
    try {
      const handler = tools.find((tool) => tool.name === "import_asset")!.handler;
      const out = await handler({ assetId: 123, parent: "workspace" });
      expect(out.isError).toBeFalsy();
      const body = JSON.parse(out.content[0].text);
      expect(body.tool).toBe("import_asset");
      expect(body.result.path).toBe("Workspace.Imported");
    } finally {
      commandQueue.enqueue = originalEnqueue;
      commandQueue.waitForResult = originalWait;
    }
  });

  it("rejects an unverified/stale import result", async () => {
    const { tools } = await import("../src/tools/registry.js");
    const { commandQueue } = await import("../src/commandQueue.js");
    const originalEnqueue = commandQueue.enqueue;
    const originalWait = commandQueue.waitForResult;
    commandQueue.enqueue = (() => ({ id: "import-test" })) as any;
    commandQueue.waitForResult = (async () => ({ imported: 123, ok: true })) as any;
    try {
      const handler = tools.find((tool) => tool.name === "import_asset")!.handler;
      const out = await handler({ assetId: 123 });
      expect(out.isError).toBe(true);
      expect(JSON.parse(out.content[0].text).error.code).toBe("ASSET_IMPORT_INVALID");
    } finally {
      commandQueue.enqueue = originalEnqueue;
      commandQueue.waitForResult = originalWait;
    }
  });

  it("keeps the registry import handler on the verified import_asset branch", () => {
    const source = readFileSync(fileURLToPath(new URL("../src/tools/registry.ts", import.meta.url)), "utf8");
    expect(source).toContain('studioQueueAndWait("import_asset", "--import"');
    expect(source).toContain("45000");
    const importDef = source.slice(source.indexOf('{ name: "import_asset"'));
    expect(importDef.slice(0, 900)).not.toContain('studioQueueAndWait("run_code"');
  });

  it("keeps project scope and uses the terminal import branch", async () => {
    const { commandQueue } = await import("../src/commandQueue.js");
    const cmd = commandQueue.enqueue({
      tool: "import_asset", command: "--import", projectId: "project-a",
      args: { assetId: 123, parent: "workspace", projectId: "project-a" },
    });
    expect(cmd.projectId).toBe("project-a");
    commandQueue.cancel(cmd.id);
  });

  it("requires proof that an import actually parented an Instance", () => {
    expect(isValidAssetImportResult({ imported: true, assetId: 123, path: "Workspace.Sword" })).toBe(true);
    expect(isValidAssetImportResult({ imported: true, assetId: 123 })).toBe(false);
    expect(isValidAssetImportResult({ imported: false, assetId: 123, path: "Workspace.Sword" })).toBe(false);
  });

  it("rejects invented or unsafe import IDs/paths", () => {
    expect(() => importInstruction(0)).toThrow("positive Creator Store ID");
    expect(() => importInstruction(1.5)).toThrow("positive Creator Store ID");
    expect(() => importInstruction(123, 'workspace"); error("bad')).toThrow("simple Studio path");
    const code = importInstruction(123, "Workspace/RoLinkAssets");
    expect(code).toContain('local __parentPath = "Workspace/RoLinkAssets"');
    expect(code).toContain("model.Parent = __parent");
  });
});
