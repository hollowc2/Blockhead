import type { Bot } from "mineflayer";
import type { Block } from "prismarine-block";
import type { Recipe } from "prismarine-recipe";
import type { Logger } from "pino";
import type { AgentState } from "../agent/state.js";
import type { TaskSignals } from "../agent/scheduler.js";
import type { MinecraftConfig } from "../config/schema.js";
import type { EventBus } from "../events/bus.js";
import type { StorageRepository } from "../memory/storage.js";
import type { ResourceSitesRepository } from "../memory/resource-sites.js";
import type { SkillsRepository } from "../memory/skills.js";
import { bareName, countItem, countPlanks, findItem, hasItem, isPlanksItemName, isRawLogItemName, itemsSummary, planksForLog } from "../minecraft/inventory.js";
import { craftItem, itemId } from "../minecraft/crafting.js";
import { smeltItems } from "../minecraft/smelting.js";
import { countStoredItems, deliverCarried, withdrawFromHomeChest } from "../minecraft/containers.js";
import { dominantNearbyLog } from "../minecraft/world.js";
import { isNaturalBlock } from "../minecraft/natural-blocks.js";
import { findBlockNear, findPlacementSpot, placeItemAt } from "../minecraft/world.js";
import { travelHomeAndWait } from "../minecraft/movement.js";
import { isEquipmentName } from "../policy/item-policy.js";
import { ChatThrottle, gameChatBudgetAllows, resourceLabel, type SkillResult } from "./skill-library.js";
import { stationSlotSpot } from "./base.js";
import type { CollectResourceRunner } from "./collect-resource.js";
import { carriedItemName } from "./collect-resource.js";
import type { GatherFoodRunner } from "./gather-food.js";
import { FOOD_ITEM_NAMES } from "./gather-food.js";
import { TOOL_FAMILIES } from "./expedition.js";

/**
 * Phase 13 (spec 14.3 / 20.2): the `ensure_item` family of skills.
 *
 * `ensure_item(item, quantity)` is intentionally powerful: it discovers the
 * deterministic production chain for an item — mine it, hunt the animal that
 * drops it, smelt its ore, craft it from prerequisites — satisfies every
 * prerequisite, and deposits the result (or keeps equipment carried). It is
 * one skill with three modes:
 *
 *   - "ensure": full autonomy — gather/hunt/craft/smelt as needed.
 *   - "craft":  materials come from carried inventory + the home chest only;
 *               missing materials fail with INSUFFICIENT_MATERIALS.
 *   - "smelt":  the target must be smelted and its input + fuel must already
 *               be in stock.
 *
 * The LLM only picks the tool; every recipe decision, prerequisite expansion,
 * travel, craft, smelt, and deposit is deterministic code. The plan resolver
 * (`resolvePlan`) is pure and unit-tested; the runner composes the existing
 * CollectResourceRunner / GatherFoodRunner and the crafting/smelting
 * primitives, mirrors their cooperative interrupt plumbing, and records a
 * SkillSuccess on full delivery (spec 20.2).
 */

// --- deterministic policy constants ---

/** Wall-clock budget for one home trip. */
const TRAVEL_TIMEOUT_MS = 120_000;
/** Scan radius for an already-placed crafting table near home. */
const TABLE_SCAN_RADIUS = 12;
/** Scan radius for an already-placed furnace near home. */
const FURNACE_SCAN_RADIUS = 12;
/** Recursion cap for prerequisite expansion (cyclic recipe protection). */
const MAX_PLAN_DEPTH = 6;
/** Crafting a table consumes 4 planks of any wood. */
const TABLE_PLANK_COST = 4;
/** How long a new run waits for a previous one to finish unwinding. */
const IN_FLIGHT_WAIT_MS = 30_000;
/** Crafting a furnace consumes 8 stone blocks. */
const FURNACE_STONE_COST = 8;

/** Smelt outcomes: output item -> input item. */
export const SMELT_INPUT_BY_OUTPUT: Record<string, string> = {
  iron_ingot: "raw_iron",
  gold_ingot: "raw_gold",
  copper_ingot: "raw_copper",
  charcoal: "oak_log",
  cooked_beef: "beef",
  cooked_porkchop: "porkchop",
  cooked_mutton: "mutton",
  cooked_chicken: "chicken",
  glass: "sand",
  brick: "clay_ball",
};

/** Ore blocks whose mined drop is the target item (collect's accounting). */
export const ORE_SOURCE_BY_DROP: Record<string, string> = {
  raw_iron: "iron_ore",
  raw_gold: "gold_ore",
  raw_copper: "copper_ore",
  coal: "coal_ore",
  diamond: "diamond_ore",
  emerald: "emerald_ore",
  lapis_lazuli: "lapis_ore",
  redstone: "redstone_ore",
};

/** Items one piece of coal or charcoal smelts. */
export const ITEMS_PER_FUEL = 8;

/**
 * Logs to net `charcoal` pieces from a furnace that fuels itself: one log
 * lights it, then charcoal from the run burns at one piece per ~8 smelts.
 * Budgeted at 6 net per burned piece for the burn lost between passes.
 * (Burning a log per smelt needed 2 logs per charcoal: 128 for 64.)
 */
export function charcoalLogsFor(charcoal: number): number {
  if (charcoal <= 0) return 0;
  return Math.ceil((charcoal * (ITEMS_PER_FUEL - 1)) / (ITEMS_PER_FUEL - 2)) + 1;
}

/** Coal/charcoal pieces needed to smelt `items` items. */
export function fuelFor(items: number): number {
  return Math.ceil(Math.max(0, items) / ITEMS_PER_FUEL);
}

/** Fuel the smelt steps burn (coal or charcoal). */
const FUEL_ITEM_NAMES: ReadonlySet<string> = new Set(["coal", "charcoal"]);

// --- the plan resolver (pure, testable) ---

/** A deterministic production step. */
export type EnsureStep =
  | { kind: "gather"; item: string; quantity: number }
  | { kind: "hunt"; item: string; quantity: number }
  | { kind: "craft"; item: string; quantity: number; table: boolean }
  | { kind: "smelt"; item: string; quantity: number }
  | { kind: "fuel"; quantity: number };

/** A complete production plan: dependency steps first, then the top craft/smelt. */
export interface Plan {
  steps: EnsureStep[];
  needsTable: boolean;
  needsFurnace: boolean;
}

export type PlanResult = { ok: true; plan: Plan } | { ok: false; errorCode: string; reason: string };

/**
 * Recipe access abstraction so the resolver is testable without a bot.
 */
