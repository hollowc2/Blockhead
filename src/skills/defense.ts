import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import type { Logger } from "pino";
import { Vec3 } from "vec3";
import type { AgentState } from "../agent/state.js";
import type { TaskSignals } from "../agent/scheduler.js";
import type { MinecraftConfig } from "../config/schema.js";
import type { EventBus } from "../events/bus.js";
import type { SkillsRepository } from "../memory/skills.js";
import { findItem, itemsSummary } from "../minecraft/inventory.js";
import { pillarBlockCount, swimToShore, towerUp, travelAndWait } from "../minecraft/movement.js";
import { asEscapeMove } from "../agent/world-actions.js";
import { equipItem, pvpAttack, pvpStop } from "../minecraft/primitives.js";
import { attackTargetAllowed, combatOutcomeObserved, isHumanTarget, isMobEntity, HOSTILE_MOB_NAMES, PROVOKED_ONLY_MOB_NAMES } from "../policy/combat.js";
import { belowHealthRetreat, checkHealthRetreat, HEALTH_RETREAT_THRESHOLD } from "../policy/safety.js";
import { gameChatBudgetAllows, withTimeout, type SkillResult } from "./skill-library.js";

/**
 * Deterministic defense skills (spec 14.6 / section 25): `defend_self` and
 * `defend_player`. Combat mechanics are deterministic pvp-plugin code; the
 * LLM only picks the tool. The combat policy is enforced at every layer —
 * the schema rejects human targets, the runners never *select* a player
 * entity, and the kill guard refuses one outright (PVP_FORBIDDEN).
 */

/** View distance in blocks for hostile selection while defending. */
const DEFENSE_VIEW_RADIUS = 64;
/** How far to back away from a creeper (its blast reaches ~7 blocks). */
const EVADE_DISTANCE = 12;
/** Below this, even a reflex defense pass stands down. */
const REFLEX_CRITICAL_HEALTH = 4;
/** A hostile this close means fleeing is no longer an option. */
const CORNERED_RADIUS = 4;
/** Wall-clock budget for one kill (approach, fight, stop). */
const KILL_TIMEOUT_MS = 60_000;
/**
 * Budget for walking up to a target before the fight. mineflayer-pvp follows
 * the target itself, so this only closes the gap; a long approach is how a
 * skeleton up a slope kept the bot walking while a spider ate it.
 */
const APPROACH_TIMEOUT_MS = 12_000;
/** A hostile this close is landing (or about to land) melee hits. */
const MELEE_RADIUS = 3.5;
/** A fight whose target stays this far away is not reachable from here. */
const UNREACHABLE_DISTANCE = 6;
/** How long a target may stay out of reach before the fight is abandoned. */
const UNREACHABLE_MS = 8_000;
/** Close targets can also be unreachable: require approach progress or observed hits. */
const COMBAT_PROGRESS_TIMEOUT_MS = 8_000;
/** Poll interval for the in-fight retarget / retreat checks. */
const FIGHT_POLL_MS = 250;
/** How far a retreat runs from the threats. */
const RETREAT_DISTANCE = 16;
/** Wall-clock budget for one retreat run. */
const RETREAT_TIMEOUT_MS = 10_000;
/** Hostiles within this radius steer the retreat direction. */
const RETREAT_THREAT_RADIUS = 24;
/** A creeper this close is evaded before anything else is fought. */
const CREEPER_DANGER_RADIUS = 6;
/** Times one creeper is backed away from before the bot fights it. */
const CREEPER_EVADE_LIMIT = 3;
/** Window the evasions are counted in. */
const CREEPER_EVADE_WINDOW_MS = 3 * 60_000;
/**
 * A creeper this close is not outrun: its 1.5 s fuse beats the path search.
 * Death 23 (03:47, 2026-10-23): the bot planned partial paths out of a stone
 * cut for half a second and was blown up wearing iron, a shield unused.
 */
const CREEPER_BLOCK_RADIUS = 4;
/** Longest the shield is held toward one creeper (a fuse plus margin). */
const CREEPER_BLOCK_MS = 3_000;
/** Beyond this a lit creeper's fuse goes out. */
const CREEPER_BLAST_RADIUS = 7;
/** Hit-and-back rounds against a creeper that will not leave. */
const CREEPER_HIT_ROUNDS = 8;
/** Reach for one hit. */
const CREEPER_HIT_REACH = 3;
/** How far to step back after each hit: out of its 3-block fuse range. */
const CREEPER_HIT_BACKOFF = 5;
/** This many hostiles within CROWD_RADIUS make a self-defense pass run instead of fight. */
const CROWD_SIZE = 3;
const CROWD_RADIUS = 10;
/** How far a swimming bot looks for a bank before the retreat trip: a lake is wider than the movement default. */
const SHORE_SEARCH_RADIUS = 16;
/** A cap on mid-fight target switches within one pass. */
const MAX_RETARGETS = 6;
/** Wall-clock budget for the whole defense pass. */
const TOTAL_TIMEOUT_MS = 180_000;
/** Max hostiles cleared in one pass (bounds a single task). */
const MAX_KILLS_PER_PASS = 3;
/** Distance the defended player may be for the bot to still fight for them. */
const DEFEND_PLAYER_RANGE = 48;
/** Blocks up a combat perch stands: out of a zombie's reach. */
const PERCH_HEIGHT = 2;
/** Hostiles this close decide whether a perch holds. */
const PERCH_THREAT_RADIUS = 16;
/** Swing reach from the perch, eyes to the mob's body. */
const PERCH_REACH = 3.5;
/** A stone/iron sword recharges in ~0.63 s; swing at that rate. */
const PERCH_SWING_MS = 650;
const PERCH_FIGHT_MS = 120_000;
/**
 * Mobs that cannot reach a bot two blocks up: no climbing, no ranged
 * attack, no explosion. Spiders climb, skeletons and drowned shoot, a
 * creeper blows the pillar out.
 */
