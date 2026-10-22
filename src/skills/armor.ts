import type { Bot } from "mineflayer";
import type { Logger } from "pino";
import { craftItem } from "../minecraft/crafting.js";
import { countItem } from "../minecraft/inventory.js";
import { equipAllArmor } from "../minecraft/primitives.js";
import { findBlockNear } from "../minecraft/world.js";

/**
 * Leather armor from hunt leather. Deaths 62-72 (20:14-21:39) were mostly
 * arrows and zombie hits on a bot wearing nothing, with 9 leather carried.
 */

/** Pieces by protection per leather: chestplate 3 for 8, leggings 2 for 7, helmet 1 for 5, boots 1 for 4. */
const LEATHER_PIECES: readonly { item: string; slot: number; leather: number }[] = [
  { item: "leather_chestplate", slot: 6, leather: 8 },
  { item: "leather_leggings", slot: 7, leather: 7 },
  { item: "leather_helmet", slot: 5, leather: 5 },
  { item: "leather_boots", slot: 8, leather: 4 },
];
const TABLE_SCAN_RADIUS = 12;

/** Armor slots of the player inventory window: helmet 5, chest 6, legs 7, boots 8. */
function wornSlots(bot: Bot): Set<number> {
  const worn = new Set<number>();
  for (const slot of [5, 6, 7, 8]) if (bot.inventory.slots[slot] != null) worn.add(slot);
  return worn;
}

/**
 * The leather pieces to craft: best protection first, for armor slots that
 * are empty and not covered by a piece already carried, within `leather`.
 */
export function leatherArmorPlan(leather: number, wornOrCarried: ReadonlySet<number>): string[] {
  const plan: string[] = [];
  let left = leather;
  for (const piece of LEATHER_PIECES) {
    if (wornOrCarried.has(piece.slot) || left < piece.leather) continue;
    plan.push(piece.item);
    left -= piece.leather;
  }
  return plan;
}

/**
 * Craft what the carried leather allows at the home table and put on any
 * armor carried. Best effort: no table or a failed craft just leaves it.
 */
export async function armorUp(bot: Bot, logger: Logger, signal?: AbortSignal): Promise<string[]> {
  const covered = wornSlots(bot);
  for (const piece of LEATHER_PIECES) if (countItem(bot, piece.item) > 0) covered.add(piece.slot);
  const plan = leatherArmorPlan(countItem(bot, "leather"), covered);
  const made: string[] = [];
  if (plan.length > 0) {
    const table = findBlockNear(bot, "crafting_table", TABLE_SCAN_RADIUS);
    if (table !== null) {
      for (const item of plan) {
        const crafted = await craftItem(bot, item, { craftingTable: table, signal });
        if (crafted.ok) made.push(item);
        else logger.warn({ item, reason: crafted.reason }, "armor: craft failed");
      }
    }
  }
  if (made.length > 0 || LEATHER_PIECES.some((piece) => countItem(bot, piece.item) > 0)) {
    await equipAllArmor(bot, signal).catch((err) => {
      if (signal?.aborted === true) throw err;
      logger.warn({ err: String(err) }, "armor: equip failed");
    });
  }
  if (made.length > 0) logger.info({ made }, "armor: crafted leather armor");
  return made;
}

/**
 * The iron combat kit the owner asked for (2026-10-21): a shield in the off
 * hand plus iron helmet, chestplate and boots. Ordered by value per ingot:
 * the one-ingot shield first, then the chestplate (6 armor for 8), helmet,
 * boots. Slots are player-window slots; 45 is the off hand.
 */
export const IRON_KIT: readonly { item: string; slot: number; iron: number }[] = [
  { item: "shield", slot: 45, iron: 1 },
  { item: "iron_chestplate", slot: 6, iron: 8 },
  { item: "iron_helmet", slot: 5, iron: 5 },
  { item: "iron_boots", slot: 8, iron: 4 },
];

/** Same-slot armor at least as good as iron (a worn diamond helmet covers iron_helmet). */
function atLeastAsGood(owned: string, wanted: string): boolean {
  if (owned === wanted) return true;
  const piece = wanted.replace(/^iron_/, "");
  return piece !== wanted && (owned === `diamond_${piece}` || owned === `netherite_${piece}`);
}

/**
 * Kit pieces neither worn nor carried, in priority order. `owned` is every
 * carried item name; `worn` maps an equipment slot to the item in it.
 */
export function missingIronKit(owned: readonly string[], worn: ReadonlyMap<number, string>): typeof IRON_KIT[number][] {
  return IRON_KIT.filter((piece) => {
    const inSlot = worn.get(piece.slot);
    if (inSlot !== undefined && atLeastAsGood(inSlot, piece.item)) return false;
    return !owned.some((name) => atLeastAsGood(name, piece.item));
  });
}

/** The kit pieces this bot still lacks. */
export function missingIronKitFor(bot: Bot): typeof IRON_KIT[number][] {
  const worn = new Map<number, string>();
  for (const slot of [5, 6, 7, 8, 45]) {
    const item = bot.inventory.slots[slot];
    if (item != null) worn.set(slot, item.name);
  }
  return missingIronKit(bot.inventory.items().map((item) => item.name), worn);
}

/** The kit pieces `ingots` pays for, in priority order. */
export function ironKitPlan(ingots: number, missing: readonly typeof IRON_KIT[number][]): string[] {
  const plan: string[] = [];
  let left = ingots;
  for (const piece of missing) {
    if (left < piece.iron) continue;
    plan.push(piece.item);
    left -= piece.iron;
  }
  return plan;
}

/** Put on every carried armor piece and move a carried shield to the off hand. */
export async function equipCarriedArmor(bot: Bot, logger: Logger, signal?: AbortSignal): Promise<void> {
  await equipAllArmor(bot, signal).catch((err) => {
    if (signal?.aborted === true) throw err;
    logger.warn({ err: String(err) }, "armor: equip failed");
  });
}
