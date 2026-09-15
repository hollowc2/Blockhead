import type { Bot } from "mineflayer";
import type { Block } from "prismarine-block";
import type { Item } from "prismarine-item";
import type { Logger } from "pino";
import { Vec3 } from "vec3";
import type { AgentState } from "../agent/state.js";
import type { TaskSignals } from "../agent/scheduler.js";
import type { MinecraftConfig } from "../config/schema.js";
import type { EventBus } from "../events/bus.js";
import type { SkillsRepository } from "../memory/skills.js";
import {
  STORAGE_CATEGORIES,
  type StorageCategory,
  type StorageLocation,
  type StorageRepository,
} from "../memory/storage.js";
import {
  countLogs,
  countPlanks,
  findItem,
  itemsSummary,
} from "../minecraft/inventory.js";
import { craftItem, craftPlanks } from "../minecraft/crafting.js";
import {
  isChestBlock,
  measureStorage,
  transferItem,
  type ChestMeasurement,
  type StorageMeasurement,
} from "../minecraft/containers.js";
import { travelAndWait } from "../minecraft/movement.js";
import {
  findBlockNear,
  findBlocksNear,
  findPlacementSpot,
  isRawLog,
  placeItemAt,
  type PlacementSpot,
} from "../minecraft/world.js";
import { ChatThrottle, gameChatBudgetAllows, withTimeout, type SkillErrorCode, type SkillResult } from "./skill-library.js";
import { freeChestSlotSpot } from "./base.js";

/**
 * Phase 11: storage organization (spec sections 14.4, 22, 23).
 *
 * `organize_storage()` deterministically measures every registered home
 * chest, creates new chests when storage is full or a category is
 * disorganized, and moves items into the chest of their category. The
 * `create_storage(category)` registration path creates exactly one chest for
 * a category. All Minecraft mechanics — measuring slots, crafting planks and
 * chests, placing blocks, transferring items — are deterministic code; the
 * LLM only chooses `organize_storage` / `create_storage` / `register_storage`
 * tool calls (spec 14.4).
 *
 * Categories start simple (spec 22): one general chest is enough until the
 * organizer creates per-category chests as capacity and organization demand:
 *
 *  - A registered chest at >= CHEST_FULL_RATIO of its slots -> a new chest
 *    for that category.
 *  - A category with no chest holding >= CATEGORY_CHEST_MIN_ITEMS -> a new
 *    chest for that category ("better organization is required").
 *  - Overall utilization at >= STORAGE_FULL_RATIO -> a new general chest.
 */

// --- deterministic policy constants ---

/** Wall-clock budget for one home/site trip. */
const TRAVEL_TIMEOUT_MS = 120_000;
/** Wall-clock budget for one wood-collection pass. */
const COLLECT_TIMEOUT_MS = 240_000;
/** Scan radius for the home crafting table. */
const TABLE_SCAN_RADIUS = 12;
/** Initial log-search radius; expands by 2x up to MAX_SEARCH_RADIUS. */
const LOG_SEARCH_RADIUS = 48;
/** Largest radius a log search reaches before giving up. */
const MAX_SEARCH_RADIUS = 256;
/** Candidate blocks considered per log-search radius. */
const CANDIDATES_PER_RADIUS = 24;
/** Planks one chest recipe consumes (spec 22 / bootstrap STORAGE). */
const CHEST_PLANK_COST = 8;
/** Planks one crafting-table recipe consumes (2x2). */
const TABLE_PLANK_COST = 4;
/** Slot utilization at which a single registered chest counts as full. */
export const CHEST_FULL_RATIO = 0.9;
/** Overall slot utilization at which the system creates a general chest. */
export const STORAGE_FULL_RATIO = 0.8;
/** Items of a category (with no chest yet) that justify creating one. */
export const CATEGORY_CHEST_MIN_ITEMS = 12;
/** New chests one organize run creates (bounds a single task). */
export const MAX_CHESTS_PER_RUN = 2;
/** Items one organize run moves before re-measuring (bounds the task). */
export const MAX_MOVES_PER_RUN = 128;

// --- deterministic category mapping (spec 22's initial categories) ---

