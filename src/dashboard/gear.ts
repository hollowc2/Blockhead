import type { Bot } from "mineflayer";
import { FOOD_ITEM_NAMES } from "../skills/gather-food.js";
import { EXPEDITION_FOOD_RESERVE, EXPEDITION_MIN_FREE_SLOTS, EXPEDITION_MIN_TOOL_DURABILITY, EXPEDITION_MIN_HEALTH } from "../skills/expedition.js";
import { EQUIPMENT_SLOTS } from "./types.js";

/**
 * Gear condition and supply readiness for the private viewer: durability and
 * enchantments of what CobbleBob wears and carries, free inventory space,
 * and how much of each supply is in his pockets versus the home chests (as
 * last seen open). Item metadata stays private; the public gear tab keeps
 * names and counts only.
 */

export interface ItemCondition {
  name: string;
  count: number;
  /** Uses left out of the item's maximum; null for items that never wear. */
  durability: { remaining: number; max: number; percent: number } | null;
  enchantments: readonly { name: string; level: number }[];
}

export interface SupplyLine { key: string; label: string; carried: number; stored: number; target: number | null }
export interface ReadinessCheck { key: string; label: string; ok: boolean; detail: string }

export interface GearDetail {
  equipment: Record<typeof EQUIPMENT_SLOTS[number], ItemCondition | null>;
  /** Carried wearable items (spare tools, weapons, armor) with their condition. */
  tools: readonly ItemCondition[];
  slots: { used: number; free: number; total: number };
  supplies: readonly SupplyLine[];
  readiness: readonly ReadinessCheck[];
  /** When a home chest was last read open; null when none has been. */
  storageSeenAt: string | null;
}

interface ItemLike { name: string; count: number; maxDurability?: number; durabilityUsed?: number; enchants?: readonly { name?: string; lvl?: number }[] | null }

const bare = (name: string): string => name.replace(/^minecraft:/, "");

export function itemCondition(item: ItemLike): ItemCondition {
  const max = typeof item.maxDurability === "number" && Number.isFinite(item.maxDurability) ? item.maxDurability : 0;
  const used = typeof item.durabilityUsed === "number" && Number.isFinite(item.durabilityUsed) ? item.durabilityUsed : 0;
  let enchants: readonly { name?: string; lvl?: number }[] = [];
  try { enchants = Array.isArray(item.enchants) ? item.enchants : []; } catch { enchants = []; }
  return {
    name: bare(item.name),
    count: item.count,
    durability: max > 0 ? { remaining: Math.max(0, max - used), max, percent: Math.max(0, Math.round(((max - used) / max) * 100)) } : null,
    enchantments: enchants.filter((e) => typeof e?.name === "string").map((e) => ({ name: bare(e.name!), level: typeof e.lvl === "number" ? e.lvl : 1 })),
  };
}

const SUPPLIES: readonly { key: string; label: string; match: (name: string) => boolean; stockpile?: "food" | "torches" | "wood" | "fuel" }[] = [
  { key: "food", label: "Food", match: (name) => FOOD_ITEM_NAMES[name] === true, stockpile: "food" },
  { key: "torches", label: "Torches", match: (name) => name === "torch", stockpile: "torches" },
  { key: "wood", label: "Logs & planks", match: (name) => /_(?:log|wood|planks)$/.test(name) || /^stripped_.*_log$/.test(name), stockpile: "wood" },
  { key: "fuel", label: "Coal & charcoal", match: (name) => name === "coal" || name === "charcoal" || name === "coal_block", stockpile: "fuel" },
  { key: "stone", label: "Cobblestone", match: (name) => name === "cobblestone" || name === "cobbled_deepslate" },
  { key: "iron", label: "Iron", match: (name) => name === "iron_ingot" || name === "raw_iron" },
];

const TIERS = ["wooden", "golden", "stone", "iron", "diamond", "netherite"];
const TOOL = /_(?:pickaxe|axe|shovel|hoe|sword)$|^(?:bow|crossbow|shield|shears|fishing_rod|flint_and_steel|trident)$/;
const ARMOR = /_(?:helmet|chestplate|leggings|boots)$/;

export interface GearInput {
  bot: Bot;
  /** Name → count summed over home chests as last opened. */
  stored: Readonly<Record<string, number>>;
  storageSeenAt: string | null;
  targets?: Partial<Record<"food" | "torches" | "wood" | "fuel", number>> | null;
}

