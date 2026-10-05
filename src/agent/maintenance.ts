import type { Bot } from "mineflayer";
import type { Logger } from "pino";
import type { MinecraftConfig } from "../config/schema.js";
import type { EventBus } from "../events/bus.js";
import { bareName, isRawLogItemName, itemsSummary } from "../minecraft/inventory.js";
import { countStoredItems } from "../minecraft/containers.js";
import { dominantNearbyLog } from "../minecraft/world.js";
import type { StorageRepository } from "../memory/storage.js";
import type { Scheduler } from "./scheduler.js";
import type { TaskSignals } from "./scheduler.js";
import { TaskPriority } from "./task.js";
import type { AgentState } from "./state.js";
import type { CollectResourceRunner } from "../skills/collect-resource.js";
import type { EnsureTorchesRunner } from "../skills/ensure-torches.js";
import type { GatherFoodRunner } from "../skills/gather-food.js";
import type { SkillResult } from "../skills/skill-library.js";
import { countFoodItems, FOOD_ITEM_NAMES } from "../skills/gather-food.js";

/**
 * Phase 7: deterministic background stockpile maintenance (spec sections
 * 4.3, 29). The manager measures each stockpile as carried + stored in the
 * home chest, computes deficits against the targets, and ranks shortages.
 *
 * Ranking (spec 29): food > torches > wood > fuel, with dependency awareness —
 * torches need fuel, so a low torch *and* low fuel stock restores fuel first.
 * Each restore runs as a scheduler task at BACKGROUND priority, executed with
 * the existing skills (`collect_resource` for wood/fuel, `gather_food` for
 * food, `ensure_torches` for torches). The LLM is never consulted.
 */

/** Stockpile kinds the background loop maintains. */
export type StockpileKind = "wood" | "food" | "fuel" | "torches";

/** The default ranking of shortages (spec 29: 1. food, 2. torches, 3. wood, 4. fuel). */
export const STOCKPILE_PRIORITY_ORDER: readonly StockpileKind[] = ["food", "torches", "wood", "fuel"];

/** Charcoal made per fuel restore when no coal is reachable (~20 logs). */
export const CHARCOAL_BATCH = 16;
/** How far a fuel restore looks for coal ore before smelting charcoal instead. */
export const FUEL_COAL_RADIUS = 32;

/**
 * The charcoal producer (`ensure_item`) ensures a *total*: asking it for the
 * batch alone was a no-op whenever that much charcoal already sat in stock.
 */
export function charcoalTarget(onHand: number, batch: number): number {
  return Math.max(0, onHand) + batch;
}

/** Spec 29 targets; the config `background.stockpiles` section overrides them. */
export const DEFAULT_STOCKPILE_TARGETS: Record<StockpileKind, number> = {
  wood: 64,
  food: 64,
  fuel: 64,
  torches: 64,
};

/**
 * Phase 8 survival floors (spec 5.4: "Food reserve falls below minimum").
 * A stockpile below its floor is a self-maintenance crisis: the restore is
 * escalated to MAINTENANCE priority (80) so it preempts even a foreground
 * user task. The config `background.stockpile_minimums` section overrides
 * them; the crisis check clamps each floor to its target so a misconfigured
 * floor can never make maintenance preempt forever.
 */
export const DEFAULT_STOCKPILE_MINIMUMS: Record<StockpileKind, number> = {
  wood: 16,
  food: 16,
  fuel: 16,
  torches: 8,
};

export interface StockpileLevels {
  wood: number;
  food: number;
  fuel: number;
  torches: number;
}

export interface StockpileDeficit {
  kind: StockpileKind;
  target: number;
  /** Stockpile level measured at check time. */
  current: number;
  /** Missing items (target - current, floored at zero). */
  deficit: number;
  /**
   * True when this deficit was below its survival floor at issue time, so a
   * restore runs at MAINTENANCE priority and may take crisis allowances
   * (short food-hunt quantity, wider night search).
   */
  crisis?: boolean;
  /** Times the restore task has been activated, this run included (resumes count). */
  attempts?: number;
}

export interface StockpileSnapshot {
  levels: StockpileLevels;
  targets: Record<StockpileKind, number>;
  deficits: StockpileDeficit[];
}

export interface StockpileManagerOptions {
  bot: Bot;
  state: AgentState;
  config: MinecraftConfig;
  bus: EventBus;
  storage: StorageRepository;
  scheduler: Scheduler;
  collect: CollectResourceRunner;
  food: GatherFoodRunner;
  torches: EnsureTorchesRunner;
  logger: Logger;
}

