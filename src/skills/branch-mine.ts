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
/**
 * Blocks the miner may lay where a step has no floor: filler first, then the
 * cobblestone the stair itself yields. The ground under home was hollowed by
 * old stairs and levelling cuts, and 143 runs in a day stopped on the first
 * step with "no floor" and mined nothing (2026-10-27).
 */
const FLOOR_ITEMS = ["dirt", "coarse_dirt", "andesite", "diorite", "granite", "tuff", "cobbled_deepslate", "cobblestone"];
/**
 * A stair blocked this close above its target depth tunnels from where it
 * stands: one stopped by a cave at y=33 on its way to 16, already in iron
 * country, and climbed 44 steps home with nothing (2026-10-28 17:47).
 */
const STAIR_SETTLE_RANGE = 24;
/**
 * Open cells (of the 26 around a missing floor) past which the gap is a cave,
 * not a hole: bridging down through the cavern under home took the bot into
 * a skeleton and two zombies, unarmored (2026-10-28 19:41).
 */
const CAVE_OPEN_CELLS = 8;
/** Blocks that fall into the opening when the cell under them is dug. */
const FALLING = /^(gravel|sand|red_sand|suspicious_sand|suspicious_gravel|[a-z_]+_concrete_powder)$/;
/** Faces to place a floor block against, the one below first. */
const FLOOR_FACES = [new Vec3(0, -1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1), new Vec3(0, 1, 0)];

/** World actions the miner drives; injectable for tests. */
export interface BranchMineActions {
  dig: (bot: Bot, block: Block, signal?: AbortSignal) => Promise<void>;
  travel: (bot: Bot, to: Vec3, signal?: AbortSignal) => Promise<boolean>;
  collect: (bot: Bot, targets: Block[], drop: string, target: number, signal?: AbortSignal) => Promise<void>;
  torch: (bot: Bot, floor: Block, at: Vec3, signal?: AbortSignal) => Promise<void>;
  /** Drop surplus junk (see `shedJunk`) so tunnel stone never crowds out the ore. */
  shed: (bot: Bot, protect: readonly string[], signal?: AbortSignal) => Promise<number>;
  /** Lay a block at `at` (an open cell under a step); false when there is nothing to lay or lean it on. */
  floor: (bot: Bot, at: Vec3, signal?: AbortSignal) => Promise<boolean>;
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
  floor: async (bot, at, signal) => {
    const item = FLOOR_ITEMS.map((name) => findItem(bot, name)).find((found) => found !== null) ?? null;
    if (item === null) return false;
    for (const face of FLOOR_FACES) {
      const reference = bot.blockAt(at.plus(face));
      if (reference === null || reference.boundingBox !== "block") continue;
      await equipItem(bot, item, signal);
      await placeBlock(bot, reference, face.scaled(-1), signal, at, item.name);
      return true;
    }
    return false;
  },
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
  /** Where the stair began; set by branchMine itself. */
  startY?: number;
}

/**
 * Cobblestone this far below the stair's top is the bot's own patchwork
 * from earlier climbs, not a build: a stair stopped 32 cells down on it and
 * the iron run came back empty (2026-10-22 20:08).
 */
const OWN_COBBLE_DEPTH = 8;

export interface BranchMineResult {
  mined: number;
  reason: string;
}

/** How far a new stair moves when the ground under the last one is hollow. */
const ENTRANCE_SHIFT = 16;
/** Solid cells under a mine entrance before it counts as rock, not a cave roof. */
const ENTRANCE_SOLID_DEPTH = 6;
/** Feet heights searched around the start for the entrance's ground. */
const ENTRANCE_SEARCH_DY = 10;

/**
 * A spot about 16 blocks out with solid rock under it, to start a stair
 * where the last one met a cave: home sits on a cavern, and every stair from
 * it either stopped at once or bridged down into mobs (2026-10-28).
 */
