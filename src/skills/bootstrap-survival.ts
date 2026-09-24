import type { Bot } from "mineflayer";
import type { Block } from "prismarine-block";
import type { Entity } from "prismarine-entity";
import type { Logger } from "pino";
import { Vec3 } from "vec3";
import {
  BootstrapStage,
  BOOTSTRAP_STAGES,
  nextBootstrapStage,
} from "../agent/bootstrap.js";
import type { AgentState } from "../agent/state.js";
import type { Scheduler } from "../agent/scheduler.js";
import type { MinecraftConfig } from "../config/schema.js";
import type { EventBus } from "../events/bus.js";
import type { BootstrapRepository } from "../memory/bootstrap.js";
import type { SkillsRepository } from "../memory/skills.js";
import type { StorageRepository } from "../memory/storage.js";
import {
  bareName,
  countItem,
  countLogs,
  countPlanks,
  countSticks,
  findItem,
  hasItem,
  itemsSummary,
  logsByType,
} from "../minecraft/inventory.js";
import {
  craftItem,
  craftPlanks,
  craftSticks,
  failure,
  type CraftResult,
} from "../minecraft/crafting.js";
import type { Item } from "prismarine-item";
import { isCreativeMode } from "../minecraft/mode.js";
import { smeltItems } from "../minecraft/smelting.js";
import {
  ARRIVE_RANGE,
  travelAndWait,
  travelHomeAndWait,
  withPathfinderDigging,
  type HomeLocation,
} from "../minecraft/movement.js";
import {
  collectBlocks,
  findBlockNear,
  findBlocksNear,
  findBlocksNearRefined,
  findPlacementSpot,
  isAir,
  isSolid,
  isRawLog,
  placeItemAt,
} from "../minecraft/world.js";
import { regionContains } from "../minecraft/protection.js";
import { cancelCollection, collectBlockOperation, digBlock, equipItem, equipToolForBlock, pvpAttack, pvpStop } from "../minecraft/primitives.js";
import { gameChatBudgetAllows, HUNT_MIN_HEALTH, recoverLowHealth } from "./skill-library.js";
import { freeChestSlotSpot, stationSlotSpot } from "./base.js";
import { stopWorldPrimitives, throwIfAborted } from "../agent/world-actions.js";
import type { WorldMutation } from "../agent/world-actions.js";
import { isProtectedFixture, revalidateAction } from "../policy/action-boundary.js";
import { canonicalMobName, isLiveMob } from "../policy/combat.js";

/** Default wood target / search radius when the config omits `bootstrap`. */
const WOOD_LOG_TARGET = 8;
const SEARCH_RADIUS = 48;
const MAX_SEARCH_RADIUS = 256;
/** Default cobblestone target when the config omits `bootstrap.cobblestone`. */
const COBBLE_TARGET = 12;
/** How many nearest stone blocks each search pass considers for exposure. */
const STONE_CANDIDATES = 64;
const STONE_LOCAL_RADIUS = 32;
const STONE_SURFACE_VERTICAL_RANGE = 6;
const STONE_MAX_HOME_DISTANCE = 96;
const STONE_EXPLORATION_SITES = 6;
const STONE_SITE_SEPARATION = 32;
const STONE_FAILED_SITE_CLEARANCE = 24;
const STONE_MINE_ATTEMPTS = 3;
const STONE_EXPLORE_TIMEOUT_MS = 60_000;
const STONE_STAGE_TIMEOUT_MS = 12 * 60_000;
/** Hard depth cap (in steps) for the dig-down trench; stone lies well above this. */
const TRENCH_MAX_STEPS = 24;
/** Wall-clock budget for one trench step (dig + advance). */
const TRENCH_STEP_TIMEOUT_MS = 20_000;
const STONE_MINE_ROUTE_TIMEOUT_MS = 3 * 60_000;
const STONE_COLLECT_TIMEOUT_MS = 3 * 60_000;
/** Wall-clock budget for one block-collection pass. */
const COLLECT_TIMEOUT_MS = 240_000;
/** Wall-clock budget for one home trip. */
// Allow recovery from deep spawn points and long surface routes.
const TRAVEL_TIMEOUT_MS = 300_000;
/** Food items (raw + cooked meat) the FOOD stage aims to carry (spec 10 reserve). */
const FOOD_ITEM_TARGET = 8;
/** Passive mobs the FOOD stage hunts (spec 11: cow, pig, sheep, chicken). */
const HUNT_MOB_NAMES: Record<string, true> = {
  cow: true,
  pig: true,
  sheep: true,
  chicken: true,
};
/** Inventory items counted as food; cooked variants cover later-phase smelting. */
const FOOD_ITEM_NAMES: Record<string, true> = {
  beef: true,
  porkchop: true,
  mutton: true,
  chicken: true,
  cooked_beef: true,
  cooked_porkchop: true,
  cooked_mutton: true,
  cooked_chicken: true,
  // Jungle/forest biomes drop apples from trees and sheep/cows may be
  // absent; an apple is a legitimate, safe food item the bot can gather
  // deterministically (it falls from jungle leaves), so count it toward
  // the survival food reserve.
  apple: true,
};
/** Drops swept up after a kill: meat plus leather, wool, feathers, and eggs. */
const LOOT_ITEM_NAMES: Record<string, true> = {
  ...FOOD_ITEM_NAMES,
  leather: true,
  feather: true,
  egg: true,
};
/** Radius around the kill site that dropped items are swept for. */
const LOOT_RADIUS = 24;
/** Wall-clock budget for one kill: approach, fight, and drop sweep. */
const KILL_TIMEOUT_MS = 90_000;
/** Render-distance net: entities are only visible within view distance, so
 * radius expansion alone cannot find animals that are far away. When the
 * scan comes up empty, the hunt walks outward in these alternating cardinal
 * directions (day only) and re-scans, widening the net without roaming. */
const HUNT_OUTWARD_DIRS: readonly [dx: number, dz: number][] = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
];
const HUNT_OUTWARD_STEP = 32;
const HUNT_OUTWARD_LEGS = 2;
const HUNT_OUTWARD_LEG_TIMEOUT_MS = 180_000;
/** `bot.activateBlock` reach for the crafting table. */
const TABLE_REACH = 6;
/** Scan radius when looking for an already-placed crafting table. */
const TABLE_SCAN_RADIUS = 10;
/** Planks one crafting-table recipe consumes (2x2). */
const TABLE_PLANK_COST = 4;
/** Planks the chest recipe consumes (spec 22 / STORAGE stage). */
const CHEST_PLANK_COST = 8;
/** Wool blocks the WOOL stage aims to carry; three make one bed (spec 7.1 items 8-10). */
const WOOL_TARGET = 3;
/** Scan radius when looking for an already-placed bed at home. */
const BED_SCAN_RADIUS = 10;
/** Placement attempts for the bed, each on a different cell near home. */
const BED_PLACEMENT_TRIES = 3;
/** Scan radius when looking for an already-placed chest at home. */
const CHEST_SCAN_RADIUS = 10;
/** Scan radius when looking for an already-placed furnace at home. */
const FURNACE_SCAN_RADIUS = 10;
/** Cobblestone the FURNACE stage gathers for the furnace recipe (8). */
const FURNACE_COBBLE_TARGET = 8;
/** Coal/charcoal the FUEL stage aims to carry (config overridable). */
const FUEL_ITEM_TARGET = 4;
/** Torches the TORCHES stage aims to stock (config overridable). */
const TORCH_TARGET = 16;
/** Raw iron the IRON stage aims to gather when exposed ore is reachable. */
const IRON_ORE_TARGET = 6;
/**
 * Iron tool upgrade order (spec 7.1 items 17-18): the essential pair first,
 * then shovel and sword as surplus ingots permit. Costs are iron ingots.
 */
const IRON_TOOL_UPGRADES: readonly [name: string, cost: number][] = [
  ["iron_pickaxe", 3],
  ["iron_axe", 3],
  ["iron_shovel", 1],
  ["iron_sword", 2],
];
/** Wall-clock budget for one smelt pass in the home furnace. */
const SMELT_TIMEOUT_MS = 120_000;
/** Attempts per stage before the run gives up (idempotent stages retry safely). */
const STAGE_ATTEMPTS = 3;
const RETRY_DELAY_MS = 3_000;
/** Backoff before re-driving the state machine after a stage permanently fails. */
const BOOTSTRAP_RETRY_MS = 30_000;
/** Silence window before a still-stuck stage re-announces itself. */
const FAIL_ANNOUNCE_THROTTLE_MS = 10 * 60_000;

export type StageOutcome = { ok: true; message: string } | { ok: false; reason: string };

export interface BootstrapRunnerOptions {
  bot: Bot;
  state: AgentState;
  config: MinecraftConfig;
  bus: EventBus;
  stages: BootstrapRepository;
  /** Home storage registration (spec 22); the STORAGE stage writes the chest. */
  storage: StorageRepository;
  skills: SkillsRepository;
  logger: Logger;
  /** Scheduler boundary for bootstrap's Mineflayer work. */
  scheduler?: Scheduler;
  /**
   * Phase 8: polled between stages. When it returns true the run yields at
   * the very next stage boundary — progress is already persisted, so a later
   * spawn/tool call or a task-settled hook resumes from exactly the next
   * stage. Never polled inside a stage.
   */
  shouldYield?: () => boolean;
}

/**
 * Bootstrap state machine (spec section 7). Executes the Phase 5.6 stages
 * HOME -> WOOD -> CRAFTING -> STONE_TOOLS -> FOOD -> STORAGE -> FURNACE
 * -> FUEL -> TORCHES -> WOOL -> BED -> IRON -> IRON_TOOLS deterministically,
 * persisting each completed stage (spec 7.2: resumable after restart) and
 * emitting typed bus events. IRON gathers exposed ore opportunistically
 * (never blocking bootstrap); IRON_TOOLS smelts it and upgrades the kit when
 * ingots permit. Finishing persists NORMAL_OPERATION, the signal Phase 7
 * stockpile maintenance reads as "bootstrap done". The LLM never steers
 * these mechanics; it only sees the `run_bootstrap` / `bootstrap_status`
 * tools.
 */
export class BootstrapRunner {
  private running = false;
  private startedAt: number | null = null;
  /** Pending re-drive after a stage permanently failed (null when none armed). */
  private retryTimer: NodeJS.Timeout | null = null;
  /** Last failure announcement, so repeated retries of one stage stay quiet. */
  private lastFailAnnounce: { stage: BootstrapStage; at: number } | null = null;
  /** Startup line is announced once per process, not on every retry re-run. */
  private startupAnnounced = false;
  /** When the food-hunt status was last announced, to throttle retry spam. */
  private lastHuntAnnounceAt: number | null = null;
  private signal: AbortSignal | null = null;
  /** The session-level lease controller, so disconnect can release it. */
  private controller: AbortController | null = null;
  private activeRun: Promise<void> | null = null;
  /** Failed block targets are retained across retries of the current stage. */
  private readonly failedTargets = new Set<string>();
  private readonly failedMobIds = new Set<number>();
  /** Exact cells this deterministic controller has authorized for digging. */
  private readonly authorizedDigCells = new Set<string>();

  constructor(private readonly opts: BootstrapRunnerOptions) {}

  get worldId(): number | null {
    return this.opts.state.worldId;
  }

  /** Last completed stage from persistence, or null before bootstrap starts. */
  get completedStage(): BootstrapStage | null {
    const worldId = this.worldId;
    return worldId === null ? null : this.opts.stages.get(worldId);
  }

  /** The next stage to execute; null once the implemented scope is done. */
  get currentStage(): BootstrapStage | null {
    return nextBootstrapStage(this.completedStage);
  }