/** Raw meat, cooked meat, fish, and plant food the FOOD category owns. */
const FOOD_ITEM_NAMES: ReadonlySet<string> = new Set([
  "apple",
  "bread",
  "carrot",
  "potato",
  "baked_potato",
  "pumpkin_pie",
  "cake",
  "cookie",
  "melon",
  "pumpkin",
  "beef",
  "porkchop",
  "mutton",
  "chicken",
  "rabbit",
  "fish",
  "salmon",
  "cooked_beef",
  "cooked_porkchop",
  "cooked_mutton",
  "cooked_chicken",
  "cooked_rabbit",
  "cooked_fish",
  "cooked_salmon",
]);

/** Gems, netherite, and their equipment (spec 24.1's critical set). */
function isValuableItemName(name: string): boolean {
  return (
    name === "diamond" ||
    name === "emerald" ||
    name.startsWith("diamond_") ||
    name.startsWith("emerald_") ||
    name.startsWith("netherite_") ||
    name.startsWith("enchanted_")
  );
}

/** Equipment: tools, weapons, armor, shields, bows, and arrows. */
function isEquipmentItemName(name: string): boolean {
  return (
    name === "bow" ||
    name === "arrow" ||
    name === "shield" ||
    name === "fishing_rod" ||
    /_(axe|pickaxe|shovel|hoe|sword|helmet|chestplate|leggings|boots)$/.test(name)
  );
}

/** Wood materials: logs, stripped wood, planks, sticks, and derived wood. */
function isWoodItemName(name: string): boolean {
  return name === "stick" || /_(log|wood|planks|fence|door|boat|sapling)$/.test(name);
}

/** Stone and earth materials the STONE category owns. */
const STONE_ITEM_NAMES: ReadonlySet<string> = new Set([
  "stone",
  "cobblestone",
  "granite",
  "diorite",
  "andesite",
  "basalt",
  "sandstone",
  "red_sandstone",
  "gravel",
  "brick",
  "bricks",
  "stone_bricks",
]);

/** Refined ore products: ore blocks, raw ores, ingots, nuggets, coal. */
function isOreItemName(name: string): boolean {
  return (
    name === "coal" ||
    name === "charcoal" ||
    name === "redstone" ||
    name === "lapis_lazuli" ||
    name === "quartz" ||
    name.startsWith("raw_") ||
    /_(ore|ingot|nugget)$/.test(name)
  );
}

/** Drops taken from mobs. */
const MOB_DROP_ITEM_NAMES: ReadonlySet<string> = new Set([
  "leather",
  "feather",
  "bone",
  "bone_meal",
  "string",
  "gunpowder",
  "slime_ball",
  "egg",
  "rotten_flesh",
  "rabbit_foot",
  "rabbit_hide",
]);

/** Every owned item maps to exactly one storage category. */
export function storageCategoryFor(itemName: string): StorageCategory {
  const name = itemName.replace(/^minecraft:/, "");
  if (isValuableItemName(name)) return "valuables";
  if (FOOD_ITEM_NAMES.has(name)) return "food";
  if (isEquipmentItemName(name)) return "equipment";
  if (isWoodItemName(name)) return "wood";
  if (STONE_ITEM_NAMES.has(name)) return "stone";
  if (isOreItemName(name)) return "ores";
  if (MOB_DROP_ITEM_NAMES.has(name)) return "mob_drops";
  return "misc";
}

// --- expansion decision (pure, unit-tested) ---

/**
 * Coerce a registered category string to the known category set. Registered
 * categories are inserted by deterministic code, so unknown strings only
 * occur for hand-edited databases; they fall back to the general bucket.
 */
export function normalizeCategory(category: string): StorageCategory {
  return STORAGE_CATEGORIES.includes(category as StorageCategory) ? (category as StorageCategory) : "general";
}

/** What the organize run should do next, if anything. */
export interface StorageDecision {
  expand: boolean;
  /** Category for the chest to create, or null when nothing is needed. */
  createCategory: StorageCategory | null;
  reason: string | null;
}

/**
 * Decide whether storage needs a new chest. Deterministic rules (Phase 11):
 *
 *  1. No registered storage at all -> create a general chest (spec 22).
 *  2. Registered storage exists but nothing could be read and at least one
 *     registered position is not a chest anymore -> create general (the old
 *     chests are gone; busy chests are skipped and return no work).
 *  3. A registered chest is at/over CHEST_FULL_RATIO -> create another chest
 *     of that chest's category.
 *  4. A category without a chest holds >= CATEGORY_CHEST_MIN_ITEMS ->
 *     create that category's first chest ("better organization is
 *     required").
 *  5. Overall utilization at/over STORAGE_FULL_RATIO -> create general.
 *  6. Otherwise nothing is needed.
 */
