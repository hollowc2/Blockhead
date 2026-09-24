import { createRequire } from "node:module";
import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import type * as Pathfinder from "mineflayer-pathfinder";
import { Vec3 } from "vec3";
import { logger } from "../logger.js";
import { registerWorldActionTeardown, requireWorldActionLease, throwIfAborted } from "../agent/world-actions.js";
import { enableCreativeFlight, isCreativeMode } from "./mode.js";

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
/** GoalNear can settle a fraction outside the nominal horizontal radius. */
// Entity coordinates are block-centred (.5) while configured anchors are
// commonly integer block coordinates. A bot at (-43.5, 0.5) relative to
// home (-46, 0) is 2.55 blocks away even though GoalNear(2) considers its
// occupied block within range. Cover that coordinate convention explicitly.
const HOME_ARRIVAL_GRACE = 0.75;
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
function getMovements(bot: Bot): Pathfinder.Movements | null {
  // Movements reads `bot.registry`, which is only populated after login (and
  // absent from minimal test mocks). Without it there is nothing to build;
  // callers must tolerate a null return (e.g. during early boot or cleanup).
  if ((bot as { registry?: unknown }).registry === undefined) return null;
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

/** Temporarily control whether pathfinder/collectblock may alter terrain. */
export async function withPathfinderDigging<T>(bot: Bot, allowDig: boolean, action: () => Promise<T>): Promise<T> {
  const movements = getMovements(bot);
  const previous = movements?.canDig;
  if (movements !== null) movements.canDig = allowDig;
  try {
    return await action();
  } finally {
    // A timeout can rebuild Movements; restore the live object as well as the
    // one captured above so the policy cannot leak into later work.
    if (movements !== null && previous !== undefined) movements.canDig = previous;
    const current = getMovements(bot);
    if (current !== null && previous !== undefined) current.canDig = previous;
  }
}

/**
 * Force-reinitialize the pathfinder after a stall or timeout. Stale internal
 * state (wedged A*, a never-settling goal, a corrupted Movements object) can
 * persist across task boundaries and make every subsequent trip fail
 * identically. Clearing the cache and rebuilding Movements gives the next
 * route a clean start.
 */
function resetPathfinder(bot: Bot): void {
  try { invalidateDynamicGoal(bot); } catch { /* disconnect cleanup */ }
  try { bot.pathfinder.stop(); } catch { /* disconnect cleanup */ }
  try { bot.pathfinder.setGoal(null); } catch { /* disconnect cleanup */ }
  movementsByBot.delete(bot);
  logger.warn("pathfinder forcefully reset after stall/timeout");
  // Rebuild fresh movements so the next trip starts clean.
  getMovements(bot);
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

/**
 * Fallback movement when the pathfinder is wedged: turn to face a target
 * position and walk forward for up to `budgetMs`, periodically polling
 * whether the bot is getting closer. When forward progress stalls, the
 * bot punches through soft blocks in front of it (dirt, sand, gravel,
 * grass, leaves, wood, etc.) so it can escape small terrain pockets.
 * Returns true when the bot reaches the destination (within `range`),
 * false when the budget runs out.
 */
export async function walkToward(
  bot: Bot,
  destination: Location,
  options: { range?: number; timeoutMs?: number; signal?: AbortSignal; allowDig?: boolean } = {},
): Promise<{ arrived: boolean; distance: number }> {
  const range = options.range ?? ARRIVE_RANGE;
  const deadline = Date.now() + (options.timeoutMs ?? 60_000);
  const self = bot.entity;
  if (self === null) return { arrived: false, distance: -1 };

  bot.clearControlStates();
  let arrived = false;
  let lastDistance = self.position.distanceTo(new Vec3(destination.x, destination.y, destination.z));
  let stuckTicks = 0;
  let lastDigAt = 0;
  let lastStrafeAt = 0;
  let strafeSide = false;
  let equippedTool = false;

  const destinationVec = new Vec3(destination.x, destination.y, destination.z);

  // Pick the best tool the bot carries for a block type.
  const equipBestForDig = (block: import("prismarine-block").Block): void => {
    if (equippedTool) return;
    const items = bot.inventory?.items() ?? [];
    const name = block.name.replace(/^minecraft:/, "");
    const want = name === "stone" || name === "cobblestone" ? "pickaxe"
               : name.includes("_log") || name.includes("_wood") ? "axe"
               : "shovel";
    let best: import("prismarine-item").Item | null = null;
    let bestTier = 0;
    for (const item of items) {
      const itemName = item.name.replace(/^minecraft:/, "");
      const tier = itemName.includes("diamond_") ? 4 : itemName.includes("iron_") ? 3 : itemName.includes("stone_") ? 2 : itemName.includes("wooden_") ? 1 : 0;
      if (itemName.includes(want) && tier > bestTier) { best = item; bestTier = tier; }
    }
    if (best !== null) {
      try { bot.equip(best, "hand"); equippedTool = true; } catch { /* ok */ }
    }
  };

  // Blocks the bot is allowed to punch through during emergency movement.
  const isDiggable = (block: import("prismarine-block").Block | null): boolean => {
    if (block === null || block.boundingBox !== "block") return false;
    const name = block.name.replace(/^minecraft:/, "");
    if (name === "bedrock" || name === "obsidian" || name === "water" || name === "lava") return false;
    // Never dig placed chests, furnaces, crafting tables, or beds at home.
    if (name === "chest" || name === "trapped_chest" || name === "furnace" || name === "lit_furnace"
      || name === "crafting_table" || name.endsWith("_bed")) return false;
    return block.hardness !== undefined && block.hardness >= 0;
  };

  try {
    while (Date.now() < deadline) {
      if (options.signal?.aborted) break;
      const current = bot.entity;
      if (current === null) break;

      const distance = current.position.distanceTo(destinationVec);
      if (distance <= range) { arrived = true; break; }

      // If we are not making progress, try to clear obstacles.
      if (distance >= lastDistance - 0.5) {
        stuckTicks += 1;

        // Every few stuck ticks, try strafing side to side to get around
        // obstacles the digger can't reach.
        if (stuckTicks >= 4 && stuckTicks % 3 === 0) {
          strafeSide = !strafeSide;
          const now = Date.now();
          if (now - lastStrafeAt > 800) {
            lastStrafeAt = now;
            bot.setControlState(strafeSide ? "left" : "right", true);
            await new Promise<void>((resolve) => setTimeout(resolve, 600));
            bot.setControlState(strafeSide ? "left" : "right", false);
          }
        }

        // Check blocks directly ahead (toward destination) at foot and head level.
        if (stuckTicks >= 2 && options.allowDig !== false) {
          const footY = Math.floor(current.position.y);
          const headY = footY + 1;
          const feet = current.position.floored();

          // Compute the direction toward the goal and sort offsets so
          // the blocks closest to the goal are mined first.
          const towardX = destinationVec.x - current.position.x;
          const towardZ = destinationVec.z - current.position.z;
          const scoreOffset = (dx: number, dz: number): number =>
            dx * towardX + dz * towardZ; // dot product with goal direction

          const offsets: [number, number][] = ([
            [1, 0], [-1, 0], [0, 1], [0, -1],
            [1, 1], [1, -1], [-1, 1], [-1, -1],
          ] as [number, number][]).sort((a, b) => scoreOffset(b[0], b[1]) - scoreOffset(a[0], a[1]));

          let dug = false;
          for (const [dx, dz] of offsets) {
            if (dug) break;
            for (const y of [footY, headY]) {
              const pos = new Vec3(feet.x + dx, y, feet.z + dz);
              const block = bot.blockAt(pos);
              if (block === null || !isDiggable(block)) continue;
              try {
                const now = Date.now();
                if (now - lastDigAt < 300) continue;
                lastDigAt = now;
                equipBestForDig(block);
                logger.warn({ at: pos, name: block.name, distance: Number(distance.toFixed(1)), stuckTicks }, "walkToward clearing obstacle");
                await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true);
                await bot.dig(block, true);
                dug = true;
                stuckTicks = 0;
              } catch (err) {
                logger.warn({ at: pos, name: block.name, err: String(err) }, "walkToward dig failed");
              }
              if (dug) break;
            }
          }

          if (!dug && stuckTicks % 20 === 0) {
            logger.warn({ position: current.position, distance: Number(distance.toFixed(1)), stuckTicks }, "walkToward stalled, no diggable blocks found in adjacency");
          }

          // Much more patient — give the bot time to mine through obstacles.
          if (stuckTicks > 240) {
            logger.warn({ position: current.position, stuckTicks }, "walkToward giving up after sustained stall");
            break;
          }
        }
      } else {
        stuckTicks = 0;
        lastDistance = distance;
      }

      // Re-aim toward the destination and walk forward.
      await bot.lookAt(destinationVec.offset(0, 1, 0), false);
      bot.setControlState("forward", true);
      bot.setControlState("jump", true); // helps with small obstacles

      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 250);
        const abort = (): void => { clearTimeout(timer); resolve(); };
        options.signal?.addEventListener("abort", abort, { once: true });
      });
    }
  } finally {
    bot.clearControlStates();
  }

  const final = bot.entity;
  const finalDistance = final === null ? -1 : final.position.distanceTo(destinationVec);
  return { arrived, distance: finalDistance };
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