  get bootstrapState() {
    return this.worldId === null ? null : this.opts.stages.getState(this.worldId);
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Drive the state machine from where it last stopped. Idempotent. */
  async run(): Promise<void> {
    // A retry/resume hook can fire while the prior run is still waiting on a
    // world-action lease. Share that run instead of queuing a duplicate owner.
    if (this.activeRun !== null) return this.activeRun;
    const controller = new AbortController();
    this.controller = controller;
    const run = this.runOnce(controller);
    this.activeRun = run;
    try {
      await run;
    } finally {
      if (this.activeRun === run) this.activeRun = null;
      if (this.controller === controller) this.controller = null;
    }
  }

  /** Cancel and await any in-flight bootstrap before its bot session is torn down. */
  async stop(): Promise<void> {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.controller?.abort(new Error("bootstrap session ended"));
    await this.activeRun?.catch(() => undefined);
  }

  private async runOnce(controller: AbortController): Promise<void> {
    if (this.opts.scheduler !== undefined) {
      try {
        await this.opts.scheduler.runWorldAction(
          `bootstrap:${this.worldId ?? "unknown"}`,
          controller.signal,
          () => this.runLeased(controller.signal),
          {
            beforeMutation: (mutation: WorldMutation) => {
              const point = mutation.point ?? this.opts.bot.entity?.position;
              if (!point) throw new Error("bootstrap mutation policy revalidation requires a live bot position");
              // Bootstrap performs two kinds of first-party digs: collecting
              // exposed surface stone and the one-wide descending stone
              // trench. Both are deterministic, finite, and directly issued
              // by this controller, so they are safe inside the protected
              // home region — the generic "authorized terrain project" path
              // does not apply to this first-party lease. Only fixture digs
              // fall through to normal policy revalidation below.
              const action = mutation.action as Parameters<typeof revalidateAction>[1];
              if (action === "dig" && mutation.blockName !== undefined && this.authorizedDigCells.has(blockKey(point))) {
                // Bootstrap's own digs are deterministic and finite: exposed
                // surface-stone collection and the one-wide descending stone
                // trench. Both are performed under the bot's direct control
                // and never target fixtures, so they are safe inside the
                // protected home region — the generic "authorized terrain
                // project" path does not apply to this first-party lease.
                // Any other dig (or a dig of a protected fixture) still
                // falls through to the normal policy revalidation below.
                if (!isProtectedFixture(mutation.blockName)) {
                  const verdict = revalidateAction(this.opts.bot, action, point, this.opts.config, null, { blockName: mutation.blockName });
                  if (!verdict.allowed) throw new Error(verdict.violation?.reason ?? "bootstrap mutation rejected by policy");
                  return;
                }
              }
              const verdict = revalidateAction(this.opts.bot, action, point, this.opts.config, this.opts.state.protectedRegion, { blockName: mutation.blockName });
              if (!verdict.allowed) throw new Error(verdict.violation?.reason ?? "bootstrap mutation rejected by policy");
            },
            onCancel: () => stopWorldPrimitives(this.opts.bot), onRecovery: () => stopWorldPrimitives(this.opts.bot),
          },
        );
      } finally { controller.abort(new Error("bootstrap settled")); }
      return;
    }
    await this.runLeased(controller.signal);
  }

  private async runLeased(signal?: AbortSignal): Promise<void> {
    if (this.running || this.worldId === null) return;
    if (this.currentStage === null) return; // already finished
    if (this.opts.bot.entity === null) {
      this.opts.logger.warn("bootstrap deferred: bot not spawned yet");
      return;
    }

    if (isCreativeMode(this.opts.bot)) {
      if (this.currentStage !== BootstrapStage.NORMAL_OPERATION) {
        this.opts.logger.info("creative mode detected; skipping survival bootstrap");
        if (this.worldId !== null) this.opts.stages.save(this.worldId, BootstrapStage.NORMAL_OPERATION);
      }
      return;
    }

    this.running = true;
    this.startedAt = Date.now();
    this.signal = signal ?? null;
    try {
      let started = false;
      while (true) {
        const stage = this.currentStage;
        if (stage === null) return;
        if (this.opts.shouldYield?.() === true) {
          this.opts.logger.info({ stage }, "bootstrap yielding to higher-priority work; resuming later");
          return;
        }
        throwIfAborted(this.signal ?? undefined);
        if (!BOOTSTRAP_STAGES.includes(stage)) {
          // The next stage belongs to a later phase (or is NORMAL_OPERATION):
          // NORMAL_OPERATION is our terminal marker, so persist it even when
          // this process resumed after IRON_TOOLS and did no work itself.
          // Other future-phase stages should remain quiet unless this run
          // actually completed part of the current bootstrap scope.
          if (stage === BootstrapStage.NORMAL_OPERATION || started) this.finishScope();
          return;
        }
        if (!started && !this.startupAnnounced) {
          this.announce("Starting up: home, wood, crafting table, wooden and stone tools, food, sheep wool, bed, storage, furnace, fuel, torches — then iron when available.");
          this.startupAnnounced = true;
        }
        // A resumed run may already have announced startup in an earlier
        // attempt. Track stage execution independently so reaching the end
        // still calls finishScope() and persists NORMAL_OPERATION.
        started = true;
        // Snapshot before the stage so its SkillSuccess record describes the
        // inventory it started from, not the whole session's baseline.
        const baseline = itemsSummary(this.opts.bot);
        const outcome = await this.executeWithRetries(stage);
        if (!outcome.ok) {
          if (stage === BootstrapStage.WOOL || stage === BootstrapStage.BED) {
            this.deferOptionalStage(stage, outcome.reason, baseline);
            continue;
          }
          this.failStage(stage, outcome.reason);
          const worldId = this.worldId;
          if (worldId !== null) {
            this.opts.stages.recordFailure(worldId, `${stage}: ${outcome.reason}`, Date.now() + BOOTSTRAP_RETRY_MS, stage === BootstrapStage.STONE_TOOLS ? 1 : STAGE_ATTEMPTS);
            this.opts.stages.markBlocked(worldId, `${stage}: ${outcome.reason}`);
          }
          this.opts.logger.error({ stage, reason: outcome.reason, action: "TERMINAL_BLOCK" }, "bootstrap exhausted stage attempt budget");
          this.scheduleRetry();
          return;
        }
        this.completeStage(stage, outcome.message, baseline);
      }
    } finally {
      // Food acquisition temporarily disables auto-eat so the reserve is
      // durable; restore the session policy even when a stage throws.
      this.opts.bot.autoEat.enableAuto();
      this.running = false;
      this.signal = null;
    }
  }

  // --- stage execution ---

  /**
   * Re-drive the state machine after a permanent stage failure. A failed
   * stage is not terminal: the runner is resumable and stage execution is
   * idempotent, so a transient blocker (server lag, a night-time mob, an
   * unreachable coordinate) clears on a later pass. Without this, a failed
   * bootstrap left the bot standing idle forever — Phase 7 waits on
   * NORMAL_OPERATION, so the idle loop silently never engaged (spec 7.2).
   */
  private scheduleRetry(): void {
    if (this.retryTimer !== null) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.run();
    }, BOOTSTRAP_RETRY_MS);
    this.retryTimer.unref?.();
  }

  private async executeWithRetries(stage: BootstrapStage): Promise<StageOutcome> {
    let last: StageOutcome = { ok: false, reason: "no attempt ran" };
    const attempts = stage === BootstrapStage.STONE_TOOLS ? 1 : STAGE_ATTEMPTS;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const startedAt = Date.now();
      this.opts.logger.info({ stage, attempt, completed: this.completedStage, inventory: itemsSummary(this.opts.bot) }, "BOOTSTRAP phase start");
      throwIfAborted(this.signal ?? undefined);
      last = await this.executeStage(stage);
      this.opts.logger.info({ stage, attempt, elapsedMs: Date.now() - startedAt, ok: last.ok, reason: last.ok ? undefined : last.reason }, "BOOTSTRAP phase settled");
      if (last.ok) return last;
      if (attempt < attempts) {
        this.opts.logger.warn({ stage, attempt, reason: last.reason }, "bootstrap stage attempt failed; retrying");
        await sleep(RETRY_DELAY_MS, this.signal ?? undefined);
      }
    }
    return last;
  }

  private async withAuthorizedDigCells<T>(positions: readonly Vec3[], action: () => Promise<T>): Promise<T> {
    const keys = positions.map(blockKey);
    for (const key of keys) this.authorizedDigCells.add(key);
    try { return await action(); }
    finally { for (const key of keys) this.authorizedDigCells.delete(key); }
  }

  private async executeStage(stage: BootstrapStage): Promise<StageOutcome> {
    switch (stage) {
      case BootstrapStage.HOME:
        return this.stageHome();
      case BootstrapStage.WOOD:
        return this.stageWood();
      case BootstrapStage.CRAFTING:
        return this.stageCrafting();
      case BootstrapStage.STONE_TOOLS:
        return this.stageStoneTools();
      case BootstrapStage.FOOD:
        return this.stageFood();
      case BootstrapStage.WOOL:
        return this.stageWool();
      case BootstrapStage.BED:
        return this.stageBed();
      case BootstrapStage.STORAGE:
        return this.restoreHomeChest();
      case BootstrapStage.FURNACE:
        return this.stageFurnace();
      case BootstrapStage.FUEL:
        return this.stageFuel();
      case BootstrapStage.TORCHES:
        return this.stageTorches();
      case BootstrapStage.IRON:
        return this.stageIron();
      case BootstrapStage.IRON_TOOLS:
        return this.stageIronTools();
      default:
        return { ok: false, reason: `stage not implemented: ${stage}` };
    }
  }

  /** HOME: walk to the configured home coordinate and wait for arrival. */
  private async stageHome(): Promise<StageOutcome> {
    const bot = this.opts.bot;
    let home = this.opts.state.home;
    if (home === null) return { ok: false, reason: "no home coordinate configured" };

    const self = bot.entity;
    if (self === null) return { ok: false, reason: "bot is not spawned" };

    // The configured home Y is a nominal altitude (often 64) or a leftover
    // from wherever the bot first stood; the real ground at the home X/Z can
    // differ by tens of blocks (a spawn mountain). Home is anchored by its
    // X/Z — the protected-region centre — so standing at those X/Z counts as
    // arrived, and the home Y is snapped to the actual diggable ground at the
    // column and persisted, so every later stage (and the go_home tool) paths
    // to a reachable altitude instead of a buried or airborne one.
    const p = self.position;
    if (Math.hypot(p.x - home.x, p.z - home.z) <= ARRIVE_RANGE) {
      const surfaceY = groundLevelAt(bot, Math.floor(home.x), Math.floor(home.z)) ?? Math.floor(p.y);
      if (surfaceY !== Math.floor(home.y)) {
        this.opts.state.setHome({ ...home, y: surfaceY });
        this.opts.logger.info({ from: Math.floor(home.y), to: surfaceY }, "home Y snapped to ground level");
      }
      return { ok: true, message: "Reached home." };
    }

    // Not at home yet: walk toward the home X/Z at the current altitude
    // first (a buried configured Y is unreachable as a goal), then re-snap
    // the Y on arrival the same way.
    const surfaceGoal = { x: home.x, y: Math.floor(p.y), z: home.z };
    const travel = await travelAndWait(bot, surfaceGoal, {
      dimension: home.dimension,
      timeoutMs: TRAVEL_TIMEOUT_MS,
    });
    switch (travel.status) {
      case "arrived":
      case "already_there": {
        const after = bot.entity;
        if (after !== null) {
          const surfaceY = groundLevelAt(bot, Math.floor(home.x), Math.floor(home.z)) ?? Math.floor(after.position.y);
          if (surfaceY !== Math.floor(home.y)) {
            this.opts.state.setHome({ ...home, y: surfaceY });
            this.opts.logger.info({ from: Math.floor(home.y), to: surfaceY }, "home Y snapped to ground level");
          }
        }
        return { ok: true, message: "Reached home." };
      }
      case "timed_out":
        return { ok: false, reason: "timed out traveling home" };
      case "wrong_dimension":
        return { ok: false, reason: `home is in dimension '${home.dimension}'` };
      case "not_ready":
        return { ok: false, reason: "bot is not ready to move" };
      case "aborted":
        // Bootstrap never passes shouldAbort (stage-boundary yields only);
        // a defensive path so a future hook cannot misread the status.
        return { ok: false, reason: "interrupted while traveling home" };
      default:
        return { ok: false, reason: `could not travel home: ${travel.error}` };
    }
  }

  /**
   * Guarantee a REACHABLE home before stage mechanics run. A registered
   * general chest is the durable shelter anchor when the persisted home was
   * accidentally moved by an earlier recovery attempt. If navigation still
   * fails, keep the persisted home intact and let the stage retry instead of
   * moving the protected region to a transient standing position.
   */
  private async ensureReachableHome(scope: string): Promise<boolean> {
    const bot = this.opts.bot;
    let home = this.opts.state.home;
    if (home === null || bot.entity === null) return false;

    const previousHome = home;
    const registeredHome = this.opts.storage
      .listByCategory(this.worldId ?? -1, "general")
      .filter((location) => location.dimension === home!.dimension)
      .map((location) => ({ location, block: bot.blockAt(new Vec3(location.x, location.y, location.z)) }))
      .find(({ block }) => block !== null && isChestBlock(block));
    if (registeredHome !== undefined) {
      const { location } = registeredHome;
      const distance = Math.hypot(location.x - home.x, location.z - home.z);
      if (distance > ARRIVE_RANGE) {
        const aligned: HomeLocation = {
          dimension: location.dimension,
          x: location.x,
          y: location.y,
          z: location.z,
        };
        this.opts.state.setHome(aligned);
        home = aligned;
        this.opts.logger.info({ from: previousHome, to: aligned, chest: location }, "home aligned to registered chest");
      }
    }

    const p = bot.entity.position;
    const snapY = (): number =>
      groundLevelAt(bot, Math.floor(home.x), Math.floor(home.z)) ?? Math.floor(bot.entity!.position.y);

    if (Math.hypot(p.x - home.x, p.z - home.z) <= ARRIVE_RANGE) {
      const surfaceY = snapY();
      if (surfaceY !== Math.floor(home.y)) {
        this.opts.state.setHome({ ...home, y: surfaceY });
        this.opts.logger.info({ from: Math.floor(home.y), to: surfaceY }, "home Y snapped to ground level");
      }
      return true;
    }

    const travel = await travelHomeAndWait(bot, home, { dimension: home.dimension, timeoutMs: TRAVEL_TIMEOUT_MS });
    if (travel.status === "arrived" || travel.status === "already_there") {
      const after = bot.entity;
      if (after !== null) {
        const surfaceY = groundLevelAt(bot, Math.floor(home.x), Math.floor(home.z)) ?? Math.floor(after.position.y);
        if (surfaceY !== Math.floor(home.y)) {
          this.opts.state.setHome({ ...home, y: surfaceY });
          this.opts.logger.info({ from: Math.floor(home.y), to: surfaceY }, "home Y snapped to ground level");
        }
      }
      return true;
    }

    this.opts.logger.warn({ scope, travel, home }, "home unreachable; keeping persisted home");
    this.announce(`Home unreachable (${travel.status}); retrying without moving home.`);
    return false;
  }

  /** WOOD: collect raw logs until the target is met, expanding the search. */
  private async stageWood(): Promise<StageOutcome> {
    const bot = this.opts.bot;
    const config = this.opts.config.bootstrap;
    const target = config?.wood_logs ?? WOOD_LOG_TARGET;
    const baseRadius = config?.search_radius ?? SEARCH_RADIUS;
    const region = this.opts.state.protectedRegion;

    let have = countLogs(bot);
    if (have >= target) return { ok: true, message: `Already carrying ${have} logs.` };

    for (let radius = baseRadius; radius <= MAX_SEARCH_RADIUS && have < target; radius = Math.min(radius * 2, MAX_SEARCH_RADIUS + 1)) {
      // Apply the standable-face check inside Mineflayer's search so a nearby
      // canopy cannot consume the 24-result cap and hide reachable trunk
      // bases farther out in the advertised radius.
      const positions = findBlocksNearRefined(bot, isRawLog, (position) => isReachableTrunkBase(bot, position), radius, 24);
      if (positions.length === 0) {
        this.announce(`No logs within ${radius} blocks. Expanding search.`);
        continue;
      }
      // Prefer trees outside the protected home region, but keep inside-region
      // logs as a fallback: on uneven terrain the "better" trees may sit in
      // an unreachable pocket, and skipping them must not empty the pass.
      const outside = region ? positions.filter((v) => !regionContains(region, { x: v.x, y: v.y, z: v.z })) : positions;
      const inside = region ? positions.filter((v) => regionContains(region, { x: v.x, y: v.y, z: v.z })) : [];
      const ordered = [...outside, ...inside]
        .map((v) => bot.blockAt(v))
        .filter((block) => block !== null);
      if (ordered.length === 0) {
        this.announce(`No logs within ${radius} blocks. Expanding search.`);
        continue;
      }

      const before = countLogs(bot);
      const gained = await this.withAuthorizedDigCells(ordered.map((block) => block.position), () => collectBlocks(
        bot,
        ordered,
        () => countLogs(bot),
        target,
        (msg) => this.announce(msg),
        COLLECT_TIMEOUT_MS,
        (block, err) => this.opts.logger.warn({ at: block.position, err: String(err) }, "skipping unreachable block"),
        undefined,
        this.failedTargets,
      ));
      have = countLogs(bot);
      this.opts.logger.warn({ radius, gained, skipped: ordered.length - gained, have }, "wood collect pass finished");
      if (have <= before) {
        this.announce(`No logs reachable within ${radius} blocks. Expanding search.`);
      }
    }

    have = countLogs(bot);
    if (have < target) return { ok: false, reason: `only ${have}/${target} logs found nearby` };
    return { ok: true, message: `Gathered ${have} logs.` };
  }

  /** CRAFTING: planks, sticks, table, placement at home, then wooden tools. */
  private async stageCrafting(): Promise<StageOutcome> {
    const bot = this.opts.bot;
    const needTable = !hasItem(bot, "crafting_table");
    const needPickaxe = !hasItem(bot, "wooden_pickaxe");
    const needAxe = !hasItem(bot, "wooden_axe");

    // Full kit costs 4 (table) + 3 + 3 (tools) + 2 (sticks) planks.
    const sticksTarget = needPickaxe || needAxe ? 4 : 0;
    const planksTarget = (needTable ? 4 : 0) + (needPickaxe ? 3 : 0) + (needAxe ? 3 : 0) + (sticksTarget > 0 ? 2 : 0);

    // Death recovery: a persisted earlier stage guarantees nothing about the
    // inventory (the bot can die at night and drop its logs), so when the
    // plank budget exceeds held logs + planks, re-gather the deficit with the
    // same deterministic search used by the WOOD stage instead of failing the
    // stage forever on a stale "stage complete" marker.
    if (planksTarget > 0) {
      const totalPlanks = countPlanks(bot) + countLogs(bot) * 4;
      if (totalPlanks < planksTarget) {
        const neededLogs = Math.ceil((planksTarget - totalPlanks) / 4);
        const regathered = await this.gatherLogs(countLogs(bot) + neededLogs);
        if (!regathered.ok) return { ok: false, reason: regathered.reason };
      }
    }

    if (planksTarget > 0 && countPlanks(bot) < planksTarget) {
      const planks = await craftPlanks(bot, planksTarget, this.signal ?? undefined);
      if (!planks.ok) return { ok: false, reason: planks.reason };
    }
    if (sticksTarget > 0 && countSticks(bot) < sticksTarget) {
      const sticks = await craftSticks(bot, sticksTarget, this.signal ?? undefined);
      if (!sticks.ok) return { ok: false, reason: sticks.reason };
    }
    if (needTable) {
      const table = await craftItem(bot, "crafting_table", { signal: this.signal ?? undefined });
      if (!table.ok) return { ok: false, reason: table.reason };
    }

    const table = await this.ensureTableAtHome();
    if (table === null) return { ok: false, reason: "could not place a crafting table at home" };

    const made: string[] = [];
    if (needPickaxe) {
      const pickaxe = await this.craftAtTable("wooden_pickaxe", table);
      if (!pickaxe.ok) return { ok: false, reason: pickaxe.reason };
      made.push("pickaxe");
    }
    if (needAxe) {
      const axe = await this.craftAtTable("wooden_axe", table);
      if (!axe.ok) return { ok: false, reason: axe.reason };
      made.push("axe");
    }

    const message = made.length > 0 ? `Crafting table placed; wooden ${made.join(" and ")} ready.` : "Crafting table ready.";
    return { ok: true, message };
  }

  /** Ensure a placed crafting table exists within `TABLE_SCAN_RADIUS` of home. */
  private async ensureTableAtHome(): Promise<Block | null> {
    const bot = this.opts.bot;
    let home = this.opts.state.home;
    if (home === null) return null;

    const self = bot.entity;
    if (self === null) return null;

    // Home's stored Y can be buried or airborne on uneven terrain; the home
    // X/Z column is what anchors the base. Route to the column at the bot's
    // own level, then snap the persisted Y to the real ground on arrival.
    const p = self.position;
    if (Math.hypot(p.x - home.x, p.z - home.z) > ARRIVE_RANGE) {
      const goal = { x: home.x, y: Math.floor(p.y), z: home.z };
      const travel = await travelAndWait(bot, goal, {
        dimension: home.dimension,
        timeoutMs: TRAVEL_TIMEOUT_MS,
      });
      if (travel.status !== "arrived" && travel.status !== "already_there") {
        this.opts.logger.warn({ travel, home, pos: p }, "crafting: travel home failed");
        return null;
      }
    }
    const after = bot.entity;
    if (after !== null) {
      const surfaceY = groundLevelAt(bot, Math.floor(home.x), Math.floor(home.z)) ?? Math.floor(after.position.y);
      if (surfaceY !== Math.floor(home.y)) {
        this.opts.state.setHome({ ...home, y: surfaceY });
        this.opts.logger.info({ from: Math.floor(home.y), to: surfaceY }, "home Y snapped to ground level");
      }
    }
    // setHome may have corrected the Y; the placement scan must anchor on
    // the corrected home, not the stale local copy.
    const correctedHome = this.opts.state.home ?? home;

    const existing = findBlockNear(bot, "crafting_table", TABLE_SCAN_RADIUS);
    if (existing !== null) return existing;

    let item = findItem(bot, "crafting_table");
    if (item === null) {
      // The base was wiped (chest and table gone — e.g. a chunk rollback or
      // griefing), so neither a placed table nor a carried one exists.
      // Rebuild the table with the same craft-and-place mechanics as
      // organize-storage's ensureTableAtHome; without it the STORAGE
      // restore (and every table craft) would fail forever.
      if (countPlanks(bot) < TABLE_PLANK_COST) {
        const shortfall = TABLE_PLANK_COST - countPlanks(bot);
        const logsNeeded = Math.max(0, Math.ceil(shortfall / 4) - countLogs(bot));
        if (logsNeeded > 0) {
          const logsPrep = await this.ensureLogs(logsNeeded);
          if (!logsPrep.ok) {
            this.opts.logger.warn({ home: correctedHome, reason: logsPrep.reason }, "crafting: could not gather logs for a new table");
            return null;
          }
        }
        const planks = await craftPlanks(bot, countPlanks(bot) + TABLE_PLANK_COST, this.signal ?? undefined);
        if (!planks.ok) {
          this.opts.logger.warn({ home: correctedHome, reason: planks.reason }, "crafting: could not craft planks for a new table");
          return null;
        }
      }
      const crafted = await craftItem(bot, "crafting_table", { signal: this.signal ?? undefined });
      if (!crafted.ok) {
        this.opts.logger.warn({ home: correctedHome, reason: crafted.reason }, "crafting: could not craft a new table");
        return null;
      }
      item = findItem(bot, "crafting_table");
      if (item === null) {
        this.opts.logger.warn({ home: correctedHome }, "crafting: the crafted table vanished");
        return null;
      }
      this.opts.logger.info({ home: correctedHome }, "crafting: rebuilt the missing crafting table");
    }
    const spot = stationSlotSpot(bot, correctedHome, "crafting_table") ?? findPlacementSpot(bot, correctedHome);
    if (spot === null) {
      // The home column may be blocked (a tree on slope terrain, e.g. spawn
      // mountains) while the bot itself stands on open ground. Fall back to
      // a free cell two steps from the bot's own feet — the bot's current
      // position is, by definition, walkable and clear.
      const fallbackCenter = bot.entity?.position;
      const nearby = fallbackCenter !== undefined ? findPlacementSpot(bot, fallbackCenter, 2) : null;
      this.opts.logger.warn({ home: correctedHome, nearby: nearby?.position, pos: bot.entity?.position }, "crafting: no placement spot near home");
      if (nearby === null) return null;
      const placedNear = await placeItemAt(bot, item, nearby, this.signal ?? undefined);
      if (placedNear === null || placedNear.name !== "crafting_table") {
        this.opts.logger.warn({ home: correctedHome, spot: nearby.position, placed: placedNear?.name }, "crafting: placement did not stick");
        return null;
      }
      return placedNear;
    }

    const placed = await placeItemAt(bot, item, spot, this.signal ?? undefined);
    if (placed === null || placed.name !== "crafting_table") {
      this.opts.logger.warn({ home: correctedHome, spot: spot.position, placed: placed?.name }, "crafting: placement did not stick");
      return null;
    }
    return placed;
  }

  /** Craft one table recipe, first re-approaching the table if out of reach. */
  private async craftAtTable(name: string, table: Block): Promise<CraftResult> {
    const bot = this.opts.bot;
    const home = this.opts.state.home;
    const self = bot.entity;
    if (self !== null) {
      const p = self.position;
      const distance = Math.hypot(p.x - table.position.x, p.y - table.position.y, p.z - table.position.z);
      if (distance > TABLE_REACH) {
        if (home === null) return { ok: false, name, reason: "no home to return to for crafting" };
        const travel = await travelHomeAndWait(bot, home, { dimension: home.dimension, timeoutMs: TRAVEL_TIMEOUT_MS });
        if (travel.status !== "arrived" && travel.status !== "already_there") {
          return { ok: false, name, reason: "could not return to the crafting table" };
        }
      }
    }
    return craftItem(bot, name, { craftingTable: table, signal: this.signal ?? undefined });
  }

  // --- stone tools (Phase 5.2) ---

  /**
   * STONE_TOOLS: gather cobblestone, then upgrade the wooden kit to stone.
   * Exposed surface stone is collected first (same mechanics as WOOD); when
   * none is reachable (flat terrain), a one-wide descending ramp is dug by
   * hand until the target is met. The ramp's 1-block steps are climbable by
   * the pathfinder, so the bot can always walk back out and return home.
   */
  private async stageStoneTools(): Promise<StageOutcome> {
    const bot = this.opts.bot;
    const config = this.opts.config.bootstrap;
    const target = config?.cobblestone ?? COBBLE_TARGET;
    const wantSword = config?.stone_sword ?? true;

    let home = this.opts.state.home;
    if (home === null) return { ok: false, reason: "no home coordinate configured" };

    // Stone recovery is an expedition, including the return to its staging
    // point. Refuse to move while critically hurt and unable to regenerate:
    // otherwise a stranded restart can roam (or clear terrain) before the
    // later mining health checks ever run.
    if (bot.health <= HUNT_MIN_HEALTH) {
      const recovered = await recoverLowHealth(bot);
      if (!recovered.ok) return { ok: false, reason: `unsafe to gather stone prerequisites: ${recovered.reason}` };
    }

    const travel = await travelHomeAndWait(bot, home, {
      dimension: home.dimension,
      timeoutMs: TRAVEL_TIMEOUT_MS,
      allowDig: false,
    });
    if (travel.status !== "arrived" && travel.status !== "already_there") {
      if (!await this.ensureReachableHome("stone_tools")) return { ok: false, reason: "home unreachable; keeping persisted home" };
      home = this.opts.state.home;
      if (home === null) return { ok: false, reason: "no home coordinate configured" };
    }
    const table = await this.ensureTableAtHome();
    if (table === null) return { ok: false, reason: "could not find a crafting table at home" };

    // The wooden kit from CRAFTING may have been lost (death/restart); re-craft
    // what is missing so mining stone is always possible.
    const wooden = await this.ensureWoodenKit(table);
    if (!wooden.ok) return { ok: false, reason: wooden.reason };

    const gathering = await this.gatherCobblestone(target);
    if (!gathering.ok) return { ok: false, reason: gathering.reason };

    const stoneTools: string[] = ["stone_pickaxe", "stone_axe", "stone_shovel"];
    if (wantSword) stoneTools.push("stone_sword");
    const missing = stoneTools.filter((name) => !hasItem(bot, name));
    if (missing.length > 0) {
      // Two planks per tool handle; the sword takes one, so this over-buys.
      const sticks = await craftSticks(bot, countSticks(bot) + missing.length * 2, this.signal ?? undefined);
      if (!sticks.ok) return { ok: false, reason: sticks.reason };
    }

    const made: string[] = [];
    for (const name of missing) {
      const crafted = await this.craftAtTable(name, table);
      if (!crafted.ok) return { ok: false, reason: crafted.reason };
      made.push(name.replace(/^stone_/, ""));
    }

    const message =
      made.length > 0
        ? `Gathered ${gathering.have} cobblestone; stone ${made.join(" and ")} ready.`
        : `Gathered ${gathering.have} cobblestone; stone tools were already ready.`;
    return { ok: true, message };
  }

  // --- food hunting (Phase 5.3) ---

  /**
   * FOOD: hunt passive animals (cow, pig, sheep, chicken) near home until the
   * food target is carried. Auto-eat is enabled first so any food obtained is
   * consumed as hunger drains, and the hunt itself only breaks off when health
   * runs low. Searches radiate from the base radius; at night the radius stays
   * at the base (spec 9.2: long surface hunts at night are unsafe).
   */
  private async stageFood(): Promise<StageOutcome> {
    const bot = this.opts.bot;
    const config = this.opts.config.bootstrap;
    const target = config?.food_items ?? FOOD_ITEM_TARGET;
    // Build a durable reserve first. Auto-eat may consume a drop between the
    // loot sweep and the inventory read, making a successful hunt look like a
    // failed stage. Re-enable it at every terminal exit below.
    bot.autoEat.disableAuto();
    const finish = (outcome: StageOutcome): StageOutcome => {
      bot.autoEat.enableAuto();
      return outcome;
    };

    let have = countFoodItems(bot);
    if (have >= target) return finish({ ok: true, message: `Already carrying ${have} food items.` });

    let home = this.opts.state.home;
    if (home === null) return finish({ ok: false, reason: "no home coordinate configured" });

    const travel = await travelHomeAndWait(bot, home, {
      dimension: home.dimension,
      timeoutMs: TRAVEL_TIMEOUT_MS,
    });
    if (travel.status !== "arrived" && travel.status !== "already_there") {
      if (!await this.ensureReachableHome("food")) return finish({ ok: false, reason: "home unreachable; keeping persisted home" });
      home = this.opts.state.home;
      if (home === null) return finish({ ok: false, reason: "no home coordinate configured" });
    }

    const baseRadius = config?.search_radius ?? SEARCH_RADIUS;
    const atNight = !bot.time.isDay;
    const maxRadius = atNight ? baseRadius : MAX_SEARCH_RADIUS;

    // When the render-distance net comes up empty, walk outward in a few
    // orthogonal legs and re-scan (day only; night hunting stays near home).
    const outwardLegs = atNight ? 0 : HUNT_OUTWARD_LEGS;
    const homeForLegs = this.opts.state.home;
    const announceHunt = (message: string): void => {
      // Surface the same hunt status at most once per throttle window so a
      // stuck stage does not spam chat across retry cycles.
      const now = Date.now();
      if (this.lastHuntAnnounceAt !== null && now - this.lastHuntAnnounceAt < FAIL_ANNOUNCE_THROTTLE_MS) return;
      this.lastHuntAnnounceAt = now;
      this.announce(message);
    };

    let kills = 0;
    for (let leg = 0; leg <= outwardLegs && have < target; leg++) {
      // Outward legs are daytime expeditions; low health blocks those. Leg 0
      // (home) is exempt: the radius scan below kills nearby animals even at
      // low health — a passive mob cannot fight back and its meat is the
      // only recovery a starving bot can reach alone.
      if (leg > 0 && bot.health <= HUNT_MIN_HEALTH) {
        const recovered = await recoverLowHealth(bot);
        if (!recovered.ok) return finish({ ok: false, reason: recovered.reason });
      }
      if (leg > 0 && homeForLegs !== null) {
        const dirIndex = (leg - 1) % HUNT_OUTWARD_DIRS.length;
        const dir = HUNT_OUTWARD_DIRS[dirIndex];
        const self = bot.entity;
        if (self !== null && dir !== undefined) {
          const p = self.position;
          const [dx, dz] = dir;
          const goalX = homeForLegs.x + dx * HUNT_OUTWARD_STEP;
          const goalZ = homeForLegs.z + dz * HUNT_OUTWARD_STEP;
          // The leg target must sit at the DESTINATION's ground level, not
          // the current altitude: on uneven terrain a goal 32 blocks away at
          // the bot's own Y is often 10+ blocks under or over the surface,
          // so `GoalNear` can never be satisfied and the leg times out.
          const goalY = groundLevelAt(bot, goalX, goalZ) ?? Math.floor(p.y);
          const goal = { x: goalX, y: goalY, z: goalZ };
          const legTravel = await travelAndWait(bot, goal, {
            dimension: homeForLegs.dimension,
            timeoutMs: HUNT_OUTWARD_LEG_TIMEOUT_MS,
          });
          if (legTravel.status !== "arrived" && legTravel.status !== "already_there") {
            this.opts.logger.warn({ leg, travel: legTravel }, "food: outward leg unreachable; scanning this spot instead");
          }
        }
        announceHunt(`No animals near home; checking ${HUNT_OUTWARD_STEP * leg} blocks out.`);
      }

      let foundHere = false;
      for (let radius = baseRadius; radius <= maxRadius && have < target && !foundHere; radius = Math.min(radius * 2, maxRadius + 1)) {
        // Low health only blocks when this radius offers nothing to hunt: a
        // passive animal cannot fight back, and killing it at low health is
        // the only self-recoverable path (auto-eat heals off the meat).
        if (bot.health <= HUNT_MIN_HEALTH && nearestHuntableMob(bot, radius) === null) {
          const recovered = await recoverLowHealth(bot);
          if (!recovered.ok) return finish({ ok: false, reason: recovered.reason });
        }
        const mob = nearestHuntableMob(bot, radius);
        if (mob === null) {
          if (leg === 0) {
            announceHunt(
              atNight
                ? "No animals close to home; night hunting stays nearby."
                : `No animals within ${radius} blocks. Expanding search.`,
            );
          }
          continue;
        }

        const before = countFoodItems(bot);
        const kill = await this.killMob(mob);
        if (!kill.ok) return finish({ ok: false, reason: kill.reason });
        kills += 1;
        have = countFoodItems(bot);
        if (have <= before) {
          announceHunt(`Hunted ${kill.name}; no food dropped.`);
        } else {
          foundHere = true;
        }
      }
    }

    have = countFoodItems(bot);
    if (have < target) return finish({ ok: false, reason: `only ${have}/${target} food found nearby` });
    return finish({ ok: true, message: `Hunted ${kills} animal${kills === 1 ? "" : "s"}; ${have} food items ready.` });
  }

  // --- sheep / bed (Phase 5.4) ---

  /**
   * WOOL: find sheep near home and hunt them until the wool target is carried
   * (spec 7.1 items 8-9). Sheep fleece drops as dyed wool, so the same kill
   * path as FOOD works; the hunt still breaks off when health runs low and
   * stays near home at night (spec 9.2). Idempotent: wool already carried
   * from an earlier hunt (or a restart) completes the stage immediately.
   */
  private async stageWool(): Promise<StageOutcome> {
    const bot = this.opts.bot;
    const config = this.opts.config.bootstrap;
    const target = config?.wool_blocks ?? WOOL_TARGET;
    // Eating stays enabled so the hunt does not starve mid-kill (idempotent).
    bot.autoEat.enableAuto();

    // Bed recipes require three wool blocks of the same color. Counting all
    // dyed wool together can leave the next BED stage with an uncrafteable
    // mix such as one white, one brown, and one gray wool.
    let have = maxWoolColorCount(bot);
    if (have >= target) return { ok: true, message: `Already carrying ${have} wool.` };

    let home = this.opts.state.home;
    if (home === null) return { ok: false, reason: "no home coordinate configured" };

    const travel = await travelHomeAndWait(bot, home, {
      dimension: home.dimension,
      timeoutMs: TRAVEL_TIMEOUT_MS,
    });
    if (travel.status !== "arrived" && travel.status !== "already_there") {
      if (!await this.ensureReachableHome("wool")) return { ok: false, reason: "home unreachable; keeping persisted home" };
      home = this.opts.state.home;
      if (home === null) return { ok: false, reason: "no home coordinate configured" };
    }

    const baseRadius = config?.search_radius ?? SEARCH_RADIUS;
    const atNight = !bot.time.isDay;
    const maxRadius = atNight ? baseRadius : (config?.hunt_max_radius ?? MAX_SEARCH_RADIUS);
    const outwardLegs = atNight ? 0 : HUNT_OUTWARD_LEGS;
    const homeForLegs = this.opts.state.home;

    let kills = 0;
    for (let leg = 0; leg <= outwardLegs && have < target; leg++) {
      if (leg > 0 && bot.health <= HUNT_MIN_HEALTH) {
        const recovered = await recoverLowHealth(bot);
        if (!recovered.ok) return { ok: false, reason: recovered.reason };
      }
      if (leg > 0 && homeForLegs !== null) {
        const dir = HUNT_OUTWARD_DIRS[(leg - 1) % HUNT_OUTWARD_DIRS.length];
        const self = bot.entity;
        if (self !== null && dir !== undefined) {
          const [dx, dz] = dir;
          const goalX = homeForLegs.x + dx * HUNT_OUTWARD_STEP;
          const goalZ = homeForLegs.z + dz * HUNT_OUTWARD_STEP;
          const goalY = groundLevelAt(bot, goalX, goalZ) ?? Math.floor(self.position.y);
          const legTravel = await travelAndWait(bot, { x: goalX, y: goalY, z: goalZ }, {
            dimension: homeForLegs.dimension,
            timeoutMs: HUNT_OUTWARD_LEG_TIMEOUT_MS,
          });
          if (legTravel.status !== "arrived" && legTravel.status !== "already_there") {
            this.opts.logger.warn({ leg, travel: legTravel }, "wool: outward leg unreachable; scanning this spot instead");
          }
        }
        this.announce(`No sheep near home; checking ${HUNT_OUTWARD_STEP * leg} blocks out.`);
      }

      let foundHere = false;
      for (let radius = baseRadius; radius <= maxRadius && have < target && !foundHere; radius = Math.min(radius * 2, maxRadius + 1)) {
        if (bot.health <= HUNT_MIN_HEALTH && nearestSheep(bot, radius, this.failedMobIds) === null) {
          const recovered = await recoverLowHealth(bot);
          if (!recovered.ok) return { ok: false, reason: recovered.reason };
        }
        const sheep = nearestSheep(bot, radius, this.failedMobIds);
        if (sheep === null) {
          if (leg === 0) {
            this.announce(
              atNight
                ? "No sheep close to home; night hunting stays nearby."
                : `No sheep within ${radius} blocks. Expanding search.`,
            );
          }
          continue;
        }

        const before = maxWoolColorCount(bot);
        const kill = await this.killMob(sheep);
        if (!kill.ok) {
          this.failedMobIds.add(sheep.id);
          this.opts.logger.warn({ entityId: sheep.id, target: sheep.position, reason: kill.reason }, "bootstrap hunt target blacklisted");
          return { ok: false, reason: kill.reason };
        }
        kills += 1;
        have = maxWoolColorCount(bot);
        if (have <= before) {
          this.announce(`Hunted ${kill.name}; no wool dropped.`);
        } else {
          foundHere = true;
        }
      }
    }

    have = maxWoolColorCount(bot);
    if (have < target) return { ok: false, reason: `only ${have}/${target} wool found nearby` };
    return { ok: true, message: `Hunted ${kills} sheep; ${have} wool ready.` };
  }

  /**
   * BED: ensure a bed stands at home (spec 7.1 items 10-11). An already-placed
   * bed completes the stage; otherwise craft one (three wool + three planks,
   * a 3x3 recipe, so at the crafting table) and place it near home. Placement
   * retries on fresh cells, since a bed occupies two blocks and the head may
   * collide with existing blocks.
   */
  private async stageBed(): Promise<StageOutcome> {
    const bot = this.opts.bot;
    let home = this.opts.state.home;
    if (home === null) return { ok: false, reason: "no home coordinate configured" };

    const travel = await travelHomeAndWait(bot, home, {
      dimension: home.dimension,
      timeoutMs: TRAVEL_TIMEOUT_MS,
    });
    if (travel.status !== "arrived" && travel.status !== "already_there") {
      if (!await this.ensureReachableHome("bed")) return { ok: false, reason: "home unreachable; keeping persisted home" };
      home = this.opts.state.home;
      if (home === null) return { ok: false, reason: "no home coordinate configured" };
    }

    const existing = bedBlockNear(bot, BED_SCAN_RADIUS);
    if (existing !== null) return { ok: true, message: "Bed already placed at home." };

    if (findBedItem(bot) === null) {
      // A persisted world may have completed the old WOOL stage by counting
      // mixed colors together. Repair that state in place before attempting
      // the color-specific bed recipe.
      if (maxWoolColorCount(bot) < WOOL_TARGET) {
        return { ok: false, reason: "bed deferred: no three matching wool blocks available" };
      }
      // Modern registries only know colored beds, and each color's recipe
      // demands matching wool ("red_bed" always wants red_wool, etc.); the
      // bed is crafted from whatever wool is actually carried. A fresh stock
      // also needs logs, so gather wood first instead of retrying forever on
      // spent leftovers.
      const logsPrep = await this.ensureLogs(1);
      if (!logsPrep.ok) return { ok: false, reason: logsPrep.reason };
      const table = await this.ensureTableAtHome();
      if (table === null) return { ok: false, reason: "could not find a crafting table at home" };
      const planks = await craftPlanks(bot, countPlanks(bot) + 3, this.signal ?? undefined);
      if (!planks.ok) return { ok: false, reason: planks.reason };
      const bed = await this.craftBedAtTable(table);
      if (!bed.ok) return { ok: false, reason: bed.reason };
    }

    const excluded: Vec3[] = [];
    for (let attempt = 0; attempt < BED_PLACEMENT_TRIES; attempt++) {
      const item = findBedItem(bot);
      if (item === null) return { ok: false, reason: "bed vanished before placement" };
      const spot = findPlacementSpot(bot, home, TABLE_SCAN_RADIUS, excluded);
      if (spot === null) return { ok: false, reason: "no floor space near home for a bed" };
      const placed = await placeItemAt(bot, item, spot, this.signal ?? undefined);
      if (placed !== null && isBedBlock(placed)) {
        return { ok: true, message: "Bed crafted and placed at home." };
      }
      excluded.push(spot.position);
    }

    return { ok: false, reason: "could not place the bed at home" };
  }

  // --- storage / furnace / fuel / torches (Phase 5.5) ---

  /**
   * Re-establish the home chest (spec 7.1 item 12, spec 22): travel home
   * (claiming the bot's position as home when the configured coordinate is
   * unreachable), adopt a chest already standing there (re-registering it),
   * or craft and place a fresh one (eight planks at the home table), then
   * register it as general storage and drop registered rows whose blocks no
   * longer stand. The bootstrap state machine runs these mechanics once as
   * the STORAGE stage; persisting NORMAL_OPERATION means it never re-runs,
   * so normal operation calls this entry point whenever the deposit or
   * measurement layer reports the home chest missing — a destroyed or
   * rolled-back chest self-heals instead of making every stockpile restore
   * fail forever. Idempotent: a healthy chest is returned as-is.
   */
  async restoreHomeChest(): Promise<StageOutcome> {
    const bot = this.opts.bot;
    let home = this.opts.state.home;
    if (home === null) return { ok: false, reason: "no home coordinate configured" };

    const travel = await travelHomeAndWait(bot, home, {
      dimension: home.dimension,
      timeoutMs: TRAVEL_TIMEOUT_MS,
    });
    if (travel.status !== "arrived" && travel.status !== "already_there") {
      if (!await this.ensureReachableHome("storage")) return { ok: false, reason: "home unreachable; keeping persisted home" };
      home = this.opts.state.home;
      if (home === null) return { ok: false, reason: "no home coordinate configured" };
    }

    const existing = chestBlockNear(bot, CHEST_SCAN_RADIUS);
    if (existing !== null) {
      this.registerChest(existing.position);
      this.pruneDeadChestRows();
      this.opts.logger.info({ position: existing.position }, "home chest found; re-registered");
      return { ok: true, message: "Chest already placed at home." };
    }

    if (!hasItem(bot, "chest")) {
      const table = await this.ensureTableAtHome();
      if (table === null) return { ok: false, reason: "could not find a crafting table at home" };

      // Eight planks make the chest. Verify the outcome instead of trusting
      // the craft result — a grid-click race can leave fewer planks than
      // the recipe consumed — and re-gather/retry once before failing.
      for (let attempt = 0; attempt < 2 && countPlanks(bot) < CHEST_PLANK_COST; attempt++) {
        const logsNeeded = Math.max(0, Math.ceil((CHEST_PLANK_COST - countPlanks(bot)) / 4) - countLogs(bot));
        if (logsNeeded > 0) {
          const logsPrep = await this.ensureLogs(logsNeeded);
          if (!logsPrep.ok) return { ok: false, reason: logsPrep.reason };
        }
      const planks = await craftPlanks(bot, CHEST_PLANK_COST, this.signal ?? undefined);
        if (!planks.ok && countPlanks(bot) < CHEST_PLANK_COST && attempt === 0) {
          this.opts.logger.warn({ reason: planks.reason, planks: countPlanks(bot) }, "chest planks under-crafted; retrying");
        }
      }
      if (countPlanks(bot) < CHEST_PLANK_COST) {
        return { ok: false, reason: `only ${countPlanks(bot)}/${CHEST_PLANK_COST} planks for a chest` };
      }
      const chest = await this.craftAtTable("chest", table);
      if (!chest.ok) return { ok: false, reason: chest.reason };
    }

    const item = findItem(bot, "chest");
    if (item === null) return { ok: false, reason: "chest vanished before placement" };
    let spot = freeChestSlotSpot(bot, home) ?? findPlacementSpot(bot, home);
    if (spot === null) {
      // The home column may be blocked (a crater from repeated deaths at
      // spawn, e.g.) while the bot itself stands on open ground. Mirror the
      // table rebuild's fallback: try a free cell two steps from the bot's
      // own feet — its current position is walkable by definition.
      const fallbackCenter = bot.entity?.position;
      spot = fallbackCenter !== undefined ? findPlacementSpot(bot, fallbackCenter, 2) : null;
      if (spot !== null) {
        this.opts.logger.warn({ home, pos: fallbackCenter }, "no floor space near home for a chest; placing near the bot");
      }
    }
    if (spot === null) return { ok: false, reason: "no floor space near home for a chest" };
    const placed = await placeItemAt(bot, item, spot, this.signal ?? undefined);
    if (placed === null || !isChestBlock(placed)) {
      return { ok: false, reason: "could not place the chest at home" };
    }
    this.registerChest(placed.position);
    this.pruneDeadChestRows();
    this.opts.logger.info({ position: placed.position }, "home chest placed and registered");
    return { ok: true, message: "Chest crafted, placed, and registered at home." };
  }

  /**
   * Drop registered rows whose block no longer stands — a destroyed or
   * rolled-back chest leaves a registration that would otherwise shadow the
   * live chest in measurements forever. Only chests near the bot are
   * pruned: a far-away LLM-registered chest can sit in an unloaded chunk,
   * and `blockAt` returning null there must not read as row deletion.
   */
  private pruneDeadChestRows(): void {
    const bot = this.opts.bot;
    const worldId = this.worldId;
    const self = bot.entity;
    if (worldId === null || self === null) return;
    for (const location of this.opts.storage.list(worldId)) {
      if (Math.hypot(location.x - self.position.x, location.z - self.position.z) > CHEST_SCAN_RADIUS) continue;
      const block = bot.blockAt(new Vec3(location.x, location.y, location.z));
      if (block === null || !isChestBlock(block)) {
        this.opts.storage.remove(worldId, location.id);
        this.opts.logger.info(
          { id: location.id, position: [location.x, location.y, location.z] },
          "pruned stale chest registration",
        );
      }
    }
  }

  /**
   * FURNACE: a furnace stands at home (spec 7.1 item 13). Eight cobblestone
   * (from the stone-tools surplus or a fresh gather) craft one via the 3x3
   * recipe at the table, and it is placed near home. The FUEL stage reuses
   * the same placement helper.
   */
  private async stageFurnace(): Promise<StageOutcome> {
    const bot = this.opts.bot;
    let home = this.opts.state.home;
    if (home === null) return { ok: false, reason: "no home coordinate configured" };

    const travel = await travelHomeAndWait(bot, home, {
      dimension: home.dimension,
      timeoutMs: TRAVEL_TIMEOUT_MS,
    });
    if (travel.status !== "arrived" && travel.status !== "already_there") {
      if (!await this.ensureReachableHome("furnace")) return { ok: false, reason: "home unreachable; keeping persisted home" };
      home = this.opts.state.home;
      if (home === null) return { ok: false, reason: "no home coordinate configured" };
    }

    const alreadyPlaced = furnaceBlockNear(bot, FURNACE_SCAN_RADIUS) !== null;
    const furnace = await this.ensureFurnaceAtHome();
    if (furnace === null) return { ok: false, reason: "could not craft or place a furnace at home" };
    return alreadyPlaced
      ? { ok: true, message: "Furnace already placed at home." }
      : { ok: true, message: "Furnace crafted and placed at home." };
  }

  /**
   * FUEL: carry coal or charcoal until the fuel target is met (spec 7.1 item
   * 14). Exposed coal ore is mined first with the stone pickaxe (same
   * world-facing search as cobblestone); when none is reachable, logs are
   * smelted into charcoal in the home furnace — one log burned as fuel
   * converts one log into one charcoal.
   */
  private async stageFuel(): Promise<StageOutcome> {
    const bot = this.opts.bot;
    const config = this.opts.config.bootstrap;
    const target = config?.fuel_items ?? FUEL_ITEM_TARGET;

    let have = countFuelItems(bot);
    if (have >= target) return { ok: true, message: `Already carrying ${have} fuel items.` };

    await this.mineCoalOre(target);
    have = countFuelItems(bot);
    if (have >= target) return { ok: true, message: `Mined coal; ${have} fuel items ready.` };

    const charcoal = await this.produceCharcoal(target - have);
    if (!charcoal.ok) return { ok: false, reason: charcoal.reason };
    have = countFuelItems(bot);
    if (have < target) return { ok: false, reason: `only ${have}/${target} fuel items after smelting` };
    return { ok: true, message: `Smelted logs into charcoal; ${have} fuel items ready.` };
  }

  /**
   * TORCHES: stock torches at home (spec 7.1 item 15). Each craft turns one
   * coal/charcoal and one stick into four torches; sticks come from planks,
   * so the fuel stock the FUEL stage secured is the limiting ingredient.
   */
  private async stageTorches(): Promise<StageOutcome> {
    const bot = this.opts.bot;
    const config = this.opts.config.bootstrap;
    const target = config?.torches ?? TORCH_TARGET;

    let have = countItem(bot, "torch");
    if (have >= target) return { ok: true, message: `Already carrying ${have} torches.` };

    const crafts = Math.ceil((target - have) / 4);
    const fuels = countFuelItems(bot);
    if (fuels < crafts) {
      return { ok: false, reason: `only ${fuels} coal/charcoal for ${crafts} torch crafts` };
    }

    // Sticks come from planks; secure the wood first so a fresh stock never
    // stalls the stage on carried leftovers.
    const planksNeeded = Math.max(0, Math.ceil(crafts / 2) - countPlanks(bot));
    if (planksNeeded > 0) {
      const logsPrep = await this.ensureLogs(Math.ceil(planksNeeded / 4));
      if (!logsPrep.ok) return { ok: false, reason: logsPrep.reason };
      const planks = await craftPlanks(bot, countPlanks(bot) + planksNeeded, this.signal ?? undefined);
      if (!planks.ok) return { ok: false, reason: planks.reason };
    }
    const sticks = await craftSticks(bot, countSticks(bot) + crafts, this.signal ?? undefined);
    if (!sticks.ok) return { ok: false, reason: sticks.reason };
    // This server can acknowledge only part of a multi-recipe craft before
    // Mineflayer attempts the next slot transaction, yielding a misleading
    // "missing ingredient" after consuming some coal. Craft one recipe at a
    // time and re-read the authoritative inventory between each operation.
    for (let craft = 0; craft < crafts && countItem(bot, "torch") < target; craft++) {
      const torches = await craftItem(bot, "torch", { times: 1, signal: this.signal ?? undefined });
      if (!torches.ok) return { ok: false, reason: torches.reason };
    }

    have = countItem(bot, "torch");
    return { ok: true, message: `Crafted ${have} torches.` };
  }

  // --- iron (Phase 5.6) ---

  /**
   * IRON: gather exposed iron ore until the raw-iron target is carried (spec
   * 7.1 item 17: "opportunistically gather iron"). Like coal, only
   * world-facing ore is mined — never a tunnel — and a miss is fine: the
   * stage always passes so bootstrap never blocks on iron, and IRON_TOOLS
   * upgrades only when ore was actually found.
   */
  private async stageIron(): Promise<StageOutcome> {
    const bot = this.opts.bot;
    const config = this.opts.config.bootstrap;
    const target = config?.iron_ore ?? IRON_ORE_TARGET;

    let have = countItem(bot, "raw_iron");
    if (have >= target) return { ok: true, message: `Already carrying ${have} raw iron.` };

    const mined = await this.mineIronOre(target);
    if (mined.ok) return { ok: true, message: `Mined ${mined.have} raw iron; ready for iron tools.` };
    have = countItem(bot, "raw_iron");
    if (have > 0) return { ok: true, message: `Gathered ${have} raw iron; no more exposed ore nearby.` };
    return { ok: true, message: "No exposed iron nearby; staying with stone tools." };
  }

  /**
   * IRON_TOOLS: smelt every raw iron into ingots, then upgrade the kit to
   * iron as ingots permit — pickaxe and axe first (spec 10.2: wood -> stone
   * -> iron; tool upgrades need no user permission). No iron at all
   * completes the stage immediately; operational failures (smelting,
   * crafting) retry like any other stage.
   */
  private async stageIronTools(): Promise<StageOutcome> {
    const bot = this.opts.bot;
    let home = this.opts.state.home;
    if (home === null) return { ok: false, reason: "no home coordinate configured" };

    const travel = await travelHomeAndWait(bot, home, {
      dimension: home.dimension,
      timeoutMs: TRAVEL_TIMEOUT_MS,
    });
    if (travel.status !== "arrived" && travel.status !== "already_there") {
      if (!await this.ensureReachableHome("iron_tools")) return { ok: false, reason: "home unreachable; keeping persisted home" };
      home = this.opts.state.home;
      if (home === null) return { ok: false, reason: "no home coordinate configured" };
    }
    const table = await this.ensureTableAtHome();
    if (table === null) return { ok: false, reason: "could not find a crafting table at home" };

    if (countItem(bot, "raw_iron") === 0 && countItem(bot, "iron_ingot") === 0) {
      return { ok: true, message: "No iron to upgrade with; stone tools stay." };
    }

    let ingots = countItem(bot, "iron_ingot");
    const raw = countItem(bot, "raw_iron");
    if (raw > 0) {
      const smelted = await this.smeltIronOre(raw);
      if (!smelted.ok) return { ok: false, reason: smelted.reason };
      ingots = smelted.ingots;
    }

    const planned: string[] = [];
    let budget = ingots;
    for (const [name, cost] of IRON_TOOL_UPGRADES) {
      if (budget < cost || hasItem(bot, name)) continue;
      planned.push(name);
      budget -= cost;
    }
    if (planned.length === 0) {
      return { ok: true, message: `Smelted ${ingots} iron ingots; no tool needs upgrading.` };
    }

    // Two sticks per tool (the sword takes one; over-buying is fine, as in
    // the stone-tools stage).
      const sticks = await craftSticks(bot, countSticks(bot) + planned.length * 2, this.signal ?? undefined);
    if (!sticks.ok) return { ok: false, reason: sticks.reason };

    const made: string[] = [];
    for (const name of planned) {
      const crafted = await this.craftAtTable(name, table);
      if (!crafted.ok) return { ok: false, reason: crafted.reason };
      made.push(name.replace(/^iron_/, ""));
    }
    return { ok: true, message: `Smelted ${ingots} iron ingots; iron ${made.join(" and ")} ready.` };
  }

  /** Ensure a placed furnace exists within `FURNACE_SCAN_RADIUS` of home. */
  private async ensureFurnaceAtHome(): Promise<Block | null> {
    const bot = this.opts.bot;
    const home = this.opts.state.home;
    if (home === null) return null;

    const travel = await travelHomeAndWait(bot, home, {
      dimension: home.dimension,
      timeoutMs: TRAVEL_TIMEOUT_MS,
    });
    if (travel.status !== "arrived" && travel.status !== "already_there") return null;

    const existing = furnaceBlockNear(bot, FURNACE_SCAN_RADIUS);
    if (existing !== null) return existing;

    const table = await this.ensureTableAtHome();
    if (table === null) return null;

    // Bootstrap stages are persisted across deaths/restarts, but inventory is
    // not.  A bot can resume at FURNACE with the table intact and no pickaxe;
    // repair the wooden kit before gathering the eight cobblestone needed for
    // the furnace.
    const wooden = await this.ensureWoodenKit(table);
    if (!wooden.ok) {
      this.opts.logger.warn({ reason: wooden.reason }, "furnace: could not restore wooden kit");
      return null;
    }
    let item = findItem(bot, "furnace");
    if (item === null) {
      const stone = await this.gatherCobblestone(FURNACE_COBBLE_TARGET);
      if (!stone.ok) return null;
      const furnace = await this.craftAtTable("furnace", table);
      if (!furnace.ok) return null;
      item = findItem(bot, "furnace");
    }
    if (item === null) return null;
    let spot = stationSlotSpot(bot, home, "furnace") ?? findPlacementSpot(bot, home);
    if (spot === null) {
      const fallbackCenter = bot.entity?.position;
      spot = fallbackCenter !== undefined ? findPlacementSpot(bot, fallbackCenter, 2) : null;
      if (spot !== null) this.opts.logger.warn({ home, pos: fallbackCenter }, "no floor space near home for a furnace; placing near the bot");
    }
    if (spot === null) return null;
    const placed = await placeItemAt(bot, item, spot, this.signal ?? undefined);
    return placed !== null && isFurnaceBlock(placed) ? placed : null;
  }

  /** Persist the chest's position as home storage (category "general"). */
  private registerChest(position: Vec3): void {
    const worldId = this.worldId;
    const home = this.opts.state.home;
    if (worldId === null || home === null) return;
    this.opts.storage.register(worldId, {
      dimension: home.dimension,
      category: "general",
      label: "home_main_chest",
      x: position.x,
      y: position.y,
      z: position.z,
    });
  }

  /**
   * Gather logs until at least `targetTotal` are carried. Same search-and-
   * collect mechanics as the WOOD stage but count-limited for smelting fuel
   * (each charcoal consumes one log as input and one burned as fuel).
   */
  private async gatherLogs(targetTotal: number): Promise<{ ok: true; have: number } | { ok: false; reason: string }> {
    const bot = this.opts.bot;
    const config = this.opts.config.bootstrap;
    const baseRadius = config?.search_radius ?? SEARCH_RADIUS;
    const region = this.opts.state.protectedRegion;
    const home = this.opts.state.home;

    let have = countLogs(bot);
    for (let radius = baseRadius; radius <= MAX_SEARCH_RADIUS && have < targetTotal; radius = Math.min(radius * 2, MAX_SEARCH_RADIUS + 1)) {
      const positions = findBlocksNearRefined(bot, isRawLog, (position) => isReachableTrunkBase(bot, position), radius, 24);
      this.opts.logger.info({
        radius,
        found: positions.length,
        positions: positions.map((position) => ({
          x: position.x,
          y: position.y,
          z: position.z,
          distance: Number(bot.entity?.position.distanceTo(position).toFixed(1)),
          name: bot.blockAt(position)?.name,
        })),
      }, "logs: scan");
      if (positions.length === 0) continue;
      const outside = region ? positions.filter((v) => !regionContains(region, { x: v.x, y: v.y, z: v.z })) : positions;
      const inside = region ? positions.filter((v) => regionContains(region, { x: v.x, y: v.y, z: v.z })) : [];
      const ordered = [...outside, ...inside]
        .map((v) => bot.blockAt(v))
        .filter((block) => block !== null);
      if (ordered.length === 0) continue;

      await this.withAuthorizedDigCells(ordered.map((block) => block.position), () => collectBlocks(
        bot,
        ordered,
        () => countLogs(bot),
        targetTotal,
        () => {},
        COLLECT_TIMEOUT_MS,
        (block, err) => this.opts.logger.warn({ at: block.position, err: String(err) }, "skipping unreachable block"),
        undefined,
        this.failedTargets,
      ));
      have = countLogs(bot);
    }

    // A radius scan only sees loaded chunks. When a wiped/restarted bot has
    // no local trees, walk a short rotating outward patrol, then return home
    // before the caller places or uses a station. This is the same render-
    // distance escape used by the bootstrap hunt, but bounded so log repair
    // cannot strand the bot indefinitely.
    if (have < targetTotal && home !== null) {
      let travelled = false;
      for (let leg = 1; leg <= HUNT_OUTWARD_LEGS && have < targetTotal; leg++) {
        const [dx, dz] = HUNT_OUTWARD_DIRS[(leg - 1) % HUNT_OUTWARD_DIRS.length]!;
        const waypoint = {
          x: Math.round(home.x + dx * HUNT_OUTWARD_STEP * leg),
          y: Math.floor(bot.entity?.position.y ?? home.y),
          z: Math.round(home.z + dz * HUNT_OUTWARD_STEP * leg),
        };
        const travel = await travelAndWait(bot, waypoint, {
          dimension: home.dimension,
          timeoutMs: HUNT_OUTWARD_LEG_TIMEOUT_MS,
        });
        if (travel.status !== "arrived" && travel.status !== "already_there") {
          this.opts.logger.warn({ leg, waypoint, travel }, "logs: outward repair leg unreachable");
          continue;
        }
        travelled = true;
        const positions = findBlocksNearRefined(bot, isRawLog, (position) => isReachableTrunkBase(bot, position), baseRadius, 24);
        const ordered = positions
          .map((v) => bot.blockAt(v))
          .filter((block) => block !== null);
        if (ordered.length > 0) {
          await this.withAuthorizedDigCells(ordered.map((block) => block.position), () => collectBlocks(
            bot,
            ordered,
            () => countLogs(bot),
            targetTotal,
            () => {},
            COLLECT_TIMEOUT_MS,
            (block, err) => this.opts.logger.warn({ at: block.position, err: String(err) }, "skipping unreachable block"),
            undefined,
            this.failedTargets,
          ));
          have = countLogs(bot);
        }
      }
      if (travelled) {
        const returned = await travelHomeAndWait(bot, home, {
          dimension: home.dimension,
          timeoutMs: TRAVEL_TIMEOUT_MS,
        });
        if (returned.status !== "arrived" && returned.status !== "already_there") {
          this.opts.logger.warn({ returned }, "logs: could not return home after outward repair");
        }
      }
    }

    have = countLogs(bot);
    if (have < targetTotal) return { ok: false, reason: `only ${have}/${targetTotal} logs found nearby` };
    return { ok: true, have };
  }

  /**
   * Make sure at least `needed` logs are carried, gathering fresh wood from
   * the world when short (Phase 8 resilience: the crafting stages used to
   * depend on carried leftovers and retried forever once they ran out).
   */
  private async ensureLogs(needed: number): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (countLogs(this.opts.bot) >= needed) return { ok: true };
    const gathered = await this.gatherLogs(needed);
    return gathered.ok ? { ok: true } : { ok: false, reason: gathered.reason };
  }

  /**
   * Craft a bed from the wool actually carried. Every colored-bed recipe
   * demands matching wool ("brown_bed" wants brown_wool, "red_bed" wants
   * red_wool, ...), so the bed color is chosen by carried wool, most
   * plentiful first.
   */
  private async craftBedAtTable(table: Block): Promise<CraftResult> {
    const bot = this.opts.bot;
    const colors = [...new Set(
      bot.inventory
        .items()
        .map((item) => bareName(item.name))
        .filter((name) => name.endsWith("_wool")),
    )].sort((a, b) => countItem(bot, b) - countItem(bot, a));
    for (const wool of colors) {
      const made = await craftItem(bot, `${wool.replace(/_wool$/, "")}_bed`, { craftingTable: table, signal: this.signal ?? undefined });
      if (made.ok) return made;
    }
    return failure("bed", "no bed recipe matches the carried wool");
  }

  /**
   * Mine exposed coal ore until the fuel target is carried (best-effort: a
   * miss just reports it, and the stage falls back to charcoal). Coal ore is
   * world-facing only, exactly like surface stone, so the bot never tunnels.
   */
  private async mineCoalOre(needed: number): Promise<{ ok: true; have: number } | { ok: false; reason: string }> {
    const bot = this.opts.bot;
    const config = this.opts.config.bootstrap;
    const baseRadius = config?.search_radius ?? SEARCH_RADIUS;

    let have = countFuelItems(bot);
    for (let radius = baseRadius; radius <= MAX_SEARCH_RADIUS && have < needed; radius = Math.min(radius * 2, MAX_SEARCH_RADIUS + 1)) {
      const positions = findBlocksNear(bot, isCoalOre, radius, STONE_CANDIDATES);
      const exposed = positions.filter((position) => hasStandableMiningFace(bot, position));
      const targets = exposed.map((position) => bot.blockAt(position)).filter((block) => block !== null);
      if (targets.length === 0) {
        this.announce(`No exposed coal within ${radius} blocks. Expanding search.`);
        continue;
      }

      const before = countFuelItems(bot);
      await this.withAuthorizedDigCells(targets.map((block) => block.position), () => collectBlocks(
        bot,
        targets,
        () => countFuelItems(bot),
        needed,
        (msg) => this.announce(msg),
        COLLECT_TIMEOUT_MS,
        (block, err) => this.opts.logger.warn({ at: block.position, err: String(err) }, "skipping unreachable block"),
        undefined,
        this.failedTargets,
      ));
      have = countFuelItems(bot);
      if (have <= before) {
        this.announce(`No coal reachable within ${radius} blocks. Expanding search.`);
      }
    }

    have = countFuelItems(bot);
    if (have < needed) return { ok: false, reason: `only ${have}/${needed} coal found nearby` };
    return { ok: true, have };
  }

  /**
   * Gather exposed iron ore until the raw-iron target is carried. Mirrors
   * `mineCoalOre`: world-facing ore only, the search expands to
   * MAX_SEARCH_RADIUS, and a hard collection error aborts the search. The
   * stage treats a shortfall as "no iron available", never as a failure.
   */
  private async mineIronOre(needed: number): Promise<{ ok: true; have: number } | { ok: false; reason: string }> {
    const bot = this.opts.bot;
    const config = this.opts.config.bootstrap;
    const baseRadius = config?.search_radius ?? SEARCH_RADIUS;

    let have = countItem(bot, "raw_iron");
    for (let radius = baseRadius; radius <= MAX_SEARCH_RADIUS && have < needed; radius = Math.min(radius * 2, MAX_SEARCH_RADIUS + 1)) {
      const positions = findBlocksNear(bot, isIronOre, radius, STONE_CANDIDATES);
      const exposed = positions.filter((position) => hasStandableMiningFace(bot, position));
      const targets = exposed.map((position) => bot.blockAt(position)).filter((block) => block !== null);
      if (targets.length === 0) {
        this.announce(`No exposed iron within ${radius} blocks. Expanding search.`);
        continue;
      }

      const before = countItem(bot, "raw_iron");
      await this.withAuthorizedDigCells(targets.map((block) => block.position), () => collectBlocks(
        bot,
        targets,
        () => countItem(bot, "raw_iron"),
        needed,
        (msg) => this.announce(msg),
        COLLECT_TIMEOUT_MS,
        (block, err) => this.opts.logger.warn({ at: block.position, err: String(err) }, "skipping unreachable block"),
        undefined,
        this.failedTargets,
      ));
      have = countItem(bot, "raw_iron");
      if (have <= before) {
        this.announce(`No iron reachable within ${radius} blocks. Expanding search.`);
      }
    }

    have = countItem(bot, "raw_iron");
    if (have < needed) return { ok: false, reason: `only ${have}/${needed} raw iron found nearby` };
    return { ok: true, have };
  }

  /**
   * Smelt logs into charcoal in the home furnace until `need` charcoal is
   * carried. Reuses one held log type for both the input and the fuel slot
   * (a log burns long enough to convert one log), so each charcoal costs two
   * logs total.
   */
  private async produceCharcoal(needed: number): Promise<{ ok: true; have: number } | { ok: false; reason: string }> {
    const bot = this.opts.bot;
    const logs = await this.gatherLogs(countLogs(bot) + needed * 2);
    if (!logs.ok) return { ok: false, reason: logs.reason };

    const furnace = await this.ensureFurnaceAtHome();
    if (furnace === null) return { ok: false, reason: "could not find a furnace at home for charcoal" };

    const logType = Object.keys(logsByType(bot))[0];
    if (logType === undefined) return { ok: false, reason: "no logs to smelt into charcoal" };

    const smelt = await smeltItems(bot, furnace, {
      inputName: logType,
      fuelName: logType,
      outputName: "charcoal",
      times: needed,
      timeoutMs: SMELT_TIMEOUT_MS,
      signal: this.signal ?? undefined,
    });
    if (!smelt.ok) return { ok: false, reason: smelt.reason };
    return { ok: true, have: countFuelItems(bot) };
  }

  /**
   * Smelt `count` raw iron into ingots in the home furnace. Fuel is whichever
   * of coal/charcoal is held in bulk; when neither alone covers the whole
   * batch, charcoal is produced first (reusing the FUEL machinery). One fuel
   * unit burns per pass, the same convention as the charcoal path.
   */
  private async smeltIronOre(count: number): Promise<{ ok: true; ingots: number } | { ok: false; reason: string }> {
    const bot = this.opts.bot;
    const furnace = await this.ensureFurnaceAtHome();
    if (furnace === null) return { ok: false, reason: "could not find a furnace at home for iron" };

    let charcoal = countItem(bot, "charcoal");
    if (charcoal < count && countItem(bot, "coal") < count) {
      const topup = await this.produceCharcoal(count - charcoal);
      if (!topup.ok) return { ok: false, reason: topup.reason };
      charcoal = countItem(bot, "charcoal");
    }
    const fuelName = charcoal >= count ? "charcoal" : "coal";

    const smelt = await smeltItems(bot, furnace, {
      inputName: "raw_iron",
      fuelName,
      outputName: "iron_ingot",
      times: count,
      timeoutMs: SMELT_TIMEOUT_MS,
      signal: this.signal ?? undefined,
    });
    if (!smelt.ok) return { ok: false, reason: smelt.reason };
    return { ok: true, ingots: countItem(bot, "iron_ingot") };
  }

  /**
   * Walk to `mob`, fight it to death with the best melee weapon (stone sword,
   * else wooden, else bare hands), then sweep up the drops. `bot.pvp.attack`
   * pursues the mob as it flees and resolves when the entity despawns (dies).
   */
  private async killMob(mob: Entity): Promise<{ ok: true; name: string } | { ok: false; reason: string }> {
    const bot = this.opts.bot;
    const self = bot.entity;
    if (self === null) return { ok: false, reason: "bot is not spawned" };
    const foodBefore = countFoodItems(bot);
    this.opts.logger.info({ target: mob.name, entityId: mob.id, position: mob.position, foodBefore }, "bootstrap hunt target selected");

    const approach = await travelAndWait(bot, mob.position, {
      timeoutMs: KILL_TIMEOUT_MS,
      range: 3,
    });
    if (approach.status !== "arrived" && approach.status !== "already_there") {
      return { ok: false, reason: `could not approach the ${mob.name ?? "animal"}` };
    }

    const weapon = findItem(bot, "stone_sword") ?? findItem(bot, "wooden_sword");
    if (weapon !== null) {
      try {
        await equipItem(bot, weapon, this.signal ?? undefined);
      } catch {
        // Passive mobs die to a fist; the sword is a speed bonus, not a requirement.
      }
    }

    try {
      await withTimeout(KILL_TIMEOUT_MS, pvpAttack(bot, mob, this.signal ?? undefined), async () => {
        await pvpStop(bot, this.signal ?? undefined);
      });
    } catch (err) {
      await pvpStop(bot, this.signal ?? undefined);
      return { ok: false, reason: `could not kill the ${mob.name ?? "animal"}: ${String(err)}` };
    } finally {
      await pvpStop(bot, this.signal ?? undefined);
    }

    // Entity updates are asynchronous relative to the pvp promise. Give the
    // server a short bounded window before the first sweep, then reconcile the
    // inventory after collection.
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    const loot = await this.collectLoot();
    if (!loot.ok) return { ok: false, reason: loot.reason };
    const foodAfter = countFoodItems(bot);
    this.opts.logger.info({ target: mob.name, entityId: mob.id, dropsSeen: loot.items, foodBefore, foodAfter, foodDelta: foodAfter - foodBefore, autoEatEnabled: false }, "bootstrap hunt loot reconciled");
    return { ok: true, name: mob.name ?? "animal" };
  }

  /** Pick up every loot drop within `LOOT_RADIUS` of the bot; returns the count swept. */
  private async collectLoot(): Promise<{ ok: true; items: number } | { ok: false; reason: string }> {
    const bot = this.opts.bot;
    let drops = lootDropsNear(bot, LOOT_RADIUS);
    if (drops.length === 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 300));
      drops = lootDropsNear(bot, LOOT_RADIUS);
    }
    if (drops.length === 0) return { ok: true, items: 0 };
    try {
      await withTimeout(COLLECT_TIMEOUT_MS, collectBlockOperation(bot, drops, { ignoreNoPath: true }, this.signal ?? undefined), () => cancelCollection(bot), this.signal ?? undefined);
    } catch (err) {
      return { ok: false, reason: `could not collect drops: ${String(err)}` };
    }
    return { ok: true, items: drops.length };
  }

  /** Re-craft missing wooden pickaxe/axe so stone mining is always possible. */
  private async ensureWoodenKit(table: Block): Promise<StageOutcome> {
    const bot = this.opts.bot;
    const needPickaxe = !hasItem(bot, "wooden_pickaxe");
    const needAxe = !hasItem(bot, "wooden_axe");
    if (!needPickaxe && !needAxe) return { ok: true, message: "wooden kit ready" };

    const missingTools = Number(needPickaxe) + Number(needAxe);
    const sticksRequired = missingTools * 2;
    const needStickCraft = countSticks(bot) < sticksRequired;
    // Mineflayer exposes wooden-tool recipes per plank variant. A total such
    // as two jungle plus one oak plank is valid in vanilla but can match none
    // of those recipes. Reserve one fresh four-plank stack for every missing
    // tool, plus one when sticks must be made, so each recipe has a compatible
    // three-item stack even when the gathered logs are mixed species.
    const freshLogs = missingTools + Number(needStickCraft);
    const logsTarget = countLogs(bot) + freshLogs;
    const logs = await this.ensureLogs(logsTarget);
    if (!logs.ok) return { ok: false, reason: logs.reason };
    const planksTarget = countPlanks(bot) + freshLogs * 4;
    const planks = await craftPlanks(bot, planksTarget, this.signal ?? undefined);
    if (!planks.ok) return { ok: false, reason: planks.reason };
    if (needStickCraft) {
      const sticks = await craftSticks(bot, sticksRequired, this.signal ?? undefined);
      if (!sticks.ok) return { ok: false, reason: sticks.reason };
    }

    if (needPickaxe) {
      const pickaxe = await this.craftAtTable("wooden_pickaxe", table);
      if (!pickaxe.ok) return { ok: false, reason: pickaxe.reason };
    }
    if (needAxe) {
      const axe = await this.craftAtTable("wooden_axe", table);
      if (!axe.ok) return { ok: false, reason: axe.reason };
    }
    return { ok: true, message: "wooden kit ready" };
  }

  /**
   * Collect cobblestone with a bounded, persistent site search. A miss in the
   * currently loaded chunks causes real movement before the next scan. Route
   * failures are local to one site and are persisted so restart cannot select
   * the same flooded/blocked hole again.
   */
  private async gatherCobblestone(needed: number): Promise<{ ok: true; have: number } | { ok: false; reason: string }> {
    const bot = this.opts.bot;
    const worldId = this.worldId;
    const home = this.opts.state.home;
    if (worldId === null || home === null) return { ok: false, reason: "stone search has no persisted world/home" };
    let have = countItem(bot, "cobblestone");
    if (have >= needed) return { ok: true, have };

    const stored = this.opts.stages.getState(worldId).progress;
    const progress = readStoneProgress(stored);
    const sites = stoneExplorationSites(home);
    const startedAt = Date.now();
    const deadline = startedAt + STONE_STAGE_TIMEOUT_MS;

    for (let index = progress.nextSite; index < sites.length && Date.now() < deadline; index++) {
      throwIfAborted(this.signal ?? undefined);
      const planned = sites[index]!;
      if (isNearAnySite(planned, progress.failedSites, STONE_FAILED_SITE_CLEARANCE)) continue;

      const currentPosition = bot.entity?.position;
      if (currentPosition === undefined || Math.hypot(currentPosition.x - planned.x, currentPosition.z - planned.z) > 3) {
        this.announce(`Exploring stone site ${index}/${sites.length - 1}.`);
        // X/Z define the exploration site. Use Bob's current standing Y as a
        // route hint so a stale persisted home altitude cannot turn a safe
        // surface patrol into an underground goal.
        const waypoint = new Vec3(planned.x, Math.floor(currentPosition?.y ?? home.y), planned.z);
        const travel = await travelAndWait(bot, waypoint, {
          dimension: home.dimension,
          timeoutMs: Math.max(1, Math.min(STONE_EXPLORE_TIMEOUT_MS, deadline - Date.now())),
          range: 3,
          allowDig: false,
          signal: this.signal ?? undefined,
        });
        if (travel.status !== "arrived" && travel.status !== "already_there") {
          // A bounded no-dig fallback often reaches useful new terrain but
          // misses the exact waypoint by a few blocks (or times out after a
          // long partial traverse). Scan that endpoint when it is still in
          // bounds and meaningfully separated from every prior scan. Only a
          // route that failed to relocate is discarded outright.
          const relocated = bot.entity?.position.floored();
          if (relocated === undefined || !isUsableStoneRelocation(relocated, home, progress.visitedSites)) {
            progress.failedSites.push({ x: planned.x, z: planned.z, reason: `travel_${travel.status}` });
            progress.nextSite = index + 1;
            this.saveStoneProgress(progress);
            continue;
          }
          this.opts.logger.warn({ index, planned, relocated, travel: travel.status }, "stone route missed waypoint; rescanning relocated endpoint");
        }
      }

      const reached = bot.entity?.position.floored();
      if (reached === undefined) return { ok: false, reason: "bot despawned during stone exploration" };
      progress.visitedSites.push({ x: reached.x, z: reached.z });

      // `useExtraInfo` applies exposure before the result cap, preventing the
      // nearest 64 buried stone blocks from hiding later exposed candidates.
      const exposed = findBlocksNearRefined(
        bot,
        isCobbleStone,
        (position) => isNearSurfaceElevation(position, reached) && hasStandableMiningFace(bot, position),
        STONE_LOCAL_RADIUS,
        STONE_CANDIDATES,
      );
      const targets = exposed
        .filter((position) => !this.failedTargets.has(blockKey(position)))
        .map((position) => bot.blockAt(position))
        .filter((block): block is Block => block !== null);
      this.opts.logger.info({ index, site: reached, loadedExposedStone: targets.length }, "stone search site scan");
      if (targets.length > 0) {
        await this.withAuthorizedDigCells(targets.map((block) => block.position), () =>
          withPathfinderDigging(bot, false, () => collectBlocks(
            bot,
            targets,
            () => countItem(bot, "cobblestone"),
            needed,
            (msg) => this.announce(msg),
            Math.max(1, Math.min(STONE_COLLECT_TIMEOUT_MS, deadline - Date.now())),
            (block, err) => this.opts.logger.warn({ at: block.position, err: String(err) }, "skipping unreachable stone"),
            undefined,
            this.failedTargets,
          )),
        );
        have = countItem(bot, "cobblestone");
        if (have >= needed) return { ok: true, have };
      }

      const farEnoughFromHome = Math.hypot(reached.x - home.x, reached.z - home.z) >= 16;
      if (index > 0 && farEnoughFromHome && progress.mineAttempts < STONE_MINE_ATTEMPTS) {
        progress.mineAttempts += 1;
        this.saveStoneProgress(progress);
        const trench = await this.digStoneTrench(needed - have, reached, Math.min(deadline, Date.now() + STONE_MINE_ROUTE_TIMEOUT_MS));
        have = countItem(bot, "cobblestone");
        if (have >= needed) return { ok: true, have };
        if (!trench.ok) {
          progress.failedSites.push({ x: reached.x, z: reached.z, reason: trench.reason });
          this.opts.logger.warn({ site: reached, attempt: progress.mineAttempts, reason: trench.reason }, "stone mine route blacklisted");
          this.announce(`Mine route unsafe (${trench.reason}); relocating.`);
          if (Date.now() < deadline) await travelAndWait(bot, reached, { timeoutMs: Math.max(1, Math.min(STONE_EXPLORE_TIMEOUT_MS, deadline - Date.now())), range: 2, allowDig: false, signal: this.signal ?? undefined });
        }
      }

      progress.nextSite = index + 1;
      this.saveStoneProgress(progress);
    }

    const reasons = progress.failedSites.map((site) => site.reason);
    return { ok: false, reason: `bounded stone search exhausted (${progress.visitedSites.length} sites, ${progress.mineAttempts} mines): ${reasons.slice(-3).join(", ") || "no reachable exposed stone"}` };
  }

  private saveStoneProgress(progress: StoneBootstrapProgress): void {
    if (this.worldId !== null) this.opts.stages.saveProgress(this.worldId, { kind: "stone_tools", ...progress });
  }

  /**
   * Dig a one-wide descending ramp through the ground until `needed`
   * cobblestone has been dug, stepping into each freshly dug cell. Each step
   * is one block down, so the pathfinder can climb back out (single-block
   * steps). Gives flat terrain guaranteed access to the stone layer.
   */
  private async digStoneTrench(needed: number, origin: Vec3, deadline: number): Promise<{ ok: true; gained: number } | { ok: false; reason: string }> {
    const bot = this.opts.bot;
    let direction = pickTrenchDirection(bot);
    if (direction === null) {
      const start = nearbyTrenchStart(bot, 8);
      if (start === null) return { ok: false, reason: "no open trench start near the bot" };
      // GoalNear at sub-block precision is brittle on slopes: the bot can be
      // safely adjacent to the chosen footing while never entering a 0.75
      // radius around its integer corner. A 1.5-block arrival still leaves
      // the controller close enough to recompute and validate the descent.
      const travel = await travelAndWait(bot, start, { timeoutMs: TRENCH_STEP_TIMEOUT_MS, range: 1.5, allowDig: false, signal: this.signal ?? undefined });
      if (travel.status !== "arrived" && travel.status !== "already_there") {
        return { ok: false, reason: `could not reach a safe trench start (${travel.status})` };
      }
      direction = pickTrenchDirection(bot);
      if (direction === null) return { ok: false, reason: "safe trench start had no diggable descent" };
    }

    const startingCobble = countItem(bot, "cobblestone");
    let gained = 0;
    for (let step = 0; step < TRENCH_MAX_STEPS && gained < needed; step++) {
      if (Date.now() >= deadline) return { ok: false, reason: "mine route timed out" };
      const self = bot.entity;
      if (self === null) return { ok: false, reason: "bot is not spawned" };
      const feet = self.position.floored();
      const target = new Vec3(feet.x + direction.x, feet.y - 1, feet.z + direction.z);
      const head = target.offset(0, 1, 0);
      const floor = target.offset(0, -1, 0);
      const corridor = [head, target];
      for (const position of [...corridor, floor]) {
        const block = bot.blockAt(position);
        const hazard = excavationHazard(block);
        if (hazard !== null) return { ok: false, reason: `trench hit ${hazard}` };
      }
      if (!isSolid(bot.blockAt(floor))) return { ok: false, reason: "trench reached unsafe drop" };
      const preexistingFluid = firstAdjacentFluid(bot, target) ?? firstAdjacentFluid(bot, head);
      if (preexistingFluid !== null) return { ok: false, reason: `trench adjacent to ${preexistingFluid}` };
      for (const position of corridor) {
        const block = bot.blockAt(position);
        if (isOpenSpace(block)) continue;
        if (!isDiggableGround(block)) return { ok: false, reason: `trench obstruction ${block?.name ?? "unloaded"}` };
        try {
          await this.withAuthorizedDigCells([position], () => withTimeout(TRENCH_STEP_TIMEOUT_MS, (async () => {
            await equipToolForBlock(bot, block!, this.signal ?? undefined);
            await digBlock(bot, block!, this.signal ?? undefined);
          })(), undefined, this.signal ?? undefined));
        } catch (err) {
          return { ok: false, reason: `could not dig the trench: ${String(err)}` };
        }
      }
      if (!isOpenSpace(bot.blockAt(target)) || !isOpenSpace(bot.blockAt(head))) {
        return { ok: false, reason: "trench corridor did not open" };
      }
      const adjacentHazard = firstAdjacentFluid(bot, target) ?? firstAdjacentFluid(bot, head);
      if (adjacentHazard !== null) return { ok: false, reason: `trench exposed ${adjacentHazard}` };

      const advance = await travelAndWait(bot, target, { timeoutMs: TRENCH_STEP_TIMEOUT_MS, range: 0.75, allowDig: false, signal: this.signal ?? undefined });
      if (advance.status !== "arrived" && advance.status !== "already_there") {
        return { ok: false, reason: "could not advance the trench" };
      }
      await sleep(500, this.signal ?? undefined);
      gained = Math.max(0, countItem(bot, "cobblestone") - startingCobble);
    }

    if (gained < needed) {
      if (Date.now() < deadline) await travelAndWait(bot, origin, { timeoutMs: Math.max(1, Math.min(STONE_EXPLORE_TIMEOUT_MS, deadline - Date.now())), range: 2, allowDig: false, signal: this.signal ?? undefined });
      return { ok: false, reason: `dug ${TRENCH_MAX_STEPS} ramp segments without ${needed} cobblestone` };
    }
    return { ok: true, gained };
  }

  // --- lifecycle: persistence, events, chat ---

  private completeStage(stage: BootstrapStage, message: string, baseline: Record<string, number>): void {
    const worldId = this.worldId;
    if (worldId === null) return;
    this.recordStageSkillSuccess(stage, message, baseline);
    this.opts.stages.save(worldId, stage);
    this.opts.bus.emit("bootstrap.stage", { stage, note: message });
    this.opts.logger.info({ stage, note: message }, "bootstrap stage complete");
    this.failedTargets.clear();
    this.failedMobIds.clear();
  }

  private failStage(stage: BootstrapStage, reason: string): void {
    this.opts.bus.emit("bootstrap.failed", { stage, reason });
    this.opts.logger.error({ stage, reason }, "bootstrap stage failed");
    // Announce a blockage when the stuck stage changes, or when it has been
    // quiet for a while — a permanently stuck stage (e.g. a server-side
    // spawn-protection block) must not spam chat on every 30s retry.
    const now = Date.now();
    const stageChanged = this.lastFailAnnounce !== null && this.lastFailAnnounce.stage !== stage;
    const quiet = this.lastFailAnnounce === null || now - this.lastFailAnnounce.at > FAIL_ANNOUNCE_THROTTLE_MS;
    if (stageChanged || quiet) {
      this.announce(`Stuck during ${stage}: ${reason}`);
      this.lastFailAnnounce = { stage, at: now };
    }
  }

  /**
   * The implemented bootstrap scope finished (Phase 5.6: through IRON_TOOLS).
   * Persisting NORMAL_OPERATION makes `currentStage` null, so the bootstrap
   * tools report complete and Phase 7 stockpile maintenance can treat the
   * transition as "bootstrap done".
   */
  private finishScope(): void {
    const worldId = this.worldId;
    if (worldId === null) return;
    this.opts.stages.save(worldId, BootstrapStage.NORMAL_OPERATION);
    this.opts.bus.emit("bootstrap.complete", {
      completedStages: BOOTSTRAP_STAGES.filter((stage) => stage !== BootstrapStage.NORMAL_OPERATION),
    });
    this.announce("Bootstrap complete: home, tools, food, storage, furnace, fuel, and torches are ready — entering normal operation; bed remains optional.");
  }

  /** Optional sheep/bed work must not block core autonomous operation. */
  private deferOptionalStage(stage: BootstrapStage, reason: string, baseline: Record<string, number>): void {
    const worldId = this.worldId;
    if (worldId === null) return;
    const note = `Deferred optional ${stage}: ${reason}`;
    this.recordStageSkillSuccess(stage, note, baseline);
    this.opts.stages.save(worldId, stage);
    this.opts.bus.emit("bootstrap.stage", { stage, note });
    this.opts.logger.warn({ stage, reason }, "optional bootstrap stage deferred; continuing");
    if (stage === BootstrapStage.WOOL) this.announce("No sheep found; continuing without a bed for now.");
  }

  /**
   * Persist one SkillSuccess per completed stage (spec 20.2: bootstrap stages
   * are recorded skills) so later runs retrieve the per-stage few-shot
   * history. The inventory delta is measured from the stage's own baseline.
   */
  private recordStageSkillSuccess(stage: BootstrapStage, note: string, baseline: Record<string, number>): void {
    const bot = this.opts.bot;
    const home = this.opts.state.home;
    const self = bot.entity;
    const summary = itemsSummary(bot);
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
      skillName: `bootstrap.${stage}`,
      parameters: { stage, note },
      startingConditions: {
        inventorySummary: baseline,
        homeDistance: distance,
        timeOfDay: bot.time && bot.time.isDay ? "day" : "night",
      },
      outcome: {
        durationMs: Math.max(0, Date.now() - (this.startedAt ?? Date.now())),
        interruptions: 0,
        finalInventoryDelta: delta,
      },
      description: `Bootstrap stage ${stage} complete: ${note}`,
    });
  }

  private announce(message: string): void {
    this.opts.logger.info({ message }, "bootstrap status");
    if (this.opts.bot.entity === null) return;
    if (!gameChatBudgetAllows()) return;
    try {
      this.opts.bot.chat(message);
    } catch (err) {
      this.opts.logger.warn({ err: String(err) }, "bootstrap chat failed");
    }
  }
}

