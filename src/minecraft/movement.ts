import { createRequire } from "node:module";
import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import type * as Pathfinder from "mineflayer-pathfinder";
import { logger } from "../logger.js";
import { registerWorldActionTeardown, requireWorldActionLease, throwIfAborted } from "../agent/world-actions.js";

// Node's cjs-module-lexer fails to detect the `goals` named export of this CJS
// package, so named ESM imports would resolve to undefined at runtime.
// Require() it directly; the cast re-checks the shape against the published types.
const require = createRequire(import.meta.url);
const pathfinder = require("mineflayer-pathfinder") as {
  Movements: new (bot: Bot) => Pathfinder.Movements;
  goals: {
    GoalNear: new (x: number, y: number, z: number, range: number) => Pathfinder.goals.GoalNear;
    GoalFollow: new (entity: Entity, range: number) => Pathfinder.goals.GoalFollow;
  };
};
const { goals, Movements } = pathfinder;

/** A block-space world coordinate. */
export interface Location {
  x: number;
  y: number;
  z: number;
}

/** Home location including the dimension it lives in. */
export interface HomeLocation extends Location {
  dimension: string;
}

/** Distance (in blocks) at which a destination counts as reached. */
export const ARRIVE_RANGE = 2;
/** Distance kept from the player while following. */
const FOLLOW_RANGE = 3;

export type MovementStatus =
  | "started"
  | "done"
  | "already_there"
  | "not_ready"
  | "player_not_found"
  | "wrong_dimension";

export type MovementResult =
  | { ok: true; status: "started" | "done" | "already_there" }
  | { ok: false; status: "not_ready" | "player_not_found" | "wrong_dimension" };

const movementsByBot = new WeakMap<Bot, Pathfinder.Movements>();
interface DynamicGoalOwnership { generation: number; owner: string; removeAbort: () => void; removeTeardown: () => void; }
const dynamicGoals = new WeakMap<Bot, DynamicGoalOwnership>();
const dynamicGoalGenerations = new WeakMap<Bot, number>();

function ownsDynamicGoal(bot: Bot, ownership: DynamicGoalOwnership): boolean {
  return dynamicGoals.get(bot) === ownership && dynamicGoalGenerations.get(bot) === ownership.generation;
}

function invalidateDynamicGoal(bot: Bot): void {
  const current = dynamicGoals.get(bot);
  if (!current) return;
  current.removeAbort();
  current.removeTeardown();
  dynamicGoals.delete(bot);
}

function installDynamicGoal(bot: Bot, owner: string, signal: AbortSignal, goal: Pathfinder.goals.Goal): void {
  invalidateDynamicGoal(bot);
  const generation = (dynamicGoalGenerations.get(bot) ?? 0) + 1;
  dynamicGoalGenerations.set(bot, generation);
  const ownership: DynamicGoalOwnership = { generation, owner, removeAbort: () => undefined, removeTeardown: () => undefined };
  const stopIfOwned = (): void => {
    if (!ownsDynamicGoal(bot, ownership)) return;
    invalidateDynamicGoal(bot);
    try { bot.pathfinder.stop(); } catch { /* disconnect cleanup */ }
    try { bot.pathfinder.setGoal(null); } catch { /* disconnect cleanup */ }
  };
  ownership.removeAbort = () => signal.removeEventListener("abort", stopIfOwned);
  ownership.removeTeardown = registerWorldActionTeardown(bot, () => {
    if (ownsDynamicGoal(bot, ownership)) invalidateDynamicGoal(bot);
  });
  signal.addEventListener("abort", stopIfOwned, { once: true });
  throwIfAborted(signal);
  bot.pathfinder.setGoal(goal, true);
  dynamicGoals.set(bot, ownership);
}

/**
 * Lazy pathfinder setup. `Movements` reads `bot.registry`, which is only
 * populated after login, so it is created on first use rather than at boot.
 */
function getMovements(bot: Bot): Pathfinder.Movements {
  let movements = movementsByBot.get(bot);
  if (!movements) {
    movements = new Movements(bot);
    bot.pathfinder.setMovements(movements);
    // collectblock builds its own Movements in its constructor and calls
    // `setMovements` on every collect(), clobbering this config. Point it at
    // the shared instance so digging costs/avoid rules stay consistent.
    try {
      bot.collectBlock.movements = movements;
    } catch {
      // collectBlock plugin absent; nothing to sync.
    }
    movementsByBot.set(bot, movements);
    logger.debug("pathfinder movements initialized");
  }
  return movements;
}