export function projectGearDetail(input: GearInput): GearDetail {
  const { bot } = input;
  const equipped = Object.fromEntries(EQUIPMENT_SLOTS.map((slot) => {
    const item = slot === "off-hand" && bot.supportFeature?.("doesntHaveOffHandSlot") ? null
      : slot === "hand" ? bot.heldItem
      : bot.inventory.slots?.[bot.getEquipmentDestSlot?.(slot)];
    return [slot, item ? itemCondition(item as unknown as ItemLike) : null];
  })) as GearDetail["equipment"];

  const items = bot.inventory.items() as unknown as ItemLike[];
  const tools = items.filter((item) => TOOL.test(bare(item.name)) || ARMOR.test(bare(item.name))).map(itemCondition)
    .sort((a, b) => (a.durability?.percent ?? 101) - (b.durability?.percent ?? 101));
  // Main inventory and hotbar (slots 9-44); armor and off hand have their own slots.
  const total = 36;
  const free = typeof bot.inventory.emptySlotCount === "function" ? Math.min(total, bot.inventory.emptySlotCount()) : Math.max(0, total - items.length);

  const carried: Record<string, number> = {};
  for (const item of items) carried[bare(item.name)] = (carried[bare(item.name)] ?? 0) + item.count;
  const sum = (counts: Readonly<Record<string, number>>, match: (name: string) => boolean): number =>
    Object.entries(counts).reduce((total, [name, count]) => total + (match(bare(name)) ? count : 0), 0);
  const supplies = SUPPLIES.map((supply) => ({
    key: supply.key, label: supply.label, carried: sum(carried, supply.match), stored: sum(input.stored, supply.match),
    target: supply.stockpile === undefined ? null : input.targets?.[supply.stockpile] ?? null,
  }));

  const all = [...Object.values(equipped).filter((item): item is ItemCondition => item !== null), ...tools];
  // The tool Bob would reach for: the best tier still above the wear limit,
  // else the best tier at all (ties go to the less worn one).
  const usable = (item: ItemCondition): boolean => (item.durability?.percent ?? 100) >= EXPEDITION_MIN_TOOL_DURABILITY * 100;
  const tier = (item: ItemCondition): number => TIERS.findIndex((prefix) => item.name.startsWith(`${prefix}_`));
  const best = (pattern: RegExp): ItemCondition | null => all.filter((item) => pattern.test(item.name))
    .sort((a, b) => Number(usable(b)) - Number(usable(a)) || tier(b) - tier(a) || (b.durability?.percent ?? 100) - (a.durability?.percent ?? 100))[0] ?? null;
  const toolCheck = (key: string, label: string, pattern: RegExp): ReadinessCheck => {
    const item = best(pattern);
    if (item === null) return { key, label, ok: false, detail: "none carried" };
    const percent = item.durability?.percent ?? 100;
    return { key, label, ok: percent >= EXPEDITION_MIN_TOOL_DURABILITY * 100, detail: `${item.name.replace(/_/g, " ")} · ${percent}%` };
  };
  const food = supplies.find((supply) => supply.key === "food")!.carried;
  const torches = supplies.find((supply) => supply.key === "torches")!.carried;
  const armor = (["head", "torso", "legs", "feet"] as const).filter((slot) => equipped[slot] !== null).length;
  const health = typeof bot.health === "number" ? bot.health : 0;
  const readiness: ReadinessCheck[] = [
    { key: "health", label: "Health", ok: health >= EXPEDITION_MIN_HEALTH, detail: `${Math.round(health)} / 20` },
    { key: "food", label: "Food carried", ok: food >= EXPEDITION_FOOD_RESERVE, detail: `${food} (need ${EXPEDITION_FOOD_RESERVE})` },
    { key: "space", label: "Free slots", ok: free >= EXPEDITION_MIN_FREE_SLOTS, detail: `${free} of ${total} (need ${EXPEDITION_MIN_FREE_SLOTS})` },
    toolCheck("pickaxe", "Pickaxe", /_pickaxe$/),
    toolCheck("axe", "Axe", /(?<!pick)_axe$/),
    toolCheck("weapon", "Weapon", /_sword$|^(?:bow|crossbow|trident)$/),
    { key: "torches", label: "Torches carried", ok: torches >= 16, detail: `${torches} (need 16)` },
    { key: "armor", label: "Armor worn", ok: armor >= 3, detail: `${armor} of 4 pieces` },
  ];
  return { equipment: equipped, tools, slots: { used: total - free, free, total }, supplies, readiness, storageSeenAt: input.storageSeenAt };
}

/** Sum the remembered contents of every chest; the newest read time comes along. */
export function storedContents(chests: readonly { lastContents?: Record<string, number>; lastSeenAt: string | null }[]): { stored: Record<string, number>; seenAt: string | null } {
  const stored: Record<string, number> = {};
  let seenAt: string | null = null;
  for (const chest of chests) {
    if (chest.lastContents === undefined) continue;
    for (const [name, count] of Object.entries(chest.lastContents)) {
      if (typeof count === "number" && Number.isFinite(count)) stored[bare(name)] = (stored[bare(name)] ?? 0) + count;
    }
    if (chest.lastSeenAt !== null && (seenAt === null || chest.lastSeenAt > seenAt)) seenAt = chest.lastSeenAt;
  }
  return { stored, seenAt };
}
