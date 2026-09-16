import type { Bot } from "mineflayer";
import type { Block } from "prismarine-block";
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
import { findBlocksNear } from "../minecraft/world.js";
import { cancelCollection, collectBlockOperation, equipItem, pvpAttack, pvpStop } from "../minecraft/primitives.js";
import { ANIMAL_MOB_NAMES, attackTargetAllowed, combatOutcomeObserved, HOSTILE_MOB_NAMES, isHumanTarget } from "../policy/combat.js";
import { belowHealthRetreat, HEALTH_RETREAT_THRESHOLD } from "../policy/safety.js";
import { ChatThrottle, gameChatBudgetAllows, HUNT_MIN_HEALTH, recoverLowHealth, withTimeout, type SkillResult } from "./skill-library.js";

/**
 * Phase 7: `gather_food` skill (spec 29 — background food stockpile; spec 11
 * hunt rules). Deterministically hunts passive animals (cow, pig, sheep,
 * chicken) and forages plant food (mature crops, berry bushes, mushrooms,
 * melons, and food dropped on the ground) until `quantity` food items are
 * carried, walks home, and deposits every food item into the home chest.
 * The hunt mirrors the bootstrap FOOD stage: auto-eat is enabled, searches
 * radiate from a base radius, nights cap the search near home (spec 9.2),
 * and the hunt breaks off when health runs low. Foraging is safe at any
 * health — crops cannot fight back — so an empty animal radius falls back
 * to it before the hunt health gate blocks the run. The LLM never steers
 * the mechanics; the background stockpile manager invokes this runner
 * directly.
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
  // Meat (raw + cooked).
  beef: true,
  porkchop: true,
  mutton: true,
  chicken: true,
  cooked_beef: true,
  cooked_porkchop: true,
  cooked_mutton: true,
  cooked_chicken: true,
  // Farmed crops and forage (built from wheat, gathered or harvested).
  wheat: true,
  bread: true,
  carrot: true,
  potato: true,
  baked_potato: true,
  beetroot: true,
  sweet_berries: true,
  melon_slice: true,
  apple: true,
  brown_mushroom: true,
  red_mushroom: true,
  mushroom_stew: true,
};

/**
 * Farmed/forage blocks `gather_food` harvests. Crops with an `age`
 * property are only harvested when mature (their final age); melon and the
 * mushrooms are always ripe.
 */
export const FORAGE_BLOCK_NAMES: Record<string, true> = {
  wheat: true,
  carrots: true,
  potatoes: true,
  beetroots: true,
  sweet_berry_bush: true,
  melon: true,
  brown_mushroom: true,
  red_mushroom: true,
};

/** The maturity `age` block property of each farmed crop (final growth stage). */
const FORAGE_MATURE_AGE: Record<string, number> = {
  wheat: 7,
  carrots: 7,
  potatoes: 7,
  beetroots: 3,
  sweet_berry_bush: 3,
};

/** Candidate forage blocks returned per search radius. */
const FORAGE_CANDIDATES = 12;

/** Drops swept up after a kill: meat plus leather, wool, feathers, and eggs,
 *  plus common hostile drops (bones, arrows, gunpowder, string, ...). */
export const LOOT_ITEM_NAMES: Record<string, true> = {
  ...FOOD_ITEM_NAMES,
  leather: true,
  feather: true,
  egg: true,
  rotten_flesh: true,
  bone: true,
  arrow: true,
  gunpowder: true,
  string: true,
  spider_eye: true,
  ender_pearl: true,
};

/** Radius around the kill site that dropped items are swept for. */
const LOOT_RADIUS = 24;
/** Wall-clock budget for one kill: approach, fight, and drop sweep. */
const KILL_TIMEOUT_MS = 90_000;
/** Wall-clock budget for one drop-collection pass. */
const COLLECT_TIMEOUT_MS = 240_000;
/** Furthest radius the hunt expands to when the config omits `bootstrap.hunt_max_radius`. */
const DEFAULT_HUNT_MAX_RADIUS = 1024;
/** Wall-clock budget for one outward patrol trip between hunt radii. */
const PATROL_TRIP_TIMEOUT_MS = 60_000;
/**
 * Sweep headings per retry: 8 compass directions radiate the full circle as
 * repeated hunts rotate, so the bot searches new ground instead of
 * re-scanning the same wedge every restore attempt.
 */
