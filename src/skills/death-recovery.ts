import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import type { Logger } from "pino";
import type { TaskSignals } from "../agent/scheduler.js";
import type { AgentState } from "../agent/state.js";
import type { MinecraftConfig } from "../config/schema.js";
import type { EventBus } from "../events/bus.js";
import type { DeathEventsRepository } from "../memory/deaths.js";
import type { SkillsRepository } from "../memory/skills.js";
import type { StorageRepository } from "../memory/storage.js";
import { craftItem } from "../minecraft/crafting.js";
import { findHomeChest, withdrawFromHomeChest } from "../minecraft/containers.js";
import { bareName, countItem, itemsSummary } from "../minecraft/inventory.js";
import { travelAndWait, travelHomeAndWait } from "../minecraft/movement.js";
import { normalizeDimension } from "../minecraft/protection.js";
import { findBlockNear } from "../minecraft/world.js";
import { ItemPolicy, type ItemValue } from "../policy/item-policy.js";
import { Vec3 } from "vec3";
import { distanceFromHome, hasUsableFamilyTool } from "./expedition.js";
import { sleep, type SkillResult } from "./skill-library.js";

/**
 * Phase 10: deterministic death recovery (spec section 26).
 *
 * Runs as the executor of an EMERGENCY-priority `death_recovery` task, so it
 * temporarily outranks foreground and background work — drops are
 * time-sensitive. Flow: wait for the respawned body, verify the site is in
 * the current dimension, travel there, sweep the dropped items in
 * value-aware order (spec 26.1: critical -> valuable -> useful -> everything
 * else), record the outcome (recovered or an explicit failure reason), then
 * re-equip essential tools and return to useful operation.
 */

// --- deterministic policy constants ---

/** How long to wait for the respawned body before giving up. */
const SPAWN_WAIT_TIMEOUT_MS = 30_000;
/** Poll cadence while waiting for the respawned body. */
const SPAWN_POLL_MS = 500;
/** Wall-clock budget for one trip to the death site. */
const RECOVERY_TRAVEL_TIMEOUT_MS = 180_000;
/** Wall-clock budget for the whole pickup sweep (drops despawn after ~5 min). */
const RECOVERY_TOTAL_TIMEOUT_MS = 300_000;
/** Blocks around the recorded death site that drops are scanned within. */
const RECOVERY_SCAN_RADIUS = 16;
/** Wall-clock budget for one walk-to-a-drop leg. */
const PICKUP_MOVE_TIMEOUT_MS = 20_000;
/** Grace period after arriving at a drop for the server to complete the pickup. */
const PICKUP_GRACE_MS = 700;
/** Health at or below which the sweep breaks off (basic survival, spec 26). */
const RECOVERY_MIN_HEALTH = 8;
/** A hostile mob within this many blocks of the site makes recovery too dangerous. */
const DANGER_PROXIMITY = 4;
/** Wall-clock budget for the post-recovery trip home. */
const GO_HOME_TIMEOUT_MS = 120_000;
/** Scan radius when looking for an already-placed crafting table. */
const TABLE_SCAN_RADIUS = 12;

/** Hostile mobs that make a death site too dangerous to work. */
const HOSTILE_MOB_NAMES: ReadonlySet<string> = new Set([
  "zombie",
  "husk",
  "drowned",
  "skeleton",
  "stray",
  "creeper",
  "spider",
  "cave_spider",
  "enderman",
  "witch",
  "slime",
  "phantom",
  "blaze",
  "ghast",
  "magma_cube",
  "piglin",
  "piglin_brute",
  "hoglin",
  "zoglin",
  "wither_skeleton",
  "wither",
  "vindicator",
  "pillager",
  "ravager",
  "evoker",
  "guardian",
  "elder_guardian",
  "shulker",
  "silverfish",
  "endermite",
  "vex",
]);

/** Explicit failure reasons recorded on the death event (spec 26). */
type RecoveryFailure =
  | "timeout"
  | "too_dangerous"
  | "died_again"
  | "items_despawned"
  | "path_unreachable"
  | "wrong_dimension"
  | "inventory_full"
  | "not_ready";

