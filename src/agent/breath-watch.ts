import type { Bot } from "mineflayer";
import type { Logger } from "pino";

const CHECK_INTERVAL_MS = 500;
/** Out of 20: at or below this with the head underwater, swim up. */
export const LOW_OXYGEN = 14;
/** Keep swimming up until the air bar is this full again. */
const RECOVERED_OXYGEN = 19;

export interface BreathInput {
  alive: boolean;
  oxygen: number;
  headUnderwater: boolean;
  pathfinderMoving: boolean;
  surfacing: boolean;
}

/**
 * Pure decision: hold jump (swim up) or not. A route that cannot start from
 * water ends every task at once, and an idle bot sinks: on 2026-10-04 19:00
 * it sank from y=59 to y=49 between tasks and drowned with the coal haul.
 * A moving pathfinder owns the controls, so the watch only acts when idle.
 */
export function shouldSurface(input: BreathInput): boolean {
  if (!input.alive || input.pathfinderMoving || !input.headUnderwater) return false;
  return input.surfacing ? input.oxygen < RECOVERED_OXYGEN : input.oxygen <= LOW_OXYGEN;
}

export interface BreathWatchOptions {
  bot: Bot;
  logger: Logger;
}

/** Keeps an idle, submerged bot swimming up for air. */
export class BreathWatch {
  private timer: ReturnType<typeof setInterval> | null = null;
  private surfacing = false;

  constructor(private readonly opts: BreathWatchOptions) {}

  attach(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.check(), CHECK_INTERVAL_MS);
    this.timer.unref?.();
  }

  detach(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** One evaluation. Exposed for tests. */
  check(): void {
    const bot = this.opts.bot;
    const entity = bot.entity;
    const eyes = entity?.position?.offset(0, 1.62, 0);
    const head = eyes === undefined ? null : bot.blockAt?.(eyes.floored()) ?? null;
    const want = shouldSurface({
      alive: entity !== null && entity !== undefined && bot.health > 0,
      oxygen: bot.oxygenLevel ?? 20,
      headUnderwater: head !== null && /water|bubble_column/.test(head.name),
      pathfinderMoving: (bot as { pathfinder?: { isMoving?: () => boolean } }).pathfinder?.isMoving?.() === true,
      surfacing: this.surfacing,
    });
    if (want === this.surfacing) return;
    this.surfacing = want;
    bot.setControlState("jump", want);
    if (want) this.opts.logger.warn({ oxygen: bot.oxygenLevel, at: entity?.position.floored() }, "breath: head underwater and low on air; swimming up");
  }
}
