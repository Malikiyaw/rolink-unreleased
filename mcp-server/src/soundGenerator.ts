// S48 — Procedural audio asset generator.
// Produces deterministic metadata (duration, sample rate, suggested SoundId
// placeholder, parametric descriptor) for an AI-generated Sound without
// requiring an external API. The actual `.ogg` byte generation is out of
// scope (the tool description already says "procedural, no key" — this
// module provides the metadata the model can use to script a procedural
// Sound via a ModuleScript, e.g. via Roblox's Audio API + DoSound).

export type SoundType = "sfx" | "music" | "voice";

export interface SoundSpec {
  id: string;
  prompt: string;
  type: SoundType;
  path: string;
  durationSec: number;
  sampleRate: number;
  channels: 1 | 2;
  format: "ogg" | "wav";
  seed: number;
  envelope: { attack: number; sustain: number; release: number };
  suggestedProperties: Record<string, number | string | boolean>;
  proceduralSource: string;
  notes: string[];
}

const TYPE_DEFAULTS: Record<SoundType, Partial<SoundSpec>> = {
  sfx: { durationSec: 0.6, sampleRate: 44100, channels: 1, format: "ogg", envelope: { attack: 0.01, sustain: 0.2, release: 0.4 } },
  music: { durationSec: 8.0, sampleRate: 44100, channels: 2, format: "ogg", envelope: { attack: 0.1, sustain: 6.0, release: 1.9 } },
  voice: { durationSec: 1.5, sampleRate: 22050, channels: 1, format: "wav", envelope: { attack: 0.02, sustain: 1.2, release: 0.28 } }
};

function seedOf(prompt: string): number {
  let h = 2166136261;
  for (let i = 0; i < prompt.length; i++) { h ^= prompt.charCodeAt(i); h = Math.imul(h, 16777619); }
  return Math.abs(h) | 1;
}

function propertiesFor(type: SoundType): Record<string, number | string | boolean> {
  switch (type) {
    case "sfx":   return { Volume: 0.8, PlaybackSpeed: 1, Looped: false, RollOffMaxDistance: 80 };
    case "music": return { Volume: 0.5, PlaybackSpeed: 1, Looped: true,  RollOffMaxDistance: 60 };
    case "voice": return { Volume: 1.0, PlaybackSpeed: 1, Looped: false, RollOffMaxDistance: 40 };
  }
}

function proceduralSource(prompt: string, type: SoundType, seed: number): string {
  // Returns a snippet the AI can drop into a ModuleScript to procedurally
  // produce this sound at runtime using Roblox APIs. This is intentionally
  // compact so it fits in a tool result.
  return `-- S48 procedural source for "${prompt}" (seed=${seed}, type=${type})
local SoundService = game:GetService("SoundService")
local s = Instance.new("Sound")
s.Name = ${JSON.stringify(safe(prompt))}
s.SoundId = "rbxassetid://0" -- placeholder; replace with uploaded assetId
s.Volume = ${type === "sfx" ? 0.8 : type === "music" ? 0.5 : 1.0}
s.Looped = ${type === "music" ? "true" : "false"}
s.Parent = SoundService
-- Hint: drive playback from gameplay events; see RoLink docs/S48.`;
}

function safe(s: string): string { return String(s).replace(/[^A-Za-z0-9_]/g, "_").slice(0, 48); }

export async function generate_sound(prompt: string, type: SoundType = "sfx"): Promise<SoundSpec> {
  const d = TYPE_DEFAULTS[type] || TYPE_DEFAULTS.sfx;
  const seed = seedOf(prompt || "untitled");
  const path = `Assets/Audio/${safe(prompt || "sound")}_${seed.toString(36)}.${d.format}`;
  return {
    id: `snd_${seed.toString(36)}`,
    prompt,
    type,
    path,
    durationSec: d.durationSec!,
    sampleRate: d.sampleRate!,
    channels: d.channels! as 1 | 2,
    format: d.format! as "ogg" | "wav",
    seed,
    envelope: d.envelope!,
    suggestedProperties: propertiesFor(type),
    proceduralSource: proceduralSource(prompt, type, seed),
    notes: [
      "Procedural — no API key required.",
      `Seed ${seed} is deterministic; same prompt yields same path/seed.`,
      type === "voice" ? "Voice mode: 22.05 kHz mono, suitable for short barks." : "Replace rbxassetid://0 with an uploaded assetId before shipping."
    ]
  };
}

export async function generate_sound_pack(prompt: string, count = 3, type: SoundType = "sfx") {
  const n = Math.max(1, Math.min(16, count | 0));
  const items: SoundSpec[] = [];
  for (let i = 0; i < n; i++) {
    const variant = `${prompt} #${i + 1}`;
    const seed = seedOf(variant);
    const d = TYPE_DEFAULTS[type] || TYPE_DEFAULTS.sfx;
    items.push({
      id: `snd_${seed.toString(36)}`,
      prompt: variant,
      type,
      path: `Assets/Audio/${safe(variant)}_${seed.toString(36)}.${d.format}`,
      durationSec: d.durationSec!,
      sampleRate: d.sampleRate!,
      channels: d.channels! as 1 | 2,
      format: d.format! as "ogg" | "wav",
      seed,
      envelope: d.envelope!,
      suggestedProperties: propertiesFor(type),
      proceduralSource: proceduralSource(variant, type, seed),
      notes: [`Pack item ${i + 1}/${n}.`]
    });
  }
  return { count: items.length, items };
}
