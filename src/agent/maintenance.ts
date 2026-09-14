import type { Bot } from "mineflayer";
import type { Logger } from "pino";
import type { MinecraftConfig } from "../config/schema.js";
import type { EventBus } from "../events/bus.js";
import { bareName, isRawLogItemName, itemsSummary } from "../minecraft/inventory.js";
import { countStoredItems } from "../minecraft/containers.js";
import type { StorageRepository } from "../memory/storage.js";
import type { Scheduler } from "./scheduler.js";
import type { TaskSignals } from "./scheduler.js";
import { TaskPriority } from "./task.js";
import type { AgentState } from "./state.js";
import type { CollectResourceRunner } from "../skills/collect-resource.js";
import type { EnsureTorchesRunner } from "../skills/ensure-torches.js";
import type { GatherFoodRunner } from "../skills/gather-food.js";
import type { SkillResult } from "../skills/skill-library.js";
import { FOOD_ITEM_NAMES } from "../skills/gather-food.js";

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
  async check(): Promise<StockpileSnapshot> {
    const targets = this.targets;
    const carried = itemsSummary(this.opts.bot);
    const stored = await countStoredItems(this.opts.bot, this.opts.state, this.opts.storage);

    let wood = 0;
    let food = 0;
    let fuel = 0;
    let torches = 0;
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
    this.opts.logger.info(
      { levels: { wood, food, fuel, torches }, targets },
      "stockpile check",
    );
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
  restore(deficit: StockpileDeficit, signals?: TaskSignals): Promise<SkillResult> {
    const options = signals === undefined ? {} : { signals };
    switch (deficit.kind) {
      case "wood":
        return this.opts.collect.run("oak_log", deficit.deficit, options);
      case "food":
        // Crisis runs may search past the night cap: the food floor is
        // breached, so the bot's survival depends on finding an animal.
        return this.opts.food.run(deficit.deficit, {
          ...options,
          expandAtNight: deficit.crisis === true,
        });
      case "fuel":
        // `collect_resource` counts the drop ("coal") and delivers it to the
        // home chest, so the fuel stockpile sees real coal.
        return this.opts.collect.run("coal_ore", deficit.deficit, options);
      case "torches":
        return this.opts.torches.run(deficit.deficit, options);
    }
  }
}