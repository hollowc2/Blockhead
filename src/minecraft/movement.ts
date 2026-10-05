import { createRequire } from "node:module";
import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import type * as Pathfinder from "mineflayer-pathfinder";
import { Vec3 } from "vec3";
import { logger } from "../logger.js";
import { digBudgetMs, raceAbort, registerWorldActionTeardown, requireWorldActionLease, throwIfAborted } from "../agent/world-actions.js";
import { enableCreativeFlight, isCreativeMode } from "./mode.js";
import { isNaturalBlock } from "./natural-blocks.js";

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
    configureMovements(bot, movements);
    bot.pathfinder.setMovements(movements);
    // The stock 5 s planning budget covers ~12k nodes here; a 30-45 block
    // route through forest canopy or broken terrain needs more, and every
    // trunk 20+ blocks out failed "Took to long to decide path".
    bot.pathfinder.thinkTimeout = PATH_THINK_TIMEOUT_MS;
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

/**
 * What the bot believes it is standing in, for stall reports: a frozen
 * position in open terrain has been seen at the world spawn, and the server
 * shows open ground there, so record the client's view (null = unloaded).
 */
function standingDiagnostics(bot: Bot): Record<string, unknown> {
  try {
    return readStandingDiagnostics(bot);
  } catch {
    return {};
  }
}

function readStandingDiagnostics(bot: Bot): Record<string, unknown> {
  const entity = bot.entity;
  if (entity === null || entity === undefined) return {};
  const feet = entity.position.floored();
  const around: Record<string, string | null> = {};
  for (const [label, dx, dy, dz] of [["below", 0, -1, 0], ["feet", 0, 0, 0], ["head", 0, 1, 0], ["n", 0, 0, -1], ["s", 0, 0, 1], ["e", 1, 0, 0], ["w", -1, 0, 0]] as const) {
    around[label] = bot.blockAt(feet.offset(dx, dy, dz))?.name ?? null;
  }
  return {
    onGround: entity.onGround,
    velocity: { x: Number(entity.velocity.x.toFixed(3)), y: Number(entity.velocity.y.toFixed(3)), z: Number(entity.velocity.z.toFixed(3)) },
    controls: Object.entries(bot.controlState ?? {}).filter(([, on]) => on).map(([key]) => key),
    physicsEnabled: (bot as { physicsEnabled?: boolean }).physicsEnabled,
    around,
  };
}

/** Wall-clock planning budget per pathfinder search. */
const PATH_THINK_TIMEOUT_MS = 12_000;

/** Throwaway blocks the pathfinder may place to tower or bridge. */
// Cobblestone and its deepslate/stone forms are crafting stock (tools,
// furnace): towering to an acacia canopy once burned all 31 cobblestone the
// bot had just mined for stone tools. Dirt and filler stones only.
const SCAFFOLD_ITEMS = ["dirt", "coarse_dirt", "netherrack", "andesite", "diorite", "granite", "tuff"];

/**
 * Cells a trip got physically stuck stepping into (a jump the pathfinder
 * thinks is possible but physics cannot make: a one-high step under a low
 * ceiling). Steps into them cost extra for a few minutes so the next plan
 * routes around instead of retrying the same jump forever.
 */
const stuckCells: Array<{ x: number; y: number; z: number; until: number }> = [];
const STUCK_CELL_COST = 40;
const STUCK_CELL_TTL_MS = 3 * 60_000;

export function avoidStuckCell(cell: { x: number; y: number; z: number }, now = Date.now()): void {
  for (let i = stuckCells.length - 1; i >= 0; i--) if (stuckCells[i]!.until <= now) stuckCells.splice(i, 1);
  stuckCells.push({ x: Math.floor(cell.x), y: Math.floor(cell.y), z: Math.floor(cell.z), until: now + STUCK_CELL_TTL_MS });
}

export function stuckCellCost(position: { x: number; y: number; z: number }, now = Date.now()): number {
  for (const cell of stuckCells) {
    if (cell.until <= now) continue;
    if (Math.abs(position.x - cell.x) <= 1 && Math.abs(position.z - cell.z) <= 1 && position.y >= cell.y - 1 && position.y <= cell.y + 2) return STUCK_CELL_COST;
  }
  return 0;
}

function configureMovements(bot: Bot, movements: Pathfinder.Movements): void {
  const registry = bot.registry;
  (movements as unknown as { exclusionAreasStep: Array<(block: { position: Vec3 }) => number> }).exclusionAreasStep.push((block) => stuckCellCost(block.position));
  for (const block of registry.blocksArray) {
    if (!isNaturalBlock(block.name) || !block.diggable) movements.blocksCantBreak.add(block.id);
  }
  applyScaffolding(bot, movements);
  // Parkour jumps and long drops are the main source of falls and of
  // getting wedged in terrain; a companion can afford the longer route.
  movements.allowParkour = false;
  movements.maxDropDown = 3;
  // Swim only when the way round is much longer. Routes straight across the
  // drowned lake west of home cost five deaths on 2026-10-04.
  (movements as unknown as { liquidCost: number }).liquidCost = 4;
}

/** Bots whose pathfinder must not place scaffolding (nesting depth). */
const scaffoldFrozen = new WeakMap<Bot, number>();

function applyScaffolding(bot: Bot, movements: Pathfinder.Movements): void {
  const frozen = (scaffoldFrozen.get(bot) ?? 0) > 0;
  (movements as unknown as { scafoldingBlocks: number[] }).scafoldingBlocks = frozen
    ? []
    : SCAFFOLD_ITEMS.map((name) => bot.registry.itemsByName[name]?.id).filter((id): id is number => id !== undefined);
  movements.allow1by1towers = !frozen;
}

/**
 * Run terrain work with pathfinder scaffolding switched off. Walking to a
 * work pose inside a freshly dug mineshaft let the pathfinder drop dirt back
 * into the corridor, which then failed the route check ("route is blocked
 * at segment 4"). The terrain runner places its own blocks deliberately.
 */
