import type { Bot } from "mineflayer";
import type { Block } from "prismarine-block";
import type { Logger } from "pino";
import { Vec3 } from "vec3";
import { cellTouchesLiquid, equipDigTool, travelAndWait } from "../minecraft/movement.js";
import { collectBlocks, hasAirNeighbor } from "../minecraft/world.js";
import { countItem, findItem } from "../minecraft/inventory.js";
import { digBlock, equipItem, placeBlock, shedJunk } from "../minecraft/primitives.js";
import { isNaturalBlock } from "../minecraft/natural-blocks.js";

/**
 * Branch mining: a staircase down to ore depth, then a straight 1x2 tunnel,
 * mining every ore its walls expose. Cave ore is the only ore the collector
 * could see, and cave trips kept ending in drowned, zombie and skeleton
 * fights (2026-10-22: two deaths and nine interrupted iron runs in an hour).
 * A tunnel the bot digs itself is enclosed, lit as it goes, and never opened
 * into water or lava.
 */

/** Best depth to tunnel for each ore (1.18+ distributions, kept above deepslate where possible). */
export const BRANCH_MINE_DEPTH: Readonly<Record<string, number>> = {
  iron_ore: 16,
  coal_ore: 48,
  copper_ore: 48,
  gold_ore: -16,
  redstone_ore: -32,
  lapis_lazuli_ore: 0,
  diamond_ore: -54,
};

const DIRECTIONS: readonly (readonly [number, number])[] = [[1, 0], [0, 1], [-1, 0], [0, -1]];
/** Steps between torches in the tunnel. */
const TORCH_EVERY = 8;
/** Ore this close to the eyes is mined from where the bot stands. */
const ORE_REACH = 4.5;
const STEP_TIMEOUT_MS = 6_000;
const COLLECT_TIMEOUT_MS = 30_000;
/** Below this health the miner stops and lets the caller head home. */
const MIN_HEALTH = 10;

/** World actions the miner drives; injectable for tests. */
export interface BranchMineActions {
  dig: (bot: Bot, block: Block, signal?: AbortSignal) => Promise<void>;
  travel: (bot: Bot, to: Vec3, signal?: AbortSignal) => Promise<boolean>;
  collect: (bot: Bot, targets: Block[], drop: string, target: number, signal?: AbortSignal) => Promise<void>;
  torch: (bot: Bot, floor: Block, at: Vec3, signal?: AbortSignal) => Promise<void>;
  /** Drop surplus junk (see `shedJunk`) so tunnel stone never crowds out the ore. */
  shed: (bot: Bot, protect: readonly string[], signal?: AbortSignal) => Promise<number>;
}

const DEFAULT_ACTIONS: BranchMineActions = {
  dig: async (bot, block, signal) => {
    await equipDigTool(bot, block, signal);
    await digBlock(bot, block, signal);
  },
  travel: async (bot, to, signal) => {
    const travel = await travelAndWait(bot, to, { range: 0.6, timeoutMs: STEP_TIMEOUT_MS, signal });
    return travel.status === "arrived" || travel.status === "already_there";
  },
  collect: async (bot, targets, drop, target, signal) => {
    await collectBlocks(bot, targets, () => countItem(bot, drop), target, () => {}, COLLECT_TIMEOUT_MS, undefined, signal);
  },
  torch: async (bot, floor, at, signal) => {
    const torch = findItem(bot, "torch");
    if (torch === null) return;
    await equipItem(bot, torch, signal);
    await placeBlock(bot, floor, new Vec3(0, 1, 0), signal, at, "torch");
  },
  shed: (bot, protect, signal) => shedJunk(bot, protect, signal),
};

export interface BranchMineOptions {
  bot: Bot;
  actions?: Partial<BranchMineActions>;
  logger: Logger;
  /** Matches the ore block (and its deepslate variant). */
  isOre: (block: Block) => boolean;
  /** Item the ore drops ("raw_iron"). */
  drop: string;
  /** Total `drop` count to stop at. */
  target: number;
  targetY: number;
  tunnelLength: number;
  deadline: number;
  signal?: AbortSignal;
  shouldStop?: () => boolean;
}

