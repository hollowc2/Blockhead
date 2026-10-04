import type { Bot } from "mineflayer";
import type { Logger } from "pino";
import { Vec3 } from "vec3";
import { craftItem, craftSticks } from "../minecraft/crafting.js";
import { bareName, countItem, findItem } from "../minecraft/inventory.js";
import type { HomeLocation } from "../minecraft/movement.js";
import { travelAndWait } from "../minecraft/movement.js";
import { cancelCollection, collectBlockOperation, digBlock, equipItem, useHeldItemOn } from "../minecraft/primitives.js";
import { findBlockNear, findBlocksNear } from "../minecraft/world.js";
import { withTimeout } from "./skill-library.js";

/**
 * A wheat farm beside home: the food source that does not run out. Animals
 * near home are eaten and never respawn, so a bot that only hunts walks
 * farther every day. `tendFarm` runs at home at the start of each food run:
 * harvest ripe wheat, bake it into bread, gather seeds from grass, till
 * soil, and plant. Every step is best effort and bounded; a missing hoe or
 * table only skips the steps that need it.
 */

/** Half-width of the square plot: offsets -2..2 -> 5x5 = 25 cells. */
const PLOT_HALF = 2;
/**
 * Plot centers, as offsets from home. Eight blocks clears the base walls
 * (3 out) and the fixtures around them; +Z is the base door, so no plot
 * sits in front of it.
 */
const PLOT_OFFSETS: ReadonlyArray<{ dx: number; dz: number }> = [
  { dx: -8, dz: 0 },
  { dx: 8, dz: 0 },
  { dx: 0, dz: -8 },
];
/** Ground may sit this far above/below home's Y and still count. */
const GROUND_SEARCH_DY = 3;
/** Farmland within this horizontal distance of water is hydrated (vanilla). */
const HYDRATION_RANGE = 4;
/** Fully grown wheat. */
const WHEAT_MATURE_AGE = 7;
/** Bread is three wheat in a row. */
const WHEAT_PER_BREAD = 3;
/** Grass blocks broken per run looking for seeds (each drops one 1/8 of the time). */
const SEED_GRASS_PER_RUN = 24;
const SEED_SEARCH_RADIUS = 24;
const TABLE_SCAN_RADIUS = 16;
/** Reach for right-clicking a farm cell. */
const WORK_RANGE = 3;
const CELL_TRAVEL_TIMEOUT_MS = 20_000;
const COLLECT_TIMEOUT_MS = 60_000;
const VERIFY_TIMEOUT_MS = 1_000;
const VERIFY_POLL_MS = 100;
/** Below this hunger the run skips sowing and goes straight to the hunt. */
const STARVING_HUNGER = 6;

const TILLABLE = new Set(["grass_block", "dirt", "dirt_path", "coarse_dirt"]);
/** Plants that sit on soil and break in one hit; cleared before tilling. */
const CLEARABLE_PLANT = /^(?:short_grass|grass|tall_grass|fern|large_fern|dandelion|poppy|azure_bluet|oxeye_daisy|cornflower|allium|blue_orchid|[a-z_]+_tulip|lily_of_the_valley|dead_bush)$/;
const SEED_GRASS = new Set(["short_grass", "grass", "tall_grass", "fern", "large_fern"]);

export interface FarmBlock {
  name: string;
  /** Crop growth stage, when the block has one. */
  age?: number;
}

/** Bare block name (plus crop age) at a position, or null where unloaded. */
export type FarmLookup = (x: number, y: number, z: number) => FarmBlock | null;

export interface FarmCell {
  /** The soil block (farmland, or soil that can be tilled). */
  x: number;
  y: number;
  z: number;
  soil: "farmland" | "tillable";
  /** What sits on the soil: "air", "wheat", or a clearable plant name. */
  above: string;
  /** Wheat growth stage when `above` is wheat. */
  age?: number;
  hydrated: boolean;
}

function isAirName(name: string): boolean {
  return name === "air" || name === "cave_air";
}

/** The workable soil block in one column near `baseY`, or null. */
function soilCell(lookup: FarmLookup, x: number, baseY: number, z: number): FarmCell | null {
  for (let y = baseY + GROUND_SEARCH_DY; y >= baseY - GROUND_SEARCH_DY; y--) {
    const soil = lookup(x, y, z);
    if (soil === null) continue;
    const isFarmland = soil.name === "farmland";
    if (!isFarmland && !TILLABLE.has(soil.name)) continue;
    const above = lookup(x, y + 1, z);
    if (above === null) return null;
    const aboveName = isAirName(above.name) ? "air" : above.name;
    // Farmland holds a crop; tillable soil needs open air (or a plant we clear).
    if (isFarmland && aboveName !== "air" && aboveName !== "wheat") return null;
    if (!isFarmland && aboveName !== "air" && !CLEARABLE_PLANT.test(aboveName)) return null;
    return {
      x, y, z,
      soil: isFarmland ? "farmland" : "tillable",
      above: aboveName,
      age: aboveName === "wheat" ? above.age : undefined,
      hydrated: false,
    };
  }
  return null;
}

