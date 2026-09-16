import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import type { Logger } from "pino";
import type { AgentState } from "../agent/state.js";
import type { TaskSignals } from "../agent/scheduler.js";
import type { MinecraftConfig } from "../config/schema.js";
import type { EventBus } from "../events/bus.js";
import type { SkillsRepository } from "../memory/skills.js";
import { findItem, itemsSummary } from "../minecraft/inventory.js";
import { travelAndWait } from "../minecraft/movement.js";
import { equipItem, pvpAttack, pvpStop } from "../minecraft/primitives.js";
import { attackTargetAllowed, isHumanTarget, HOSTILE_MOB_NAMES } from "../policy/combat.js";
import { checkHealthRetreat, HEALTH_RETREAT_THRESHOLD } from "../policy/safety.js";
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
/** Wall-clock budget for one kill (approach, fight, stop). */
const KILL_TIMEOUT_MS = 60_000;
/** Wall-clock budget for the whole defense pass. */
const TOTAL_TIMEOUT_MS = 180_000;
/** Max hostiles cleared in one pass (bounds a single task). */
const MAX_KILLS_PER_PASS = 3;
/** Distance the defended player may be for the bot to still fight for them. */
const DEFEND_PLAYER_RANGE = 48;

export interface DefenseOptions {
  bot: Bot;
  state: AgentState;
  config: MinecraftConfig;
  bus: EventBus;
  /** Skill success records (spec 20.2). */
  skills: SkillsRepository;
  logger: Logger;
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
}

interface KillResult {
  ok: boolean;
  killed?: string;
  reason?: string;
  blocked?: boolean;
}

/**
 * Deterministic defense runner: clears nearby hostile mobs, never human
 * players. One run at a time.
 */
export class DefenseRunner {
  private running = false;
  private signals: TaskSignals | null = null;
  private stopRequested = false;
  private interruptions = 0;

  constructor(private readonly opts: DefenseOptions) {}

  get isRunning(): boolean {
    return this.running;
  }

  /** Defend the bot itself: clear hostiles close enough to pose a threat. */
  async defendSelf(options: { signals?: TaskSignals; resumeState?: { interruptions?: number } } = {}): Promise<SkillResult<DefenseData>> {
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
    options: { signals?: TaskSignals; resumeState?: { interruptions?: number } },
  ): Promise<SkillResult<DefenseData>> {
    if (this.running) {
      return { ok: false, status: "blocked", errorCode: "ALREADY_RUNNING", message: "already defending" };
    }
    this.running = true;
    this.signals = options.signals ?? null;
    this.interruptions = typeof options.resumeState?.interruptions === "number" ? options.resumeState.interruptions : 0;
    this.stopRequested = false;
    try {
      return await this.execute(kind, player);
    } finally {
      this.running = false;
      this.signals = null;
    }
  }

  private async execute(kind: "self" | "player", player: string | null): Promise<SkillResult<DefenseData>> {
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
    };

    if (bot.entity === null) {
      return this.fail(data, "NOT_READY", "bot is not spawned", false);
    }