export function isNearSurfaceElevation(position: Pick<Vec3, "y">, site: Pick<Vec3, "y">): boolean {
  return Math.abs(position.y - site.y) <= STONE_SURFACE_VERTICAL_RANGE;
}

// --- stone tools helpers (Phase 5.2) ---

export interface StoneBootstrapProgress {
  nextSite: number;
  mineAttempts: number;
  visitedSites: Array<{ x: number; z: number }>;
  failedSites: Array<{ x: number; z: number; reason: string }>;
}

function readStoneProgress(value: Record<string, unknown>): StoneBootstrapProgress {
  if (value.kind !== "stone_tools") return { nextSite: 0, mineAttempts: 0, visitedSites: [], failedSites: [] };
  const visitedSites = Array.isArray(value.visitedSites)
    ? value.visitedSites.filter(isStoredSite).map((site) => ({ x: site.x, z: site.z }))
    : [];
  const failedSites = Array.isArray(value.failedSites)
    ? value.failedSites.filter(isStoredFailedSite).map((site) => ({ x: site.x, z: site.z, reason: site.reason }))
    : [];
  return {
    nextSite: Number.isInteger(value.nextSite) ? Math.max(0, Number(value.nextSite)) : 0,
    mineAttempts: Number.isInteger(value.mineAttempts) ? Math.max(0, Number(value.mineAttempts)) : 0,
    visitedSites,
    failedSites,
  };
}

