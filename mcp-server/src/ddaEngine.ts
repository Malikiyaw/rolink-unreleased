// S45 — Dynamic Difficulty Adjustment (DDA).
// Windowed metric-based controller: keeps a rolling window of gameplay
// metrics, computes a "frustration index" and nudges spawn/damage/health/
// loot rates within bounded ranges. Deterministic, offline, no external
// dependency. All adjustments are clamped so the AI can never accidentally
// request a degenerate game.

export type DifficultyProfile = "easy" | "medium" | "hard" | "adaptive";
export interface DifficultyMultipliers {
  enemySpawnRate: number;
  damageMultiplier: number;
  healthMultiplier: number;
  lootDropRate: number;
  xpMultiplier: number;
}
export interface AdjustResult extends DifficultyMultipliers {
  profile: DifficultyProfile;
  frustrationIndex: number;
  recentSamples: number;
  applied: boolean;
  note?: string;
}

let profile: DifficultyProfile = "adaptive";
const SAMPLE_WINDOW = 20;
let buffer: number[] = [];

const CLAMPS: Record<keyof DifficultyMultipliers, [number, number]> = {
  enemySpawnRate: [0.5, 2.0],
  damageMultiplier: [0.5, 2.0],
  healthMultiplier: [0.6, 1.8],
  lootDropRate: [0.5, 2.0],
  xpMultiplier: [0.5, 2.0]
};

const DEFAULTS: DifficultyMultipliers = {
  enemySpawnRate: 1.0,
  damageMultiplier: 1.0,
  healthMultiplier: 1.0,
  lootDropRate: 1.0,
  xpMultiplier: 1.0
};

export function set_difficulty_profile(p: DifficultyProfile) {
  profile = p;
  buffer = [];
  return { profile, ...DEFAULTS };
}

export function getProfile(): DifficultyProfile { return profile; }

export function shouldAutoAdjust(): boolean { return profile === "adaptive"; }

// Ingest a single gameplay sample. `value` is a frustration score in [0,1].
// 0 = player breezing through, 1 = player dying constantly.
export function ingest(value: number) {
  if (typeof value !== "number" || !isFinite(value)) return;
  buffer.push(Math.max(0, Math.min(1, value)));
  if (buffer.length > SAMPLE_WINDOW) buffer.shift();
}

// Derive multipliers from the current window.
export function multipliers(): { mult: DifficultyMultipliers; index: number; samples: number } {
  if (!buffer.length) return { mult: { ...DEFAULTS }, index: 0.5, samples: 0 };
  const sum = buffer.reduce((a, b) => a + b, 0);
  const index = sum / buffer.length;
  // Easy profile: keep things forgiving. Hard profile: keep things tough.
  // Adaptive: drift multipliers opposite to the index.
  let mult: DifficultyMultipliers = { ...DEFAULTS };
  switch (profile) {
    case "easy":
      mult = { enemySpawnRate: 0.7, damageMultiplier: 0.7, healthMultiplier: 1.2, lootDropRate: 1.4, xpMultiplier: 1.2 };
      break;
    case "medium":
      mult = { ...DEFAULTS };
      break;
    case "hard":
      mult = { enemySpawnRate: 1.3, damageMultiplier: 1.3, healthMultiplier: 0.8, lootDropRate: 0.7, xpMultiplier: 0.9 };
      break;
    case "adaptive": {
      const drift = (index - 0.5) * 2; // -1..+1
      mult = {
        enemySpawnRate: clamp(1 - drift * 0.4, CLAMPS.enemySpawnRate),
        damageMultiplier: clamp(1 - drift * 0.4, CLAMPS.damageMultiplier),
        healthMultiplier: clamp(1 + drift * 0.3, CLAMPS.healthMultiplier),
        lootDropRate: clamp(1 - drift * 0.4, CLAMPS.lootDropRate),
        xpMultiplier: clamp(1 - drift * 0.3, CLAMPS.xpMultiplier)
      };
      break;
    }
  }
  return { mult, index, samples: buffer.length };
}

export async function adjust_difficulty(): Promise<AdjustResult> {
  const { mult, index, samples } = multipliers();
  return {
    profile,
    ...mult,
    frustrationIndex: Number(index.toFixed(3)),
    recentSamples: samples,
    applied: samples > 0,
    note: profile === "adaptive" ? "adaptive drift applied" : "fixed profile"
  };
}

function clamp(v: number, [lo, hi]: [number, number]): number {
  return Math.max(lo, Math.min(hi, v));
}
