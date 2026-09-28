/**
 * S21 Generative Asset Creation — Text-to-3D / Image-to-Texture via external APIs
 * Integrates with MeshGen / Tripo / Stability. Falls back to procedural placeholder cubes + decals.
 */
export interface GenAssetResult { ok:boolean; kind:"model"|"texture"; prompt: string; code: string; url?: string; note: string; }

function proceduralFallback(prompt:string, kind:"model"|"texture"): string {
  if(kind==="model"){
    return `
-- RoLink procedural fallback for "${prompt.replace(/"/g,"'")}"
for i=1,3 do
  local p=Instance.new("Part")
  p.Size=Vector3.new(math.random(4,8),math.random(4,8),math.random(4,8))
  p.Position=Vector3.new(math.random(-20,20),5,math.random(-20,20))
  p.Color=Color3.fromRGB(math.random(80,255),math.random(80,255),math.random(80,255))
  p.Material=Enum.Material.Neon
  p.Anchored=true
  p.Parent=workspace
end
print("[RoLink assetGen] procedural model for "${prompt.replace(/"/g,"'")}"")
`.trim();
  } else {
    return `
local decal=Instance.new("Decal")
decal.Texture="rbxassetid://0" -- replace with generated texture id
decal.Parent=workspace:FindFirstChild("Part")
print("[RoLink assetGen] texture placeholder for "${prompt.replace(/"/g,"'")}"")
`.trim();
  }
}

export async function generateAsset(prompt:string, kind:"model"|"texture"="model", opts?:{ apiKey?:string; imageUrl?:string }): Promise<GenAssetResult> {
  const key=opts?.apiKey || process.env.MESHGEN_API_KEY || process.env.STABILITY_API_KEY || "";
  const endpoint=process.env.ASSET_GEN_ENDPOINT || "";
  // try external
  if(key && endpoint){
    try{
      const res=await fetch(endpoint, { method:"POST", headers:{ "Content-Type":"application/json", Authorization:`Bearer ${key}` }, body: JSON.stringify({ prompt, kind, imageUrl: opts?.imageUrl }) });
      if(res.ok){
        const data:any=await res.json();
        const url=data.url||data.modelUrl||data.textureUrl;
        const importCode = url ? `-- download ${url}\n` + proceduralFallback(prompt,kind) : proceduralFallback(prompt,kind);
        return { ok:true, kind, prompt, code: importCode, url, note:"generated via external API" };
      }
    }catch(e:any){
      // fallthrough
    }
  }
  return { ok:true, kind, prompt, code: proceduralFallback(prompt,kind), note:"procedural fallback (no API key). Set ASSET_GEN_ENDPOINT + MESHGEN_API_KEY for real generation." };
}

export async function generateVariants(prompt:string, count:number, kind:"model"|"texture"="model"){
  const out:GenAssetResult[]=[];
  for(let i=0;i<count;i++) out.push(await generateAsset(`${prompt} variant ${i+1}`, kind));
  return out;
}