function isStoredSite(value: unknown): value is { x: number; z: number } {
  return typeof value === "object" && value !== null
    && Number.isFinite((value as { x?: unknown }).x) && Number.isFinite((value as { z?: unknown }).z);
}

function isStoredFailedSite(value: unknown): value is { x: number; z: number; reason: string } {
  return isStoredSite(value) && typeof (value as { reason?: unknown }).reason === "string";
}

/** Deterministic, separated destinations bounded to 96 blocks from home. */
export function stoneExplorationSites(home: { x: number; y: number; z: number }): Vec3[] {
  const offsets: ReadonlyArray<readonly [number, number]> = [
    [0, 0], [40, 0], [0, 40], [-40, 0], [0, -40], [48, 48], [-48, -48],
  ];
  return offsets
    .slice(0, STONE_EXPLORATION_SITES + 1)
    .map(([dx, dz]) => new Vec3(Math.round(home.x + dx), Math.floor(home.y), Math.round(home.z + dz)))
    .filter((site) => Math.hypot(site.x - home.x, site.z - home.z) <= STONE_MAX_HOME_DISTANCE);
}

export function isNearAnySite(site: { x: number; z: number }, others: ReadonlyArray<{ x: number; z: number }>, clearance = STONE_SITE_SEPARATION): boolean {
  return others.some((other) => Math.hypot(site.x - other.x, site.z - other.z) < clearance);
}

