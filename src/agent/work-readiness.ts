import type { Bot } from "mineflayer";
import { isCreativeMode } from "../minecraft/mode.js";
import { nearestThreat } from "./self-defense.js";

export function workReadiness(bot: Bot): { reason: string; item?: string } | null {
  if (isCreativeMode(bot)) return null;
  const threat = nearestThreat(bot);
  if (threat !== null) return { reason: `exposed to ${threat.name} nearby` };
  if (bot.health < 14) {
    const food = bot.inventory?.items?.().some(item => /^(bread|baked_potato|carrot|apple|golden_carrot|cooked_.*)$/.test(item.name));
    return { reason: `heal before discretionary work (${bot.health}/20)`, ...(bot.food < 18 && !food ? { item: "bread" } : {}) };
  }
  // Small test/telemetry-only adapters may not carry an inventory interface.
  if (bot.inventory?.items === undefined) return null;
  const names = bot.inventory.items().filter(item => item.count > 0).map(item => item.name);
  for (const [suffix, item] of [["_sword", "stone_sword"], ["_pickaxe", "stone_pickaxe"], ["_axe", "stone_axe"]] as const) {
    if (!names.some(name => name.endsWith(suffix))) return { reason: `rearm before discretionary work: ${item}`, item };
  }
  return null;
}