const PERCH_SAFE_MOBS: ReadonlySet<string> = new Set(["zombie", "husk", "zombie_villager"]);

/** A perch holds when every threat is a non-climbing melee mob and blocks are carried. */
export function perchHolds(threats: readonly string[], blocks: number): boolean {
  return threats.length > 0 && blocks >= PERCH_HEIGHT && threats.every((name) => PERCH_SAFE_MOBS.has(name));
}

/** World actions the runner drives; injectable so the fight logic is testable. */
export interface DefenseActions {
  travel: typeof travelAndWait;
  attack: typeof pvpAttack;
  stop: typeof pvpStop;
  equip: typeof equipItem;
  shore?: typeof swimToShore;
  /** One swing at `target` (a creeper is hit once, then backed away from). */
  hit?: (bot: Bot, target: Entity) => void;
  /** Tower straight up; returns the blocks climbed. */
  tower?: (bot: Bot, steps: number, signal?: AbortSignal) => Promise<number>;
  /** Hold the off-hand shield toward `threat` until it is gone or `ms` passes. */
  shieldBlock?: (bot: Bot, threat: Entity, ms: number, signal?: AbortSignal) => Promise<void>;
}

/** True when a shield is in the off hand (inventory slot 45). */
export function holdsShield(bot: Bot): boolean {
  return bot.inventory?.slots?.[45]?.name === "shield";
}