export interface BranchMineResult {
  mined: number;
  reason: string;
}

/** Cells a step from `feet` toward `dir` must open: the landing cell, head room, and one above while stepping down. */
export function stepCells(feet: { x: number; y: number; z: number }, dir: readonly [number, number], down: boolean): Vec3[] {
  const x = feet.x + dir[0];
  const z = feet.z + dir[1];
  const y = down ? feet.y - 1 : feet.y;
  const cells = [new Vec3(x, y, z), new Vec3(x, y + 1, z)];
  if (down) cells.push(new Vec3(x, y + 2, z));
  return cells;
}

export async function branchMine(o: BranchMineOptions): Promise<BranchMineResult> {
  const { bot, logger } = o;
  const startCount = countItem(bot, o.drop);
  const mined = (): number => countItem(bot, o.drop) - startCount;
  // Every cell stood in, so the way back is the way in: a pathfinder search
  // up from 50 blocks down timed out ("Took too long to decide path").
  const trail: Vec3[] = [];
  const done = async (reason: string): Promise<BranchMineResult> => {
    const back = await retrace(o, trail);
    logger.info({ drop: o.drop, mined: mined(), reason, retraced: back }, "branch mine finished");
    return { mined: mined(), reason };
  };
  const stopNow = (): string | null => {
    if (o.signal?.aborted === true || o.shouldStop?.() === true) return "interrupted";
    if (Date.now() > o.deadline) return "time budget spent";
    if (bot.health < MIN_HEALTH) return `health ${bot.health} too low to keep mining`;
    if (countItem(bot, o.drop) >= o.target) return "target reached";
    return null;
  };
  if (!bot.inventory.items().some((item) => item.name.endsWith("_pickaxe"))) return { mined: 0, reason: "no pickaxe" };

  const feet0 = bot.entity?.position.floored();
  if (feet0 === undefined) return { mined: 0, reason: "not spawned" };
  trail.push(feet0);
  // Start down whichever way the first steps stay clear of water and lava.
  let dir = DIRECTIONS.find((d) => stepCells(feet0, d, true).every((cell) => !cellTouchesLiquid(bot, cell) && !isLiquid(bot, cell))) ?? null;
  if (dir === null) return { mined: 0, reason: "water or lava on every side" };
  logger.info({ from: feet0, dir, targetY: o.targetY, drop: o.drop }, "branch mine: digging down");

  // Staircase down.
  while ((bot.entity?.position.y ?? o.targetY) > o.targetY + 0.5) {
    const stop = stopNow();
    if (stop !== null) return done(stop);
    const stepped = await step(o, dir, true);
    if (stepped !== null) {
      const turned = await turn(o, dir, true);
      if (turned === null) return done(`stair blocked: ${stepped}`);
      dir = turned;
    }
    trail.push(bot.entity!.position.floored());
    await mineVisibleOre(o);
  }

  // Tunnel.
  logger.info({ at: bot.entity?.position.floored(), dir }, "branch mine: tunnelling");
  for (let n = 1; n <= o.tunnelLength; n++) {
    const stop = stopNow();
    if (stop !== null) return done(stop);
    const stepped = await step(o, dir, false);
    if (stepped !== null) {
      const turned = await turn(o, dir, false);
      if (turned === null) return done(`tunnel blocked: ${stepped}`);
      dir = turned;
    }
    trail.push(bot.entity!.position.floored());
    await mineVisibleOre(o);
    if (n % TORCH_EVERY === 0) await placeTorch(o, dir);
    await act(o).shed(bot, [o.drop], o.signal).catch((err) => {
      if (o.signal?.aborted === true) throw err;
      o.logger.warn({ err: String(err) }, "branch mine: could not shed junk");
    });
  }
  return done("tunnel finished");
}

/**
 * Walk the trail back to its start, one cell at a time. Ore pickups can pull
 * the bot a step aside, so each leg is a short trip. Returns cells walked.
 */