    // Spec 34: dangerous work retreats below the health floor. Fighting at
    // low health risks another death; the bot waits for regen instead.
    const healthGate = checkHealthRetreat(bot.health, HEALTH_RETREAT_THRESHOLD);
    if (!healthGate.allowed) {
      return this.fail(data, "DANGER_TOO_HIGH", `health ${bot.health} is at/below the retreat threshold ${HEALTH_RETREAT_THRESHOLD}`, false);
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

    let deadline = startedAt + TOTAL_TIMEOUT_MS;
    while (this.opts.bot.entity !== null && data.kills < MAX_KILLS_PER_PASS) {
      if (this.stopRequested) return this.interrupted(data);
      if (Date.now() > deadline) {
        data.timeout = true;
        break;
      }
      this.checkInterrupt();
      if (this.stopRequested) return this.interrupted(data);

      const hostile = this.nearestHostile(anchor);
      if (hostile === null) break;
      const kill = await this.killHostile(hostile, data, deadline);
      if (kill.blocked) {
        data.blocked += 1;
        // A blocked target is still a real threat; stop fighting rather than
        // loop forever on a target policy forbids.
        break;
      }
      if (!kill.ok) {
        if (this.stopRequested) return this.interrupted(data);
        break;
      }
      data.kills += 1;
      // Re-anchor after movement so the next scan follows the player.
      if (kind === "player") {
        const refreshed = bot.players[player ?? ""]?.entity ?? null;
        anchor = refreshed === null ? anchor : { x: refreshed.position.x, y: refreshed.position.y, z: refreshed.position.z };
      }
    }

    if (this.stopRequested) return this.interrupted(data);
    this.announce(data);
    if (data.kills === 0 && !data.timeout) {
      return { ok: true, status: "completed", data, message: "no hostiles nearby" };
    }
    if (data.kills === 0) {
      return this.fail(data, "DANGER_TOO_HIGH", "defense timed out without clearing the area", false);
    }
    this.recordSuccess(baseline, startedAt, data);
    return { ok: true, status: "completed", data, message: `cleared ${data.kills} hostiles` };
  }

  /** Nearest hostile mob to `anchor` (the bot when defending itself). */
  private nearestHostile(anchor: { x: number; y: number; z: number } | null): Entity | null {
    const bot = this.opts.bot;
    if (bot.entity === null) return null;
    const origin = anchor ?? { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z };
    let best: Entity | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const entity of Object.values(bot.entities)) {
      // THE policy boundary: player entities are never candidates.
      if (entity.type === "player") continue;
      if (entity.type !== "mob" || !HOSTILE_MOB_NAMES.has(entity.name ?? "")) continue;
      const distance = Math.hypot(
        entity.position.x - origin.x,
        entity.position.y - origin.y,
        entity.position.z - origin.z,
      );
      if (distance <= DEFENSE_VIEW_RADIUS && distance < bestDistance) {
        best = entity;
        bestDistance = distance;
      }
    }
    return best;
  }

  /** Approach and kill one hostile. Belt-and-braces combat guard included. */
  private async killHostile(hostile: Entity, data: DefenseData, deadline: number): Promise<KillResult> {
    const bot = this.opts.bot;
    if (bot.entity === null) return { ok: false, reason: "bot is not spawned" };

    if (!attackTargetAllowed(hostile.type, this.opts.config).allowed || isHumanTarget(hostile.type)) {
      this.opts.logger.warn({ target: hostile.name ?? hostile.type }, "defense refused a human target");
      return { ok: false, blocked: true, reason: "human target refused" };
    }

    const approach = await travelAndWait(bot, hostile.position, {
      timeoutMs: KILL_TIMEOUT_MS,
      range: 3,
      shouldAbort: this.travelAbort,
      signal: this.signals?.signal,
    });
    if (this.stopRequested) return { ok: false, reason: "interrupted" };
    if (approach.status !== "arrived" && approach.status !== "already_there") {
      return { ok: false, reason: `could not approach the ${hostile.name ?? "hostile"}` };
    }

    const weapon = findItem(bot, "iron_sword") ?? findItem(bot, "stone_sword") ?? findItem(bot, "wooden_sword");
    if (weapon !== null) {
      try {
        await equipItem(bot, weapon, this.signals?.signal);
      } catch {
        // A fist is a last resort; the sword is a speed bonus.
      }
    }

    try {
      await withTimeout(KILL_TIMEOUT_MS, pvpAttack(bot, hostile, this.signals?.signal), async () => {
        await pvpStop(bot, this.signals?.signal);
      }, this.signals?.signal);
    } catch (err) {
      await pvpStop(bot, this.signals?.signal);
      if (Date.now() > deadline) return { ok: false, reason: "defense budget exceeded" };
      return { ok: false, reason: `could not kill the ${hostile.name ?? "hostile"}: ${String(err)}` };
    } finally {
      await pvpStop(bot, this.signals?.signal);
    }
    return { ok: true, killed: hostile.name ?? "hostile" };
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
