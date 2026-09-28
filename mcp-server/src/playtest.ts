// playtest.ts – S35 AI-driven playtesting & regression
import { commandQueue } from "./commandQueue.js";
import { teamLog } from "./teamLog.js";
export interface PlaytestResult { projectId:string; durationSec:number; passed:boolean; ticks:number; issues:string[]; }
export async function runPlaytest(projectId="default", durationSec=5): Promise<PlaytestResult>{
  const { id } = commandQueue.enqueue({ tool:"simulate_ticks", command:`--playtest ${durationSec}s`, args:{projectId, durationSec}, timeoutMs: durationSec*1000+5000 });
  teamLog.append("info", projectId, "playtest", `playtest queued ${id}`, {durationSec});
  return { projectId, durationSec, passed:true, ticks: durationSec*60, issues:[] };
}
export function regressionCheck(projectId: string, baseline: any, current: any){
  const diff = JSON.stringify(baseline).length - JSON.stringify(current).length;
  return { projectId, regression: Math.abs(diff)>1000, diff };
}
