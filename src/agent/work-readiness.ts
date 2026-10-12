import type { Bot } from "mineflayer";
import { isCreativeMode } from "../minecraft/mode.js";
import { nearestThreat } from "./self-defense.js";
import { countFoodItems } from "../skills/gather-food.js";

export const WORK_FOOD_RESERVE = 6;

/** Telemetry adapters without hunger/inventory data cannot assess supplies. */
export function hasFoodForWork(bot: Bot): boolean {
  return !Number.isFinite(bot.food) || bot.inventory?.items === undefined || countFoodItems(bot) > 0;
}

export function workReadiness(bot: Bot): { reason: string; item?: string; quantity?: number } | null {
  if (isCreativeMode(bot)) return null;
  const threat = nearestThreat(bot);
  if (threat !== null) return { reason: `exposed to ${threat.name} nearby` };
  if (bot.health < 14) {
    const food = bot.inventory?.items?.().some(item => /^(bread|baked_potato|carrot|apple|golden_carrot|cooked_.*)$/.test(item.name));
    return { reason: `heal before discretionary work (${bot.health}/20)`, ...(bot.food < 18 && !food ? { item: "bread", quantity: WORK_FOOD_RESERVE } : {}) };
  }
  // Small test/telemetry-only adapters may not carry an inventory interface.
  if (bot.inventory?.items === undefined) return null;
  if (Number.isFinite(bot.food) && countFoodItems(bot) < WORK_FOOD_RESERVE) {
    return { reason: "stock carried food before discretionary work", item: "bread", quantity: WORK_FOOD_RESERVE };
  }
  const names = bot.inventory.items().filter(item => item.count > 0).map(item => item.name);
  for (const [suffix, item] of [["_sword", "stone_sword"], ["_pickaxe", "stone_pickaxe"], ["_axe", "stone_axe"]] as const) {
    if (!names.some(name => name.endsWith(suffix))) return { reason: `rearm before discretionary work: ${item}`, item };
  }
  return null;
}
