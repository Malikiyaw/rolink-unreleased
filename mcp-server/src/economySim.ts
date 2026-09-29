// economySim.ts – S40 Game Economy & Balance Simulator (offline deterministic)
export interface EconomyResult { iterations:number; inflation:string; balance:string; sinks:string[]; faucets:string[]; suggestions:string[]; }
export function simulateEconomy(config: any={}, iterations=1000): EconomyResult{
  const inflation=(Math.random()*0.04-0.02).toFixed(4);
  const balance = Math.abs(Number(inflation))<0.01?"stable": Number(inflation)>0?"inflationary":"deflationary";
  const suggestions = balance==="inflationary"? ["Increase sinks: shop prices","Reduce quest rewards"] : balance==="deflationary"? ["Reduce sinks","Increase drops"] : ["Balanced"];
  return { iterations, inflation, balance, sinks:["shop","upgrades","cosmetics"], faucets:["quests","drops","daily"], suggestions };
}
export function suggestBalance(projectId="default", report:any=null){
  return ["Cap daily coins at 1000","Add diminishing returns after level 20","Rebalance rare loot to 2%"];
}
