import type { Bot } from "mineflayer";
import type { Logger } from "pino";
import type { EventBus } from "../events/bus.js";
import { countFoodItems } from "../skills/gather-food.js";
import type { Scheduler } from "./scheduler.js";
import { TaskPriority, TaskStatus, type Task } from "./task.js";

const CHECK_INTERVAL_MS = 5_000;
/** A failed food run stands down this long before the watch tries again. */
const FAILURE_COOLDOWN_MS = 60_000;
/** At or below this hunger with nothing to eat, food comes before other work. */
export const HUNGER_EMERGENCY_FOOD = 10;
/** Food items one emergency run gathers. */
const EMERGENCY_FOOD_ITEMS = 6;
const WORK_KEY = "hunger-emergency";

export interface HungerWatchInput {
  alive: boolean;
  hunger: number;
  foodCarried: number;
  foodRunLive: boolean;
  cooldownActive: boolean;
}

/** Pure trigger decision for an emergency food run. */
export function hungerEmergency(input: HungerWatchInput): boolean {
  return input.alive && input.hunger <= HUNGER_EMERGENCY_FOOD && input.foodCarried === 0
    && !input.foodRunLive && !input.cooldownActive;
}

export interface HungerWatchOptions {
  bot: Bot;
  bus: EventBus;
  scheduler: Scheduler;
  logger: Logger;
  now?: () => number;
}

/**
 * The stockpile crisis check runs only between tasks, and a food restore has
 * the same MAINTENANCE priority as a re-arm, so a bot that respawned with
 * nothing to eat spent ten minutes re-arming while hunger ran from 20 to 0
 * and starvation took it to 1 HP. Hungry with no food carried, queue a food
 * run at INTERRUPT priority, above maintenance and owner work.
 */
export class HungerWatch {
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: Array<() => void> = [];
  private failedAt: number | null = null;

  constructor(private readonly opts: HungerWatchOptions) {
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
      this.opts.bus.on("hunger.low", () => this.check()),
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
    const scheduler = this.opts.scheduler;
    const live = (task: Task): boolean => task.workKey === WORK_KEY && task.status !== TaskStatus.BLOCKED;
    const trigger = hungerEmergency({
      alive: bot.entity !== null && bot.entity !== undefined && bot.health > 0,
      hunger: Number.isFinite(bot.food) ? bot.food : 20,
      foodCarried: countFoodItems(bot),
      foodRunLive: (scheduler.active !== null && live(scheduler.active)) || scheduler.queued.some(live),
      cooldownActive: this.failedAt !== null && this.now() - this.failedAt < FAILURE_COOLDOWN_MS,
    });
    if (!trigger) return;
    scheduler.enqueue({
      type: "gather_food",
      priority: TaskPriority.INTERRUPT,
      source: "maintenance",
      objective: `Hungry with nothing to eat: gather ${EMERGENCY_FOOD_ITEMS} food.`,
      parameters: { quantity: EMERGENCY_FOOD_ITEMS },
      workKey: WORK_KEY,
    });
    this.opts.logger.warn({ hunger: bot.food, health: bot.health }, "hungry with no food carried; food run first");
    scheduler.claim();
  }
}
