import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CANONICAL_EASINGS,
  EASING_ALIASES,
  compatSchema,
  normalizeAnimationArgs,
  resolveEasingName,
} from "../src/tools/animationCompat.js";
import { tools } from "../src/tools/registry.js";

const REGISTRY_SRC = readFileSync(
  fileURLToPath(new URL("../src/tools/registry.ts", import.meta.url)),
  "utf8",
);

const SHIMMED = [
  "create_model_animation",
  "set_model_keyframe",
  "set_model_easing",
  "add_animation_marker",
  "preview_model_animation",
  "validate_model_animation",
  "retime_animation",
  "reverse_animation",
  "mirror_animation",
  "blend_animation",
  "fix_animation",
  "set_track_lock",
  "create_attack_animation",
  "create_idle_animation",
  "create_walk_cycle",
];

function toolDef(name: string) {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error("no such tool: " + name);
  return t;
}

describe("Task 12.10 — backward-compatibility shim", () => {
  describe("easing resolution", () => {
    it("passes canonical names through unchanged", () => {
      for (const e of CANONICAL_EASINGS) {
        expect(resolveEasingName(e)).toBe(e);
      }
    });

    it("resolves the legacy spellings", () => {
      for (const [alias, target] of Object.entries(EASING_ALIASES)) {
        expect(resolveEasingName(alias)).toBe(target);
        // Case- and separator-insensitive, as the plugin's resolver is.
        expect(resolveEasingName(alias.toUpperCase())).toBe(target);
      }
      expect(resolveEasingName("Quad-In")).toBe("quadIn");
      expect(resolveEasingName("ease_out")).toBe("quadOut");
    });

    it("never silently downgrades an unknown easing to linear", () => {
      // Masking a typo as "linear" would make a bad prompt produce a
      // plausible-looking but wrong clip.
      expect(resolveEasingName("bounce")).toBeUndefined();
      expect(resolveEasingName("")).toBeUndefined();
      expect(resolveEasingName(undefined)).toBeUndefined();
      expect(resolveEasingName(42)).toBeUndefined();
    });

    it("matches the plugin's own alias table", () => {
      // The registry and studio-plugin/RoLink.lua must agree or a prompt
      // resolves differently depending on which layer sees it first.
      const plugin = readFileSync(
        fileURLToPath(new URL("../../studio-plugin/RoLink.lua", import.meta.url)),
        "utf8",
      );
      const block = plugin.match(/local EASE_ALIASES[\s\S]*?\n\}/);
      expect(block).toBeTruthy();
      for (const [alias, target] of Object.entries(EASING_ALIASES)) {
        expect(block![0]).toContain(`${alias} = "${target}"`);
      }
    });
  });

  describe("argument normalization", () => {
    it("renames the legacy `animation` key to `anim`", () => {
      const r = normalizeAnimationArgs("set_model_keyframe", {
        animation: "Clip",
        track: "Head",
        t: 0.5,
      });
      expect(r.args.anim).toBe("Clip");
      expect(r.args.animation).toBeUndefined();
      expect(r.notes.join(" ")).toContain("animation");
    });

    it("prefers the canonical `anim` when both are present", () => {
      const r = normalizeAnimationArgs("fix_animation", { anim: "A", animation: "B" });
      expect(r.args.anim).toBe("A");
      expect(r.args.animation).toBe("B");
    });

    it("renames the legacy `easing` key to `ease`", () => {
      const r = normalizeAnimationArgs("set_model_easing", {
        anim: "Clip",
        track: "Head",
        keyIndex: 1,
        easing: "quadIn",
      });
      expect(r.args.ease).toBe("quadIn");
      expect(r.args.easing).toBeUndefined();
    });

    it("resolves a legacy easing spelling end to end", () => {
      const r = normalizeAnimationArgs("set_model_keyframe", {
        anim: "Clip",
        track: "Head",
        t: 0,
        ease: "easeInOut",
      });
      expect(r.args.ease).toBe("quadInOut");
      expect(r.unresolvedEasing).toBeUndefined();
    });

    it("flags an unresolvable easing instead of rewriting it", () => {
      const r = normalizeAnimationArgs("set_model_keyframe", { ease: "wobble" });
      expect(r.unresolvedEasing).toBe("wobble");
      expect(r.args.ease).toBe("wobble");
    });

    it("leaves canonical args untouched", () => {
      const input = { anim: "Clip", track: "Head", t: 0.5, ease: "bezierOut" };
      const r = normalizeAnimationArgs("set_model_keyframe", input);
      expect(r.args).toEqual(input);
      expect(r.notes).toEqual([]);
      // Input must not be mutated.
      expect(input).toEqual({ anim: "Clip", track: "Head", t: 0.5, ease: "bezierOut" });
    });

    it("does not touch tools outside the animation set", () => {
      const r = normalizeAnimationArgs("get_animation_info", { animation: "X" });
      expect(r.args.animation).toBe("X");
      expect(r.args.anim).toBeUndefined();
    });

    it("pins a style on the scaffolds so the plugin never sees an empty one", () => {
      for (const t of ["create_attack_animation", "create_idle_animation", "create_walk_cycle"]) {
        expect(normalizeAnimationArgs(t, {}).args.style).toBe("REALISTIC");
        expect(normalizeAnimationArgs(t, { style: "" }).args.style).toBe("REALISTIC");
        expect(normalizeAnimationArgs(t, { style: "ANIME" }).args.style).toBe("ANIME");
      }
    });
  });

  describe("schema reachability", () => {
    it("the compat schema accepts every engine style", () => {
      const parsed = compatSchema().style.parse("MECHANICAL");
      expect(parsed).toBe("MECHANICAL");
      expect(() => compatSchema().style.parse("FAST")).toThrow();
    });

    it("zod would have stripped the new keys without the schema change", () => {
      // This is the whole point of 12.10: prove the option is now forwarded.
      for (const t of ["create_attack_animation", "create_idle_animation", "create_walk_cycle"]) {
        const parsed = toolDef(t).inputSchema.parse({
          target: "Workspace.NPC",
          name: "Clip",
          tracks: ["Head"],
          style: "ANIME",
        });
        expect(parsed.style).toBe("ANIME");
        // Every pre-existing field still parses unchanged.
        expect(parsed.target).toBe("Workspace.NPC");
        expect(parsed.name).toBe("Clip");
        expect(parsed.tracks).toEqual(["Head"]);
      }
      const seeded = toolDef("create_model_animation").inputSchema.parse({
        target: "Workspace.NPC",
        name: "Clip",
        duration: 1,
        tracks: ["Head"],
      });
      expect(seeded.tracks).toEqual(["Head"]);
    });

    it("create_model_animation still accepts a prompt with no tracks", () => {
      const parsed = toolDef("create_model_animation").inputSchema.parse({
        target: "Workspace.NPC",
        name: "Clip",
        duration: 1,
      });
      expect(parsed.tracks).toBeUndefined();
    });

    it("every migrated animation tool is routed through the shim", () => {
      for (const name of SHIMMED) {
        expect(REGISTRY_SRC, name + " must normalize its args").toContain(
          `normalizeAnimationArgs("${name}"`,
        );
      }
    });

    it("the registry still has 150 tools", () => {
      expect(tools.length).toBe(150);
    });
  });
});
