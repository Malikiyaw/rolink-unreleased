/**
 * S23 Player Behavior Analytics & Design Suggestions
 * Aggregates S16 metrics + snapshots to produce design recommendations.
 */
import { gameplayFeedback } from "./gameplayFeedback.js";
export interface Suggestion { id:string; title:string; reason:string; actionCode?:string; priority:"low"|"medium"|"high"; }

class AnalyticsEngine {
  suggest(projectId:string): Suggestion[] {
    const s: Suggestion[]=[];
    const avgDeaths=gameplayFeedback.avg(projectId,"deathsPerMinute",20);
    const avgFPS=gameplayFeedback.avg(projectId,"avgFPS",20);
    const avgCoins=gameplayFeedback.avg(projectId,"coinsPerMin",20);
    if(avgDeaths>6) s.push({ id:"s-deaths", title:"Reduce spike density", reason:`Deaths/min ${avgDeaths.toFixed(1)} >6`, actionCode:`-- remove every other kill brick\nfor _,v in ipairs(workspace:GetChildren()) do if v.Name:find("Kill") and math.random()<0.5 then v:Destroy() end end`, priority:"high" });
    if(avgFPS>0 && avgFPS<48) s.push({ id:"s-fps", title:"Optimize part count", reason:`FPS ${avgFPS.toFixed(0)} low`, actionCode:`-- stream/cull\nworkspace.StreamingEnabled=true`, priority:"high" });
    if(avgCoins>0 && avgCoins<5) s.push({ id:"s-coins", title:"Increase coin spawn", reason:`Coins/min ${avgCoins.toFixed(1)} low`, actionCode:`local r=ReplicatedStorage:FindFirstChild("CoinSpawner"); if r then r.Value+=2 end`, priority:"medium" });
    if(s.length===0) s.push({ id:"s-ok", title:"Retention looks healthy", reason:"No threshold breach", priority:"low" });
    return s;
  }
  report(projectId:string){
    const recent=gameplayFeedback.recent(projectId,10);
    return { projectId, recentCount: recent.length, avgDeaths: gameplayFeedback.avg(projectId,"deathsPerMinute"), avgFPS: gameplayFeedback.avg(projectId,"avgFPS"), suggestions: this.suggest(projectId) };
  }
}

export const analyticsEngine = new AnalyticsEngine();