export function decideStorageWork(
  measurement: StorageMeasurement,
  registered: readonly StorageLocation[],
): StorageDecision {
  if (registered.length === 0) {
    return { expand: true, createCategory: "general", reason: "no storage at home" };
  }
  if (!measurement.reachable) {
    if (measurement.missingChests > 0) {
      return { expand: true, createCategory: "general", reason: "registered storage is gone" };
    }
    // Every registered chest is busy; re-check on a later pass.
    return { expand: false, createCategory: null, reason: null };
  }

  // 3. Full chest: expand the fullest one's category.
  let fullest: ChestMeasurement | null = null;
  for (const chest of measurement.chests) {
    if (chest.usedSlots < chest.capacitySlots * CHEST_FULL_RATIO) continue;
    if (fullest === null || chest.usedSlots / chest.capacitySlots > fullest.usedSlots / fullest.capacitySlots) {
      fullest = chest;
    }
  }
  if (fullest !== null) {
    return {
      expand: true,
      createCategory: normalizeCategory(fullest.location.category),
      reason: `the ${fullest.location.category} chest is full`,
    };
  }

  // 4. A category with no chest yet accumulated enough items to deserve one.
  const registeredCategories = new Set(registered.map((location) => location.category));
  for (const category of STORAGE_CATEGORIES) {
    if (category === "general") continue;
    if (registeredCategories.has(category)) continue;
    let held = 0;
    for (const chest of measurement.chests) {
      for (const [name, count] of Object.entries(chest.items)) {
        if (storageCategoryFor(name) === category) held += count;
      }
    }
    if (held >= CATEGORY_CHEST_MIN_ITEMS) {
      return { expand: true, createCategory: category, reason: `${held} ${category} items need a chest` };
    }
  }

  // 5. Overall utilization is high; add general capacity.
  if (measurement.slotsTotal > 0 && measurement.slotsUsed >= measurement.slotsTotal * STORAGE_FULL_RATIO) {
    return { expand: true, createCategory: "general", reason: "storage is nearly full" };
  }

  return { expand: false, createCategory: null, reason: null };
}

// --- runner ---

export interface OrganizeStorageOptions {
  bot: Bot;
  state: AgentState;
  config: MinecraftConfig;
  bus: EventBus;
  /** Home storage registrations (spec 22); the organizer reads and extends them. */
  storage: StorageRepository;
  /** Skill success records (spec 20.2). */
  skills: SkillsRepository;
  logger: Logger;
}

export interface OrganizeStorageData {
  /**
   * The category of the chest `create_storage` asked for; null for a full
   * organize run.
   */
  category: StorageCategory | null;
  chestsCreated: number;
  itemsMoved: number;
  slotsUsed: number;
  slotsTotal: number;
  /** Times this task was cooperatively interrupted (Phase 8, persisted across resumes). */
  interruptions: number;
}

/** Progress persisted as the task's resume state (Phase 8). */
export interface OrganizeResumeState {
  interruptions: number;
}

export interface OrganizeRunOptions {
  /** When set, create exactly one chest for this category (create_storage). */
  category?: StorageCategory;
  /** Cooperative signals from the owning scheduler task; null for unbound runs. */
  signals?: TaskSignals;
  /** Resume state from a paused run of the same task. */
  resumeState?: OrganizeResumeState;
}

/**
 * Deterministic `organize_storage` / `create_storage` skill. One run at a
 * time; a second run returns ALREADY_RUNNING.
 */
export class OrganizeStorageRunner {
  private running = false;

  /** Cooperative signals for the current run; null when unbound. */
  private signals: TaskSignals | null = null;
  /** True once a pause/cancel was observed; the run stops at the next boundary. */
  private stopRequested = false;
  /** Accumulated interrupts across pause/resume cycles of this task. */
  private interruptions = 0;

  /** Identical game-chat lines repeat at most once per window (spam-kick guard). */
  private readonly chatThrottle: ChatThrottle;

