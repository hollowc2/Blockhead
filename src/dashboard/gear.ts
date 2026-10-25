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

/** `stored` is null until a home chest has been opened: unknown, not zero. */
export interface SupplyLine { key: string; label: string; carried: number; stored: number | null; target: number | null }
/** `item` names the tool a tool check judged, when one is carried. */
export interface ReadinessCheck { key: string; label: string; ok: boolean; detail: string; item?: string }

/** The kind of work Bob is about to do; readiness is judged for that job, not a generic expedition. */
export type ReadinessJob = "building" | "mining" | "gathering" | "travelling";
/** A preparation step the owner can ask for; `command` is sent through the normal owner command channel. */
export interface PreparationAction { key: string; label: string; command: string }
export interface JobReadiness {
  job: ReadinessJob;
  /** What the job is, e.g. "Gathering oak log"; null when only the kind is known. */
  subject: string | null;
  status: "ready" | "partial" | "not-ready";
  /** Plain result, e.g. "Mining preparation: replace pickaxe and unload inventory." */
  headline: string;
  checks: readonly ReadinessCheck[];
  actions: readonly PreparationAction[];
}

const JOB_CHECKS: Record<ReadinessJob, readonly string[]> = {
  mining: ["health", "food", "space", "pickaxe", "torches", "weapon"],
  gathering: ["health", "food", "space", "axe", "weapon"],
  building: ["health", "food", "space"],
  travelling: ["health", "food", "weapon", "armor", "space"],
};
const JOB_NOUN: Record<ReadinessJob, string> = { mining: "Mining", gathering: "Gathering", building: "Building", travelling: "Travel" };

/** A worn tool is replaced at its own tier; a missing one starts at stone. */
const replacement = (check: ReadinessCheck, family: string): string => {
  const tier = check.item?.match(/^([a-z]+)_/)?.[1];
  return `${tier !== undefined && tier !== "wooden" && tier !== "golden" ? tier : "stone"} ${family}`;
};
/**
 * What to do about each failed check: a short verb phrase and an owner
 * command worded so the command model picks the matching tool
 * (eat, ensure_item, store_items, equip_best).
 */
const FIXES: Record<string, { phrase: (check: ReadinessCheck) => string; command: (check: ReadinessCheck) => string }> = {
  health: { phrase: () => "heal up", command: () => "eat some food to heal up" },
  food: { phrase: () => "pack food", command: () => `get ${EXPEDITION_FOOD_RESERVE} bread` },
  space: { phrase: () => "unload inventory", command: () => "store everything you're carrying in the home chest" },
  pickaxe: { phrase: (c) => c.item ? "replace pickaxe" : "make a pickaxe", command: (c) => `get a new ${replacement(c, "pickaxe")}` },
  axe: { phrase: (c) => c.item ? "replace axe" : "make an axe", command: (c) => `get a new ${replacement(c, "axe")}` },
  weapon: { phrase: (c) => c.item ? "replace weapon" : "make a sword", command: (c) => `get a new ${replacement(c, "sword")}` },
  torches: { phrase: () => "pack torches", command: () => "get 16 torches" },
  armor: { phrase: () => "put on armor", command: () => "equip your best armor" },
};

const joinPhrases = (parts: string[]): string => parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;

/** Narrow the general checklist to the job at hand and phrase the outcome plainly. */
export function jobReadiness(job: ReadinessJob, readiness: readonly ReadinessCheck[], subject: string | null = null): JobReadiness {
  const checks = JOB_CHECKS[job].map((key) => readiness.find((check) => check.key === key)).filter((check): check is ReadinessCheck => check !== undefined);
  const failed = checks.filter((check) => !check.ok);
  const status = failed.length === 0 ? "ready" : failed.length === checks.length ? "not-ready" : "partial";
  const phrases = failed.map((check) => FIXES[check.key]?.phrase(check) ?? check.label.toLowerCase());
  const headline = `${JOB_NOUN[job]} preparation: ${failed.length === 0 ? "ready to go" : joinPhrases(phrases)}.`;
  const actions = failed.flatMap((check) => {
    const fix = FIXES[check.key];
    return fix ? [{ key: check.key, label: fix.phrase(check).replace(/^./, (c) => c.toUpperCase()), command: fix.command(check) }] : [];
  });
  return { job, subject, status, headline, checks, actions };
}

