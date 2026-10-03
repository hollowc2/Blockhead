import type { Bot } from "mineflayer";
import type { MinecraftConfig } from "../config/schema.js";
import type { ProtectedRegion } from "../minecraft/protection.js";
import { checkBlockDestruction, checkBlockPlacement, classifyBlock } from "./protection.js";
import { ANIMAL_MOB_NAMES } from "./combat.js";
import { canPerform, regionContains } from "../minecraft/protection.js";
import { checkDimensionEntry, checkHealthRetreat, checkLavaEntry, lavaAvoidanceRadius, type SafetyVerdict } from "./safety.js";
import { DestructiveAuthorizationRegistry, destructiveActionForMutation, type MutationAuthorizationContext } from "./destructive-authorization.js";

/** At or below this health even digging or a fight stops; the bot heals first. */
const DIG_CRITICAL_HEALTH = 4;
/** Health regenerates only at or above this hunger. */
const REGEN_HUNGER = 18;

export type DangerousAction = "dig" | "place" | "container" | "combat" | "dimension" | "craft" | "smelt";

/** Re-read current bot/world facts immediately before a dangerous mutation. */
export function revalidateAction(
  bot: Bot,
  action: DangerousAction,
  point: { x: number; y: number; z: number },
  config: MinecraftConfig,
  region: ProtectedRegion | null,
  options: { blockName?: string; userRequested?: boolean; dimension?: string; authorization?: MutationAuthorizationContext; taskId?: string; projectId?: string; worldId?: string | number; now?: Date; ownBuildReplacement?: boolean } = {},
): SafetyVerdict {
  if (bot.entity === null) return { allowed: false, violation: { code: "DANGER_TOO_HIGH", reason: "bot is not spawned" } };
  if (action === "dimension") {
    return options.dimension === undefined ? { allowed: false, violation: { code: "DIMENSION_FORBIDDEN", reason: "destination dimension is missing" } } : checkDimensionEntry(options.dimension, config);
  }
  if (["dig", "place", "container", "combat", "craft", "smelt"].includes(action)) {
    const threshold = config.policy?.health_retreat_threshold ?? 8;
    // Combat: a passive animal cannot fight back (killing it for food is the
    // way out of low health), and the skills own the retreat policy for
    // hostiles. The boundary only refuses a fight at critical health.
    if (action === "combat" && !(options.blockName !== undefined && ANIMAL_MOB_NAMES.has(options.blockName))) {
      const critical = checkHealthRetreat(bot.health, Math.min(threshold, DIG_CRITICAL_HEALTH));
      if (!critical.allowed) return critical;
    }
    // Breaking a block is not a fight. Without food, health never regenerates
    // past the retreat threshold, and blocking every dig there left the bot
    // unable even to clear leaves off a build site. Only critical health
    // stops digging (lava and falling blocks are checked separately).
    // Waiting only helps a bot that can regenerate (hunger 18+). Starving, the
    // gate froze it in place: at 1 HP it could not even dig into its night
    // shelter, the one move that keeps it alive.
    if (action === "dig" && (Number.isFinite(bot.food) ? bot.food : 20) >= REGEN_HUNGER) {
      const critical = checkHealthRetreat(bot.health, Math.min(threshold, DIG_CRITICAL_HEALTH));
      if (!critical.allowed) return critical;
    }
    const lava = checkLavaEntry(bot, point, lavaAvoidanceRadius(config));
    if (!lava.allowed && ["dig", "combat", "place"].includes(action)) return lava;
  }
  if (action === "container" && !canPerform("useContainers", region, point)) {
    return { allowed: false, violation: { code: "DANGER_TOO_HIGH", reason: "container use rejected by protected-region policy" } };
  }
  if (action === "craft" && options.blockName === "crafting_table" && !canPerform("useCraftingTables", region, point)) {
    return { allowed: false, violation: { code: "DANGER_TOO_HIGH", reason: "crafting-table use rejected by protected-region policy" } };
  }
  if (action === "smelt" && ["furnace", "smoker", "blast_furnace"].includes(options.blockName ?? "") && !canPerform("useFurnaces", region, point)) {
    return { allowed: false, violation: { code: "DANGER_TOO_HIGH", reason: "furnace use rejected by protected-region policy" } };
  }
  if (action === "dig") {
    if (options.blockName === undefined) return { allowed: false, violation: { code: "DANGER_TOO_HIGH", reason: "current block state is unavailable" } };
    const insideProtected = region !== null && regionContains(region, point);
    const authorization = options.authorization;
    const hasAuthorizationIdentity = authorization !== undefined && options.taskId !== undefined && options.projectId !== undefined && options.worldId !== undefined;
    if (hasAuthorizationIdentity) {
      const authorized = new DestructiveAuthorizationRegistry().allows(authorization, "dig", point, options.worldId!, options.dimension ?? region?.dimension ?? "", options.projectId!, options.taskId!, options.now);
      if (!authorized) return { allowed: false, violation: { code: "DANGER_TOO_HIGH", reason: "dig is outside the active bounded terrain authorization" } };
      if (isProtectedFixture(options.blockName)) return { allowed: false, violation: { code: "DANGER_TOO_HIGH", reason: `${options.blockName} is a protected fixture` } };
      return { allowed: true };
    }
    // Natural terrain near home (dirt, stone, leaves, ores...) may be dug;
    // the protected region exists to keep player-built blocks safe.
    // A build task may break a structural block it placed itself where its
    // blueprint calls for a replacement (a door or window cut into a wall).
    const ownReplacement = options.ownBuildReplacement === true && options.projectId !== undefined && classifyBlock(options.blockName) === "structural";
    if (insideProtected && classifyBlock(options.blockName) !== "terrain" && !ownReplacement) return { allowed: false, violation: { code: "DANGER_TOO_HIGH", reason: "protected digging requires an active bounded terrain authorization" } };
    const verdict = ownReplacement ? { allowed: true } as { allowed: boolean; reason?: string } : checkBlockDestruction(options.blockName, point, region, false);
    if (!verdict.allowed) return { allowed: false, violation: { code: "DANGER_TOO_HIGH", reason: verdict.reason ?? "protected action" } };
  }
  if (action === "place") {
    if (options.blockName === undefined) return { allowed: false, violation: { code: "DANGER_TOO_HIGH", reason: "placement item is unavailable" } };
    if (options.authorization !== undefined && options.taskId !== undefined && options.projectId !== undefined && options.worldId !== undefined) {
      const destructiveAction = destructiveActionForMutation(action, options.blockName);
      if (destructiveAction === null || !new DestructiveAuthorizationRegistry().allows(options.authorization, destructiveAction, point, options.worldId, options.dimension ?? "", options.projectId, options.taskId, options.now)) {
        return { allowed: false, violation: { code: "DANGER_TOO_HIGH", reason: "terrain placement is outside its active bounded authorization" } };
      }
    }
    const verdict = checkBlockPlacement(options.blockName, point, region);
    if (!verdict.allowed) return { allowed: false, violation: { code: "DANGER_TOO_HIGH", reason: verdict.reason ?? "protected placement" } };
  }
  return { allowed: true };
}

export function isProtectedFixture(blockName: string): boolean {
  const bare = blockName.replace(/^minecraft:/, "");
  return ["chest", "trapped_chest", "barrel", "ender_chest", "shulker_box", "furnace", "smoker", "blast_furnace", "crafting_table", "enchanting_table", "brewing_stand", "smithing_table", "stonecutter", "loom", "cartography_table", "bed", "hopper", "dropper", "dispenser", "beacon", "anvil", "spawner", "decorated_pot"].includes(bare) || bare.endsWith("_bed") || bare.endsWith("_sign") || bare.endsWith("_hanging_sign");
}