export interface RecipeCatalog {
  /** True when the item is a world block the bot can mine. */
  gatherable(item: string): boolean;
  /** Recipes producing the item (may be empty). */
  recipesProducing(item: string): Recipe[];
  /** Item name for a numeric id, or null when unknown. */
  nameForId(id: number): string | null;
  /** Carried + stored count, used to prefer recipes whose inputs are in stock. */
  available?(item: string): number;
  /**
   * Tie-break for inputs nothing is stocked of: true for the variant most
   * likely to be found where the bot is (cobblestone at the surface, the
   * local log species).
   */
  preferred?(item: string): boolean;
}

/**
 * Recipe variants ordered by how much of their input is already in stock, so
 * a stone pickaxe comes from the cobblestone being carried rather than from
 * whichever variant (cobbled deepslate, blackstone) the data lists first.
 */
export function rankRecipes(recipes: Recipe[], catalog: RecipeCatalog): Recipe[] {
  if (catalog.available === undefined) return recipes;
  // How well stock covers `need` of `name`: held/stored first, then (at half
  // weight) what one more crafting step could make from stock. One level
  // alone saw every plank species at zero, so a stick picked pale oak while
  // the chest held birch logs.
  const supply = (name: string, need: number, depth: number): number => {
    const direct = Math.min(1, (catalog.available?.(name) ?? 0) / need);
    if (direct >= 1 || depth <= 0) return direct;
    let best = 0;
    for (const recipe of catalog.recipesProducing(name)) {
      let sum = 0;
      let count = 0;
      for (const delta of recipe.delta) {
        if (delta.count >= 0) continue;
        const ingredient = catalog.nameForId(delta.id);
        if (ingredient === null) continue;
        count += 1;
        sum += supply(ingredient, -delta.count, depth - 1);
      }
      if (count > 0) best = Math.max(best, sum / count);
    }
    return Math.max(direct, best / 2);
  };
  const score = (recipe: Recipe): number => {
    let total = 0;
    for (const delta of recipe.delta) {
      if (delta.count >= 0) continue;
      const name = catalog.nameForId(delta.id);
      if (name === null) continue;
      total += supply(name, -delta.count, 1);
    }
    return total;
  };
  // With nothing stocked every variant scores 0 and the registry order used
  // to decide: stone tools planned cobbled deepslate at the surface and
  // searched 256 blocks for it (long enough to time the bot out).
  const preference = (recipe: Recipe): number => {
    let total = 0;
    for (const delta of recipe.delta) {
      if (delta.count >= 0) continue;
      const name = catalog.nameForId(delta.id);
      if (name !== null && catalog.preferred?.(name) === true) total += 1;
    }
    return total;
  };
  return recipes.map((recipe, index) => ({ recipe, index, score: score(recipe), preference: preference(recipe) }))
    .sort((a, b) => b.score - a.score || b.preference - a.preference || a.index - b.index)
    .map((entry) => entry.recipe);
}

/** The stone-tool material found where the bot stands. */
function localStone(bot: Bot): string {
  if (String(bot.game?.dimension ?? "").includes("nether")) return "blackstone";
  return (bot.entity?.position.y ?? 64) < 0 ? "cobbled_deepslate" : "cobblestone";
}

/** The live catalog over a connected mineflayer bot. */
export function makeRecipeCatalog(bot: Bot, available?: (item: string) => number): RecipeCatalog {
  // Scanned only when a tie needs it, once per catalog.
  let nearbyLog: string | null = null;
  const localLog = (): string => (nearbyLog ??= dominantNearbyLog(bot));
  return {
    available,
    preferred: (item) => {
      const bare = bareName(item);
      if (bare === "cobblestone" || bare === "cobbled_deepslate" || bare === "blackstone") return bare === localStone(bot);
      if (/_log$|_planks$/.test(bare)) return bare === localLog() || bare === localLog().replace(/_log$/, "_planks");
      return false;
    },
    // A block is gathered only when it occurs in nature or cannot be
    // crafted: planks, bricks, and the like are blocks too, but searching the
    // world for them instead of crafting from logs/stone never succeeds.
    gatherable: (item) => {
      const bare = bareName(item);
      if (bot.registry.blocksByName[bare] === undefined) return false;
      if (isNaturalBlock(bare) || /_log$|_wood$/.test(bare)) return true;
      const id = itemId(bot, bare);
      try { return id === null || (bot.recipesAll(id, null, true) ?? []).length === 0; } catch { return true; }
    },
    recipesProducing: (item) => {
      const id = itemId(bot, item);
      if (id === null) return [];
      try {
        // Inventory (2x2) recipes first, then table-only recipes: doors,
        // tools, chests and furnaces need the 3x3 grid and were invisible
        // when only the 2x2 set was consulted.
        const handheld = bot.recipesAll(id, null, false) ?? [];
        const withTable = (bot.recipesAll(id, null, true) ?? []).filter((recipe) => !handheld.includes(recipe) && recipe.requiresTable);
        return [...handheld, ...withTable];
      } catch {
        return [];
      }
    },
    nameForId: (id) => {
      const items = bot.registry.items;
      if (items === undefined) return null;
      // registry.items is keyed by numeric id; the name lives on the entry.
      const entry = (items as Record<number, { name?: string } | undefined>)[id];
      return entry?.name === undefined ? null : bareName(entry.name);
    },
  };
}

function okPlan(steps: EnsureStep[], needsTable = false, needsFurnace = false): PlanResult {
  return { ok: true, plan: { steps, needsTable, needsFurnace } };
}

/**
 * Expand `item x quantity` into a deterministic production plan. Resolution
 * order: mineable block -> hunt (raw food) -> mine the source ore -> smelt
 * from its input -> craft from its ingredients. Ingredients recurse with a
 * depth cap; produced quantities are per-craft so the plan's craft steps
 * carry *craft counts*, and gather/hunt/smelt steps carry item counts.
 */
