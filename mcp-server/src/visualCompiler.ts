/**
 * S11 Visual Scripting to Luau Compiler — compiles node-graph JSON to Luau
 */
export interface VisualNode { id: string; type: string; data?: Record<string, unknown>; }
export interface VisualEdge { from: string; to: string; fromPort?: string; toPort?: string; }
export interface NodeGraph { nodes: VisualNode[]; edges: VisualEdge[]; variables?: Record<string, unknown>; }

function escStr(s: string): string { return JSON.stringify(String(s)); }

function compileNode(n: VisualNode): string {
  const d: any = n.data || {};
  switch (n.type) {
    case 'onPlayerJoin': return 'game.Players.PlayerAdded:Connect(function(' + (d.param || 'player') + ')';
    case 'onTouched': return (d.part || 'script.Parent') + '.Touched:Connect(function(' + (d.param || 'hit') + ')';
    case 'spawnPart': {
      const v = d.var || 'part';
      return 'local ' + v + ' = Instance.new("Part"); ' + v + '.Size = Vector3.new(' + (d.sizeX || 4) + ',' + (d.sizeY || 1) + ',' + (d.sizeZ || 4) + '); ' + v + '.Position = Vector3.new(' + (d.x || 0) + ',' + (d.y || 5) + ',' + (d.z || 0) + '); ' + v + '.Anchored = true; ' + v + '.Parent = workspace';
    }
    case 'setProperty': {
      const val = typeof d.value === 'string' ? escStr(d.value) : String(d.value ?? 'nil');
      return (d.target || 'part') + '.' + (d.prop || 'Name') + ' = ' + val;
    }
    case 'ifCondition': return 'if ' + (d.condition || d.CONDITION || 'true') + ' then';
    case 'loop': return 'for ' + (d.var || 'i') + '=1,' + (d.count || 5) + ' do';
    case 'print': return 'print(' + escStr(String(d.msg || 'hello')) + ')';
    case 'wait': return 'task.wait(' + (d.seconds || 1) + ')';
    case 'killPlayer': return 'local hum = ' + (d.target || 'hit') + '.Parent:FindFirstChild("Humanoid"); if hum then hum.Health = 0 end';
    case 'giveCoins': return 'local ls = ' + (d.player || 'player') + ':FindFirstChild("leaderstats"); if ls then local c = ls:FindFirstChild("Coins"); if c then c.Value += ' + (d.amount || 10) + ' end end';
    case 'callFunction': return (d.func || 'myFunc') + '(' + (d.args || '') + ')';
    case 'endBlock': return 'end';
    default: return '-- unknown node ' + n.type + ' ' + n.id;
  }
}

function topoSort(nodes: VisualNode[], edges: VisualEdge[]): VisualNode[] {
  const map = new Map(nodes.map(n => [n.id, n] as const));
  const adj = new Map<string, string[]>();
  const indeg = new Map<string, number>();
  for (const n of nodes) indeg.set(n.id, 0);
  for (const e of edges) { adj.set(e.from, [...(adj.get(e.from) || []), e.to]); indeg.set(e.to, (indeg.get(e.to) || 0) + 1); }
  const q = nodes.filter(n => (indeg.get(n.id) || 0) === 0).map(n => n.id);
  const order: string[] = [];
  while (q.length) { const u = q.shift()!; order.push(u); for (const v of adj.get(u) || []) { indeg.set(v, indeg.get(v)! - 1); if (indeg.get(v) === 0) q.push(v); } }
  for (const n of nodes) if (!order.includes(n.id)) order.push(n.id);
  return order.map(id => map.get(id)!).filter(Boolean);
}

export function compileGraph(graph: NodeGraph): { luau: string; warnings: string[] } {
  const warnings: string[] = [];
  if (!graph.nodes.length) return { luau: '-- empty graph', warnings: ['no nodes'] };
  const sorted = topoSort(graph.nodes, graph.edges);
  const lines: string[] = [];
  let indent = 0;
  const blockOpens = new Set(['onPlayerJoin', 'onTouched', 'ifCondition', 'loop']);
  for (const n of sorted) {
    if (n.type === 'endBlock') { indent = Math.max(0, indent - 1); lines.push('  '.repeat(indent) + compileNode(n)); continue; }
    lines.push('  '.repeat(indent) + compileNode(n));
    if (blockOpens.has(n.type)) indent++;
  }
  while (indent > 0) { indent--; lines.push('  '.repeat(indent) + 'end'); }
  const luau = lines.join('\n');
  if (luau.length > 50000) warnings.push('output >50k');
  return { luau, warnings };
}

export function graphFromPrompt(prompt: string): NodeGraph {
  const lower = prompt.toLowerCase();
  if (lower.includes('obby') || lower.includes('obstacle')) {
    return {
      nodes: [
        { id: '1', type: 'onPlayerJoin', data: { param: 'player' } },
        { id: '2', type: 'print', data: { msg: 'welcome to obby' } },
        { id: '3', type: 'loop', data: { var: 'i', count: 5 } },
        { id: '4', type: 'spawnPart', data: { var: 'p', sizeX: 6, sizeY: 1, sizeZ: 6, x: 'i*10', y: 5, z: 0 } },
        { id: '5', type: 'endBlock' },
        { id: '6', type: 'endBlock' },
      ],
      edges: [{ from: '1', to: '2' }, { from: '2', to: '3' }, { from: '3', to: '4' }, { from: '4', to: '5' }, { from: '5', to: '6' }],
    };
  }
  return { nodes: [{ id: '1', type: 'print', data: { msg: prompt.slice(0, 80) } }], edges: [] };
}