const SWEEP_HEADINGS = 8;

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
  /**
   * Hunt target filter: a specific mob name ("cow", "zombie"), the literal
   * "hostile" (any hostile mob), or undefined (any passive animal). The
   * combat policy refuses human targets at every layer (schema, validator,
   * and the kill-time guard).
   */
  targetMob?: string;
}

/** Total carried food items (raw or cooked meat). */
export function countFoodItems(bot: Bot): number {
  let total = 0;
  for (const item of bot.inventory.items()) {
    if (FOOD_ITEM_NAMES[bareName(item.name)] === true) total += item.count;
  }
  return total;
}

/** Nearest matching mob within `maxDistance` of the bot, or null. */
function nearestMatchingMob(bot: Bot, maxDistance: number, matches: (name: string) => boolean): Entity | null {
  const self = bot.entity;
  if (self === null) return null;
  let best: Entity | null = null;
  let bestDistance = Infinity;
  for (const entity of Object.values(bot.entities)) {
    const name = entity.name ?? "";
    if (entity.type !== "mob" || !matches(name)) continue;
    const distance = self.position.distanceTo(entity.position);
    if (distance <= maxDistance && distance < bestDistance) {
      best = entity;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * The hunt-target predicate for `targetMob`: a specific mob name, the
 * literal "hostile" (any hostile mob), or the default passive animals
 * (spec 11: cow, pig, sheep, chicken).
 */
export function huntTargetPredicate(targetMob: string | null | undefined): (name: string) => boolean {
  if (targetMob === "hostile") return (name) => HOSTILE_MOB_NAMES.has(name);
  if (targetMob !== null && targetMob !== undefined && targetMob !== "") return (name) => name === targetMob;
  return (name) => HUNT_MOB_NAMES[name] === true;
}

/**
 * True when a block is harvestable food: a mature crop (final `age` stage),
 * a ripe sweet-berry bush, or an always-ripe melon/mushroom. Immature crops
 * stay in the ground — pulling them wastes the plant and yields no food.
 */
export function isForageFoodBlock(block: Block): boolean {
  const name = bareName(block.name);
  if (name === "melon" || name === "brown_mushroom" || name === "red_mushroom") return true;
  const matureAt = FORAGE_MATURE_AGE[name];
  if (matureAt === undefined) return false;
  const age = Number(block.getProperties()?.age);
  return Number.isFinite(age) && age >= matureAt;
}

/**
 * Compass heading in degrees for sweep step `step`. Wraps modulo
 * `SWEEP_HEADINGS` (and handles negatives) so any counter fans out around
 * home: 0 = along +z, 45 = +x/+z, ... 315 = -x/+z.
 */
export function patrolHeadingDeg(step: number): number {
  return ((step % SWEEP_HEADINGS) + SWEEP_HEADINGS) % SWEEP_HEADINGS * 45;
}

/**
 * Ring-edge waypoint `distance` blocks from home along `headingDeg`, rounded
 * to whole blocks (the pathfinder's GoalNear tolerance absorbs sub-block
 * offsets). Horizontal only: travel keeps the bot's standing altitude.
 */
export function patrolWaypoint(
  homeX: number,
  homeZ: number,
  distance: number,
  headingDeg: number,
): { x: number; z: number } {
  const rad = (headingDeg * Math.PI) / 180;
  return {
    x: Math.round(homeX + distance * Math.sin(rad)),
    z: Math.round(homeZ + distance * Math.cos(rad)),
  };
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

/** Dropped food items within `radius` of the bot (forage: apples, berries, bread, meat, ...). */
function foodDropsNear(bot: Bot, radius: number): Entity[] {
  const self = bot.entity;
  if (self === null) return [];
  const drops: Entity[] = [];
  for (const entity of Object.values(bot.entities)) {
    if (entity.type !== "object") continue;
    const item = entity.getDroppedItem();
    if (item === null) continue;
    if (FOOD_ITEM_NAMES[bareName(item.name)] !== true) continue;
    if (self.position.distanceTo(entity.position) <= radius) {
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
  /** Set per run: hunt target filter (specific mob, "hostile", or null for passives). */
  private targetMob: string | null = null;

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
    this.targetMob = options.targetMob ?? null;
    this.interruptions = options.resumeState?.interruptions ?? 0;
    this.currentQuantity = quantity;
    this.stopRequested = false;
    try {
      return await this.execute(quantity);
    } finally {
      this.running = false;
      this.signals = null;
      this.expandAtNight = false;
      this.targetMob = null;
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
      signal: this.signals?.signal,
    });
    if (this.stopRequested) return this.interrupted(data);
    if (travel.status !== "arrived" && travel.status !== "already_there") {
      return this.fail(data, "PATH_UNREACHABLE", `could not return home: ${travel.status}`);
    }

    const config = this.opts.config.bootstrap;
    const baseRadius = config?.search_radius ?? 48;
    const huntMaxRadius = config?.hunt_max_radius ?? DEFAULT_HUNT_MAX_RADIUS;
    const atNight = !bot.time.isDay;
    // Nights normally cap the search near home (spec 9.2). A below-floor
    // food crisis lifts that cap: the bot is starving, so the wider sweep is
    // the difference between recovery and another death.
    const maxRadius = atNight && !this.expandAtNight ? baseRadius : huntMaxRadius;

    // The hunt meter: passive/hostile-any hunts count carried food (kills
    // deliver raw meat); a specific hostile target counts kills (its drops —
    // bones, rotten flesh, ... — stay in the inventory as the "food").
    const countsFood = this.targetMob === null || ANIMAL_MOB_NAMES.has(this.targetMob);
    const meter = (): number => countsFood ? countFoodItems(bot) : data.kills;

    let have = meter();
    for (let radius = baseRadius; radius <= maxRadius && have < quantity; radius = Math.min(radius * 2, maxRadius + 1)) {
      this.checkInterrupt();
      if (this.stopRequested) return this.interrupted(data);
      const matches = huntTargetPredicate(this.targetMob);
      const mob = nearestMatchingMob(bot, radius, matches);
      if (mob === null) {
        // Farmed crops and food drops cannot fight back, so foraging is safe
        // even at the health that blocks hunting — and it is the only
        // survival path an animal-less radius leaves. Try it before the hunt
        // health gate can fail the run.
        const foraged = await this.forageNear(radius);
        if (this.stopRequested) return this.interrupted(data);
        if (foraged.food > 0) {
          have = meter();
          this.announce(`Foraged ${foraged.food} food.`);
          // Starving: take the food home now instead of roaming farther.
          // Healthy: keep expanding the search toward the target.
          if (bot.health <= HUNT_MIN_HEALTH) break;
          continue;
        }
        // Only when this radius offers nothing to hunt *or* forage does low
        // health block: a passive animal cannot fight back, so killing it at
        // low health is strictly better than standing still — auto-eat turns
        // the meat into regen. Without a mob there is nothing to recover
        // from, and a re-run cannot succeed until the state changes.
        // REGEN_TIMEOUT is transient and stays retryable (paced by the
        // restore cooldown).
        if (bot.health <= HUNT_MIN_HEALTH) {
          const recovered = await recoverLowHealth(bot);
          if (!recovered.ok) {
            return this.fail(data, recovered.code, recovered.reason, {
              retryable: recovered.code !== "LOW_HEALTH",
            });
          }
        }
        // The radius scan only sees entities the client tracks around the
        // bot's current spot, so an empty radius reads like the world has no
        // animals when they may simply live out of sight. Before declaring
        // this radius empty, walk to its ring edge on this attempt's sweep
        // heading: the doubled next radius then scans new ground, and the
        // sweeping heading rotates across retries so repeated hunts fan out
        // around home in all directions. Travel failure just continues from
        // wherever the trip ended — the next scan is no worse off. The final
        // radius never patrols (nothing left to widen) and nights without a
        // crisis cap the sweep near home via `maxRadius`, per spec 9.2.
        if (radius < maxRadius) {
          const self = bot.entity;
          if (self !== null) {
            const waypoint = patrolWaypoint(home.x, home.z, radius, patrolHeadingDeg(this.sweepStep()));
            const walked = await travelAndWait(
              bot,
              { x: waypoint.x, y: Math.floor(self.position.y), z: waypoint.z },
              { timeoutMs: this.patrolTimeoutMs(radius), shouldAbort: this.travelAbort, signal: this.signals?.signal },
            );
            if (this.stopRequested) return this.interrupted(data);
            this.opts.logger.info(
              { to: [waypoint.x, waypoint.z], status: walked.status },
              "gather_food patrolled",
            );
          }
        }
        this.announce(
          atNight && !this.expandAtNight
            ? "No animals or forage close to home; night hunting stays nearby."
            : `No animals or forage within ${radius} blocks. Expanding search.`,
        );
        continue;
      }

      const before = countFoodItems(bot);
      // Spec 34 health policy: a hostile target fights back, so engaging one
      // at/below the retreat threshold is dangerous work that must retreat.
      // Passive animals stay legal at low health — they cannot fight back and
      // auto-eat turns the meat into regen.
      if (HOSTILE_MOB_NAMES.has(mob.name ?? "") && belowHealthRetreat(bot.health, HEALTH_RETREAT_THRESHOLD)) {
        return this.fail(data, "DANGER_TOO_HIGH", `health ${bot.health} is at/below the retreat threshold ${HEALTH_RETREAT_THRESHOLD}; not engaging a hostile ${mob.name ?? "mob"}`);
      }
      const kill = await this.killMob(mob);
      if (this.stopRequested) return this.interrupted(data);
      if (!kill.ok) return this.fail(data, "DANGER_TOO_HIGH", kill.reason);
      data.kills += 1;
      have = meter();
      if (countsFood && have <= before) {
        this.announce(`Hunted ${kill.name}; no food dropped.`);
      }
    }

    have = meter();
    data.gathered = Math.max(0, have - data.carriedAtStart);
    if (this.stopRequested) return this.interrupted(data);
    if (have < quantity) {
      if (have > 0 && countsFood) {
        // Partial kills still deliver what was gathered (spec 23).
        const partial = await deliverCarriedItems(bot, this.opts.state, this.opts.storage, Object.keys(FOOD_ITEM_NAMES), this.opts.logger, this.signals?.signal);
        data.delivered = partial.delivered;
      }
      return this.fail(data, "RESOURCE_NOT_FOUND", `only ${have}/${quantity} ${countsFood ? "food" : "kills"} nearby`);
    }

    let complete: boolean;
    if (countsFood) {
      const delivered = await deliverCarriedItems(bot, this.opts.state, this.opts.storage, Object.keys(FOOD_ITEM_NAMES), this.opts.logger, this.signals?.signal);
      data.delivered = delivered.delivered;
      complete = delivered.delivered > 0;
      if (complete) {
        this.announce(`Done. ${delivered.delivered} food in the chest.`);
        this.recordSuccess(quantity, startedAt, baseline, data);
      }
    } else {
      complete = true;
      this.announce(`Done. ${data.kills} ${this.targetMob ?? "targets"} cleared.`);
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

  /**
   * Sweep step for this hunt attempt. Rotates with the wall clock (roughly
   * one step per restore-retry window), so consecutive failed hunts fan out
   * around home in different rings instead of repeating the same heading.
   */
  private sweepStep(): number {
    return Math.floor(Date.now() / 60_000);
  }

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

    // Spec 25 / 34: never attack a human player. The schema and validators
    // already reject human targets; this is the kill-time belt-and-braces guard.
    if (!attackTargetAllowed(mob.type, this.opts.config).allowed || isHumanTarget(mob.type)) {
      return { ok: false, reason: "combat policy forbids attacking human players" };
    }

    const approach = await travelAndWait(bot, mob.position, {
      timeoutMs: KILL_TIMEOUT_MS,
      range: 3,
      shouldAbort: this.travelAbort,
      signal: this.signals?.signal,
    });
    if (this.stopRequested) return { ok: false, reason: "interrupted" };
    if (approach.status !== "arrived" && approach.status !== "already_there") {
      return { ok: false, reason: `could not approach the ${mob.name ?? "animal"}` };
    }

    const weapon = findItem(bot, "stone_sword") ?? findItem(bot, "wooden_sword");
    if (weapon !== null) {
      try {
        await equipItem(bot, weapon, this.signals?.signal);
      } catch {
        // Passive mobs die to a fist; the sword is a speed bonus, not a requirement.
      }
    }

    try {
      await withTimeout(KILL_TIMEOUT_MS, pvpAttack(bot, mob, this.signals?.signal), async () => {
        await pvpStop(bot, this.signals?.signal);
      }, this.signals?.signal);
    } catch (err) {
      await pvpStop(bot, this.signals?.signal);
      return { ok: false, reason: `could not kill the ${mob.name ?? "animal"}: ${String(err)}` };
    } finally {
      await pvpStop(bot, this.signals?.signal);
    }
    if (!combatOutcomeObserved(bot, mob)) {
      return { ok: false, reason: `attack settled without an observed defeat of the ${mob.name ?? "animal"}` };
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
      await withTimeout(COLLECT_TIMEOUT_MS, collectBlockOperation(bot, drops, { ignoreNoPath: true }, this.signals?.signal), async () => {
        await cancelCollection(bot);
      }, this.signals?.signal);
    } catch (err) {
      return { ok: false, reason: `could not collect drops: ${String(err)}` };
    }
    return { ok: true, items: drops.length };
  }

  /**
   * Forage `radius` blocks around the bot: harvest mature crops/berry
   * bushes/mushrooms/melons and pick up dropped food items (apples,
   * berries, bread, meat from other kills). Runs on a best-effort basis —
   * a failed collection pass is logged, not fatal — and counts the net food
   * gained (auto-eat may consume some of it on the spot).
   */
  private async forageNear(radius: number): Promise<{ blocks: number; drops: number; food: number }> {
    const bot = this.opts.bot;
    const before = countFoodItems(bot);

    const positions = findBlocksNear(bot, isForageFoodBlock, radius, FORAGE_CANDIDATES);
    const targets = positions
      .map((v) => bot.blockAt(v))
      .filter((b): b is Block => b !== null);
    let blocks = 0;
    if (targets.length > 0) {
      this.opts.logger.info({ blocks: targets.map((b) => b.name), radius }, "gather_food foraging");
      try {
        await withTimeout(COLLECT_TIMEOUT_MS, collectBlockOperation(bot, targets, { ignoreNoPath: true }, this.signals?.signal), async () => {
          await cancelCollection(bot);
        }, this.signals?.signal);
        blocks = targets.length;
      } catch (err) {
        this.opts.logger.warn({ err: String(err) }, "gather_food forage collect failed");
      }
    }

    const drops = foodDropsNear(bot, radius);
    if (drops.length > 0) {
      try {
        await withTimeout(COLLECT_TIMEOUT_MS, collectBlockOperation(bot, drops, { ignoreNoPath: true }, this.signals?.signal), async () => {
        await cancelCollection(bot);
        }, this.signals?.signal);
      } catch (err) {
        this.opts.logger.warn({ err: String(err) }, "gather_food drop pickup failed");
      }
    }

    return { blocks, drops: drops.length, food: Math.max(0, countFoodItems(bot) - before) };
  }

  /**
   * Patrol budget scaled to the ring distance: the 60s base covers the small
   * rings, the walk to a 1024-block ring edge (~4.3 blocks/s) needs minutes.
   * A `timed_out` trip leaves the bot wherever the pathfinder stopped; the
   * next radius scans from there, so the sweep still fans outward.
   */
  private patrolTimeoutMs(radius: number): number {
    return Math.max(PATROL_TRIP_TIMEOUT_MS, radius * 300);
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