/** Active stockpile targets from the config, falling back to spec 29. */
export function stockpileTargets(config: MinecraftConfig): Record<StockpileKind, number> {
  const targets = config.background?.stockpiles ?? DEFAULT_STOCKPILE_TARGETS;
  return {
    wood: targets.wood ?? DEFAULT_STOCKPILE_TARGETS.wood,
    food: targets.food ?? DEFAULT_STOCKPILE_TARGETS.food,
    fuel: targets.fuel ?? DEFAULT_STOCKPILE_TARGETS.fuel,
    torches: targets.torches ?? DEFAULT_STOCKPILE_TARGETS.torches,
  };
}

/** Active stockpile survival floors from the config, falling back to defaults. */
export function stockpileMinimums(config: MinecraftConfig): Record<StockpileKind, number> {
  const minimums = config.background?.stockpile_minimums ?? DEFAULT_STOCKPILE_MINIMUMS;
  return {
    wood: minimums.wood ?? DEFAULT_STOCKPILE_MINIMUMS.wood,
    food: minimums.food ?? DEFAULT_STOCKPILE_MINIMUMS.food,
    fuel: minimums.fuel ?? DEFAULT_STOCKPILE_MINIMUMS.fuel,
    torches: minimums.torches ?? DEFAULT_STOCKPILE_MINIMUMS.torches,
  };
}

/** Short human label for a stockpile kind ("wood" -> "wood stockpile"). */
export function stockpileLabel(kind: StockpileKind): string {
  return `${kind} stockpile`;
}

/** Deficits for every stockpile below its target, in priority order. */
export function computeDeficits(
  levels: StockpileLevels,
  targets: Record<StockpileKind, number>,
): StockpileDeficit[] {
  const deficits: StockpileDeficit[] = [];
  for (const kind of STOCKPILE_PRIORITY_ORDER) {
    const target = targets[kind];
    const current = levels[kind];
    const deficit = Math.max(0, target - current);
    if (deficit > 0) deficits.push({ kind, target, current, deficit });
  }
  return deficits;
}

/**
 * Pick the single most important shortage (spec 29). Dependency awareness:
 * torch maintenance consumes fuel (coal/charcoal), so when both torches and
 * fuel are short, fuel is restored first — otherwise the torch run would
 * simply drain the fuel stockpile again. Everything else follows the
 * priority order.
 */
export function prioritizeDeficit(deficits: readonly StockpileDeficit[]): StockpileDeficit | null {
  if (deficits.length === 0) return null;
  const byKind = new Map(deficits.map((d) => [d.kind, d] as const));
  const torches = byKind.get("torches");
  const fuel = byKind.get("fuel");
  if (torches !== undefined && fuel !== undefined) return fuel;
  return deficits[0] ?? null;
}

/**
 * Deterministic stockpile manager. `check()` measures the levels; the
 * background coordinator decides *when* to maintain; `runMaintenance`
 * executes one shortage as a scheduler task and settles it when the skill
 * finishes.
 */
export class StockpileManager {
  private readonly opts: StockpileManagerOptions;
  private lastSnapshot: StockpileSnapshot | null = null;

  constructor(options: StockpileManagerOptions) {
    this.opts = options;
  }

  /** The most recent measurement (null before the first check). */
  get snapshot(): StockpileSnapshot | null {
    return this.lastSnapshot;
  }

  get targets(): Record<StockpileKind, number> {
    return stockpileTargets(this.opts.config);
  }

  /** True while any restore skill is running (guards overlap with other work). */
  isBusy(): boolean {
    return this.opts.collect.isRunning || this.opts.food.isRunning || this.opts.torches.isRunning;
  }

