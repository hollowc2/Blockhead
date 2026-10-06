import type { Bot } from "mineflayer";
import type { Logger } from "pino";
import { Vec3 } from "vec3";
import type { AgentState } from "../agent/state.js";
import type { TaskSignals } from "../agent/scheduler.js";
import { travelAndWait, travelHomeAndWait, withoutPathfinderScaffolding } from "../minecraft/movement.js";
import { collectBlocks, nearbyLogCensus, placeItemAt, touchesCraftedBlock } from "../minecraft/world.js";
import { countLogs, countPlanks, countSticks, findItem } from "../minecraft/inventory.js";
import { digBlock, shedJunk } from "../minecraft/primitives.js";
import { isDroppedItemEntity } from "../policy/combat.js";
import { botLookup, developmentPlots, hoeWoodShort, holdsHoe, tendFarm, type FarmLookup, type PlotOffset } from "./farm.js";
import type { SkillResult } from "./skill-library.js";
import type { BuildingDesign } from "../building/schema.js";
import { VILLAGE_ORDER, VILLAGE_SITE, villageDesign, type VillageBuilding } from "../building/village.js";

/**
 * Land development for idle time: the owner asked for a bot that keeps
 * developing the land when it has nothing else to do (2026-10-05): clear
 * fields, plant food, then clear more and plant more. Each run takes the
 * nearest undeveloped plot on the rings around home, clears the trees and
 * brush standing on it, and has the farm till and sow it. A plot is
 * developed once it holds farmland; the farm keeps tending it from then on.
 */

const PLOT_HALF = 2;
export const FIELD_MAX_STEP = 3;
/** Columns are searched this far above/below home for their ground. */
const GROUND_SEARCH_DY = 12;
/** Clearing reaches this high above the ground: crop space plus headroom to walk. */
const CLEAR_HEIGHT = 2;
/** A plot with fewer ground columns than this (a lake, a cliff) is skipped. */
const MIN_GROUND_COLUMNS = 18;
const TRAVEL_TIMEOUT_MS = 90_000;
/** How long an idle check's answer is reused. */
const WORK_MEMO_MS = 60_000;
const CLEAR_TIMEOUT_MS = 180_000;

/** Ground a field can be made from (or already is). */
const FIELD_GROUND = /^(grass_block|dirt|coarse_dirt|rooted_dirt|podzol|dirt_path|farmland|mycelium)$/;
/** Natural cover cleared off a field: trees, saplings, brush and flowers. */
const CLEARABLE = /(_log|_wood|_leaves|_sapling|vine|bush|^short_grass$|^tall_grass$|^grass$|^fern$|^large_fern$|^dandelion$|^poppy$|_tulip$|^azure_bluet$|^oxeye_daisy$|^cornflower$|^allium$|^blue_orchid$|^lily_of_the_valley$|^brown_mushroom$|^red_mushroom$|^sweet_berry_bush$|^pumpkin$|^melon$)/;

/** A lookup that reads each cell from the world once (field and site surveys overlap). */
function cachedLookup(lookup: FarmLookup): FarmLookup {
  const cache = new Map<string, ReturnType<FarmLookup>>();
  return (x, y, z) => {
    const key = `${x},${y},${z}`;
    if (cache.has(key)) return cache.get(key)!;
    const block = lookup(x, y, z);
    cache.set(key, block);
    return block;
  };
}

/** Tree trunk blocks. */
const TREE_LOG = /_log$|_wood$/;

/** Crops on farmland. */
const CROP = /^(wheat|carrots|potatoes|beetroots)$/;

function isAirName(name: string): boolean {
  return name === "air" || name === "cave_air";
}

export interface PlotSurvey {
  offset: PlotOffset;
  /** Field ground columns in the plot. */
  groundColumns: number;
  farmland: number;
  /** Cells to clear above the ground (trees, brush), lowest first. */
  clear: { x: number; y: number; z: number; name: string }[];
  minGround: number;
  maxGround: number;
  /** Log blocks above the cleared height (within `logCheckHeight`). */
  highLogs: number;
  groundYs: number[];
  /**
   * Tree logs left standing above crop height over the plot: the upper
   * trunk a cleared tree leaves floating. Without them its leaves decay.
   */
  leftoverLogs: { x: number; y: number; z: number; name: string }[];
}

