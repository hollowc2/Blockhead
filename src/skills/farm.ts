import type { Bot } from "mineflayer";
import type { Block } from "prismarine-block";
import type { Logger } from "pino";
import { Vec3 } from "vec3";
import { craftCraftingTable, craftItem, craftPlanks, craftSpeciesPlanks, craftSticks } from "../minecraft/crafting.js";
import { bareName, countItem, countPlanks, findItem } from "../minecraft/inventory.js";
import type { HomeLocation } from "../minecraft/movement.js";
import { travelAndWait, walkIntoReach } from "../minecraft/movement.js";
import { digBlock, equipItem, useHeldItemOn } from "../minecraft/primitives.js";
import { collectBlocks, findBlockNear, findBlocksNear, findPlacementSpot, placeItemAt } from "../minecraft/world.js";

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
/**
 * How far out land development lays plots (rings every 8 blocks, out to
 * 48). Three rings (24 blocks) were all developed by 21:46 on 2026-10-05
 * and the bot stood idle; nearest-first order keeps growth compact.
 */
const DEVELOP_RINGS = 6;

export interface PlotOffset { dx: number; dz: number }

/**
 * Plot centers for land development, nearest ring first: the three home
 * plots, then every 8-block grid point on the square rings at 16 and 24
 * blocks. The ring-1 front (+Z, the base door) stays open.
 */
export function developmentPlots(rings = DEVELOP_RINGS): PlotOffset[] {
  const plots: PlotOffset[] = [...PLOT_OFFSETS];
  for (let ring = 2; ring <= rings; ring++) {
    const r = ring * 8;
    const ringPlots: PlotOffset[] = [];
    for (let dx = -r; dx <= r; dx += 8) {
      for (let dz = -r; dz <= r; dz += 8) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) === r) ringPlots.push({ dx, dz });
      }
    }
    ringPlots.sort((a, b) => Math.hypot(a.dx, a.dz) - Math.hypot(b.dx, b.dz));
    plots.push(...ringPlots);
  }
  return plots;
}

function sameOffset(a: PlotOffset, b: PlotOffset): boolean {
  return a.dx === b.dx && a.dz === b.dz;
}
/**
 * Each column is scanned top-down this far above/below home's Y for its
 * surface soil. Wide on purpose: the persisted home Y can drift (a pit under
 * the base once snapped it ten blocks down) while the plots stay on the
 * surface.
 */
const GROUND_SEARCH_DY = 12;
/** Farmland within this horizontal distance of water is hydrated (vanilla). */
const HYDRATION_RANGE = 4;
/** Fully grown wheat. */
const WHEAT_MATURE_AGE = 7;
/** Bread is three wheat in a row. */
const WHEAT_PER_BREAD = 3;
/** Grass blocks broken per run looking for seeds (each drops one 1/8 of the time). */
const SEED_GRASS_PER_RUN = 48;
const SEED_SEARCH_RADIUS = 24;
const TABLE_SCAN_RADIUS = 16;
/** A crafting table is four planks. */
const TABLE_PLANK_COST = 4;
/** Reach for right-clicking a farm cell. */
const WORK_RANGE = 3;
const CELL_TRAVEL_TIMEOUT_MS = 20_000;
const COLLECT_TIMEOUT_MS = 90_000;
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
 * The farm's cells. The first plot is the candidate that already holds the
 * most farmland (so the choice is stable once farming starts), else the one
 * with the most workable soil, preferring water nearby (hydrated wheat grows
 * faster). Every other plot that has farmland stays in the farm, and the
 * next best plot is added when the carried seeds cover it too: one plot
 * baked 8 bread a pass while the food floor preempted everything and hunts
 * went 250 blocks out (2026-10-04). (Waiting for the plot to be fully
 * tilled never fired: harvested farmland dries back to dirt.) Pure over
 * `lookup`.
 */
