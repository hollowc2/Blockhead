import { logger } from "../logger.js";

/**
 * Anti-loop watchdog — a lightweight generic layer ABOVE individual skills.
 *
 * The bot's high-level actions are chosen repeatedly (background director,
 * deterministic maintenance rails, owner commands), and a hopeless action
 * (unreachable resource, unhealable health, empty world) would otherwise be
 * re-attempted forever. This module fingerprints every action — task type +
 * normalized goal arguments — and tracks the outcome of each settled run.
 * After `maxFailures` failed attempts the action is marked temporarily
 * BLOCKED for `cooldownMs`; the scheduler then holds matching tasks in
 * `TaskStatus.BLOCKED` instead of running them, and the block reason is
 * surfaced to the LLM context so the model picks something else or waits.
 *
 * Deliberately generic: the fingerprint rules live HERE (one module), not in
 * any skill. A new task type works out of the box through the stable-JSON
 * fallback and can gain a precise rule without touching a skill file.
 *
 * Outcome semantics (per settled run):
 *  - completed  -> meaningful success: failure count and any block reset.
 *  - partial    -> meaningful progress: the count is halved (a partial
 *                  collect delivered something), and a block under the
 *                  threshold lifts.
 *  - failed/blocked -> the attempt made no progress: count increments; at
 *                  `maxFailures` the action is blocked.
 *  - interrupted (preemption/pause/cancel) is never recorded — that is the
 *                  scheduler, not the action, stopping.
 *
 * Owner commands: a task with source "user" bypasses the gate and resets the
 * action's failure state — an explicit owner request always runs and can
 * never be pushed into a permanent block by its own failures.
 */

export interface WatchdogPersistence {
  loadAll(): Array<{
    action: string;
    failures: number;
    blockedAt: number | null;
    retryAt: number | null;
    lastReason: string | null;
  }>;
  upsert(state: {
    action: string;
    failures: number;
    blockedAt: number | null;
    retryAt: number | null;
    lastReason: string | null;
  }): void;
  remove(action: string): void;
}

export interface ActionWatchdogOptions {
  /** Failed attempts of the same action before it is blocked. Default 3. */
  maxFailures?: number;
  /** How long a block lasts before a retry is allowed. Default 10 minutes. */
  cooldownMs?: number;
  /** Injectable wall clock (tests advance it to exercise the cooldown). */
  now?: () => number;
  /** Durable action-level state, rehydrated explicitly during startup. */
  persistence?: WatchdogPersistence;
}

/** How one settled run of an action changed its failure state. */
export type AttemptOutcome = "success" | "partial" | "failure";

/** An active block, as consumed by the scheduler gate. */
export interface ActionBlock {
  /** Stable fingerprint of the blocked action ("collect_resource:coal:32"). */
  action: string;
  /** Failure count that triggered the block. */
  failures: number;
  /** Wall clock when the block started. */
  blockedAt: number;
  /** Wall clock when a retry is allowed again. */
  retryAt: number;
  /** Last failure reason observed (e.g. a skill's terminal message). */
  lastReason: string;
}

/** A block as surfaced to the LLM context (chat snapshot / director digest). */
export interface BlockView {
  action: string;
  reason: string;
  retryInSeconds: number;
}

export const DEFAULT_MAX_FAILURES = 3;
export const DEFAULT_COOLDOWN_MS = 10 * 60_000;

/**
 * Stable fingerprint of one high-level action: task type + normalized
 * "goal" arguments. Two tasks with the same fingerprint are the same action
 * for anti-loop purposes: `collect_resource:coal:32`, `build_base:starter`,
 * `go_home`. Quantities are floored and strings trimmed, so equivalent
 * spellings collapse to one identity.
 */
export function actionFingerprint(type: string, parameters: Record<string, unknown> = {}): string {
  const args = goalArguments(type, parameters);
  if (args !== "") return `${type}:${args}`;
  // Parameterless tasks are their own goal; a fixed label makes the
  // deterministic target explicit where the goal isn't just the type name.
  const label = GOAL_LABELS[type];
  return label === undefined ? type : `${type}:${label}`;
}

/**
 * The goal-defining arguments of a task, or "" when the task has none. One
 * switch lives here (the watchdog owns fingerprints; skills stay untouched).
 * Unknown future types fall back to a stable JSON of their scalar
 * parameters, so they still get distinct fingerprints without per-skill code.
 */