/** Ground, farmland and the cover to clear for one plot. Pure over `lookup`. */
export function surveyPlot(home: { x: number; y: number; z: number }, offset: PlotOffset, lookup: FarmLookup, half = PLOT_HALF, logCheckHeight = 0): PlotSurvey {
  const cx = Math.floor(home.x) + offset.dx;
  const cz = Math.floor(home.z) + offset.dz;
  const baseY = Math.floor(home.y);
  const survey: PlotSurvey = { offset, groundColumns: 0, farmland: 0, clear: [], minGround: Infinity, maxGround: -Infinity, highLogs: 0, groundYs: [], leftoverLogs: [] };
  for (let dx = -half; dx <= half; dx++) {
    for (let dz = -half; dz <= half; dz++) {
      const x = cx + dx;
      const z = cz + dz;
      // Top-down past the canopy: the first block that is neither air nor
      // tree is the ground (or not field ground, and the column is skipped).
      const logsAbove: { x: number; y: number; z: number; name: string }[] = [];
      const keepLeftovers = (groundY: number): void => {
        for (const log of logsAbove) {
          const floating = Array.from({ length: log.y - groundY - 1 }, (_, i) => lookup(x, groundY + 1 + i, z)?.name ?? "unknown")
            .some((name) => isAirName(name) || /_leaves$/.test(name));
          if (floating) survey.leftoverLogs.push(log);
        }
      };
      for (let y = baseY + GROUND_SEARCH_DY; y >= baseY - GROUND_SEARCH_DY; y--) {
        const block = lookup(x, y, z);
        if (block === null) break;
        // A crop stands on farmland: the column is already a field.
        if (CROP.test(block.name)) continue;
        if (TREE_LOG.test(block.name)) logsAbove.push({ x, y, z, name: block.name });
        if (isAirName(block.name) || CLEARABLE.test(block.name)) continue;
        if (!FIELD_GROUND.test(block.name)) break;
        keepLeftovers(y);
        survey.groundColumns += 1;
        survey.groundYs.push(y);
        survey.minGround = Math.min(survey.minGround, y);
        survey.maxGround = Math.max(survey.maxGround, y);
        if (block.name === "farmland") survey.farmland += 1;
        for (let up = 1; up <= CLEAR_HEIGHT; up++) {
          const above = lookup(x, y + up, z);
          if (above !== null && CLEARABLE.test(above.name)) survey.clear.push({ x, y: y + up, z, name: above.name });
        }
        // Trunks above crop height inside a building's volume would stop
        // the build (the owner's house blocked on a birch log, 2026-10-04).
        for (let up = CLEAR_HEIGHT + 1; up <= logCheckHeight; up++) {
          if (/_log$|_wood$/.test(lookup(x, y + up, z)?.name ?? "")) survey.highLogs += 1;
        }
        break;
      }
    }
  }
  survey.clear.sort((a, b) => a.y - b.y);
  return survey;
}

function touchesReserved(cx: number, cz: number, half: number, reserved: ReadonlySet<string>): boolean {
  for (const key of reserved) {
    const [x, , z] = key.split(",").map(Number);
    if (Math.abs(x! - cx) <= half + 1 && Math.abs(z! - cz) <= half + 1) return true;
  }
  return false;
}

const SITE_HALF = Math.floor(VILLAGE_SITE / 2);
/** Highest village building plus its roof: trunks below this are felled while building. */
const SITE_LOG_CHECK = 12;
/** A building site needs this much of its 7x7 to be field ground. */
const SITE_MIN_GROUND = 40;
/** Uneven ground up to this step is levelled into a pad before building. */
const SITE_MAX_STEP = 5;
/** Outer fields developed per building: two fields, then a building, and so on. */
export const FIELDS_PER_BUILDING = 2;
/** A building goes on the flattest of this many nearest open plots. */
const SITE_CHOICES = 6;

export type Development =
  | { kind: "tidy"; survey: PlotSurvey }
  | { kind: "level_field"; survey: PlotSurvey; padY: number }
  | { kind: "tree_farm"; survey: PlotSurvey }
  | { kind: "plant_trees"; survey: PlotSurvey; farm: TreeFarmSurvey }
  | { kind: "field"; survey: PlotSurvey }
  | { kind: "building"; survey: PlotSurvey; building: VillageBuilding; origin: { x: number; y: number; z: number } };

export interface DevelopmentState {
  /** A development building is unfinished: only fields until it is done. */
  buildBusy: boolean;
  /** Plots ("dx,dz") whose leftover logs could not be reached: not tidied again. */
  tidySkip?: ReadonlySet<string>;
  /** Fields whose levelling was incomplete; left alone for this session. */
  levelSkip?: ReadonlySet<string>;
  /** Development buildings started so far (sets the next kind and the balance). */
  buildings: number;
  /** Plots set aside for trees, and whether home is short of trees. */
  treeFarm?: TreeFarmState;
}

export interface TreeFarmState {
  /** Plots already set aside as the tree farm. */
  plots: readonly PlotOffset[];
  /** Home is short of standing trees: set more plots aside, up to TREE_FARM_PLOTS. */
  wanted: boolean;
  /** Saplings to hand, or a hunt for some is due: empty farm cells are worth a run. */
  canPlant: boolean;
}

/**
 * The tree farm (owner request, 2026-10-06: "start a tree farm if needed").
 * Land development cleared every standing tree within 64 blocks of home, and
 * wood trips crossed the lakes to the woods beyond; three of them died in the
 * water. When home runs short of trees, up to TREE_FARM_PLOTS outer plots are
 * set aside and planted with saplings at the corners and centre, two blocks
 * apart. The wood restore fells them like any tree, and empty cells are
 * replanted.
 */
export const TREE_FARM_PLOTS = 2;
/** Fewer standing trees than this within 64 blocks of home and a tree farm is started. */
export const TREE_FARM_WANTED_BELOW = 12;
/** Sapling cells of a tree-farm plot, as offsets from its centre. */
export const TREE_FARM_CELLS: readonly (readonly [number, number])[] = [[-2, -2], [-2, 2], [2, -2], [2, 2], [0, 0]];

