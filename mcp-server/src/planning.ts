/**
 * S6 Planning — breaks natural language prompt into ordered steps (project plan)
 */
export interface PlanStep {
  id: string;
  title: string;
  tool: string;
  args: Record<string, unknown>;
  codePreview?: string;
  dependsOn?: string[];
}

export interface Plan {
  title: string;
  overview: string;
  steps: PlanStep[];
  mermaid: string;
}

const STEP_TEMPLATES: Array<{ test: RegExp; gen: (prompt: string) => PlanStep[] }> = [
  {
    test: /leaderboard|points|score/i,
    gen: () => [
      { id:"s1", title:"Create leaderboard", tool:"run_code", args:{}, codePreview:'local lb = Instance.new("Folder", game.Players)\nlb.Name="leaderstats"' },
      { id:"s2", title:"Hook PlayerAdded for scores", tool:"run_code", args:{}, codePreview:'game.Players.PlayerAdded:Connect(function(plr) local s=Instance.new("IntValue"); s.Name="Points"; s.Parent=plr:FindFirstChild("leaderstats") end)' },
    ]
  },
  {
    test: /obstacle|obby|parkour/i,
    gen: () => [
      { id:"s1", title:"Create baseplate path", tool:"create_instance", args:{className:"Part", parent:"workspace", name:"StartPlatform", properties:{Size:{x:20,y:2,z:20}}} },
      { id:"s2", title:"Spawn obstacles (5 parts)", tool:"run_code", args:{}, codePreview:'for i=1,5 do local p=Instance.new("Part"); p.Size=Vector3.new(4,2,4); p.Position=Vector3.new(i*12,5,0); p.Parent=workspace end' },
      { id:"s3", title:"Add kill script", tool:"run_code", args:{}, codePreview:'-- touch to kill: script.Parent.Touched:Connect(function(hit) if hit.Parent:FindFirstChild("Humanoid") then hit.Parent.Humanoid.Health=0 end end)' },
    ]
  },
  {
    test: /shop|buy|purchase/i,
    gen: () => [
      { id:"s1", title:"Create shop GUI", tool:"create_instance", args:{className:"ScreenGui", parent:"StarterGui", name:"ShopGui"} },
      { id:"s2", title:"Add buy RemoteEvent", tool:"create_instance", args:{className:"RemoteEvent", parent:"ReplicatedStorage", name:"BuyItem"} },
    ]
  },
];

export function planFromPrompt(prompt: string): Plan {
  const lower = prompt.toLowerCase();
  let steps: PlanStep[] = [];
  for (const t of STEP_TEMPLATES) if (t.test.test(prompt)) steps = steps.concat(t.gen(prompt));
  if (steps.length === 0) {
    // generic fallback
    steps = [
      { id:"s1", title:"Create base instances", tool:"get_snapshot", args:{maxDepth:2} },
      { id:"s2", title:"Generate core script", tool:"run_code", args:{}, codePreview:`-- TODO: implement "${prompt.slice(0,120)}"\nprint("RoLink plan for: ${prompt.slice(0,40)}")` },
      { id:"s3", title:"Verify via snapshot", tool:"get_snapshot", args:{} },
    ];
  }
  // dedup ids
  steps = steps.map((s,i)=> ({ ...s, id: `step-${i+1}` }));
  for(let i=1;i<steps.length;i++) steps[i].dependsOn = [steps[i-1].id];

  const mermaid = [
    "graph TD",
    ...steps.map(s=> `  ${s.id}["${s.title} (${s.tool})"]`),
    ...steps.slice(1).map((s,i)=> `  step-${i+1} --> step-${i+2}`)
  ].join("\n");

  return {
    title: prompt.slice(0,60) || "Untitled plan",
    overview: `Plan for: ${prompt}`,
    steps,
    mermaid,
  };
}
