import type { Bot } from "mineflayer";
import type { Block } from "prismarine-block";
import type { Logger } from "pino";
import type { AgentState } from "../agent/state.js";
import type { TaskSignals } from "../agent/scheduler.js";
import type { MinecraftConfig } from "../config/schema.js";
import type { EventBus } from "../events/bus.js";
import type { StorageRepository } from "../memory/storage.js";
import type { SkillsRepository } from "../memory/skills.js";
import { bareName, countItem, countLogs, countPlanks, countSticks, findItem, itemsSummary } from "../minecraft/inventory.js";
import { craftItem, craftPlanks, craftSticks } from "../minecraft/crafting.js";
import { deliverCarried, withdrawFromHomeChest } from "../minecraft/containers.js";
import { travelAndWait } from "../minecraft/movement.js";
import { collectBlocks, findBlockNear, findBlocksNear, findPlacementSpot, hasAirNeighbor, isRawLog, placeItemAt } from "../minecraft/world.js";
import { ChatThrottle, gameChatBudgetAllows, type SkillResult } from "./skill-library.js";

/**
 * Phase 7: `ensure_torches` skill (spec 29 — torch stockpile; one
 * coal/charcoal + one stick craft four torches). Crafts enough torches to
 * cover `quantity` missing torches and deposits them into the home chest.
 *
 * Materials are self-sufficient so the run never touches the fuel or wood
 * stockpiles that are still healthy: fuel comes from what is carried, then
 * the home chest (the stockpile manager guarantees fuel was topped up first —
 * spec 29's dependency rule), then freshly mined coal ore — mining coal
 * needs a pickaxe, so one is crafted (with a rebuilt table when the base was
 * wiped) before any ore is touched. Sticks come from carried logs, then a
 * fresh log gather. Torches are an inventory-grid craft; the table is only
 * for the pickaxe.
 */

// --- deterministic policy constants ---

/** Wall-clock budget for one home trip. */
const TRAVEL_TIMEOUT_MS = 120_000;
/** Wall-clock budget for one material-collection pass. */
const COLLECT_TIMEOUT_MS = 240_000;
/** Scan radius for the home crafting table. */
const TABLE_SCAN_RADIUS = 12;
/** Planks one crafting-table recipe consumes (2x2). */
const TABLE_PLANK_COST = 4;
/** Search radii reach the same bound the bootstrap hunt uses. */
const MAX_SEARCH_RADIUS = 256;
/** Torches each craft produces from one fuel unit and one stick. */
const TORCHES_PER_CRAFT = 4;
/** Candidate blocks considered per search radius. */
const CANDIDATES_PER_RADIUS = 24;

/** Blocks that drop coal when mined with a pickaxe. */
function isCoalOre(block: Block): boolean {
  return block.name === "coal_ore" || block.name === "deepslate_coal_ore";
}

/** Total carried fuel items (coal or charcoal) — both burn in the torch recipe. */
function countFuelItems(bot: Bot): number {
  return countItem(bot, "coal") + countItem(bot, "charcoal");
}

/** True when any carried item is a pickaxe (coal ore cannot be mined by hand). */
function hasPickaxe(bot: Bot): boolean {
  for (const item of bot.inventory.items()) {
    if (bareName(item.name).endsWith("_pickaxe")) return true;
  }
  return false;
}

export interface EnsureTorchesOptions {
  bot: Bot;
  state: AgentState;
  config: MinecraftConfig;
  bus: EventBus;
  /** Home storage registration (spec 22): the chest torches land in. */
  storage: StorageRepository;
  /** Skill success records (spec 20.2). */
  skills: SkillsRepository;
  logger: Logger;
}

export interface EnsureTorchesData {
  /** Torches the run was asked to add to the stockpile. */
  quantity: number;
  /** Individual crafts performed (one per 4 torches). */
  crafts: number;
  /** Torches carried when the run started. */
  carriedAtStart: number;
  /** Amount deposited into the home chest. */
  delivered: number;
  /** Times this task was cooperatively interrupted (Phase 8, persisted across resumes). */
  interruptions: number;
}

/** Progress persisted as the task's resume state (Phase 8). */
export interface EnsureTorchesResumeState {
  quantity: number;
  interruptions: number;
}

