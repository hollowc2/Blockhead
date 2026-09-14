import type { ProtectedRegion, RegionPoint } from "../minecraft/protection.js";
import { canPerform, regionContains } from "../minecraft/protection.js";

/**
 * Deterministic block-action protection policy (spec sections 8.2, 34:
 * "Do not destroy protected structures"). The geometry answers ("where is a
 * region", "does this point fall in it") live in minecraft/protection.ts;
 * this module classifies blocks and decides whether a specific destructive
 * or placement action is legal.
 *
 * Inside the protected home region:
 *   - containers, beds, crafting tables, furnaces, and permitted placement
 *     are allowed (the region's own policy flags).
 *   - breaking registered storage is never allowed (a chest holds items).
 *   - breaking structural blocks is forbidden unless the owner explicitly
 *     requested it ("restricted by default: unrequested demolition").
 *   - natural terrain (trees, stone, ores, dirt) may be gathered — bootstrap
 *     and stockpile maintenance depend on the neighborhood's resources, and
 *     the protected region protects human structures, not the ground.
 * Outside the region everything is free (spec 8.2).
 */

/** Block categories the destruction policy reasons over. */
export type BlockClass = "terrain" | "structural" | "infrastructure";

/** Logs, leaves, ores — natural resources of the bot's own neighborhood. */
const TERRAIN_BLOCK_NAMES: ReadonlySet<string> = new Set([
  "dirt",
  "grass_block",
  "stone",
  "deepslate",
  "tuff",
  "granite",
  "diorite",
  "andesite",
  "sandstone",
  "red_sandstone",
  "sand",
  "red_sand",
  "gravel",
  "clay",
  "mud",
  "moss",
  "snow",
  "ice",
  "water",
  "bedrock",
  "grass",
  "tall_grass",
  "dandelion",
  "poppy",
  "flower",
]);

/** Registered storage; destroying it would scatter the owner's items. */
const INFRASTRUCTURE_BLOCK_NAMES: ReadonlySet<string> = new Set([
  "chest",
  "trapped_chest",
]);

/** Structural blocks with a natural lookalike (planks vs logs). */
const STRUCTURAL_SUFFIXES: readonly string[] = [
  "_planks",
  "_slab",
  "_wall",
  "_fence",
  "_door",
  "_stairs",
  "_glass",
  "_bricks",
  "_tile",
];

/** Classify a bare block name for the destruction decision. */
export function classifyBlock(name: string): BlockClass {
  const bare = name.replace(/^minecraft:/, "");
  if (INFRASTRUCTURE_BLOCK_NAMES.has(bare)) return "infrastructure";
  if (TERRAIN_BLOCK_NAMES.has(bare)) return "terrain";
  if (/_(log|leaves|ore)$/.test(bare) || /^deepslate_.+_ore$/.test(bare)) return "terrain";
  for (const suffix of STRUCTURAL_SUFFIXES) {
    if (bare.endsWith(suffix)) return "structural";
  }
  return "structural";
}

export interface ProtectionVerdict {
  allowed: boolean;
  /** PROTECTED_REGION when a protected block was refused. */
  code?: "PROTECTED_REGION";
  reason?: string;
}

/**
 * Is destroying `blockName` at `point` legal? `userRequested` records whether
 * the owner explicitly asked for this work (a `source: "user"` task); the
 * spec's "restricted by default" demolition rule needs that distinction.
 */
export function checkBlockDestruction(
  blockName: string,
  point: RegionPoint,
  region: ProtectedRegion | null,
  userRequested: boolean,
): ProtectionVerdict {
  if (region === null || !regionContains(region, point)) return { allowed: true };
  const blockClass = classifyBlock(blockName);
  if (blockClass === "terrain") return { allowed: true };
  if (blockClass === "infrastructure") {
    return {
      allowed: false,
      code: "PROTECTED_REGION",
      reason: `${blockName} is registered storage; it is never destroyed automatically`,
    };
  }
  if (!userRequested) {
    return {
      allowed: false,
      code: "PROTECTED_REGION",
      reason: `breaking ${blockName} inside the protected home region requires an explicit request`,
    };
  }
  return { allowed: true };
}

/**
 * Is placing `blockName` at `point` legal? Fire and lava are always refused
 * inside the region (the region's `fire`/`lava` flags, default false); every
 * other placement falls to the region's `place` flag (default true — the
 * bot's own tables, furnaces, chests, and lighting).
 */
export function checkBlockPlacement(
  blockName: string,
  point: RegionPoint,
  region: ProtectedRegion | null,
): ProtectionVerdict {
  if (region === null || !regionContains(region, point)) return { allowed: true };
  const bare = blockName.replace(/^minecraft:/, "");
  let action: "fire" | "lava" | "place";
  if (bare === "fire" || bare === "campfire" || bare === "torch") {
    action = "fire";
  } else if (bare === "lava" || bare === "flowing_lava") {
    action = "lava";
  } else {
    action = "place";
  }
  if (!canPerform(action, region, point)) {
    return {
      allowed: false,
      code: "PROTECTED_REGION",
      reason: `${action} placement of ${bare} is not allowed inside the protected home region`,
    };
  }
  return { allowed: true };
}