export function resolvePlan(item: string, quantity: number, catalog: RecipeCatalog, depth = 0): PlanResult {
  // Reserve existing inputs once across the whole recipe tree. Physical stock
  // also includes ingredients reserved for a later craft, so acquisition
  // targets cannot accidentally reuse those items in a sibling branch.
  const remaining = new Map<string, number>();
  const physical = new Map<string, number>();
  const initial = (name: string): number => Math.max(0, catalog.available?.(name) ?? 0);
  const stock = (name: string): number => remaining.get(name) ?? initial(name);
  const heldStock = (name: string): number => physical.get(name) ?? initial(name);
  const produced = (name: string, count: number): void => { physical.set(name, heldStock(name) + count); };
  const consume = (name: string, count: number): void => { physical.set(name, Math.max(0, heldStock(name) - count)); };
  const acquired = (kind: "gather" | "hunt", item: string, drop: string, count: number): PlanResult => {
    const target = heldStock(drop) + count;
    produced(drop, count);
    return okPlan([{ kind, item, quantity: target }]);
  };
  const reserveFuel = (count: number): EnsureStep => {
    // Smelting burns coal before charcoal. Replenish coal reserved for a
    // sibling ingredient rather than silently spending that reservation.
    const reservedCoal = heldStock("coal") - stock("coal");
    const missing = reservedCoal > 0
      ? Math.max(0, count - stock("coal"))
      : Math.max(0, count - stock("coal") - stock("charcoal"));
    const target = heldStock("coal") + heldStock("charcoal") + missing;
    produced("coal", missing);
    remaining.set("coal", stock("coal") + missing);
    let burned = count;
    for (const name of ["coal", "charcoal"]) {
      const used = Math.min(heldStock(name), burned);
      remaining.set(name, stock(name) - used);
      consume(name, used);
      burned -= used;
    }
    return { kind: "fuel", quantity: target };
  };
  function expand(item: string, quantity: number, depth: number): PlanResult {
    const bare = bareName(item);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return { ok: false, errorCode: "INVALID_RESOURCE", reason: `invalid quantity ${quantity} for '${bare}'` };
    }
    const held = stock(bare);
    const reserved = Math.min(held, quantity);
    const missing = quantity - reserved;
    remaining.set(bare, held - reserved);
    if (missing === 0) return okPlan([]);
    quantity = missing;
    if (depth > MAX_PLAN_DEPTH) {
      return { ok: false, errorCode: "NOT_READY", reason: `prerequisite chain for '${bare}' is unreasonably deep` };
    }

    if (catalog.gatherable(bare)) {
      return acquired("gather", bare, bare, quantity);
    }
    if (FOOD_ITEM_NAMES[bare] === true && SMELT_INPUT_BY_OUTPUT[bare] === undefined) {
      return acquired("hunt", bare, bare, quantity);
    }
    const oreSource = ORE_SOURCE_BY_DROP[bare];
    if (oreSource !== undefined) {
      return acquired("gather", oreSource, bare, quantity);
    }
    if (bare === "charcoal") {
      // Charcoal fuels its own run: logs only, no separate fuel step.
      const logs = expand(SMELT_INPUT_BY_OUTPUT[bare]!, charcoalLogsFor(quantity), depth + 1);
      if (!logs.ok) return logs;
      consume(SMELT_INPUT_BY_OUTPUT[bare]!, charcoalLogsFor(quantity));
      produced(bare, quantity);
      return okPlan([...logs.plan.steps, { kind: "smelt", item: bare, quantity }], logs.plan.needsTable, true);
    }
    const smeltInput = SMELT_INPUT_BY_OUTPUT[bare];
    if (smeltInput !== undefined) {
      const inputPlan = expand(smeltInput, quantity, depth + 1);
      if (!inputPlan.ok) return inputPlan;
      const fuel = reserveFuel(fuelFor(quantity));
      consume(smeltInput, quantity);
      produced(bare, quantity);
      return okPlan(
        [...inputPlan.plan.steps, fuel, { kind: "smelt", item: bare, quantity }],
        inputPlan.plan.needsTable,
        true,
      );
    }

    const recipes = rankRecipes(catalog.recipesProducing(bare), { ...catalog, available: stock });
    // Skip a recipe that consumes its own output (data quirk / self-loop).
    const recipe = recipes.find((candidate) => {
      return !candidate.delta.some((d) => d.count < 0 && catalog.nameForId(d.id) === bare);
    });
    if (recipe === undefined) {
      return {
        ok: false,
        errorCode: "INVALID_RESOURCE",
        reason: `'${bare}' is not mineable, huntable, smeltable, or craftable`,
      };
    }

    const perCraft = Math.max(1, recipe.result.count);
    const crafts = Math.max(1, Math.ceil(quantity / perCraft));
    const ingredientSteps: EnsureStep[] = [];
    let needsTable = recipe.requiresTable;
    let needsFurnace = false;
    for (const delta of recipe.delta) {
      if (delta.count >= 0) continue;
      const name = catalog.nameForId(delta.id);
      if (name === null || name === bare) continue;
      const sub = expand(name, -delta.count * crafts, depth + 1);
      if (!sub.ok) return sub;
      ingredientSteps.push(...sub.plan.steps);
      needsTable = needsTable || sub.plan.needsTable;
      needsFurnace = needsFurnace || sub.plan.needsFurnace;
    }
    for (const delta of recipe.delta) {
      const name = catalog.nameForId(delta.id);
      if (delta.count < 0 && name !== null) consume(name, -delta.count * crafts);
    }
    const output = perCraft * crafts;
    produced(bare, output);
    remaining.set(bare, stock(bare) + output - quantity);
    return okPlan(
      [...ingredientSteps, { kind: "craft", item: bare, quantity: crafts, table: recipe.requiresTable }],
      needsTable,
      needsFurnace,
    );
  }
  return expand(item, quantity, depth);
}

// --- the runner ---

export type EnsureMode = "ensure" | "craft" | "smelt";

export interface EnsureItemOptions {
  bot: Bot;
  state: AgentState;
  config: MinecraftConfig;
  bus: EventBus;
  /** Home storage registration (spec 22): stock and the deposit target. */
  storage: StorageRepository;
  /** Known resource sites, forwarded to the inner collect runner. */
  sites: ResourceSitesRepository;
  /** Skill success records (spec 20.2). */
  skills: SkillsRepository;
  /** The deterministic gather runner (spec 27) for gather steps. */
  collect: CollectResourceRunner;
  /** The deterministic hunt runner (spec 11) for hunt steps. */
  food: GatherFoodRunner;
  logger: Logger;
}

export interface EnsureItemData {
  item: string;
  quantity: number;
  mode: EnsureMode;
  /** Carried + stored of the target when the run started. */
  availableAtStart: number;
  /** Carried + stored of the target when the run ended. */
  availableAtEnd: number;
  /** Fresh items produced by inner gather/hunt runs. */
  gathered: number;
  /** Craft passes performed. */
  crafted: number;
  /** Smelt passes performed. */
  smelted: number;
  /** Items moved out of the home chest into the inventory. */
  withdrawals: number;
  /** Items deposited into the home chest. */
  delivered: number;
  /** Times this task was cooperatively interrupted (persisted across resumes). */
  interruptions: number;
}

/** Progress persisted as the task's resume state (Phase 8). A paused run
 *  replans and re-executes; every step short-circuits on what is already
 *  carried or stored, so a resume simply continues the same production. */
export interface EnsureResumeState {
  item: string;
  quantity: number;
  mode: EnsureMode;
  interruptions: number;
  version: 1;
}

export interface EnsureRunOptions {
  /** "ensure" (default), "craft" (stock only), or "smelt" (smelt from stock). */
  mode?: EnsureMode;
  /** Cooperative signals from the owning scheduler task. */
  signals?: TaskSignals;
  /** Resume state from a paused run of the same task. */
  resumeState?: Partial<EnsureResumeState>;
  /** Leave the result in the inventory (build materials), withdrawing stock if needed. */
  keepCarried?: boolean;
}