export interface EnsureTorchesRunOptions {
  /** Cooperative signals from the owning scheduler task; null for unbound runs. */
  signals?: TaskSignals;
  /** Resume state from a paused run of the same task. */
  resumeState?: EnsureTorchesResumeState;
}

/**
 * Deterministic `ensure_torches` skill. One run at a time; the stockpile
 * manager serializes maintenance, so a second run returns ALREADY_RUNNING.
 */
export class EnsureTorchesRunner {
  private running = false;

  /** Cooperative signals for the current run; null when unbound. */
  private signals: TaskSignals | null = null;
  /** True once a pause/cancel was observed; the run stops at the next boundary. */
  private stopRequested = false;
  /** Accumulated interrupts across pause/resume cycles of this task. */
  private interruptions = 0;
  private currentQuantity = 0;

  /** Identical game-chat lines repeat at most once per window (spam-kick guard). */
  private readonly chatThrottle: ChatThrottle;

  constructor(private readonly opts: EnsureTorchesOptions) {
    const throttleSeconds = opts.config.background?.announce_throttle_seconds ?? 30;
    this.chatThrottle = new ChatThrottle(throttleSeconds * 1000);
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Craft and deliver `quantity` torches (rounded up to whole crafts). */
  async run(quantity: number, options: EnsureTorchesRunOptions = {}): Promise<SkillResult<EnsureTorchesData>> {
    if (this.running) {
      return {
        ok: false,
        status: "blocked",
        errorCode: "ALREADY_RUNNING",
        message: "already crafting torches",
      };
    }
    this.running = true;
    this.signals = options.signals ?? null;
    this.interruptions = options.resumeState?.interruptions ?? 0;
    this.currentQuantity = quantity;
    this.stopRequested = false;
    try {
      return await this.execute(quantity);
    } finally {
      this.running = false;
      this.signals = null;
    }
  }

  private async execute(quantity: number): Promise<SkillResult<EnsureTorchesData>> {
    const bot = this.opts.bot;
    const startedAt = Date.now();
    const baseline = itemsSummary(bot);
    const crafts = Math.max(0, Math.ceil(quantity / TORCHES_PER_CRAFT));
    const data: EnsureTorchesData = {
      quantity,
      crafts,
      carriedAtStart: countItem(bot, "torch"),
      delivered: 0,
      interruptions: this.interruptions,
    };

    if (bot.entity === null) {
      return this.fail(data, "NOT_READY", "bot is not spawned");
    }
    if (crafts === 0) {
      return { ok: true, status: "completed", data, message: "no torches needed" };
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
      return this.fail(data, "PATH_UNREACHABLE", `could not return home: ${travel.status}`);
    }

    // Fuel: carried -> home chest -> fresh coal ore.
    let fuel = countFuelItems(bot);
    if (fuel < crafts) {
      await withdrawFromHomeChest(bot, this.opts.state, this.opts.storage, "coal", crafts - fuel, this.opts.logger);
      fuel = countFuelItems(bot);
      if (fuel < crafts) {
        await withdrawFromHomeChest(bot, this.opts.state, this.opts.storage, "charcoal", crafts - fuel, this.opts.logger);
        fuel = countFuelItems(bot);
      }
      if (fuel < crafts) {
        // mineCoalOre counts total carried fuel against `needed` (the
        // bootstrap FUEL contract), so the target here is the total the
        // crafts need — not the remaining deficit. A deficit would
        // short-circuit the search whenever half the fuel was already
        // carried.
        const mined = await this.mineCoalOre(crafts);
        if (this.stopRequested) return this.interrupted(data);
        if (!mined.ok) return this.fail(data, mined.code, mined.reason);
        fuel = countFuelItems(bot);
      }
      if (fuel < crafts) {
        return this.fail(data, "RESOURCE_NOT_FOUND", `only ${fuel}/${crafts} fuel for ${crafts} torch crafts`);
      }
    }

    // Sticks: carried planks/logs, or a fresh log gather. Each stick craft
    // turns two planks into four sticks; each log makes four planks.
    const sticksNeeded = Math.max(0, crafts - countSticks(bot));
    if (sticksNeeded > 0) {
      const planksNeeded = Math.max(0, Math.ceil(sticksNeeded / 4) * 2 - countPlanks(bot));
      if (planksNeeded > 0) {
        const logsNeeded = Math.ceil(planksNeeded / 4);
        if (countLogs(bot) < logsNeeded) {
          const gathered = await this.gatherLogs(logsNeeded);
          if (this.stopRequested) return this.interrupted(data);
          if (!gathered.ok) return this.fail(data, "RESOURCE_NOT_FOUND", gathered.reason);
        }
        const planks = await craftPlanks(bot, countPlanks(bot) + planksNeeded);
        if (!planks.ok) return this.fail(data, "TOOL_REQUIRED", planks.reason);
      }
      const sticks = await craftSticks(bot, countSticks(bot) + sticksNeeded);
      if (!sticks.ok) return this.fail(data, "TOOL_REQUIRED", sticks.reason);
    }

    // Torch is an inventory-grid recipe (coal/charcoal over a stick in the
    // 2x2 box), no crafting table needed — same craft as the bootstrap
    // TORCHES stage. The table-window variant opens the table and has failed
    // with "missing ingredient" on this server.
    if (this.stopRequested) return this.interrupted(data);
    const torches = await craftItem(bot, "torch", { times: crafts });
    if (!torches.ok) {
      return this.fail(data, "TOOL_REQUIRED", torches.reason);
    }
    if (this.stopRequested) return this.interrupted(data);

    const delivered = await deliverCarried(bot, this.opts.state, this.opts.storage, "torch", this.opts.logger);
    data.delivered = delivered.delivered;
    const done = delivered.delivered > 0;
    if (done) {
      this.announce(`Done. ${delivered.delivered} torches in the chest.`);
      this.recordSuccess(data, startedAt, baseline);
    }
    return {
      ok: done,
      status: done ? "completed" : "partial",
      data,
      errorCode: done ? undefined : "STORAGE_NOT_FOUND",
      message: done ? undefined : "crafted the torches but could not deposit them",
      retryable: !done,
    };
  }

  // --- Phase 8 cooperative interrupt plumbing ---

  /** Poll the task signals once and remember the result. */
  private checkInterrupt(): void {
    if (this.stopRequested || this.signals === null) return;
    const payload: EnsureTorchesResumeState = {
      quantity: this.currentQuantity,
      interruptions: this.interruptions + 1,
    };
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

  /** Terminal result for a paused/cancelled run. Partials stay carried. */
  private interrupted(data: EnsureTorchesData): SkillResult<EnsureTorchesData> {
    data.interruptions = this.interruptions;
    this.opts.logger.info({ crafts: data.crafts }, "ensure_torches interrupted");
    return { ok: false, status: "interrupted", retryable: true, data, message: "interrupted" };
  }

  /**
   * Craft a wooden pickaxe at the home crafting table so coal ore can be
   * mined. Mirrors the bootstrap wooden-kit mechanics: the missing table is
   * rebuilt (4 planks) when the base was wiped — a common state after
   * deaths — and planks/sticks come from fresh logs. Coal ore never drops
   * by hand, so this is the torch restore's own tool stage.
   */
  private async ensurePickaxe(): Promise<{ ok: true } | { ok: false; reason: string }> {
    const bot = this.opts.bot;
    const home = this.opts.state.home;
    if (hasPickaxe(bot)) return { ok: true };
    if (home === null) return { ok: false, reason: "no home to craft a pickaxe at" };

    let table = findBlockNear(bot, "crafting_table", TABLE_SCAN_RADIUS);
    if (table === null) {
      // The base was wiped: rebuild the table and place it near home,
      // falling back to a free cell two steps from the bot's own feet when
      // the home column is blocked (same fallback as the bootstrap table
      // stage — the bot's current position is walkable by definition).
      const logsNeeded = Math.max(0, Math.ceil((TABLE_PLANK_COST - countPlanks(bot)) / 4) - countLogs(bot));
      if (logsNeeded > 0) {
        const gathered = await this.gatherLogs(logsNeeded);
        if (!gathered.ok) return { ok: false, reason: gathered.reason };
      }
      const planks = await craftPlanks(bot, countPlanks(bot) + TABLE_PLANK_COST);
      if (!planks.ok) return { ok: false, reason: planks.reason };
      const crafted = await craftItem(bot, "crafting_table");
      if (!crafted.ok) return { ok: false, reason: crafted.reason };
      const item = findItem(bot, "crafting_table");
      if (item === null) return { ok: false, reason: "the crafted table vanished" };
      let spot = findPlacementSpot(bot, home);
      if (spot === null) {
        const fallbackCenter = bot.entity?.position;
        spot = fallbackCenter !== undefined ? findPlacementSpot(bot, fallbackCenter, 2) : null;
        if (spot !== null) {
          this.opts.logger.warn({ home, pos: fallbackCenter }, "ensure_torches: no table spot near home; placing near the bot");
        }
      }
      if (spot === null) return { ok: false, reason: "no floor space to place a crafting table at home" };
      const placed = await placeItemAt(bot, item, spot);
      if (placed === null || placed.name !== "crafting_table") {
        return { ok: false, reason: "could not place a crafting table at home" };
      }
      this.opts.logger.info({ position: placed.position }, "ensure_torches rebuilt the missing crafting table");
      table = placed;
    }

    // Reach the table, then craft the kit: 3 planks + 2 sticks (2 planks).
    const tableTravel = await travelAndWait(bot, table.position, {
      timeoutMs: TRAVEL_TIMEOUT_MS,
      range: 1,
      shouldAbort: this.travelAbort,
    });
    if (this.stopRequested) return { ok: false, reason: "interrupted" };
    if (tableTravel.status !== "arrived" && tableTravel.status !== "already_there") {
      return { ok: false, reason: "could not reach the crafting table" };
    }
    const logsNeeded = Math.max(0, Math.ceil((3 + 2 - countPlanks(bot)) / 4) - countLogs(bot));
    if (logsNeeded > 0) {
      const gathered = await this.gatherLogs(logsNeeded);
      if (!gathered.ok) return { ok: false, reason: gathered.reason };
    }
    const planks = await craftPlanks(bot, countPlanks(bot) + 3 + 2);
    if (!planks.ok) return { ok: false, reason: planks.reason };
    const sticks = await craftSticks(bot, countSticks(bot) + 2);
    if (!sticks.ok) return { ok: false, reason: sticks.reason };
    const made = await craftItem(bot, "wooden_pickaxe", { craftingTable: table });
    if (!made.ok) return { ok: false, reason: made.reason };
    this.opts.logger.info({}, "ensure_torches crafted a wooden pickaxe");
    return { ok: true };
  }

  /**
   * Mine exposed coal ore until `needed` fuel items are carried. Mirrors the
   * bootstrap FUEL machinery: world-facing ore only (an air-neighbor filter
   * keeps buried cave veins out of the targets), expanding search, and
   * per-block collection that skips sites the pathfinder cannot reach
   * instead of failing the pass on the first one. Coal ore drops coal, which
   * counts as fuel.
   */
  private async mineCoalOre(needed: number): Promise<{ ok: true; have: number } | { ok: false; code: string; reason: string }> {
    const bot = this.opts.bot;
    const config = this.opts.config.bootstrap;
    const baseRadius = config?.search_radius ?? 48;

    // Coal ore only drops when mined with a pickaxe; without one every
    // collect attempt must fail. Craft the missing pickaxe first — the
    // wooden kit is cheap and self-sufficient — so a fresh world or a
    // death that cost the tools never wedges the torch restore in a
    // TOOL_REQUIRED retry loop.
    if (!hasPickaxe(bot)) {
      const made = await this.ensurePickaxe();
      if (!made.ok) return { ok: false, code: "TOOL_REQUIRED", reason: made.reason };
    }

    let have = countFuelItems(bot);
    for (let radius = baseRadius; radius <= MAX_SEARCH_RADIUS && have < needed; radius = Math.min(radius * 2, MAX_SEARCH_RADIUS + 1)) {
      this.checkInterrupt();
      if (this.stopRequested) return { ok: false, code: "INTERRUPTED", reason: "interrupted" };
      const positions = findBlocksNear(bot, isCoalOre, radius, CANDIDATES_PER_RADIUS);
      const exposed = positions.filter((position) => hasAirNeighbor(bot, position));
      const targets = exposed.map((position) => bot.blockAt(position)).filter((block) => block !== null);
      if (targets.length === 0) {
        this.announce(`No exposed coal within ${radius} blocks. Expanding search.`);
        continue;
      }
      this.opts.logger.info(
        { radius, candidates: positions.length, exposed: targets.length, need: Math.max(0, needed - have) },
        "ensure_torches coal search",
      );

      const before = have;
      await collectBlocks(
        bot,
        targets,
        () => countFuelItems(bot),
        needed,
        (msg) => this.announce(msg),
        COLLECT_TIMEOUT_MS,
        (block, err) => this.opts.logger.warn({ at: block.position, err: String(err) }, "ensure_torches skipping unreachable coal"),
      );
      have = countFuelItems(bot);
      if (have <= before) {
        this.announce(`No coal reachable within ${radius} blocks. Expanding search.`);
      }
    }

    have = countFuelItems(bot);
    if (have < needed) return { ok: false, code: "RESOURCE_NOT_FOUND", reason: `only ${have}/${needed} coal found nearby` };
    return { ok: true, have };
  }

  /**
   * Gather raw logs until at least `targetTotal` are carried — the sticks
   * fallback when no planks/logs are carried. Same search-and-collect
   * mechanics as the bootstrap WOOD stage: per-block collection skips
   * unreachable sites instead of failing the pass.
   */
  private async gatherLogs(targetTotal: number): Promise<{ ok: true; have: number } | { ok: false; reason: string }> {
    const bot = this.opts.bot;
    const config = this.opts.config.bootstrap;
    const baseRadius = config?.search_radius ?? 48;

    let have = countLogs(bot);
    for (let radius = baseRadius; radius <= MAX_SEARCH_RADIUS && have < targetTotal; radius = Math.min(radius * 2, MAX_SEARCH_RADIUS + 1)) {
      this.checkInterrupt();
      if (this.stopRequested) return { ok: false, reason: "interrupted" };
      const positions = findBlocksNear(bot, isRawLog, radius, CANDIDATES_PER_RADIUS);
      const targets = positions.map((position) => bot.blockAt(position)).filter((block) => block !== null);
      if (targets.length === 0) continue;

      const before = have;
      await collectBlocks(
        bot,
        targets,
        () => countLogs(bot),
        targetTotal,
        (msg) => this.announce(msg),
        COLLECT_TIMEOUT_MS,
        (block, err) => this.opts.logger.warn({ at: block.position, err: String(err) }, "ensure_torches skipping unreachable log"),
      );
      have = countLogs(bot);
      if (have <= before) continue;
    }

    have = countLogs(bot);
    if (have < targetTotal) return { ok: false, reason: `only ${have}/${targetTotal} logs found nearby` };
    return { ok: true, have };
  }

  /** Persist one SkillSuccess for a fully delivered torch run (spec 20.2). */
  private recordSuccess(data: EnsureTorchesData, startedAt: number, baseline: Record<string, number>): void {
    const worldId = this.opts.state.worldId;
    if (worldId === null) return;
    const home = this.opts.state.home;
    const self = this.opts.bot.entity;
    const delta: Record<string, number> = {};
    for (const [name, count] of Object.entries(itemsSummary(this.opts.bot))) {
      const before = baseline[name] ?? 0;
      if (count !== before) delta[name] = count - before;
    }
    const distance =
      self !== null && home !== null
        ? Math.round(Math.hypot(self.position.x - home.x, self.position.y - home.y, self.position.z - home.z))
        : -1;
    this.opts.skills.record({
      skillName: "ensure_torches",
      parameters: { quantity: data.quantity, crafts: data.crafts },
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
      description: `Crafted ${data.crafts} torch crafts and delivered ${data.delivered} torches to the home chest.`,
    });
  }

  private fail(data: EnsureTorchesData, errorCode: string, reason: string): SkillResult<EnsureTorchesData> {
    this.announce(`Stuck: ${reason}.`);
    return {
      ok: false,
      status: "failed",
      errorCode,
      message: reason,
      retryable: true,
      data,
    };
  }

  private announce(message: string): void {
    this.opts.logger.info({ message }, "ensure_torches status");
    if (this.opts.bot.entity === null) return;
    if (!this.chatThrottle.allow(message)) return;
    if (!gameChatBudgetAllows()) return;
    try {
      this.opts.bot.chat(message);
    } catch (err) {
      this.opts.logger.warn({ err: String(err) }, "ensure_torches chat failed");
    }
  }
}