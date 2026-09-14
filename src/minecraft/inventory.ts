import type { Bot } from "mineflayer";
import type { Item } from "prismarine-item";

/**
 * Deterministic inventory primitives. The LLM never touches slots; these
 * helpers answer "how many do I have" / "where is it" for the skills layer.
 * Item names are full minecraft-data names ("oak_log", "wooden_pickaxe").
 */

/** Strip a leading "minecraft:" namespace for name comparisons. */
export function bareName(name: string): string {
  return name.replace(/^minecraft:/, "");
}

/** Raw (non-stripped) log item names: "oak_log", "spruce_log", ... */
export function isRawLogItemName(name: string): boolean {
  const bare = bareName(name);
  return !bare.startsWith("stripped_") && /^[a-z_]+_log$/.test(bare);
}

/** Plank item names: "oak_planks", "spruce_planks", ... */
export function isPlanksItemName(name: string): boolean {
  return /^[a-z_]+_planks$/.test(bareName(name));
}

/** The plank type a raw log produces ("oak_log" -> "oak_planks"). */
export function planksForLog(logName: string): string {
  return `${bareName(logName).replace(/_log$/, "")}_planks`;
}

/** Count every stack matching an exact item name. */
export function countItem(bot: Bot, name: string): number {
  const bare = bareName(name);
  let total = 0;
  for (const item of bot.inventory.items()) {
    if (bareName(item.name) === bare) total += item.count;
  }
  return total;
}

/** True when a single instance of the item is owned. */
export function hasItem(bot: Bot, name: string): boolean {
  return countItem(bot, name) > 0;
}

/** First owned instance of an item, or null. */
export function findItem(bot: Bot, name: string): Item | null {
  const bare = bareName(name);
  for (const item of bot.inventory.items()) {
    if (bareName(item.name) === bare) return item;
  }
  return null;
}

/** Total raw logs (any wood type) carried. */
export function countLogs(bot: Bot): number {
  return bot
    .inventory
    .items()
    .filter((item) => isRawLogItemName(item.name))
    .reduce((sum, item) => sum + item.count, 0);
}

/** Total planks (any wood type) carried. */
export function countPlanks(bot: Bot): number {
  return bot
    .inventory
    .items()
    .filter((item) => isPlanksItemName(item.name))
    .reduce((sum, item) => sum + item.count, 0);
}

/** Total sticks carried. */
export function countSticks(bot: Bot): number {
  return countItem(bot, "stick");
}

/** Owned raw-log counts grouped by exact item name ("oak_log": 5). */
export function logsByType(bot: Bot): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of bot.inventory.items()) {
    if (isRawLogItemName(item.name)) {
      counts[item.name] = (counts[item.name] ?? 0) + item.count;
    }
  }
  return counts;
}

/** Name -> count snapshot of the carried inventory (skill success records). */
export function itemsSummary(bot: Bot): Record<string, number> {
  const summary: Record<string, number> = {};
  for (const item of bot.inventory.items()) {
    summary[item.name] = (summary[item.name] ?? 0) + item.count;
  }
  return summary;
}