/** A production failure with a structured code. */
interface StepFailure {
  errorCode: string;
  reason: string;
  retryable: boolean;
}

/**
 * Deterministic `ensure_item` / `craft_item` / `smelt_item` skill. One run at
 * a time; the tool handlers never stack requests (`isRunning`).
 */
export class EnsureItemRunner {
  private running = false;
  private signals: TaskSignals | null = null;
  private stopRequested = false;
  private interruptions = 0;
  private mode: EnsureMode = "ensure";

  /** The runner's own tracked chest counts (drifts with deposits/withdrawals). */
  private stored: Record<string, number> = {};

  /** Identical game-chat lines repeat at most once per window (spam-kick guard). */
  private readonly chatThrottle: ChatThrottle;

  constructor(private readonly opts: EnsureItemOptions) {
    const throttleSeconds = opts.config.background?.announce_throttle_seconds ?? 30;
    this.chatThrottle = new ChatThrottle(throttleSeconds * 1000);
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** The run in progress, awaited by a run that starts while it unwinds. */
  private inFlight: Promise<unknown> | null = null;

  /** Produce `quantity` of `item` in the given mode, resolving when the run ends. */
  async run(item: string, quantity: number, options: EnsureRunOptions = {}): Promise<SkillResult<EnsureItemData>> {
    // A paused run unwinds for a moment after its task settles; the next
    // ensure_item task starting in that window was refused as "blocked",
    // which is terminal (three re-arms sat blocked from 20:13 on). Wait it out.
    if (this.running && this.inFlight !== null) {
      await Promise.race([this.inFlight.catch(() => undefined), new Promise((resolve) => setTimeout(resolve, IN_FLIGHT_WAIT_MS))]);
    }
    if (this.running) {
      return {
        ok: false,
        status: "blocked",
        errorCode: "ALREADY_RUNNING",
        message: `already producing ${resourceLabel(item)}`,
      };
    }
    const mode = options.mode ?? "ensure";
    const resume = options.resumeState;
    this.running = true;
    this.signals = options.signals ?? null;
    this.interruptions = typeof resume?.interruptions === "number" ? resume.interruptions : 0;
    this.mode = mode;
    this.stopRequested = false;
    this.currentItemName = bareName(item);
    this.currentQuantity = quantity;
    this.keepCarried = options.keepCarried === true;
    const run = this.execute(item, quantity, mode);
    this.inFlight = run;
    try {
      return await run;
    } finally {
      this.running = false;
      this.inFlight = null;
      this.signals = null;
      this.stored = {};
    }
  }

  private async execute(item: string, quantity: number, mode: EnsureMode): Promise<SkillResult<EnsureItemData>> {
    const bot = this.opts.bot;
    const startedAt = Date.now();
    const baseline = itemsSummary(bot);
    let bare = bareName(item);
    let label = resourceLabel(bare);
    const data: EnsureItemData = {
      item: bare,
      quantity,
      mode,
      availableAtStart: -1,
      availableAtEnd: -1,
      gathered: 0,
      crafted: 0,
      smelted: 0,
      withdrawals: 0,
      delivered: 0,
      interruptions: this.interruptions,
    };

    if (bot.entity === null) {
      return this.fail(data, "NOT_READY", "bot is not spawned", false);
    }

    const home = this.opts.state.home;
    if (home === null) {
      return this.fail(data, "STORAGE_NOT_FOUND", "no home coordinate configured", false);
    }
    const returned = await travelHomeAndWait(bot, home, {
      dimension: home.dimension,
      timeoutMs: TRAVEL_TIMEOUT_MS,
      shouldAbort: this.travelAbort,
    });
    if (this.stopRequested) return this.interrupted(data);
    if (returned.status !== "arrived" && returned.status !== "already_there") {
      return this.fail(data, "PATH_UNREACHABLE", `could not return home: ${returned.status}`, true);
    }

    const stored = await countStoredItems(bot, this.opts.state, this.opts.storage, this.signals?.signal);
    this.stored = { ...stored };
    if (bare.endsWith("_planks") || (bare.endsWith("_door") && !bare.startsWith("iron_") && !bare.includes("trapdoor"))) {
      // Plank and wooden-door requests (house walls) accept any wood: make
      // the species we already have the most of instead of chopping a
      // different tree.
      const suffix = bare.endsWith("_door") ? "_door" : "_planks";
      const best = this.bestPlankSpecies(bare.replace(/_door$/, "_planks")).replace(/_planks$/, suffix);
      if (best !== bare) {
        this.opts.logger.info({ requested: bare, using: best }, "ensure_item: substituting the best-stocked plank species");
        bare = best;
        label = resourceLabel(bare);
        data.item = bare;
        this.currentItemName = bare;
      }
    }
    data.availableAtStart = this.available(bare);

    // Already satisfied: materialize the shortfall for equipment; bulk stock
    // may stay in the chest.
    if (data.availableAtStart >= quantity) {
      const carried = countItem(bot, bare);
      if ((isEquipmentName(bare) || this.keepCarried) && carried < quantity) {
        const withdrawn = await withdrawFromHomeChest(bot, this.opts.state, this.opts.storage, bare, quantity - carried, this.opts.logger, this.signals?.signal);
        this.withdrawAccount(bare, withdrawn.withdrawn);
        data.withdrawals += withdrawn.withdrawn;
      }
      return this.finish(data, baseline, startedAt, true);
    }

    const catalog = makeRecipeCatalog(bot, (item) => this.available(item));
    const planResult = resolvePlan(bare, quantity, catalog);
    if (!planResult.ok) {
      return this.fail(data, planResult.errorCode, planResult.reason, false);
    }
    const plan = planResult.plan;
    this.opts.logger.info({ item: bare, quantity, available: data.availableAtStart, steps: plan.steps }, "ensure_item plan");
    if (this.stopRequested) return this.interrupted(data);

    // Infrastructure: a crafting table for craft steps, a furnace for smelt.
    let table: Block | null = null;
    if (plan.needsTable && mode !== "smelt") {
      table = await this.ensureTable();
      if (this.stopRequested) return this.interrupted(data);
      if (table === null) {
        return this.fail(data, "NOT_READY", "no crafting table at home and none could be crafted", true);
      }
    }
    let furnace: Block | null = null;
    if (plan.needsFurnace) {
      furnace = await this.ensureFurnace();
      if (this.stopRequested) return this.interrupted(data);
      if (furnace === null) {
        return this.fail(data, "NOT_READY", "no furnace at home and none could be crafted", true);
      }
    }

    for (const step of plan.steps) {
      this.checkInterrupt();
      if (this.stopRequested) return this.interrupted(data);
      const failure = await this.executeStep(step, table, furnace, data);
      this.opts.logger.info({ step, ok: failure === null, reason: failure?.reason, carried: countItem(this.opts.bot, bareName("item" in step ? step.item : bare)) }, "ensure_item step settled");
      if (failure !== null) {
        return this.fail(data, failure.errorCode, failure.reason, failure.retryable);
      }
      if (this.stopRequested) return this.interrupted(data);
    }

    return this.finish(data, baseline, startedAt, false);
  }

  // --- step execution ---

  private async executeStep(
    step: EnsureStep,
    table: Block | null,
    furnace: Block | null,
    data: EnsureItemData,
  ): Promise<StepFailure | null> {
    switch (step.kind) {
      case "gather":
        return this.stepGather(step, data);
      case "hunt":
        return this.stepHunt(step, data);
      case "fuel":
        return this.stepFuel(step, data);
      case "craft":
        return this.stepCraft(step, table, data);
      case "smelt":
        return this.stepSmelt(step, furnace, data);
      default:
        return { errorCode: "NOT_READY", reason: "unknown production step", retryable: false };
    }
  }

  /** A gather step: ensure `quantity` of the mined drop is held or stored. */
  private async stepGather(step: { item: string; quantity: number }, data: EnsureItemData): Promise<StepFailure | null> {
    const drop = carriedItemName(step.item);
    const missing = Math.max(0, step.quantity - this.available(drop));
    if (missing === 0) return null;

    if (this.mode !== "ensure") {
      return { errorCode: "INSUFFICIENT_MATERIALS", reason: `need ${missing} more ${resourceLabel(drop)} and ${this.mode} mode does not mine`, retryable: false };
    }
    const result = await this.opts.collect.run(step.item, countItem(this.opts.bot, drop) + missing, { signals: this.signals ?? undefined });
    if (result.status === "interrupted") {
      this.interruptions += result.data?.interruptions ?? 0;
      this.stopRequested = true;
      return null;
    }
    data.gathered += result.data?.gathered ?? 0;
    if (!result.ok && result.status !== "partial") {
      return { errorCode: result.errorCode ?? "RESOURCE_NOT_FOUND", reason: result.message ?? "gather failed", retryable: result.retryable ?? true };
    }
    // The inner runner deposited; book the fresh stock so later steps can
    // withdraw it without re-opening the chest.
    this.stored[drop] = (this.stored[drop] ?? 0) + (result.data?.delivered ?? 0);
    return null;
  }

  /** A hunt step: ensure `quantity` raw food via the gather-food runner. */
  private async stepHunt(step: { item: string; quantity: number }, data: EnsureItemData): Promise<StepFailure | null> {
    const raw = bareName(step.item);
    const missing = Math.max(0, step.quantity - this.available(raw));
    if (missing === 0) return null;

    if (this.mode !== "ensure") {
      return { errorCode: "INSUFFICIENT_MATERIALS", reason: `need ${missing} more ${resourceLabel(raw)} and ${this.mode} mode does not hunt`, retryable: false };
    }
    const result = await this.opts.food.run(missing, { signals: this.signals ?? undefined });
    if (result.status === "interrupted") {
      this.interruptions += result.data?.interruptions ?? 0;
      this.stopRequested = true;
      return null;
    }
    data.gathered += result.data?.gathered ?? 0;
    if (!result.ok && result.status !== "partial") {
      return { errorCode: result.errorCode ?? "RESOURCE_NOT_FOUND", reason: result.message ?? "hunt failed", retryable: result.retryable ?? true };
    }
    this.stored[raw] = (this.stored[raw] ?? 0) + (result.data?.delivered ?? missing);
    return null;
  }

  /** A fuel step: ensure `quantity` burnable fuel (coal or charcoal). */
  private async stepFuel(step: { quantity: number }, data: EnsureItemData): Promise<StepFailure | null> {
    const have = this.availableFuel();
    const missing = Math.max(0, step.quantity - have);
    if (missing === 0) return null;

    if (this.mode !== "ensure") {
      return { errorCode: "INSUFFICIENT_MATERIALS", reason: `need ${missing} more coal/charcoal and ${this.mode} mode does not gather fuel`, retryable: false };
    }

    // 1. Mine coal ore when the world has it.
    const catalog = makeRecipeCatalog(this.opts.bot);
    if (catalog.gatherable("coal_ore")) {
      const result = await this.opts.collect.run("coal_ore", countItem(this.opts.bot, "coal") + missing, { signals: this.signals ?? undefined });
      if (result.status === "interrupted") {
        this.interruptions += result.data?.interruptions ?? 0;
        this.stopRequested = true;
        return null;
      }
      if (result.ok || result.status === "partial") {
        this.stored["coal"] = (this.stored["coal"] ?? 0) + (result.data?.delivered ?? 0);
        return null;
      }
    }

    // 2. Produce charcoal from logs.
    const charcoalMissing = Math.max(0, step.quantity - this.availableFuel());
    if (charcoalMissing > 0) return this.produceCharcoal(charcoalMissing, data);
    return null;
  }

  /**
   * Net `count` more charcoal into the inventory: chop logs when the chest is
   * short, then smelt with the run fueling itself. Too few logs still smelts
   * what there is, so a failed restore leaves more fuel than it found.
   */
  private async produceCharcoal(count: number, data: EnsureItemData): Promise<StepFailure | null> {
    const bot = this.opts.bot;
    const logName = this.bestLogSpecies();
    const logsNeeded = charcoalLogsFor(count);
    const gathered = await this.stepGather({ item: logName, quantity: logsNeeded }, data);
    if (this.stopRequested) return null;
    const usable = Math.min(logsNeeded, this.available(logName));
    if (gathered !== null && usable < 2) {
      return { ...gathered, reason: `no coal and no logs for charcoal (${gathered.reason})` };
    }
    await this.materialize(logName, usable);
    const furnace = await this.ensureFurnace();
    if (furnace === null) {
      return { errorCode: "NOT_READY", reason: "no furnace at home for charcoal", retryable: true };
    }
    const start = countItem(bot, "charcoal");
    let lastReason = gathered?.reason ?? "ran out of logs";
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const remaining = count - (countItem(bot, "charcoal") - start);
      const logs = countItem(bot, logName);
      if (remaining <= 0 || logs === 0) break;
      const smelt = await smeltItems(bot, furnace, {
        inputName: logName,
        fuelName: ["coal", "charcoal", logName],
        outputName: "charcoal",
        times: Math.min(logs, Math.ceil((remaining * ITEMS_PER_FUEL) / (ITEMS_PER_FUEL - 1))),
        signal: this.signals?.signal,
      });
      if (!smelt.ok) {
        lastReason = smelt.reason;
        break;
      }
    }
    const made = countItem(bot, "charcoal") - start;
    data.smelted += Math.max(0, made);
    this.opts.logger.info({ wanted: count, made, logName, logsLeft: countItem(bot, logName) }, "ensure_item charcoal run settled");
    if (made >= count) return null;
    return { errorCode: "INSUFFICIENT_MATERIALS", reason: `made ${Math.max(0, made)}/${count} charcoal: ${lastReason}`, retryable: true };
  }