  /**
   * Measure every stockpile as carried + home-chest stored and emit a
   * `stockpile.checked` event. Opens each registered chest once; a chest
   * that cannot be opened is skipped and re-read on the next pass.
   */
  async check(signal?: AbortSignal): Promise<StockpileSnapshot> {
    const targets = this.targets;
    const carried = itemsSummary(this.opts.bot);
    const stored = await countStoredItems(this.opts.bot, this.opts.state, this.opts.storage, signal);

    let wood = 0;
    let food = 0;
    let fuel = 0;
    let torches = 0;
    this.charcoalOnHand = (carried["charcoal"] ?? 0) + (stored["charcoal"] ?? 0);
    for (const [name, count] of Object.entries(carried)) {
      const bare = bareName(name);
      if (isRawLogItemName(bare)) wood += count;
      else if (FOOD_ITEM_NAMES[bare] === true) food += count;
      else if (bare === "coal" || bare === "charcoal") fuel += count;
      else if (bare === "torch") torches += count;
    }
    for (const [name, count] of Object.entries(stored)) {
      const bare = bareName(name);
      if (isRawLogItemName(bare)) wood += count;
      else if (FOOD_ITEM_NAMES[bare] === true) food += count;
      else if (bare === "coal" || bare === "charcoal") fuel += count;
      else if (bare === "torch") torches += count;
    }

    const levels: StockpileLevels = { wood, food, fuel, torches };
    const snapshot: StockpileSnapshot = {
      levels,
      targets,
      deficits: computeDeficits(levels, targets),
    };
    this.lastSnapshot = snapshot;
    this.opts.bus.emit("stockpile.checked", {
      levels,
      targets,
      deficits: snapshot.deficits,
    });
    // Checks run every 30s; logging unchanged levels each time buries
    // everything else and rotates the journal away within hours.
    const logKey = JSON.stringify([levels, targets]);
    if (logKey !== this.lastLoggedLevels) {
      this.lastLoggedLevels = logKey;
      this.opts.logger.info(
        { levels: { wood, food, fuel, torches }, targets },
        "stockpile check",
      );
    }
    return snapshot;
  }

  /**
   * The single most important shortage, or null when every stockpile is healthy.
   */
  prioritize(snapshot: StockpileSnapshot): StockpileDeficit | null {
    return prioritizeDeficit(snapshot.deficits);
  }

  /**
   * The first stockpile below its survival floor (Phase 8, spec 5.4), or null
   * when everything sits above its floor. Floors are clamped to each
   * stockpile's target so a bad config cannot force permanent preemption.
   */
  crisisDeficit(snapshot: StockpileSnapshot): StockpileDeficit | null {
    const minimums = stockpileMinimums(this.opts.config);
    const targets = snapshot.targets;
    for (const deficit of snapshot.deficits) {
      // Only an empty food supply threatens survival. Low wood, fuel, or
      // torches must never preempt what the owner asked for; they are
      // restored as ordinary background work when the bot is idle.
      if (deficit.kind !== "food") continue;
      const floor = Math.min(minimums[deficit.kind], targets[deficit.kind]);
      if (deficit.current < floor) return deficit;
    }
    return null;
  }

  /**
   * Enqueue a stockpile restore as a scheduler task and claim the slot.
   * Execution and settling belong to the TaskDispatcher, which runs the
   * matching skill with the task's signals (Phase 8). `preempt` escalates a
   * below-floor shortage to MAINTENANCE priority so it displaces foreground
   * work; ordinary restores run at BACKGROUND priority. A preempted food
   * crisis hunts only up to the survival floor, not the full stockpile
   * target: while starving, a short survivable trip beats a long hunt that
   * ends in another death at spawn.
   */
  runMaintenance(deficit: StockpileDeficit, options: { preempt?: boolean } = {}): void {
    const preempt = options.preempt === true;
    const priority = preempt ? TaskPriority.MAINTENANCE : TaskPriority.BACKGROUND;
    let quantity = deficit.deficit;
    if (preempt && deficit.kind === "food") {
      const floor = Math.min(stockpileMinimums(this.opts.config)[deficit.kind], deficit.target);
      quantity = Math.min(deficit.deficit, Math.max(0, floor - deficit.current));
    }
    this.opts.scheduler.enqueue({
      type: "stockpile_maintenance",
      priority,
      source: "background",
      objective: `Restore ${stockpileLabel(deficit.kind)} to ${deficit.target}`,
      parameters: {
        kind: deficit.kind,
        target: deficit.target,
        current: deficit.current,
        deficit: quantity,
        crisis: preempt,
      },
    });
    this.opts.scheduler.claim();
  }

  /**
   * Deterministic restore path per stockpile kind — skills only, no LLM.
   * Public so the TaskDispatcher can run a maintenance task with the task's
   * cooperative signals; the skills deliver into the home chest.
   */
  /** Charcoal producer, wired after construction (ensure_item is built later). */
  private lastLoggedLevels: string | null = null;