/** A raised shield facing an explosion takes the whole blast. */
async function raiseShield(bot: Bot, threat: Entity, ms: number, signal?: AbortSignal): Promise<void> {
  const until = Date.now() + ms;
  bot.clearControlStates();
  bot.activateItem(true);
  try {
    while (Date.now() < until && signal?.aborted !== true && isLiveEntity(threat) && bot.entity
      && distanceBetween(threat.position, bot.entity.position) <= CREEPER_BLAST_RADIUS) {
      await bot.lookAt(threat.position.offset(0, 1, 0), true);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } finally {
    bot.deactivateItem();
  }
}

const DEFAULT_ACTIONS: DefenseActions = { travel: travelAndWait, attack: pvpAttack, stop: pvpStop, equip: equipItem, shore: swimToShore, hit: (bot, target) => bot.attack(target), tower: towerUp, shieldBlock: raiseShield };

export interface DefenseOptions {
  bot: Bot;
  state: AgentState;
  config: MinecraftConfig;
  bus: EventBus;
  /** Skill success records (spec 20.2). */
  skills: SkillsRepository;
  logger: Logger;
  actions?: Partial<DefenseActions>;
}

export interface DefenseData {
  kind: "self" | "player";
  player: string | null;
  kills: number;
  /** Names of hostiles that were ignored/blocked by policy this run. */
  blocked: number;
  interruptions: number;
  /** Wall-clock budget exceeded. */
  timeout: boolean;
  /** The pass ran away from the threats instead of fighting on. */
  retreated: boolean;
}

interface KillResult {
  ok: boolean;
  killed?: string;
  reason?: string;
  blocked?: boolean;
  /** Another hostile closed to melee range while the target was out of reach. */
  retarget?: boolean;
  /** Health fell to the retreat floor with nothing in melee range. */
  retreat?: boolean;
}

type FightBreak = "retarget" | "retreat" | "outnumbered" | "unreachable" | "stalled";

/**
 * Deterministic defense runner: clears nearby hostile mobs, never human
 * players. One run at a time.
 */
export class DefenseRunner {
  private running = false;
  private signals: TaskSignals | null = null;
  private stopRequested = false;
  private interruptions = 0;
  private readonly actions: DefenseActions;
  /** Recent evasions per creeper entity id. */
  private readonly creeperEvasions = new Map<number, { count: number; first: number }>();

  constructor(private readonly opts: DefenseOptions) {
    this.actions = { ...DEFAULT_ACTIONS, ...opts.actions };
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Defend the bot itself: clear hostiles close enough to pose a threat. */
  async defendSelf(options: { signals?: TaskSignals; resumeState?: { interruptions?: number }; radius?: number; reflex?: boolean } = {}): Promise<SkillResult<DefenseData>> {
    return this.run("self", null, options);
  }

  /** Defend the named player: clear hostiles near them. */
  async defendPlayer(
    player: string,
    options: { signals?: TaskSignals; resumeState?: { interruptions?: number } } = {},
  ): Promise<SkillResult<DefenseData>> {
    return this.run("player", player, options);
  }

  private async run(
    kind: "self" | "player",
    player: string | null,
    options: { signals?: TaskSignals; resumeState?: { interruptions?: number }; radius?: number; reflex?: boolean },
  ): Promise<SkillResult<DefenseData>> {
    if (this.running) {
      return { ok: false, status: "blocked", errorCode: "ALREADY_RUNNING", message: "already defending" };
    }
    this.running = true;
    this.signals = options.signals ?? null;
    this.interruptions = typeof options.resumeState?.interruptions === "number" ? options.resumeState.interruptions : 0;
    this.stopRequested = false;
    try {
      return await this.execute(kind, player, options.radius ?? DEFENSE_VIEW_RADIUS, options.reflex === true);
    } finally {
      this.running = false;
      this.signals = null;
    }
  }

  private async execute(kind: "self" | "player", player: string | null, radius: number, reflex: boolean): Promise<SkillResult<DefenseData>> {
    const bot = this.opts.bot;
    const startedAt = Date.now();
    const baseline = itemsSummary(bot);
    const data: DefenseData = {
      kind,
      player,
      kills: 0,
      blocked: 0,
      interruptions: this.interruptions,
      timeout: false,
      retreated: false,
    };

    if (bot.entity === null) {
      return this.fail(data, "NOT_READY", "bot is not spawned", false);
    }

    // Spec 34: dangerous work retreats below the health floor. A reflex pass
    // with an attacker already in melee range fights anyway (running only
    // hands it free hits); otherwise a hurt bot runs instead of trading blows
    // it cannot afford with no food to heal.
    const healthGate = checkHealthRetreat(bot.health, HEALTH_RETREAT_THRESHOLD);
    const cornered = reflex && this.nearestHostile(null, CORNERED_RADIUS) !== null;
    if (!healthGate.allowed && !cornered) {
      if (!reflex) {
        return this.fail(data, "DANGER_TOO_HIGH", `health ${bot.health} is at/below the retreat threshold ${HEALTH_RETREAT_THRESHOLD}`, false);
      }
      return this.retreatResult(data, `health ${bot.health} is at/below the retreat threshold`);
    }

    // Swimming, the bot cannot fight: no footing, no crits, and drowned
    // hit from below and throw tridents. Both drowned deaths (2026-10-04
    // 16:38, 16:39) were fights started in the water, 20 -> 4 health in
    // four seconds. Get to the bank first; the reflex re-fires on land.
    if (kind === "self" && this.swimming()) {
      return this.retreatResult(data, "attacked in the water");
    }
    // Outnumbered, the bot runs: a crowd in forest shade or a cave mouth
    // (four zombies, a spider and a creeper at 20:13; six zombies, creepers
    // and a skeleton in the 19:16 pit) wore it from 20 to 3 health before
    // the per-target retreat floor kicked in.
    const crowd = kind === "self" ? this.hostilesWithin(CROWD_RADIUS) : 0;
    if (crowd >= CROWD_SIZE) {
      return this.retreatResult(data, `outnumbered by ${crowd} hostiles`);
    }

    // Defending a player requires seeing them.
    let anchor: { x: number; y: number; z: number } | null = null;
    if (kind === "player") {
      if (player === null || player === "") {
        return this.fail(data, "INVALID_RESOURCE", "no player named to defend", false);
      }
      const targetPlayer = bot.players[player]?.entity ?? null;
      if (targetPlayer === null) {
        return { ok: true, status: "completed", data, message: "cannot see that player to defend them" };
      }
      // Never attack the defended player themselves — only hostiles around them.
      anchor = { x: targetPlayer.position.x, y: targetPlayer.position.y, z: targetPlayer.position.z };
      if (this.stopRequested) return this.interrupted(data);
    }

    const deadline = startedAt + TOTAL_TIMEOUT_MS;
    let retargets = 0;
    let lastFailure: string | null = null;
    while (this.opts.bot.entity !== null && data.kills < MAX_KILLS_PER_PASS) {
      if (this.stopRequested) return this.interrupted(data);
      if (Date.now() > deadline) {
        data.timeout = true;
        break;
      }
      this.checkInterrupt();
      if (this.stopRequested) return this.interrupted(data);

      const hostile = this.selectTarget(anchor, radius);
      if (hostile === null) break;
      if (hostile.name === "creeper") {
        // Meleeing a creeper lights its fuse at arm's length. Back off
        // instead: the bot outruns it, and the reflex fires again if it
        // closes in. One that keeps following is fought hit-and-back: a
        // creeper by a field interrupted the work every 15 seconds for 15
        // minutes, 66 evasions and no kill (2026-10-06 06:00-06:15).
        const evasions = this.noteCreeperEvasion(hostile.id);
        // One that lingers in range without blowing is still fought down.
        if (evasions > CREEPER_EVADE_LIMIT) await this.hitAndBack(hostile);
        else if (this.creeperClose(hostile)) await this.blockCreeper(hostile);
        else await this.evade(hostile);
        if (this.stopRequested) return this.interrupted(data);
        break;
      }
      const kill = await this.killHostile(hostile, data, deadline, kind === "self");
      if (kill.blocked) {
        data.blocked += 1;
        // A blocked target is still a real threat; stop fighting rather than
        // loop forever on a target policy forbids.
        break;
      }
      if (!kill.ok) {
        if (this.stopRequested) return this.interrupted(data);
        lastFailure = kill.reason ?? `could not kill the ${hostile.name ?? "hostile"}`;
        if (kill.retarget === true && retargets < MAX_RETARGETS) {
          retargets += 1;
          continue;
        }
        // Defending itself, the bot does not stand in a fight it is losing
        // or cannot reach (an archer up a slope): it runs.
        if (kind === "self") {
          if (data.kills > 0) this.recordSuccess(baseline, startedAt, data);
          return this.retreatResult(data, lastFailure);
        }
        break;
      }
      lastFailure = null;
      data.kills += 1;
      // Re-anchor after movement so the next scan follows the player.
      if (kind === "player") {
        const refreshed = bot.players[player ?? ""]?.entity ?? null;
        anchor = refreshed === null ? anchor : { x: refreshed.position.x, y: refreshed.position.y, z: refreshed.position.z };
      }
    }

    if (this.stopRequested) return this.interrupted(data);
    this.announce(data);
    if (data.kills === 0 && lastFailure !== null) {
      return this.fail(data, "DANGER_TOO_HIGH", lastFailure, false);
    }
    if (data.kills === 0 && !data.timeout) {
      return { ok: true, status: "completed", data, message: "no hostiles nearby" };
    }
    if (data.kills === 0) {
      return this.fail(data, "DANGER_TOO_HIGH", "defense timed out without clearing the area", false);
    }
    this.recordSuccess(baseline, startedAt, data);
    return { ok: true, status: "completed", data, message: `cleared ${data.kills} hostiles` };
  }

  /** In water now: the physics flag, confirmed by the block at the feet (the flag outlives a respawn). */
  private swimming(): boolean {
    const bot = this.opts.bot;
    const entity = bot.entity as { isInWater?: boolean; position?: { floored(): unknown } } | null;
    if (entity?.isInWater !== true) return false;
    if (typeof bot.blockAt !== "function" || entity.position === undefined) return true;
    return /water/.test(bot.blockAt(entity.position.floored() as never)?.name ?? "");
  }

  /** Live hostiles (provoked-only mobs excluded) within `radius` of the bot. */
  private hostilesWithin(radius: number): number {
    const self = this.opts.bot.entity?.position;
    if (self === undefined || self === null) return 0;
    return Object.values(this.opts.bot.entities).filter((entity) =>
      entity.type !== "player" && isMobEntity(entity) && HOSTILE_MOB_NAMES.has(entity.name ?? "")
      && !PROVOKED_ONLY_MOB_NAMES.has(entity.name ?? "") && isLiveEntity(entity)
      && distanceBetween(entity.position, self) <= radius).length;
  }

  /** Nearest live hostile mob to `anchor` (the bot when defending itself). */
  private nearestHostile(anchor: { x: number; y: number; z: number } | null, radius = DEFENSE_VIEW_RADIUS, exclude?: number): Entity | null {
    const bot = this.opts.bot;
    if (bot.entity === null) return null;
    const origin = anchor ?? { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z };
    let best: Entity | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const entity of Object.values(bot.entities)) {
      // THE policy boundary: player entities are never candidates.
      if (entity.type === "player") continue;
      if (!isMobEntity(entity) || !HOSTILE_MOB_NAMES.has(entity.name ?? "")) continue;
      if (exclude !== undefined && entity.id === exclude) continue;
      if (!isLiveEntity(entity)) continue;
      const distance = distanceBetween(entity.position, origin);
      // Neutral until provoked: only one already in melee range of the bot
      // (attacking it) is a target; picking one off at range starts the fight.
      if (PROVOKED_ONLY_MOB_NAMES.has(entity.name ?? "") && (bot.entity === null || distanceBetween(entity.position, bot.entity.position) > MELEE_RADIUS)) continue;
      if (distance <= radius && distance < bestDistance) {
        best = entity;
        bestDistance = distance;
      }
    }
    return best;
  }

  /**
   * The hostile to fight next: whatever is already in melee range of the bot
   * (it is the one landing hits) before the nearest one around the anchor.
   */
  private selectTarget(anchor: { x: number; y: number; z: number } | null, radius: number): Entity | null {
    // A creeper close by comes first, whatever else is in reach: death 80
    // (18:54, 2026-10-05) was a fight with a zombie while a creeper beside
    // it went off, 20 health to dead in one blast.
    return this.creeperWithin(CREEPER_DANGER_RADIUS) ?? this.nearestHostile(null, MELEE_RADIUS) ?? this.nearestHostile(anchor, radius);
  }

  /** The nearest live creeper within `radius` of the bot, or null. */
  private creeperWithin(radius: number): Entity | null {
    const self = this.opts.bot.entity?.position;
    if (self === undefined || self === null) return null;
    let best: Entity | null = null;
    let bestDistance = Infinity;
    for (const entity of Object.values(this.opts.bot.entities)) {
      if (!isMobEntity(entity) || entity.name !== "creeper" || !isLiveEntity(entity)) continue;
      const distance = distanceBetween(entity.position, self);
      if (distance <= radius && distance < bestDistance) { best = entity; bestDistance = distance; }
    }
    return best;
  }

  /**
   * Why the current fight against `target` should stop, if it should: a
   * different hostile is in melee range while the target is not, health hit
   * the retreat floor with nothing in melee range, or the target stayed out of
   * reach too long. `farSince` carries the out-of-reach clock between polls.
   */
  private fightBreak(target: Entity, allowRetreat: boolean, farSince: { at: number | null } | null): FightBreak | null {
    const bot = this.opts.bot;
    const self = bot.entity?.position;
    if (self === undefined || self === null) return null;
    const targetDistance = distanceBetween(target.position, self);
    const targetInMelee = targetDistance <= MELEE_RADIUS;
    // A one-zombie fight that a crowd joins is not fought out: death 74
    // (23:55, 100 blocks north) went 16 -> 0 health against a skeleton and
    // three zombies, with the crowd check only run when the pass began.
    if (allowRetreat && this.hostilesWithin(CROWD_RADIUS) >= CROWD_SIZE) return "outnumbered";
    // A creeper closing in mid-fight: drop the fight and get clear of it.
    const creeper = this.creeperWithin(CREEPER_DANGER_RADIUS);
    if (creeper !== null && creeper.id !== target.id) return "retarget";
    if (!targetInMelee && this.nearestHostile(null, MELEE_RADIUS, target.id) !== null) return "retarget";
    // Low on health, the bot runs unless one mob alone is on it: turning
    // away from two at once only trades the fight for death in place.
    if (allowRetreat && belowHealthRetreat(bot.health) && this.hostilesWithin(MELEE_RADIUS) !== 1) return "retreat";
    if (farSince === null) return null;
    if (targetDistance > UNREACHABLE_DISTANCE) {
      const now = Date.now();
      farSince.at ??= now;
      if (now - farSince.at >= UNREACHABLE_MS) return "unreachable";
    } else {
      farSince.at = null;
    }
    return null;
  }

  private noteCreeperEvasion(id: number, now = Date.now()): number {
    for (const [key, entry] of this.creeperEvasions) if (now - entry.first > CREEPER_EVADE_WINDOW_MS) this.creeperEvasions.delete(key);
    const entry = this.creeperEvasions.get(id) ?? { count: 0, first: now };
    entry.count += 1;
    this.creeperEvasions.set(id, entry);
    return entry.count;
  }

  /** Hit a creeper once, step out of its fuse range, repeat until it is dead. */
  private async hitAndBack(creeper: Entity): Promise<void> {
    const bot = this.opts.bot;
    this.opts.logger.info({ id: creeper.id }, "defense: creeper keeps following; fighting it hit-and-back");
    const weapon = findItem(bot, "iron_sword") ?? findItem(bot, "stone_sword") ?? findItem(bot, "wooden_sword");
    if (weapon !== null) await this.actions.equip(bot, weapon, this.signals?.signal).catch(() => undefined);
    for (let round = 0; round < CREEPER_HIT_ROUNDS && isLiveEntity(creeper) && !this.stopRequested; round++) {
      const self = bot.entity?.position;
      if (self === undefined || self === null) return;
      if (distanceBetween(creeper.position, self) > CREEPER_HIT_REACH) {
        await this.actions.travel(bot, creeper.position, { range: 2, timeoutMs: 4_000, shouldAbort: this.travelAbort, signal: this.signals?.signal });
      }
      const here = bot.entity?.position;
      if (here !== undefined && here !== null && distanceBetween(creeper.position, here) <= CREEPER_HIT_REACH) this.actions.hit?.(bot, creeper);
      if (!isLiveEntity(creeper)) break;
      await this.evade(creeper, CREEPER_HIT_BACKOFF);
    }
    if (!isLiveEntity(creeper)) this.creeperEvasions.delete(creeper.id);
  }

  /** Walk straight away from `threat` far enough to be out of blast range. */
  private async evade(threat: Entity, distance = EVADE_DISTANCE): Promise<void> {
    const bot = this.opts.bot;
    const self = bot.entity?.position;
    if (self === undefined) return;
    const dx = self.x - threat.position.x;
    const dz = self.z - threat.position.z;
    const length = Math.hypot(dx, dz) || 1;
    const target = { x: self.x + (dx / length) * distance, y: self.y, z: self.z + (dz / length) * distance };
    this.opts.logger.info({ threat: threat.name, from: { x: Math.round(self.x), z: Math.round(self.z) } }, "defense: backing away from a creeper");
    await this.actions.travel(bot, target, { range: 3, timeoutMs: 8_000, shouldAbort: this.travelAbort, signal: this.signals?.signal });
    // Boxed in, the trip ends where it started with the fuse still burning.
    if (this.creeperClose(threat)) await this.blockCreeper(threat);
  }

  /** A live creeper inside the range no retreat can beat, with a shield to take it on. */
  private creeperClose(creeper: Entity): boolean {
    const self = this.opts.bot.entity?.position;
    return self !== undefined && self !== null && isLiveEntity(creeper) && this.actions.shieldBlock !== undefined
      && holdsShield(this.opts.bot) && distanceBetween(creeper.position, self) <= CREEPER_BLOCK_RADIUS;
  }

  /** Face the creeper behind the raised shield until it blows, dies or walks off. */
  private async blockCreeper(creeper: Entity): Promise<void> {
    this.opts.logger.info({ id: creeper.id, distance: Number(distanceBetween(creeper.position, this.opts.bot.entity!.position).toFixed(1)) }, "defense: creeper too close to outrun; blocking with the shield");
    await this.actions.shieldBlock!(this.opts.bot, creeper, CREEPER_BLOCK_MS, this.signals?.signal);
  }

  /**
   * Run from the hostiles around the bot, leaning toward home when home is
   * not back toward them. Best effort: one short trip, whatever its outcome.
   */
  private async retreat(reason: string): Promise<boolean> {
    const bot = this.opts.bot;
    const self = bot.entity?.position;
    if (self === undefined || self === null) return false;
    const threats = Object.values(bot.entities).filter((entity) =>
      entity.type !== "player" && isMobEntity(entity) && HOSTILE_MOB_NAMES.has(entity.name ?? "") && isLiveEntity(entity)
      && distanceBetween(entity.position, self) <= RETREAT_THREAT_RADIUS);
    const target = retreatTarget(self, threats.map((entity) => entity.position), this.opts.config.home ?? null);
    // The pathfinder plans poorly from open water; swim to the bank first.
    if (this.swimming() && this.actions.shore !== undefined) {
      await this.actions.shore(bot, target, this.signals?.signal, SHORE_SEARCH_RADIUS);
    }
    this.opts.logger.warn({
      reason,
      threats: threats.map((entity) => entity.name),
      from: { x: Math.round(self.x), y: Math.round(self.y), z: Math.round(self.z) },
      to: { x: Math.round(target.x), z: Math.round(target.z) },
      health: bot.health,
    }, "defense: retreating");
    const travel = await this.actions.travel(bot, target, { range: 3, timeoutMs: RETREAT_TIMEOUT_MS, shouldAbort: this.travelAbort, signal: this.signals?.signal });
    return travel.status === "arrived" || travel.status === "already_there";
  }

  /** Live hostile mobs within `radius`, nearest first. */
  private hostilesNear(radius: number): Entity[] {
    const self = this.opts.bot.entity?.position;
    if (self === undefined || self === null) return [];
    return Object.values(this.opts.bot.entities)
      .filter((entity) => entity.type !== "player" && isMobEntity(entity) && HOSTILE_MOB_NAMES.has(entity.name ?? "") && isLiveEntity(entity)
        && distanceBetween(entity.position, self) <= radius)
      .sort((a, b) => distanceBetween(a.position, self) - distanceBetween(b.position, self));
  }

  /**
   * Against a zombie crowd, tower two blocks up and fight from there instead
   * of running: fleeing three cave zombies took the bot from 20 to 0 health
   * in 11 seconds (2026-10-22), every hit landing on its back. Null when a
   * perch would not hold (a climber, archer or creeper near, no blocks, in
   * water) or the tower failed, so the caller runs as before.
   */
  private async perchFight(data: DefenseData, reason: string): Promise<SkillResult<DefenseData> | null> {
    const bot = this.opts.bot;
    const tower = this.actions.tower;
    if (tower === undefined || bot.entity === null || bot.entity.onGround !== true || this.swimming()) return null;
    const threats = this.hostilesNear(PERCH_THREAT_RADIUS);
    if (!perchHolds(threats.map((entity) => entity.name ?? ""), pillarBlockCount(bot))) return null;
    const climbed = await asEscapeMove(() => tower(bot, PERCH_HEIGHT, this.signals?.signal)).catch(() => 0);
    if (this.stopRequested) return this.interrupted(data);
    if (climbed < PERCH_HEIGHT) {
      this.opts.logger.warn({ climbed, reason }, "defense: could not build a perch; running instead");
      return null;
    }
    this.opts.logger.warn({ reason, threats: threats.map((entity) => entity.name), health: bot.health }, "defense: perched out of reach; fighting from above");
    const weapon = findItem(bot, "iron_sword") ?? findItem(bot, "stone_sword") ?? findItem(bot, "wooden_sword");
    if (weapon !== null) await this.actions.equip(bot, weapon, this.signals?.signal).catch(() => undefined);

    const struck = new Set<number>();
    const deadline = Date.now() + PERCH_FIGHT_MS;
    while (Date.now() < deadline) {
      this.checkInterrupt();
      if (this.stopRequested) return this.interrupted(data);
      const around = this.hostilesNear(PERCH_THREAT_RADIUS);
      if (around.length === 0 || !perchHolds(around.map((entity) => entity.name ?? ""), PERCH_HEIGHT)) break;
      const self = bot.entity?.position;
      const eyes = self === undefined || self === null ? undefined : { x: self.x, y: self.y + 1.62, z: self.z };
      const body = (entity: Entity) => new Vec3(entity.position.x, entity.position.y + (entity.height ?? 1.8) * 0.6, entity.position.z);
      const target = eyes === undefined ? undefined : around.find((entity) => distanceBetween(body(entity), eyes) <= PERCH_REACH);
      if (target !== undefined && this.actions.hit !== undefined) {
        await bot.lookAt?.(body(target), true)?.catch(() => undefined);
        this.actions.hit(bot, target);
        struck.add(target.id);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, PERCH_SWING_MS));
    }
    data.kills += [...struck].filter((id) => { const entity = bot.entities[id]; return entity === undefined || !isLiveEntity(entity); }).length;
    data.retreated = true;
    this.announce(data);
    return { ok: true, status: "completed", data, message: `perched and fought: ${data.kills} cleared` };
  }

  private async retreatResult(data: DefenseData, reason: string): Promise<SkillResult<DefenseData>> {
    if (data.kind === "self") {
      const perched = await this.perchFight(data, reason);
      if (perched !== null) return perched;
    }
    const escaped = await this.retreat(reason);
    if (this.stopRequested) return this.interrupted(data);
    if (!escaped) return this.fail(data, "PATH_UNREACHABLE", `could not retreat: ${reason}`, true);
    data.retreated = true;
    this.announce(data);
    // Running is the defense working, not failing: a failed reflex pass
    // stands the reflex down, and repeated failures make the watchdog block
    // defend_self outright.
    return { ok: true, status: "completed", data, message: `retreated: ${reason}` };
  }

  /** Approach and kill one hostile. Belt-and-braces combat guard included. */
  private async killHostile(hostile: Entity, data: DefenseData, deadline: number, allowRetreat: boolean): Promise<KillResult> {
    const bot = this.opts.bot;
    if (bot.entity === null) return { ok: false, reason: "bot is not spawned" };

    if (!attackTargetAllowed(hostile.type, this.opts.config).allowed || isHumanTarget(hostile.type)) {
      this.opts.logger.warn({ target: hostile.name ?? hostile.type }, "defense refused a human target");
      return { ok: false, blocked: true, reason: "human target refused" };
    }
    const name = hostile.name ?? "hostile";
    const farSince: { at: number | null } = { at: null };
    let broke: FightBreak | null = null;
    const breakResult = (why: FightBreak): KillResult => {
      this.opts.logger.info({ target: name, why, health: bot.health }, "defense: breaking off the fight");
      if (why === "retarget") return { ok: false, retarget: true, reason: `another hostile closed in while fighting the ${name}` };
      if (why === "retreat") return { ok: false, retreat: true, reason: `health ${bot.health} fell to the retreat floor fighting the ${name}` };
      if (why === "outnumbered") return { ok: false, retreat: true, reason: `outnumbered by ${this.hostilesWithin(CROWD_RADIUS)} hostiles while fighting the ${name}` };
      if (why === "stalled") return { ok: false, reason: `no combat progress against the ${name}` };
      return { ok: false, reason: `could not reach the ${name}` };
    };

    if (distanceBetween(hostile.position, bot.entity.position) > MELEE_RADIUS) {
      const approach = await this.actions.travel(bot, hostile.position, {
        timeoutMs: APPROACH_TIMEOUT_MS,
        range: 3,
        shouldAbort: () => {
          if (this.travelAbort()) return true;
          // The approach timeout already bounds an out-of-reach target here.
          broke = this.fightBreak(hostile, allowRetreat, null);
          return broke !== null;
        },
        signal: this.signals?.signal,
      });
      if (this.stopRequested) return { ok: false, reason: "interrupted" };
      if (broke !== null) return breakResult(broke);
      if (approach.status !== "arrived" && approach.status !== "already_there") {
        return { ok: false, reason: `could not approach the ${name}` };
      }
    }

    const weapon = findItem(bot, "iron_sword") ?? findItem(bot, "stone_sword") ?? findItem(bot, "wooden_sword");
    if (weapon !== null) {
      try {
        await this.actions.equip(bot, weapon, this.signals?.signal);
      } catch {
        // A fist is a last resort; the sword is a speed bonus.
      }
    }

    // mineflayer-pvp chases one target until it dies; watch the fight and
    // stop it when another mob is doing the damage or the bot must run.
    let progressAt = Date.now();
    let bestDistance = distanceBetween(hostile.position, bot.entity.position);
    const onTargetHurt = (entity: Entity): void => {
      if (entity.id === hostile.id) progressAt = Date.now();
    };
    bot.on("entityHurt", onTargetHurt);
    const watch = setInterval(() => {
      if (broke !== null) return;
      const self = bot.entity?.position;
      if (self !== undefined && self !== null) {
        const distance = distanceBetween(hostile.position, self);
        if (distance < bestDistance - 0.5) {
          bestDistance = distance;
          progressAt = Date.now();
        }
      }
      this.checkInterrupt();
      broke = this.fightBreak(hostile, allowRetreat, farSince);
      if (broke === null && Date.now() - progressAt >= COMBAT_PROGRESS_TIMEOUT_MS) broke = "stalled";
      if (broke !== null || this.stopRequested) void this.actions.stop(bot, this.signals?.signal).catch(() => undefined);
    }, FIGHT_POLL_MS);
    try {
      await withTimeout(KILL_TIMEOUT_MS, this.actions.attack(bot, hostile, this.signals?.signal), async () => {
        await this.actions.stop(bot, this.signals?.signal);
      }, this.signals?.signal);
    } catch (err) {
      await this.actions.stop(bot, this.signals?.signal);
      if (broke !== null) return breakResult(broke);
      if (Date.now() > deadline) return { ok: false, reason: "defense budget exceeded" };
      return { ok: false, reason: `could not kill the ${name}: ${String(err)}` };
    } finally {
      clearInterval(watch);
      bot.off("entityHurt", onTargetHurt);
      await this.actions.stop(bot, this.signals?.signal);
    }
    if (combatOutcomeObserved(bot, hostile)) return { ok: true, killed: name };
    if (broke !== null) return breakResult(broke);
    return { ok: false, reason: `attack settled without an observed defeat of the ${name}` };
  }

  // --- plumbing ---

  private checkInterrupt(): void {
    if (this.stopRequested || this.signals === null) return;
    if (!this.signals.checkpoint({ interruptions: this.interruptions + 1 })) {
      this.stopRequested = true;
      this.interruptions += 1;
    }
  }

  private travelAbort = (): boolean => {
    this.checkInterrupt();
    return this.stopRequested;
  };

  private interrupted(data: DefenseData): SkillResult<DefenseData> {
    data.interruptions = this.interruptions;
    this.opts.logger.info({ kind: data.kind }, "defense interrupted");
    return { ok: false, status: "interrupted", retryable: true, data, message: "interrupted" };
  }

  private fail(data: DefenseData, errorCode: string, reason: string, retryable: boolean): SkillResult<DefenseData> {
    this.opts.logger.info({ kind: data.kind, errorCode, reason }, "defense failed");
    return { ok: false, status: "failed", errorCode, message: reason, retryable, data };
  }

  private announce(data: DefenseData): void {
    const message = `Defended. ${data.kills} hostile${data.kills === 1 ? "" : "s"} cleared.`;
    this.opts.logger.info({ kills: data.kills }, "defense status");
    if (this.opts.bot.entity === null) return;
    if (!gameChatBudgetAllows()) return;
    try {
      this.opts.bot.chat(message);
    } catch (err) {
      this.opts.logger.warn({ err: String(err) }, "defense chat failed");
    }
  }

  private recordSuccess(baseline: Record<string, number>, startedAt: number, data: DefenseData): void {
    const worldId = this.opts.state.worldId;
    if (worldId === null) return;
    const delta: Record<string, number> = {};
    for (const [name, count] of Object.entries(itemsSummary(this.opts.bot))) {
      const before = baseline[name] ?? 0;
      if (count !== before) delta[name] = count - before;
    }
    this.opts.skills.record({
      skillName: data.kind === "self" ? "defend_self" : "defend_player",
      parameters: { player: data.player },
      startingConditions: {
        inventorySummary: baseline,
        homeDistance: -1,
        timeOfDay: this.opts.bot.time && this.opts.bot.time.isDay ? "day" : "night",
      },
      outcome: {
        durationMs: Math.max(0, Date.now() - startedAt),
        interruptions: data.interruptions,
        finalInventoryDelta: delta,
      },
      description: `Cleared ${data.kills} hostiles${data.player === null ? "" : ` near ${data.player}`}.`,
    });
  }
}

