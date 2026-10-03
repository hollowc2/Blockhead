import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import type { Logger } from "pino";
import type { EventBus } from "../events/bus.js";
import { HOSTILE_MOB_NAMES, isMobEntity, PROVOKED_ONLY_MOB_NAMES } from "../policy/combat.js";
import type { Scheduler } from "./scheduler.js";
import { TaskPriority, type Task } from "./task.js";

/** A hostile this close (horizontally) is treated as an incoming attack. */
export const REFLEX_TRIGGER_RADIUS = 6;
/** Hostiles more than this many blocks above/below are behind a floor or wall. */
const REFLEX_TRIGGER_HEIGHT = 3;
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
  private failedAt: number | null = null;

  constructor(private readonly opts: SelfDefenseReflexOptions) {
    this.now = opts.now ?? Date.now;
  }

  attach(): void {
    if (this.timer !== null) return;
    const onHurt = (hurt: Entity, source?: Entity | null): void => {
      if (hurt.id !== this.opts.bot.entity?.id) return;
      if (source === null || source === undefined || !isHostileMob(source)) return;
      this.trigger(`hurt by ${source.name ?? "hostile"}`);
    };
    this.onHurt = onHurt;
    this.opts.bot.on("entityHurt", onHurt);
    this.timer = setInterval(() => this.scan(), SCAN_INTERVAL_MS);
    this.timer.unref?.();
    const onSettled = (failed: boolean) => ({ task }: { task: Task }): void => {
      if (task.workKey !== WORK_KEY) return;
      this.failedAt = failed ? this.now() : null;
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
    if (threat !== null) this.trigger(`${threat.name ?? "hostile"} within ${REFLEX_TRIGGER_RADIUS} blocks`);
  }

  private trigger(reason: string): void {
    if (this.opts.bot.entity === null || this.opts.bot.health <= 0) return;
    if (this.failedAt !== null && this.now() - this.failedAt < FAILURE_COOLDOWN_MS) return;
    const active = this.opts.scheduler.active;
    if (active?.workKey === WORK_KEY || active?.type === "defend_self" || active?.type === "defend_player") return;
    if (this.opts.scheduler.queued.some((task) => task.workKey === WORK_KEY)) return;
    this.opts.scheduler.enqueue({
      type: "defend_self",
      priority: TaskPriority.REFLEX,
      source: "maintenance",
      objective: `Fight off attackers (${reason}).`,
      parameters: { radius: REFLEX_DEFENSE_RADIUS, reflex: true },
      workKey: WORK_KEY,
    });
    this.opts.logger.warn({ reason }, "self-defense reflex triggered");
    this.opts.scheduler.claim();
  }
}

function isHostileMob(entity: Entity): boolean {
  return isMobEntity(entity) && HOSTILE_MOB_NAMES.has(entity.name ?? "");
}

/** The nearest hostile mob close enough, and level enough, to be attacking. */
export function nearestThreat(bot: Bot): Entity | null {
  const self = bot.entity?.position;
  if (self === undefined || self === null) return null;
  let best: Entity | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const entity of Object.values(bot.entities)) {
    if (!isHostileMob(entity) || entity.position === undefined || entity.position === null) continue;
    // A neutral mob nearby is not an attack; one that hits the bot still
    // triggers the reflex through entityHurt.
    if (PROVOKED_ONLY_MOB_NAMES.has(entity.name ?? "")) continue;
    if (Math.abs(entity.position.y - self.y) > REFLEX_TRIGGER_HEIGHT) continue;
    const distance = Math.hypot(entity.position.x - self.x, entity.position.z - self.z);
    if (distance <= REFLEX_TRIGGER_RADIUS && distance < bestDistance) {
      best = entity;
      bestDistance = distance;
    }
  }
  return best;
}
