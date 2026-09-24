import type { Bot } from "mineflayer";
import type { MinecraftConfig } from "../config/schema.js";
import type { ProtectedRegion } from "../minecraft/protection.js";
import { checkBlockDestruction, checkBlockPlacement } from "./protection.js";
import { canPerform, regionContains } from "../minecraft/protection.js";
import { checkDimensionEntry, checkHealthRetreat, checkLavaEntry, lavaAvoidanceRadius, type SafetyVerdict } from "./safety.js";
import { DestructiveAuthorizationRegistry, destructiveActionForMutation, type MutationAuthorizationContext } from "./destructive-authorization.js";

export type DangerousAction = "dig" | "place" | "container" | "combat" | "dimension" | "craft" | "smelt";

/** Re-read current bot/world facts immediately before a dangerous mutation. */
export function revalidateAction(
  bot: Bot,
  action: DangerousAction,
  point: { x: number; y: number; z: number },
  config: MinecraftConfig,
  region: ProtectedRegion | null,
  options: { blockName?: string; userRequested?: boolean; dimension?: string; authorization?: MutationAuthorizationContext; taskId?: string; projectId?: string; worldId?: string | number; now?: Date } = {},
): SafetyVerdict {
  if (bot.entity === null) return { allowed: false, violation: { code: "DANGER_TOO_HIGH", reason: "bot is not spawned" } };
  if (action === "dimension") {
    return options.dimension === undefined ? { allowed: false, violation: { code: "DIMENSION_FORBIDDEN", reason: "destination dimension is missing" } } : checkDimensionEntry(options.dimension, config);
  }
  if (["dig", "place", "container", "combat", "craft", "smelt"].includes(action)) {
    const health = checkHealthRetreat(bot.health, config.policy?.health_retreat_threshold ?? 8);
    if (!health.allowed && ["dig", "combat"].includes(action)) return health;
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
    if (insideProtected) return { allowed: false, violation: { code: "DANGER_TOO_HIGH", reason: "protected digging requires an active bounded terrain authorization" } };
    const verdict = checkBlockDestruction(options.blockName, point, region, false);
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
