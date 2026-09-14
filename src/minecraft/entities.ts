import type { Bot } from "mineflayer";
import type { EventBus } from "../events/bus.js";

/**
 * Deterministic hostile-entity sensor (Phase 12). Mineflayer feeds raw
 * `entitySpawn` / `entityGone` events; this module keeps the small hostile
 * subset and emits the spec's `hostile.detected` bus event once per spawn.
 *
 * This is not an LLM layer — the tracker only answers "is anything hostile
 * near me and how far", which the danger model (spec 33's State panel) and
 * the dashboard feed consume.
 */

/** The subset of a mineflayer entity this sensor reads (structural, mocks-friendly). */
export interface TrackedEntity {
  id: number;
  type: string;
  name?: string;
  position: { x: number; y: number; z: number };
  isValid: boolean;
}

/** Mobs that attack on sight. The nicknames mirror mineflayer data names. */
const HOSTILE_MOB_NAMES: ReadonlySet<string> = new Set([
  "zombie",
  "zombie_villager",
  "husk",
  "drowned",
  "skeleton",
  "stray",
  "creeper",
  "spider",
  "cave_spider",
  "enderman",
  "witch",
  "slime",
  "phantom",
  "blaze",
  "ghast",
  "magma_cube",
  "wither",
  "wither_skeleton",
  "vindicator",
  "evoker",
  "ravager",
  "pillager",
  "vex",
]);

/** The nearest hostile mob and its straight-line distance in blocks. */
export interface HostileSighting {
  type: string;
  distance: number;
}

/**
 * Tracks spawned hostiles for the lifetime of one bot session. `attach()`
 * hooks the bot's entity events; `detach()` removes them. Positions are the
 * live prismarine positions, so `nearest()` reflects movement as the server
 * streams it.
 */
export class HostileTracker {
  private readonly bot: Bot;
  private readonly bus: EventBus;
  private readonly hostile = new Map<number, TrackedEntity>();
  private onSpawnRef: ((entity: TrackedEntity) => void) | null = null;
  private onGoneRef: ((entity: TrackedEntity) => void) | null = null;

  constructor(bot: Bot, bus: EventBus) {
    this.bot = bot;
    this.bus = bus;
  }

  /** Subscribe to the bot's entity events. Idempotent. */
  attach(): void {
    if (this.onSpawnRef !== null) return;
    const onSpawn = (entity: TrackedEntity): void => this.onSpawn(entity);
    const onGone = (entity: TrackedEntity): void => this.onGone(entity);
    this.onSpawnRef = onSpawn;
    this.onGoneRef = onGone;
    this.bot.on("entitySpawn", onSpawn);
    this.bot.on("entityGone", onGone);
  }

  /** Release the bot's entity events. A session's tracker is discarded on reconnect. */
  detach(): void {
    const onSpawn = this.onSpawnRef;
    const onGone = this.onGoneRef;
    if (onSpawn === null || onGone === null) return;
    this.bot.off("entitySpawn", onSpawn);
    this.bot.off("entityGone", onGone);
    this.onSpawnRef = null;
    this.onGoneRef = null;
    this.hostile.clear();
  }

  /** Number of tracked hostiles (diagnostics only). */
  get count(): number {
    return this.hostile.size;
  }

  /**
   * The nearest tracked hostile with a live position, or null when none.
   * Dead/invalid entities are pruned on the way (a despawned mob should not
   * keep adding danger forever).
   */
  nearest(): HostileSighting | null {
    const self = this.bot.entity?.position;
    if (self === null || self === undefined) return null;
    let best: HostileSighting | null = null;
    for (const [id, entity] of this.hostile) {
      if (!entity.isValid || entity.position === null) {
        this.hostile.delete(id);
        continue;
      }
      const distance = Math.hypot(
        self.x - entity.position.x,
        self.y - entity.position.y,
        self.z - entity.position.z,
      );
      if (best === null || distance < best.distance) {
        best = { type: entity.name ?? "hostile", distance: Math.round(distance) };
      }
    }
    return best;
  }

  private onSpawn(entity: TrackedEntity): void {
    if (entity.id === this.bot.entity?.id) return; // the bot's own body
    if (entity.type !== "mob" || !HOSTILE_MOB_NAMES.has(entity.name ?? "")) return;
    this.hostile.set(entity.id, entity);
    const self = this.bot.entity?.position;
    const distance =
      self !== null && self !== undefined
        ? Math.round(Math.hypot(self.x - entity.position.x, self.y - entity.position.y, self.z - entity.position.z))
        : null;
    this.bus.emit("hostile.detected", { type: entity.name ?? "hostile", distance });
  }

  private onGone(entity: TrackedEntity): void {
    this.hostile.delete(entity.id);
  }
}