export async function withoutPathfinderScaffolding<T>(bot: Bot, action: () => Promise<T>): Promise<T> {
  scaffoldFrozen.set(bot, (scaffoldFrozen.get(bot) ?? 0) + 1);
  const movements = getMovements(bot);
  if (movements !== null) applyScaffolding(bot, movements);
  try {
    return await action();
  } finally {
    scaffoldFrozen.set(bot, Math.max(0, (scaffoldFrozen.get(bot) ?? 1) - 1));
    const current = getMovements(bot);
    if (current !== null) applyScaffolding(bot, current);
  }
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
/**
 * Face and dig one cell for emergency movement. Both calls are raced against
 * the task's abort signal and a time bound: a bare `bot.dig` that straddles a
 * death never settles and would wedge the task (see raceAbort).
 */
async function digCell(bot: Bot, block: import("prismarine-block").Block, signal: AbortSignal | undefined): Promise<void> {
  await raceAbort(bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true), signal, { timeoutMs: 2_000, label: "look" });
  await raceAbort(bot.dig(block, true), signal, {
    timeoutMs: digBudgetMs(bot, block) ?? 30_000,
    label: "dig",
    onStop: () => bot.stopDigging(),
  });
}

/**
 * One step of an upward staircase: clear the block over the bot's head and
 * the two cells of the next step (feet+1, feet+2 one block ahead), then jump
 * onto it. Returns false when a cell cannot be cleared or there is no floor.
 */
async function climbStep(
  bot: Bot,
  feet: Vec3,
  dx: number,
  dz: number,
  isDiggable: (block: import("prismarine-block").Block | null) => boolean,
  equip: (block: import("prismarine-block").Block) => Promise<void> | void,
  signal?: AbortSignal,
): Promise<boolean> {
  const floor = bot.blockAt(new Vec3(feet.x + dx, feet.y, feet.z + dz));
  if (floor === null || floor.boundingBox !== "block") return false;
  const cells = [new Vec3(feet.x, feet.y + 2, feet.z), new Vec3(feet.x + dx, feet.y + 1, feet.z + dz), new Vec3(feet.x + dx, feet.y + 2, feet.z + dz)];
  // Opening a cell next to lava (or under water) floods the stair.
  if (cells.some((cell) => cellTouchesLiquid(bot, cell))) return false;
  for (const cell of cells) {
    const block = bot.blockAt(cell);
    if (block === null) return false;
    if (block.boundingBox !== "block") continue;
    if (!isDiggable(block)) return false;
    if (signal?.aborted) return false;
    try {
      await equip(block);
      logger.warn({ at: cell, name: block.name }, "walkToward climbing: clearing a stair cell");
      await digCell(bot, block, signal);
    } catch (err) {
      logger.warn({ at: cell, err: String(err) }, "walkToward climb dig failed");
      return false;
    }
  }
  // Let the pathfinder take the one-block step: it centres the bot, which a
  // blind jump in a one-wide tunnel does not (the hitbox catches the wall).
  const startY = bot.entity?.position.y ?? feet.y;
  try {
    await Promise.race([
      bot.pathfinder.goto(new goals.GoalNear(feet.x + dx, feet.y + 1, feet.z + dz, 0)),
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error("step timed out")), 4_000)),
    ]);
  } catch {
    bot.pathfinder.setGoal(null);
    await bot.lookAt(new Vec3(feet.x + dx + 0.5, feet.y + 1.6, feet.z + dz + 0.5), true);
    bot.setControlState("jump", true);
    bot.setControlState("forward", true);
    await new Promise<void>((resolve) => setTimeout(resolve, 450));
    bot.setControlState("jump", false);
    bot.setControlState("forward", false);
  }
  return (bot.entity?.position.y ?? startY) > startY + 0.5;
}

/**
 * Hold the best carried tool for digging `block`, and wait for the swap: dig
 * time is fixed from the held item when the dig starts, so an un-awaited
 * equip dug the first cell with whatever was in hand. Checks the real held
 * item rather than a cached kind, which went stale when anything else
 * swapped the hand. (The 7.5 s-per-cell climb of 2026-10-04 18:20 was a
 * broken pickaxe; see craftPickaxeInField.)
 */
export async function equipDigTool(bot: Bot, block: import("prismarine-block").Block, signal?: AbortSignal): Promise<void> {
  const want = digToolKind(block);
  let best: import("prismarine-item").Item | null = null;
  let bestTier = 0;
  for (const item of bot.inventory?.items() ?? []) {
    const name = item.name.replace(/^minecraft:/, "");
    // Exact family: "axe" must not match "pickaxe".
    if (!name.endsWith(`_${want}`)) continue;
    const tier = TOOL_TIERS[name.slice(0, -want.length - 1)] ?? 0;
    if (tier > bestTier) { best = item; bestTier = tier; }
  }
  if (best === null || bot.heldItem?.name === best.name) return;
  await raceAbort(bot.equip(best, "hand"), signal, { timeoutMs: 2_000, label: "equip" }).catch(() => undefined);
}

const TOOL_TIERS: Record<string, number> = { wooden: 1, golden: 1, stone: 2, iron: 3, diamond: 4, netherite: 5 };

/**
 * Tool family that digs `block` fastest, from its registry material
 * ("mineable/pickaxe", ...). Name guessing sent andesite, diorite, tuff and
 * ores to the shovel, digging them at hand speed.
 */
export function digToolKind(block: { name: string; material?: string | null }): "pickaxe" | "axe" | "shovel" {
  const material = block.material ?? "";
  if (/pickaxe/.test(material)) return "pickaxe";
  if (/(^|\/)axe/.test(material)) return "axe";
  if (/shovel/.test(material)) return "shovel";
  const name = block.name.replace(/^minecraft:/, "");
  if (/_log$|_wood$|_planks$/.test(name)) return "axe";
  if (/^(dirt|grass_block|sand|red_sand|gravel|clay|coarse_dirt|rooted_dirt|mud|podzol|mycelium|snow_block|soul_sand|soul_soil)$/.test(name)) return "shovel";
  return "pickaxe";
}

/** True when digging `cell` would let lava in from any side or water from above. */
function cellTouchesLiquid(bot: Bot, cell: Vec3): boolean {
  const offsets = [[0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]] as const;
  for (const [ox, oy, oz] of offsets) {
    const name = bot.blockAt(cell.offset(ox, oy, oz))?.name ?? "";
    if (/lava/.test(name)) return true;
    if (oy === 1 && /water/.test(name)) return true;
  }
  return false;
}