  /** Log species with the largest carried + stored supply, else what grows nearby. */
  private bestLogSpecies(): string {
    return ["oak_log", "spruce_log", "birch_log", "jungle_log", "acacia_log", "dark_oak_log", "mangrove_log", "cherry_log", "pale_oak_log"]
      .reduce((best, name) => (this.available(name) > this.available(best) ? name : best), dominantNearbyLog(this.opts.bot));
  }

  /** A craft step: run `quantity` craft passes of `item` at the table. */
  private async stepCraft(step: { item: string; quantity: number; table: boolean }, table: Block | null, data: EnsureItemData): Promise<StepFailure | null> {
    const name = bareName(step.item);
    const stepCatalog = makeRecipeCatalog(this.opts.bot, (item) => this.available(item));
    const recipe = rankRecipes(stepCatalog.recipesProducing(name), stepCatalog)
      .find((candidate) => candidate.result && itemId(this.opts.bot, name) === candidate.result.id);
    if (recipe === undefined) {
      return { errorCode: "INVALID_RESOURCE", reason: `no recipe found for '${name}'`, retryable: false };
    }
    // Materials must sit in the *inventory* to craft: withdraw every
    // ingredient of the runtime recipe from the chest when needed.
    for (const delta of recipe.delta) {
      if (delta.count >= 0) continue;
      const ingredient = makeRecipeCatalog(this.opts.bot).nameForId(delta.id);
      if (ingredient === null) continue;
      const need = -delta.count * step.quantity;
      const materialized = await this.materialize(ingredient, need);
      if (!materialized.ok) {
        return { errorCode: "INSUFFICIENT_MATERIALS", reason: materialized.reason, retryable: false };
      }
    }
    const perRun = Math.max(1, recipe.result?.count ?? 1);
    const target = countItem(this.opts.bot, name) + step.quantity * perRun;
    let crafted = await craftItem(this.opts.bot, name, {
      times: step.quantity,
      craftingTable: step.table ? (table ?? undefined) : undefined,
      signal: this.signals?.signal,
    });
    // A run cut short by inventory desync leaves ingredients carried; finish
    // the remaining runs instead of failing the whole plan on a shortfall.
    for (let pass = 0; crafted.ok && pass < 2; pass += 1) {
      const remainingRuns = Math.ceil((target - countItem(this.opts.bot, name)) / perRun);
      if (remainingRuns <= 0) break;
      this.opts.logger.info({ item: name, remainingRuns }, "craft step fell short; crafting the remainder");
      crafted = await craftItem(this.opts.bot, name, {
        times: remainingRuns,
        craftingTable: step.table ? (table ?? undefined) : undefined,
        signal: this.signals?.signal,
      });
    }
    if (!crafted.ok && countItem(this.opts.bot, name) < target) {
      return { errorCode: "INSUFFICIENT_MATERIALS", reason: crafted.reason, retryable: true };
    }
    data.crafted += step.quantity;
    return null;
  }

