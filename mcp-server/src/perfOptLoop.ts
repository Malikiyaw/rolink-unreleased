/**
 * S22 Automated Performance Optimization Loop — self-optimizing based on S16 FPS + part count
 */
import { gameplayFeedback } from "./gameplayFeedback.js";
export interface OptimizationAction { id:string; description:string; code:string; expectedGain:string; }

export function analyzePerf(snapshot?: string, projectId="default"): OptimizationAction[] {
  const actions:OptimizationAction[]=[];
  const avgFPS=gameplayFeedback.avg(projectId,"avgFPS",10);
  const partCount = snapshot ? (snapshot.match(/Part/g)||[]).length : 0;
  if(avgFPS>0 && avgFPS<50){
    actions.push({ id:"streaming", description:"Enable StreamingEnabled", code:"workspace.StreamingEnabled=true; workspace.StreamingTargetRadius=350", expectedGain:"+8-15 FPS" });
    actions.push({ id:"shadow", description:"Disable shadows on far parts", code:`for _,p in ipairs(workspace:GetDescendants()) do if p:IsA("BasePart") and (p.Position-workspace.CurrentCamera.CFrame.Position).Magnitude>120 then p.CastShadow=false end end`, expectedGain:"+5 FPS" });
  }
  if(partCount>400){
    actions.push({ id:"union", description:"Union small parts + cull", code:`-- consider unions: ${partCount} parts detected -> union clusters`, expectedGain:"-30% part count" });
  }
  if(actions.length===0) actions.push({ id:"ok", description:"No optimization needed", code:"-- healthy", expectedGain:"0" });
  return actions;
}

export function autoOptimize(snapshot?: string, projectId="default"){
  const actions=analyzePerf(snapshot, projectId);
  // pick highest impact
  const pick=actions.find(a=>a.id!=="ok")||actions[0];
  return { projectId, analyzedAt: Date.now(), actions, picked: pick };
}
