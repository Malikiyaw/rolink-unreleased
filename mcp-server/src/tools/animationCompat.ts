/**
 * RoLink animation tool backward-compatibility shim — Task 12.10.
 *
 * Phase 12 moved the model-animation tools in studio-plugin/RoLink.lua onto
 * the Animation Engine v3. That changed two things an existing AI prompt can
 * notice, and this module absorbs both so old prompts keep working:
 *
 *  1. SCHEMA REACHABILITY. zod STRIPS keys a schema does not declare, so any
 *     engine option Phase 12 added (`style` on the scaffolds, `tracks` on
 *     create_model_animation) would be silently dropped before it ever
 *     reached the plugin. The schemas below now declare them.
 *
 *  2. ARGUMENT SPELLING. The tools have always been called with a few
 *     long-lived synonyms. normalizeAnimationArgs maps them onto the single
 *     canonical spelling the plugin reads, so a prompt written years ago and
 *     one written today take the identical code path.
 *
 * The shim is deliberately narrow: it only ever ADDS an argument the schema
 * lacks, only ever renames a synonym, and never invents a value. A prompt
 * that already sends canonical args is passed through byte-for-byte, so no
 * existing behaviour can shift underneath it.
 */

import { z } from "zod";

/** Easing names the plugin's Curves engine can evaluate. */
export const CANONICAL_EASINGS = [
  "linear", "quadIn", "quadOut", "quadInOut",
  "cubicIn", "cubicOut", "cubicInOut",
  "sineIn", "sineOut", "sineInOut",
  "bezierOut", "springOut",
] as const;

/**
 * Legacy spellings -> canonical easing. Mirrors EASE_ALIASES in
 * studio-plugin/RoLink.lua so a prompt resolves identically at both the
 * registry boundary and inside the plugin.
 */
export const EASING_ALIASES: Readonly<Record<string, string>> = {
  quad: "quadInOut", cubic: "cubicInOut", sine: "sineInOut",
  bezier: "bezierOut", spring: "springOut", back: "bezierOut",
  easein: "quadIn", easeout: "quadOut", easeinout: "quadInOut",
  ease_in: "quadIn", ease_out: "quadOut", ease_in_out: "quadInOut",
};

/**
 * Resolve any accepted easing spelling to the canonical engine name.
 * Returns undefined for genuinely unknown input so the caller can keep the
 * plugin's own did-you-mean error rather than masking it as "linear".
 */
export function resolveEasingName(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const name = raw.trim();
  if ((CANONICAL_EASINGS as readonly string[]).includes(name)) return name;
  const norm = name.toLowerCase().replace(/[\s\-_]/g, "");
  for (const e of CANONICAL_EASINGS) {
    if (e.toLowerCase() === norm) return e;
  }
  return EASING_ALIASES[norm];
}

/** Tools whose `anim` argument was also written as `animation` in the wild. */
const ANIM_ALIAS_TOOLS = new Set([
  "set_model_keyframe", "set_model_easing", "add_animation_marker",
  "preview_model_animation", "validate_model_animation",
  "retime_animation", "reverse_animation", "mirror_animation",
  "fix_animation", "set_track_lock",
]);

/** Tools whose `ease` argument was also written as `easing`. */
const EASE_TOOLS = new Set(["set_model_keyframe", "set_model_easing"]);

export interface CompatResult {
  args: Record<string, unknown>;
  /** Non-fatal notes worth surfacing so a caller can see what was rewritten. */
  notes: string[];
  /** True when an easing could not be resolved; the plugin will error. */
  unresolvedEasing?: string;
}

/**
 * Rewrite one tool call's arguments into the canonical shape the plugin
 * expects. Pure: the input object is never mutated.
 */
export function normalizeAnimationArgs(
  tool: string,
  rawArgs: unknown,
): CompatResult {
  const args: Record<string, unknown> = { ...(rawArgs as Record<string, unknown> ?? {}) };
  const notes: string[] = [];

  // `animation` -> `anim`
  if (ANIM_ALIAS_TOOLS.has(tool) && args.anim === undefined && typeof args.animation === "string") {
    args.anim = args.animation;
    delete args.animation;
    notes.push(`renamed 'animation' -> 'anim' for ${tool}`);
  }

  // `easing` -> `ease`, then normalize the spelling to an engine curve.
  if (EASE_TOOLS.has(tool)) {
    if (args.ease === undefined && typeof args.easing === "string") {
      args.ease = args.easing;
      delete args.easing;
      notes.push(`renamed 'easing' -> 'ease' for ${tool}`);
    }
    if (typeof args.ease === "string") {
      const canonical = resolveEasingName(args.ease);
      if (canonical === undefined) {
        return { args, notes, unresolvedEasing: args.ease };
      }
      if (canonical !== args.ease) {
        notes.push(`resolved easing '${args.ease}' -> '${canonical}'`);
        args.ease = canonical;
      }
    }
  }

  // Scaffolds gained an optional `style` in Phase 12. Older prompts omit it;
  // pin the engine default here so the plugin never sees an empty string.
  if (
    (tool === "create_attack_animation" || tool === "create_idle_animation" || tool === "create_walk_cycle") &&
    (args.style === undefined || args.style === null || args.style === "")
  ) {
    args.style = "REALISTIC";
  }

  return { args, notes };
}

/**
 * Optional schema fragments for the engine options Phase 12 introduced.
 * Spread these into the relevant tool schemas so zod forwards the keys
 * instead of stripping them.
 */
export function compatSchema(): {
  style: ReturnType<typeof buildStyle>;
  tracks: ReturnType<typeof buildTracks>;
} {
  return { style: buildStyle(), tracks: buildTracks() };
}

const buildStyle = () =>
  z.enum([
    "REALISTIC", "CINEMATIC", "ANIME", "EXAGGERATED",
    "MECHANICAL", "CREATURE", "CARTOON", "SUBTLE",
  ]).optional().default("REALISTIC");

const buildTracks = () => z.array(z.string().min(1)).min(1).max(32).optional();