/** True when at least 3 of the 4 cells beside the bot's feet are solid (a shaft or pit). */
function enclosedAtFeet(bot: Bot, feet: Vec3): boolean {
  let solid = 0;
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    if (bot.blockAt(feet.offset(dx, 0, dz))?.boundingBox === "block") solid += 1;
  }
  return solid >= 3;
}

/** How far up `hasRoof` looks for a ceiling. */
const ROOF_SCAN = 24;

/** True when a solid block hangs over the bot's head: it is in a cave, not in the open. */
export function hasRoof(bot: Bot, position: Vec3): boolean {
  const head = position.floored().offset(0, 2, 0);
  for (let dy = 0; dy < ROOF_SCAN; dy++) {
    const block = bot.blockAt(head.offset(0, dy, 0));
    if (block === null) return false;
    if (block.boundingBox === "block") return true;
  }
  return false;
}

/** Perch rescues one trip may make before it reports no progress. */
const MAX_PERCH_RESCUES = 2;
/** Deepest drop a stranded bot may take to get off a perch (2 hearts of fall damage at most). */
const RESCUE_MAX_DROP = 5;
/** Health a perch rescue needs before it risks that fall. */
const RESCUE_MIN_HEALTH = 10;

/**
 * Get down from a perch the pathfinder will not leave: open air on every side
 * and the nearest floor deeper than its 3-block drop limit. Steps off toward
 * `toward` onto the shallowest landing within RESCUE_MAX_DROP; never into
 * lava. Returns true when the bot ended lower than it started.
 */
export async function stepOffPerch(bot: Bot, toward: { x: number; z: number }, signal?: AbortSignal): Promise<boolean> {
  const self = bot.entity;
  if (self === null || self === undefined || typeof bot.blockAt !== "function") return false;
  if ((bot.health ?? 20) < RESCUE_MIN_HEALTH) return false;
  const feet = self.position.floored();
  const landings: { dx: number; dz: number; depth: number }[] = [];
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    const side = feet.offset(dx, 0, dz);
    if (bot.blockAt(side)?.boundingBox !== "empty" || bot.blockAt(side.offset(0, 1, 0))?.boundingBox !== "empty") continue;
    for (let depth = 1; depth <= RESCUE_MAX_DROP + 1; depth++) {
      const block = bot.blockAt(side.offset(0, -depth, 0));
      if (block === null) break;
      if (/lava/.test(block.name)) break;
      if (block.boundingBox === "block" || /water/.test(block.name)) {
        if (depth - 1 > MAX_SAFE_DROP && depth - 1 <= RESCUE_MAX_DROP) landings.push({ dx, dz, depth: depth - 1 });
        break;
      }
    }
  }
  if (landings.length === 0) return false;
  const towardX = toward.x - self.position.x;
  const towardZ = toward.z - self.position.z;
  landings.sort((a, b) => a.depth - b.depth || (b.dx * towardX + b.dz * towardZ) - (a.dx * towardX + a.dz * towardZ));
  const pick = landings[0]!;
  const startY = self.position.y;
  logger.warn({ at: { x: feet.x, y: feet.y, z: feet.z }, step: [pick.dx, pick.dz], drop: pick.depth }, "stranded on a perch; stepping off");
  bot.clearControlStates();
  await raceAbort(bot.lookAt(new Vec3(feet.x + pick.dx + 0.5, self.position.y + 1.6, feet.z + pick.dz + 0.5), true), signal, { timeoutMs: 2_000, label: "look" });
  bot.setControlState("forward", true);
  try {
    const deadline = Date.now() + 2_500;
    while (Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      if (signal?.aborted) break;
      const now = bot.entity?.position.y ?? startY;
      if (now < startY - 1) break;
    }
  } finally {
    bot.setControlState("forward", false);
  }
  // Let the fall finish before the next leg plans from mid-air.
  const settle = Date.now() + 2_000;
  while (Date.now() < settle && bot.entity?.onGround === false) await new Promise<void>((resolve) => setTimeout(resolve, 100));
  return (bot.entity?.position.y ?? startY) < startY - 0.5;
}

/** How far a swimming bot looks for a bank to climb out onto. */
const SHORE_SCAN = 6;
const SHORE_SWIM_MS = 8_000;

/** A cell the bot can stand in: solid floor, two non-liquid open cells. */
function standable(bot: Bot, cell: Vec3): boolean {
  const open = (pos: Vec3): boolean => {
    const block = bot.blockAt(pos);
    return block !== null && block.boundingBox === "empty" && !/water|lava/.test(block.name);
  };
  return bot.blockAt(cell.offset(0, -1, 0))?.boundingBox === "block" && open(cell) && open(cell.offset(0, 1, 0));
}

/** Nearest standable bank cell within SHORE_SCAN of a swimming bot, preferring the side toward `toward`. */
export function nearestShore(bot: Bot, toward: { x: number; z: number }, scan = SHORE_SCAN): Vec3 | null {
  const self = bot.entity;
  if (self === null || self === undefined) return null;
  const feet = self.position.floored();
  let best: Vec3 | null = null;
  let bestScore = Infinity;
  for (let dx = -scan; dx <= scan; dx++) {
    for (let dz = -scan; dz <= scan; dz++) {
      for (let dy = -1; dy <= 2; dy++) {
        const cell = feet.offset(dx, dy, dz);
        if (!standable(bot, cell)) continue;
        const reach = Math.hypot(dx, dz) + Math.max(0, dy) * 2;
        const goal = Math.hypot(toward.x - cell.x, toward.z - cell.z) - Math.hypot(toward.x - feet.x, toward.z - feet.z);
        const score = reach + goal * 0.25;
        if (score < bestScore) { bestScore = score; best = cell; }
      }
    }
  }
  return best;
}

/**
 * Swim out of water the pathfinder will not plan from: in a cave pool its
 * start node has no floor and every leg ends "noPath" after one node, so the
 * bot treaded water until the trip gave up (18:59 2026-10-04, coal haul
 * stranded). Swims to the nearest bank, holding jump to stay up. Returns true
 * once the bot stands out of the water.
 */