function hasWaterNear(lookup: FarmLookup, x: number, y: number, z: number): boolean {
  for (let dx = -HYDRATION_RANGE; dx <= HYDRATION_RANGE; dx++) {
    for (let dz = -HYDRATION_RANGE; dz <= HYDRATION_RANGE; dz++) {
      for (let dy = 0; dy <= 1; dy++) {
        if (lookup(x + dx, y + dy, z + dz)?.name === "water") return true;
      }
    }
  }
  return false;
}

/** Every workable cell of the plot centered `offset` from home. */
function plotCells(home: { x: number; y: number; z: number }, offset: { dx: number; dz: number }, lookup: FarmLookup): FarmCell[] {
  const cx = Math.floor(home.x) + offset.dx;
  const cz = Math.floor(home.z) + offset.dz;
  const baseY = Math.floor(home.y);
  const cells: FarmCell[] = [];
  for (let dx = -PLOT_HALF; dx <= PLOT_HALF; dx++) {
    for (let dz = -PLOT_HALF; dz <= PLOT_HALF; dz++) {
      const cell = soilCell(lookup, cx + dx, baseY, cz + dz);
      if (cell === null) continue;
      cell.hydrated = hasWaterNear(lookup, cell.x, cell.y, cell.z);
      cells.push(cell);
    }
  }
  return cells;
}

/**
 * The farm's cells: the candidate plot that already holds the most farmland
 * (so the choice is stable once farming starts), else the one with the most
 * workable soil, preferring water nearby (hydrated wheat grows faster).
 * Pure over `lookup`.
 */
export function chooseFarmCells(home: { x: number; y: number; z: number }, lookup: FarmLookup): FarmCell[] {
  let best: FarmCell[] = [];
  let bestScore = 0;
  for (const offset of PLOT_OFFSETS) {
    const cells = plotCells(home, offset, lookup);
    let score = 0;
    for (const cell of cells) {
      score += cell.soil === "farmland" ? 100 : 1;
      if (cell.hydrated) score += 1;
    }
    if (score > bestScore) {
      best = cells;
      bestScore = score;
    }
  }
  return best;
}

export function isMatureWheat(cell: FarmCell): boolean {
  return cell.above === "wheat" && (cell.age ?? 0) >= WHEAT_MATURE_AGE;
}

/** Cells to sow, in order: empty farmland first, then soil to till. */
export function sowingOrder(cells: readonly FarmCell[]): FarmCell[] {
  const empty = cells.filter((c) => c.soil === "farmland" && c.above === "air");
  const fresh = cells.filter((c) => c.soil === "tillable").sort((a, b) => Number(b.hydrated) - Number(a.hydrated));
  return [...empty, ...fresh];
}

export interface TendFarmOptions {
  bot: Bot;
  home: HomeLocation;
  logger: Logger;
  signal?: AbortSignal;
  shouldAbort?: () => boolean;
}

export interface TendFarmResult {
  harvested: number;
  bread: number;
  tilled: number;
  planted: number;
}