// One block per server tick is still comfortably below vanilla's movement
// validation threshold, and halves the dead travel time between build cells.
const CREATIVE_FLIGHT_STEP = 1;
const CREATIVE_FLIGHT_TICK_MS = 50;
const CREATIVE_FLIGHT_REACH = 0.75;

type ClientPositionBot = Bot & {
  _client?: { write: (packet: string, data: Record<string, unknown>) => void };
};

/**
 * Move a creative bot without Mineflayer's creative.flyTo promise.
 *
 * creative.flyTo optimistically mutates bot.entity.position and waits for a
 * `move` event. Mineflayer physics does not emit/send that event while the
 * current block is unloaded, which is common in void-like or deep builds.
 * Send the same position packets explicitly and use the observed local
 * entity position only as the bounded step/arrival state. No synthetic event
 * is used to settle the operation.
 */
export async function creativeFlyToAndWait(
  bot: Bot,
  location: Location,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<TravelWaitResult> {
  const lease = requireWorldActionLease(options.signal);
  const signal = options.signal ?? lease.signal;
  const self = bot.entity;
  const client = (bot as ClientPositionBot)._client;
  if (!self || client === undefined) return { status: "not_ready" };
  if (signal.aborted) return { status: "aborted" };

  enableCreativeFlight(bot);
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TRAVEL_TIMEOUT_MS);
  const destination = new Vec3(location.x, location.y, location.z);
  let commanded = self.position.clone();
  const stop = (): void => bot.creative?.stopFlying?.();
  try {
    while (true) {
      if (signal.aborted) return { status: "aborted" };
      const current = bot.entity;
      if (!current) return { status: "not_ready" };
      const distance = commanded.distanceTo(destination);
      if (distance <= CREATIVE_FLIGHT_REACH) {
        // Publish the exact endpoint once more immediately before the caller
        // performs its reach check; a server correction may have replaced the
        // entity position during the final flight tick.
        current.position = destination.clone();
        const packet = bot.supportFeature("positionPacketHasBitflags")
          ? { x: destination.x, y: destination.y, z: destination.z, flags: { onGround: false, hasHorizontalCollision: false } }
          : { x: destination.x, y: destination.y, z: destination.z, onGround: false };
        client.write("position", packet);
        return { status: "arrived" };
      }
      if (Date.now() >= deadline) return { status: "timed_out" };

      const step = Math.min(CREATIVE_FLIGHT_STEP, distance);
      const next = commanded.plus(destination.minus(commanded).scaled(step / distance));
      commanded = next;
      current.position = next;
      const packet = bot.supportFeature("positionPacketHasBitflags")
        ? { x: next.x, y: next.y, z: next.z, flags: { onGround: false, hasHorizontalCollision: false } }
        : { x: next.x, y: next.y, z: next.z, onGround: false };
      client.write("position", packet);

      await new Promise<void>((resolve) => {
        let timer: NodeJS.Timeout;
        const abort = (): void => { clearTimeout(timer); signal.removeEventListener("abort", abort); resolve(); };
        timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, CREATIVE_FLIGHT_TICK_MS);
        signal.addEventListener("abort", abort, { once: true });
      });
    }
  } finally {
    stop();
  }
}

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
  /** Disable all pathfinder and fallback obstacle digging for safe exploration. */
  allowDig?: boolean;
}

