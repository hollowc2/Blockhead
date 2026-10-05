import type { Bot } from "mineflayer";
import type { Logger } from "pino";
import { Vec3 } from "vec3";
import type { AgentState } from "../agent/state.js";
import type { TaskSignals } from "../agent/scheduler.js";
import { travelHomeAndWait } from "../minecraft/movement.js";
import { collectBlocks } from "../minecraft/world.js";
import { botLookup, developmentPlots, tendFarm, type FarmLookup, type PlotOffset } from "./farm.js";
import type { SkillResult } from "./skill-library.js";

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
}

/** Ground, farmland and the cover to clear for one plot. Pure over `lookup`. */
export function surveyPlot(home: { x: number; y: number; z: number }, offset: PlotOffset, lookup: FarmLookup): PlotSurvey {
  const cx = Math.floor(home.x) + offset.dx;
  const cz = Math.floor(home.z) + offset.dz;
  const baseY = Math.floor(home.y);
  const survey: PlotSurvey = { offset, groundColumns: 0, farmland: 0, clear: [] };
  for (let dx = -PLOT_HALF; dx <= PLOT_HALF; dx++) {
    for (let dz = -PLOT_HALF; dz <= PLOT_HALF; dz++) {
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
        if (block.name === "farmland") survey.farmland += 1;
        for (let up = 1; up <= CLEAR_HEIGHT; up++) {
          const above = lookup(x, y + up, z);
          if (above !== null && CLEARABLE.test(above.name)) survey.clear.push({ x, y: y + up, z, name: above.name });
        }
        break;
      }
    }
  }
  survey.clear.sort((a, b) => a.y - b.y);
  return survey;
}

/**
 * The next plot to develop: nearest first, not yet farmland, mostly field
 * ground, and clear of reserved cells (an owner's unfinished build).
 */
export function nextPlotToDevelop(
  home: { x: number; y: number; z: number },
  lookup: FarmLookup,
  reserved: ReadonlySet<string> = new Set(),
): PlotSurvey | null {
  for (const offset of developmentPlots()) {
    const cx = Math.floor(home.x) + offset.dx;
    const cz = Math.floor(home.z) + offset.dz;
    let touchesReserved = false;
    for (const key of reserved) {
      const [x, , z] = key.split(",").map(Number);
      if (Math.abs(x! - cx) <= PLOT_HALF + 1 && Math.abs(z! - cz) <= PLOT_HALF + 1) { touchesReserved = true; break; }
    }
    if (touchesReserved) continue;
    const survey = surveyPlot(home, offset, lookup);
    if (survey.farmland > 0) continue;
    if (survey.groundColumns < MIN_GROUND_COLUMNS) continue;
    return survey;
  }
  return null;
}

export interface DevelopLandOptions {
  bot: Bot;
  state: AgentState;
  logger: Logger;
  /** Cells an unfinished owner build will occupy; development keeps off them. */
  reservedCells?: () => ReadonlySet<string>;
}

export interface DevelopLandData {
  plot: PlotOffset | null;
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
    return nextPlotToDevelop(home, botLookup(this.opts.bot), this.opts.reservedCells?.() ?? new Set()) !== null;
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

    const survey = nextPlotToDevelop(home, botLookup(bot), this.opts.reservedCells?.() ?? new Set());
    if (survey === null) return { ok: true, status: "completed", message: "The land around home is developed.", data };
    data.plot = survey.offset;
    this.opts.logger.info({ plot: survey.offset, ground: survey.groundColumns, toClear: survey.clear.length }, "develop: clearing a field");

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

    // Till and sow it: the farm takes the cleared plot first.
    const farm = await tendFarm({ bot, home, logger: this.opts.logger, signal, shouldAbort: () => signals?.checkpoint() === false, preferPlot: survey.offset });
    if (signals?.checkpoint() === false) return interrupted();
    data.planted = farm.planted;
    this.opts.logger.info({ plot: survey.offset, cleared: data.cleared, planted: farm.planted, tilled: farm.tilled }, "develop: field done");
    // Progress either way: a plot short of seeds is finished on the next run.
    return { ok: true, status: "completed", message: `Developed a field at ${survey.offset.dx},${survey.offset.dz}: cleared ${data.cleared}, planted ${farm.planted}.`, data };
  }
}
