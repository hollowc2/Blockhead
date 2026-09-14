import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import type { Logger } from "pino";
import type { AgentState } from "../agent/state.js";
import type { TaskSignals } from "../agent/scheduler.js";
import type { MinecraftConfig } from "../config/schema.js";
import type { EventBus } from "../events/bus.js";
import type { StorageRepository } from "../memory/storage.js";
import type { SkillsRepository } from "../memory/skills.js";
import { deliverCarriedItems } from "../minecraft/containers.js";
import { bareName, findItem, itemsSummary } from "../minecraft/inventory.js";
import { travelAndWait } from "../minecraft/movement.js";
import { ChatThrottle, gameChatBudgetAllows, HUNT_MIN_HEALTH, recoverLowHealth, withTimeout, type SkillResult } from "./skill-library.js";

/**
 * Phase 7: `gather_food` skill (spec 29 — background food stockpile; spec 11
 * hunt rules). Deterministically hunts passive animals (cow, pig, sheep,
 * chicken) until `quantity` food items are carried, walks home, and deposits
 * every food item into the home chest. The hunt mirrors the bootstrap FOOD
 * stage: auto-eat is enabled, searches radiate from a base radius, nights
 * cap the search near home (spec 9.2), and the hunt breaks off when health
 * runs low. The LLM never steers the mechanics; the background stockpile
 * manager invokes this runner directly.
 */

// --- deterministic policy constants ---

/** Wall-clock budget for one home trip. */
const TRAVEL_TIMEOUT_MS = 120_000;
/** Passive mobs the hunt targets (spec 11: cow, pig, sheep, chicken). */
export const HUNT_MOB_NAMES: Record<string, true> = {
  cow: true,
  pig: true,
  sheep: true,
  chicken: true,
};

/** Inventory items counted as food; cooked variants cover smelting output. */
export const FOOD_ITEM_NAMES: Record<string, true> = {
  beef: true,
  porkchop: true,
  mutton: true,
  chicken: true,
  cooked_beef: true,
  cooked_porkchop: true,
  cooked_mutton: true,
  cooked_chicken: true,
};

/** Drops swept up after a kill: meat plus leather, wool, feathers, and eggs. */
export const LOOT_ITEM_NAMES: Record<string, true> = {
  ...FOOD_ITEM_NAMES,
  leather: true,
  feather: true,
  egg: true,
};

/** Radius around the kill site that dropped items are swept for. */
const LOOT_RADIUS = 24;
/** Wall-clock budget for one kill: approach, fight, and drop sweep. */
const KILL_TIMEOUT_MS = 90_000;
/** Wall-clock budget for one drop-collection pass. */
const COLLECT_TIMEOUT_MS = 240_000;
/** Search radii reach the same bound the bootstrap hunt uses. */
const MAX_SEARCH_RADIUS = 256;

export interface GatherFoodOptions {
  bot: Bot;
  state: AgentState;
  config: MinecraftConfig;
  bus: EventBus;
  /** Home storage registration (spec 22): the chest hunts land in. */
  storage: StorageRepository;
  /** Skill success records (spec 20.2). */
  skills: SkillsRepository;
  logger: Logger;
}

export interface GatherFoodData {
  /** Food items the run was asked to deliver. */
  quantity: number;
  /** Carried food when the run started. */
  carriedAtStart: number;
  /** Net food gained this run: carried at return minus carriedAtStart. */
  gathered: number;
  /** Amount deposited into the home chest. */
  delivered: number;
  kills: number;
  /** Times this task was cooperatively interrupted (Phase 8, persisted across resumes). */
  interruptions: number;
}

/** Progress persisted as the task's resume state (Phase 8). */
export interface GatherFoodResumeState {
  quantity: number;
  interruptions: number;
}

export interface GatherFoodRunOptions {
  /** Cooperative signals from the owning scheduler task; null for unbound runs. */
  signals?: TaskSignals;
  /** Resume state from a paused run of the same task. */
  resumeState?: GatherFoodResumeState;
  /**
   * Below-floor food crises (stockpile under the survival minimum) may expand
   * the night search past the near-home cap. The bot is starving either way;
   * the wider sweep is the only chance to find an animal before death, so
   * the ordinary night safety rule (spec 9.2) yields to survival.
   */
  expandAtNight?: boolean;
}

