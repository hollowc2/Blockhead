import type { Logger } from "pino";
import type { EventBus } from "../events/bus.js";
import type { MinecraftConfig } from "../config/schema.js";
import type { DeathEventsRepository } from "../memory/deaths.js";
import { bareName } from "../minecraft/inventory.js";
import { normalizeDimension } from "../minecraft/protection.js";
import { ItemPolicy } from "../policy/item-policy.js";
import type { AgentState } from "./state.js";
import type { Scheduler } from "./scheduler.js";
import { TaskPriority, type Task } from "./task.js";

export interface DeathRecoveryManagerOptions {
  bus: EventBus;
  scheduler: Scheduler;
  state: AgentState;
  deaths: DeathEventsRepository;
  logger: Logger;
  /** Used for the item `items:` overrides behind the corpse-worth gate. */
  config?: MinecraftConfig;
  /** Injectable wall clock (tests advance it to exercise the loop brake). */
  now?: () => number;
}

/**
 * Death-loop brake thresholds. Deaths within this many blocks of each other
 * count as the same site; that many consecutive same-site deaths inside the
 * window prove the bot is respawning into an un-survivable spot (the logged
 * pattern: ~60 deaths at one spawn point, every 10-20s recovery trip coming
 * back empty with `items_despawned` while drops are destroyed instantly).
 */
const DEATH_LOOP_SITE_RADIUS = 8;
const DEATH_LOOP_WINDOW_MS = 5 * 60_000;
const DEATH_LOOP_THRESHOLD = 3;
/** How long the brake holds once a loop is declared. */
const DEATH_LOOP_BRAKE_MS = 10 * 60_000;

interface RecentDeath {
  at: number;
  x: number;
  y: number;
  z: number;
}

/** Why a death's recovery was skipped without a trip (persisted on the row). */
export type RecoverySkipReason = "nothing_carried" | "only_expendable_items";

/** The death-time verdict on whether a recovery trip is worth it. */
export interface CorpseVerdict {
  worthRecovering: boolean;
  skipReason: RecoverySkipReason | null;
  /** Total units carried at death (what the corpse will drop). */
  itemCount: number;
}

/**
 * Gate: is this death's drop worth a recovery trip? Decided at death time
 * from the carried-inventory snapshot, so an empty (or discard-junk-only)
 * death never pauses ordinary work for a sweep that has nothing to gain.
 * Expendable items are the policy's auto-discard candidates (dirt, gravel,
 * netherrack, rotten flesh, flowers, seeds, low-tier tools) — a corpse
 * holding only those is provably not worth a trip. Everything else,
 * including unclassified "common" items (unknown modded loot lands here), is
 * worth a visit: the sweep re-verifies the site anyway.
 */
export function corpseVerdict(inventory: Record<string, number>, policy: ItemPolicy): CorpseVerdict {
  const itemCount = Object.values(inventory).reduce((sum, count) => sum + count, 0);
  if (itemCount === 0) return { worthRecovering: false, skipReason: "nothing_carried", itemCount };
  const expendableRank = policy.rank("expendable");
  const worthAnything = Object.keys(inventory).some((name) => policy.rank(policy.classify(name)) < expendableRank);
  return worthAnything
    ? { worthRecovering: true, skipReason: null, itemCount }
    : { worthRecovering: false, skipReason: "only_expendable_items", itemCount };
}

/** "oak_log x2, dirt x3" style summary of a corpse contents. */
function corpusSummary(inventory: Record<string, number>): string {
  return Object.entries(inventory)
    .map(([name, count]) => {
      const bare = bareName(name);
      return count > 1 ? `${bare} x${count}` : bare;
    })
    .join(", ");
}

/**
 * Phase 10: death handling (spec section 26). Death is an emergency: this
 * coordinator records the event (position, dimension, time), pauses ordinary
 * work, and on respawn enqueues a single EMERGENCY-priority `death_recovery`
 * task whose deterministic runner sweeps the death site in value order.
 *
 * A death whose corpse is not worth a sweep is skipped outright at record
 * time (decided from the carried-inventory snapshot; see `corpseVerdict`):
 * the row records the reason and ordinary work is never paused.
 *
 * A newer death supersedes pending or queued recovery work — recovering the
 * older site first would let the newer drops despawn. Once the recovery task
 * settles (success or failure), the scheduler resumes the paused work, so
 * CobbleBob returns to useful operation either way.
 */
export class DeathRecoveryManager {
  private readonly opts: DeathRecoveryManagerOptions;
  private readonly now: () => number;
  private readonly policy: ItemPolicy;
  /** Death awaiting respawn, whose recovery is not yet queued. */
  private pendingDeathId: number | null = null;
  /** Death whose recovery task is currently queued or active. */
  private activeDeathId: number | null = null;
  /** Same-site deaths inside the rapid window, oldest first. */
  private readonly recentDeaths: RecentDeath[] = [];
  /** Wall clock until which recovery is braked (0 = no brake). */
  private deathLoopResetsAt = 0;
  /** Site whose rapid deaths started the current brake (null = no brake). */
  private deathLoopSite: { x: number; y: number; z: number } | null = null;
  /** True once the current brake has been surfaced (one warn per brake). */
  private deathLoopWarned = false;

