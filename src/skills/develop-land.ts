import type { Bot } from "mineflayer";
import type { Logger } from "pino";
import { Vec3 } from "vec3";
import type { AgentState } from "../agent/state.js";
import type { TaskSignals } from "../agent/scheduler.js";
import { travelHomeAndWait } from "../minecraft/movement.js";
import { collectBlocks } from "../minecraft/world.js";
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
const CLEAR_TIMEOUT_MS = 180_000;

/** Ground a field can be made from (or already is). */
const FIELD_GROUND = /^(grass_block|dirt|coarse_dirt|rooted_dirt|podzol|dirt_path|farmland|mycelium)$/;
/** Natural cover cleared off a field: trees, saplings, brush and flowers. */
const CLEARABLE = /(_log|_wood|_leaves|_sapling|vine|bush|^short_grass$|^tall_grass$|^grass$|^fern$|^large_fern$|^dandelion$|^poppy$|_tulip$|^azure_bluet$|^oxeye_daisy$|^cornflower$|^allium$|^blue_orchid$|^lily_of_the_valley$|^brown_mushroom$|^red_mushroom$|^sweet_berry_bush$|^pumpkin$|^melon$)/;

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
}

/** Ground, farmland and the cover to clear for one plot. Pure over `lookup`. */
export function surveyPlot(home: { x: number; y: number; z: number }, offset: PlotOffset, lookup: FarmLookup, half = PLOT_HALF, logCheckHeight = 0): PlotSurvey {
  const cx = Math.floor(home.x) + offset.dx;
  const cz = Math.floor(home.z) + offset.dz;
  const baseY = Math.floor(home.y);
  const survey: PlotSurvey = { offset, groundColumns: 0, farmland: 0, clear: [], minGround: Infinity, maxGround: -Infinity, highLogs: 0, groundYs: [] };
  for (let dx = -half; dx <= half; dx++) {
    for (let dz = -half; dz <= half; dz++) {
      const x = cx + dx;
      const z = cz + dz;
      // Top-down past the canopy: the first block that is neither air nor
      // tree is the ground (or not field ground, and the column is skipped).
      for (let y = baseY + GROUND_SEARCH_DY; y >= baseY - GROUND_SEARCH_DY; y--) {
        const block = lookup(x, y, z);
        if (block === null) break;
        // A crop stands on farmland: the column is already a field.
        if (CROP.test(block.name)) { survey.groundColumns += 1; survey.farmland += 1; break; }
        if (isAirName(block.name) || CLEARABLE.test(block.name)) continue;
        if (!FIELD_GROUND.test(block.name)) break;
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

/** Every third outer plot is a building site; the rest are fields. */
export function siteIndex(offset: PlotOffset): number | null {
  const outer = developmentPlots().slice(3);
  const index = outer.findIndex((candidate) => candidate.dx === offset.dx && candidate.dz === offset.dz);
  if (index < 0 || index % 3 !== 1) return null;
  return (index - 1) / 3;
}

const SITE_HALF = Math.floor(VILLAGE_SITE / 2);
/** Highest village building plus its roof: logs below this block a site. */
const SITE_LOG_CHECK = 12;
/** A building site needs this much of its 7x7 to be field ground. */
const SITE_MIN_GROUND = 40;
/** Ground heights across a building site may differ by at most this. */
const SITE_MAX_STEP = 2;

export type Development =
  | { kind: "field"; survey: PlotSurvey }
  | { kind: "building"; survey: PlotSurvey; building: VillageBuilding; origin: { x: number; y: number; z: number } };

/**
 * The next development step: nearest plot first. A building site gets its
 * building when it is flat, open ground with no trunks in the way and no
 * other development build is unfinished; a site that cannot take a building
 * is farmed instead. Fields need mostly field ground and no farmland yet.
 * Anything touching a reserved cell (an unfinished build) is left alone.
 */
export function nextDevelopment(
  home: { x: number; y: number; z: number },
  lookup: FarmLookup,
  reserved: ReadonlySet<string> = new Set(),
  buildBusy = false,
): Development | null {
  for (const offset of developmentPlots()) {
    const cx = Math.floor(home.x) + offset.dx;
    const cz = Math.floor(home.z) + offset.dz;
    const site = siteIndex(offset);
    if (site !== null) {
      if (touchesReserved(cx, cz, SITE_HALF, reserved)) continue;
      const survey = surveyPlot(home, offset, lookup, SITE_HALF, SITE_LOG_CHECK);
      const buildable = survey.farmland === 0 && survey.groundColumns >= SITE_MIN_GROUND && survey.maxGround - survey.minGround <= SITE_MAX_STEP && survey.highLogs === 0;
      if (buildable) {
        if (buildBusy) continue;
        const building = VILLAGE_ORDER[site % VILLAGE_ORDER.length]!;
        // Build on the most common ground height; the builder digs bumps
        // and props up dips.
        const counts = new Map<number, number>();
        for (const y of survey.groundYs) counts.set(y, (counts.get(y) ?? 0) + 1);
        const ground = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]![0];
        return { kind: "building", survey, building, origin: { x: cx - SITE_HALF, y: ground + 1, z: cz - SITE_HALF } };
      }
      // A built site reads as mostly not ground; leave it be.
      if (survey.groundColumns < SITE_MIN_GROUND) continue;
    }
    if (touchesReserved(cx, cz, PLOT_HALF, reserved)) continue;
    const survey = surveyPlot(home, offset, lookup);
    if (survey.farmland > 0) continue;
    if (survey.groundColumns < MIN_GROUND_COLUMNS) continue;
    return { kind: "field", survey };
  }
  return null;
}

/** The next field to clear and plant (fields only). */
export function nextPlotToDevelop(home: { x: number; y: number; z: number }, lookup: FarmLookup, reserved: ReadonlySet<string> = new Set()): PlotSurvey | null {
  const next = nextDevelopment(home, lookup, reserved, true);
  return next?.kind === "field" ? next.survey : null;
}

/** Starts and tracks the bot's own building projects. */
export interface DevelopmentBuilds {
  /** True while a building development started is unfinished. */
  busy(): boolean;
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

  /** True when a plot within the development rings is left to develop. */
  hasWork(): boolean {
    const home = this.opts.state.home;
    const self = this.opts.bot.entity?.position;
    if (home === null || self === undefined || self === null) return false;
    // Unloaded chunks read as unknown; only judge from home.
    if (Math.hypot(self.x - home.x, self.z - home.z) > 32) return false;
    return this.next(home) !== null;
  }

  private next(home: { x: number; y: number; z: number }): Development | null {
    const builds = this.opts.builds;
    return nextDevelopment(home, botLookup(this.opts.bot), this.opts.reservedCells?.() ?? new Set(), builds === undefined || builds.busy());
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

    const next = this.next(home);
    if (next === null) return { ok: true, status: "completed", message: "The land around home is developed.", data };
    const survey = next.survey;
    data.plot = survey.offset;
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