export function isUsableStoneRelocation(
  site: { x: number; z: number },
  home: { x: number; z: number },
  visited: ReadonlyArray<{ x: number; z: number }>,
): boolean {
  return Math.hypot(site.x - home.x, site.z - home.z) <= STONE_MAX_HOME_DISTANCE
    && !isNearAnySite(site, visited, STONE_SITE_SEPARATION);
}

function blockKey(point: { x: number; y: number; z: number }): string {
  return `${Math.floor(point.x)},${Math.floor(point.y)},${Math.floor(point.z)}`;
}

function isOpenSpace(block: Block | null): boolean {
  if (block === null) return false;
  const name = bareName(block.name);
  if (block.boundingBox === "block") return false;
  if (name === "water" || name === "lava" || name === "cobweb" || name === "fire" || name === "soul_fire" || name === "sweet_berry_bush") return false;
  return true;
}

function excavationHazard(block: Block | null): string | null {
  if (block === null) return "unloaded terrain";
  const name = bareName(block.name);
  if (name === "water" || name === "lava") return name;
  if (name === "sand" || name === "red_sand" || name === "gravel" || name.endsWith("_concrete_powder")) return `falling ${name}`;
  if (name === "bedrock" || block.hardness === -1) return `unbreakable ${name}`;
  if (isProtectedFixture(name)) return `protected fixture ${name}`;
  return null;
}

