import type { Bot } from "mineflayer";
import type { Logger } from "pino";
import { Vec3 } from "vec3";
import type { MinecraftConfig } from "../config/schema.js";
import type { EventBus } from "../events/bus.js";
import { findBlocksNearPoint } from "../minecraft/world.js";
import { isShelterNight, isThundering } from "../skills/night-shelter.js";
import { isBedBlock } from "../skills/utility.js";
import type { Scheduler } from "./scheduler.js";
import type { AgentState } from "./state.js";
import { TaskPriority, TaskStatus, type Task } from "./task.js";

const CHECK_INTERVAL_MS = 5_000;
/** A failed shelter run stands down this long before the next attempt. */
const FAILURE_COOLDOWN_MS = 60_000;
/** Within this distance of home, a bed there means the sleep path covers the night. */
const BED_HOME_RADIUS = 48;
/** Scan radius for a bed around home. */
const BED_SCAN_RADIUS = 16;
const WORK_KEY = "night-shelter";

export interface ShelterDecisionInput {
  timeOfDay: number;
  /** A thunderstorm: hostiles spawn under it as at night. */
  thundering?: boolean;
  dimension: string;
  isSleeping: boolean;
  inWater: boolean;
  /** A bed stands at home and the bot is close enough for the sleep path. */
  bedAvailable: boolean;
  /** An owner task is active or queued: the owner decides the night. */
  ownerWorkPending: boolean;
  /** A shelter task is already active or queued. */
  shelterLive: boolean;
  cooldownActive: boolean;
}

/** Pure trigger decision for the night shelter. */
export function shelterDecision(input: ShelterDecisionInput): { shelter: boolean; reason: string } {
  if (!isShelterNight(input.timeOfDay) && input.thundering !== true) return { shelter: false, reason: "day" };
  if (!input.dimension.replace(/^minecraft:/, "").startsWith("overworld")) return { shelter: false, reason: "not the overworld" };
  if (input.isSleeping) return { shelter: false, reason: "asleep" };
  // The sleep path covers nights only; a daytime storm still needs the shelter.
  if (input.bedAvailable && isShelterNight(input.timeOfDay)) return { shelter: false, reason: "a bed is available" };
  if (input.inWater) return { shelter: false, reason: "in water" };
  if (input.ownerWorkPending) return { shelter: false, reason: "owner work pending" };
  if (input.shelterLive) return { shelter: false, reason: "already sheltering" };
  if (input.cooldownActive) return { shelter: false, reason: "cooling down after a failed shelter" };
  return { shelter: true, reason: isShelterNight(input.timeOfDay) ? "night without a bed" : "thunderstorm" };
}

export interface NightShelterWatchOptions {
  bot: Bot;
  bus: EventBus;
  scheduler: Scheduler;
  state: AgentState;
  config: MinecraftConfig;
  logger: Logger;
  /** Preempt a running bootstrap stage so the shelter gets the world lease. */
  yieldBootstrap?: () => void;
  now?: () => number;
}

/** True when an owner task is active or waiting to run. */
export function ownerWorkPending(scheduler: Pick<Scheduler, "active" | "queued">): boolean {
  // A blocked owner task waits on the owner, not on the night: the owner's
  // house slice, blocked since 2026-10-04, kept the shelter from ever
  // triggering, and a test storm at 13:39 (2026-10-05) killed the bot.
  return scheduler.active?.source === "user" || scheduler.queued.some((task) => task.source === "user" && task.status !== TaskStatus.BLOCKED);
}

/**
 * Night watch: at dusk, with no bed to sleep in, enqueue a `night_shelter`
 * task at INTERRUPT priority. That outranks background errands and bootstrap
 * stages (death recovery and the self-defense reflex still outrank it); owner
 * work keeps the floor.
 */
export class NightShelterWatch {
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: Array<() => void> = [];
  private failedAt: number | null = null;

  constructor(private readonly opts: NightShelterWatchOptions) {
    this.now = opts.now ?? Date.now;
  }

  attach(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.check(), CHECK_INTERVAL_MS);
    this.timer.unref?.();
    const onSettled = (failed: boolean) => ({ task }: { task: Task }): void => {
      if (task.workKey !== WORK_KEY) return;
      this.failedAt = failed ? this.now() : null;
    };
    this.unsubscribe = [
      this.opts.bus.on("task.failed", onSettled(true)),
      this.opts.bus.on("task.completed", onSettled(false)),
      this.opts.bus.on("time.night", () => this.check()),
    ];
  }

  detach(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    for (const off of this.unsubscribe) off();
    this.unsubscribe = [];
  }

  /** One trigger evaluation. Exposed for tests. */
  check(): void {
    const bot = this.opts.bot;
    if (bot.entity === null || bot.entity === undefined || bot.health <= 0) return;
    const scheduler = this.opts.scheduler;
    const decision = shelterDecision({
      timeOfDay: bot.time?.timeOfDay ?? 0,
      thundering: isThundering(bot as { thunderState?: number }),
      dimension: String(bot.game?.dimension ?? "overworld"),
      isSleeping: bot.isSleeping === true,
      inWater: (bot.entity as { isInWater?: boolean }).isInWater === true,
      bedAvailable: this.bedAvailable(),
      ownerWorkPending: ownerWorkPending(scheduler),
      shelterLive: scheduler.active?.workKey === WORK_KEY || scheduler.queued.some((task) => task.workKey === WORK_KEY && task.status !== TaskStatus.BLOCKED),
      cooldownActive: this.failedAt !== null && this.now() - this.failedAt < FAILURE_COOLDOWN_MS,
    });
    if (!decision.shelter) return;
    // A parked (BLOCKED) shelter from a failed run never resumes on its own;
    // replace it rather than let it stand for a live one.
    for (const parked of scheduler.queued.filter((task) => task.workKey === WORK_KEY && task.status === TaskStatus.BLOCKED)) scheduler.cancel(parked.id);
    scheduler.enqueue({
      type: "night_shelter",
      priority: TaskPriority.INTERRUPT,
      source: "maintenance",
      objective: "Dig in and wait out the night (no bed).",
      parameters: {},
      workKey: WORK_KEY,
      executionPolicy: "resumable",
    });
    this.opts.logger.warn({ timeOfDay: bot.time?.timeOfDay, reason: decision.reason }, "night shelter: digging in");
    this.opts.yieldBootstrap?.();
    scheduler.claim();
  }

  private bedAvailable(): boolean {
    if (this.opts.config.behavior?.auto_sleep === false) return false;
    const home = this.opts.state.home;
    const self = this.opts.bot.entity?.position;
    if (home === null || self === undefined || self === null) return false;
    if (Math.hypot(self.x - home.x, self.z - home.z) > BED_HOME_RADIUS) return false;
    try {
      return findBlocksNearPoint(this.opts.bot, new Vec3(home.x, home.y, home.z), isBedBlock, BED_SCAN_RADIUS, 1).length > 0;
    } catch {
      return false;
    }
  }
}
