/**
 * S15 Roblox Library / Asset Store Integration — search + import.
 * Live search calls Roblox's current public v2 Toolbox Service endpoint.
 * NEVER fabricates results: an upstream failure throws so the caller reports
 * `asset_search_unavailable` instead of inventing asset ids. The bridge-side
 * handler (bridge.py `_local_search_asset`) produces the identical shape, so
 * the model sees one contract on both paths.
 */
export interface AssetInfo { id: number; name: string; description?: string; creator?: string; assetType?: string; url?: string; hasScripts?: boolean; scriptCount?: number; isFree?: boolean; priceCents?: number; }
export interface AssetSearchResult { assets: AssetInfo[]; source: "roblox-catalog"; keyword: string; category: string; note?: string; }

/** A terminal import must prove that an Instance was actually parented. */
export function isValidAssetImportResult(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return row.imported === true
    && typeof row.path === "string" && row.path.length > 0
    && Number.isSafeInteger(Number(row.assetId)) && Number(row.assetId) > 0;
}

const ROBLOX_SEARCH = "https://apis.roblox.com/toolbox-service/v2/assets:search";
const CATEGORY_MAP: Record<string, string> = {
  model: "Model", models: "Model", mesh: "MeshPart", meshes: "MeshPart", meshpart: "MeshPart",
  decal: "Decal", decals: "Decal", image: "Decal", images: "Decal", texture: "Decal", textures: "Decal",
  audio: "Audio", sound: "Audio", sounds: "Audio",
  plugin: "Plugin", plugins: "Plugin", video: "Video", videos: "Video",
  font: "FontFamily", fontfamily: "FontFamily", fonts: "FontFamily",
  tool: "Model", tools: "Model", gear: "Model", decoration: "Model", decorations: "Model",
};
const CATEGORY_NAMES = new Set(["Model", "MeshPart", "Decal", "Audio", "Plugin", "Video", "FontFamily"]);
const ASSET_TYPE_NAMES: Record<number, string> = { 3: "Audio", 10: "Model", 13: "Decal", 38: "Plugin", 40: "MeshPart" };

export function assetCategory(raw?: string): string {
  const s = String(raw ?? "").trim();
  if (!s) return "Model";
  const mapped = CATEGORY_MAP[s.toLowerCase()];
  if (mapped) return mapped;
  return CATEGORY_NAMES.has(s) ? s : "Model";
}

function assetRows(data: any): any[] {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return [];
  for (const key of ["creatorStoreAssets", "data", "catalogSearchResults", "results", "items"]) {
    if (Array.isArray(data[key])) return data[key];
  }
  return [];
}

export async function searchAssets(keyword: string, limit = 8, category?: string): Promise<AssetInfo[]> {
  if (typeof keyword !== "string") throw new Error("asset_search_invalid: keyword must be a string");
  const kw = keyword.trim();
  if (!kw) throw new Error("asset_search_invalid: keyword is required");
  if (kw.length > 64) throw new Error("asset_search_invalid: keyword must be 64 characters or fewer");
  const requested = Number(limit);
  const lim = Number.isFinite(requested) ? Math.max(1, Math.min(Math.floor(requested), 20)) : 8;
  const cat = assetCategory(category);
  const qs = new URLSearchParams({
    searchCategoryType: cat,
    query: kw,
    maxPageSize: String(lim),
    includeOnlyVerifiedCreators: "false",
  });
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 6000);
  let data: any;
  try {
    const res = await fetch(`${ROBLOX_SEARCH}?${qs.toString()}`, {
      headers: { Accept: "application/json", "User-Agent": "RoLink/2.5 (asset search)" },
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`catalog HTTP ${res.status}`);
    data = await res.json();
    if (data && typeof data === "object" && (data.error || data.errors)) {
      throw new Error(String(data.error || data.errors).slice(0, 160));
    }
    if (!Array.isArray(data) && (!data || typeof data !== "object")) {
      throw new Error("Roblox catalog returned a non-object JSON response");
    }
  } catch (e: any) {
    const why = e?.name === "AbortError" ? "timeout after 6s" : String(e?.message || e);
    throw new Error(`asset_search_unavailable: Roblox Creator Store search failed (${why}). Never invent asset ids.`);
  } finally {
    clearTimeout(timer);
  }
  const out: AssetInfo[] = [];
  for (const row of assetRows(data)) {
    if (!row || typeof row !== "object") continue;
    const asset = row.asset && typeof row.asset === "object" ? row.asset : row;
    const id = Number(asset.id ?? asset.ItemId ?? asset.AssetId ?? asset.assetId ?? 0);
    if (!Number.isFinite(id) || id <= 0) continue;
    const creator = row.creator && typeof row.creator === "object" ? row.creator : {};
    const creatorName = creator.name ?? row.CreatorName ?? row.creatorName
      ?? (typeof row.creator === "string" ? row.creator : "");
    const rawType = asset.assetType ?? asset.AssetType ?? asset.itemType
      ?? ASSET_TYPE_NAMES[Number(asset.assetTypeId)];
    const scriptCount = Number(asset.scriptCount);
    const hasScripts = typeof asset.hasScripts === "boolean" ? asset.hasScripts
      : (Number.isFinite(scriptCount) && scriptCount > 0 ? true : undefined);
    const quantity = row.creatorStoreProduct?.purchasePrice?.quantity;
    const priceCents = quantity && Number.isFinite(Number(quantity.significand)) && Number.isFinite(Number(quantity.exponent))
      ? Math.round(Number(quantity.significand) * (10 ** (Number(quantity.exponent) + 2))) : undefined;
    out.push({
      id,
      name: String(asset.name ?? asset.Name ?? "Asset").slice(0, 120),
      description: String(asset.description ?? asset.Description ?? "").slice(0, 400),
      creator: String(creatorName ?? "").slice(0, 80),
      assetType: String(rawType ?? cat).slice(0, 40),
      url: `https://www.roblox.com/library/${id}/redirect`,
      ...(hasScripts === undefined ? {} : { hasScripts }),
      ...(Number.isFinite(scriptCount) ? { scriptCount } : {}),
      ...(priceCents === undefined ? {} : { priceCents, isFree: priceCents === 0 }),
    });
    if (out.length >= lim) break;
  }
  return out;
}