const DEFAULT_TRAVEL_TIMEOUT_MS = 120_000;

/** Keep long home routes from turning into one expensive, fragile A* search. */
const HOME_LEG_LENGTH = 48;
/** Give each route leg a bounded budget so one bad leg cannot consume the trip. */
const HOME_LEG_TIMEOUT_MS = 60_000;
/** General travel also uses leg decomposition above this threshold. */
const TRAVEL_LEG_LENGTH = 48;
const TRAVEL_LEG_TIMEOUT_MS = 60_000;
/** A buried bot should use the surface as a transit corridor when possible. */
const SURFACE_SCAN_UP = 128;
const SURFACE_SCAN_DOWN = 32;

/** How often the travel loop re-checks `shouldAbort`. */
const ABORT_POLL_MS = 250;
/** Do not hold the world-action lease forever if pathfinder ignores stop(). */
const TRIP_SETTLE_GRACE_MS = 2_000;
/** If the pathfinder stays active this long without settling, force-reinitialize it. */
const PATHFINDER_STALL_MS = 30_000;
/** How often the stall detector polls `bot.pathfinder.goal` / `isMoving`. */
const PATHFINDER_STALL_POLL_MS = 5_000;

/**
 * Find a plausible standing Y in the currently loaded column. This is only a
 * route hint: unloaded columns return the fallback and the pathfinder remains
 * responsible for validating the actual path.
 */
