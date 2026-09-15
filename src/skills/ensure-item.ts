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
import { bareName, countItem, countPlanks, findItem, hasItem, itemsSummary } from "../minecraft/inventory.js";
import { craftItem, itemId } from "../minecraft/crafting.js";
import { smeltItems } from "../minecraft/smelting.js";
import { countStoredItems, deliverCarried, withdrawFromHomeChest } from "../minecraft/containers.js";
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
}

/** The live catalog over a connected mineflayer bot. */
export function makeRecipeCatalog(bot: Bot): RecipeCatalog {
  return {
    gatherable: (item) => bot.registry.blocksByName[bareName(item)] !== undefined,
    recipesProducing: (item) => {
      const id = itemId(bot, item);
      if (id === null) return [];
      try {
        return bot.recipesAll(id, null, false) ?? [];
      } catch {
        return [];
      }
    },
    nameForId: (id) => {
      const items = bot.registry.items;
      if (items === undefined) return null;
      for (const [name, entry] of Object.entries(items)) {
        if (typeof entry === "object" && entry !== null && (entry as { id?: number }).id === id) {
          return bareName(name);
        }
      }
      return null;
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
  const bare = bareName(item);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return { ok: false, errorCode: "INVALID_RESOURCE", reason: `invalid quantity ${quantity} for '${bare}'` };
  }
  if (depth > MAX_PLAN_DEPTH) {
    return { ok: false, errorCode: "NOT_READY", reason: `prerequisite chain for '${bare}' is unreasonably deep` };
  }

  if (catalog.gatherable(bare)) {
    return okPlan([{ kind: "gather", item: bare, quantity }]);
  }
  if (FOOD_ITEM_NAMES[bare] === true && SMELT_INPUT_BY_OUTPUT[bare] === undefined) {
    return okPlan([{ kind: "hunt", item: bare, quantity }]);
  }
  const oreSource = ORE_SOURCE_BY_DROP[bare];
  if (oreSource !== undefined) {
    return okPlan([{ kind: "gather", item: oreSource, quantity }]);
  }
  const smeltInput = SMELT_INPUT_BY_OUTPUT[bare];
  if (smeltInput !== undefined) {
    const inputPlan = resolvePlan(smeltInput, quantity, catalog, depth + 1);
    if (!inputPlan.ok) return inputPlan;
    return okPlan(
      [...inputPlan.plan.steps, { kind: "fuel", quantity }, { kind: "smelt", item: bare, quantity }],
      inputPlan.plan.needsTable,
      true,
    );
  }

  const recipes = catalog.recipesProducing(bare);
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
    const sub = resolvePlan(name, -delta.count * crafts, catalog, depth + 1);
    if (!sub.ok) return sub;
    ingredientSteps.push(...sub.plan.steps);
    needsTable = needsTable || sub.plan.needsTable;
    needsFurnace = needsFurnace || sub.plan.needsFurnace;
  }
  return okPlan(
    [...ingredientSteps, { kind: "craft", item: bare, quantity: crafts, table: recipe.requiresTable }],
    needsTable,
    needsFurnace,
  );
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

  /** Produce `quantity` of `item` in the given mode, resolving when the run ends. */
  async run(item: string, quantity: number, options: EnsureRunOptions = {}): Promise<SkillResult<EnsureItemData>> {
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
    try {
      return await this.execute(item, quantity, mode);
    } finally {
      this.running = false;
      this.signals = null;
      this.stored = {};
    }
  }

  private async execute(item: string, quantity: number, mode: EnsureMode): Promise<SkillResult<EnsureItemData>> {
    const bot = this.opts.bot;
    const startedAt = Date.now();
    const baseline = itemsSummary(bot);
    const bare = bareName(item);
    const label = resourceLabel(bare);
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

    const stored = await countStoredItems(bot, this.opts.state, this.opts.storage);
    this.stored = { ...stored };
    data.availableAtStart = this.available(bare);

    // Already satisfied: materialize the shortfall for equipment; bulk stock
    // may stay in the chest.
    if (data.availableAtStart >= quantity) {
      const carried = countItem(bot, bare);
      if (isEquipmentName(bare) && carried < quantity) {
        const withdrawn = await withdrawFromHomeChest(bot, this.opts.state, this.opts.storage, bare, quantity - carried, this.opts.logger);
        this.withdrawAccount(bare, withdrawn.withdrawn);
        data.withdrawals += withdrawn.withdrawn;
      }
      return this.finish(data, baseline, startedAt, true);
    }

    const catalog = makeRecipeCatalog(bot);
    const planResult = resolvePlan(bare, quantity, catalog);
    if (!planResult.ok) {
      return this.fail(data, planResult.errorCode, planResult.reason, false);
    }
    const plan = planResult.plan;
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
    const result = await this.opts.collect.run(step.item, missing, { signals: this.signals ?? undefined });
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
    this.stored[drop] = (this.stored[drop] ?? 0) + (result.data?.delivered ?? missing);
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
      const result = await this.opts.collect.run("coal_ore", missing, { signals: this.signals ?? undefined });
      if (result.status === "interrupted") {
        this.interruptions += result.data?.interruptions ?? 0;
        this.stopRequested = true;
        return null;
      }
      if (result.ok || result.status === "partial") {
        this.stored["coal"] = (this.stored["coal"] ?? 0) + missing;
        return null;
      }
    }

    // 2. Produce charcoal from logs (each pass burns one fuel log, so a pass
    // needs two logs total). Depth-capped to one level; never recurses back
    // into this step.
    const charcoalMissing = Math.max(0, step.quantity - this.availableFuel());
    if (charcoalMissing > 0) {
      const logsNeeded = charcoalMissing * 2;
      const logs = await this.materialize("oak_log", logsNeeded);
      if (!logs.ok) {
        return { errorCode: "INSUFFICIENT_MATERIALS", reason: `no coal and no logs for charcoal (${logs.reason})`, retryable: false };
      }
      const furnace = await this.ensureFurnace();
      if (furnace === null) {
        return { errorCode: "NOT_READY", reason: "no furnace at home for charcoal", retryable: true };
      }
      const smelt = await smeltItems(this.opts.bot, furnace, {
        inputName: "oak_log",
        fuelName: "oak_log",
        outputName: "charcoal",
        times: charcoalMissing,
      });
      if (!smelt.ok) {
        return { errorCode: "NOT_READY", reason: `charcoal production failed: ${smelt.reason}`, retryable: true };
      }
      this.stored["charcoal"] = (this.stored["charcoal"] ?? 0) + charcoalMissing;
    }
    return null;
  }

  /** A craft step: run `quantity` craft passes of `item` at the table. */
  private async stepCraft(step: { item: string; quantity: number; table: boolean }, table: Block | null, data: EnsureItemData): Promise<StepFailure | null> {
    const name = bareName(step.item);
    const recipe = makeRecipeCatalog(this.opts.bot)
      .recipesProducing(name)
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
    const crafted = await craftItem(this.opts.bot, name, {
      times: step.quantity,
      craftingTable: step.table ? (table ?? undefined) : undefined,
    });
    if (!crafted.ok) {
      return { errorCode: "INSUFFICIENT_MATERIALS", reason: crafted.reason, retryable: true };
    }
    data.crafted += step.quantity;
    return null;
  }

  /** A smelt step: run `quantity` smelt passes of `item` in the furnace. */
  private async stepSmelt(step: { item: string; quantity: number }, furnace: Block | null, data: EnsureItemData): Promise<StepFailure | null> {
    const bare = bareName(step.item);
    const input = SMELT_INPUT_BY_OUTPUT[bare];
    if (input === undefined) {
      return { errorCode: "INVALID_RESOURCE", reason: `'${bare}' has no smelting recipe`, retryable: false };
    }
    const within = await this.materialize(input, step.quantity);
    if (!within.ok) {
      return { errorCode: "INSUFFICIENT_MATERIALS", reason: within.reason, retryable: false };
    }
    if (this.availableFuel() < step.quantity) {
      const fuel = await this.materializeFuel(step.quantity);
      if (!fuel.ok) {
        return { errorCode: "INSUFFICIENT_MATERIALS", reason: fuel.reason, retryable: false };
      }
    }
    if (furnace === null) {
      return { errorCode: "NOT_READY", reason: "no furnace at home to smelt", retryable: true };
    }
    const fuelItem = findItem(this.opts.bot, "coal") ?? findItem(this.opts.bot, "charcoal");
    if (fuelItem === null) {
      return { errorCode: "INSUFFICIENT_MATERIALS", reason: "no fuel to burn", retryable: false };
    }
    const smelted = await smeltItems(this.opts.bot, furnace, {
      inputName: input,
      fuelName: fuelItem.name,
      outputName: bare,
      times: step.quantity,
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
      const withdrawn = await withdrawFromHomeChest(this.opts.bot, this.opts.state, this.opts.storage, bare, fromChest, this.opts.logger);
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
    const existing = findBlockNear(bot, "crafting_table", TABLE_SCAN_RADIUS);
    if (existing !== null) return existing;
    if (home === null) return null;

    if (!hasItem(bot, "crafting_table")) {
      const planks = await this.materializePlanks(TABLE_PLANK_COST);
      if (planks.ok) {
        const crafted = await craftItem(bot, "crafting_table");
        if (!crafted.ok) return null;
      }
    }
    if (!hasItem(bot, "crafting_table")) return null;
    const item = findItem(bot, "crafting_table");
    if (item === null) return null;
    const spot = stationSlotSpot(bot, home, "crafting_table") ?? findPlacementSpot(bot, { x: home.x, y: home.y, z: home.z });
    if (spot === null) return null;
    const placed = await placeItemAt(bot, item, spot);
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
        const crafted = await craftItem(bot, "furnace");
        if (!crafted.ok) return null;
      }
    }
    if (!hasItem(bot, "furnace")) return null;
    const item = findItem(bot, "furnace");
    if (item === null) return null;
    const spot = stationSlotSpot(bot, home, "furnace") ?? findPlacementSpot(bot, { x: home.x, y: home.y, z: home.z }, 6);
    if (spot === null) return null;
    const placed = await placeItemAt(bot, item, spot);
    return placed !== null && placed.name === "furnace" ? placed : null;
  }

  /** Carry at least `count` planks of any wood type (deposited variants). */
  private async materializePlanks(count: number): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (countPlanks(this.opts.bot) >= count) return { ok: true };
    for (const [name, sitting] of Object.entries(this.stored)) {
      if (!name.endsWith("_planks") || sitting <= 0) continue;
      const need = count - countPlanks(this.opts.bot);
      if (need <= 0) return { ok: true };
      const withdrawn = await withdrawFromHomeChest(this.opts.bot, this.opts.state, this.opts.storage, name, Math.min(need, sitting), this.opts.logger);
      this.withdrawAccount(name, withdrawn.withdrawn);
    }
    return countPlanks(this.opts.bot) >= count ? { ok: true } : { ok: false, reason: "not enough planks in stock" };
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
    const deposit = !alreadyHadIt && !isEquipmentName(bare) && FOOD_ITEM_NAMES[bare] !== true;
    if (deposit && targetMet) {
      const delivered = await deliverCarried(bot, this.opts.state, this.opts.storage, bare, this.opts.logger);
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