export function pickMineEntrance(blockAt: (p: Vec3) => { name: string; boundingBox: string } | null, from: Vec3): Vec3 | null {
  const solid = (p: Vec3): boolean => {
    const block = blockAt(p);
    return block !== null && block.boundingBox === "block" && !/water|lava|_leaves$|_log$/.test(block.name);
  };
  const open = (p: Vec3): boolean => {
    const block = blockAt(p);
    return block !== null && block.boundingBox !== "block" && !/water|lava/.test(block.name);
  };
  for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [-1, -1], [1, -1]] as const) {
    const x = from.x + dx * ENTRANCE_SHIFT;
    const z = from.z + dz * ENTRANCE_SHIFT;
    for (let y = from.y + ENTRANCE_SEARCH_DY; y >= from.y - ENTRANCE_SEARCH_DY; y--) {
      const feet = new Vec3(x, y, z);
      if (!open(feet) || !open(feet.offset(0, 1, 0)) || !solid(feet.offset(0, -1, 0))) continue;
      let rock = true;
      for (let d = 2; d <= ENTRANCE_SOLID_DEPTH + 1 && rock; d++) rock = solid(feet.offset(0, -d, 0));
      if (rock) return feet;
      break;
    }
  }
  return null;
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
  o = { ...o, startY: feet0.y };
  // Start down whichever way the first steps stay clear of water and lava,
  // preferring one that already has a floor to land on.
  const dry = DIRECTIONS.filter((d) => stepCells(feet0, d, true).every((cell) => !cellTouchesLiquid(bot, cell) && !isLiquid(bot, cell)));
  let dir = dry.find((d) => bot.blockAt(stepCells(feet0, d, true)[0]!.offset(0, -1, 0))?.boundingBox === "block") ?? dry[0] ?? null;
  if (dir === null) return { mined: 0, reason: "water or lava on every side" };
  logger.info({ from: feet0, dir, targetY: o.targetY, drop: o.drop }, "branch mine: digging down");

  // Staircase down.
  while ((bot.entity?.position.y ?? o.targetY) > o.targetY + 0.5) {
    const stop = stopNow();
    if (stop !== null) return done(stop);
    const stepped = await step(o, dir, true);
    if (stepped !== null) {
      const turned = await turn(o, dir, true);
      if (turned === null) {
        if ((bot.entity?.position.y ?? Infinity) > o.targetY + STAIR_SETTLE_RANGE) return done(`stair blocked: ${stepped}`);
        logger.info({ at: bot.entity?.position.floored(), why: stepped }, "branch mine: stair blocked near depth; tunnelling here");
        break;
      }
      dir = turned;
    }
    trail.push(bot.entity!.position.floored());
    await mineVisibleOre(o);
  }

  // Tunnel.
  // Only steps that dig count toward the length. Each run starts from the
  // same spot and heading, so every repeat walked the last run's tunnel and
  // found nothing: 0 iron twice in a row (2026-10-22 19:25-19:28). Counting
  // fresh rock extends the old tunnel instead; the walk is capped in case
  // it wanders through open cave.
  logger.info({ at: bot.entity?.position.floored(), dir }, "branch mine: tunnelling");
  let digs = 0;
  const counting: BranchMineOptions = { ...o, actions: { ...act(o), dig: async (b, block, signal) => { digs += 1; await act(o).dig(b, block, signal); } } };
  for (let n = 0, walked = 0; n < o.tunnelLength && walked < o.tunnelLength * 4; walked++) {
    const stop = stopNow();
    if (stop !== null) return done(stop);
    const before = digs;
    const stepped = await step(counting, dir, false);
    if (stepped !== null) {
      const turned = await turn(counting, dir, false);
      if (turned === null) return done(`tunnel blocked: ${stepped}`);
      dir = turned;
    }
    trail.push(bot.entity!.position.floored());
    if (digs === before) continue;
    n += 1;
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
  // Ore pickups pull the bot off the trail, so join it at the nearest cell
  // and skip one cell that will not take a step. Stalling on the first leg
  // left the bot digging a new stair up from y=15 (2026-10-22 19:41).
  const here = o.bot.entity?.position;
  let start = trail.length - 2;
  if (here !== undefined) {
    let best = Infinity;
    for (let i = 0; i < trail.length; i++) {
      const d = trail[i]!.offset(0.5, 0, 0.5).distanceTo(here);
      if (d <= best) { best = d; start = i; }
    }
    if (start === trail.length - 1 && best < 1) start -= 1;
  }
  let walked = 0;
  let misses = 0;
  for (let i = start; i >= 0; i--) {
    if (o.signal?.aborted === true) break;
    const cell = trail[i]!;
    if (!await act(o).travel(o.bot, new Vec3(cell.x + 0.5, cell.y, cell.z + 0.5), o.signal)) {
      if (++misses < 2) continue;
      o.logger.warn({ at: cell, walked }, "branch mine: retrace stalled; leaving the rest to the trip home");
      break;
    }
    misses = 0;
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
  if (bot.blockAt(floor)?.boundingBox !== "block" && !await layFloor(o, floor)) return "no floor (a cave or drop)";
  // Gravel over the opening pours into the bot's head cell: a tunnel through
  // a gravel seam at y=15 buried and suffocated it in full kit (2026-10-28 18:40).
  if (FALLING.test(bot.blockAt(cells[cells.length - 1]!.offset(0, 1, 0))?.name ?? "")) return "loose gravel or sand overhead";
  for (const cell of cells) {
    if (isLiquid(bot, cell) || cellTouchesLiquid(bot, cell)) return "water or lava beside the way";
    const block = bot.blockAt(cell);
    if (block === null) return "unloaded";
    if (block.boundingBox !== "block") continue;
    const ownCobble = /^cobble(stone|d_deepslate)$/.test(block.name) && o.startY !== undefined && cell.y <= o.startY - OWN_COBBLE_DEPTH;
    if ((!isNaturalBlock(block.name) && !ownCobble) || block.name === "bedrock") return `${block.name} in the way`;
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

/** Close an open cell under a step with a carried block. */
async function layFloor(o: BranchMineOptions, at: Vec3): Promise<boolean> {
  const block = o.bot.blockAt(at);
  if (block === null || isLiquid(o.bot, at)) return false;
  if (openCellsAround(o.bot, at) > CAVE_OPEN_CELLS) return false;
  try {
    if (!await act(o).floor(o.bot, at, o.signal)) return false;
  } catch (err) {
    if (o.signal?.aborted === true) throw err;
    o.logger.warn({ at, err: String(err) }, "branch mine: could not lay a floor");
    return false;
  }
  const laid = o.bot.blockAt(at)?.boundingBox === "block";
  if (laid) o.logger.info({ at }, "branch mine: laid a floor over a gap");
  return laid;
}

/** Non-solid cells among the 26 around `at` (unloaded counts as open). */
function openCellsAround(bot: Bot, at: Vec3): number {
  let open = 0;
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
    if (dx === 0 && dy === 0 && dz === 0) continue;
    if (bot.blockAt(at.offset(dx, dy, dz))?.boundingBox !== "block") open += 1;
  }
  return open;
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