  constructor(private readonly opts: OrganizeStorageOptions) {
    const throttleSeconds = opts.config.background?.announce_throttle_seconds ?? 30;
    this.chatThrottle = new ChatThrottle(throttleSeconds * 1000);
  }

  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Run the organize flow, or create one chest for `category` when given.
   */
  async run(options: OrganizeRunOptions = {}): Promise<SkillResult<OrganizeStorageData>> {
    if (this.running) {
      return {
        ok: false,
        status: "blocked",
        errorCode: "ALREADY_RUNNING",
        message: "already organizing storage",
      };
    }
    this.running = true;
    this.signals = options.signals ?? null;
    this.interruptions = options.resumeState?.interruptions ?? 0;
    this.stopRequested = false;
    try {
      return await this.execute(options.category ?? null);
    } finally {
      this.running = false;
      this.signals = null;
    }
  }

  /**
   * Lightweight background probe (Phase 11 integration): measures home
   * storage and reports whether an organize/expand pass is needed, emitting
   * `storage.checked` for observability. Never modifies anything.
   */
  async needsAttention(): Promise<{ needsWork: boolean; reason: string | null }> {
    const worldId = this.opts.state.worldId;
    const registered = worldId === null ? [] : this.opts.storage.list(worldId);
    const measurement = await measureStorage(this.opts.bot, this.opts.state, this.opts.storage);
    const decision = decideStorageWork(measurement, registered);
    this.opts.bus.emit("storage.checked", {
      chests: measurement.chests.length,
      slotsUsed: measurement.slotsUsed,
      slotsTotal: measurement.slotsTotal,
      needsWork: decision.expand,
    });
    return { needsWork: decision.expand, reason: decision.reason };
  }

  private async execute(category: StorageCategory | null): Promise<SkillResult<OrganizeStorageData>> {
    const bot = this.opts.bot;
    const startedAt = Date.now();
    const baseline = itemsSummary(bot);
    const data: OrganizeStorageData = {
      category,
      chestsCreated: 0,
      itemsMoved: 0,
      slotsUsed: 0,
      slotsTotal: 0,
      interruptions: this.interruptions,
    };

    if (bot.entity === null) {
      return this.fail(data, "NOT_READY", "bot is not spawned");
    }
    const home = this.opts.state.home;
    if (home === null) {
      return this.fail(data, "STORAGE_NOT_FOUND", "no home coordinate configured");
    }
    const travel = await travelAndWait(bot, home, {
      dimension: home.dimension,
      timeoutMs: TRAVEL_TIMEOUT_MS,
      shouldAbort: this.travelAbort,
    });
    if (this.stopRequested) return this.interrupted(data);
    if (travel.status !== "arrived" && travel.status !== "already_there") {
      return this.fail(data, "PATH_UNREACHABLE", `could not reach home: ${travel.status}`);
    }

    // create_storage mode: exactly one chest for the category.
    if (category !== null) return this.createOnly(category, data, startedAt, baseline);

    const worldId = this.opts.state.worldId;
    if (worldId === null) {
      return this.fail(data, "STORAGE_NOT_FOUND", "no world");
    }

    // Expand while the decision demands it, re-measuring after each creation
    // so a fresh chest (empty, newly registered) is never re-expanded for.
    let registered = this.opts.storage.list(worldId);
    let measurement = await measureStorage(bot, this.opts.state, this.opts.storage);
    data.slotsUsed = measurement.slotsUsed;
    data.slotsTotal = measurement.slotsTotal;
    for (let pass = 0; pass < MAX_CHESTS_PER_RUN; pass++) {
      if (this.stopRequested) return this.interrupted(data);
      const decision = decideStorageWork(measurement, registered);
      if (!decision.expand) break;
      const created = await this.createChest(decision.createCategory ?? "general");
      if (this.stopRequested) return this.interrupted(data);
      if (!created.ok) return this.fail(data, "STORAGE_NOT_FOUND", created.reason);
      data.chestsCreated += 1;
      registered = this.opts.storage.list(worldId);
      measurement = await measureStorage(bot, this.opts.state, this.opts.storage);
      data.slotsUsed = measurement.slotsUsed;
      data.slotsTotal = measurement.slotsTotal;
    }
    if (this.stopRequested) return this.interrupted(data);

    // Redistribute items into their category chests (bounded by the run cap).
    const moved = await this.redistribute(measurement);
    data.itemsMoved += moved;
    if (this.stopRequested) return this.interrupted(data);

    const message =
      data.chestsCreated > 0 || data.itemsMoved > 0
        ? `Storage organized: ${data.chestsCreated} chest(s) created, ${data.itemsMoved} item(s) moved.`
        : "Storage is organized.";
    this.announce(message);
    this.recordSuccess(data, startedAt, baseline, message);
    return { ok: true, status: "completed", data, message };
  }

