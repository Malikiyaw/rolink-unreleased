/**
 * S9 Templates — CRUD for reusable code/instance templates
 */
export interface Template {
  id: string;
  name: string;
  description: string;
  category: string;
  code: string;
  instances?: Array<{ className:string; name:string; parent:string; properties?:Record<string,unknown>}>;
}

const SEED: Template[] = [
  { id:"obby-3stage", name:"Obby 3-stage", description:"Spawn + 3 platforms + kill bricks", category:"gameplay", code: `for i=1,3 do local p=Instance.new("Part"); p.Size=Vector3.new(10,1,10); p.Position=Vector3.new(i*14,5,0); p.Anchored=true; p.Parent=workspace end`, instances: [] },
  { id:"leaderboard", name:"Leaderboard", description:"leaderstats with Coins/KOs", category:"systems", code: `game.Players.PlayerAdded:Connect(function(plr) local ls=Instance.new("Folder"); ls.Name="leaderstats"; ls.Parent=plr; local c=Instance.new("IntValue"); c.Name="Coins"; c.Parent=ls end)` },
  { id:"shop-remote", name:"Shop RemoteEvent", description:"ReplicatedStorage RemoteEvent + GUI", category:"systems", code: `-- RemoteEvent creation handled via instances`, instances:[{className:"RemoteEvent", name:"BuyItem", parent:"ReplicatedStorage"}] },
  { id:"health-system", name:"Health system", description:"Player health regen script", category:"systems", code: `game.Players.PlayerAdded:Connect(function(plr) plr.CharacterAdded:Connect(function(char) local hum=char:WaitForChild("Humanoid"); hum.HealthChanged:Connect(function() if hum.Health<hum.MaxHealth then task.wait(2); hum.Health=hum.MaxHealth end end) end) end)` },
];

class TemplateStore {
  private map = new Map<string, Template>(SEED.map(t=>[t.id,t]));
  list(category?: string){ const v=[...this.map.values()]; return category? v.filter(t=>t.category===category): v; }
  get(id:string){ return this.map.get(id); }
  create(t:Template){
    if(this.map.has(t.id)) throw new Error("id exists");
    this.map.set(t.id,t); return t;
  }
  remove(id:string){ return this.map.delete(id); }
}

export const templateStore = new TemplateStore();
