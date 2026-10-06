import type { Bot } from "mineflayer";
import type { Logger } from "pino";
import { Vec3 } from "vec3";
import type { AgentState } from "../agent/state.js";
import type { TaskSignals } from "../agent/scheduler.js";
import { travelAndWait, travelHomeAndWait } from "../minecraft/movement.js";
import { collectBlocks, placeItemAt } from "../minecraft/world.js";
import { findItem } from "../minecraft/inventory.js";
import { shedJunk } from "../minecraft/primitives.js";
import { botLookup, developmentPlots, tendFarm, type FarmLookup, type PlotOffset } from "./farm.js";
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
        for (const log of logsAbove) if (log.y > groundY + CLEAR_HEIGHT) survey.leftoverLogs.push(log);
      };
      for (let y = baseY + GROUND_SEARCH_DY; y >= baseY - GROUND_SEARCH_DY; y--) {
        const block = lookup(x, y, z);
        if (block === null) break;
        // A crop stands on farmland: the column is already a field.
        if (CROP.test(block.name)) { survey.groundColumns += 1; survey.farmland += 1; keepLeftovers(y - 1); break; }
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
  | { kind: "field"; survey: PlotSurvey }
  | { kind: "building"; survey: PlotSurvey; building: VillageBuilding; origin: { x: number; y: number; z: number } };

export interface DevelopmentState {
  /** A development building is unfinished: only fields until it is done. */
  buildBusy: boolean;
  /** Plots ("dx,dz") whose leftover logs could not be reached: not tidied again. */
  tidySkip?: ReadonlySet<string>;
  /** Development buildings started so far (sets the next kind and the balance). */
  buildings: number;
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
  let outerFields = 0;
  const tidy: PlotSurvey[] = [];
  const openFields: PlotSurvey[] = [];
  const openSites: PlotSurvey[] = [];
  plots.forEach((offset, index) => {
    const cx = Math.floor(home.x) + offset.dx;
    const cz = Math.floor(home.z) + offset.dz;
    const field = surveyPlot(home, offset, lookup);
    if (field.farmland > 0) {
      if (index >= 3) outerFields += 1;
      // Tidy before expanding: the owner asked for the half-cleared trees
      // over the fields to be taken down too (2026-10-05).
      if (field.leftoverLogs.length > 0 && !state.tidySkip?.has(`${offset.dx},${offset.dz}`)) tidy.push(field);
      return;
    }
    if (touchesReserved(cx, cz, PLOT_HALF, reserved)) return;
    if (field.groundColumns >= MIN_GROUND_COLUMNS) openFields.push(field);
    if (index < 3 || touchesReserved(cx, cz, SITE_HALF, reserved)) return;
    const site = surveyPlot(home, offset, lookup, SITE_HALF, SITE_LOG_CHECK);
    // A built site reads as mostly not ground and drops out here.
    if (site.farmland === 0 && site.groundColumns >= SITE_MIN_GROUND && site.maxGround - site.minGround <= SITE_MAX_STEP) openSites.push(site);
  });
  if (tidy[0] !== undefined) return { kind: "tidy", survey: tidy[0] };
  const homeField = openFields.find((field) => plots.findIndex((p) => p.dx === field.offset.dx && p.dz === field.offset.dz) < 3);
  if (homeField !== undefined) return { kind: "field", survey: homeField };

  const buildingDue = !state.buildBusy && outerFields >= FIELDS_PER_BUILDING * (state.buildings + 1) - FIELDS_PER_BUILDING;
  if (buildingDue && openSites.length > 0) {
    const nearest = openSites.slice(0, SITE_CHOICES);
    const site = nearest.reduce((best, candidate) => (candidate.maxGround - candidate.minGround < best.maxGround - best.minGround ? candidate : best));
    const building = VILLAGE_ORDER[state.buildings % VILLAGE_ORDER.length]!;
    // The pad sits on the most common ground height; higher ground is cut
    // down to it and dips are filled up to it.
    const counts = new Map<number, number>();
    for (const y of site.groundYs) counts.set(y, (counts.get(y) ?? 0) + 1);
    const ground = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]![0];
    const cx = Math.floor(home.x) + site.offset.dx;
    const cz = Math.floor(home.z) + site.offset.dz;
    return { kind: "building", survey: site, building, origin: { x: cx - SITE_HALF, y: ground + 1, z: cz - SITE_HALF } };
  }
  const field = openFields[0];
  return field === undefined ? null : { kind: "field", survey: field };
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
        if (block !== null && LEVEL_GROUND.test(block.name)) cut.push({ x, y, z });
      }
      for (let y = padY; y >= padY - SITE_MAX_STEP; y--) {
        const block = lookup(x, y, z);
        if (block === null) break;
        if (!isAirName(block.name) && !CLEARABLE.test(block.name) && !/water/.test(block.name)) break;
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
const LEVEL_GROUND = /^(grass_block|dirt|coarse_dirt|rooted_dirt|podzol|mycelium|stone|andesite|diorite|granite|gravel|sand|clay|tuff)$/;

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
}