  constructor(options: DeathRecoveryManagerOptions) {
    this.opts = options;
    this.now = options.now ?? Date.now;
    this.policy = new ItemPolicy(options.config?.items ?? {});
    options.bus.on("death", ({ dimension, position, killer, inventory }) =>
      this.onDeath(dimension, position, killer, inventory),
    );
    options.bus.on("respawn", () => this.onRespawn());
    options.bus.on("task.completed", ({ task }) => this.onRecoveryTaskSettled(task));
    options.bus.on("task.failed", ({ task }) => this.onRecoveryTaskSettled(task));
    options.bus.on("task.cancelled", ({ task }) => this.onRecoveryTaskSettled(task));
  }

  /**
   * True while the death-loop brake holds. Recovery trips are provably
   * futile (drops destroyed instantly at the kill site), so the manager
   * records deaths but refrains from sweeping, and the background
   * coordinator stands down wandering restores that feed the loop.
   */
  get inDeathLoop(): boolean {
    return this.now() < this.deathLoopResetsAt;
  }

  private onDeath(
    dimension: string | null,
    position: { x: number; y: number; z: number } | null,
    killer: { name: string; x: number; y: number; z: number } | null,
    inventory: Record<string, number>,
  ): void {
    const worldId = this.opts.state.worldId;
    if (worldId === null || position === null) {
      this.opts.logger.warn({ dimension, position, killer }, "death without a recordable site; skipping recovery");
      return;
    }

    // A newer death supersedes recovery work that has not finished.
    if (this.pendingDeathId !== null) {
      this.opts.deaths.markFailed(this.pendingDeathId, "superseded_by_another_death");
      this.pendingDeathId = null;
    }
    if (this.activeDeathId !== null) {
      this.opts.deaths.markFailed(this.activeDeathId, "superseded_by_another_death");
      this.activeDeathId = null;
    }
    for (const task of this.opts.scheduler.queued) {
      if (task.type === "death_recovery") {
        this.cancelQueuedRecovery(task);
      }
    }
    if (this.opts.scheduler.active?.type === "death_recovery") {
      // The runner marks the outcome itself when it observes the interrupt.
      this.opts.scheduler.requestCancel();
    }

    const death = this.opts.deaths.record(worldId, {
      dimension: normalizeDimension(dimension ?? "unknown"),
      x: position.x,
      y: position.y,
      z: position.z,
      inventory,
    });
    const site = `(${Math.round(death.x)}, ${Math.round(death.y)}, ${Math.round(death.z)})`;

    // Worth gate: decide at death time, from what was actually carried, so an
    // empty or junk-only corpse never pauses ordinary work for a sweep that
    // has nothing to gain. The verdict is surfaced and persisted; nothing is
    // enqueued on respawn for a skipped death.
    const verdict = corpseVerdict(death.inventory, this.policy);
    this.pendingDeathId = death.id;
    if (!verdict.worthRecovering) {
      this.pendingDeathId = null;
      this.opts.deaths.markSkipped(death.id, verdict.skipReason ?? "nothing_carried");
      const contents = corpusSummary(death.inventory);
      const cause = verdict.skipReason === "nothing_carried" ? "carried nothing" : `carried only ${contents}`;
      this.opts.state.addEvent(`died at ${site} — ${cause}; recovery skipped`);
      this.opts.bus.emit("death.recorded", {
        deathId: death.id,
        inventory: death.inventory,
        worthRecovering: false,
        skipReason: verdict.skipReason,
      });
      this.opts.logger.info(
        {
          deathId: death.id,
          position,
          dimension: death.dimension,
          killer: killer?.name ?? null,
          inventory: death.inventory,
          skipReason: verdict.skipReason,
        },
        "death recorded; nothing worth recovering — no recovery trip",
      );
    } else {
      this.opts.scheduler.requestPause();
      this.opts.state.addEvent(`died at ${site} — carrying ${verdict.itemCount} items; recovery queued`);
      this.opts.bus.emit("death.recorded", {
        deathId: death.id,
        inventory: death.inventory,
        worthRecovering: true,
        skipReason: null,
      });
      this.opts.logger.warn(
        { deathId: death.id, position, dimension: death.dimension, killer: killer?.name ?? null, inventory: death.inventory },
        "death recorded; pausing ordinary tasks for recovery",
      );
    }

    // Death-loop brake: same-site rapid deaths prove a respawn kill zone —
    // drop recovery is futile there, so further deaths record but do not
    // enqueue another sweep (respawning into the killer must not repeat it).
    // Skipped deaths still count: dying repeatedly with nothing on you is
    // the same kill-zone signal, and the brake stands down wanderers that
    // feed it either way.
    const at = this.now();
    this.recentDeaths.push({ at, x: death.x, y: death.y, z: death.z });
    this.evaluateDeathLoop(death, at, killer?.name ?? null);
  }

