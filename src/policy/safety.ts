import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import type { MinecraftConfig } from "../config/schema.js";
import { findBlocksNearPoint } from "../minecraft/world.js";

/**
 * Deterministic safety policy (spec section 34). Hard constraints enforced
 * independently of the LLM: dangerous work retreats below a health floor,
 * the bot never digs straight down blindly, never intentionally steps into
 * known lava, never starts long expeditions without supplies, and never
 * enters another dimension unless the config allows it.
 *
 * These are pure checks (plus one bounded world probe for lava). Skills and
 * tool handlers consult them *before* acting; a violation returns a
 * structured error code the LLM sees on the next decision
 * (DANGER_TOO_HIGH / DIG_STRAIGHT_DOWN / LAVA_ENTRY / DIMENSION_FORBIDDEN).
 */

/** Health at or below which dangerous work (mining at risk, hunting, combat) retreats. */
export const HEALTH_RETREAT_THRESHOLD = 8;

/** Blocks the bot must keep between its working position and a lava pool. */
export const DEFAULT_LAVA_AVOIDANCE_RADIUS = 4;

/** The default set of dimensions the agent may enter (spec 34: "unless explicitly allowed"). */
export const DEFAULT_ALLOWED_DIMENSIONS: readonly string[] = ["overworld"];

/** A safety check failed; the structured code is what the model sees. */
export interface SafetyViolation {
  code: "DANGER_TOO_HIGH" | "DIG_STRAIGHT_DOWN" | "LAVA_ENTRY" | "DIMENSION_FORBIDDEN";
  reason: string;
}

export type SafetyVerdict = { allowed: true } | { allowed: false; violation: SafetyViolation };

/**
 * The configured lava-avoidance radius in blocks (policy.lava_avoidance_radius).
 */
export function lavaAvoidanceRadius(config: MinecraftConfig): number {
  return config.policy?.lava_avoidance_radius ?? DEFAULT_LAVA_AVOIDANCE_RADIUS;
}

/** Whether `health` is at or below the retreat floor. */
export function belowHealthRetreat(health: number, threshold: number = HEALTH_RETREAT_THRESHOLD): boolean {
  return Number.isFinite(health) && health <= threshold;
}

/**
 * "Never continue dangerous work below health limits" (spec 34). Dangerous
 * work (hunting, defending, expeditions) refuses to start at/below the
 * retreat threshold; healing or a full health pool must arrive first.
 */
export function checkHealthRetreat(health: number, threshold: number = HEALTH_RETREAT_THRESHOLD): SafetyVerdict {
  if (belowHealthRetreat(health, threshold)) {
    return {
      allowed: false,
      violation: {
        code: "DANGER_TOO_HIGH",
        reason: `health ${health} is at/below the retreat threshold ${threshold}`,
      },
    };
  }
  return { allowed: true };
}

/**
 * True when `target` is the block directly beneath the bot's feet (same X/Z
 * column, one block down). Mining that block is the "dig straight down"
 * pattern the policy refuses: it is the classic fall-to-death / lava-plunge
 * move, and a sideways or angled dig is always available instead.
 */
export function isStraightDownTarget(target: { x: number; y: number; z: number }, self: { x: number; y: number; z: number }): boolean {
  return (
    Math.round(target.x) === Math.round(self.x) &&
    Math.round(target.z) === Math.round(self.z) &&
    Math.round(target.y) === Math.round(self.y) - 1
  );
}

/** "Never dig straight down blindly" (spec 34). */
export function checkDigStraightDown(
  target: { x: number; y: number; z: number },
  self: { x: number; y: number; z: number },
): SafetyVerdict {
  if (isStraightDownTarget(target, self)) {
    return {
      allowed: false,
      violation: {
        code: "DIG_STRAIGHT_DOWN",
        reason: `would dig the block directly beneath the bot at (${Math.round(target.x)}, ${Math.round(target.y)}, ${Math.round(target.z)})`,
      },
    };
  }
  return { allowed: true };
}

/** True when a block is lava (stationary or flowing). */
export function isLavaBlock(blockName: string): boolean {
  return blockName === "lava" || blockName === "flowing_lava";
}

/**
 * True when lava sits within `radius` blocks of `point`. A single bounded
 * world probe (the gather/search skills call it once per candidate site, not
 * per block). Returns false before spawn.
 */
export function lavaNear(bot: Bot, point: { x: number; y: number; z: number }, radius: number): boolean {
  if (bot.entity === null) return false;
  const found = findBlocksNearPoint(bot, new Vec3(point.x, point.y, point.z), (block) => isLavaBlock(block.name), radius, 1);
  return found.length > 0;
}

/**
 * "Never intentionally enter known lava" (spec 34). Refuses a destination or
 * work site that lava surrounds; the bot stands off instead of walking in.
 */
export function checkLavaEntry(bot: Bot, point: { x: number; y: number; z: number }, radius: number): SafetyVerdict {
  if (lavaNear(bot, point, radius)) {
    return {
      allowed: false,
      violation: {
        code: "LAVA_ENTRY",
        reason: `lava is within ${radius} blocks of (${Math.round(point.x)}, ${Math.round(point.y)}, ${Math.round(point.z)})`,
      },
    };
  }
  return { allowed: true };
}

/** The configured set of dimension ids the agent may enter, normalized. */
export function allowedDimensions(config: MinecraftConfig): readonly string[] {
  const configured = config.policy?.allowed_dimensions ?? DEFAULT_ALLOWED_DIMENSIONS;
  if (Array.isArray(configured) && configured.length > 0) {
    return configured;
  }
  return DEFAULT_ALLOWED_DIMENSIONS;
}

/** "Never enter another dimension unless explicitly allowed by policy" (spec 34). */
export function checkDimensionEntry(dimension: string, config: MinecraftConfig): SafetyVerdict {
  const bare = dimension.replace(/^minecraft:/, "");
  if (allowedDimensions(config).includes(bare)) return { allowed: true };
  return {
    allowed: false,
    violation: {
      code: "DIMENSION_FORBIDDEN",
      reason: `entering '${bare}' is not allowed by policy (allowed: ${allowedDimensions(config).join(", ")})`,
    },
  };
}

/**
 * "Do not begin long expeditions without minimum supplies" (spec 12, 34).
 * The deterministic supply verification lives in the expedition skill
 * (`checkExpeditionSupplies`), which `collect_resource` already runs before
 * crossing the threshold; this alias exists so the safety layer reads as the
 * single policy surface for the rule.
 */
export { checkExpeditionSupplies, snapshotExpeditionSupplies } from "../skills/expedition.js";