  /** A smelt step: run `quantity` smelt passes of `item` in the furnace. */
  private async stepSmelt(step: { item: string; quantity: number }, furnace: Block | null, data: EnsureItemData): Promise<StepFailure | null> {
    const bare = bareName(step.item);
    if (bare === "charcoal") {
      const failure = await this.produceCharcoal(step.quantity, data);
      return failure;
    }
    const input = SMELT_INPUT_BY_OUTPUT[bare];
    if (input === undefined) {
      return { errorCode: "INVALID_RESOURCE", reason: `'${bare}' has no smelting recipe`, retryable: false };
    }
    const within = await this.materialize(input, step.quantity);
    if (!within.ok) {
      return { errorCode: "INSUFFICIENT_MATERIALS", reason: within.reason, retryable: false };
    }
    // Carried fuel, not carried + chest: with 66 fuel in the chest and none
    // in hand this skipped the withdraw and failed "no fuel to burn" on every
    // iron_pickaxe try (2026-10-05 09:54).
    if (countItem(this.opts.bot, "coal") + countItem(this.opts.bot, "charcoal") < fuelFor(step.quantity)) {
      const fuel = await this.materializeFuel(fuelFor(step.quantity));
      if (!fuel.ok) {
        return { errorCode: "INSUFFICIENT_MATERIALS", reason: fuel.reason, retryable: false };
      }
    }
    if (furnace === null) {
      return { errorCode: "NOT_READY", reason: "no furnace at home to smelt", retryable: true };
    }
    if (findItem(this.opts.bot, "coal") === null && findItem(this.opts.bot, "charcoal") === null) {
      return { errorCode: "INSUFFICIENT_MATERIALS", reason: "no fuel to burn", retryable: false };
    }
    const smelted = await smeltItems(this.opts.bot, furnace, {
      inputName: input,
      fuelName: ["coal", "charcoal"],
      outputName: bare,
      times: step.quantity,
      signal: this.signals?.signal,
    });
    if (!smelted.ok) {
      return { errorCode: "NOT_READY", reason: smelted.reason, retryable: true };
    }
    data.smelted += step.quantity;
    return null;
  }

  // --- materialization (inventory <- chest stock <- fresh acquisition) ---

  /** Carried + tracked-stored count of an exact item name. */
  private available(name: string): number {
    return countItem(this.opts.bot, bareName(name)) + (this.stored[bareName(name)] ?? 0);
  }

  /** Carried + tracked-stored fuel (coal + charcoal). */
  private availableFuel(): number {
    return (this.available("coal") + this.available("charcoal")) as number;
  }

  private keepCarried = false;

  /** Plank species with the largest supply (planks + 4 per log), carried or stored. */
  private bestPlankSpecies(requested: string): string {
    const supply = (species: string): number => {
      const planks = `${species}_planks`;
      const log = `${species}_log`;
      return this.available(planks) + 4 * this.available(log);
    };
    const requestedSpecies = requested.replace(/_planks$/, "");
    let best = { species: requestedSpecies, supply: supply(requestedSpecies) };
    for (const species of ["oak", "spruce", "birch", "jungle", "acacia", "dark_oak", "mangrove", "cherry", "pale_oak"]) {
      const amount = supply(species);
      if (amount > best.supply) best = { species, supply: amount };
    }
    return `${best.species}_planks`;
  }

  private withdrawAccount(name: string, withdrawn: number): void {
    if (withdrawn <= 0) return;
    const bare = bareName(name);
    this.stored[bare] = Math.max(0, (this.stored[bare] ?? 0) - withdrawn);
  }