async function retrace(o: BranchMineOptions, trail: readonly Vec3[]): Promise<number> {
  let walked = 0;
  for (let i = trail.length - 2; i >= 0; i--) {
    if (o.signal?.aborted === true) break;
    const cell = trail[i]!;
    if (!await act(o).travel(o.bot, new Vec3(cell.x + 0.5, cell.y, cell.z + 0.5), o.signal)) {
      o.logger.warn({ at: cell, walked }, "branch mine: retrace stalled; leaving the rest to the trip home");
      break;
    }
    walked += 1;
  }
  return walked;
}

function act(o: BranchMineOptions): BranchMineActions {
  return { ...DEFAULT_ACTIONS, ...o.actions };
}

function isLiquid(bot: Bot, cell: Vec3): boolean {
  return /water|lava/.test(bot.blockAt(cell)?.name ?? "");
}

/** Try the side directions when the way ahead is unsafe. */
async function turn(o: BranchMineOptions, dir: readonly [number, number], down: boolean): Promise<readonly [number, number] | null> {
  for (const side of [[dir[1], -dir[0]], [-dir[1], dir[0]]] as const) {
    if (await step(o, side, down) === null) return side;
  }
  return null;
}

/** Open the step's cells and walk into it. Null on success, else why not. */
async function step(o: BranchMineOptions, dir: readonly [number, number], down: boolean): Promise<string | null> {
  const { bot } = o;
  const feet = bot.entity?.position.floored();
  if (feet === undefined) return "not spawned";
  const cells = stepCells(feet, dir, down);
  const floor = cells[0]!.offset(0, -1, 0);
  const floorBlock = bot.blockAt(floor);
  if (floorBlock === null || floorBlock.boundingBox !== "block") return "no floor (a cave or drop)";
  for (const cell of cells) {
    if (isLiquid(bot, cell) || cellTouchesLiquid(bot, cell)) return "water or lava beside the way";
    const block = bot.blockAt(cell);
    if (block === null) return "unloaded";
    if (block.boundingBox !== "block") continue;
    if (!isNaturalBlock(block.name) || block.name === "bedrock") return `${block.name} in the way`;
    try {
      await act(o).dig(bot, block, o.signal);
    } catch (err) {
      return `dig failed: ${String(err)}`;
    }
  }
  const target = cells[0]!;
  if (!await act(o).travel(bot, new Vec3(target.x + 0.5, target.y, target.z + 0.5), o.signal)) return "could not step";
  return null;
}

/** Mine exposed ore within reach, skipping any that would open water or lava. */
async function mineVisibleOre(o: BranchMineOptions): Promise<void> {
  const { bot } = o;
  const eyes = bot.entity?.position.offset(0, 1.62, 0);
  if (eyes === undefined) return;
  const positions = bot.findBlocks({ matching: (block: Block) => o.isOre(block), maxDistance: Math.ceil(ORE_REACH), count: 16 });
  const targets = positions
    .filter((position) => position.offset(0.5, 0.5, 0.5).distanceTo(eyes) <= ORE_REACH && hasAirNeighbor(bot, position) && !cellTouchesLiquid(bot, position))
    .map((position) => bot.blockAt(position))
    .filter((block): block is Block => block !== null);
  if (targets.length === 0) return;
  o.logger.info({ ores: targets.length, at: bot.entity?.position.floored() }, "branch mine: ore in the walls");
  await act(o).collect(bot, targets, o.drop, o.target, o.signal).catch((err) => {
    if (o.signal?.aborted === true) throw err;
    o.logger.warn({ err: String(err) }, "branch mine: ore collection failed");
  });
}

/** Light the tunnel: a torch on the floor one step back, best effort. */
async function placeTorch(o: BranchMineOptions, dir: readonly [number, number]): Promise<void> {
  const { bot } = o;
  const feet = bot.entity?.position.floored();
  if (feet === undefined) return;
  const behind = feet.offset(-dir[0], 0, -dir[1]);
  const floor = bot.blockAt(behind.offset(0, -1, 0));
  if (floor === null || floor.boundingBox !== "block" || bot.blockAt(behind)?.name !== "air") return;
  try {
    await act(o).torch(bot, floor, behind, o.signal);
  } catch (err) {
    if (o.signal?.aborted === true) throw err;
    o.logger.warn({ err: String(err) }, "branch mine: torch placement failed");
  }
}