export function chooseFarmCells(home: { x: number; y: number; z: number }, lookup: FarmLookup, seeds = 0, prefer: PlotOffset | null = null): FarmCell[] {
  // Outer development plots join the farm once they hold farmland, or when
  // land development has just cleared one (`prefer`); the farm does not
  // sprawl onto them by itself.
  const plots = developmentPlots().map((offset) => {
    const cells = plotCells(home, offset, lookup);
    let score = 0;
    for (const cell of cells) {
      score += cell.soil === "farmland" ? 100 : 1;
      if (cell.hydrated) score += 1;
    }
    const home3 = PLOT_OFFSETS.some((candidate) => sameOffset(candidate, offset));
    const preferred = prefer !== null && sameOffset(prefer, offset);
    return { cells, score, established: cells.some((cell) => cell.soil === "farmland"), eligible: home3 || preferred, preferred };
  }).filter((plot) => plot.score > 0 && (plot.established || plot.eligible));
  // Stable sort: equal scores keep the development order. A plot just
  // cleared for the farm comes first among the new ones.
  plots.sort((a, b) => Number(b.established) - Number(a.established) || Number(b.preferred) - Number(a.preferred) || b.score - a.score);
  const chosen: FarmCell[] = [];
  for (const plot of plots) {
    const covered = seeds >= chosen.length + plot.cells.length;
    // A plot development just cleared is sown whatever the seed count (the
    // pass gathers seeds from grass when short); gating it on seeds left
    // the cleared plot untilled and development looping on it (14:41).
    if (chosen.length === 0 || plot.established || plot.preferred || covered) chosen.push(...plot.cells);
  }
  return chosen;
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
  /** A plot land development just cleared: sow it first. */
  preferPlot?: PlotOffset;
}

export interface TendFarmResult {
  harvested: number;
  bread: number;
  tilled: number;
  planted: number;
}

