import type { Bot } from "mineflayer";
import type { Item } from "prismarine-item";
import type { Logger } from "pino";
import type { MinecraftConfig } from "../config/schema.js";
import type { EventBus } from "../events/bus.js";
import { findItem } from "../minecraft/inventory.js";
import type { HomeLocation } from "../minecraft/movement.js";
import { normalizeDimension } from "../minecraft/protection.js";
import { countFoodItems } from "./gather-food.js";

/**
 * Phase 9: expedition mode (spec section 12).
 *
 * When a search skill must operate farther than `navigation.expedition_threshold`
 * (default 256 blocks) from home, it switches into expedition mode: a supply
 * check runs first, the search may keep expanding, and every mechanic becomes
 * risk-tiered by distance so the bot can always walk back home.
 *
 * This module is pure deterministic policy — the LLM never sees or chooses any
 * of it. Skills (`collect_resource` today) consult `ExpeditionTracker` at the
 * moment their next radius would exceed the threshold; the tracker runs the
 * supply check once per run and announces entry/denial/exit.
 *
 * Supply verification (spec 12): home known, enough food, usable tools,
 * free inventory space, acceptable health, and an executable return plan —
 * the concrete "walk home via pathfinder, above the tier health floor, with
 * food reserved for the return leg" route.
 */

/** Default expedition threshold in blocks from home (spec 12). */
export const DEFAULT_EXPEDITION_THRESHOLD = 256;

/** Food items (raw or cooked meat) that must be carried to depart and return. */
export const EXPEDITION_FOOD_RESERVE = 8;

/** Health at or below which an expedition must not start. */
export const EXPEDITION_MIN_HEALTH = 12;

/** Free inventory slots required to depart on an expedition. */
export const EXPEDITION_MIN_FREE_SLOTS = 6;

/** Fraction of tool durability (0..1) that must remain to depart. */
export const EXPEDITION_MIN_TOOL_DURABILITY = 0.5;

/** The deep band begins strictly beyond `threshold * DEEP_EXPEDITION_MULTIPLIER`. */
export const DEEP_EXPEDITION_MULTIPLIER = 2;

/** Deep-band health floor: farther out, even the return trip costs more. */
export const DEEP_MIN_HEALTH = 16;

/** Deep-band free-slot floor. */
export const DEEP_MIN_FREE_SLOTS = 10;

/** Tool families and their member items (highest tier not required). */
export const TOOL_FAMILIES: Readonly<Record<"axe" | "pickaxe", readonly string[]>> = {
  axe: ["wooden_axe", "stone_axe", "iron_axe", "gold_axe", "diamond_axe"],
  pickaxe: ["wooden_pickaxe", "stone_pickaxe", "iron_pickaxe", "gold_pickaxe", "diamond_pickaxe"],
};

/** Stone-like blocks that only drop their resource when mined with a pickaxe. */
const PICKAXE_ONLY_BLOCKS: Record<string, true> = {
  stone: true,
  cobblestone: true,
  granite: true,
  diorite: true,
  andesite: true,
  sandstone: true,
  red_sandstone: true,
  basalt: true,
  calcite: true,
};

/** Resources in the axe or pickaxe families; null needs no tool. */
export function toolFamilyFor(resource: string): "axe" | "pickaxe" | null {
  if (/_(?:log|wood|leaves)$/.test(resource)) return "axe";
  if (/_ore$/.test(resource) || PICKAXE_ONLY_BLOCKS[resource] === true) return "pickaxe";
  return null;
}

/** The configured expedition threshold in blocks from home. */
export function expeditionThreshold(config: MinecraftConfig): number {
  return config.navigation?.expedition_threshold ?? DEFAULT_EXPEDITION_THRESHOLD;
}

/** Straight-line distance of the bot from home; Infinity when home is unknown. */
export function distanceFromHome(bot: Bot, home: HomeLocation | null): number {
  const self = bot.entity;
  if (home === null || self === null) return Number.POSITIVE_INFINITY;
  const p = self.position;
  return Math.hypot(p.x - home.x, p.y - home.y, p.z - home.z);
}

/**
 * A deterministic risk band keyed by distance from home. Floor rules are
 * monotonic: the farther out, the healthier the bot must stay and the more
 * inventory headroom it must keep, because the return trip gets longer with
 * every block.
 */
export interface RiskTier {
  name: "near" | "expedition" | "deep";
  /** Health at or below which work breaks off in this band (spec 27 stage 12). */
  minHealth: number;
  /** Free slots that must remain while working in this band. */
  minFreeSlots: number;
}