export interface DeathRecoveryOptions {
  bot: Bot;
  state: AgentState;
  config: MinecraftConfig;
  bus: EventBus;
  storage: StorageRepository;
  deaths: DeathEventsRepository;
  skills: SkillsRepository;
  logger: Logger;
}

/** Task parameters for a `death_recovery` task (persisted, survives restarts). */
export interface DeathRecoveryParams {
  deathId: number;
  dimension: string;
  x: number;
  y: number;
  z: number;
}

export interface DeathRecoveryData {
  deathId: number;
  dropsFound: number;
  /** Item name -> count actually picked up from the death site. */
  pickedUp: Record<string, number>;
  /** Names of drops the sweep could not recover. */
  leftBehind: string[];
  failureReason: RecoveryFailure | null;
  recovered: boolean;
  durationMs: number;
  returnedHome: boolean;
  equipmentRebuilt: boolean;
}

/**
 * Deterministic death-recovery skill. One run at a time (mirrors the other
 * runners' `isRunning` guard); executes the spec 26 workflow.
 */
export class DeathRecoveryRunner {
  private readonly policy: ItemPolicy;
  private running = false;

  constructor(private readonly opts: DeathRecoveryOptions) {
    this.policy = new ItemPolicy(opts.config.items ?? {});
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Recover the drops of one recorded death. Resolves when the attempt ends. */
  async run(params: DeathRecoveryParams, signals: TaskSignals): Promise<SkillResult<DeathRecoveryData>> {
    if (this.running) {
      return {
        ok: false,
        status: "blocked",
        errorCode: "ALREADY_RUNNING",
        message: "death recovery already running",
        retryable: false,
      };
    }
    this.running = true;
    try {
      return await this.execute(params, signals);
    } finally {
      this.running = false;
    }
  }

  private async execute(params: DeathRecoveryParams, signals: TaskSignals): Promise<SkillResult<DeathRecoveryData>> {
    const bot = this.opts.bot;
    const logger = this.opts.logger;
    const startedAt = Date.now();
    // Inventory at run start (just after respawn) — the skill-success
    // starting conditions and the base the recovery outcome is measured from.
    const baseline = itemsSummary(bot);
    const data: DeathRecoveryData = {
      deathId: params.deathId,
      dropsFound: 0,
      pickedUp: {},
      leftBehind: [],
      failureReason: null,
      recovered: false,
      durationMs: 0,
      returnedHome: false,
      equipmentRebuilt: false,
    };

    // 1. The respawned body must exist (covers boot-rehydrated tasks too).
    if (!(await this.waitForSpawn())) {
      if (!signals.checkpoint()) {
        return this.finish(params, data, signals, baseline, null, true, startedAt);
      }
      return this.finish(params, data, signals, baseline, "not_ready", false, startedAt);
    }
    if (!signals.checkpoint()) {
      return this.finish(params, data, signals, baseline, null, true, startedAt);
    }

    // 2. Feasibility: the site must be reachable in the current dimension.
    const currentDimension = normalizeDimension(bot.game.dimension ?? "");
    const deathDimension = normalizeDimension(params.dimension);
    if (currentDimension !== deathDimension) {
      logger.warn({ deathDimension, currentDimension }, "death site in another dimension; recovery not feasible");
      return this.finish(params, data, signals, baseline, "wrong_dimension", false, startedAt);
    }

    // 3. Travel to the site. Recovery deliberately skips the expedition
    //    supply checks: drops are time-sensitive, and a direct trip needs no
    //    tools. The emergency priority already outranks ordinary work.
    const travel = await travelAndWait(bot, { x: params.x, y: params.y, z: params.z }, {
      timeoutMs: RECOVERY_TRAVEL_TIMEOUT_MS,
      shouldAbort: () => !signals.checkpoint(),
    });
    if (travel.status === "aborted") {
      return this.finish(params, data, signals, baseline, null, true, startedAt);
    }
    if (travel.status !== "arrived" && travel.status !== "already_there") {
      const failure: RecoveryFailure =
        travel.status === "timed_out" ? "timeout" : travel.status === "wrong_dimension" ? "wrong_dimension" : "path_unreachable";
      return this.finish(params, data, signals, baseline, failure, false, startedAt);
    }

    // 4. A hostile mob camped on the drops is the textbook "too dangerous".
    if (this.hostileMobNear(bot, DANGER_PROXIMITY)) {
      logger.warn("hostile mob at the death site; aborting recovery");
      return this.finish(params, data, signals, baseline, "too_dangerous", false, startedAt);
    }

    // 5. Scan the site and order the drops by item value (spec 26.1).
    const drops = this.dropsNear(bot, params, RECOVERY_SCAN_RADIUS);
    data.dropsFound = drops.length;
    drops.sort((a, b) => this.dropOrder(a, b, bot));

    // 6. Sweep in value order with an overall deadline and survival gates.
    const resolved = new Set<number>();
    const deadline = Date.now() + RECOVERY_TOTAL_TIMEOUT_MS;
    let failure: RecoveryFailure | null = null;
    for (const drop of drops) {
      if (Date.now() > deadline) {
        failure = "timeout";
        break;
      }
      if (!signals.checkpoint()) {
        return this.finish(params, data, signals, baseline, null, true, startedAt);
      }
      if (bot.health <= 0) {
        failure = "died_again";
        break;
      }
      if (bot.health < RECOVERY_MIN_HEALTH) {
        failure = "too_dangerous";
        break;
      }
      if (bot.inventory.emptySlotCount() === 0) {
        failure = "inventory_full";
        break;
      }
      const gained = await this.tryPickup(bot, drop, signals);
      if (gained !== null) {
        resolved.add(drop.id);
        data.pickedUp[gained] = (data.pickedUp[gained] ?? 0) + 1;
      }
    }
    data.leftBehind = [
      ...new Set(
        drops
          .filter((drop) => !resolved.has(drop.id))
          .map((drop) => bareName(drop.getDroppedItem()?.name ?? "item")),
      ),
    ];

    return this.finish(params, data, signals, baseline, failure, false, startedAt);
  }

  /**
   * Settle the record, persist the outcome, re-equip, and return a skill
   * result. Called from every exit path so no started recovery is left
   * unmarked in the death_events table.
   */
  private async finish(
    params: DeathRecoveryParams,
    data: DeathRecoveryData,
    signals: TaskSignals,
    baseline: Record<string, number>,
    failure: RecoveryFailure | null,
    interrupted: boolean,
    startedAt: number,
  ): Promise<SkillResult<DeathRecoveryData>> {
    const bot = this.opts.bot;
    const logger = this.opts.logger;
    data.durationMs = Date.now() - startedAt;
    data.failureReason = failure;

    if (!interrupted) {
      // Outcome derivation: a sweep that never found drops means the items
      // were gone (despawned or taken); a sweep that found drops but gained
      // nothing means none of them were reachable.
      if (failure === null && data.dropsFound === 0) failure = "items_despawned";
      if (failure === null && data.dropsFound > 0 && Object.keys(data.pickedUp).length === 0) {
        failure = "path_unreachable";
      }
      data.failureReason = failure;
      data.recovered = failure === null;

      // Only first write wins: a newer death may have superseded this record
      // while the attempt was in flight. A skipped death (nothing worth
      // carrying) is also terminal — a stray run must not overwrite it.
      const record = this.opts.deaths.get(params.deathId);
      if (
        record !== null &&
        !record.recovered &&
        record.recoveryFailedReason === null &&
        record.recoverySkippedReason === null
      ) {
        if (data.recovered) this.opts.deaths.markRecovered(params.deathId);
        else this.opts.deaths.markFailed(params.deathId, failure ?? "interrupted");
      }
    }

    // Post-attempt: return home and rebuild essential equipment, unless the
    // task was interrupted (the pause keeps this run resumable).
    if (!interrupted) {
      data.returnedHome = await this.returnHome(signals);
      data.equipmentRebuilt = await this.ensureEssentialEquipment(signals);
    }

    const total = Object.values(data.pickedUp).reduce((sum, count) => sum + count, 0);
    const summary = data.recovered
      ? `Recovered ${total} items from the death site.`
      : `No items recovered: ${failure ?? "interrupted"}.`;
    logger.info({ ...data, deathId: params.deathId }, "death recovery finished");
    this.opts.state.addEvent(`death recovery ${data.recovered ? "succeeded" : `failed (${failure ?? "interrupted"})`}`);
    this.opts.bus.emit("death.recovery.completed", {
      deathId: params.deathId,
      recovered: data.recovered,
      failureReason: failure,
      pickedUp: data.pickedUp,
      dropsFound: data.dropsFound,
      durationMs: data.durationMs,
    });

    if (data.recovered) {
      this.opts.skills.record({
        skillName: "death_recovery",
        parameters: {
          deathId: params.deathId,
          dimension: normalizeDimension(params.dimension),
          x: params.x,
          y: params.y,
          z: params.z,
        },
        startingConditions: {
          biomeOrRegion: normalizeDimension(bot.game.dimension ?? ""),
          inventorySummary: baseline,
          homeDistance: distanceFromHome(bot, this.opts.state.home),
          timeOfDay: bot.time.isDay ? "day" : "night",
        },
        outcome: {
          durationMs: data.durationMs,
          interruptions: 0,
          finalInventoryDelta: data.pickedUp,
        },
        description: summary,
      });
    }

    const status = interrupted ? "interrupted" : data.recovered ? "completed" : "failed";
    return {
      ok: data.recovered,
      status,
      data,
      errorCode: interrupted ? undefined : this.errorCodeFor(failure),
      message: interrupted
        ? "death recovery interrupted"
        : data.recovered
          ? `Recovered ${total} items from the death site`
          : `No items recovered: ${failure ?? "unknown"}`,
      retryable:
        !interrupted && !data.recovered && (failure === "timeout" || failure === "path_unreachable"),
    };
  }

  // --- primitives ---

  /** Wait for the respawned body; false when it never appears in time. */
  private async waitForSpawn(): Promise<boolean> {
    const bot = this.opts.bot;
    const deadline = Date.now() + SPAWN_WAIT_TIMEOUT_MS;
    while (bot.entity === null || bot.health <= 0) {
      if (Date.now() > deadline) return false;
      await sleep(SPAWN_POLL_MS);
    }
    return true;
  }

  /** Dropped-item entities within `radius` of the recorded site. */
  private dropsNear(bot: Bot, site: { x: number; y: number; z: number }, radius: number): Entity[] {
    const siteVec = new Vec3(site.x, site.y, site.z);
    const drops: Entity[] = [];
    for (const entity of Object.values(bot.entities)) {
      if (entity.type !== "object" || entity.getDroppedItem() === null) continue;
      if (entity.position.distanceTo(siteVec) > radius) continue;
      drops.push(entity);
    }
    return drops;
  }

  /** Value rank first, then nearest first (deterministic tiebreak). */
  private dropOrder(a: Entity, b: Entity, bot: Bot): number {
    const rankA = this.valueRankOf(a);
    const rankB = this.valueRankOf(b);
    if (rankA !== rankB) return rankA - rankB;
    const self = bot.entity;
    if (self === null) return 0;
    return self.position.distanceTo(a.position) - self.position.distanceTo(b.position);
  }

  private valueRankOf(drop: Entity): number {
    const item = drop.getDroppedItem();
    if (item === null) return this.policy.rank("common");
    const value: ItemValue = this.policy.classify(item.name, {
      enchants: item.enchants,
      customName: item.customName,
    });
    return this.policy.rank(value);
  }

  /**
   * Walk onto a drop and wait for the server to hand it over. Returns the
   * item name on success, null when the drop vanished or was unreachable.
   */
  private async tryPickup(bot: Bot, drop: Entity, signals: TaskSignals): Promise<string | null> {
    const item = drop.getDroppedItem();
    if (item === null) return null;
    const name = bareName(item.name);
    const before = countItem(bot, name);
    for (let attempt = 0; attempt < 2; attempt++) {
      if (drop.isValid === false || bot.entities[drop.id] === undefined) break;
      const target = bot.entities[drop.id] ?? drop;
      const moved = await travelAndWait(bot, target.position, {
        timeoutMs: PICKUP_MOVE_TIMEOUT_MS,
        range: 1,
        shouldAbort: () => !signals.checkpoint(),
      });
      if (moved.status === "aborted") return null;
      if (moved.status !== "arrived" && moved.status !== "already_there") return null;
      await sleep(PICKUP_GRACE_MS);
      const after = countItem(bot, name);
      if (after > before) return name;
      // The drop may have drifted (water/lava); one more path onto its
      // current spot before giving up on it.
    }
    return null;
  }

  /** A hostile mob within `radius` of the bot (the site). */
  private hostileMobNear(bot: Bot, radius: number): boolean {
    const self = bot.entity;
    if (self === null) return false;
    for (const entity of Object.values(bot.entities)) {
      if (entity.type !== "mob" || !HOSTILE_MOB_NAMES.has(entity.name ?? "")) continue;
      if (self.position.distanceTo(entity.position) <= radius) return true;
    }
    return false;
  }

  /** Walk home when the bot is in the home dimension (best-effort). */
  private async returnHome(signals: TaskSignals): Promise<boolean> {
    const bot = this.opts.bot;
    const home = this.opts.state.home;
    if (home === null || normalizeDimension(bot.game.dimension ?? "") !== home.dimension) return false;
    const trip = await travelHomeAndWait(bot, home, {
      timeoutMs: GO_HOME_TIMEOUT_MS,
      shouldAbort: () => !signals.checkpoint(),
    });
    return trip.status === "arrived" || trip.status === "already_there";
  }

  /**
   * Rebuild essential equipment (spec 26: "rebuild essential equipment if
   * needed"): a usable axe and pickaxe must exist for ordinary work to
   * resume. Home-chest spares first, then a stone-tool craft when the
   * ingredients and a table are already at hand. Best-effort — returning to
   * operation never blocks on this.
   */
  private async ensureEssentialEquipment(signals: TaskSignals): Promise<boolean> {
    const bot = this.opts.bot;
    if (hasUsableFamilyTool(bot, "axe") && hasUsableFamilyTool(bot, "pickaxe")) return true;
    if (!hasUsableFamilyTool(bot, "axe")) await this.obtainTool("axe", signals);
    if (!hasUsableFamilyTool(bot, "pickaxe")) await this.obtainTool("pickaxe", signals);
    return hasUsableFamilyTool(bot, "axe") && hasUsableFamilyTool(bot, "pickaxe");
  }

  private async obtainTool(family: "axe" | "pickaxe", signals: TaskSignals): Promise<void> {
    const bot = this.opts.bot;
    const spares = family === "axe" ? ["iron_axe", "stone_axe", "wooden_axe"] : ["iron_pickaxe", "stone_pickaxe", "wooden_pickaxe"];
    // Probe the home chest once per family, not once per spare item: a home
    // without a chest supplies none of them, and six "no chest at home"
    // warnings per recovery drown the actual story (the item is gone).
    const chest = findHomeChest(bot, this.opts.state, this.opts.storage);
    if (chest !== null) {
      for (const name of spares) {
        const withdrawn = await withdrawFromHomeChest(bot, this.opts.state, this.opts.storage, name, 1, this.opts.logger, signals.signal);
        if (withdrawn.withdrawn > 0) return;
      }
    }
    // Craft fallback: only when the ingredients and a table already exist.
    if (countItem(bot, "cobblestone") < 3 || countItem(bot, "stick") < 2) return;
    const table = findBlockNear(bot, "crafting_table", TABLE_SCAN_RADIUS);
    if (table === null) return;
    await craftItem(bot, family === "axe" ? "stone_axe" : "stone_pickaxe", { craftingTable: table, signal: signals.signal });
  }

  private errorCodeFor(failure: RecoveryFailure | null): string | undefined {
    switch (failure) {
      case "timeout":
        return "TIMEOUT";
      case "too_dangerous":
      case "died_again":
        return "DANGER_TOO_HIGH";
      case "items_despawned":
        return "ITEMS_DESPAWNED";
      case "path_unreachable":
        return "PATH_UNREACHABLE";
      case "wrong_dimension":
        return "WRONG_DIMENSION";
      case "inventory_full":
        return "INVENTORY_FULL";
      case "not_ready":
        return "NOT_READY";
      case null:
        return undefined;
    }
  }
}