function getPlayerEntity(bot: Bot, playerName: string): Entity | null {
  // `Player.entity` is typed non-null but is absent until the player is
  // within render distance of the bot.
  return bot.players[playerName]?.entity ?? null;
}

/** Start a one-shot pathfinder goal and return its settlement promise.
 *
 * This deliberately does not detach the Mineflayer promise. Callers that own
 * a world lease must keep awaiting this promise so a replacement action cannot
 * overlap a still-running pathfinder operation.
 */
async function startGoto(bot: Bot, goal: Pathfinder.goals.Goal, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  const removeAbort = stopOnAbort(bot, signal);
  try {
    await bot.pathfinder.goto(goal);
  } catch (err) {
    logger.debug({ err: String(err) }, "movement goal ended");
    throw err;
  } finally {
    removeAbort();
  }
}

function stopOnAbort(bot: Bot, signal?: AbortSignal): () => void {
  if (!signal) return () => undefined;
  const stop = (): void => { try { bot.pathfinder.stop(); } catch { /* disconnect cleanup */ } };
  if (signal.aborted) stop();
  else signal.addEventListener("abort", stop, { once: true });
  return () => signal.removeEventListener("abort", stop);
}

/** Walk to a player's current position, then stop. */
export async function comeToPlayer(bot: Bot, playerName: string, signal?: AbortSignal): Promise<MovementResult> {
  const lease = requireWorldActionLease(signal);
  signal ??= lease.signal;
  const self: Entity | null = bot.entity;
  if (!self) return { ok: false, status: "not_ready" };
  getMovements(bot);

  const target = getPlayerEntity(bot, playerName);
  if (!target) return { ok: false, status: "player_not_found" };

  const p = target.position;
  const here = self.position;
  if (Math.hypot(here.x - p.x, here.y - p.y, here.z - p.z) <= ARRIVE_RANGE) {
    return { ok: true, status: "already_there" };
  }

  await startGoto(bot, new goals.GoalNear(p.x, p.y, p.z, ARRIVE_RANGE), signal);
  return { ok: true, status: "done" };
}

/** Keep within follow range of a player, re-pathing as they move. */
export async function followPlayer(bot: Bot, playerName: string, signal?: AbortSignal): Promise<MovementResult> {
  const lease = requireWorldActionLease(signal);
  signal ??= lease.signal;
  const self: Entity | null = bot.entity;
  if (!self) return { ok: false, status: "not_ready" };
  getMovements(bot);

  const target = getPlayerEntity(bot, playerName);
  if (!target) return { ok: false, status: "player_not_found" };

  // Dynamic goal: pathfinder re-computes the path as the target moves.
  throwIfAborted(signal);
  installDynamicGoal(bot, lease.owner, signal, new goals.GoalFollow(target, FOLLOW_RANGE));
  return { ok: true, status: "started" };
}

/** Cancel any active movement goal, including a follow. */
export function stopFollowing(bot: Bot, signal?: AbortSignal): MovementResult {
  const lease = requireWorldActionLease(signal);
  signal ??= lease.signal;
  throwIfAborted(signal);
  invalidateDynamicGoal(bot);
  bot.pathfinder.stop();
  bot.pathfinder.setGoal(null);
  return { ok: true, status: "done" };
}

/** Stop in place wherever the bot currently is. */
export function waitHere(bot: Bot, signal?: AbortSignal): MovementResult {
  const lease = requireWorldActionLease(signal);
  signal ??= lease.signal;
  throwIfAborted(signal);
  invalidateDynamicGoal(bot);
  bot.pathfinder.stop();
  bot.pathfinder.setGoal(null);
  return { ok: true, status: "done" };
}

/** Navigate to the configured home location. */
export async function goHome(bot: Bot, home: HomeLocation, signal?: AbortSignal): Promise<MovementResult> {
  const lease = requireWorldActionLease(signal);
  signal ??= lease.signal;
  const self: Entity | null = bot.entity;
  if (!self) return { ok: false, status: "not_ready" };
  getMovements(bot);

  const homeDimension = (home.dimension ?? "").replace(/^minecraft:/, "");
  const currentDimension = (bot.game.dimension ?? "").replace(/^minecraft:/, "");
  if (currentDimension !== homeDimension) {
    return { ok: false, status: "wrong_dimension" };
  }

  const p = self.position;
  if (Math.hypot(p.x - home.x, p.y - home.y, p.z - home.z) <= ARRIVE_RANGE) {
    return { ok: true, status: "already_there" };
  }

  await startGoto(bot, new goals.GoalNear(home.x, home.y, home.z, ARRIVE_RANGE), signal);
  return { ok: true, status: "done" };
}