export function botLookup(bot: Bot): FarmLookup {
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

/**
 * Whether the bot lacks a hoe and the wood to make one (two planks for the
 * head, two more for the sticks unless it carries them; a log is four
 * planks). The farm crafts from what it carries, so a run with no wood on
 * hand tilled nothing: "missing ingredients for 'wooden_hoe'" and the field
 * at -24,0 failed twice (2026-10-05 23:41, 23:46) with 367 seeds held.
 */
export function hoeWoodShort(held: { hoe: boolean; planks: number; logs: number; sticks: number }): boolean {
  if (held.hoe) return false;
  const planks = held.planks + 4 * held.logs;
  // Four more for a table: an outer plot can be out of reach of the one at
  // home, and a field 2026-10-06 04:16 planted 2 cells with "no crafting
  // table for a hoe" (missing ingredients for 'crafting_table').
  return planks < TABLE_PLANK_COST + (held.sticks >= 2 ? 2 : 4);
}

export function holdsHoe(bot: Bot): boolean { return findHoe(bot) !== null; }

function findHoe(bot: Bot) {
  for (const name of ["netherite_hoe", "diamond_hoe", "iron_hoe", "stone_hoe", "wooden_hoe"]) {
    const item = findItem(bot, name);
    if (item !== null) return item;
  }
  return null;
}

/**
 * The home crafting table, or a new one crafted from carried logs and set
 * down beside the bot (which is at home). Bread and the hoe both need it.
 * Placed around the bot's own height, not home's stored Y, which can drift.
 */
async function ensureTable(bot: Bot, home: HomeLocation, logger: Logger, signal?: AbortSignal): Promise<Block | null> {
  const existing = findBlockNear(bot, "crafting_table", TABLE_SCAN_RADIUS);
  if (existing !== null) return existing;
  return placeNewTable(bot, home, logger, signal);
}

/** Craft (if not carried) and place a crafting table beside the bot. */
export async function placeNewTable(bot: Bot, home: HomeLocation, logger: Logger, signal?: AbortSignal): Promise<Block | null> {
  const self = bot.entity;
  if (self === null) return null;
  if (findItem(bot, "crafting_table") === null) {
    const crafted = await craftCraftingTable(bot, signal);
    if (!crafted.ok) {
      logger.warn({ reason: crafted.reason }, "farm: could not craft a crafting table");
      return null;
    }
  }
  const item = findItem(bot, "crafting_table");
  const spot = findPlacementSpot(bot, { x: home.x, y: self.position.y, z: home.z });
  if (item === null || spot === null) return null;
  // The spot is beside home, the bot often out at a plot: a placement from
  // 8.5 blocks away was never answered (23:15, 23:38), so no table, no hoe,
  // and 62 open cells went unplanted.
  if (!(await walkIntoReach(bot, spot.reference, signal))) {
    logger.warn({ at: [spot.position.x, spot.position.y, spot.position.z] }, "farm: cannot reach the table spot");
    return null;
  }
  const placed = await placeItemAt(bot, item, spot, signal);
  return placed !== null && placed.name === "crafting_table" ? placed : null;
}

/** Wheat plants standing in the farm now (what the next harvests will bring). */
export function farmGrowing(bot: Bot, home: HomeLocation): number {
  return chooseFarmCells(home, botLookup(bot), countItem(bot, "wheat_seeds")).filter((cell) => cell.above === "wheat").length;
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
  // One block at a time, nearest first: an unreachable grass tuft is
  // skipped instead of failing the whole pass (a batch collect gave up on
  // the first "took too long to decide path" and planted nothing).
  const collect = async (positions: Vec3[], countHeld: () => number, target: number): Promise<void> => {
    const self = bot.entity;
    const blocks = positions.map((p) => bot.blockAt(p)).filter((b) => b !== null);
    if (self !== null) blocks.sort((a, b) => a.position.distanceTo(self.position) - b.position.distanceTo(self.position));
    if (blocks.length === 0) return;
    try {
      await collectBlocks(bot, blocks, countHeld, target, () => {}, COLLECT_TIMEOUT_MS, () => {}, signal);
    } catch (err) {
      if (signal?.aborted === true) throw err;
      logger.warn({ err: String(err) }, "farm: collection pass failed");
    }
  };

  // A table click from beyond reach never opens its window (a 20 s timeout per try).
  // Returns false when the table cannot be reached (buried, walled off).
  const walkToTable = async (table: Block): Promise<boolean> => {
    const self = bot.entity;
    if (self === null) return false;
    if (self.position.distanceTo(table.position.offset(0.5, 0.5, 0.5)) <= WORK_RANGE + 1) return true;
    const walked = await travelAndWait(bot, table.position, { range: WORK_RANGE, timeoutMs: CELL_TRAVEL_TIMEOUT_MS, shouldAbort: opts.shouldAbort, signal });
    const reached = walked.status === "arrived" || walked.status === "already_there";
    if (!reached) logger.warn({ table: [table.position.x, table.position.y, table.position.z], status: walked.status }, "farm: cannot reach the crafting table");
    return reached;
  };

  // 1. Harvest. Collecting the crop breaks it and picks up wheat + seeds.
  let cells = chooseFarmCells(home, lookup, countItem(bot, "wheat_seeds"), opts.preferPlot ?? null);
  const ripe = cells.filter(isMatureWheat).map((c) => new Vec3(c.x, c.y + 1, c.z));
  if (ripe.length > 0) {
    const before = countItem(bot, "wheat");
    await collect(ripe, () => countItem(bot, "wheat"), before + ripe.length);
    result.harvested = Math.max(0, countItem(bot, "wheat") - before);
  }
  if (aborted()) return result;

  // 2. Bake. Wheat is not edible; bread is.
  const loaves = Math.floor(countItem(bot, "wheat") / WHEAT_PER_BREAD);
  const table = loaves > 0
    ? await ensureTable(bot, home, logger, signal)
    : findBlockNear(bot, "crafting_table", TABLE_SCAN_RADIUS);
  if (loaves > 0 && table !== null && await walkToTable(table)) {
    const baked = await craftItem(bot, "bread", { times: loaves, craftingTable: table, signal });
    if (baked.ok) result.bread = baked.crafted;
    else logger.warn({ reason: baked.reason }, "farm: could not bake bread");
  }
  if (aborted()) return result;
  // Starving: sowing pays off a day from now, the hunt pays off today.
  if (bot.food < STARVING_HUNGER) return result;

  // 3. Seeds for every open cell, from grass around home.
  cells = chooseFarmCells(home, lookup, countItem(bot, "wheat_seeds"), opts.preferPlot ?? null);
  const toSow = sowingOrder(cells);
  if (toSow.length === 0) return result;
  if (countItem(bot, "wheat_seeds") < toSow.length) {
    const grass = findBlocksNear(bot, (b) => SEED_GRASS.has(bareName(b.name)), SEED_SEARCH_RADIUS, SEED_GRASS_PER_RUN);
    await collect(grass, () => countItem(bot, "wheat_seeds"), toSow.length);
    if (aborted()) return result;
  }

  // 4. A hoe, when there is soil to till and seeds to put in it.
  const seeds = countItem(bot, "wheat_seeds");
  const needsTilling = toSow.slice(0, seeds).some((c) => c.soil === "tillable");
  logger.info({ plotCells: cells.length, openCells: toSow.length, seeds, hasHoe: findHoe(bot) !== null }, "farm: sowing");
  if (needsTilling && findHoe(bot) === null) {
    let hoeTable = table ?? await ensureTable(bot, home, logger, signal);
    if (hoeTable !== null && !(await walkToTable(hoeTable))) hoeTable = await placeNewTable(bot, home, logger, signal);
    if (hoeTable === null) {
      logger.warn("farm: no crafting table for a hoe");
    } else {
      if (countItem(bot, "stick") < 2) await craftSticks(bot, 2, signal);
      if (countItem(bot, "cobblestone") < 2) await craftSpeciesPlanks(bot, 2, signal);
      const hoe = countItem(bot, "cobblestone") >= 2
        ? await craftItem(bot, "stone_hoe", { craftingTable: hoeTable, signal })
        : await craftItem(bot, "wooden_hoe", { craftingTable: hoeTable, signal });
      if (!hoe.ok) logger.warn({ reason: hoe.reason }, "farm: could not craft a hoe");
    }
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