function firstAdjacentFluid(bot: Bot, position: Vec3): string | null {
  for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const) {
    const name = bareName(bot.blockAt(position.offset(dx, dy, dz))?.name ?? "");
    if (name === "water" || name === "lava") return name;
  }
  return null;
}

/** Blocks that become cobblestone when mined (stone drops cobblestone). */
function isCobbleStone(block: Block | null): boolean {
  if (block === null) return false;
  const name = block.name.replace(/^minecraft:/, "");
  return name === "stone" || name === "cobblestone";
}

/**
 * The standing Y of the highest solid ground at a column, or null when the
 * column is not loaded/known. Home's configured Y is a nominal altitude that
 * is often buried (pathfarmer can't route into rock) or airborne (a ledge
 * the bot once stood on); the real standing surface is the ground the bot
 * can actually walk on, which is what every home-anchored stage needs.
 */
function groundLevelAt(bot: Bot, x: number, z: number): number | null {
  // In a vertical shaft or an otherwise open column, scanning from the world
  // ceiling finds the lowest bedrock/deepslate floor rather than the surface
  // the bot is actually standing on. When the bot is already on (or right
  // next to) this column, prefer its valid standing level so nearby exposed
  // blocks remain reachable: the bot's own feet are ground truth for a
  // reachable surface, and a sky-scan from far away can pick an overhang or
  // canopy many blocks above the real ground.
  const self = bot.entity;
  if (self !== null) {
    const feet = self.position.floored();
    if (Math.abs(feet.x - x) <= 1 && Math.abs(feet.z - z) <= 1 && isOpenSpace(bot.blockAt(feet)) && isSolid(bot.blockAt(feet.offset(0, -1, 0)))) {
      return feet.y;
    }
  }
  // Minecraft 1.18+ worlds extend below Y=0. Scanning only 0..255 can miss
  // the actual surface and incorrectly persist the bot's current altitude as
  // home, which sends later routes toward an invalid vertical coordinate.
  for (let y = 319; y >= -64; y--) {
    const block = bot.blockAt(new Vec3(x, y, z));
    if (block === null) return null; // column not loaded yet
    if (isDiggableGround(block)) return y + 1;
  }
  return null;
}