  private charcoal: ((quantity: number, signals?: TaskSignals) => Promise<SkillResult>) | null = null;
  /** Carried + stored charcoal at the last check (the producer's target is a total). */
  private charcoalOnHand = 0;

  setCharcoalProducer(producer: (quantity: number, signals?: TaskSignals) => Promise<SkillResult>): void {
    this.charcoal = producer;
  }

  restore(queued: StockpileDeficit, signals?: TaskSignals): Promise<SkillResult> {
    const deficit = this.replan(queued);
    if (deficit.deficit <= 0) {
      this.opts.logger.info({ kind: deficit.kind, current: deficit.current }, "stockpile restore no longer needed; settling");
      return Promise.resolve({ ok: true, status: "completed", message: `${stockpileLabel(deficit.kind)} already at ${deficit.current}` } as SkillResult);
    }
    const options = signals === undefined ? {} : { signals };
    switch (deficit.kind) {
      case "wood":
        // "Wood" is whatever trees grow here, not specifically oak.
        return this.opts.collect.run(dominantNearbyLog(this.opts.bot), deficit.deficit, options);
      case "food":
        // Crisis runs may search past the night cap: the food floor is
        // breached, so the bot's survival depends on finding an animal.
        // gather_food hunts until `quantity` food is *carried*, while the
        // deficit is how many more are needed: passing the deficit alone
        // finished instantly once the bot carried that many, and the crisis
        // check re-queued the same no-op every second ("Done. 8 food on me").
        return this.opts.food.run(countFoodItems(this.opts.bot) + deficit.deficit, {
          ...options,
          expandAtNight: deficit.crisis === true,
        });
      case "fuel":
        // `collect_resource` counts the drop ("coal") and delivers it to the
        // home chest, so the fuel stockpile sees real coal. With no coal in
        // reach, smelt charcoal from logs instead of failing forever.
        // Charcoal comes in batches: each restore that lands one counts as
        // progress, where an all-or-nothing 64 needing 75 logs failed
        // outright and tripped the anti-loop watchdog.
        // A resumed restore skips the coal trip: the far ore run is what kept
        // being preempted (food floor, defense), and starting it over each
        // time never finished. A charcoal batch at the home furnace does.
        if (this.charcoal !== null && (deficit.attempts ?? 1) > 1) return this.charcoalBatch(deficit, "resumed after an interrupted coal run", signals);
        // Coal only close to home: an uncapped search went 150 blocks out
        // and 60 down, then died climbing back with the haul (2026-10-04).
        // Past that, charcoal from the home furnace is the safer fuel.
        return this.opts.collect.run("coal_ore", deficit.deficit, { ...options, maxRadius: this.charcoal === null ? undefined : FUEL_COAL_RADIUS }).then((result) => {
          if (result.ok || this.charcoal === null) return result;
          // Interrupted is not "no coal": falling through started charcoal
          // under the already-paused signal, so it never ran (2026-10-04).
          if (result.status === "interrupted") return result;
          if (result.status === "partial" && (result.data?.gathered ?? 0) > 0) return result;
          return this.charcoalBatch(deficit, result.message, signals);
        });
      case "torches":
        return this.opts.torches.run(deficit.deficit, options);
    }
  }

  /**
   * Re-plan a queued restore from the latest stock check. Its deficit was
   * frozen at enqueue: a food crisis queued at 0 kept hunting 16 more for an
   * hour, 250 blocks out, after bread put the stock over the floor, and the
   * fuel restore behind it never ran (2026-10-04 19:09-20:05). A crisis only
   * restores up to its floor.
   */
  replan(queued: StockpileDeficit): StockpileDeficit {
    const levels = this.lastSnapshot?.levels;
    if (levels === undefined) return queued;
    const current = levels[queued.kind];
    const goal = queued.crisis === true
      ? Math.min(stockpileMinimums(this.opts.config)[queued.kind], queued.target)
      : queued.target;
    return { ...queued, current, deficit: Math.min(queued.deficit, Math.max(0, goal - current)) };
  }

  private charcoalBatch(deficit: StockpileDeficit, reason: string | undefined, signals?: TaskSignals): Promise<SkillResult> {
    const batch = Math.min(deficit.deficit, CHARCOAL_BATCH);
    this.opts.logger.info({ reason, batch }, "fuel: no coal reachable; smelting charcoal instead");
    return this.charcoal!(charcoalTarget(this.charcoalOnHand, batch), signals);
  }
}