export interface DevelopLandData {
  plot: PlotOffset | null;
  building?: VillageBuilding;
  cleared: number;
  planted: number;
}

export class DevelopLandRunner {
  constructor(private readonly opts: DevelopLandOptions) {}

  /**
   * Cut the site's high ground down to the pad and fill its dips with the
   * dirt dug out (cobblestone when the dirt runs short). Best effort: the
   * builder also digs bumps in its wall cells and props up gaps.
   */
  private async levelSite(origin: { x: number; y: number; z: number }, signal?: AbortSignal): Promise<{ cut: number; filled: number }> {
    const bot = this.opts.bot;
    const plan = levelPlan(origin, origin.y - 1, VILLAGE_SITE, botLookup(bot));
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
    for (const cell of plan.fill) {
      if (signal?.aborted === true) break;
      const item = findItem(bot, "dirt") ?? findItem(bot, "cobblestone");
      if (item === null) break;
      const at = new Vec3(cell.x, cell.y, cell.z);
      const below = bot.blockAt(at.offset(0, -1, 0));
      if (below === null || below.boundingBox !== "block") continue;
      const walked = await travelAndWait(bot, at, { range: 3, timeoutMs: 15_000, signal });
      if (walked.status !== "arrived" && walked.status !== "already_there") continue;
      const placed = await placeItemAt(bot, item, { position: at, reference: below, face: new Vec3(0, 1, 0) }, signal).catch(() => null);
      if (placed !== null) filled += 1;
    }
    return { cut, filled };
  }

  /** Plots whose leftover logs could not be reached; not tidied again this session. */
  private readonly tidySkip = new Set<string>();
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
    return nextDevelopment(home, cachedLookup(botLookup(this.opts.bot)), this.opts.reservedCells?.() ?? new Set(), { buildBusy: builds === undefined || builds.busy(), buildings: builds?.count() ?? 0, tidySkip: this.tidySkip });
  }

  async run(options: { signals?: TaskSignals } = {}): Promise<SkillResult<DevelopLandData>> {
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
      if (left > 0) this.tidySkip.add(`${survey.offset.dx},${survey.offset.dz}`);
      return { ok: true, status: "completed", message: `Took down ${data.cleared} leftover logs over the field at ${survey.offset.dx},${survey.offset.dz}.`, data };
    }
    this.opts.logger.info({ plot: survey.offset, kind: next.kind, building: next.kind === "building" ? next.building : undefined, ground: survey.groundColumns, toClear: survey.clear.length }, next.kind === "building" ? "develop: clearing a building site" : "develop: clearing a field");

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
      const level = await this.levelSite(next.origin, signal);
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

    // Till and sow it: the farm takes the cleared plot first.
    const farm = await tendFarm({ bot, home, logger: this.opts.logger, signal, shouldAbort: () => signals?.checkpoint() === false, preferPlot: survey.offset });
    if (signals?.checkpoint() === false) return interrupted();
    data.planted = farm.planted;
    this.opts.logger.info({ plot: survey.offset, cleared: data.cleared, planted: farm.planted, tilled: farm.tilled }, "develop: field done");
    // No progress at all would re-run on the same plot every few seconds
    // (14:41): fail so the restore cooldown spaces the retries.
    if (data.cleared === 0 && farm.planted === 0 && farm.tilled === 0) {
      return { ok: false, status: "failed", errorCode: "NOT_READY", message: `could not clear or plant the field at ${survey.offset.dx},${survey.offset.dz}`, retryable: true, data };
    }
    // A plot short of seeds is finished on the next run.
    return { ok: true, status: "completed", message: `Developed a field at ${survey.offset.dx},${survey.offset.dz}: cleared ${data.cleared}, planted ${farm.planted}.`, data };
  }
}