  /** create_storage: build and register one chest for `category`. */
  private async createOnly(
    category: StorageCategory,
    data: OrganizeStorageData,
    startedAt: number,
    baseline: Record<string, number>,
  ): Promise<SkillResult<OrganizeStorageData>> {
    const created = await this.createChest(category);
    if (this.stopRequested) return this.interrupted(data);
    if (!created.ok) return this.fail(data, "STORAGE_NOT_FOUND", created.reason);
    data.chestsCreated = 1;
    const message = `Chest placed and registered as ${category} storage.`;
    this.announce(message);
    this.recordSuccess(data, startedAt, baseline, message);
    return { ok: true, status: "completed", data, message };
  }

  /**
   * Craft (or reuse a carried) chest, place it near home on a cell that is
   * not adjacent to a registered chest (a second half would merge into a
   * double chest, which one registration cannot represent), and register it.
   */
  private async createChest(category: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const bot = this.opts.bot;
    const home = this.opts.state.home;
    const worldId = this.opts.state.worldId;
    if (home === null) return { ok: false, reason: "no home coordinate configured" };
    if (worldId === null) return { ok: false, reason: "no world" };

    const spot = await this.findChestSpot();
    if (spot === null) {
      return { ok: false, reason: "no floor space near home for a chest" };
    }
    const chestItem = await this.ensureChestItem();
    if (this.stopRequested) return { ok: false, reason: "interrupted" };
    if (!chestItem.ok) return chestItem;

    const placed = await placeItemAt(bot, chestItem.item, spot);
    if (placed === null || !isChestBlock(placed)) {
      return { ok: false, reason: "could not place the chest at home" };
    }
    this.opts.storage.register(worldId, {
      dimension: home.dimension,
      category,
      label: `${category}_chest`,
      x: placed.position.x,
      y: placed.position.y,
      z: placed.position.z,
    });
    this.opts.logger.info({ category, position: placed.position }, "storage chest created and registered");
    return { ok: true };
  }