/** Total carried food items (raw or cooked meat). */
export function countFoodItems(bot: Bot): number {
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
    const name = entity.name ?? "";
    if (entity.type !== "mob" || HUNT_MOB_NAMES[name] !== true) continue;
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

/** Dropped-item entities within `radius` of the bot that carry loot. */
function lootDropsNear(bot: Bot, radius: number): Entity[] {
  const self = bot.entity;
  if (self === null) return [];
  const drops: Entity[] = [];
  for (const entity of Object.values(bot.entities)) {
    if (entity.type !== "object") continue;
    if (self.position.distanceTo(entity.position) <= radius && isLootDropItem(entity)) {
      drops.push(entity);
    }
  }
  drops.sort(
    (a, b) => self.position.distanceTo(a.position) - self.position.distanceTo(b.position),
  );
  return drops;
}

/**
 * Deterministic `gather_food` skill. One run at a time; the stockpile manager
 * serializes maintenance, so a second run returns ALREADY_RUNNING.
 */
export class GatherFoodRunner {
  private running = false;

  /** Cooperative signals for the current run; null when unbound. */
  private signals: TaskSignals | null = null;
  /** True once a pause/cancel was observed; the hunt stops at the next boundary. */
  private stopRequested = false;
  /** Accumulated interrupts across pause/resume cycles of this task. */
  private interruptions = 0;
  private currentQuantity = 0;

  /** Identical game-chat lines repeat at most once per window (spam-kick guard). */
  private readonly chatThrottle: ChatThrottle;

  /** Set per run: true when a below-floor crisis may search past the night cap. */
  private expandAtNight = false;

  constructor(private readonly opts: GatherFoodOptions) {
    const throttleSeconds = opts.config.background?.announce_throttle_seconds ?? 30;
    this.chatThrottle = new ChatThrottle(throttleSeconds * 1000);
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Hunt, return home, and deliver `quantity` food items to the home chest. */
  async run(quantity: number, options: GatherFoodRunOptions = {}): Promise<SkillResult<GatherFoodData>> {
    if (this.running) {
      return {
        ok: false,
        status: "blocked",
        errorCode: "ALREADY_RUNNING",
        message: "already hunting for food",
      };
    }
    this.running = true;
    this.signals = options.signals ?? null;
    this.expandAtNight = options.expandAtNight === true;
    this.interruptions = options.resumeState?.interruptions ?? 0;
    this.currentQuantity = quantity;
    this.stopRequested = false;
    try {
      return await this.execute(quantity);
    } finally {
      this.running = false;
      this.signals = null;
      this.expandAtNight = false;
    }
  }

  private async execute(quantity: number): Promise<SkillResult<GatherFoodData>> {
    const bot = this.opts.bot;
    const startedAt = Date.now();
    const baseline = itemsSummary(bot);
    const data: GatherFoodData = {
      quantity,
      carriedAtStart: countFoodItems(bot),
      gathered: 0,
      delivered: 0,
      kills: 0,
      interruptions: this.interruptions,
    };

    if (bot.entity === null) {
      return this.fail(data, "NOT_READY", "bot is not spawned");
    }
    // Eat as soon as anything edible exists (plugin call is idempotent).
    bot.autoEat.enableAuto();

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

    const config = this.opts.config.bootstrap;
    const baseRadius = config?.search_radius ?? 48;
    const atNight = !bot.time.isDay;
    // Nights normally cap the search near home (spec 9.2). A below-floor
    // food crisis lifts that cap: the bot is starving, so the wider sweep is
    // the difference between recovery and another death.
    const maxRadius = atNight && !this.expandAtNight ? baseRadius : MAX_SEARCH_RADIUS;

    let have = countFoodItems(bot);
    for (let radius = baseRadius; radius <= maxRadius && have < quantity; radius = Math.min(radius * 2, maxRadius + 1)) {
      this.checkInterrupt();
      if (this.stopRequested) return this.interrupted(data);
      const mob = nearestHuntableMob(bot, radius);
      if (mob === null) {
        // Only when this radius offers nothing to hunt does low health block:
        // a passive animal cannot fight back, so killing it at low health is
        // strictly better than standing still — auto-eat turns the meat into
        // regen. Without a mob there is nothing to recover from, and a
        // re-run cannot succeed until the state changes. REGEN_TIMEOUT is
        // transient and stays retryable (paced by the restore cooldown).
        if (bot.health <= HUNT_MIN_HEALTH) {
          const recovered = await recoverLowHealth(bot);
          if (!recovered.ok) {
            return this.fail(data, recovered.code, recovered.reason, {
              retryable: recovered.code !== "LOW_HEALTH",
            });
          }
        }
        this.announce(
          atNight && !this.expandAtNight
            ? "No animals close to home; night hunting stays nearby."
            : `No animals within ${radius} blocks. Expanding search.`,
        );
        continue;
      }

      const before = countFoodItems(bot);
      const kill = await this.killMob(mob);
      if (this.stopRequested) return this.interrupted(data);
      if (!kill.ok) return this.fail(data, "DANGER_TOO_HIGH", kill.reason);
      data.kills += 1;
      have = countFoodItems(bot);
      if (have <= before) {
        this.announce(`Hunted ${kill.name}; no food dropped.`);
      }
    }

    have = countFoodItems(bot);
    data.gathered = Math.max(0, have - data.carriedAtStart);
    if (this.stopRequested) return this.interrupted(data);
    if (have < quantity) {
      if (have > 0) {
        // Partial kills still deliver what was gathered (spec 23).
        const partial = await deliverCarriedItems(bot, this.opts.state, this.opts.storage, Object.keys(FOOD_ITEM_NAMES), this.opts.logger);
        data.delivered = partial.delivered;
      }
      return this.fail(data, "RESOURCE_NOT_FOUND", `only ${have}/${quantity} food found nearby`);
    }

    const delivered = await deliverCarriedItems(bot, this.opts.state, this.opts.storage, Object.keys(FOOD_ITEM_NAMES), this.opts.logger);
    data.delivered = delivered.delivered;
    const complete = delivered.delivered > 0;
    if (complete) {
      this.announce(`Done. ${delivered.delivered} food in the chest.`);
      this.recordSuccess(quantity, startedAt, baseline, data);
    }
    return {
      ok: complete,
      status: complete ? "completed" : "partial",
      data,
      errorCode: complete ? undefined : "STORAGE_NOT_FOUND",
      message: complete ? undefined : "hunted the food but could not deposit it",
      retryable: !complete,
    };
  }

  // --- Phase 8 cooperative interrupt plumbing ---

  /** Poll the task signals once and remember the result. */
  private checkInterrupt(): void {
    if (this.stopRequested || this.signals === null) return;
    const payload: GatherFoodResumeState = {
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
  private interrupted(data: GatherFoodData): SkillResult<GatherFoodData> {
    data.interruptions = this.interruptions;
    this.opts.logger.info({ kills: data.kills }, "gather_food interrupted");
    return { ok: false, status: "interrupted", retryable: true, data, message: "interrupted" };
  }

  /**
   * Walk to a mob, fight it to death with the best melee weapon (stone
   * sword, else wooden, else bare hands), then sweep up the drops.
   */
  private async killMob(mob: Entity): Promise<{ ok: true; name: string } | { ok: false; reason: string }> {
    const bot = this.opts.bot;
    const self = bot.entity;
    if (self === null) return { ok: false, reason: "bot is not spawned" };

    const approach = await travelAndWait(bot, mob.position, {
      timeoutMs: KILL_TIMEOUT_MS,
      range: 3,
      shouldAbort: this.travelAbort,
    });
    if (this.stopRequested) return { ok: false, reason: "interrupted" };
    if (approach.status !== "arrived" && approach.status !== "already_there") {
      return { ok: false, reason: `could not approach the ${mob.name ?? "animal"}` };
    }

    const weapon = findItem(bot, "stone_sword") ?? findItem(bot, "wooden_sword");
    if (weapon !== null) {
      try {
        await bot.equip(weapon, "hand");
      } catch {
        // Passive mobs die to a fist; the sword is a speed bonus, not a requirement.
      }
    }

    try {
      await withTimeout(KILL_TIMEOUT_MS, bot.pvp.attack(mob), () => {
        void bot.pvp.stop();
      });
    } catch (err) {
      void bot.pvp.stop();
      return { ok: false, reason: `could not kill the ${mob.name ?? "animal"}: ${String(err)}` };
    } finally {
      void bot.pvp.stop();
    }

    const loot = await this.collectLoot();
    if (!loot.ok) return { ok: false, reason: loot.reason };
    return { ok: true, name: mob.name ?? "animal" };
  }

  /** Pick up every loot drop within `LOOT_RADIUS` of the bot. */
  private async collectLoot(): Promise<{ ok: true; items: number } | { ok: false; reason: string }> {
    const bot = this.opts.bot;
    const drops = lootDropsNear(bot, LOOT_RADIUS);
    if (drops.length === 0) return { ok: true, items: 0 };
    try {
      await withTimeout(COLLECT_TIMEOUT_MS, bot.collectBlock.collect(drops, { ignoreNoPath: true }), () => {
        void bot.collectBlock.cancelTask();
      });
    } catch (err) {
      return { ok: false, reason: `could not collect drops: ${String(err)}` };
    }
    return { ok: true, items: drops.length };
  }

  /** Persist one SkillSuccess for a fully delivered hunt (spec 20.2). */
  private recordSuccess(
    quantity: number,
    startedAt: number,
    baseline: Record<string, number>,
    data: GatherFoodData,
  ): void {
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
      skillName: "gather_food",
      parameters: { quantity },
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
      description: `Hunted ${data.kills} animals and delivered ${data.delivered} food items to the home chest.`,
    });
  }

  private fail(
    data: GatherFoodData,
    errorCode: string,
    reason: string,
    options: { retryable?: boolean } = {},
  ): SkillResult<GatherFoodData> {
    this.announce(`Stuck: ${reason}.`);
    return {
      ok: false,
      status: "failed",
      errorCode,
      message: reason,
      retryable: options.retryable ?? true,
      data,
    };
  }

  private announce(message: string): void {
    this.opts.logger.info({ message }, "gather_food status");
    if (this.opts.bot.entity === null) return;
    if (!this.chatThrottle.allow(message)) return;
    if (!gameChatBudgetAllows()) return;
    try {
      this.opts.bot.chat(message);
    } catch (err) {
      this.opts.logger.warn({ err: String(err) }, "gather_food chat failed");
    }
  }
}