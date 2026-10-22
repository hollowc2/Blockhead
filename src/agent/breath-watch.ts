import type { Bot } from "mineflayer";
import type { Logger } from "pino";
import { Vec3 } from "vec3";

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

/** A block's bare name by integer cell, or null when unloaded. */
export type CellName = (x: number, y: number, z: number) => string | null;

const SWIMMABLE = /^(water|bubble_column|seagrass|tall_seagrass|kelp|kelp_plant)$/;
const BREATHABLE = /^(air|cave_air)$/;
/** Cells searched for air under a ceiling: a few blocks of swimming, no more. */
const AIR_SEARCH_LIMIT = 300;

/**
 * Nearest breathable cell reachable by swimming from the head cell, or null.
 * Swimming straight up only works with open water overhead: on 2026-10-22
 * the bot drowned in a two-high flooded pocket under stone, with air two
 * blocks to the side.
 */
export function nearestAir(cell: CellName, head: { x: number; y: number; z: number }): { x: number; y: number; z: number } | null {
  const seen = new Set<string>([`${head.x},${head.y},${head.z}`]);
  const queue = [head];
  for (let i = 0; i < queue.length && seen.size < AIR_SEARCH_LIMIT; i++) {
    const at = queue[i]!;
    // Up first so open water overhead still means "swim up".
    for (const [dx, dy, dz] of [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]] as const) {
      const next = { x: at.x + dx, y: at.y + dy, z: at.z + dz };
      const key = `${next.x},${next.y},${next.z}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const name = cell(next.x, next.y, next.z);
      if (name === null) continue;
      if (BREATHABLE.test(name)) return next;
      if (SWIMMABLE.test(name)) queue.push(next);
    }
  }
  return null;
}

export interface BreathWatchOptions {
  bot: Bot;
  logger: Logger;
}

/** Keeps an idle, submerged bot swimming up for air. */
export class BreathWatch {
  private timer: ReturnType<typeof setInterval> | null = null;
  private surfacing = false;
  private escaping = false;

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
    if (want && eyes !== undefined) this.steerToAir(eyes.floored());
    else if (!want && this.escaping) this.stopEscape();
    if (want === this.surfacing) return;
    this.surfacing = want;
    bot.setControlState("jump", want);
    if (want) this.opts.logger.warn({ oxygen: bot.oxygenLevel, at: entity?.position.floored() }, "breath: head underwater and low on air; swimming up");
  }

  /** Under a ceiling, swim sideways toward the nearest air instead of only up. */
  private steerToAir(head: { x: number; y: number; z: number }): void {
    const bot = this.opts.bot;
    const cell: CellName = (x, y, z) => bot.blockAt?.(new Vec3(x, y, z))?.name ?? null;
    const above = cell(head.x, head.y + 1, head.z);
    if (above === null || SWIMMABLE.test(above) || BREATHABLE.test(above)) {
      if (this.escaping) this.stopEscape();
      return;
    }
    const air = nearestAir(cell, head);
    if (air === null) return;
    bot.lookAt?.(new Vec3(air.x + 0.5, air.y + 0.5, air.z + 0.5), true)?.catch(() => undefined);
    bot.setControlState("forward", true);
    if (!this.escaping) this.opts.logger.warn({ at: head, air }, "breath: ceiling overhead; swimming sideways to air");
    this.escaping = true;
  }

  private stopEscape(): void {
    this.escaping = false;
    this.opts.bot.setControlState("forward", false);
  }
}