/** A physical, manually diggable block (never liquids, bedrock, or trees). */
function isDiggableGround(block: Block | null): boolean {
  if (block === null || block.boundingBox !== "block") return false;
  const name = block.name.replace(/^minecraft:/, "");
  if (name === "bedrock" || name === "water" || name === "lava") return false;
  if (isProtectedFixture(name)) return false;
  if (/[a-z_]+_log$/.test(name) || name === "leaves" || name.endsWith("_leaves")) return false;
  return true;
}

/** True when the bot can stand beside a block with room to swing a tool. */
function hasStandableMiningFace(bot: Bot, position: Vec3): boolean {
  const faces: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (const [dx, dz] of faces) {
    const feet = position.offset(dx, 0, dz);
    const head = feet.offset(0, 1, 0);
    const floor = feet.offset(0, -1, 0);
    if (isOpenSpace(bot.blockAt(feet)) && isOpenSpace(bot.blockAt(head)) && isSolid(bot.blockAt(floor))) return true;
  }
  return false;
}

/** Keep vertical canopies from monopolizing a capped log search. */
function isReachableTrunkBase(bot: Bot, position: Vec3): boolean {
  const below = bot.blockAt(position.offset(0, -1, 0));
  return below !== null && !isRawLog(below) && hasStandableMiningFace(bot, position);
}

