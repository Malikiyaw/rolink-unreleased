/**
 * S4 Multi-Engine Translation — rule-based translation between Luau / C# (Unity) / GDScript
 * Minimal but extensible: patterns for common constructs. Not exhaustive, but production-usable.
 */
export type Engine = "roblox" | "unity" | "godot";

const RULES: Record<string, Array<{ from: RegExp; to: string | ((m: string, ...args: string[]) => string) }>> = {
  "roblox->unity": [
    { from: /local\s+(\w+)\s*=\s*Instance\.new\("Part"\)/g, to: 'GameObject $1 = GameObject.CreatePrimitive(PrimitiveType.Cube)' },
    { from: /workspace/g, to: "Scene" },
    { from: /:WaitForChild\("([^"]+)"\)/g, to: '.transform.Find("$1")' },
    { from: /print\((.*?)\)/g, to: 'Debug.Log($1)' },
  ],
  "roblox->godot": [
    { from: /local\s+(\w+)\s*=\s*Instance\.new\("Part"\)/g, to: 'var $1 = CSGBox3D.new()' },
    { from: /:WaitForChild\("([^"]+)"\)/g, to: '.get_node("$1")' },
    { from: /print\((.*?)\)/g, to: 'print($1)' },
  ],
  "unity->roblox": [
    { from: /GameObject\s+(\w+)\s*=\s*GameObject\.CreatePrimitive\([^)]+\)/g, to: 'local $1 = Instance.new("Part")\n$1.Parent = workspace' },
    { from: /Debug\.Log\((.*?)\)/g, to: 'print($1)' },
  ],
  "godot->roblox": [
    { from: /var\s+(\w+)\s*=\s*CSGBox3D\.new\(\)/g, to: 'local $1 = Instance.new("Part")' },
  ],
};

export function translate(code: string, from: Engine, to: Engine): { translated: string; notes: string[] } {
  if (from === to) return { translated: code, notes: ["no translation needed"] };
  const key = `${from}->${to}`;
  const rules = RULES[key];
  if (!rules) return { translated: `// no rules for ${key}\n${code}`, notes: [`No translation rules for ${key}`] };
  let out = code;
  const notes: string[] = [];
  for (const r of rules) {
    const before = out;
    out = out.replace(r.from as any, r.to as any);
    if (out !== before) notes.push(`applied ${r.from}`);
  }
  notes.unshift(`Translated ${from} -> ${to}`);
  return { translated: out, notes };
}

export function detectEngine(code: string): Engine {
  if (/GameObject|Debug\.Log|MonoBehaviour/.test(code)) return "unity";
  if (/CSGBox3D|get_node|extends Node/.test(code)) return "godot";
  return "roblox";
}