function goalArguments(type: string, parameters: Record<string, unknown>): string {
  switch (type) {
    case "collect_resource":
      return `${clean(parameters.resource)}:${quantity(parameters.quantity)}`;
    case "ensure_item":
    case "craft_item":
    case "smelt_item":
      return `${clean(parameters.item)}:${quantity(parameters.quantity)}`;
    case "gather_food":
      return quantity(parameters.quantity);
    case "hunt": {
      const entity = clean(parameters.entity_type);
      return entity === "" ? quantity(parameters.quantity) : `${entity}:${quantity(parameters.quantity)}`;
    }
    case "give_item":
      return `${clean(parameters.player)}:${clean(parameters.item)}:${quantity(parameters.quantity)}`;
    case "store_items":
      return [clean(parameters.filter), clean(parameters.location)].filter((part) => part !== "").join(":");
    case "retrieve_items": {
      const items = Array.isArray(parameters.items) ? parameters.items : [];
      const names = items
        .map((entry) => clean(typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>).item : undefined))
        .filter((part) => part !== "");
      names.sort();
      const location = clean(parameters.location);
      return [...names, location].filter((part) => part !== "").join(":");
    }
    case "travel_to":
      return [parameters.x, parameters.y, parameters.z].map(coord).join(",");
    case "recover_death_items":
    case "death_recovery":
      return numeric(parameters.deathId);
    case "stockpile_maintenance":
      return clean(parameters.kind);
    case "create_storage":
      return clean(parameters.category);
    case "defend_player":
      return clean(parameters.player);
    case "explore":
      // Distance defines the trip's goal; the heading is a clock-rotated
      // fan-out knob, so it must not split one action into many identities.
      return quantity(parameters.distance, 128);
    default:
      return canonicalScalars(parameters);
  }
}

/**
 * Parameterless tasks whose goal deserves a fixed label beyond the bare
 * type name. The base builder's deterministic target is the starter shed.
 */
const GOAL_LABELS: Readonly<Record<string, string>> = {
  build_base: "starter",
};

/** Trimmed string argument, or "" when absent — "coal" and " coal " match. */
function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Normalized quantity: floored, min 1. "32" and 32.0 are the same goal. */
function quantity(value: unknown, fallback = 1): string {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return String(Math.max(1, Math.floor(fallback)));
  return String(Math.max(1, Math.floor(n)));
}

/** Numeric argument (death id), or "" when absent. */
function numeric(value: unknown): string {
  const n = Number(value);
  return Number.isFinite(n) ? String(n) : "";
}

/** Coordinate argument, rounded to whole blocks. */
function coord(value: unknown): string {
  const n = Number(value);
  return Number.isFinite(n) ? String(Math.round(n)) : "";
}

/** Stable JSON of a task's scalar parameters (generic fallback for new types). */
function canonicalScalars(parameters: Record<string, unknown>): string {
  const out: Record<string, string | number | boolean> = {};
  for (const key of Object.keys(parameters).sort()) {
    const value = parameters[key];
    if (typeof value === "string" && value.trim() !== "") out[key] = value.trim();
    else if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    else if (typeof value === "boolean") out[key] = value;
  }
  return Object.keys(out).length === 0 ? "" : JSON.stringify(out);
}

/**
 * Tracks failed attempts per action fingerprint. Instances are cheap and
 * process-lifetime (survives reconnect); blocks expire by wall clock.
 */
export class ActionWatchdog {
  private readonly maxFailures: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly persistence: WatchdogPersistence | undefined;
  /** fingerprint -> consecutive failure count (not counting resets/partials). */
  private readonly failures = new Map<string, number>();
  /** fingerprint -> active block (present only while `retryAt` is in the future). */
  private readonly blocks = new Map<string, ActionBlock>();

  constructor(options: ActionWatchdogOptions = {}) {
    this.maxFailures = options.maxFailures ?? DEFAULT_MAX_FAILURES;
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.now = options.now ?? Date.now;
    this.persistence = options.persistence;
  }

