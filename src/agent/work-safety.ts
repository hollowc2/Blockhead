import type { Bot } from "mineflayer";
import type { Logger } from "pino";
import type { EventBus } from "../events/bus.js";
import { isCreativeMode } from "../minecraft/mode.js";
import { nearestThreat } from "./self-defense.js";
import type { Scheduler } from "./scheduler.js";
import { TaskPriority, type Task } from "./task.js";
import { hasFoodForWork } from "./work-readiness.js";

/** Survival work remains runnable while discretionary checkpoints wait. */
export function taskSafeToRun(bot: Bot, task: Task): boolean {
  if (isCreativeMode(bot) || task.source === "user" || task.source === "system") return true;
  if (["defend_self", "defend_player", "go_home", "sleep", "night_shelter", "eat", "gather_food", "death_recovery", "world_project_return"].includes(task.type)) return true;
  if (task.type === "stockpile_maintenance" && task.parameters.kind === "food") return true;
  if (task.type === "ensure_item" && task.parameters.item === "bread") return true;
  return bot.entity !== null && bot.health >= 14 && nearestThreat(bot) === null && hasFoodForWork(bot);
}

export class WorkSafetyCoordinator {
  private timer: NodeJS.Timeout | null = null;
  private readonly unsubscribe: Array<() => void> = [];
  private shelterRetryAt = 0;
  constructor(private readonly opts: { bot: Bot; scheduler: Scheduler; bus: EventBus; logger: Logger }) {}
  attach(): void {
    if (this.timer !== null) return;
    this.opts.scheduler.setActivationGuard(task => taskSafeToRun(this.opts.bot, task));
    this.unsubscribe.push(this.opts.bus.on("damage.received", () => this.scan()));
    this.unsubscribe.push(this.opts.bus.on("task.failed", ({ task }) => {
      if (task.workKey === "heal-in-shelter") this.shelterRetryAt = Date.now() + 30_000;
    }));
    this.timer = setInterval(() => this.scan(), 1_000); this.timer.unref();
  }
  scan(): void {
    const { bot, scheduler, logger } = this.opts;
    if (bot.entity === null || bot.health <= 0 || scheduler.isHalted || isCreativeMode(bot)) return;
    const active = scheduler.active;
    if (active !== null && !taskSafeToRun(bot, active) && !scheduler.interruptPending) {
      logger.warn({ taskId: active.id, health: bot.health }, "unsafe autonomous work paused; preserving checkpoint");
      scheduler.requestPause();
    }
    if (bot.health < 14 && nearestThreat(bot) !== null && Date.now() >= this.shelterRetryAt
      && active?.type !== "night_shelter" && !scheduler.queued.some(task => task.type === "night_shelter")) {
      scheduler.enqueue({ type: "night_shelter", source: "maintenance", priority: TaskPriority.EMERGENCY, objective: "Shelter until health recovers before resuming work.", parameters: { healUntilHealth: 14 }, workKey: "heal-in-shelter" });
    }
    scheduler.claim();
  }
  detach(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    for (const off of this.unsubscribe.splice(0)) off();
    this.opts.scheduler.setActivationGuard(null);
  }
}