export interface TreeFarmSurvey {
  offset: PlotOffset;
  /** Cells to plant: the air (or brush) above field ground. */
  empty: { x: number; y: number; z: number; cover: string | null }[];
  saplings: number;
  trees: number;
}

/** What stands on each sapling cell of a tree-farm plot. Pure over `lookup`. */
export function surveyTreeFarm(home: { x: number; y: number; z: number }, offset: PlotOffset, lookup: FarmLookup): TreeFarmSurvey {
  const cx = Math.floor(home.x) + offset.dx;
  const cz = Math.floor(home.z) + offset.dz;
  const baseY = Math.floor(home.y);
  const survey: TreeFarmSurvey = { offset, empty: [], saplings: 0, trees: 0 };
  for (const [dx, dz] of TREE_FARM_CELLS) {
    const x = cx + dx;
    const z = cz + dz;
    for (let y = baseY + GROUND_SEARCH_DY; y >= baseY - GROUND_SEARCH_DY; y--) {
      const block = lookup(x, y, z);
      if (block === null) break;
      if (isAirName(block.name) || CLEARABLE.test(block.name)) continue;
      if (!FIELD_GROUND.test(block.name) || block.name === "farmland") break;
      const above = lookup(x, y + 1, z)?.name ?? "air";
      if (/_sapling$/.test(above)) survey.saplings += 1;
      else if (TREE_LOG.test(above)) survey.trees += 1;
      else survey.empty.push({ x, y: y + 1, z, cover: isAirName(above) ? null : above });
      break;
    }
  }
  return survey;
}

function sameOffset(a: PlotOffset, b: PlotOffset): boolean {
  return a.dx === b.dx && a.dz === b.dz;
}

/**
 * The next development step, keeping fields and buildings in balance (the
 * owner asked for it to "feel balanced"): the home plots first, then two
 * outer fields for every building. When a building is due it goes on the
 * flattest of the nearest open plots, with uneven ground levelled into a pad
 * first, so steep land does not leave a village of farms only. Anything
 * touching a reserved cell (an unfinished build) is left alone.
 */
export function nextDevelopment(
  home: { x: number; y: number; z: number },
  lookup: FarmLookup,
  reserved: ReadonlySet<string> = new Set(),
  state: DevelopmentState = { buildBusy: true, buildings: 0 },
): Development | null {
  const plots = developmentPlots();
  const farmPlots = state.treeFarm?.plots ?? [];
  // The tree farm is kept off like an unfinished build: no field, no site.
  const blocked = new Set(reserved);
  for (const farm of farmPlots) {
    for (let dx = -PLOT_HALF; dx <= PLOT_HALF; dx++) for (let dz = -PLOT_HALF; dz <= PLOT_HALF; dz++) blocked.add(`${Math.floor(home.x) + farm.dx + dx},0,${Math.floor(home.z) + farm.dz + dz}`);
  }
  let outerFields = 0;
  const tidy: PlotSurvey[] = [];
  const uneven: PlotSurvey[] = [];
  const openFields: PlotSurvey[] = [];
  const openSites: PlotSurvey[] = [];
  plots.forEach((offset, index) => {
    const cx = Math.floor(home.x) + offset.dx;
    const cz = Math.floor(home.z) + offset.dz;
    if (farmPlots.some((farm) => sameOffset(farm, offset))) return;
    const field = surveyPlot(home, offset, lookup);
    if (field.farmland > 0) {
      if (index >= 3) outerFields += 1;
      // Tidy before expanding: the owner asked for the half-cleared trees
      // over the fields to be taken down too (2026-10-05).
      const leftovers = surveyPlot(home, offset, lookup, 4).leftoverLogs.filter((log) =>
        !touchesReserved(log.x, log.z, 0, blocked) && !touchesCraftedBlock({ blockAt: (at: Vec3) => lookup(at.x, at.y, at.z) }, new Vec3(log.x, log.y, log.z)));
      if (leftovers.length > 0 && !state.tidySkip?.has(`${offset.dx},${offset.dz}`)) tidy.push({ ...field, leftoverLogs: leftovers });
      if (!touchesReserved(cx, cz, PLOT_HALF, blocked) && field.groundColumns >= MIN_GROUND_COLUMNS && field.maxGround > field.minGround && field.maxGround - field.minGround <= FIELD_MAX_STEP && !state.levelSkip?.has(`${offset.dx},${offset.dz}`)) uneven.push(field);
      return;
    }
    if (touchesReserved(cx, cz, PLOT_HALF, blocked)) return;
    if (!state.levelSkip?.has(`${offset.dx},${offset.dz}`) && field.groundColumns >= MIN_GROUND_COLUMNS && field.maxGround - field.minGround <= FIELD_MAX_STEP) openFields.push(field);
    if (index < 3 || touchesReserved(cx, cz, SITE_HALF, blocked)) return;
    const site = surveyPlot(home, offset, lookup, SITE_HALF, SITE_LOG_CHECK);
    // A built site reads as mostly not ground and drops out here.
    if (site.farmland === 0 && site.groundColumns >= SITE_MIN_GROUND && site.maxGround - site.minGround <= SITE_MAX_STEP) openSites.push(site);
  });
  if (tidy[0] !== undefined) return { kind: "tidy", survey: tidy[0] };
  if (uneven[0] !== undefined) return { kind: "level_field", survey: uneven[0], padY: modalGround(uneven[0]) };
  if (state.treeFarm?.canPlant === true) {
    for (const offset of farmPlots) {
      const farm = surveyTreeFarm(home, offset, lookup);
      if (farm.empty.length > 0) return { kind: "plant_trees", survey: surveyPlot(home, offset, lookup), farm };
    }
  }
  const isHomePlot = (offset: PlotOffset): boolean => plots.findIndex((p) => sameOffset(p, offset)) < 3;
  const homeField = openFields.find((field) => isHomePlot(field.offset));
  if (homeField !== undefined) return { kind: "field", survey: homeField };
  // Short of trees: set the nearest open outer plot aside for them.
  if (state.treeFarm?.wanted === true && farmPlots.length < TREE_FARM_PLOTS) {
    const site = openFields.find((field) => !isHomePlot(field.offset));
    if (site !== undefined) return { kind: "tree_farm", survey: site };
  }

  const buildingDue = !state.buildBusy && outerFields >= FIELDS_PER_BUILDING * (state.buildings + 1) - FIELDS_PER_BUILDING;
  if (buildingDue && openSites.length > 0) {
    const nearest = openSites.slice(0, SITE_CHOICES);
    const site = nearest.reduce((best, candidate) => (candidate.maxGround - candidate.minGround < best.maxGround - best.minGround ? candidate : best));
    const building = VILLAGE_ORDER[state.buildings % VILLAGE_ORDER.length]!;
    // The pad sits on the most common ground height; higher ground is cut
    // down to it and dips are filled up to it.
    const ground = modalGround(site);
    const cx = Math.floor(home.x) + site.offset.dx;
    const cz = Math.floor(home.z) + site.offset.dz;
    return { kind: "building", survey: site, building, origin: { x: cx - SITE_HALF, y: ground + 1, z: cz - SITE_HALF } };
  }
  const field = openFields[0];
  return field === undefined ? null : { kind: "field", survey: field };
}