/** Navigate to an arbitrary location in the current dimension. */
export async function travelTo(bot: Bot, location: Location, signal?: AbortSignal): Promise<MovementResult> {
  const lease = requireWorldActionLease(signal);
  signal ??= lease.signal;
  const self: Entity | null = bot.entity;
  if (!self) return { ok: false, status: "not_ready" };
  getMovements(bot);

  const p = self.position;
  if (Math.hypot(p.x - location.x, p.y - location.y, p.z - location.z) <= ARRIVE_RANGE) {
    return { ok: true, status: "already_there" };
  }

  await startGoto(bot, new goals.GoalNear(location.x, location.y, location.z, ARRIVE_RANGE), signal);
  return { ok: true, status: "done" };
}

export type TravelWaitStatus =
  | "arrived"
  | "already_there"
  | "not_ready"
  | "wrong_dimension"
  | "timed_out"
  | "aborted"
  | "failed";

export type TravelWaitResult =
  | { status: "arrived" | "already_there" | "not_ready" | "wrong_dimension" | "timed_out" | "aborted" }
  | { status: "failed"; error: string };

export interface TravelWaitOptions {
  /** Expected dimension; a mismatch aborts before any movement starts. */
  dimension?: string;
  /** Wall-clock budget for one trip, in milliseconds. */
  timeoutMs?: number;
  /**
   * Arrival tolerance in blocks (default 2). Pass `0` to land in the exact
   * cell (used by dig-trench primitives that advance one block at a time).
   */
  range?: number;
  /**
   * Polled every ~250ms during the trip (Phase 8 cooperative interrupts).
   * When it returns true the trip resolves `"aborted"` and the pathfinder
   * goal is cancelled, so a preempted skill stops within a quarter second
   * instead of waiting out the travel timeout.
   */
  shouldAbort?: () => boolean;
  signal?: AbortSignal;
}

const DEFAULT_TRAVEL_TIMEOUT_MS = 120_000;

/** Keep long home routes from turning into one expensive, fragile A* search. */
const HOME_LEG_LENGTH = 48;

/** How often the travel loop re-checks `shouldAbort`. */
const ABORT_POLL_MS = 250;
/** Do not hold the world-action lease forever if pathfinder ignores stop(). */
const TRIP_SETTLE_GRACE_MS = 2_000;

/**
 * Race a pathfinder trip against the wall-clock timeout and the cooperative
 * abort probe. Used by both travel helpers so their interrupt behavior is
 * identical.
 */
export async function raceTrip(
  bot: Bot,
  trip: Promise<TravelWaitResult>,
  options: TravelWaitOptions,
): Promise<TravelWaitResult> {
  const lease = requireWorldActionLease(options.signal);
  const signal = options.signal ?? lease.signal;
  const { promise: nap, resolve: resolveNap } = Promise.withResolvers<TravelWaitResult>();
  const removeAbort = stopOnAbort(bot, signal);
  const poll = setInterval(() => {
    if (options.signal?.aborted || options.shouldAbort?.() === true) resolveNap({ status: "aborted" });
  }, ABORT_POLL_MS);
  const timer = setTimeout(
    () => resolveNap({ status: "timed_out" }),
    options.timeoutMs ?? DEFAULT_TRAVEL_TIMEOUT_MS,
  );

  try {
    if (signal.aborted) return { status: "aborted" };
    const winner = await Promise.race([trip, nap]);
    if (winner.status === "timed_out" || winner.status === "aborted") {
      bot.pathfinder.stop();
      // Stopping the pathfinder is only a cancellation request. Mineflayer's
      // goto promise may settle later. Give it a short grace period, but do
      // not let a broken/stale pathfinder hold the scheduler lease forever.
      await Promise.race([
        trip.catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, TRIP_SETTLE_GRACE_MS)),
      ]);
    }
    return winner;
  } finally {
    clearInterval(poll);
    clearTimeout(timer);
    removeAbort();
  }
}