function botLookup(bot: Bot): FarmLookup {
  return (x, y, z) => {
    const block = bot.blockAt(new Vec3(x, y, z));
    if (block === null) return null;
    const age = Number(block.getProperties?.()?.age);
    return { name: bareName(block.name), age: Number.isFinite(age) ? age : undefined };
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function waitForBlock(bot: Bot, pos: Vec3, name: string): Promise<boolean> {
  const deadline = Date.now() + VERIFY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (bot.blockAt(pos)?.name === name) return true;
    await sleep(VERIFY_POLL_MS);
  }
  return bot.blockAt(pos)?.name === name;
}

function findHoe(bot: Bot) {
  for (const name of ["netherite_hoe", "diamond_hoe", "iron_hoe", "stone_hoe", "wooden_hoe"]) {
    const item = findItem(bot, name);
    if (item !== null) return item;
  }
  return null;
}

/**
 * One pass over the farm. Harvests ripe wheat, bakes bread at the home
 * table, gathers seeds from grass when short, tills and plants as many cells
 * as seeds allow (bare farmland with no crop reverts to dirt, so nothing is
 * tilled ahead of its seed). Never throws for a world refusal; the caller's
 * abort signal still propagates.
 */
export async function tendFarm(opts: TendFarmOptions): Promise<TendFarmResult> {
  const { bot, home, logger, signal } = opts;
  const result: TendFarmResult = { harvested: 0, bread: 0, tilled: 0, planted: 0 };
  const aborted = (): boolean => signal?.aborted === true || opts.shouldAbort?.() === true;
  const lookup = botLookup(bot);
  const collect = async (positions: Vec3[]): Promise<void> => {
    const blocks = positions.map((p) => bot.blockAt(p)).filter((b) => b !== null);
    if (blocks.length === 0) return;
    try {
      await withTimeout(COLLECT_TIMEOUT_MS, collectBlockOperation(bot, blocks, { ignoreNoPath: true }, signal), async () => {
        await cancelCollection(bot);
      }, signal);
    } catch (err) {
      if (signal?.aborted === true) throw err;
      logger.warn({ err: String(err) }, "farm: collection pass failed");
    }
  };

  // 1. Harvest. Collecting the crop breaks it and picks up wheat + seeds.
  let cells = chooseFarmCells(home, lookup);
  const ripe = cells.filter(isMatureWheat).map((c) => new Vec3(c.x, c.y + 1, c.z));
  if (ripe.length > 0) {
    const before = countItem(bot, "wheat");
    await collect(ripe);
    result.harvested = Math.max(0, countItem(bot, "wheat") - before);
  }
  if (aborted()) return result;

  // 2. Bake. Wheat is not edible; bread is.
  const table = findBlockNear(bot, "crafting_table", TABLE_SCAN_RADIUS);
  const loaves = Math.floor(countItem(bot, "wheat") / WHEAT_PER_BREAD);
  if (loaves > 0 && table !== null) {
    if (bot.entity !== null && bot.entity.position.distanceTo(table.position) > WORK_RANGE) {
      await travelAndWait(bot, table.position, { range: WORK_RANGE, timeoutMs: CELL_TRAVEL_TIMEOUT_MS, shouldAbort: opts.shouldAbort, signal });
    }
    const baked = await craftItem(bot, "bread", { times: loaves, craftingTable: table, signal });
    if (baked.ok) result.bread = baked.crafted;
    else logger.warn({ reason: baked.reason }, "farm: could not bake bread");
  }
  if (aborted()) return result;
  // Starving: sowing pays off a day from now, the hunt pays off today.
  if (bot.food < STARVING_HUNGER) return result;

  // 3. Seeds for every open cell, from grass around home.
  cells = chooseFarmCells(home, lookup);
  const toSow = sowingOrder(cells);
  if (toSow.length === 0) return result;
  if (countItem(bot, "wheat_seeds") < toSow.length) {
    const grass = findBlocksNear(bot, (b) => SEED_GRASS.has(bareName(b.name)), SEED_SEARCH_RADIUS, SEED_GRASS_PER_RUN);
    await collect(grass);
    if (aborted()) return result;
  }

  // 4. A hoe, when there is soil to till and seeds to put in it.
  const needsTilling = toSow.slice(0, countItem(bot, "wheat_seeds")).some((c) => c.soil === "tillable");
  if (needsTilling && findHoe(bot) === null && table !== null) {
    if (countItem(bot, "stick") < 2) await craftSticks(bot, 2, signal);
    const hoe = countItem(bot, "cobblestone") >= 2
      ? await craftItem(bot, "stone_hoe", { craftingTable: table, signal })
      : await craftItem(bot, "wooden_hoe", { craftingTable: table, signal });
    if (!hoe.ok) logger.warn({ reason: hoe.reason }, "farm: could not craft a hoe");
  }

  // 5. Till and plant, one cell at a time.
  for (const cell of toSow) {
    if (aborted() || countItem(bot, "wheat_seeds") === 0) break;
    const soilPos = new Vec3(cell.x, cell.y, cell.z);
    const self = bot.entity;
    if (self === null) break;
    if (self.position.distanceTo(soilPos.offset(0.5, 1, 0.5)) > WORK_RANGE) {
      const walked = await travelAndWait(bot, soilPos.offset(0, 1, 0), { range: WORK_RANGE - 1, timeoutMs: CELL_TRAVEL_TIMEOUT_MS, shouldAbort: opts.shouldAbort, signal });
      if (walked.status !== "arrived" && walked.status !== "already_there") continue;
    }
    try {
      if (bareName(bot.blockAt(soilPos)?.name ?? "") !== "farmland") {
        const hoe = findHoe(bot);
        if (hoe === null) continue;
        const plant = bot.blockAt(soilPos.offset(0, 1, 0));
        if (plant !== null && CLEARABLE_PLANT.test(bareName(plant.name))) await digBlock(bot, plant, signal);
        await equipItem(bot, hoe, signal);
        const soil = bot.blockAt(soilPos);
        if (soil === null) continue;
        await useHeldItemOn(bot, soil, new Vec3(0, 1, 0), "farmland", signal);
        if (!(await waitForBlock(bot, soilPos, "farmland"))) continue;
        result.tilled += 1;
      }
      const seeds = findItem(bot, "wheat_seeds");
      const farmland = bot.blockAt(soilPos);
      if (seeds === null || farmland === null) break;
      await equipItem(bot, seeds, signal);
      await useHeldItemOn(bot, farmland, new Vec3(0, 1, 0), "wheat", signal);
      if (await waitForBlock(bot, soilPos.offset(0, 1, 0), "wheat")) result.planted += 1;
    } catch (err) {
      if (signal?.aborted === true) throw err;
      logger.warn({ cell: [cell.x, cell.y, cell.z], err: String(err) }, "farm: cell work failed");
    }
  }
  return result;
}