/** Normal operation: within the expedition threshold (pre-Phase 9 behavior). */
export const NEAR_TIER: RiskTier = { name: "near", minHealth: 8, minFreeSlots: 1 };

/** Expedition band: beyond the threshold, up to the deep multiplier. */
export const EXPEDITION_TIER: RiskTier = {
  name: "expedition",
  minHealth: EXPEDITION_MIN_HEALTH,
  minFreeSlots: EXPEDITION_MIN_FREE_SLOTS,
};

/** Deep band: beyond `threshold * DEEP_EXPEDITION_MULTIPLIER`. */
export const DEEP_TIER: RiskTier = { name: "deep", minHealth: DEEP_MIN_HEALTH, minFreeSlots: DEEP_MIN_FREE_SLOTS };

/** The tier applying at `distance` blocks from home (unknown distance = near). */
export function tierForDistance(distance: number, threshold: number): RiskTier {
  if (!Number.isFinite(distance) || distance <= threshold) return NEAR_TIER;
  if (distance > threshold * DEEP_EXPEDITION_MULTIPLIER) return DEEP_TIER;
  return EXPEDITION_TIER;
}

/**
 * True when a tool's remaining durability is acceptable for an expedition
 * (spec 12: "required tools exist and have acceptable durability"). Items
 * with no durability model (maxDurability <= 0) always pass.
 */
export function hasAcceptableDurability(maxDurability: number, durabilityUsed: number): boolean {
  if (!Number.isFinite(maxDurability) || maxDurability <= 0) return true;
  const remaining = 1 - durabilityUsed / maxDurability;
  return remaining >= EXPEDITION_MIN_TOOL_DURABILITY;
}

/** True when the item is a durable (or non-degradable) tool, not a broken one. */
export function itemHasAcceptableDurability(item: Item): boolean {
  return hasAcceptableDurability(item.maxDurability, item.durabilityUsed);
}

/** True when at least one member of the family is carried with usable durability. */
export function hasUsableFamilyTool(bot: Bot, family: "axe" | "pickaxe"): boolean {
  return TOOL_FAMILIES[family].some((name) => {
    const item = findItem(bot, name);
    return item !== null && itemHasAcceptableDurability(item);
  });
}

/** Inventory/self snapshot the supply check reasons over; plain data, testable. */
export interface ExpeditionSupplies {
  /** Required tool family for the work; null when the resource needs no tool. */
  toolFamily: "axe" | "pickaxe" | null;
  /** True when a durable tool of the family is carried. */
  hasUsableTool: boolean;
  /** Carried food items (raw or cooked meat). */
  food: number;
  /** Free inventory slots. */
  freeSlots: number;
  /** Current health. */
  health: number;
  /** Current dimension, normalized; null before spawn. */
  dimension: string | null;
}

/** Snapshot the bot's current supplies deterministically. */
export function snapshotExpeditionSupplies(bot: Bot, toolFamily: "axe" | "pickaxe" | null): ExpeditionSupplies {
  return {
    toolFamily,
    hasUsableTool: toolFamily === null || hasUsableFamilyTool(bot, toolFamily),
    food: countFoodItems(bot),
    freeSlots: bot.inventory.emptySlotCount(),
    health: bot.health,
    dimension: bot.entity === null ? null : normalizeDimension(bot.game.dimension ?? ""),
  };
}

/**
 * The deterministic plan to walk home: the home anchor, the food reserved for
 * the return leg, and the health floor governing it. It exists only when home
 * is known and sits in the current dimension — a home in another dimension
 * cannot be walked to, so no return strategy exists and the expedition is
 * refused.
 */
export interface ReturnPlan {
  home: HomeLocation;
  /** Straight-line distance home at planning time. */
  distance: number;
  /** Food items kept for the return trip. */
  foodReserve: number;
  /** Health floor maintained on the return trip. */
  healthFloor: number;
}

/** The executable return plan, or null when walking home is impossible. */
export function planReturn(home: HomeLocation | null, supplies: ExpeditionSupplies, distance: number): ReturnPlan | null {
  if (home === null) return null;
  if (supplies.dimension !== null && supplies.dimension !== home.dimension) return null;
  return {
    home,
    distance,
    foodReserve: EXPEDITION_FOOD_RESERVE,
    healthFloor: EXPEDITION_MIN_HEALTH,
  };
}

/** Result of the Phase 9 pre-expedition supply verification. */
export interface SupplyCheckReport {
  ok: boolean;
  /** One failure per unmet requirement; empty when `ok`. */
  failures: string[];
  plan: ReturnPlan | null;
  /** Risk band of the starting distance. */
  tier: RiskTier;
}