function surfaceStandingY(bot: Bot, x: number, z: number, fallback: number): number {
  const currentY = Math.floor(bot.entity?.position.y ?? fallback);
  if (typeof bot.blockAt !== "function") return currentY;
  // The bot's own standing cell is ground truth for a reachable surface.
  // A wide sky-window scan can otherwise pick an overhang or a canopy ridge
  // many blocks above the bot (e.g. a ledge at y+16), producing route goals
  // the pathfinder cannot honor from the bot's actual altitude.
  const self = bot.entity;
  if (self !== null) {
    const feet = self.position.floored();
    if (Math.abs(feet.x - x) <= 4 && Math.abs(feet.z - z) <= 4) {
      const below = bot.blockAt(new Vec3(feet.x, feet.y - 1, feet.z));
      const at = bot.blockAt(new Vec3(feet.x, feet.y, feet.z));
      if (at?.boundingBox !== "block" && below?.boundingBox === "block") return feet.y;
    }
  }
  const minY = currentY - SURFACE_SCAN_DOWN;
  const maxY = currentY + SURFACE_SCAN_UP;
  // Prefer the standing level nearest the bot's own altitude: the bot's Y
  // is reachable by definition, while "highest solid with air above" can be
  // an overhang or canopy ridge the pathfinder cannot climb to. Ties break
  // toward the higher level (a short climb beats a long drop).
  let best: { y: number; dist: number } | null = null;
  for (let y = minY; y <= maxY; y++) {
    const block = bot.blockAt(new Vec3(Math.floor(x), y, Math.floor(z)));
    if (block?.boundingBox !== "block") continue;
    const above = bot.blockAt(new Vec3(Math.floor(x), y + 1, Math.floor(z)));
    // Any non-solid cell above counts as open: `cave_air`/`void_air` (e.g. a
    // shaft with open space above its floor) is standable open space, and
    // requiring literal "air" skips every cave/shaft floor.
    if (above !== null && above.boundingBox === "block") continue;
    const stand = y + 1;
    const dist = Math.abs(stand - currentY);
    if (best === null || dist < best.dist || (dist === best.dist && stand > best.y)) {
      best = { y: stand, dist };
    }
  }
  return best?.y ?? fallback;
}

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

  // Stall detector: if the pathfinder stays "active" (has a goal and
  // considers itself moving) for PATHFINDER_STALL_MS without settling,
  // the A* solver is wedged. Force-reset it so the next trip starts
  // with a clean state instead of inheriting the hang.
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  const stallPoll = setInterval(() => {
    const hasGoal = bot.pathfinder.goal !== null;
    const isMoving = bot.pathfinder.isMoving?.() ?? false;
    if (hasGoal && !isMoving) {
      // Pathfinder has a goal but reports it is not moving — likely wedged.
      if (stallTimer === undefined) {
        stallTimer = setTimeout(() => {
          logger.warn({ pathfinderGoal: bot.pathfinder.goal, pathfinderMoving: isMoving }, "pathfinder has goal but is not moving; force-resetting");
          resetPathfinder(bot);
          resolveNap({ status: "failed", error: "pathfinder stalled without progress" });
        }, PATHFINDER_STALL_MS);
      }
    } else {
      // Pathfinder is making progress (or has no goal yet); clear the stall
      // timer since progress is being made.
      if (stallTimer !== undefined) {
        clearTimeout(stallTimer);
        stallTimer = undefined;
      }
    }
  }, PATHFINDER_STALL_POLL_MS);

  try {
    if (signal.aborted) return { status: "aborted" };
    const winner = await Promise.race([trip, nap]);
    if (winner.status === "timed_out" || winner.status === "aborted" || winner.status === "failed") {
      // resetPathfinder stops the pathfinder and rebuilds its Movements so
      // the next trip starts clean; the explicit stop is contained there.
      resetPathfinder(bot);
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
    clearInterval(stallPoll);
    if (stallTimer !== undefined) clearTimeout(stallTimer);
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
async function travelHomeAndWaitImpl(bot: Bot, home: HomeLocation, options: TravelWaitOptions = {}): Promise<TravelWaitResult> {
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
  if (isCreativeMode(bot) && bot.creative?.flyTo !== undefined) {
    return creativeFlyToAndWait(bot, home, { timeoutMs: options.timeoutMs, signal });
  }
  getMovements(bot);
  const range = options.range ?? ARRIVE_RANGE;
  const arrivalRange = range + HOME_ARRIVAL_GRACE;

  const p = self.position;
  const initialDistance = Math.hypot(p.x - home.x, p.z - home.z);
  const homeSurfaceY = surfaceStandingY(bot, home.x, home.z, Math.floor(home.y));
  const verticallyAtHome = Math.abs(p.y - homeSurfaceY) <= 3;
  if (initialDistance <= arrivalRange && verticallyAtHome) {
    logger.info({
      position: p,
      configuredHome: home,
      currentDimension: bot.game.dimension ?? "",
      horizontalDistance: Number(initialDistance.toFixed(3)),
      homeSurfaceY,
      arrivalRange,
    }, "home arrival recognized by horizontal anchor");
    return { status: "already_there" };
  }

  // A long GoalNear can make mineflayer-pathfinder spend the entire timeout
  // planning through unloaded or difficult terrain. Break it into bounded
  // horizontal legs. For transit legs, prefer the local surface altitude so a
  // bot that is deep underground does not attempt a 200-block cave crossing;
  // Use the current column's surface altitude for every transit leg. A stale
  // persisted home Y can be below the terrain (or in the void), and asking
  // pathfinder to finish at that altitude makes recovery routes unsafe.
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TRAVEL_TIMEOUT_MS);
  let distance = initialDistance;
  let legNumber = 0;
  let noProgressLegs = 0;
  while (distance > arrivalRange || Math.abs((bot.entity?.position.y ?? homeSurfaceY) - homeSurfaceY) > 3) {
    if (signal.aborted || options.shouldAbort?.() === true) return { status: "aborted" };
    const current = bot.entity;
    if (!current) return { status: "not_ready" };
    legNumber += 1;
    const verticalOnly = distance <= arrivalRange;
    const leg = verticalOnly ? 0 : Math.min(HOME_LEG_LENGTH, distance);
    const fraction = verticalOnly ? 1 : leg / distance;
    const finalLeg = verticalOnly || distance <= HOME_LEG_LENGTH + arrivalRange;
    const transitY = surfaceStandingY(bot, current.position.x, current.position.z, Math.floor(current.position.y));
    const goal: Location = {
      x: current.position.x + (home.x - current.position.x) * fraction,
      y: finalLeg ? homeSurfaceY : transitY,
      z: current.position.z + (home.z - current.position.z) * fraction,
    };
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { status: "timed_out" };
    const legTimeout = Math.min(remaining, HOME_LEG_TIMEOUT_MS);
    logger.info({
      leg: legNumber,
      start: current.position,
      goal,
      configuredHome: home,
      currentDimension: bot.game.dimension ?? "",
      horizontalDistance: Number(distance.toFixed(3)),
      arrivalRange,
      timeoutMs: legTimeout,
    }, "home route leg");
    const trip = bot.pathfinder
      .goto(new goals.GoalNear(goal.x, goal.y, goal.z, Math.min(range, 3)))
      .then(() => ({ status: "arrived" } as const), (err: unknown) => ({ status: "failed" as const, error: String(err) }));
    const result = await raceTrip(bot, trip, { ...options, timeoutMs: legTimeout, signal });
    if (result.status === "timed_out" && !finalLeg && Date.now() < deadline) {
      logger.warn({ leg: legNumber, distance: Number(distance.toFixed(1)) }, "home route leg timed out; retrying from current position");
      continue;
    }
    if (result.status !== "arrived" && result.status !== "already_there") {
      // Pathfinder failed this leg. Try a dumb-walk toward home before
      // giving up — if the pathfinder is fundamentally broken (e.g.
      // unpathable terrain pocket), this is the only way out.
      // Give walkToward at least a full leg's budget so the bot can mine
      // its way home even when the leg consumed most of the deadline.
      logger.warn({ leg: legNumber, status: result.status }, "home route leg failed; attempting walkToward fallback");
      const fallback = await walkToward(bot, home, {
        range: arrivalRange + 2,
        timeoutMs: Math.max(TRAVEL_LEG_TIMEOUT_MS, remaining),
        signal,
        allowDig: options.allowDig,
      });
      if (fallback.arrived) return { status: "arrived" };
      return result;
    }
    const after = bot.entity;
    if (!after) return { status: "not_ready" };
    const previousDistance = distance;
    const previousY = current.position.y;
    distance = Math.hypot(after.position.x - home.x, after.position.z - home.z);
    const verticalDistance = Math.abs(after.position.y - homeSurfaceY);
    if (distance <= arrivalRange && verticalDistance <= 3) return { status: "arrived" };
    // GoalNear may resolve successfully at its own geometric boundary while
    // floating-point position leaves us a hair outside that same boundary.
    // Never turn that into a hot loop of immediately-successful route legs.
    const horizontalDelta = previousDistance - distance;
    const verticalDelta = Math.abs(previousY - after.position.y);
    if (horizontalDelta < 0.01 && verticalDelta < 0.05) noProgressLegs += 1;
    else noProgressLegs = 0;
    logger.info({ leg: legNumber, horizontalDelta: Number(horizontalDelta.toFixed(3)), verticalDelta: Number(verticalDelta.toFixed(3)), noProgressLegs }, "home route progress");
    if (noProgressLegs >= 2) {
      logger.warn({
        leg: legNumber,
        position: after.position,
        configuredHome: home,
        currentDimension: bot.game.dimension ?? "",
        horizontalDistance: Number(distance.toFixed(3)),
        verticalDistance: Number(verticalDistance.toFixed(3)),
        arrivalRange,
      }, "home route made no progress");
      return distance <= arrivalRange + 0.01 && verticalDistance <= 3
        ? { status: "arrived" }
        : { status: "failed", error: `home route made no progress at horizontal distance ${distance.toFixed(2)}` };
    }
  }
  return { status: "arrived" };
}

export async function travelHomeAndWait(bot: Bot, home: HomeLocation, options: TravelWaitOptions = {}): Promise<TravelWaitResult> {
  return withPathfinderDigging(bot, options.allowDig ?? true, () => travelHomeAndWaitImpl(bot, home, options));
}

/**
 * Walk to `location` and await arrival. Unlike `travelTo` (fire-and-forget),
 * this resolves when the pathfinder goal completes, times out, or fails —
 * the blocking primitive for skills that must be *somewhere* before acting.
 *
 * Long trips are decomposed into bounded horizontal legs, like
 * `travelHomeAndWait`, so a single unreachable waypoint cannot consume the
 * entire timeout and the pathfinder gets a fresh start on each leg.
 */
async function travelAndWaitImpl(bot: Bot, location: Location, options: TravelWaitOptions = {}): Promise<TravelWaitResult> {
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
  if (isCreativeMode(bot) && bot.creative?.flyTo !== undefined) {
    return creativeFlyToAndWait(bot, location, { timeoutMs: options.timeoutMs, signal });
  }
  getMovements(bot);
  const range = options.range ?? ARRIVE_RANGE;

  const p = self.position;
  const initialDistance = Math.hypot(p.x - location.x, p.y - location.y, p.z - location.z);
  if (initialDistance <= range) {
    return { status: "already_there" };
  }

  // Short trips fit in one leg and skip the decomposition overhead.
  if (initialDistance <= TRAVEL_LEG_LENGTH) {
    const trip = bot.pathfinder
      .goto(new goals.GoalNear(location.x, location.y, location.z, range))
      .then(() => ({ status: "arrived" } as const), (err: unknown) => ({ status: "failed" as const, error: String(err) }));
    return raceTrip(bot, trip, { ...options, signal });
  }

  // Long trips: decompose into bounded horizontal legs so a single bad A*
  // expansion cannot consume the entire budget and the pathfinder starts
  // fresh on each leg. The final leg targets the exact destination Y;
  // transit legs use surface standing altitudes.
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TRAVEL_TIMEOUT_MS);
  let distance = initialDistance;
  let legNumber = 0;
  let noProgressLegs = 0;
  while (distance > range) {
    if (signal.aborted || options.shouldAbort?.() === true) return { status: "aborted" };
    const current = bot.entity;
    if (!current) return { status: "not_ready" };
    legNumber += 1;
    const leg = Math.min(TRAVEL_LEG_LENGTH, distance);
    const fraction = leg / distance;
    const finalLeg = distance <= TRAVEL_LEG_LENGTH + range;
    const transitY = surfaceStandingY(bot, current.position.x, current.position.z, Math.floor(current.position.y));
    const goal: Location = {
      x: current.position.x + (location.x - current.position.x) * fraction,
      y: finalLeg ? location.y : transitY,
      z: current.position.z + (location.z - current.position.z) * fraction,
    };
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { status: "timed_out" };
    const legTimeout = Math.min(remaining, TRAVEL_LEG_TIMEOUT_MS);
    logger.info({
      leg: legNumber,
      start: current.position,
      goal,
      destination: location,
      currentDimension: bot.game.dimension ?? "",
      distance: Number(distance.toFixed(3)),
      range,
      timeoutMs: legTimeout,
    }, "travel route leg");
    const trip = bot.pathfinder
      .goto(new goals.GoalNear(goal.x, goal.y, goal.z, Math.min(range, 3)))
      .then(() => ({ status: "arrived" } as const), (err: unknown) => ({ status: "failed" as const, error: String(err) }));
    const result = await raceTrip(bot, trip, { ...options, timeoutMs: legTimeout, signal });
    if (result.status === "timed_out" && !finalLeg && Date.now() < deadline) {
      logger.warn({ leg: legNumber, distance: Number(distance.toFixed(1)) }, "travel route leg timed out; retrying from current position");
      continue;
    }
    if (result.status !== "arrived" && result.status !== "already_there") {
      // Pathfinder failed. Fall back to dumb-walk toward the destination.
      // Give walkToward a proper budget even if the leg consumed most of the deadline.
      logger.warn({ leg: legNumber, status: result.status }, "travel route leg failed; attempting walkToward fallback");
      const fallback = await walkToward(bot, location, {
        range: range + 2,
        timeoutMs: Math.max(TRAVEL_LEG_TIMEOUT_MS, remaining),
        signal,
        allowDig: options.allowDig,
      });
      if (fallback.arrived) return { status: "arrived" };
      return result;
    }
    const after = bot.entity;
    if (!after) return { status: "not_ready" };
    const previousDistance = distance;
    distance = Math.hypot(after.position.x - location.x, after.position.y - location.y, after.position.z - location.z);
    if (distance <= range) return { status: "arrived" };
    const horizontalDelta = previousDistance - distance;
    if (horizontalDelta < 0.01) noProgressLegs += 1;
    else noProgressLegs = 0;
    logger.info({ leg: legNumber, horizontalDelta: Number(horizontalDelta.toFixed(3)), noProgressLegs }, "travel route progress");
    if (noProgressLegs >= 2) {
      logger.warn({
        leg: legNumber,
        position: after.position,
        destination: location,
        currentDimension: bot.game.dimension ?? "",
        distance: Number(distance.toFixed(3)),
        range,
      }, "travel route made no progress");
      return distance <= range + 0.01
        ? { status: "arrived" }
        : { status: "failed", error: `travel route made no progress at distance ${distance.toFixed(2)}` };
    }
  }
  return { status: "arrived" };
}

export async function travelAndWait(bot: Bot, location: Location, options: TravelWaitOptions = {}): Promise<TravelWaitResult> {
  return withPathfinderDigging(bot, options.allowDig ?? true, () => travelAndWaitImpl(bot, location, options));
}