function distanceBetween(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** A mob the server has not reported dead (corpses linger in bot.entities). */
function isLiveEntity(entity: Entity): boolean {
  const current = entity as Entity & { health?: number; isValid?: boolean };
  return current.isValid !== false && !(typeof current.health === "number" && current.health <= 0);
}

/**
 * Where to run: `distance` blocks straight away from the threats' centroid,
 * bent toward home when home does not lie back toward them. With no known
 * threat the bot heads for home.
 */
export function retreatTarget(
  self: { x: number; y: number; z: number },
  threats: ReadonlyArray<{ x: number; y: number; z: number }>,
  home: { x: number; y: number; z: number } | null,
  distance = RETREAT_DISTANCE,
): { x: number; y: number; z: number } {
  const unit = (dx: number, dz: number): { x: number; z: number } | null => {
    const length = Math.hypot(dx, dz);
    return length < 1e-6 ? null : { x: dx / length, z: dz / length };
  };
  const toHome = home === null ? null : unit(home.x - self.x, home.z - self.z);
  let away: { x: number; z: number } | null = null;
  if (threats.length > 0) {
    const cx = threats.reduce((sum, point) => sum + point.x, 0) / threats.length;
    const cz = threats.reduce((sum, point) => sum + point.z, 0) / threats.length;
    away = unit(self.x - cx, self.z - cz);
  }
  let direction = away ?? toHome ?? { x: 1, z: 0 };
  if (away !== null && toHome !== null && away.x * toHome.x + away.z * toHome.z > -0.25) {
    direction = unit(away.x + toHome.x * 0.6, away.z + toHome.z * 0.6) ?? away;
  }
  return { x: self.x + direction.x * distance, y: self.y, z: self.z + direction.z * distance };
}