  /**
   * Ensure `count` of `name` sits in the *inventory*: take it from the chest
   * when held there ("tracked" availability only — fresh territory is not
   * acquired, that is what the gather/hunt/fuel steps do).
   */
  private async materialize(name: string, count: number): Promise<{ ok: true } | { ok: false; reason: string }> {
    const bare = bareName(name);
    let carried = countItem(this.opts.bot, bare);
    if (carried >= count) return { ok: true };
    const inChest = Math.max(0, (this.stored[bare] ?? 0));
    const fromChest = Math.min(count - carried, inChest);
    if (fromChest > 0) {
      const withdrawn = await withdrawFromHomeChest(this.opts.bot, this.opts.state, this.opts.storage, bare, fromChest, this.opts.logger, this.signals?.signal);
      this.withdrawAccount(bare, withdrawn.withdrawn);
      if (withdrawn.withdrawn > 0) {
        this.opts.logger.info({ item: bare, count: withdrawn.withdrawn }, "ensure_item withdrew stock from the home chest");
      }
    }
    carried = countItem(this.opts.bot, bare);
    return carried >= count ? { ok: true } : { ok: false, reason: `only ${carried}/${count} ${resourceLabel(bare)} available in stock` };
  }

  /** Ensure `count` fuel is carried (from inventory + chest). */
  private async materializeFuel(count: number): Promise<{ ok: true } | { ok: false; reason: string }> {
    const have = countItem(this.opts.bot, "coal") + countItem(this.opts.bot, "charcoal");
    if (have >= count) return { ok: true };
    const coal = await this.materialize("coal", count);
    if (coal.ok && countItem(this.opts.bot, "coal") >= count) return { ok: true };
    const charcoal = await this.materialize("charcoal", count);
    if (charcoal.ok) return { ok: true };
    return { ok: false, reason: "no coal or charcoal in stock" };
  }

  // --- home infrastructure ---

  /** A placed crafting table near home, or one crafted+placed now. */
  private async ensureTable(): Promise<Block | null> {
    const bot = this.opts.bot;
    const home = this.opts.state.home;
    let existing = findBlockNear(bot, "crafting_table", TABLE_SCAN_RADIUS);
    if (existing !== null) return existing;
    if (home === null) return null;
    // Just respawned at home, the chunks may still be arriving: a scan of
    // unloaded terrain finds no table, as it found no chest (ed1fe0c).
    await waitForChunks(bot);
    existing = findBlockNear(bot, "crafting_table", TABLE_SCAN_RADIUS);
    if (existing !== null) return existing;

    if (!hasItem(bot, "crafting_table")) {
      const planks = await this.materializePlanks(TABLE_PLANK_COST);
      if (planks.ok) {
        const crafted = await craftItem(bot, "crafting_table", { signal: this.signals?.signal });
        if (!crafted.ok) return null;
      }
    }
    if (!hasItem(bot, "crafting_table")) return null;
    const item = findItem(bot, "crafting_table");
    if (item === null) return null;
    const spot = stationSlotSpot(bot, home, "crafting_table") ?? findPlacementSpot(bot, { x: home.x, y: home.y, z: home.z });
    if (spot === null) return null;
    const placed = await placeItemAt(bot, item, spot, this.signals?.signal);
    return placed !== null && placed.name === "crafting_table" ? placed : null;
  }

  /** A placed furnace near home, or one crafted+placed now. */
  private async ensureFurnace(): Promise<Block | null> {
    const bot = this.opts.bot;
    const home = this.opts.state.home;
    const existing = findBlockNear(bot, "furnace", FURNACE_SCAN_RADIUS);
    if (existing !== null) return existing;
    if (home === null) return null;

    if (!hasItem(bot, "furnace")) {
      const stone = await this.materialize("stone", FURNACE_STONE_COST);
      if (stone.ok) {
      const crafted = await craftItem(bot, "furnace", { signal: this.signals?.signal });
        if (!crafted.ok) return null;
      }
    }
    if (!hasItem(bot, "furnace")) return null;
    const item = findItem(bot, "furnace");
    if (item === null) return null;
    const spot = stationSlotSpot(bot, home, "furnace") ?? findPlacementSpot(bot, { x: home.x, y: home.y, z: home.z }, 6);
    if (spot === null) return null;
    const placed = await placeItemAt(bot, item, spot, this.signals?.signal);
    return placed !== null && placed.name === "furnace" ? placed : null;
  }

  /**
   * Carry at least `count` planks of any wood type: stored planks first,
   * then planks crafted from carried or stored logs. Planks alone left a
   * respawned bot unable to make a table with 48 logs at home (19:43, 20:15).
   */
  private async materializePlanks(count: number): Promise<{ ok: true } | { ok: false; reason: string }> {
    const bot = this.opts.bot;
    if (countPlanks(bot) >= count) return { ok: true };
    const carried: Record<string, number> = {};
    for (const item of bot.inventory.items()) carried[item.name] = (carried[item.name] ?? 0) + item.count;
    for (const action of planksPlan(count, carried, this.stored)) {
      if (this.stopRequested) break;
      if (action.kind === "withdraw") {
        const withdrawn = await withdrawFromHomeChest(bot, this.opts.state, this.opts.storage, action.item, action.count, this.opts.logger, this.signals?.signal);
        this.withdrawAccount(action.item, withdrawn.withdrawn);
      } else {
        const made = await craftItem(bot, action.item, { times: action.times, signal: this.signals?.signal });
        if (!made.ok) this.opts.logger.warn({ item: action.item, reason: made.reason }, "ensure_item: could not craft planks");
      }
      if (countPlanks(bot) >= count) return { ok: true };
    }
    return countPlanks(bot) >= count ? { ok: true } : { ok: false, reason: "not enough planks or logs in stock" };
  }

  // --- finishing ---

  private async finish(
    data: EnsureItemData,
    baseline: Record<string, number>,
    startedAt: number,
    alreadyHadIt: boolean,
  ): Promise<SkillResult<EnsureItemData>> {
    const bot = this.opts.bot;
    const bare = data.item;
    data.availableAtEnd = this.available(bare);

    const targetMet = data.availableAtEnd >= data.quantity;
    // Equipment and food stay carried; bulk materials are deposited into the
    // home chest (spec 23 delivery behavior). When the run started with the
    // target already available, nothing new arrived to deposit.
    const deposit = !alreadyHadIt && !this.keepCarried && !isEquipmentName(bare) && FOOD_ITEM_NAMES[bare] !== true;
    if (deposit && targetMet) {
      const delivered = await deliverCarried(bot, this.opts.state, this.opts.storage, bare, this.opts.logger, this.signals?.signal);
      data.delivered = delivered.delivered;
      if (delivered.delivered > 0) {
        this.stored[bare] = (this.stored[bare] ?? 0) + delivered.delivered;
      }
    }
    if (!targetMet) {
      const missing = Math.max(0, data.quantity - data.availableAtEnd);
      return this.fail(data, "RESOURCE_NOT_FOUND", `only ${data.availableAtEnd}/${data.quantity} ${resourceLabel(bare)} available (${missing} short)`, true);
    }
    if (this.stopRequested) return this.interrupted(data);

    if (alreadyHadIt) {
      this.announce(`Already have ${data.availableAtEnd} ${resourceLabel(bare)}.`);
    } else {
      this.announce(`Done. ${data.quantity} ${resourceLabel(bare)} ready.`);
    }
    this.recordSuccess(baseline, startedAt, data);
    return { ok: true, status: "completed", data };
  }

