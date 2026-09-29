/**
 * S16 Real-Time Gameplay Feedback Loop — metrics collection and optimization triggers
 * Plugin reports Player stats; server aggregates and triggers hooks.
 */
export interface GameplayMetrics { projectId: string; timestamp: number; deathsPerMinute?: number; killDeathRatio?: number; avgFPS?: number; completionTimeSec?: number; coinsPerMin?: number; activePlayers?: number; custom?: Record<string,number>; }

class GameplayFeedback {
  private store: GameplayMetrics[]=[];
  private max=300;
  private thresholds: Record<string, { min?:number; max?:number; action:string }> = {
    deathsPerMinute: { max: 8, action: "reduce difficulty — high death rate" },
    avgFPS: { min: 45, action: "optimize parts — FPS low" },
    killDeathRatio: { min: 0.3, max: 3, action: "balance combat" },
  };

  ingest(m: GameplayMetrics){
    this.store.push({ ...m, timestamp: Date.now() });
    if(this.store.length>this.max) this.store.shift();
    return this.evaluate(m);
  }
  evaluate(m: GameplayMetrics){
    const triggers:string[]=[];
    for(const k of Object.keys(this.thresholds)){
      const v=(m as any)[k]; if(typeof v!=="number") continue;
      const t=this.thresholds[k];
      if(t.max!==undefined && v>t.max) triggers.push(`${k}=${v} > max ${t.max}: ${t.action}`);
      if(t.min!==undefined && v<t.min) triggers.push(`${k}=${v} < min ${t.min}: ${t.action}`);
    }
    // FPS low triggers S22
    if(triggers.some(t=>t.includes("FPS"))) triggers.push("trigger S22 perfOptLoop");
    return { triggers, metrics:m };
  }
  recent(projectId:string, limit=20){ return this.store.filter(s=>s.projectId===projectId).slice(-limit).reverse(); }
  avg(projectId:string, field: keyof GameplayMetrics, limit=20){
    const r=this.recent(projectId, limit); const vals=r.map(x=> (x[field] as number)).filter(v=>typeof v==="number"); if(!vals.length) return 0; return vals.reduce((a,b)=>a+b,0)/vals.length;
  }
}

export const gameplayFeedback = new GameplayFeedback();