interface TaskLike { type: string; parameters: Record<string, unknown>; status?: string; heldAt?: string; priority?: number }
const MINED = /ore$|^(?:cobblestone|stone|cobbled_deepslate|deepslate|coal|raw_(?:iron|copper|gold)|iron_ingot|copper_ingot|gold_ingot|diamond|emerald|redstone|lapis_lazuli|obsidian|andesite|diorite|granite|tuff|calcite|flint|gravel)$/;
const words = (name: unknown): string => String(name ?? "").replace(/^minecraft:/, "").replace(/_/g, " ").trim();

/** Which kind of work a task is, with a short subject; null for chores that aren't a job (eating, storing, crafting). */
export function jobForTask(task: TaskLike): { job: ReadinessJob; subject: string } | null {
  const p = task.parameters ?? {};
  switch (task.type) {
    case "collect_resource": {
      const resource = String(p.resource ?? "").replace(/^minecraft:/, "");
      return MINED.test(resource) ? { job: "mining", subject: `Mining ${words(resource)}` } : { job: "gathering", subject: `Gathering ${words(resource)}` };
    }
    case "stockpile_maintenance":
      return p.kind === "fuel" || p.kind === "torches" ? { job: "mining", subject: `Restocking ${words(p.kind)}` } : { job: "gathering", subject: `Restocking ${words(p.kind)}` };
    case "gather_food": case "hunt":
      return { job: "gathering", subject: "Gathering food" };
    case "travel_to": case "explore": case "go_home": case "death_recovery": case "recover_death_items":
      return { job: "travelling", subject: task.type === "go_home" ? "Travelling home" : task.type === "explore" ? "Exploring" : task.type === "travel_to" ? "Travelling" : "Recovering dropped items" };
    case "build_base": case "build_design": case "build_structure": case "build_project_acquire": case "build_project_slice": case "build_project_verify": case "light_home": case "create_storage":
      return { job: "building", subject: "Building" };
    case "develop_land": case "world_project_acquire": case "world_project_slice": case "world_project_verify": case "world_project_return": case "world_project_deposit": case "world_project_replace_tool":
      return { job: "building", subject: "Working on the land" };
    default:
      return null;
  }
}

/**
 * The job readiness is judged for: the active task when it is real work,
 * otherwise the next queued job that isn't held by the owner (highest
 * priority first), otherwise an open build project.
 */
export function upcomingJob(active: TaskLike | null, queued: readonly TaskLike[], building: boolean): { job: ReadinessJob; subject: string } | null {
  const now = active === null ? null : jobForTask(active);
  if (now !== null) return now;
  const next = [...queued].filter((task) => task.heldAt === undefined && (task.status === undefined || task.status === "queued" || task.status === "paused"))
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
    .map(jobForTask).find((job) => job !== null);
  return next ?? (building ? { job: "building", subject: "Building" } : null);
}

export interface GearDetail {
  equipment: Record<typeof EQUIPMENT_SLOTS[number], ItemCondition | null>;
  /** Carried wearable items (spare tools, weapons, armor) with their condition. */
  tools: readonly ItemCondition[];
  slots: { used: number; free: number; total: number };
  supplies: readonly SupplyLine[];
  readiness: readonly ReadinessCheck[];
  /** Readiness judged for the upcoming job; null when no job is known. */
  jobReadiness?: JobReadiness | null;
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
  /** Name → count summed over home chests as last opened; null when none has been opened. */
  stored: Readonly<Record<string, number>> | null;
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
    key: supply.key, label: supply.label, carried: sum(carried, supply.match), stored: input.stored === null ? null : sum(input.stored, supply.match),
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
    return { key, label, ok: percent >= EXPEDITION_MIN_TOOL_DURABILITY * 100, detail: `${item.name.replace(/_/g, " ")} · ${percent}%`, item: item.name };
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

/** Sum the remembered contents of every chest; the newest read time comes along. Null when no chest has been read. */
export function storedContents(chests: readonly { lastContents?: Record<string, number>; lastSeenAt: string | null }[]): { stored: Record<string, number> | null; seenAt: string | null } {
  const stored: Record<string, number> = {};
  let seenAt: string | null = null, read = false;
  for (const chest of chests) {
    if (chest.lastContents === undefined) continue;
    read = true;
    for (const [name, count] of Object.entries(chest.lastContents)) {
      if (typeof count === "number" && Number.isFinite(count)) stored[bare(name)] = (stored[bare(name)] ?? 0) + count;
    }
    if (chest.lastSeenAt !== null && (seenAt === null || chest.lastSeenAt > seenAt)) seenAt = chest.lastSeenAt;
  }
  return { stored: read ? stored : null, seenAt };
}