  /**
   * Death-loop detection. While the brake holds, a death at (near) the
   * loop site records only; a death somewhere new clears the brake — that
   * hazard is no longer the current threat — and normal per-death recovery
   * resumes. When no brake holds, THRESHOLD consecutive same-site deaths
   * inside the window declare a loop: recovery stands down for the brake
   * window with a single surfaced warning.
   */
  private evaluateDeathLoop(
    death: { id: number; x: number; y: number; z: number },
    at: number,
    killer: string | null,
  ): void {
    const site = { x: death.x, y: death.y, z: death.z };

    if (this.inDeathLoop) {
      if (this.deathLoopSite !== null && withinDeathLoopRadius(site, this.deathLoopSite)) {
        // Same kill zone as before: the drops are gone again. Record only.
        this.pendingDeathId = null;
        return;
      }
      // The bot died somewhere new — whatever killed it at the loop site is
      // not the current threat. Normal per-death handling resumes.
      this.clearDeathLoop();
    }

    this.pruneRecentDeaths(at);
    const consecutive = this.consecutiveSameSiteDeaths(site);
    if (consecutive < DEATH_LOOP_THRESHOLD) return;

    this.deathLoopResetsAt = at + DEATH_LOOP_BRAKE_MS;
    this.deathLoopSite = site;
    this.pendingDeathId = null;
    if (this.deathLoopWarned) return;
    this.deathLoopWarned = true;
    this.opts.logger.warn(
      {
        deathId: death.id,
        x: Math.round(site.x),
        y: Math.round(site.y),
        z: Math.round(site.z),
        consecutiveDeaths: consecutive,
        killer,
      },
      "repeated deaths at the same site; recovery standing down (a mob is camping the respawn point)",
    );
    this.opts.state.addEvent(
      `death loop: ${consecutive} deaths at (${Math.round(site.x)}, ${Math.round(site.y)}, ${Math.round(site.z)})${killer === null ? "" : `, killed by ${killer}`}; recovery paused — move CobbleBob or relocate the spawn`,
    );
    this.opts.bus.emit("death.loop_detected", {
      deathId: death.id,
      x: site.x,
      y: site.y,
      z: site.z,
      consecutiveDeaths: consecutive,
      killer,
    });
  }

  private clearDeathLoop(): void {
    this.deathLoopResetsAt = 0;
    this.deathLoopSite = null;
    this.deathLoopWarned = false;
  }

  /** Drop deaths outside the rapid window, keeping at most the window's worth. */
  private pruneRecentDeaths(at: number): void {
    const cutoff = at - DEATH_LOOP_WINDOW_MS;
    while (this.recentDeaths.length > 0 && this.recentDeaths[0]!.at < cutoff) {
      this.recentDeaths.shift();
    }
  }

  /** Deaths at the tail that are (within radius of) the given site, newest first. */
  private consecutiveSameSiteDeaths(site: { x: number; y: number; z: number }): number {
    let count = 0;
    for (let i = this.recentDeaths.length - 1; i >= 0; i--) {
      if (!withinDeathLoopRadius(site, this.recentDeaths[i]!)) break;
      count++;
    }
    return count;
  }

  private onRespawn(): void {
    const deathId = this.pendingDeathId;
    if (deathId === null) return;
    this.pendingDeathId = null;

    const death = this.opts.deaths.get(deathId);
    if (death === null) return;
    if (death.recoverySkippedReason !== null) {
      // Belt and braces: a skipped death never reaches the queue (pending was
      // cleared at record time), but a stale in-flight respawn event must not
      // resurrect a trip for a corpse that was judged worthless.
      this.opts.logger.info(
        { deathId: death.id, skipReason: death.recoverySkippedReason },
        "death recovery already skipped; no trip",
      );
      return;
    }

    const task = this.opts.scheduler.enqueue({
      type: "death_recovery",
      priority: TaskPriority.EMERGENCY,
      source: "system",
      objective: "Recover items from death site",
      parameters: {
        deathId: death.id,
        dimension: death.dimension,
        x: death.x,
        y: death.y,
        z: death.z,
      },
    });
    this.activeDeathId = death.id;
    // EMERGENCY outranks every foreground/background priority; the scheduler
    // pauses the active task cooperatively and runs recovery next.
    this.opts.scheduler.claim();
    this.opts.logger.info({ deathId: death.id, taskId: task.id }, "death recovery enqueued at EMERGENCY priority");
  }

  private cancelQueuedRecovery(task: Task): void {
    const deathId = Number(task.parameters.deathId);
    if (Number.isFinite(deathId)) {
      this.opts.deaths.markFailed(deathId, "superseded_by_another_death");
    }
    this.opts.scheduler.cancel(task.id);
    this.opts.logger.info({ taskId: task.id, deathId }, "queued death recovery superseded and cancelled");
  }

  /** The recovery task settled; its death is no longer the active one. */
  private onRecoveryTaskSettled(task: Task): void {
    if (task.type !== "death_recovery") return;
    if (this.activeDeathId === Number(task.parameters.deathId)) {
      this.activeDeathId = null;
    }
  }
}

/** True when two sites are close enough to be the same death location. */
function withinDeathLoopRadius(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
): boolean {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz <= DEATH_LOOP_SITE_RADIUS * DEATH_LOOP_SITE_RADIUS;
}