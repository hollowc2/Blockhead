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
/** Free slots below which gathering first sheds junk to make room. */
export const MIN_FREE_SLOTS_FOR_GATHER = 4;

/**
 * Junk the bot picks up while digging and pathing, with how many to keep.
 * Cobblestone is kept for stone tools, furnaces and scaffolding; the rest has
 * no use for the bot. Seeds and low-tier tools are deliberately absent (the
 * farm plants seeds; a wooden pickaxe may be the only pickaxe).
 */
const JUNK_KEEP: Readonly<Record<string, number>> = {
  cobblestone: 64,
  cobbled_deepslate: 0,
  dirt: 0,
  gravel: 0,
  granite: 0,
  diorite: 0,
  andesite: 0,
  tuff: 0,
  netherrack: 0,
  rotten_flesh: 0,
  poppy: 0,
  dandelion: 0,
  azure_bluet: 0,
  oxeye_daisy: 0,
  cornflower: 0,
  red_tulip: 0,
  orange_tulip: 0,
  white_tulip: 0,
  pink_tulip: 0,
  allium: 0,
  blue_orchid: 0,
  lily_of_the_valley: 0,
};

/**
 * Plan which junk to drop when the inventory is short of room: item name ->
 * count to toss. Empty when `freeSlots` is already enough. `protect` names an
 * item the caller is gathering, which is never dropped.
 */
export function junkToShed(
  items: readonly { name: string; count: number }[],
  freeSlots: number,
  protect: readonly string[] = [],
): Record<string, number> {
  if (freeSlots >= MIN_FREE_SLOTS_FOR_GATHER) return {};
  const totals: Record<string, number> = {};
  for (const item of items) {
    const name = bareName(item.name);
    if (JUNK_KEEP[name] === undefined || protect.some((kept) => bareName(kept) === name)) continue;
    totals[name] = (totals[name] ?? 0) + item.count;
  }
  const plan: Record<string, number> = {};
  for (const [name, count] of Object.entries(totals)) {
    const surplus = count - (JUNK_KEEP[name] ?? 0);
    if (surplus > 0) plan[name] = surplus;
  }
  return plan;
}