  // --- cooperative interrupt plumbing (mirrors the other runners) ---

  private checkInterrupt(): void {
    if (this.stopRequested || this.signals === null) return;
    const payload: EnsureResumeState = {
      item: this.currentItemName,
      quantity: this.currentQuantity,
      mode: this.mode,
      interruptions: this.interruptions + 1,
      version: 1,
    };
    if (!this.signals.checkpoint(payload)) {
      this.stopRequested = true;
      this.interruptions += 1;
    }
  }

  private travelAbort = (): boolean => {
    this.checkInterrupt();
    return this.stopRequested;
  };

  private currentItemName = "";
  private currentQuantity = 0;

  private interrupted(data: EnsureItemData): SkillResult<EnsureItemData> {
    data.interruptions = this.interruptions;
    this.opts.logger.info({ item: data.item }, "ensure_item interrupted");
    return { ok: false, status: "interrupted", retryable: true, data, message: "interrupted" };
  }

  /** Persist one SkillSuccess for a fully produced item (spec 20.2). */
  private recordSuccess(baseline: Record<string, number>, startedAt: number, data: EnsureItemData): void {
    const worldId = this.opts.state.worldId;
    if (worldId === null) return;
    const delta: Record<string, number> = {};
    for (const [name, count] of Object.entries(itemsSummary(this.opts.bot))) {
      const before = baseline[name] ?? 0;
      if (count !== before) delta[name] = count - before;
    }
    this.opts.skills.record({
      skillName: `ensure_item_${data.mode}`,
      parameters: { item: data.item, quantity: data.quantity },
      startingConditions: {
        inventorySummary: baseline,
        homeDistance: 0,
        timeOfDay: this.opts.bot.time && this.opts.bot.time.isDay ? "day" : "night",
      },
      outcome: {
        durationMs: Math.max(0, Date.now() - startedAt),
        interruptions: data.interruptions,
        finalInventoryDelta: delta,
      },
      description: `${data.mode} x${data.quantity} ${resourceLabel(data.item)} (gathered ${data.gathered}, crafted ${data.crafted}, smelted ${data.smelted}).`,
    });
  }

  private fail(data: EnsureItemData, errorCode: string, reason: string, retryable: boolean): SkillResult<EnsureItemData> {
    this.announce(`Stuck: ${reason}.`);
    this.opts.logger.info({ item: data.item, errorCode, reason }, "ensure_item failed");
    return {
      ok: false,
      status: "failed",
      errorCode,
      message: reason,
      retryable,
      data,
    };
  }

  private announce(message: string): void {
    this.opts.logger.info({ message }, "ensure_item status");
    if (this.opts.bot.entity === null) return;
    if (!this.chatThrottle.allow(message)) return;
    if (!gameChatBudgetAllows()) return;
    try {
      this.opts.bot.chat(message);
    } catch (err) {
      this.opts.logger.warn({ err: String(err) }, "ensure_item chat failed");
    }
  }
}

/**
 * Deterministic equipment upgrade ladder (spec 10.2): wood -> stone -> iron
 * when the resources are available, no user permission needed. Runs entirely
 * through the ensure machinery so every prerequisite is satisfied
 * deterministically. Returns the items upgraded this pass (empty when the
 * ladder is already at its top or no upgrade is affordable).
 */
export async function runEquipmentUpgrade(
  bot: Bot,
  runner: EnsureItemRunner,
  options: { signals?: TaskSignals } = {},
): Promise<SkillResult<{ upgraded: readonly string[] }>> {
  const upgraded: string[] = [];
  const familyNames: readonly ("pickaxe" | "axe")[] = ["pickaxe", "axe"];
  for (const family of familyNames) {
    const members = TOOL_FAMILIES[family];
    // The implemented ladder is wood -> stone -> iron (spec 10.2); gold is a
    // vanity tier and diamond is beyond the initial scope.
    const ladder = members.slice(0, 3);
    let carriedTier = -1;
    for (let i = 0; i < ladder.length; i++) {
      if (countItem(bot, ladder[i] ?? "") > 0) carriedTier = i;
    }
    const next = ladder[carriedTier + 1];
    if (next === undefined) continue;
    const result = await runner.run(next, 1, { mode: "ensure", signals: options.signals });
    if (result.ok) upgraded.push(next);
  }
  return upgraded.length > 0
    ? { ok: true, status: "completed", data: { upgraded } }
    : { ok: false, status: "failed", errorCode: "NOT_READY", message: "no affordable tool upgrade right now", retryable: false, data: { upgraded: [] } };
}

/** One step toward carrying enough planks. */
export type PlanksAction = { kind: "withdraw"; item: string; count: number } | { kind: "craft"; item: string; times: number };

/**
 * How to come by `need` planks: carried planks count first, then stored
 * planks are withdrawn, then carried logs are crafted (4 planks a log), then
 * stored logs are withdrawn and crafted.
 */
export function planksPlan(need: number, carried: Readonly<Record<string, number>>, stored: Readonly<Record<string, number>>): PlanksAction[] {
  const actions: PlanksAction[] = [];
  let short = need - Object.entries(carried).reduce((sum, [name, n]) => sum + (isPlanksItemName(name) ? n : 0), 0);
  for (const [name, n] of Object.entries(stored)) {
    if (short <= 0) return actions;
    if (!isPlanksItemName(name) || n <= 0) continue;
    const take = Math.min(short, n);
    actions.push({ kind: "withdraw", item: name, count: take });
    short -= take;
  }
  for (const source of [carried, stored]) {
    for (const [name, n] of Object.entries(source)) {
      if (short <= 0) return actions;
      if (!isRawLogItemName(name) || n <= 0) continue;
      const times = Math.min(n, Math.ceil(short / 4));
      if (source === stored) actions.push({ kind: "withdraw", item: name, count: times });
      actions.push({ kind: "craft", item: planksForLog(name), times });
      short -= times * 4;
    }
  }
  return actions;
}

/** Wait (bounded) for the chunks around the bot to finish loading. */
async function waitForChunks(bot: Bot): Promise<void> {
  const wait = (bot as { waitForChunksToLoad?: () => Promise<void> }).waitForChunksToLoad;
  if (typeof wait !== "function") return;
  await Promise.race([wait.call(bot).catch(() => undefined), new Promise<void>((resolve) => setTimeout(resolve, 5_000))]);
}
