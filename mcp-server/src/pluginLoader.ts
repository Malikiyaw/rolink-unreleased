// pluginLoader.ts – S25 Modular Plugin System
import { validateLuau } from "./sandbox.js";
export interface Plugin { name:string; code?:string; loaded:boolean; enabled:boolean; }
const plugins = new Map<string, Plugin>([["rolink-core",{name:"rolink-core", loaded:true, enabled:true}],["selfHeal",{name:"selfHeal", loaded:true, enabled:true}],["perfTracker",{name:"perfTracker", loaded:true, enabled:true}]]);
export function listPlugins(){ return [...plugins.values()]; }
export function loadPlugin(name: string, code?: string){
  if(code){ const v=validateLuau(code); if(!v.ok) throw new Error(`Invalid Luau: ${v.errors.join(", ")}`); }
  const p: Plugin={name, code, loaded:true, enabled:true};
  plugins.set(name, p);
  return p;
}
export function unloadPlugin(name:string){ return plugins.delete(name); }