/**
 * The full supply verification run before entering expedition mode (spec 12):
 * home known + reachable (return plan), enough food, usable required tool,
 * free inventory space, acceptable health. Every unmet requirement is listed
 * so the refusal message names the actual blocker.
 */
export function checkExpeditionSupplies(
  supplies: ExpeditionSupplies,
  home: HomeLocation | null,
  threshold: number,
  distance: number,
): SupplyCheckReport {
  const failures: string[] = [];
  const plan = planReturn(home, supplies, distance);
  if (plan === null) {
    failures.push(
      home === null
        ? "no home coordinate configured"
        : "home is in another dimension, too far to walk back",
    );
  }
  if (supplies.food < EXPEDITION_FOOD_RESERVE) {
    failures.push(`only ${supplies.food}/${EXPEDITION_FOOD_RESERVE} food carried for the trip`);
  }
  if (supplies.toolFamily !== null && !supplies.hasUsableTool) {
    failures.push(`no ${supplies.toolFamily} with ${Math.round(EXPEDITION_MIN_TOOL_DURABILITY * 100)}% durability left`);
  }
  if (supplies.freeSlots < EXPEDITION_MIN_FREE_SLOTS) {
    failures.push(`only ${supplies.freeSlots}/${EXPEDITION_MIN_FREE_SLOTS} free inventory slots`);
  }
  if (supplies.health < EXPEDITION_MIN_HEALTH) {
    failures.push(`health ${supplies.health}/20 is below the ${EXPEDITION_MIN_HEALTH} expedition floor`);
  }
  return { ok: failures.length === 0, failures, plan, tier: tierForDistance(distance, threshold) };
}

/** Options the tracker needs to run the supply check and announce transitions. */
export interface ExpeditionEntryOptions {
  bot: Bot;
  /** Home anchor; null when home is unknown. */
  home: HomeLocation | null;
  /** Configured expedition threshold in blocks from home. */
  threshold: number;
  /** Tool family the underlying work requires; null when none. */
  toolFamily: "axe" | "pickaxe" | null;
}

/**
 * Per-run expedition lifecycle: entry gate + status messages/events. Skills
 * reset it at run start, call `enter` just before their first beyond-threshold
 * step, and `leave` once back within the threshold. Transitions are announced
 * in-game (spec 12: "clear status messages") and mirrored as bus events.
 * The tracker holds no bot mechanics — all decisions are `checkExpeditionSupplies`.
 */
export class ExpeditionTracker {
  private active = false;

  constructor(
    private readonly bus: EventBus,
    private readonly logger: Logger,
  ) {}

  get isActive(): boolean {
    return this.active;
  }

  /** Forget expedition state between runs of a skill. */
  reset(): void {
    this.active = false;
  }

  /**
   * Phase 9 entry gate: run the supply check and, on success, switch this run
   * into expedition mode. Idempotent within a run. On refusal the run must
   * not expand beyond the threshold; on success the search may continue under
   * the expedition risk tiers.
   */
  enter(options: ExpeditionEntryOptions): { ok: true } | { ok: false; failures: string[] } {
    if (this.active) return { ok: true };
    const { bot, home, threshold, toolFamily } = options;
    const supplies = snapshotExpeditionSupplies(bot, toolFamily);
    const distance = distanceFromHome(bot, home);
    const report = checkExpeditionSupplies(supplies, home, threshold, distance);
    if (!report.ok) {
      this.bus.emit("expedition.denied", { distanceFromHome: distance, failures: report.failures });
      return { ok: false, failures: report.failures };
    }
    this.active = true;
    this.announce(`Entering expedition mode: ${Math.round(distance)} blocks from home.`, bot);
    this.bus.emit("expedition.entered", { distanceFromHome: distance, tier: report.tier.name });
    return { ok: true };
  }

  /**
   * End the expedition once the bot is back within the threshold, announcing
   * the exit. Keeps the mode active while the bot is still far out (e.g. a
   * failed return), because the risk tiers must keep applying until home.
   */
  leave(bot: Bot, home: HomeLocation | null, threshold: number): void {
    if (!this.active) return;
    const distance = distanceFromHome(bot, home);
    if (distance <= threshold) {
      this.active = false;
      this.announce(`Leaving expedition mode: back within ${threshold} blocks of home.`, bot);
      this.bus.emit("expedition.left", { distanceFromHome: distance });
    }
  }

  private announce(message: string, bot: Bot): void {
    this.logger.info({ message }, "expedition status");
    if (bot.entity === null) return;
    try {
      bot.chat(message);
    } catch (err) {
      this.logger.warn({ err: String(err) }, "expedition chat failed");
    }
  }
}