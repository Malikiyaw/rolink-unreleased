/**
 * S19 Natural Language → Game Design Document → Implementation
 * Generates GDD JSON plus executable plan steps.
 */
import { planFromPrompt } from "./planning.js";
export interface GDD { title:string; genre:string; coreLoop:string; mechanics:string[]; objectives:string[]; monetization?:string; mermaid:string; plan: ReturnType<typeof planFromPrompt>; }

function inferGenre(prompt:string){
  const p=prompt.toLowerCase();
  if(p.includes("obby")||p.includes("parkour")) return "Obby / Platformer";
  if(p.includes("tycoon")) return "Tycoon";
  if(p.includes("simulator")) return "Simulator";
  if(p.includes("horror")) return "Horror";
  if(p.includes("rpg")||p.includes("quest")) return "RPG";
  return "Casual";
}

export function generateGDD(prompt:string): GDD {
  const plan=planFromPrompt(prompt);
  const genre=inferGenre(prompt);
  const mechanics=plan.steps.map(s=>s.title);
  const lower=prompt.toLowerCase();
  const objectives=[
    `Implement core: ${plan.steps[0]?.title||"base"}`,
    lower.includes("collect") ? "Collect coins with leaderstats" : "Complete level",
    lower.includes("shop") ? "Buy upgrades via RemoteEvent" : "Reach finish"
  ];
  const mermaid=[
    "graph LR",
    "  A[Player Start] --> B[Core Loop]",
    "  B --> C[Challenge]",
    "  C --> D[Reward]",
    "  D --> B",
    "  C --> E[Fail -> Retry]",
  ].join("\n");
  return {
    title: prompt.slice(0,60)||"RoLink Game",
    genre,
    coreLoop: "Play → Challenge → Reward → Progress",
    mechanics,
    objectives,
    monetization: lower.includes("shop")||lower.includes("buy") ? "Coins + Gamepasses" : "None yet",
    mermaid,
    plan,
  };
}