/**
 * Walk to the home X/Z column and await arrival. Unlike `travelAndWait`,
 * the goal Y is the bot's OWN standing altitude, not the stored home Y:
 * home is anchored by its X/Z (the protected-region centre), while the
 * nominal Y can be buried under terrain or sit on an unreachable ledge.
 * Arrival is judged on horizontal distance; the caller re-snaps the
 * persisted home Y to the real ground once the bot is on the column.
 */
export async function travelHomeAndWait(bot: Bot, home: HomeLocation, options: TravelWaitOptions = {}): Promise<TravelWaitResult> {
  const lease = requireWorldActionLease(options.signal);
  const signal = options.signal ?? lease.signal;
  const self: Entity | null = bot.entity;
  if (!self) return { status: "not_ready" };
  if (options.dimension) {
    const current = (bot.game.dimension ?? "").replace(/^minecraft:/, "");
    const expected = options.dimension.replace(/^minecraft:/, "");
    if (current !== expected) return { status: "wrong_dimension" };
  }
  if (!bot.registry) return { status: "not_ready" };
  if (signal.aborted) return { status: "aborted" };
  getMovements(bot);
  const range = options.range ?? ARRIVE_RANGE;

  const p = self.position;
  const initialDistance = Math.hypot(p.x - home.x, p.z - home.z);
  if (initialDistance <= range) {
    return { status: "already_there" };
  }

  // A long GoalNear can make mineflayer-pathfinder spend the entire timeout
  // planning through unloaded or difficult terrain. Break it into bounded
  // horizontal legs; refresh Y after every leg because the ground elevation
  // may change substantially on the way home.
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TRAVEL_TIMEOUT_MS);
  let distance = initialDistance;
  while (distance > range) {
    if (signal.aborted || options.shouldAbort?.() === true) return { status: "aborted" };
    const current = bot.entity;
    if (!current) return { status: "not_ready" };
    const leg = Math.min(HOME_LEG_LENGTH, distance);
    const fraction = leg / distance;
    const goal: Location = {
      x: current.position.x + (home.x - current.position.x) * fraction,
      y: Math.floor(current.position.y),
      z: current.position.z + (home.z - current.position.z) * fraction,
    };
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { status: "timed_out" };
    const trip = bot.pathfinder
      .goto(new goals.GoalNear(goal.x, goal.y, goal.z, Math.min(range, 3)))
      .then(() => ({ status: "arrived" } as const), (err: unknown) => ({ status: "failed" as const, error: String(err) }));
    const result = await raceTrip(bot, trip, { ...options, timeoutMs: remaining, signal });
    if (result.status !== "arrived" && result.status !== "already_there") return result;
    const after = bot.entity;
    if (!after) return { status: "not_ready" };
    distance = Math.hypot(after.position.x - home.x, after.position.z - home.z);
  }
  return { status: "arrived" };
}

/**
 * Walk to `location` and await arrival. Unlike `travelTo` (fire-and-forget),
 * this resolves when the pathfinder goal completes, times out, or fails —
 * the blocking primitive for skills that must be *somewhere* before acting.
 */
export async function travelAndWait(bot: Bot, location: Location, options: TravelWaitOptions = {}): Promise<TravelWaitResult> {
  const lease = requireWorldActionLease(options.signal);
  const signal = options.signal ?? lease.signal;
  const self: Entity | null = bot.entity;
  if (!self) return { status: "not_ready" };
  if (options.dimension) {
    const current = (bot.game.dimension ?? "").replace(/^minecraft:/, "");
    const expected = options.dimension.replace(/^minecraft:/, "");
    if (current !== expected) return { status: "wrong_dimension" };
  }
  if (!bot.registry) return { status: "not_ready" };
  if (signal.aborted) return { status: "aborted" };
  getMovements(bot);
  const range = options.range ?? ARRIVE_RANGE;

  const p = self.position;
  if (Math.hypot(p.x - location.x, p.y - location.y, p.z - location.z) <= range) {
    return { status: "already_there" };
  }

  const trip = bot.pathfinder
    .goto(new goals.GoalNear(location.x, location.y, location.z, range))
    .then(() => ({ status: "arrived" } as const), (err: unknown) => ({ status: "failed" as const, error: String(err) }));
  return raceTrip(bot, trip, { ...options, signal });
}