export async function swimToShore(bot: Bot, toward: { x: number; z: number }, signal?: AbortSignal, scan = SHORE_SCAN): Promise<boolean> {
  const self = bot.entity;
  if (self === null || self === undefined || typeof bot.blockAt !== "function") return false;
  if (!/water/.test(bot.blockAt(self.position.floored())?.name ?? "")) return false;
  const shore = nearestShore(bot, toward, scan);
  if (shore === null) {
    logger.warn({ from: self.position.floored(), scan }, "swimming with no bank in sight");
    return false;
  }
  logger.warn({ from: self.position.floored(), shore }, "stuck swimming; heading for the bank");
  bot.clearControlStates();
  bot.setControlState("jump", true);
  bot.setControlState("forward", true);
  try {
    // About 2 blocks/s swimming: a far bank needs longer than a near one.
    const deadline = Date.now() + Math.max(SHORE_SWIM_MS, self.position.distanceTo(shore) * 700);
    while (Date.now() < deadline) {
      if (signal?.aborted) break;
      const now = bot.entity;
      if (now === null || now === undefined) break;
      if (now.onGround && !/water/.test(bot.blockAt(now.position.floored())?.name ?? "")) return true;
      await raceAbort(bot.lookAt(shore.offset(0.5, 1.2, 0.5), true), signal, { timeoutMs: 1_000, label: "look" }).catch(() => undefined);
      await new Promise<void>((resolve) => setTimeout(resolve, 150));
    }
  } finally {
    bot.clearControlStates();
  }
  const final = bot.entity;
  return final !== null && final !== undefined && !/water/.test(bot.blockAt(final.position.floored())?.name ?? "");
}

/** Get unstuck when route legs make no progress: off a perch, or out of water. */
async function rescueStranded(bot: Bot, toward: { x: number; z: number }, signal?: AbortSignal): Promise<boolean> {
  if (await swimToShore(bot, toward, signal)) return true;
  return stepOffPerch(bot, toward, signal);
}

/** Consecutive failed steps before a staircase climb gives up. */
const CLIMB_MAX_FAILURES = 4;

/**
 * Staircase straight up toward `destination` until the bot is within 2
 * blocks of its height. One tight loop: dig the step, take it, repeat — no
 * forward walking in between, which dropped the bot back off the stair it had
 * just cut. Climbing out of a y=37 cave through the walkToward stall detector
 * managed ~1 block per 8 s and was cancelled by the task watchdog every 5 min
 * (2026-10-04). Returns the height gained.
 */
export async function climbToward(
  bot: Bot,
  destination: { x: number; y: number; z: number },
  isDiggable: (block: import("prismarine-block").Block | null) => boolean,
  equip: (block: import("prismarine-block").Block) => Promise<void> | void,
  options: { deadline: number; signal?: AbortSignal },
): Promise<number> {
  const startY = bot.entity?.position.y ?? 0;
  let failures = 0;
  while (Date.now() < options.deadline && failures < CLIMB_MAX_FAILURES) {
    if (options.signal?.aborted) break;
    const self = bot.entity;
    if (self === null || self === undefined) break;
    if (destination.y - self.position.y < 3) break;
    const feet = self.position.floored();
    const towardX = destination.x - self.position.x;
    const towardZ = destination.z - self.position.z;
    const directions = ([[1, 0], [-1, 0], [0, 1], [0, -1]] as [number, number][])
      .sort((a, b) => (b[0] * towardX + b[1] * towardZ) - (a[0] * towardX + a[1] * towardZ));
    let stepped = false;
    for (const [dx, dz] of directions) {
      if (options.signal?.aborted) break;
      stepped = await climbStep(bot, feet, dx, dz, isDiggable, equip, options.signal);
      if (stepped) break;
    }
    // Tower straight up only inside a shaft. In the open, a pillar strands
    // the bot on a column it may not dig and cannot drop from (18:31
    // 2026-10-04: three blocks of cobblestone with a 4-block fall around).
    if (!stepped && !options.signal?.aborted && enclosedAtFeet(bot, feet)) stepped = await pillarStep(bot, feet, isDiggable, equip, options.signal);
    failures = stepped ? 0 : failures + 1;
  }
  const gained = (bot.entity?.position.y ?? startY) - startY;
  logger.info({ gained: Number(gained.toFixed(1)), y: Math.floor(bot.entity?.position.y ?? 0), targetY: destination.y }, "staircase climb finished");
  return gained;
}

/** Throwaway blocks a trapped bot may stand on while towering up. */
const PILLAR_ITEMS = ["cobblestone", "dirt", "cobbled_deepslate", "andesite", "diorite", "granite", "netherrack"];

/** Clear the block overhead, jump, and place a block where the bot stood. */
async function pillarStep(
  bot: Bot,
  feet: Vec3,
  isDiggable: (block: import("prismarine-block").Block | null) => boolean,
  equip: (block: import("prismarine-block").Block) => Promise<void> | void,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return false;
  const item = bot.inventory.items().find((candidate) => PILLAR_ITEMS.includes(candidate.name.replace(/^minecraft:/, "")));
  if (item === undefined) return false;
  const below = bot.blockAt(feet.offset(0, -1, 0));
  if (below === null || below.boundingBox !== "block") return false;
  for (const cell of [feet.offset(0, 2, 0)]) {
    if (cellTouchesLiquid(bot, cell)) return false;
    const block = bot.blockAt(cell);
    if (block === null) return false;
    if (block.boundingBox !== "block") continue;
    if (!isDiggable(block)) return false;
    try {
      await equip(block);
      await digCell(bot, block, signal);
    } catch { return false; }
  }
  try {
    await bot.equip(item, "hand");
    await bot.lookAt(feet.offset(0.5, -0.5, 0.5), true);
    const startY = bot.entity?.position.y ?? feet.y;
    bot.setControlState("jump", true);
    const deadline = Date.now() + 800;
    while ((bot.entity?.position.y ?? startY) < startY + 1 && Date.now() < deadline) await new Promise<void>((resolve) => setTimeout(resolve, 50));
    await bot.placeBlock(below, new Vec3(0, 1, 0));
    logger.warn({ at: feet }, "walkToward climbing: towered up one block");
    return true;
  } catch (err) {
    logger.warn({ at: feet, err: String(err) }, "walkToward tower step failed");
    return false;
  } finally {
    bot.setControlState("jump", false);
  }
}

