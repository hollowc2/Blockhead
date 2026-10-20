import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import type { Logger } from "pino";
import { Vec3 } from "vec3";
import type { EventBus } from "../events/bus.js";
import { HOSTILE_MOB_NAMES, isMobEntity, PROVOKED_ONLY_MOB_NAMES } from "../policy/combat.js";
import type { Scheduler } from "./scheduler.js";
import { TaskPriority, type Task } from "./task.js";

/** A hostile this close (horizontally) is treated as an incoming attack. */
export const REFLEX_TRIGGER_RADIUS = 6;
/** Hostiles more than this many blocks above/below are behind a floor or wall. */
const REFLEX_TRIGGER_HEIGHT = 3;
/** Shared geometry only; public admission applies stricter observation rules. */
export function reflexThreatRange(name: string): { radius: number; height: number } {
  return /^(skeleton|stray|pillager|drowned)$/.test(name)
    ? { radius: 16, height: 12 }
    : { radius: REFLEX_TRIGGER_RADIUS, height: REFLEX_TRIGGER_HEIGHT };
}
/** How far the reflex's defense pass may range while clearing attackers. */
export const REFLEX_DEFENSE_RADIUS = 24;
const SCAN_INTERVAL_MS = 1_000;
/** A failed pass (unreachable mob behind a wall, say) stands down this long. */
const FAILURE_COOLDOWN_MS = 30_000;
const WORK_KEY = "reflex:defend_self";

export interface SelfDefenseReflexOptions {
  bot: Bot;
  bus: EventBus;
  scheduler: Scheduler;
  logger: Logger;
  now?: () => number;
}

/**
 * Fighting back is a reflex, not a decision. `defend_self` was reachable only
 * through the LLM or an owner command, so a zombie wandering out of the mine
 * killed the bot while it stood idle at home. This watches for damage from a
 * hostile mob, or one closing in, and enqueues a REFLEX-priority defense pass
 * that preempts whatever is running (death recovery included: a queued
 * defense behind an EMERGENCY trip let a creeper finish the job); the paused
 * work resumes afterwards.
 */
export class SelfDefenseReflex {
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private onHurt: ((hurt: Entity, source?: Entity | null) => void) | null = null;
  private unsubscribe: Array<() => void> = [];
  private attempt: { taskId: string; threatId: number; position: { x: number; y: number; z: number } } | null = null;
  private failure: { threatId: number; position: { x: number; y: number; z: number }; at: number; count: number } | null = null;

  constructor(private readonly opts: SelfDefenseReflexOptions) {
    this.now = opts.now ?? Date.now;
  }

  attach(): void {
    if (this.timer !== null) return;
    const onHurt = (hurt: Entity, source?: Entity | null): void => {
      if (hurt.id !== this.opts.bot.entity?.id) return;
      const attacker = source !== null && source !== undefined && isHostileMob(source) ? source : nearestThreat(this.opts.bot, 24);
      if (attacker === null) return;
      this.trigger(`hurt with ${attacker.name ?? "hostile"} in range`, attacker, true);
    };
    this.onHurt = onHurt;
    this.opts.bot.on("entityHurt", onHurt);
    this.timer = setInterval(() => this.scan(), SCAN_INTERVAL_MS);
    this.timer.unref?.();
    const onSettled = (failed: boolean) => ({ task }: { task: Task }): void => {
      if (task.workKey !== WORK_KEY) return;
      const attempt = this.attempt;
      if (!failed) this.failure = null;
      else if (attempt?.taskId === task.id) {
        const previous = this.failure;
        const unchanged = previous?.threatId === attempt.threatId
          && Math.hypot(previous.position.x - attempt.position.x, previous.position.y - attempt.position.y, previous.position.z - attempt.position.z) <= 3;
        this.failure = { threatId: attempt.threatId, position: attempt.position, at: this.now(), count: unchanged ? previous.count + 1 : 1 };
      }
      this.attempt = null;
    };
    this.unsubscribe = [
      this.opts.bus.on("task.failed", onSettled(true)),
      this.opts.bus.on("task.completed", onSettled(false)),
    ];
  }

  detach(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    if (this.onHurt !== null) this.opts.bot.off("entityHurt", this.onHurt);
    this.onHurt = null;
    for (const off of this.unsubscribe) off();
    this.unsubscribe = [];
  }