  rehydrate(): void {
    for (const state of this.persistence?.loadAll() ?? []) {
      if (state.failures > 0) this.failures.set(state.action, state.failures);
      if (state.retryAt !== null && state.retryAt > this.now()) {
        this.blocks.set(state.action, {
          action: state.action,
          failures: state.failures,
          blockedAt: state.blockedAt ?? state.retryAt - this.cooldownMs,
          retryAt: state.retryAt,
          lastReason: state.lastReason ?? "",
        });
      } else if (state.retryAt !== null) {
        this.persistence?.remove(state.action);
      }
    }
  }

  private persist(action: string): void {
    if (this.persistence === undefined) return;
    const failures = this.failures.get(action) ?? 0;
    const block = this.blocks.get(action);
    if (failures === 0) this.persistence.remove(action);
    else this.persistence.upsert({ action, failures, blockedAt: block?.blockedAt ?? null, retryAt: block?.retryAt ?? null, lastReason: block?.lastReason ?? null });
  }

  /**
   * Record one settled attempt of `action`. A fresh owner command
   * (`ownerIntent`) resets the count first, so an explicit request never
   * accumulates toward a block on its own.
   */
  record(action: string, outcome: AttemptOutcome, ownerIntent = false, reason = ""): void {
    if (ownerIntent) this.noteOwnerIntent(action);
    if (outcome === "success") {
      this.failures.delete(action);
      if (this.blocks.delete(action)) {
        logger.info({ action }, "anti-loop block cleared by success");
      }
      this.persist(action);
      return;
    }
    if (outcome === "partial") {
      // Meaningful progress: halve the count and lift a block that no longer
      // has enough failures behind it. Progress means the action is not stuck.
      const reduced = Math.floor((this.failures.get(action) ?? 0) / 2);
      if (reduced <= 0) this.failures.delete(action);
      else this.failures.set(action, reduced);
      if (reduced < this.maxFailures) {
        if (this.blocks.delete(action)) {
          logger.info({ action }, "anti-loop block lifted after partial progress");
        }
      }
      this.persist(action);
      return;
    }
    const count = (this.failures.get(action) ?? 0) + 1;
    this.failures.set(action, count);
    if (count >= this.maxFailures && this.blocks.has(action) === false) {
      const blockedAt = this.now();
      this.blocks.set(action, {
        action,
        failures: count,
        blockedAt,
        retryAt: blockedAt + this.cooldownMs,
        lastReason: reason,
      });
      logger.warn({ action, failures: count, cooldownMs: this.cooldownMs }, "action blocked by anti-loop watchdog");
    }
    this.persist(action);
  }

  /** Reset an action's failure state (fresh owner intent, or an owner success). */
  noteOwnerIntent(action: string): void {
    this.failures.delete(action);
    if (this.blocks.delete(action)) {
      logger.info({ action }, "anti-loop block cleared by owner command");
    }
    this.persistence?.remove(action);
  }

  /** The active block for `action`, or null when it may run again. */
  blockFor(action: string): ActionBlock | null {
    const block = this.blocks.get(action);
    if (block === undefined) return null;
    if (block.retryAt <= this.now()) {
      this.blocks.delete(action);
      this.persistence?.remove(action);
      return null;
    }
    return block;
  }

  /** True when `action` must stand down right now. */
  isBlocked(action: string): boolean {
    return this.blockFor(action) !== null;
  }

  /**
   * Every currently active block, newest first by `blockedAt`, formatted for
   * the LLM context (chat state snapshot and the director situation digest).
   */
  activeBlocks(): BlockView[] {
    const now = this.now();
    const views: BlockView[] = [];
    for (const block of [...this.blocks.values()].sort((a, b) => b.blockedAt - a.blockedAt)) {
      if (block.retryAt <= now) {
        this.blocks.delete(block.action);
        this.persistence?.remove(block.action);
        continue;
      }
      views.push({
        action: block.action,
        reason:
          block.lastReason === ""
            ? `${block.failures} failed attempts; temporarily blocked until ${new Date(block.retryAt).toISOString()}`
            : `${block.failures} failed attempts (${block.lastReason}); temporarily blocked until ${new Date(block.retryAt).toISOString()}`,
        retryInSeconds: Math.max(0, Math.ceil((block.retryAt - now) / 1000)),
      });
    }
    return views;
  }

  /** Failure count behind an action (0 when clean) — diagnostics/tests. */
  failureCount(action: string): number {
    return this.failures.get(action) ?? 0;
  }
}