/** The deepest fall a blind fallback walk may take (the pathfinder's own limit). */
const MAX_SAFE_DROP = 3;

/** Blocks of open air under the cell one step toward `target` (0 = level or rising ground). */
export function dropAhead(bot: Bot, from: Vec3, target: Vec3): number {
  if (typeof bot.blockAt !== "function") return 0;
  const dx = target.x - from.x;
  const dz = target.z - from.z;
  const length = Math.hypot(dx, dz);
  if (length < 0.5) return 0;
  const step = new Vec3(Math.floor(from.x + dx / length), Math.floor(from.y), Math.floor(from.z + dz / length));
  // Rising ground or a wall ahead: no drop.
  if (bot.blockAt(step)?.boundingBox === "block") return 0;
  for (let depth = 1; depth <= MAX_SAFE_DROP + 2; depth++) {
    const block = bot.blockAt(step.offset(0, -depth, 0));
    if (block === null) return 0;
    if (block.boundingBox === "block" || /water/.test(block.name)) return depth - 1;
  }
  return MAX_SAFE_DROP + 2;
}

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

  const destinationVec = new Vec3(destination.x, destination.y, destination.z);

  const equipBestForDig = (block: import("prismarine-block").Block): Promise<void> => equipDigTool(bot, block, options.signal);

  // Blocks the bot is allowed to punch through during emergency movement.
  const isDiggable = (block: import("prismarine-block").Block | null): boolean => {
    if (block === null || block.boundingBox !== "block") return false;
    const name = block.name.replace(/^minecraft:/, "");
    if (name === "bedrock" || name === "obsidian" || name === "water" || name === "lava") return false;
    // Never dig placed chests, furnaces, crafting tables, or beds at home.
    // Only natural terrain: never tunnel through something a player built.
    if (!isNaturalBlock(name)) return false;
    return block.hardness !== undefined && block.hardness >= 0;
  };

  try {
    // Far below the destination (a cave or mine): climb out first, in one
    // go, rather than waiting for the stall detector to cut each step.
    if (options.allowDig !== false && destinationVec.y - self.position.y >= 3 && hasRoof(bot, self.position)) {
      await climbToward(bot, destinationVec, isDiggable, equipBestForDig, { deadline, signal: options.signal });
    }
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
          // Destination well above (trapped in a cave or tunnel): climb a
          // staircase toward it. Digging straight ahead at the current depth
          // only lengthens the tunnel.
          if (destinationVec.y - current.position.y >= 3) {
            for (const [dx, dz] of offsets.filter(([ox, oz]) => ox === 0 || oz === 0)) {
              dug = await climbStep(bot, feet, dx, dz, isDiggable, equipBestForDig, options.signal);
              if (dug) break;
            }
            // No step to climb onto in any direction: tower straight up.
            if (!dug) dug = await pillarStep(bot, feet, isDiggable, equipBestForDig, options.signal);
            if (dug) { stuckTicks = 0; lastDistance = distance; continue; }
          }
          for (const [dx, dz] of offsets) {
            if (dug || options.signal?.aborted) break;
            for (const y of [footY, headY]) {
              if (options.signal?.aborted) break;
              const pos = new Vec3(feet.x + dx, y, feet.z + dz);
              const block = bot.blockAt(pos);
              if (block === null || !isDiggable(block)) continue;
              try {
                const now = Date.now();
                if (now - lastDigAt < 300) continue;
                lastDigAt = now;
                await equipBestForDig(block);
                logger.warn({ at: pos, name: block.name, distance: Number(distance.toFixed(1)), stuckTicks }, "walkToward clearing obstacle");
                await digCell(bot, block, options.signal);
                dug = true;
                stuckTicks = 0;
              } catch (err) {
                logger.warn({ at: pos, name: block.name, err: String(err) }, "walkToward dig failed");
              }
              if (dug) break;
            }
          }

          if (!dug && stuckTicks % 20 === 0) {
            logger.warn({ position: current.position, distance: Number(distance.toFixed(1)), stuckTicks, ...standingDiagnostics(bot) }, "walkToward stalled, no diggable blocks found in adjacency");
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

      if (options.signal?.aborted) break;
      // Re-aim toward the destination and walk forward. A smooth look waits
      // on physics ticks, which stall while the bot is dead.
      try {
        await raceAbort(bot.lookAt(destinationVec.offset(0, 1, 0), false), options.signal, { timeoutMs: 2_000, label: "look" });
      } catch {
        if (options.signal?.aborted) break;
      }
      // Never walk off an edge: this fallback stepped off a dirt bridge the
      // pathfinder had built over a valley (25-block fall, death 3).
      if (dropAhead(bot, current.position, destinationVec) > MAX_SAFE_DROP) {
        logger.warn({ position: current.position, destination }, "walkToward refusing to step off a drop");
        break;
      }
      bot.setControlState("forward", true);
      bot.setControlState("jump", true); // helps with small obstacles

      await new Promise<void>((resolve) => {
        const abort = (): void => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => { options.signal?.removeEventListener("abort", abort); resolve(); }, 250);
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
    // A lake bed under water is not a standing surface: picked as "ground"
    // it sent every home leg from a lake to y=44, deep under the land.
    if (above !== null && /water|lava/.test(above.name)) continue;
    const stand = y + 1;
    const dist = Math.abs(stand - currentY);
    if (best === null || dist < best.dist || (dist === best.dist && stand > best.y)) {
      best = { y: stand, dist };
    }
  }
  return best?.y ?? fallback;
}

/**
 * The topmost standing level in a loaded column (open cell over solid, with
 * no ground above), ignoring leaves so a tree canopy is not "the surface".
 * Returns null when the column is not loaded.
 */
export function skySurfaceY(bot: Bot, x: number, z: number): number | null {
  if (typeof bot.blockAt !== "function") return null;
  const bx = Math.floor(x);
  const bz = Math.floor(z);
  let sawLoaded = false;
  for (let y = 319; y >= -63; y--) {
    const block = bot.blockAt(new Vec3(bx, y, bz));
    if (block === null) { if (sawLoaded) return null; continue; }
    sawLoaded = true;
    if (block.boundingBox !== "block") continue;
    const name = block.name.replace(/^minecraft:/, "");
    if (name.endsWith("_leaves") || name.endsWith("_log")) continue;
    return y + 1;
  }
  return null;
}

/**
 * Where a transit leg should end in a column: the top of the ground, with
 * leaves and logs ignored (a canopy picked by "nearest the bot's altitude"
 * sent a lakeside leg to y=87 over a lake at 62) and water counted as the
 * surface (the bot can swim there; a lake bed was y=44 under the land).
 * Falls back to the bot-relative scan when the column is not loaded.
 */
function legSurfaceY(bot: Bot, x: number, z: number, fallback: number): number {
  if (typeof bot.blockAt !== "function") return fallback;
  const bx = Math.floor(x);
  const bz = Math.floor(z);
  let sawLoaded = false;
  for (let y = 319; y >= -63; y--) {
    const block = bot.blockAt(new Vec3(bx, y, bz));
    if (block === null) { if (sawLoaded) break; continue; }
    sawLoaded = true;
    const name = block.name.replace(/^minecraft:/, "");
    if (/water|seagrass|kelp/.test(name)) return y + 1;
    if (block.boundingBox !== "block") continue;
    if (name.endsWith("_leaves") || name.endsWith("_log")) continue;
    return y + 1;
  }
  return surfaceStandingY(bot, x, z, fallback);
}

/**
 * Break a physics wedge: move the bot a few hundredths of a block toward the
 * centre of its cell (well inside the server's movement tolerance) so an edge
 * resting exactly on a block face no longer pins it, and drop its velocity.
 */
export function unwedge(bot: Bot): void {
  const entity = bot.entity;
  if (entity === null || entity === undefined) return;
  const p = entity.position;
  const toward = (v: number): number => {
    const centre = Math.floor(v) + 0.5;
    return Math.abs(centre - v) < 0.01 ? v : v + Math.sign(centre - v) * Math.min(0.08, Math.abs(centre - v));
  };
  const from = { x: p.x, y: p.y, z: p.z };
  p.x = toward(p.x);
  p.z = toward(p.z);
  entity.velocity.x = 0;
  entity.velocity.z = 0;
  logger.warn({ from, to: { x: p.x, y: p.y, z: p.z }, onGround: entity.onGround }, "pathfinder stuck in place; nudging the bot free");
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

  // Trip trace: a 60 s leg with the bot motionless, where a fresh pathfinder
  // plans the same leg in 81 ms (probe on maia), needs the pathfinder's own
  // view. Log the first few plan results and every reset, per trip.
  let updates = 0;
  let nextNode: { x: number; y: number; z: number } | null = null;
  const onPathUpdate = (result: { status: string; path: Array<{ x: number; y: number; z: number }>; visitedNodes?: number; time?: number }): void => {
    updates += 1;
    nextNode = result.path[0] ?? null;
    if (updates > 4 && result.status === "success") return;
    if (updates > 12) return;
    logger.info({ status: result.status, pathLength: result.path.length, visitedNodes: result.visitedNodes, ms: result.time }, "trip: path update");
  };
  // The pathfinder resetting "stuck" while the bot does not move at all is
  // the physics wedge (box edge exactly on a step face, frozen mid-jump at
  // y+0.42 with zero velocity; the server agreed). Nudge it free.
  let stuckAt: Vec3 | null = null;
  let stuckResets = 0;
  const onPathReset = (reason: string): void => {
    logger.info({ reason }, "trip: path reset");
    if (reason !== "stuck" || bot.entity === null || bot.entity === undefined) return;
    const here = bot.entity.position;
    if (stuckAt !== null && here.distanceTo(stuckAt) < 0.3) stuckResets += 1;
    else { stuckAt = here.clone(); stuckResets = 1; }
    if (stuckResets === 2) unwedge(bot);
    if (stuckResets >= 4) {
      // The nudge did not help: the move itself is impossible here. Route
      // around the step it keeps failing.
      const cell = nextNode ?? { x: here.x, y: here.y, z: here.z };
      avoidStuckCell(cell);
      logger.warn({ at: { x: Math.floor(here.x), y: Math.floor(here.y), z: Math.floor(here.z) }, avoiding: { x: Math.floor(cell.x), y: Math.floor(cell.y), z: Math.floor(cell.z) } }, "pathfinder keeps failing the same move; routing around it");
      stuckResets = 0;
      stuckAt = null;
    }
  };
  const pathEvents = bot as unknown as Partial<NodeJS.EventEmitter>;
  pathEvents.on?.("path_update", onPathUpdate);
  pathEvents.on?.("path_reset", onPathReset);

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
      logger.info({ status: winner.status, error: winner.status === "failed" ? winner.error : undefined, position: bot.entity?.position, ...(winner.status === "aborted" ? {} : standingDiagnostics(bot)) }, "pathfinder trip ended without arrival");
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
    pathEvents.off?.("path_update", onPathUpdate);
    pathEvents.off?.("path_reset", onPathReset);
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
  // Home is on the surface: from a cave under the home column the nearest
  // standing level is the cave floor, which must never count as "home".
  // Unloaded right after a spawn, the home column has no sky surface yet and
  // the fallback ends at the stored home Y, which can be inside the ground:
  // 19:43 2026-10-04 the bot dug down to y=88 under the house (surface 98)
  // and then found no crafting table. Re-resolve it on every leg.
  let skyHomeY = skySurfaceY(bot, home.x, home.z);
  let homeSurfaceY = skyHomeY ?? surfaceStandingY(bot, home.x, home.z, Math.floor(home.y));
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
  let perchRescues = 0;
  while (distance > arrivalRange || Math.abs((bot.entity?.position.y ?? homeSurfaceY) - homeSurfaceY) > 3) {
    if (signal.aborted || options.shouldAbort?.() === true) return { status: "aborted" };
    const current = bot.entity;
    if (!current) return { status: "not_ready" };
    const legStart = current.position.clone();
    legNumber += 1;
    const verticalOnly = distance <= arrivalRange;
    const leg = verticalOnly ? 0 : Math.min(HOME_LEG_LENGTH, distance);
    const fraction = verticalOnly ? 1 : leg / distance;
    const finalLeg = verticalOnly || distance <= HOME_LEG_LENGTH + arrivalRange;
    const goalX = current.position.x + (home.x - current.position.x) * fraction;
    const goalZ = current.position.z + (home.z - current.position.z) * fraction;
    // The leg ends at the goal column's surface, not the bot's own altitude:
    // 48 blocks away the ground can be 20+ blocks higher or lower.
    const transitY = legSurfaceY(bot, goalX, goalZ, Math.floor(current.position.y));
    if (skyHomeY === null) {
      skyHomeY = skySurfaceY(bot, home.x, home.z);
      if (skyHomeY !== null) homeSurfaceY = skyHomeY;
    }
    const goal: Location = {
      x: goalX,
      // Until the home column loads, a final leg ends on the ground there.
      y: finalLeg && skyHomeY !== null ? homeSurfaceY : transitY,
      z: goalZ,
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
    if (result.status === "timed_out" && Date.now() < deadline && (!finalLeg || movedSince(bot, legStart, 2)) && !trappedBelow(bot, home, legStart)) {
      // Slow is not stuck: digging a staircase with a wooden pickaxe easily
      // outlasts one leg budget. Keep going while the bot is still moving.
      logger.warn({ leg: legNumber, distance: Number(distance.toFixed(1)) }, "home route leg timed out; retrying from current position");
      distance = Math.hypot((bot.entity?.position.x ?? current.position.x) - home.x, (bot.entity?.position.z ?? current.position.z) - home.z);
      continue;
    }
    if (result.status !== "arrived" && result.status !== "already_there") {
      // Pathfinder failed this leg. Try a dumb-walk toward home before
      // giving up — if the pathfinder is fundamentally broken (e.g.
      // unpathable terrain pocket), this is the only way out.
      // Give walkToward at least a full leg's budget so the bot can mine
      // its way home even when the leg consumed most of the deadline.
      logger.warn({ leg: legNumber, status: result.status, error: result.status === "failed" ? result.error : undefined, position: bot.entity?.position, goal }, "home route leg failed; attempting walkToward fallback");
      // A no-dig NoPath is answered by the caller's natural-digging retry;
      // blind walking cannot beat an exhaustive A* search.
      if (options.allowDig === false && isNoPath(result)) return result;
      if (signal.aborted || /GoalChanged/.test(result.status === "failed" ? result.error : "")) return result;
      const fallback = await walkToward(bot, { x: home.x, y: homeSurfaceY, z: home.z }, {
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
    if (noProgressLegs >= 2 && perchRescues < MAX_PERCH_RESCUES && await rescueStranded(bot, home, signal)) {
      perchRescues += 1;
      noProgressLegs = 0;
      distance = Math.hypot((bot.entity?.position.x ?? home.x) - home.x, (bot.entity?.position.z ?? home.z) - home.z);
      continue;
    }
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

/**
 * Deep below the goal and no higher than when the leg began: the bot is
 * wandering a cave, not climbing out. Skip the leg retries and go to the
 * walkToward fallback, which digs a staircase up.
 */
function trappedBelow(bot: Bot, goal: { y: number }, legStart: Vec3): boolean {
  const y = bot.entity?.position.y;
  return y !== undefined && goal.y - y >= 6 && y - legStart.y < 1;
}

function movedSince(bot: Bot, start: Vec3, minimum: number): boolean {
  const now = bot.entity?.position;
  return now !== undefined && now.distanceTo(start) >= minimum;
}

function isNoPath(result: TravelWaitResult): boolean {
  return result.status === "failed" && /NoPath|no progress/i.test(result.error);
}

/** Known way up from where the bot stands (a dug mineshaft), or null. */
export type EscapeRouteProvider = (position: { x: number; y: number; z: number }, dimension: string) => Array<{ x: number; y: number; z: number }> | null;
let escapeRouteProvider: EscapeRouteProvider | null = null;

export function setEscapeRouteProvider(provider: EscapeRouteProvider | null): void {
  escapeRouteProvider = provider;
}

/** Destinations this far above the bot count as "climbing out". */
const ESCAPE_MIN_RISE = 6;

/**
 * Deep in a mineshaft with a destination far above, walk up the shaft's own
 * steps to its entrance first. A pathfinder search from the bottom of a long
 * staircase to the surface does not finish, and the straight-line fallback
 * then tunnels sideways at depth instead of climbing.
 */
/**
 * Standing on a chest (or slab, bed, ...) puts the bot's feet inside that
 * block's cell, and the pathfinder cannot plan from there: every trip from
 * the top of the home chest timed out without the bot moving (the "frozen at
 * home/spawn" stalls). Walk off onto an open neighbouring cell first.
 */
export async function stepOffPartialBlock(bot: Bot, options: TravelWaitOptions = {}): Promise<void> {
  const entity = bot.entity;
  if (entity === null || entity === undefined || typeof bot.blockAt !== "function") return;
  const feet = entity.position.floored();
  const under = bot.blockAt(feet);
  if (under === null || under.boundingBox === "empty") return;
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    const cell = feet.offset(dx, 0, dz);
    const open = (block: ReturnType<Bot["blockAt"]>): boolean => block !== null && block.boundingBox === "empty" && !/water|lava/.test(block.name);
    if (!open(bot.blockAt(cell)) || !open(bot.blockAt(cell.offset(0, 1, 0)))) continue;
    if (bot.blockAt(cell.offset(0, -1, 0))?.boundingBox !== "block") continue;
    logger.info({ on: under.name, at: { x: feet.x, y: feet.y, z: feet.z }, toward: { x: cell.x, z: cell.z } }, "stepping off a partial block before travelling");
    await bot.lookAt(new Vec3(cell.x + 0.5, entity.position.y + 1.6, cell.z + 0.5), true);
    bot.setControlState("forward", true);
    try {
      const deadline = Date.now() + 1_500;
      while (Date.now() < deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        if (options.signal?.aborted === true) return;
        if (bot.blockAt(bot.entity.position.floored())?.boundingBox === "empty") return;
      }
    } finally {
      bot.setControlState("forward", false);
    }
    return;
  }
}

async function climbOutFirst(bot: Bot, destination: { y: number }, options: TravelWaitOptions): Promise<void> {
  await stepOffPartialBlock(bot, options);
  const self = bot.entity?.position;
  if (escapeRouteProvider === null || self === undefined || destination.y - self.y < ESCAPE_MIN_RISE) return;
  const route = escapeRouteProvider({ x: self.x, y: self.y, z: self.z }, String(bot.game?.dimension ?? ""));
  if (route === null || route.length === 0) return;
  logger.info({ from: { x: Math.floor(self.x), y: Math.floor(self.y), z: Math.floor(self.z) }, hops: route.length }, "climbing out through the mineshaft first");
  for (const point of route) {
    if (options.signal?.aborted === true || options.shouldAbort?.() === true) return;
    const hop = await withPathfinderDigging(bot, false, () => travelAndWaitImpl(bot, point, { ...options, range: 1.5, timeoutMs: 45_000 }));
    if (hop.status !== "arrived" && hop.status !== "already_there") return;
  }
}

/**
 * A preemption (e.g. the self-defense reflex pausing the task) can end a trip
 * with `failed: GoalChanged` or `aborted` between two `shouldAbort` polls, so
 * the skill never learns it was interrupted and reports an unreachable
 * destination instead. Poll once more when a trip ends short.
 */
function interruptedTrip(result: TravelWaitResult, options: TravelWaitOptions): TravelWaitResult {
  if (result.status === "arrived" || result.status === "already_there") return result;
  return options.signal?.aborted === true || options.shouldAbort?.() === true ? { status: "aborted" } : result;
}

export async function travelHomeAndWait(bot: Bot, home: HomeLocation, options: TravelWaitOptions = {}): Promise<TravelWaitResult> {
  await climbOutFirst(bot, { y: home.y }, options);
  const allowDig = options.allowDig ?? true;
  const result = interruptedTrip(await withPathfinderDigging(bot, allowDig, () => travelHomeAndWaitImpl(bot, home, options)), options);
  if (allowDig || !isNoPath(result)) return result;
  // A no-dig route can be physically impossible (the bot is in a pit or a
  // sealed cave). Digging only natural terrain is always safe, and staying
  // trapped forever is not.
  logger.warn({ home }, "no walkable route home; retrying with natural-terrain digging");
  return interruptedTrip(await withPathfinderDigging(bot, true, () => travelHomeAndWaitImpl(bot, home, { ...options, allowDig: true })), options);
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
  let perchRescues = 0;
  while (distance > range) {
    if (signal.aborted || options.shouldAbort?.() === true) return { status: "aborted" };
    const current = bot.entity;
    if (!current) return { status: "not_ready" };
    const legStart = current.position.clone();
    legNumber += 1;
    const leg = Math.min(TRAVEL_LEG_LENGTH, distance);
    const fraction = leg / distance;
    const finalLeg = distance <= TRAVEL_LEG_LENGTH + range;
    const goalX = current.position.x + (location.x - current.position.x) * fraction;
    const goalZ = current.position.z + (location.z - current.position.z) * fraction;
    // The goal column's own surface: at the bot's altitude a leg across a
    // valley ended in mid-air, the pathfinder bridged out on dirt, and the
    // walk fallback stepped off the bridge (25-block fall, death 3).
    const transitY = legSurfaceY(bot, goalX, goalZ, Math.floor(current.position.y));
    const goal: Location = {
      x: goalX,
      y: finalLeg ? location.y : transitY,
      z: goalZ,
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
    if (result.status === "timed_out" && Date.now() < deadline && (!finalLeg || movedSince(bot, legStart, 2)) && !trappedBelow(bot, location, legStart)) {
      logger.warn({ leg: legNumber, distance: Number(distance.toFixed(1)) }, "travel route leg timed out; retrying from current position");
      const now = bot.entity?.position ?? current.position;
      distance = Math.hypot(now.x - location.x, now.y - location.y, now.z - location.z);
      continue;
    }
    if (result.status !== "arrived" && result.status !== "already_there") {
      // Pathfinder failed. Fall back to dumb-walk toward the destination.
      // Give walkToward a proper budget even if the leg consumed most of the deadline.
      logger.warn({ leg: legNumber, status: result.status, error: result.status === "failed" ? result.error : undefined, position: bot.entity?.position, goal }, "travel route leg failed; attempting walkToward fallback");
      // A no-dig NoPath is answered by the caller's natural-digging retry;
      // blind walking cannot beat an exhaustive A* search.
      if (options.allowDig === false && isNoPath(result)) return result;
      if (signal.aborted || /GoalChanged/.test(result.status === "failed" ? result.error : "")) return result;
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
    if (noProgressLegs >= 2 && perchRescues < MAX_PERCH_RESCUES && await rescueStranded(bot, location, signal)) {
      perchRescues += 1;
      noProgressLegs = 0;
      continue;
    }
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
  await climbOutFirst(bot, location, options);
  const allowDig = options.allowDig ?? true;
  const result = interruptedTrip(await withPathfinderDigging(bot, allowDig, () => travelAndWaitImpl(bot, location, options)), options);
  if (allowDig || !isNoPath(result)) return result;
  logger.warn({ location }, "no walkable route; retrying with natural-terrain digging");
  return interruptedTrip(await withPathfinderDigging(bot, true, () => travelAndWaitImpl(bot, location, { ...options, allowDig: true })), options);
}

/** Distance from which a block's window reliably opens (vanilla reach is ~4.5). */
const STATION_REACH = 4;
/** How close to stand when walking up to a station. */
const STATION_RANGE = 3;
const STATION_TRAVEL_TIMEOUT_MS = 60_000;

/**
 * Walk within reach of a crafting table / furnace before clicking it. A click
 * from beyond reach never opens the window, so every craft or smelt try then
 * burns a 20 s windowOpen timeout. Returns false when the station cannot be
 * reached.
 */
export async function walkIntoReach(bot: Bot, station: { position: Location }, signal?: AbortSignal): Promise<boolean> {
  const self = bot.entity;
  if (!self) return true;
  const { x, y, z } = station.position;
  if (self.position.distanceTo(new Vec3(x + 0.5, y + 0.5, z + 0.5)) <= STATION_REACH) return true;
  const walked = await travelAndWait(bot, station.position, { range: STATION_RANGE, timeoutMs: STATION_TRAVEL_TIMEOUT_MS, signal });
  const reached = walked.status === "arrived" || walked.status === "already_there";
  if (!reached) logger.warn({ station: [x, y, z], status: walked.status }, "could not walk within reach of the station");
  return reached;
}
