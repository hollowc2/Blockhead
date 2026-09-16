import type { Bot } from "mineflayer";
import type { MinecraftConfig } from "../config/schema.js";
import type { ProtectedRegion } from "../minecraft/protection.js";
import { checkBlockDestruction, checkBlockPlacement } from "./protection.js";
import { checkDimensionEntry, checkHealthRetreat, checkLavaEntry, lavaAvoidanceRadius, type SafetyVerdict } from "./safety.js";

export type DangerousAction = "dig" | "place" | "container" | "combat" | "dimension" | "craft" | "smelt";

/** Re-read current bot/world facts immediately before a dangerous mutation. */
export function revalidateAction(
  bot: Bot,
  action: DangerousAction,
  point: { x: number; y: number; z: number },
  config: MinecraftConfig,
  region: ProtectedRegion | null,
  options: { blockName?: string; userRequested?: boolean; dimension?: string } = {},
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
  if (action === "dig") {
    if (options.blockName === undefined) return { allowed: false, violation: { code: "DANGER_TOO_HIGH", reason: "current block state is unavailable" } };
    const verdict = checkBlockDestruction(options.blockName, point, region, options.userRequested === true);
    if (!verdict.allowed) return { allowed: false, violation: { code: "DANGER_TOO_HIGH", reason: verdict.reason ?? "protected action" } };
  }
  if (action === "place") {
    if (options.blockName === undefined) return { allowed: false, violation: { code: "DANGER_TOO_HIGH", reason: "placement item is unavailable" } };
    const verdict = checkBlockPlacement(options.blockName, point, region);
    if (!verdict.allowed) return { allowed: false, violation: { code: "DANGER_TOO_HIGH", reason: verdict.reason ?? "protected placement" } };
  }
  return { allowed: true };
}