/** A diagonal cardinal direction whose front corner is diggable. */
function pickTrenchDirection(bot: Bot): { x: number; y: number; z: number } | null {
  const self = bot.entity;
  if (self === null) return null;
  return trenchDirectionAt(bot, self.position.floored());
}

function trenchDirectionAt(bot: Bot, feet: Vec3): { x: number; y: number; z: number } | null {
  // The pathfinder models a 1-block drop natively for diagonal moves, so the
  // ramp descends diagonally (one block forward-sideways and one down per
  // step); straight steps into a pit rely on fall-and-replan instead.
  const directions: [number, number][] = [
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
    // Dense jungle can block every diagonal with trunks or leaf columns.
    // A cardinal one-down step is still a bounded, climbable stair once the
    // target and head cells pass the same checks below.
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  for (const [dx, dz] of directions) {
    const front = bot.blockAt(new Vec3(feet.x + dx, feet.y - 1, feet.z + dz));
    if (!isDiggableGround(front)) continue;
    // Headroom above the pit so the bot can step into it after digging.
    const above = bot.blockAt(new Vec3(feet.x + dx, feet.y, feet.z + dz));
    if (!isOpenSpace(above)) continue;
    return { x: dx, y: 0, z: dz };
  }
  return null;
}

/** Find nearby open footing from which a fixture-safe diagonal ramp can begin. */
function nearbyTrenchStart(bot: Bot, radius: number): Vec3 | null {
  const self = bot.entity;
  if (self === null) return null;
  const origin = self.position.floored();
  for (let ring = 1; ring <= radius; ring++) {
    for (let dx = -ring; dx <= ring; dx++) {
      for (let dz = -ring; dz <= ring; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
        // Uneven terrain is common around jungle spawn. Searching only at the
        // bot's current Y rejects every otherwise-safe foothold on a one-block
        // slope, so resolve each candidate column to its actual standing Y.
        const x = origin.x + dx;
        const z = origin.z + dz;
        const standingY = groundLevelAt(bot, x, z);
        if (standingY === null || Math.abs(standingY - origin.y) > 4) continue;
        const feet = new Vec3(x, standingY, z);
        if (!isOpenSpace(bot.blockAt(feet)) || !isOpenSpace(bot.blockAt(feet.offset(0, 1, 0)))) continue;
        if (!isDiggableGround(bot.blockAt(feet.offset(0, -1, 0)))) continue;
        if (trenchDirectionAt(bot, feet) !== null) return feet;
      }
    }
  }
  return null;
}

// --- food hunting helpers (Phase 5.3) ---

/** Total carried food items (raw or cooked meat) — the FOOD stage's metric. */
function countFoodItems(bot: Bot): number {
  let total = 0;
  for (const item of bot.inventory.items()) {
    if (FOOD_ITEM_NAMES[bareName(item.name)] === true) total += item.count;
  }
  return total;
}

/** Nearest huntable passive mob within `maxDistance` of the bot, or null. */
function nearestHuntableMob(bot: Bot, maxDistance: number): Entity | null {
  const self = bot.entity;
  if (self === null) return null;
  let best: Entity | null = null;
  let bestDistance = Infinity;
  for (const entity of Object.values(bot.entities)) {
    const name = canonicalMobName(entity);
    if (!isLiveMob(entity) || HUNT_MOB_NAMES[name] !== true) continue;
    const distance = self.position.distanceTo(entity.position);
    if (distance <= maxDistance && distance < bestDistance) {
      best = entity;
      bestDistance = distance;
    }
  }
  return best;
}

/** True when a dropped-item entity carries loot worth sweeping up. */
function isLootDropItem(drop: Entity): boolean {
  const item = drop.getDroppedItem();
  if (item === null) return false;
  const name = bareName(item.name);
  // Sheep drop colored wool ("white_wool", "brown_wool", ...).
  return LOOT_ITEM_NAMES[name] === true || name.endsWith("_wool");
}

// --- sheep / bed helpers (Phase 5.4) ---

/** True when a block is a bed (any color): "red_bed", "white_bed", ... */
function isBedBlock(block: Block | null): boolean {
  return block !== null && /^[a-z_]*bed$/.test(bareName(block.name));
}

/** The carried bed item ("bed" or any colored variant), or null. */
function findBedItem(bot: Bot): Item | null {
  for (const item of bot.inventory.items()) {
    const name = bareName(item.name);
    if (name === "bed" || /_bed$/.test(name)) return item;
  }
  return null;
}

/** Largest carried stack of one wool color, which is the bed-stage metric. */
export function maxWoolColorCount(bot: Bot): number {
  const counts = new Map<string, number>();
  for (const item of bot.inventory.items()) {
    const name = bareName(item.name);
    if (!name.endsWith("_wool")) continue;
    counts.set(name, (counts.get(name) ?? 0) + item.count);
  }
  return Math.max(0, ...counts.values());
}

/** Nearest sheep within `maxDistance` of the bot, or null. */
function nearestSheep(bot: Bot, maxDistance: number, failedIds?: Set<number>): Entity | null {
  const self = bot.entity;
  if (self === null) return null;
  let best: Entity | null = null;
  let bestDistance = Infinity;
  for (const entity of Object.values(bot.entities)) {
    if (!isLiveMob(entity) || canonicalMobName(entity) !== "sheep" || failedIds?.has(entity.id)) continue;
    const distance = self.position.distanceTo(entity.position);
    if (distance <= maxDistance && distance < bestDistance) {
      best = entity;
      bestDistance = distance;
    }
  }
  return best;
}

/** Nearest placed bed within `radius` of the bot, or null. */
function bedBlockNear(bot: Bot, radius: number): Block | null {
  const positions = findBlocksNear(bot, isBedBlock, radius, 1);
  const first = positions[0];
  return first !== undefined ? bot.blockAt(first) : null;
}

// --- storage / fuel helpers (Phase 5.5) ---

/** True when a block is a chest (any variant). */
function isChestBlock(block: Block): boolean {
  return block.name === "chest" || block.name === "trapped_chest";
}

/** True when a block is a furnace. */
function isFurnaceBlock(block: Block): boolean {
  return block.name === "furnace" || block.name === "lit_furnace";
}

/** Blocks that drop coal when mined with a pickaxe. */
function isCoalOre(block: Block): boolean {
  return block.name === "coal_ore" || block.name === "deepslate_coal_ore";
}

/** Blocks that drop raw iron when mined with a pickaxe. */
function isIronOre(block: Block): boolean {
  return block.name === "iron_ore" || block.name === "deepslate_iron_ore";
}

/** Total carried fuel items (coal or charcoal) — the FUEL stage's metric. */
function countFuelItems(bot: Bot): number {
  return countItem(bot, "coal") + countItem(bot, "charcoal");
}

/** Nearest placed chest within `radius` of the bot, or null. */
function chestBlockNear(bot: Bot, radius: number): Block | null {
  const positions = findBlocksNear(bot, isChestBlock, radius, 1);
  const first = positions[0];
  return first !== undefined ? bot.blockAt(first) : null;
}

/** Nearest placed furnace within `radius` of the bot, or null. */
function furnaceBlockNear(bot: Bot, radius: number): Block | null {
  const positions = findBlocksNear(bot, isFurnaceBlock, radius, 1);
  const first = positions[0];
  return first !== undefined ? bot.blockAt(first) : null;
}

/**
 * Dropped-item entities within `radius` of the bot that carry loot, nearest
 * first. Only item entities (type "object") are considered; `getDroppedItem`
 * returns null for anything that is not a ground item.
 */
function lootDropsNear(bot: Bot, radius: number): Entity[] {
  const self = bot.entity;
  if (self === null) return [];
  const drops: Entity[] = [];
  for (const entity of Object.values(bot.entities)) {
    if (entity.type !== "object" || !isLootDropItem(entity)) continue;
    if (self.position.distanceTo(entity.position) > radius) continue;
    drops.push(entity);
  }
  drops.sort((a, b) => self.position.distanceTo(a.position) - self.position.distanceTo(b.position));
  return drops;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const cleanup = (): void => signal?.removeEventListener("abort", abort);
  const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
  const abort = (): void => {
    clearTimeout(timer);
    cleanup();
    reject(new Error("bootstrap sleep aborted"));
  };
  if (signal !== undefined) signal.addEventListener("abort", abort, { once: true });
  return promise;
}

/**
 * Await `promise` but give up after `timeoutMs`. The original promise is kept
 * observed so no late rejection goes unhandled; `onTimeout` runs to cancel it
 * when possible (e.g. stopping pathfinding).
 */
async function withTimeout<T>(timeoutMs: number, promise: Promise<T>, onTimeout?: () => void | Promise<void>, signal?: AbortSignal): Promise<T> {
  const awaited = promise.then(
    (value) => ({ ok: true, value } as const),
    (error) => ({ ok: false, error: String(error) } as const),
  );
  const { promise: timer, resolve: resolveTimer } = Promise.withResolvers<{ timedOut: true }>();
  const timeoutHandle = setTimeout(() => resolveTimer({ timedOut: true }), timeoutMs);
  const abort = (): void => resolveTimer({ timedOut: true });
  signal?.addEventListener("abort", abort, { once: true });

  const winner = await Promise.race([awaited, timer]);
  if (winner && typeof winner === "object" && "timedOut" in winner) {
    clearTimeout(timeoutHandle);
    signal?.removeEventListener("abort", abort);
    if (onTimeout) await onTimeout();
    await awaited;
    throw signal?.aborted ? new DOMException("operation aborted", "AbortError") : new Error(`operation timed out after ${timeoutMs}ms`);
  }
  clearTimeout(timeoutHandle);
  signal?.removeEventListener("abort", abort);
  if (winner.ok) return winner.value;
  throw new Error(winner.error);
}