  /** Enqueue one defense pass unless one is live or cooling down. Exposed for tests. */
  scan(): void {
    // Sealed in a night shelter, a mob "near" is on the far side of solid
    // ground (a creeper in an adjacent cave pulled the bot out at midnight).
    // Only real damage (entityHurt) calls the reflex there.
    if (this.opts.scheduler.active?.type === "night_shelter") return;
    const threat = nearestThreat(this.opts.bot);
    if (threat !== null) this.trigger(`${threat.name ?? "hostile"} nearby`, threat);
  }

  private trigger(reason: string, threat: Entity, hurt = false): void {
    if (this.opts.bot.entity === null || this.opts.bot.health <= 0) return;
    const failure = this.failure;
    const position = this.opts.bot.entity.position;
    if (!hurt && failure?.threatId === threat.id
      && Math.hypot(position.x - failure.position.x, position.y - failure.position.y, position.z - failure.position.z) <= 3) {
      // Repeating an unchanged failure must leave increasing time for ordinary
      // work to move us out of it. New threats, movement and real damage bypass.
      const cooldown = Math.min(300_000, FAILURE_COOLDOWN_MS * 2 ** Math.min(failure.count - 1, 4));
      if (this.now() - failure.at < cooldown) return;
    }
    const active = this.opts.scheduler.active;
    if (active?.workKey === WORK_KEY || active?.type === "defend_self" || active?.type === "defend_player") return;
    if (this.opts.scheduler.queued.some((task) => task.workKey === WORK_KEY)) return;
    const task = this.opts.scheduler.enqueue({
      type: "defend_self",
      priority: TaskPriority.REFLEX,
      source: "maintenance",
      objective: `Fight off attackers (${reason}).`,
      parameters: { radius: REFLEX_DEFENSE_RADIUS, reflex: true },
      workKey: WORK_KEY,
    });
    this.attempt = { taskId: task.id, threatId: threat.id, position: { x: position.x, y: position.y, z: position.z } };
    this.opts.logger.warn({ reason }, "self-defense reflex triggered");
    this.opts.scheduler.claim();
  }
}

function isHostileMob(entity: Entity): boolean {
  return isMobEntity(entity) && HOSTILE_MOB_NAMES.has(entity.name ?? "");
}

/** The nearest hostile mob close enough, and level enough, to be attacking. */
export function nearestThreat(bot: Bot, damageRadius?: number): Entity | null {
  const self = bot.entity?.position;
  if (self === undefined || self === null) return null;
  let best: Entity | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const entity of Object.values(bot.entities ?? {})) {
    if (!isHostileMob(entity) || entity.position === undefined || entity.position === null) continue;
    const live = entity as Entity & { health?: number };
    if (entity.isValid === false || (typeof live.health === "number" && live.health <= 0)) continue;
    // A neutral mob nearby is not an attack; one that hits the bot still
    // triggers the reflex through entityHurt.
    if (PROVOKED_ONLY_MOB_NAMES.has(entity.name ?? "")) continue;
    const range = reflexThreatRange(entity.name ?? "");
    if (Math.abs(entity.position.y - self.y) > range.height) continue;
    const distance = Math.hypot(entity.position.x - self.x, entity.position.z - self.z);
    const radius = damageRadius ?? range.radius;
    if (distance <= radius && distance < bestDistance && threatLineClear(bot, entity)) {
      best = entity;
      bestDistance = distance;
    }
  }
  return best;
}

/** Solid cover separates loaded mobs from an exposed attacker. */
export function threatLineClear(bot: Bot, entity: Entity): boolean {
  if (typeof bot.blockAt !== "function") return true;
  const self = bot.entity?.position;
  if (self === undefined || self === null) return false;
  const start = new Vec3(self.x, self.y + 1.5, self.z);
  const end = new Vec3(entity.position.x, entity.position.y + 1.2, entity.position.z);
  const steps = Math.ceil(start.distanceTo(end) * 2);
  for (let i = 1; i < steps; i++) {
    const block = bot.blockAt(start.plus(end.minus(start).scaled(i / steps)));
    if (block === null || block.boundingBox === "block") return false;
  }
  return true;
}
