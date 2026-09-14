import type { MinecraftConfig } from "../config/schema.js";

/**
 * Deterministic combat target policy (spec section 25, rule 34: "Never
 * attack human players"). The LLM proposes a hunt/defense target; this
 * module decides whether attacking it is legal. Player-versus-player combat
 * is forbidden (`behavior.allow_pvp`, default false). Self-defense and
 * defending the owner are always allowed; hunting animals for food is
 * allowed; hunting hostile mobs is allowed as a task.
 */

/** Attacks on human players are rejected with this code. */
export const PVP_ERROR_CODE = "PVP_FORBIDDEN";

/** Passive animals the bot may hunt for food (spec 11, 25). */
export const ANIMAL_MOB_NAMES: ReadonlySet<string> = new Set([
  "cow",
  "pig",
  "sheep",
  "chicken",
]);

/**
 * Hostile mobs the bot may hunt as a task (`hunt_target`). Canonical for
 * the combat policy; matches minecraft-data entity names.
 */
export const HOSTILE_MOB_NAMES: ReadonlySet<string> = new Set([
  "zombie",
  "zombie_villager",
  "husk",
  "drowned",
  "skeleton",
  "stray",
  "creeper",
  "spider",
  "cave_spider",
  "enderman",
  "witch",
  "slime",
  "phantom",
  "blaze",
  "ghast",
  "magma_cube",
  "piglin",
  "piglin_brute",
  "hoglin",
  "zoglin",
  "wither",
  "wither_skeleton",
  "vindicator",
  "evoker",
  "ravager",
  "pillager",
  "vex",
  "guardian",
  "elder_guardian",
  "shulker",
  "silverfish",
  "endermite",
]);

/** True when the target is a human player entity ("player" type). */
export function isHumanTarget(entityType: string | null | undefined): boolean {
  return entityType === "player";
}

export interface CombatVerdict {
  allowed: boolean;
  /** PVP_FORBIDDEN when a human target was refused. */
  code?: "PVP_FORBIDDEN";
  reason?: string;
}

/**
 * Whether the bot may attack `targetType` (mineflayer entity type: "player"
 * or "mob"). The config's `behavior.allow_pvp` is the only way human targets
 * become legal (explicit PvP environments, spec 25 — out of scope by default).
 * Mob targets are always legal: the policy layer never second-guesses mob
 * names here, only the human-vs-mob boundary. Callers decide *which* mobs
 * they hunt (animals for food, hostiles as tasks).
 */
export function attackTargetAllowed(targetType: string | null | undefined, config: MinecraftConfig): CombatVerdict {
  if (!isHumanTarget(targetType)) return { allowed: true };
  const allowPvp = config.behavior?.allow_pvp === true;
  if (allowPvp) return { allowed: true };
  return {
    allowed: false,
    code: PVP_ERROR_CODE,
    reason: "attacks on human players are forbidden (allow_pvp: false)",
  };
}

/**
 * A raw string target name may never resolve to a human: schema-level
 * validation rejects "player"/"human" for hunt tools, and this check is the
 * runtime belt-and-braces guard used by the hunt/defense runners.
 */
export function targetNameIsHuman(name: string | null | undefined): boolean {
  if (name === null || name === undefined) return false;
  return name === "player" || name === "human" || name.endsWith("_player");
}