  /** The next stockpile chest slot (center first), else a scatter cell near
   *  home with solid floor, away from registered chests. Slots keep the
   *  stockpile at its centralized location; the scatter fallback only runs
   *  when every slot is occupied (the row holds three chests). */
  private async findChestSpot(): Promise<PlacementSpot | null> {
    const bot = this.opts.bot;
    const home = this.opts.state.home;
    const worldId = this.opts.state.worldId;
    if (home === null || bot.entity === null) return null;

    const slotted = freeChestSlotSpot(bot, home);
    if (slotted !== null) return slotted;

    const exclude: Vec3[] = [];
    if (worldId !== null) {
      for (const location of this.opts.storage.list(worldId)) {
        // Orthogonally adjacent cells would merge into a double chest on
        // placement; skip them so every chest stays a single registration.
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          exclude.push(new Vec3(location.x + dx, location.y, location.z + dz));
        }
      }
    }
    return findPlacementSpot(bot, home, 4, exclude);
  }

  /** Ensure a chest item is carried: reuse, or craft one from planks. */
  private async ensureChestItem(): Promise<{ ok: true; item: Item } | { ok: false; reason: string }> {
    const bot = this.opts.bot;
    const carried = findItem(bot, "chest");
    if (carried !== null) return { ok: true, item: carried };

    if (countPlanks(bot) < CHEST_PLANK_COST) {
      const shortfall = CHEST_PLANK_COST - countPlanks(bot);
      const logsNeeded = Math.max(0, Math.ceil(shortfall / 4) - countLogs(bot));
      if (logsNeeded > 0) {
        const gathered = await this.gatherLogs(logsNeeded);
        if (this.stopRequested) return { ok: false, reason: "interrupted" };
        if (!gathered.ok) return { ok: false, reason: gathered.reason };
      }
      const planks = await craftPlanks(bot, CHEST_PLANK_COST);
      if (!planks.ok) return { ok: false, reason: planks.reason };
    }

    const table = await this.ensureTableAtHome();
    if (this.stopRequested) return { ok: false, reason: "interrupted" };
    if (table === null) return { ok: false, reason: "could not find a crafting table at home" };

    const chest = await craftItem(bot, "chest", { craftingTable: table });
    if (!chest.ok) return { ok: false, reason: chest.reason };
    const item = findItem(bot, "chest");
    return item !== null ? { ok: true, item } : { ok: false, reason: "the crafted chest vanished" };
  }

  /** The placed home crafting table, placing one when it is missing. */
  private async ensureTableAtHome(): Promise<Block | null> {
    const bot = this.opts.bot;
    const home = this.opts.state.home;
    if (home === null) return null;
    const existing = findBlockNear(bot, "crafting_table", TABLE_SCAN_RADIUS);
    if (existing !== null) return existing;

    if (countPlanks(bot) < TABLE_PLANK_COST) {
      const shortfall = TABLE_PLANK_COST - countPlanks(bot);
      const logsNeeded = Math.max(0, Math.ceil(shortfall / 4) - countLogs(bot));
      if (logsNeeded > 0) {
        const gathered = await this.gatherLogs(logsNeeded);
        if (!gathered.ok) return null;
      }
      const planks = await craftPlanks(bot, TABLE_PLANK_COST);
      if (!planks.ok) return null;
    }
    const table = await craftItem(bot, "crafting_table");
    if (!table.ok) return null;
    const item = findItem(bot, "crafting_table");
    if (item === null) return null;
    const spot = findPlacementSpot(bot, home, 4);
    if (spot === null) return null;
    const placed = await placeItemAt(bot, item, spot);
    return placed !== null && placed.name === "crafting_table" ? placed : null;
  }

  /**
   * Gather raw logs until at least `targetTotal` are carried. Same search-
   * and-collect mechanics as the bootstrap WOOD stage; a hard collection
   * error aborts the search.
   */
  private async gatherLogs(targetTotal: number): Promise<{ ok: true; have: number } | { ok: false; reason: string }> {
    const bot = this.opts.bot;
    const config = this.opts.config.bootstrap;
    const baseRadius = config?.search_radius ?? LOG_SEARCH_RADIUS;

    let have = countLogs(bot);
    for (
      let radius = baseRadius;
      radius <= MAX_SEARCH_RADIUS && have < targetTotal;
      radius = Math.min(radius * 2, MAX_SEARCH_RADIUS + 1)
    ) {
      this.checkInterrupt();
      if (this.stopRequested) return { ok: false, reason: "interrupted" };
      const positions = findBlocksNear(bot, isRawLog, radius, CANDIDATES_PER_RADIUS);
      const targets = positions.map((v) => bot.blockAt(v)).filter((block) => block !== null);
      if (targets.length === 0) continue;

      const before = have;
      try {
        await withTimeout(COLLECT_TIMEOUT_MS, bot.collectBlock.collect(targets, { ignoreNoPath: true }), () => {
          void bot.collectBlock.cancelTask();
        });
      } catch (err) {
        return { ok: false, reason: `could not collect logs: ${String(err)}` };
      }
      have = countLogs(bot);
      if (have <= before) continue;
    }

    have = countLogs(bot);
    if (have < targetTotal) return { ok: false, reason: `only ${have}/${targetTotal} logs found nearby` };
    return { ok: true, have };
  }

  /**
   * Move every misplaced item into the chest of its category, bounded by
   * MAX_MOVES_PER_RUN and cooperative checkpoints. An item is misplaced when
   * it sits in a category chest it does not belong to, or in the general
   * chest although a specific category chest exists for it. Items whose
   * category has no chest stay in general (a single general chest is
   * acceptable, spec 22). A full target chest skips the move.
   */
  private async redistribute(measurement: StorageMeasurement): Promise<number> {
    const bot = this.opts.bot;
    const worldId = this.opts.state.worldId;
    if (worldId === null) return 0;

    const byCategory = new Map<string, ChestMeasurement[]>();
    for (const chest of measurement.chests) {
      const list = byCategory.get(chest.location.category) ?? [];
      list.push(chest);
      byCategory.set(chest.location.category, list);
    }
    const registeredCategories = new Set(this.opts.storage.list(worldId).map((location) => location.category));

    let moved = 0;
    outer: for (const chest of measurement.chests) {
      const sourceCategory = chest.location.category;
      for (const [name, count] of Object.entries(chest.items)) {
        if (moved >= MAX_MOVES_PER_RUN) break outer;
        this.checkInterrupt();
        if (this.stopRequested) return moved;

        const targetCategory = storageCategoryFor(name);
        if (sourceCategory !== "general" && sourceCategory === targetCategory) continue;
        if (sourceCategory === "general") {
          if (targetCategory === "general" || !registeredCategories.has(targetCategory)) continue;
        }
        const target = this.pickTarget(byCategory, targetCategory);
        if (target === null) continue;

        const sourceBlock = bot.blockAt(new Vec3(chest.location.x, chest.location.y, chest.location.z));
        if (sourceBlock === null || !isChestBlock(sourceBlock)) continue;
        const targetBlock = bot.blockAt(new Vec3(target.location.x, target.location.y, target.location.z));
        if (targetBlock === null || !isChestBlock(targetBlock)) continue;
        if (sourceBlock === targetBlock) continue;

        const transferred = await transferItem(bot, sourceBlock, targetBlock, name, count, this.opts.logger);
        moved += transferred.moved;
        if (this.stopRequested) return moved;
      }
    }
    return moved;
  }

  /** A measured chest of `targetCategory` with room, else a general one. */
  private pickTarget(byCategory: Map<string, ChestMeasurement[]>, targetCategory: string): ChestMeasurement | null {
    const withRoom = (category: string): ChestMeasurement | null => {
      for (const chest of byCategory.get(category) ?? []) {
        if (chest.usedSlots < chest.capacitySlots * CHEST_FULL_RATIO) return chest;
      }
      return null;
    };
    return withRoom(targetCategory) ?? withRoom("general");
  }

  // --- Phase 8 cooperative interrupt plumbing ---

  /** Poll the task signals once and remember the result. */
  private checkInterrupt(): void {
    if (this.stopRequested || this.signals === null) return;
    const payload: OrganizeResumeState = { interruptions: this.interruptions + 1 };
    if (!this.signals.checkpoint(payload)) {
      this.stopRequested = true;
      this.interruptions += 1;
    }
  }

  /** Abort probe for travel waits: polls the signals while the bot walks. */
  private travelAbort = (): boolean => {
    this.checkInterrupt();
    return this.stopRequested;
  };

  /** Terminal result for a paused/cancelled run. */
  private interrupted(data: OrganizeStorageData): SkillResult<OrganizeStorageData> {
    data.interruptions = this.interruptions;
    this.opts.logger.info(
      { created: data.chestsCreated, moved: data.itemsMoved },
      "organize_storage interrupted",
    );
    return { ok: false, status: "interrupted", retryable: true, data, message: "interrupted" };
  }

  private fail(
    data: OrganizeStorageData,
    errorCode: Extract<SkillErrorCode, "NOT_READY" | "STORAGE_NOT_FOUND" | "PATH_UNREACHABLE">,
    reason: string,
  ): SkillResult<OrganizeStorageData> {
    this.announce(`Stuck: ${reason}.`);
    return { ok: false, status: "failed", errorCode, message: reason, retryable: true, data };
  }

  private announce(message: string): void {
    this.opts.logger.info({ message }, "organize_storage status");
    if (this.opts.bot.entity === null) return;
    if (!this.chatThrottle.allow(message)) return;
    if (!gameChatBudgetAllows()) return;
    try {
      this.opts.bot.chat(message);
    } catch (err) {
      this.opts.logger.warn({ err: String(err) }, "organize_storage chat failed");
    }
  }

  /** Persist one SkillSuccess for a completed organize run (spec 20.2). */
  private recordSuccess(
    data: OrganizeStorageData,
    startedAt: number,
    baseline: Record<string, number>,
    description: string,
  ): void {
    const worldId = this.opts.state.worldId;
    if (worldId === null) return;
    const home = this.opts.state.home;
    const self = this.opts.bot.entity;
    const summary = itemsSummary(this.opts.bot);
    const delta: Record<string, number> = {};
    for (const [name, count] of Object.entries(summary)) {
      const before = baseline[name] ?? 0;
      if (count !== before) delta[name] = count - before;
    }
    const distance =
      self !== null && home !== null
        ? Math.round(Math.hypot(self.position.x - home.x, self.position.y - home.y, self.position.z - home.z))
        : -1;
    this.opts.skills.record({
      skillName: "organize_storage",
      parameters: {
        category: data.category ?? "all",
        chestsCreated: data.chestsCreated,
        itemsMoved: data.itemsMoved,
      },
      startingConditions: {
        inventorySummary: baseline,
        homeDistance: distance,
        timeOfDay: this.opts.bot.time && this.opts.bot.time.isDay ? "day" : "night",
      },
      outcome: {
        durationMs: Math.max(0, Date.now() - startedAt),
        interruptions: data.interruptions,
        finalInventoryDelta: delta,
      },
      description,
    });
  }
}