/** Modal surface height, choosing the lower height on a tie. */
export function modalGround(survey: PlotSurvey): number {
  const counts = new Map<number, number>();
  for (const y of survey.groundYs) counts.set(y, (counts.get(y) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]![0];
}

/** Cells to cut and fill so a site's footprint is one flat pad at `padY`. Pure over `lookup`. */
export function levelPlan(origin: { x: number; z: number }, padY: number, size: number, lookup: FarmLookup): { cut: { x: number; y: number; z: number }[]; fill: { x: number; y: number; z: number }[] } {
  const cut: { x: number; y: number; z: number }[] = [];
  const fill: { x: number; y: number; z: number }[] = [];
  for (let dx = 0; dx < size; dx++) {
    for (let dz = 0; dz < size; dz++) {
      const x = origin.x + dx;
      const z = origin.z + dz;
      for (let y = padY + SITE_MAX_STEP + 1; y > padY; y--) {
        const block = lookup(x, y, z);
        if (block === null) break;
        if (isAirName(block.name) || CLEARABLE.test(block.name) || CROP.test(block.name)) continue;
        if (!LEVEL_GROUND.test(block.name)) break;
        cut.push({ x, y, z });
        const above = lookup(x, y + 1, z);
        if (above !== null && CROP.test(above.name)) cut.push({ x, y: y + 1, z });
      }
      for (let y = padY; y >= padY - SITE_MAX_STEP; y--) {
        const block = lookup(x, y, z);
        if (block === null) break;
        if (!isAirName(block.name) && !CLEARABLE.test(block.name) && !CROP.test(block.name) && !/water/.test(block.name)) break;
        fill.push({ x, y, z });
      }
    }
  }
  // Cut from the top down; fill from the bottom up so each block rests on the last.
  cut.sort((a, b) => b.y - a.y);
  fill.sort((a, b) => a.y - b.y);
  return { cut, fill };
}

/** Natural ground the levelling may cut away. */
const LEVEL_GROUND = /^(grass_block|dirt|coarse_dirt|rooted_dirt|podzol|mycelium|farmland|stone|andesite|diorite|granite|gravel|sand|clay|tuff)$/;

/** The next field to clear and plant (fields only). */
export function nextPlotToDevelop(home: { x: number; y: number; z: number }, lookup: FarmLookup, reserved: ReadonlySet<string> = new Set()): PlotSurvey | null {
  const next = nextDevelopment(home, lookup, reserved, { buildBusy: true, buildings: 0 });
  return next?.kind === "field" ? next.survey : null;
}

/** Starts and tracks the bot's own building projects. */
export interface DevelopmentBuilds {
  /** True while a building development started is unfinished. */
  busy(): boolean;
  /** Development buildings started so far. */
  count(): number;
  /** Start a building at `origin`; throws when the design cannot be scheduled. */
  start(building: VillageBuilding, design: BuildingDesign, origin: { x: number; y: number; z: number; dimension: string }): void;
}

export interface DevelopLandOptions {
  bot: Bot;
  state: AgentState;
  logger: Logger;
  /** Cells an unfinished owner build will occupy; development keeps off them. */
  reservedCells?: () => ReadonlySet<string>;
  /** Building projects; without it development only makes fields. */
  builds?: DevelopmentBuilds;
  /** Fetch missing fill dirt from home without excavating protected land. */
  fetchDirt?: (count: number, signal?: AbortSignal) => Promise<void>;
  /** Take a little wood from the home chests (a hoe needs it). */
  fetchWood?: (signal?: AbortSignal) => Promise<void>;
  /** The tree farm's plots, kept across restarts, and saplings from the chest. */
  treeFarm?: TreeFarmStore;
}

export interface TreeFarmStore {
  load(): PlotOffset[];
  save(plots: readonly PlotOffset[]): void;
  /** Take saplings from the home chests. */
  fetchSaplings(signal?: AbortSignal): Promise<void>;
}

/** Leaves broken for saplings in one run when none are to be had otherwise. */
const SAPLING_LEAVES_PER_RUN = 40;
/** Dropped saplings and leaves are sought this far from the bot. */
const SAPLING_SEARCH_RADIUS = 24;
/** After a hunt that found no sapling, wait this long before another. */
const SAPLING_HUNT_COOLDOWN_MS = 20 * 60_000;

function countSaplings(bot: Bot): number {
  return bot.inventory.items().filter((item) => /_sapling$/.test(item.name)).reduce((sum, item) => sum + item.count, 0);
}

export interface DevelopLandData {
  plot: PlotOffset | null;
  building?: VillageBuilding;
  cleared: number;
  planted: number;
  /** Saplings planted in the tree farm. */
  trees?: number;
}

export class DevelopLandRunner {
  constructor(private readonly opts: DevelopLandOptions) {}

  /**
   * Cut the site's high ground down to the pad and fill its dips with the
   * dirt dug out (cobblestone when the dirt runs short). Best effort: the
   * builder also digs bumps in its wall cells and props up gaps.
   */
  private async levelSite(origin: { x: number; y: number; z: number }, size: number, signal?: AbortSignal): Promise<{ cut: number; filled: number }> {
    const bot = this.opts.bot;
    const blocked = new Set(this.opts.reservedCells?.() ?? []);
    const home = this.opts.state.home;
    if (home !== null) for (const farm of this.opts.treeFarm?.load() ?? []) {
      for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) blocked.add(`${Math.floor(home.x) + farm.dx + dx},0,${Math.floor(home.z) + farm.dz + dz}`);
    }
    if (touchesReserved(origin.x + (size - 1) / 2, origin.z + (size - 1) / 2, (size - 1) / 2, blocked)) return { cut: 0, filled: 0 };
    const plan = levelPlan(origin, origin.y - 1, size, botLookup(bot));
    const cutTargets = plan.cut.map((cell) => bot.blockAt(new Vec3(cell.x, cell.y, cell.z))).filter((block) => block !== null);
    if (cutTargets.length > 0) {
      try {
        await collectBlocks(bot, cutTargets, () => 0, Number.POSITIVE_INFINITY, () => {}, CLEAR_TIMEOUT_MS, undefined, signal);
      } catch (err) {
        if (signal?.aborted === true) throw err;
        this.opts.logger.warn({ err: String(err) }, "develop: levelling cut stopped");
      }
    }
    const cut = plan.cut.filter((cell) => isAirName(bot.blockAt(new Vec3(cell.x, cell.y, cell.z))?.name ?? "")).length;
    let filled = 0;
    const dirt = bot.inventory.items().filter((item) => item.name === "dirt").reduce((sum, item) => sum + item.count, 0);
    if (dirt < plan.fill.length) await this.opts.fetchDirt?.(plan.fill.length - dirt, signal).catch((err) => {
      if (signal?.aborted) throw err;
      this.opts.logger.warn({ err: String(err) }, "develop: could not fetch fill dirt");
    });
    for (const cell of plan.fill) {
      if (signal?.aborted === true) break;
      const item = findItem(bot, "dirt") ?? (size === VILLAGE_SITE || cell.y < origin.y - 1 ? findItem(bot, "cobblestone") : null);
      if (item === null) break;
      const at = new Vec3(cell.x, cell.y, cell.z);
      const below = bot.blockAt(at.offset(0, -1, 0));
      if (below === null || (below.boundingBox !== "block" && below.name !== "farmland")) continue;
      const walked = await travelAndWait(bot, at, { range: 3, timeoutMs: 15_000, signal });
      if (walked.status !== "arrived" && walked.status !== "already_there") continue;
      const cover = bot.blockAt(at);
      if (cover === null) continue;
      if (!isAirName(cover.name)) {
        if (!CLEARABLE.test(cover.name) && !CROP.test(cover.name) && !/water/.test(cover.name)) continue;
        if (!/water/.test(cover.name)) await digBlock(bot, cover, signal);
      }
      const placed = await placeItemAt(bot, item, { position: at, reference: below, face: new Vec3(0, 1, 0) }, signal).catch(() => null);
      if (placed !== null) filled += 1;
    }
    return { cut, filled };
  }

  /** Plots whose leftover logs could not be reached; not tidied again this session. */
  private readonly tidySkip = new Set<string>();
  private readonly levelSkip = new Set<string>();
  /** The last idle-check answer, reused for a minute (surveying every ring is slow). */
  private workMemo: { at: number; work: boolean } | null = null;

  /** True when a plot within the development rings is left to develop. */
  hasWork(): boolean {
    if (this.workMemo !== null && Date.now() - this.workMemo.at < WORK_MEMO_MS) return this.workMemo.work;
    const work = this.computeHasWork();
    this.workMemo = { at: Date.now(), work };
    return work;
  }

  private computeHasWork(): boolean {
    const home = this.opts.state.home;
    const self = this.opts.bot.entity?.position;
    if (home === null || self === undefined || self === null) return false;
    // Unloaded chunks read as unknown, so the land is only judged from home.
    // Away from it there may be work: the run walks home first. Saying "no
    // work" left the bot standing 46 blocks out after a restart (16:31).
    if (Math.hypot(self.x - home.x, self.z - home.z) > 32) return true;
    return this.next(home) !== null;
  }

  private next(home: { x: number; y: number; z: number }): Development | null {
    const builds = this.opts.builds;
    return nextDevelopment(home, cachedLookup(botLookup(this.opts.bot)), this.opts.reservedCells?.() ?? new Set(), { buildBusy: builds === undefined || builds.busy(), buildings: builds?.count() ?? 0, tidySkip: this.tidySkip, levelSkip: this.levelSkip, treeFarm: this.treeFarmState() });
  }

  /** When a sapling hunt may run again (it found none last time). */
  private saplingHuntAfter = 0;

  private treeFarmState(): TreeFarmState | undefined {
    const store = this.opts.treeFarm;
    if (store === undefined) return undefined;
    const trees = Object.values(nearbyLogCensus(this.opts.bot).trees).reduce((sum, count) => sum + count, 0);
    return { plots: store.load(), wanted: trees < TREE_FARM_WANTED_BELOW, canPlant: countSaplings(this.opts.bot) > 0 || Date.now() >= this.saplingHuntAfter };
  }

  /**
   * Saplings for the farm: from the chest, off the ground (decaying leaves
   * drop them), and failing both, from leaves broken within reach of the
   * ground. Best effort; a hunt that finds none waits before the next.
   */
  private async gatherSaplings(signal?: AbortSignal): Promise<void> {
    const bot = this.opts.bot;
    await this.opts.treeFarm?.fetchSaplings(signal).catch((err) => this.opts.logger.warn({ err: String(err) }, "develop: could not take saplings from the chest"));
    if (countSaplings(bot) === 0) await this.pickUpSaplings(signal);
    if (countSaplings(bot) === 0 && signal?.aborted !== true) {
      const self = bot.entity?.position;
      if (self !== undefined && self !== null) {
        const leaves = bot.findBlocks({ matching: (block) => block !== null && /_leaves$/.test(block.name), maxDistance: SAPLING_SEARCH_RADIUS, count: 200 })
          .map((position) => bot.blockAt(position))
          .filter((block): block is NonNullable<typeof block> => block !== null && block.position.y <= self.y + 3 && block.position.y >= self.y - 2)
          .sort((a, b) => a.position.distanceTo(self) - b.position.distanceTo(self))
          .slice(0, SAPLING_LEAVES_PER_RUN);
        if (leaves.length > 0) {
          this.opts.logger.info({ leaves: leaves.length }, "develop: breaking leaves for saplings");
          await collectBlocks(bot, leaves, () => countSaplings(bot), 8, () => {}, CLEAR_TIMEOUT_MS, undefined, signal).catch((err) => {
            if (signal?.aborted === true) throw err;
            this.opts.logger.warn({ err: String(err) }, "develop: breaking leaves stopped");
          });
          await this.pickUpSaplings(signal);
        }
      }
    }
    if (countSaplings(bot) === 0) this.saplingHuntAfter = Date.now() + SAPLING_HUNT_COOLDOWN_MS;
  }

  /** Walk over sapling drops lying near the bot. */
  private async pickUpSaplings(signal?: AbortSignal): Promise<void> {
    const bot = this.opts.bot;
    const self = bot.entity?.position;
    if (self === undefined || self === null) return;
    const drops = Object.values(bot.entities)
      .filter((entity) => isDroppedItemEntity(entity) && /_sapling$/.test((entity as unknown as { getDroppedItem(): { name: string } | null }).getDroppedItem()?.name ?? "") && entity.position.distanceTo(self) <= SAPLING_SEARCH_RADIUS)
      .sort((a, b) => a.position.distanceTo(self) - b.position.distanceTo(self))
      .slice(0, 8);
    for (const drop of drops) {
      if (signal?.aborted === true) return;
      if (bot.entities[drop.id] === undefined) continue;
      await travelAndWait(bot, drop.position, { range: 1, timeoutMs: 8_000, signal });
    }
  }

  /** Plant saplings in the farm's empty cells; returns how many went in. */
  private async plantTrees(farm: TreeFarmSurvey, signals?: TaskSignals): Promise<number> {
    const bot = this.opts.bot;
    const signal = signals?.signal;
    if (countSaplings(bot) === 0) await this.gatherSaplings(signal);
    let planted = 0;
    for (const cell of farm.empty) {
      if (signal?.aborted === true || signals?.checkpoint() === false) break;
      const sapling = bot.inventory.items().find((item) => /_sapling$/.test(item.name));
      if (sapling === undefined) break;
      const at = new Vec3(cell.x, cell.y, cell.z);
      const walked = await travelAndWait(bot, at, { range: 3, timeoutMs: 20_000, signal });
      if (walked.status !== "arrived" && walked.status !== "already_there") continue;
      const cover = bot.blockAt(at);
      if (cover !== null && !isAirName(cover.name)) {
        if (!CLEARABLE.test(cover.name) || TREE_LOG.test(cover.name) || /_sapling$/.test(cover.name)) continue;
        await digBlock(bot, cover, signal).catch(() => undefined);
      }
      const ground = bot.blockAt(at.offset(0, -1, 0));
      if (ground === null || !FIELD_GROUND.test(ground.name) || ground.name === "farmland") continue;
      const placed = await placeItemAt(bot, sapling, { position: at, reference: ground, face: new Vec3(0, 1, 0) }, signal).catch(() => null);
      if (placed !== null && /_sapling$/.test(placed.name)) planted += 1;
    }
    return planted;
  }

  async run(options: { signals?: TaskSignals } = {}): Promise<SkillResult<DevelopLandData>> {
    // Approaching floating logs must not leave pillars; field walks must not
    // place dirt back into freshly cut columns either.
    return withoutPathfinderScaffolding(this.opts.bot, () => this.runWork(options));
  }

  private async runWork(options: { signals?: TaskSignals }): Promise<SkillResult<DevelopLandData>> {
    const bot = this.opts.bot;
    const signals = options.signals;
    const signal = signals?.signal;
    const home = this.opts.state.home;
    const data: DevelopLandData = { plot: null, cleared: 0, planted: 0 };
    const interrupted = (): SkillResult<DevelopLandData> => ({ ok: false, status: "interrupted", message: "interrupted", data });
    if (home === null) return { ok: false, status: "failed", errorCode: "NOT_READY", message: "no home to develop around", retryable: false, data };

    const travel = await travelHomeAndWait(bot, home, { dimension: home.dimension, timeoutMs: TRAVEL_TIMEOUT_MS, signal, shouldAbort: () => signals?.checkpoint() === false });
    if (signals?.checkpoint() === false) return interrupted();
    if (travel.status !== "arrived" && travel.status !== "already_there") {
      return { ok: false, status: "failed", errorCode: "PATH_UNREACHABLE", message: `could not reach home: ${travel.status}`, retryable: true, data };
    }

    // Harvests bring seeds and saplings by the stack: shed the surplus so
    // clearing and crafting have room.
    await shedJunk(bot, [], signal).catch(() => 0);
    this.workMemo = null;
    const next = this.next(home);
    if (next === null) return { ok: true, status: "completed", message: "The land around home is developed.", data };
    const survey = next.survey;
    data.plot = survey.offset;
    if (next.kind === "tidy") {
      this.opts.logger.info({ plot: survey.offset, logs: survey.leftoverLogs.length }, "develop: taking down leftover tree trunks");
      const logs = survey.leftoverLogs.map((cell) => bot.blockAt(new Vec3(cell.x, cell.y, cell.z))).filter((block) => block !== null);
      try {
        await collectBlocks(bot, logs, () => 0, Number.POSITIVE_INFINITY, () => {}, CLEAR_TIMEOUT_MS, undefined, signal);
      } catch (err) {
        if (signal?.aborted === true) return interrupted();
        this.opts.logger.warn({ err: String(err) }, "develop: tidying stopped");
      }
      const left = logs.filter((log) => TREE_LOG.test(bot.blockAt(log.position)?.name ?? "")).length;
      data.cleared = logs.length - left;
      // Logs it cannot reach stay; the plot is not tidied again.
      this.opts.logger.info({ plot: survey.offset, cleared: data.cleared, unreachable: left }, "develop: tidy done");
      if (left > 0) this.tidySkip.add(`${survey.offset.dx},${survey.offset.dz}`);
      return { ok: true, status: "completed", message: `Took down ${data.cleared} leftover logs over the field at ${survey.offset.dx},${survey.offset.dz}.`, data };
    }
    if (next.kind === "plant_trees") {
      this.opts.logger.info({ plot: survey.offset, empty: next.farm.empty.length, saplings: countSaplings(bot) }, "develop: planting the tree farm");
      data.trees = await this.plantTrees(next.farm, signals);
      if (signals?.checkpoint() === false) return interrupted();
      this.opts.logger.info({ plot: survey.offset, planted: data.trees }, "develop: tree farm planted");
      if (data.trees === 0) {
        return { ok: false, status: "failed", errorCode: "NOT_READY", message: `no saplings to plant the tree farm at ${survey.offset.dx},${survey.offset.dz}`, retryable: true, data };
      }
      return { ok: true, status: "completed", message: `Planted ${data.trees} saplings in the tree farm at ${survey.offset.dx},${survey.offset.dz}.`, data };
    }
    const label = next.kind === "building" ? "develop: clearing a building site" : next.kind === "tree_farm" ? "develop: setting a plot aside for a tree farm" : "develop: clearing a field";
    this.opts.logger.info({ plot: survey.offset, kind: next.kind, building: next.kind === "building" ? next.building : undefined, ground: survey.groundColumns, toClear: survey.clear.length }, label);

    // Trees and brush off the plot; logs go to the wood stock.
    const targets = survey.clear.map((cell) => bot.blockAt(new Vec3(cell.x, cell.y, cell.z))).filter((block) => block !== null);
    if (targets.length > 0) {
      try {
        await collectBlocks(bot, targets, () => 0, Number.POSITIVE_INFINITY, () => {}, CLEAR_TIMEOUT_MS, undefined, signal);
      } catch (err) {
        if (signal?.aborted === true) return interrupted();
        this.opts.logger.warn({ err: String(err) }, "develop: clearing stopped");
      }
      data.cleared = targets.filter((target) => !CLEARABLE.test(bot.blockAt(target.position)?.name ?? "")).length;
    }
    if (signals?.checkpoint({ plot: survey.offset }) === false) return interrupted();

    if (next.kind === "building") {
      data.building = next.building;
      const level = await this.levelSite(next.origin, VILLAGE_SITE, signal);
      if (signal?.aborted === true || signals?.checkpoint() === false) return interrupted();
      this.opts.logger.info({ building: next.building, cut: level.cut, filled: level.filled }, "develop: site levelled");
      try {
        this.opts.builds!.start(next.building, villageDesign(next.building), { ...next.origin, dimension: home.dimension });
      } catch (err) {
        this.opts.logger.warn({ building: next.building, err: String(err) }, "develop: could not start the building");
        return { ok: false, status: "failed", errorCode: "NOT_READY", message: `could not start a ${next.building}: ${String(err)}`, retryable: true, data };
      }
      this.opts.logger.info({ building: next.building, origin: next.origin }, "develop: building started");
      return { ok: true, status: "completed", message: `Started a ${next.building.replace("_", " ")} at ${next.origin.x},${next.origin.y},${next.origin.z}.`, data };
    }

    if (next.kind === "tree_farm") {
      const store = this.opts.treeFarm!;
      store.save([...store.load(), survey.offset]);
      const farm = surveyTreeFarm(home, survey.offset, botLookup(bot));
      data.trees = await this.plantTrees(farm, signals);
      if (signals?.checkpoint() === false) return interrupted();
      this.opts.logger.info({ plot: survey.offset, planted: data.trees }, "develop: tree farm planted");
      return { ok: true, status: "completed", message: `Set the plot at ${survey.offset.dx},${survey.offset.dz} aside for trees and planted ${data.trees} saplings.`, data };
    }

    const padY = next.kind === "level_field" ? next.padY : modalGround(survey);
    const origin = { x: Math.floor(home.x) + survey.offset.dx - PLOT_HALF, y: padY + 1, z: Math.floor(home.z) + survey.offset.dz - PLOT_HALF };
    this.opts.logger.info({ plot: survey.offset, padY }, "develop: levelling a field");
    const level = await this.levelSite(origin, 5, signal);
    if (signal?.aborted === true || signals?.checkpoint() === false) return interrupted();
    const after = surveyPlot(home, survey.offset, botLookup(bot));
    const complete = after.groundColumns >= survey.groundColumns && after.minGround === padY && after.maxGround === padY;
    if (!complete) this.levelSkip.add(`${survey.offset.dx},${survey.offset.dz}`);
    this.opts.logger.info({ plot: survey.offset, padY, ...level, complete }, "develop: field levelled");
    if (!complete && next.kind === "field") return { ok: false, status: "failed", errorCode: "NOT_READY", message: `could not fully level the field at ${survey.offset.dx},${survey.offset.dz}`, retryable: true, data };

    // A hoe is made from carried wood; fetch some first when there is none.
    if (this.opts.fetchWood !== undefined && hoeWoodShort({ hoe: holdsHoe(bot), planks: countPlanks(bot), logs: countLogs(bot), sticks: countSticks(bot) })) {
      await this.opts.fetchWood(signal).catch((err) => this.opts.logger.warn({ err: String(err) }, "develop: could not fetch wood for a hoe"));
      if (signal?.aborted || signals?.checkpoint() === false) return interrupted();
    }
    // Till and sow it: the farm takes the cleared plot first.
    const farm = await tendFarm({ bot, home, logger: this.opts.logger, signal, shouldAbort: () => signals?.checkpoint() === false, preferPlot: survey.offset });
    if (signals?.checkpoint() === false) return interrupted();
    data.planted = farm.planted;
    this.opts.logger.info({ plot: survey.offset, cleared: data.cleared, planted: farm.planted, tilled: farm.tilled }, "develop: field done");
    // No progress at all would re-run on the same plot every few seconds
    // (14:41): fail so the restore cooldown spaces the retries.
    if (!complete || (data.cleared === 0 && level.cut === 0 && level.filled === 0 && farm.planted === 0 && farm.tilled === 0)) {
      return { ok: false, status: "failed", errorCode: "NOT_READY", message: `could not clear or plant the field at ${survey.offset.dx},${survey.offset.dz}`, retryable: true, data };
    }
    // A plot short of seeds is finished on the next run.
    return { ok: true, status: "completed", message: `Developed a field at ${survey.offset.dx},${survey.offset.dz}: cleared ${data.cleared}, planted ${farm.planted}.`, data };
  }
}