export function importInstruction(assetId: number, parent: string="workspace"): string {
  if (!Number.isSafeInteger(assetId) || assetId <= 0) {
    throw new Error("asset_import_invalid: assetId must be a positive Creator Store ID from search_asset");
  }
  const parentPath = String(parent ?? "workspace").trim();
  if (!parentPath || parentPath.length > 200 || !/^[\w\s./%\-[\]]+$/.test(parentPath)) {
    throw new Error("asset_import_invalid: parent must be a simple Studio path (letters, numbers, spaces, / . _ - [ ])");
  }
  const parentLiteral = JSON.stringify(parentPath);
  // Luau that plugin will execute to import via InsertService. Resolve common
  // slash/dot Studio paths in the generated code rather than interpolating a
  // path as Luau source (which made `Workspace/Assets` fail or become code).
  return `
local InsertService = game:GetService("InsertService")
local __parentPath = ${parentLiteral}
local __parent = workspace
if __parentPath ~= "workspace" and __parentPath ~= "Workspace" then
  local __cur = game
  for __part in string.gmatch(string.gsub(__parentPath, "%.", "/"), "[^/]+") do
    if __part == "game" and __cur == game then
      continue
    elseif (__part == "workspace" or __part == "Workspace") and __cur == game then
      __cur = workspace
    elseif __cur == game then
      local __ok, __service = pcall(function() return game:GetService(__part) end)
      __cur = __ok and __service or __cur:FindFirstChild(__part)
    else
      __cur = __cur:FindFirstChild(__part)
    end
    if not __cur then error("parent not found: " .. __parentPath) end
  end
  __parent = __cur
end
local __assetId = ${assetId}
local ok, model = pcall(function() return game:GetObjects("rbxassetid://" .. __assetId)[1] end)
if not ok or not model then
  ok, model = pcall(function() return InsertService:LoadAsset(__assetId):GetChildren()[1] end)
end
if model then
  local __removedScripts = 0
  local __toStrip = {}
  if model:IsA("LuaSourceContainer") or model:IsA("PackageLink") then table.insert(__toStrip, model) end
  for _, d in ipairs(model:GetDescendants()) do
    if d:IsA("LuaSourceContainer") or d:IsA("PackageLink") then table.insert(__toStrip, d) end
  end
  for _, source in ipairs(__toStrip) do
    if source.Parent then source:Destroy(); __removedScripts += 1 end
  end
  if model:IsA("LuaSourceContainer") or model:IsA("PackageLink") then
    error("import contained an executable root and was not inserted")
  end
  model.Parent = __parent
  print("[RoLink] imported " .. __assetId .. " -> " .. __parentPath .. ": " .. model:GetFullName())
  return {imported = true, assetId = __assetId, id = __assetId, path = model:GetFullName(),
    className = model.ClassName, parent = __parent:GetFullName(),
    scriptsStripped = __removedScripts > 0, removedScripts = __removedScripts}
else
  error("import failed for asset " .. __assetId)
end
`.trim();
}
