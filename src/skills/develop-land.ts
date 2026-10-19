import { createHash } from "node:crypto";
import type { Bot } from "mineflayer";
import type { Logger } from "pino";
import { Vec3 } from "vec3";
import type { AgentState } from "../agent/state.js";
import type { TaskSignals } from "../agent/scheduler.js";
import { travelAndWait, travelHomeAndWait, withoutPathfinderScaffolding } from "../minecraft/movement.js";
import { collectBlocks, isReachableFromGround, nearbyLogCensus, placeItemAt, touchesCraftedBlock } from "../minecraft/world.js";
import { countLogs, countPlanks, countSticks, findItem } from "../minecraft/inventory.js";
import { digBlock, shedJunk } from "../minecraft/primitives.js";
import { isDroppedItemEntity } from "../policy/combat.js";
import { botLookup, developmentPlots, hoeWoodShort, holdsHoe, tendFarm, type FarmLookup, type PlotOffset } from "./farm.js";
import type { SkillResult } from "./skill-library.js";
import type { BuildingDesign } from "../building/schema.js";
import type { BackgroundFailuresRepository } from "../memory/background-failures.js";
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
const FIELD_GROUND = /^(grass_block|dirt|coarse_dirt|rooted_dirt|podzol|farmland|mycelium)$/;
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

export interface DevelopmentWork { plot: string; kind: Development["kind"] }

export interface DevelopmentState {
  /** A development building is unfinished: only fields until it is done. */
  buildBusy: boolean;
  /** Plots ("dx,dz") whose leftover logs could not be reached: not tidied again. */
  tidySkip?: ReadonlySet<string>;
  /** Only schedule cleanup when at least one log has a safe supported approach. */
  canTidyLog?: (log: { x: number; y: number; z: number }) => boolean;
  /** Fields whose levelling was incomplete; left alone for this session. */
  levelSkip?: ReadonlySet<string>;
  /** Development buildings started so far (sets the next kind and the balance). */
  buildings: number;
  /** Plots set aside for trees, and whether home is short of trees. */
  treeFarm?: TreeFarmState;
  deferredPlots?: ReadonlySet<string>;
  /** Bound repeated maintenance failures without suppressing useful expansion. */
  deferMaintenance?: boolean;
  /** Scheduler/restore blockers are eligibility, not merely an enqueue-time veto. */
  accepts?: (work: DevelopmentWork) => boolean;
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
  const accepts = (kind: Development["kind"], survey: PlotSurvey): boolean => state.accepts?.({ kind, plot: `${survey.offset.dx},${survey.offset.dz}` }) ?? true;
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
    if (state.deferredPlots?.has(`${offset.dx},${offset.dz}`)) return;
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
      if (leftovers.some(log => state.canTidyLog?.(log) ?? true) && !state.tidySkip?.has(`${offset.dx},${offset.dz}`)) tidy.push({ ...field, leftoverLogs: leftovers });
      if (!touchesReserved(cx, cz, PLOT_HALF, blocked) && field.maxGround > field.minGround && field.maxGround - field.minGround <= FIELD_MAX_STEP && !state.levelSkip?.has(`${offset.dx},${offset.dz}`)) uneven.push(field);
      return;
    }
    if (touchesReserved(cx, cz, PLOT_HALF, blocked)) return;
    if (!state.levelSkip?.has(`${offset.dx},${offset.dz}`) && field.groundColumns >= MIN_GROUND_COLUMNS && field.maxGround - field.minGround <= FIELD_MAX_STEP) openFields.push(field);
    if (index < 3 || touchesReserved(cx, cz, SITE_HALF, blocked)) return;
    const site = surveyPlot(home, offset, lookup, SITE_HALF, SITE_LOG_CHECK);
    // A built site reads as mostly not ground and drops out here.
    if (site.farmland === 0 && site.groundColumns >= SITE_MIN_GROUND && site.maxGround - site.minGround <= SITE_MAX_STEP) openSites.push(site);
  });
  const tidyField = !state.deferMaintenance ? tidy.find(survey => accepts("tidy", survey)) : undefined;
  if (tidyField !== undefined) return { kind: "tidy", survey: tidyField };
  const unevenField = !state.deferMaintenance ? uneven.find(survey => accepts("level_field", survey)) : undefined;
  if (unevenField !== undefined) return { kind: "level_field", survey: unevenField, padY: modalGround(unevenField) };
  if (state.treeFarm?.canPlant === true) {
    for (const offset of farmPlots) {
      if (state.deferredPlots?.has(`${offset.dx},${offset.dz}`)) continue;
      const farm = surveyTreeFarm(home, offset, lookup);
      const survey = surveyPlot(home, offset, lookup);
      if (farm.empty.length > 0 && accepts("plant_trees", survey)) return { kind: "plant_trees", survey, farm };
    }
  }
  const isHomePlot = (offset: PlotOffset): boolean => plots.findIndex((p) => sameOffset(p, offset)) < 3;
  const homeField = openFields.find((field) => isHomePlot(field.offset) && accepts("field", field));
  if (homeField !== undefined) return { kind: "field", survey: homeField };
  // Short of trees: set the nearest open outer plot aside for them.
  if (state.treeFarm?.wanted === true && farmPlots.length < TREE_FARM_PLOTS) {
    const site = openFields.find((field) => !isHomePlot(field.offset) && accepts("tree_farm", field));
    if (site !== undefined) return { kind: "tree_farm", survey: site };
  }

  const buildingDue = !state.buildBusy && outerFields >= FIELDS_PER_BUILDING * (state.buildings + 1) - FIELDS_PER_BUILDING;
  const eligibleSites = buildingDue ? openSites.filter(survey => accepts("building", survey)) : [];
  if (eligibleSites.length > 0) {
    const nearest = eligibleSites.slice(0, SITE_CHOICES);
    const site = nearest.reduce((best, candidate) => (candidate.maxGround - candidate.minGround < best.maxGround - best.minGround ? candidate : best));
    const building = VILLAGE_ORDER[state.buildings % VILLAGE_ORDER.length]!;
    // The pad sits on the most common ground height; higher ground is cut
    // down to it and dips are filled up to it.
    const ground = modalGround(site);
    const cx = Math.floor(home.x) + site.offset.dx;
    const cz = Math.floor(home.z) + site.offset.dz;
    return { kind: "building", survey: site, building, origin: { x: cx - SITE_HALF, y: ground + 1, z: cz - SITE_HALF } };
  }
  const field = openFields.find(survey => accepts("field", survey));
  return field === undefined ? null : { kind: "field", survey: field };
}

/** Modal surface height, choosing the lower height on a tie. */
export function modalGround(survey: PlotSurvey): number {
  const counts = new Map<number, number>();
  for (const y of survey.groundYs) counts.set(y, (counts.get(y) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]![0];
}

/** Cells to cut and fill so a site's footprint is one flat pad at `padY`. Pure over `lookup`. */
export function levelPlan(origin: { x: number; z: number }, padY: number, size: number, lookup: FarmLookup): { cut: { x: number; y: number; z: number }[]; fill: { x: number; y: number; z: number }[]; blockers: string[] } {
  const cut: { x: number; y: number; z: number }[] = [];
  const fill: { x: number; y: number; z: number }[] = [];
  const blockers: string[] = [];
  for (let dx = 0; dx < size; dx++) {
    for (let dz = 0; dz < size; dz++) {
      const x = origin.x + dx;
      const z = origin.z + dz;
      // Preserve the whole column under a fixture/path; do not cut its support or fill inside it.
      let protectedColumn = false;
      for (let y = padY + SITE_MAX_STEP + 1; y >= padY - SITE_MAX_STEP; y--) {
        const block = lookup(x, y, z);
        if (block === null) { blockers.push(`unloaded column ${x},${y},${z}`); protectedColumn = true; break; }
        if (!isAirName(block.name) && !CLEARABLE.test(block.name) && !CROP.test(block.name) && !LEVEL_GROUND.test(block.name) && !/water/.test(block.name)) {
          blockers.push(`protected ${block.name} at ${x},${y},${z}`); protectedColumn = true; break;
        }
        if (y <= padY && LEVEL_GROUND.test(block.name)) break;
      }
      if (protectedColumn) continue;
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
  return { cut, fill, blockers };
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
  failures?: BackgroundFailuresRepository;
  now?: () => number;
  /** Last observed relevant home-store supplies; never opens containers from an idle probe. */
  materialsAvailable?: () => Readonly<Record<string, number>>;
  actions?: { home?: typeof travelHomeAndWait; travel?: typeof travelAndWait; place?: typeof placeItemAt; collect?: typeof collectBlocks };
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
  blocker?: string;
  cut?: number;
  filled?: number;
  tilled?: number;
}

export interface TreePlantResult { planted: number; blocker: "no_saplings" | "path_unreachable" | "invalid_ground" | "placement_refused" | "interrupted" | null }

export class DevelopLandRunner {
  private readonly deferred = new Map<string, { retryAt: number; reason: string; attempts: number; fingerprint: string }>();
  private maintenanceBudget = { startedAt: 0, failures: 0, retryAt: 0 };
  private readonly now: () => number;
  private get prefix(): string { return `development:${this.opts.state.worldId ?? "unknown"}:`; }
  constructor(private readonly opts: DevelopLandOptions) {
    this.now = opts.now ?? Date.now;
    for (const row of opts.failures?.loadAll() ?? []) {
      if (!row.action.startsWith(this.prefix)) continue;
      const key = row.action.slice(this.prefix.length);
      if (key === "saplings") this.saplingHuntAfter = row.retryAt;
      else if (key === "maintenance-budget") {
        try { this.maintenanceBudget = JSON.parse(row.reason); } catch { /* Legacy records are not budgets. */ }
      } else {
        let record = { reason: row.reason, attempts: 1, fingerprint: "" };
        try { const parsed = JSON.parse(row.reason); if (parsed.version === 1) record = parsed; } catch { /* Legacy plain-text blockers retain their cooldown. */ }
        this.deferred.set(key, { ...record, retryAt: row.retryAt });
      }
    }
  }

  /** Block identities, not crop age or bot pose: growing wheat must not reset a blocked plot. */
  private plotFingerprint(plot: PlotOffset, reason: string): string {
    const home = this.opts.state.home;
    if (home === null) return "no-home";
    const hash = createHash("sha256");
    for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) {
      for (let dy = -GROUND_SEARCH_DY; dy <= GROUND_SEARCH_DY; dy++) {
        const at = new Vec3(Math.floor(home.x) + plot.dx + dx, Math.floor(home.y) + dy, Math.floor(home.z) + plot.dz + dz);
        const block = this.opts.bot.blockAt(at);
        if (block === null) return "unloaded";
        // A cleanup failure concerns trunks and supported access. Incidental
        // harvest/replant or canopy decay must not erase its failure history.
        // Changed foliage access is reconsidered at the bounded retry time.
        const incidentalCover = /leftover logs/.test(reason) && (CROP.test(block.name) || CLEARABLE.test(block.name) && !TREE_LOG.test(block.name));
        hash.update(incidentalCover ? "air" : block.name); hash.update(";");
      }
    }
    // Only prerequisites relevant to this failure release it early.
    if (/sapling/.test(reason)) hash.update(String(countSaplings(this.opts.bot) > 0));
    if (/material|dirt|planting|tilling/.test(reason)) {
      const items = this.opts.bot.inventory.items();
      const relevant = /missing fill material|dirt required/.test(reason) ? /^dirt$/ : /^(dirt|wheat_seeds)$|_hoe$|_log$|_planks$/;
      const supplies: Record<string, number> = {};
      for (const [name, count] of Object.entries(this.opts.materialsAvailable?.() ?? {})) if (relevant.test(name) && count > 0) supplies[name] = count;
      for (const item of items) if (relevant.test(item.name)) supplies[item.name] = (supplies[item.name] ?? 0) + item.count;
      hash.update(JSON.stringify(Object.entries(supplies).sort()));
    }
    return hash.digest("hex");
  }

  private defer(plot: PlotOffset, reason: string, maintenance = false): void {
    const key = `${plot.dx},${plot.dz}`;
    const now = this.now();
    const fingerprint = this.plotFingerprint(plot, reason);
    const previous = this.deferred.get(key);
    const attempts = previous?.fingerprint === fingerprint ? previous.attempts + 1 : 1;
    // Persistent capped exponential backoff: a restart/expiry is not evidence of changed conditions.
    const baseDelay = /protected/.test(reason) ? 6 * 60 * 60_000 : SAPLING_HUNT_COOLDOWN_MS;
    const delay = Math.min(24 * 60 * 60_000, baseDelay * 2 ** Math.min(attempts - 1, 7));
    const record = { reason, attempts, fingerprint, retryAt: now + delay };
    this.deferred.set(key, record);
    this.opts.failures?.upsert({ action: this.prefix + key, failedAt: now, retryAt: record.retryAt, reason: JSON.stringify({ version: 1, ...record }) });
    if (maintenance) {
      const budget = this.maintenanceBudget;
      if (now >= budget.startedAt + 10 * 60_000) { budget.startedAt = now; budget.failures = 0; }
      budget.failures++;
      if (budget.failures >= 3) budget.retryAt = now + 10 * 60_000;
      this.opts.failures?.upsert({ action: this.prefix + "maintenance-budget", failedAt: now, retryAt: budget.retryAt, reason: JSON.stringify(budget) });
    }
    this.workMemo = null;
    this.opts.logger.info({ plot, reason, attempts, retryAt: record.retryAt }, "develop: plot deferred");
  }

  private deferredPlots(): ReadonlySet<string> {
    const blocked = new Set<string>();
    for (const [key, record] of this.deferred) {
      const [dx, dz] = key.split(",").map(Number);
      const fingerprint = this.plotFingerprint({ dx: dx!, dz: dz! }, record.reason);
      // Preserve retry history after expiry; remove it only when conditions really change.
      if (record.fingerprint !== "" && fingerprint !== "unloaded" && record.fingerprint !== fingerprint
        || record.reason === "no_saplings" && countSaplings(this.opts.bot) > 0) {
        this.deferred.delete(key);
        this.opts.failures?.remove(this.prefix + key);
      } else if (record.retryAt > this.now() || this.maintenanceBudget.retryAt > this.now()) blocked.add(key);
    }
    return blocked;
  }

  nextWork(accepts?: (work: DevelopmentWork) => boolean): DevelopmentWork | { plot: "home"; kind: "survey_home" } | null {
    const home = this.opts.state.home;
    const self = this.opts.bot.entity?.position;
    // A distant chunk view is only a reason to return home and survey. It
    // must not become an unidentified development task that mutates any plot.
    if (home !== null && self != null && Math.hypot(self.x - home.x, self.z - home.z) > 32) return { plot: "home", kind: "survey_home" };
    const next = home === null ? null : this.next(home, accepts);
    return next === null ? null : { plot: `${next.survey.offset.dx},${next.survey.offset.dz}`, kind: next.kind };
  }

  /**
   * Cut the site's high ground down to the pad and fill its dips with the
   * dirt dug out (cobblestone when the dirt runs short). Best effort: the
   * builder also digs bumps in its wall cells and props up gaps.
   */
  private async levelSite(origin: { x: number; y: number; z: number }, size: number, signal?: AbortSignal): Promise<{ cut: number; filled: number; blocker?: string }> {
    const bot = this.opts.bot;
    const blocked = new Set(this.opts.reservedCells?.() ?? []);
    const home = this.opts.state.home;
    if (home !== null) for (const farm of this.opts.treeFarm?.load() ?? []) {
      for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) blocked.add(`${Math.floor(home.x) + farm.dx + dx},0,${Math.floor(home.z) + farm.dz + dz}`);
    }
    if (touchesReserved(origin.x + (size - 1) / 2, origin.z + (size - 1) / 2, (size - 1) / 2, blocked)) return { cut: 0, filled: 0, blocker: "protected project or tree-farm reservation" };
    const plan = levelPlan(origin, origin.y - 1, size, botLookup(bot));
    let blocker = plan.blockers[0];
    const cutTargets = plan.cut.map((cell) => bot.blockAt(new Vec3(cell.x, cell.y, cell.z))).filter((block) => block !== null);
    if (cutTargets.length > 0) {
      try {
        await (this.opts.actions?.collect ?? collectBlocks)(bot, cutTargets, () => 0, Number.POSITIVE_INFINITY, () => {}, CLEAR_TIMEOUT_MS, (block, err) => { blocker = `cut ${block.name} at ${block.position}: ${String(err)}`; this.opts.logger.warn({ at: block.position, block: block.name, err: String(err) }, "develop: levelling cut skipped"); }, signal);
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
      if (item === null) { blocker = `missing fill material: dirt required at ${cell.x},${cell.y},${cell.z}`; break; }
      const at = new Vec3(cell.x, cell.y, cell.z);
      const below = bot.blockAt(at.offset(0, -1, 0));
      if (below === null || (below.boundingBox !== "block" && below.name !== "farmland")) { blocker = `unsupported fill at ${cell.x},${cell.y},${cell.z}`; continue; }
      const walked = await (this.opts.actions?.travel ?? travelAndWait)(bot, at, { range: 3, timeoutMs: 15_000, signal });
      if (walked.status !== "arrived" && walked.status !== "already_there") { blocker = `fill approach ${walked.status} at ${cell.x},${cell.y},${cell.z}`; continue; }
      const cover = bot.blockAt(at);
      if (cover === null) continue;
      if (!isAirName(cover.name)) {
        if (!CLEARABLE.test(cover.name) && !CROP.test(cover.name) && !/water/.test(cover.name)) continue;
        if (!/water/.test(cover.name)) await digBlock(bot, cover, signal);
      }
      const placed = await (this.opts.actions?.place ?? placeItemAt)(bot, item, { position: at, reference: below, face: new Vec3(0, 1, 0) }, signal).catch((err) => { if (signal?.aborted) throw err; blocker = `fill refused at ${cell.x},${cell.y},${cell.z}: ${String(err)}`; return null; });
      if (placed !== null && bot.blockAt(at)?.name === item.name) filled += 1;
      else blocker ??= `fill not verified at ${cell.x},${cell.y},${cell.z}`;
    }
    if (cut < plan.cut.length) blocker ??= "planned ground cuts not verified";
    return { cut, filled, blocker };
  }

  private readonly levelSkip = new Set<string>();
  /** The last idle-check answer, reused for a minute (surveying every ring is slow). */
  private workMemo: { at: number; work: boolean } | null = null;

  /** True when a plot within the development rings is left to develop. */
  hasWork(): boolean {
    if (this.workMemo !== null && this.now() - this.workMemo.at < WORK_MEMO_MS) return this.workMemo.work;
    const work = this.computeHasWork();
    this.workMemo = { at: this.now(), work };
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

  private next(home: { x: number; y: number; z: number }, accepts?: (work: DevelopmentWork) => boolean): Development | null {
    const builds = this.opts.builds;
    return nextDevelopment(home, cachedLookup(botLookup(this.opts.bot)), this.opts.reservedCells?.() ?? new Set(), { buildBusy: builds === undefined || builds.busy(), buildings: builds?.count() ?? 0, levelSkip: this.levelSkip, treeFarm: this.treeFarmState(), deferredPlots: this.deferredPlots(), deferMaintenance: this.maintenanceBudget.retryAt > this.now(), canTidyLog: log => isReachableFromGround(this.opts.bot, new Vec3(log.x, log.y, log.z)), accepts });
  }

  /** When a sapling hunt may run again (it found none last time). */
  private saplingHuntAfter = 0;

  private treeFarmState(): TreeFarmState | undefined {
    const store = this.opts.treeFarm;
    if (store === undefined) return undefined;
    const trees = Object.values(nearbyLogCensus(this.opts.bot).trees).reduce((sum, count) => sum + count, 0);
    return { plots: store.load(), wanted: trees < TREE_FARM_WANTED_BELOW, canPlant: countSaplings(this.opts.bot) > 0 || this.now() >= this.saplingHuntAfter };
  }

  /**
   * Saplings for the farm: from the chest, off the ground (decaying leaves
   * drop them), and failing both, from leaves broken within reach of the
   * ground. Best effort; a hunt that finds none waits before the next.
   */
  private async gatherSaplings(signal?: AbortSignal): Promise<void> {
    const bot = this.opts.bot;
    if (this.now() < this.saplingHuntAfter) return;
    await this.opts.treeFarm?.fetchSaplings(signal).catch((err) => this.opts.logger.warn({ err: String(err) }, "develop: could not take saplings from the chest"));
    if (countSaplings(bot) === 0) await this.pickUpSaplings(signal);
    if (countSaplings(bot) === 0 && signal?.aborted !== true) {
      const self = bot.entity?.position;
      if (self !== undefined && self !== null) {
        const leaves = bot.findBlocks({ matching: (block) => block !== null && /_leaves$/.test(block.name), maxDistance: SAPLING_SEARCH_RADIUS, count: 200 })
          .map((position) => bot.blockAt(position))
          .filter((block): block is NonNullable<typeof block> => block !== null && block.position.y <= self.y + 3 && block.position.y >= self.y - 2)
          .filter(block => isReachableFromGround(bot, block.position) && !touchesCraftedBlock(bot, block.position))
          .sort((a, b) => a.position.distanceTo(self) - b.position.distanceTo(self))
          .slice(0, SAPLING_LEAVES_PER_RUN);
        if (leaves.length > 0) {
          this.opts.logger.info({ leaves: leaves.length }, "develop: breaking leaves for saplings");
          await (this.opts.actions?.collect ?? collectBlocks)(bot, leaves, () => countSaplings(bot), 8, () => {}, 30_000, undefined, signal).catch((err) => {
            if (signal?.aborted === true) throw err;
            this.opts.logger.warn({ err: String(err) }, "develop: breaking leaves stopped");
          });
          await this.pickUpSaplings(signal);
        }
      }
    }
    if (countSaplings(bot) === 0 && !signal?.aborted) {
      const now = this.now();
      this.saplingHuntAfter = now + SAPLING_HUNT_COOLDOWN_MS;
      this.opts.failures?.upsert({ action: this.prefix + "saplings", failedAt: now, retryAt: this.saplingHuntAfter, reason: "no saplings from reachable chest, drops, or leaves" });
    } else if (countSaplings(bot) > 0) {
      this.saplingHuntAfter = 0;
      this.opts.failures?.remove(this.prefix + "saplings");
    }
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
      if (isReachableFromGround(bot, drop.position)) await (this.opts.actions?.travel ?? travelAndWait)(bot, drop.position, { range: 1, timeoutMs: 8_000, signal });
    }
  }

  /** Plant saplings in the farm's empty cells; returns how many went in. */
  private async plantTrees(farm: TreeFarmSurvey, signals?: TaskSignals): Promise<TreePlantResult> {
    const bot = this.opts.bot;
    const signal = signals?.signal;
    if (countSaplings(bot) === 0) await this.gatherSaplings(signal);
    let planted = 0;
    let blocker: TreePlantResult["blocker"] = countSaplings(bot) === 0 ? "no_saplings" : null;
    for (const cell of farm.empty) {
      if (signal?.aborted === true || signals?.checkpoint() === false) { blocker = "interrupted"; break; }
      const sapling = bot.inventory.items().find((item) => /_sapling$/.test(item.name));
      if (sapling === undefined) break;
      const at = new Vec3(cell.x, cell.y, cell.z);
      const walked = await (this.opts.actions?.travel ?? travelAndWait)(bot, at, { range: 3, timeoutMs: 20_000, signal });
      if (walked.status !== "arrived" && walked.status !== "already_there") { blocker = "path_unreachable"; continue; }
      const cover = bot.blockAt(at);
      if (cover !== null && !isAirName(cover.name)) {
        if (!CLEARABLE.test(cover.name) || TREE_LOG.test(cover.name) || /_sapling$/.test(cover.name)) { blocker = "invalid_ground"; continue; }
        await digBlock(bot, cover, signal).catch(() => undefined);
      }
      const ground = bot.blockAt(at.offset(0, -1, 0));
      if (ground === null || !FIELD_GROUND.test(ground.name) || ground.name === "farmland") { blocker = "invalid_ground"; continue; }
      const placed = await (this.opts.actions?.place ?? placeItemAt)(bot, sapling, { position: at, reference: ground, face: new Vec3(0, 1, 0) }, signal).catch((err) => { if (signal?.aborted) throw err; return null; });
      if (placed !== null && /_sapling$/.test(placed.name)) planted += 1;
      else blocker = "placement_refused";
    }
    return { planted, blocker };
  }

  async run(options: { signals?: TaskSignals; planned?: DevelopmentWork } = {}): Promise<SkillResult<DevelopLandData>> {
    // Approaching floating logs must not leave pillars; field walks must not
    // place dirt back into freshly cut columns either.
    return withoutPathfinderScaffolding(this.opts.bot, () => this.runWork(options));
  }

  private async runWork(options: { signals?: TaskSignals; planned?: DevelopmentWork }): Promise<SkillResult<DevelopLandData>> {
    const bot = this.opts.bot;
    const signals = options.signals;
    const signal = signals?.signal;
    const home = this.opts.state.home;
    const data: DevelopLandData = { plot: null, cleared: 0, planted: 0 };
    const interrupted = (): SkillResult<DevelopLandData> => ({ ok: false, status: "interrupted", message: "interrupted", data });
    if (home === null) return { ok: false, status: "failed", errorCode: "NOT_READY", message: "no home to develop around", retryable: false, data };

    const travel = await (this.opts.actions?.home ?? travelHomeAndWait)(bot, home, { dimension: home.dimension, timeoutMs: TRAVEL_TIMEOUT_MS, signal, shouldAbort: () => signals?.checkpoint() === false });
    if (signals?.checkpoint() === false) return interrupted();
    if (travel.status !== "arrived" && travel.status !== "already_there") {
      return { ok: false, status: "failed", errorCode: "PATH_UNREACHABLE", message: `could not reach home: ${travel.status}`, retryable: true, data };
    }

    this.workMemo = null;
    const planned = options.planned;
    const next = this.next(home, planned === undefined ? undefined : work => work.kind === planned.kind && work.plot === planned.plot);
    if (planned !== undefined && next === null) return { ok: false, status: "failed", errorCode: "DEVELOPMENT_PLAN_STALE", message: `Planned ${planned.kind} at ${planned.plot} is no longer eligible; select fresh work.`, retryable: false, data };

    // Harvests bring seeds and saplings by the stack: shed the surplus so
    // clearing and crafting have room.
    // Fill blocks are work supplies here, even though generic gathering sheds them.
    await shedJunk(bot, ["dirt", "cobblestone"], signal).catch(() => 0);
    if (next === null) return { ok: true, status: "completed", message: this.deferred.size > 0 || this.now() < this.saplingHuntAfter ? "No runnable development; prerequisites are cooling down." : "The land around home is developed.", data };
    const survey = next.survey;
    data.plot = survey.offset;
    if (next.kind === "tidy") {
      this.opts.logger.info({ plot: survey.offset, logs: survey.leftoverLogs.length }, "develop: taking down leftover tree trunks");
      const logs = survey.leftoverLogs.map((cell) => bot.blockAt(new Vec3(cell.x, cell.y, cell.z))).filter((block): block is NonNullable<typeof block> => block !== null && TREE_LOG.test(block.name));
      try {
        await (this.opts.actions?.collect ?? collectBlocks)(bot, logs.filter((log) => isReachableFromGround(bot, log.position)), () => 0, Number.POSITIVE_INFINITY, () => {}, CLEAR_TIMEOUT_MS, (block, err) => this.opts.logger.warn({ at: block.position, err: String(err) }, "develop: tidy target skipped"), signal);
      } catch (err) {
        if (signal?.aborted === true) return interrupted();
        this.opts.logger.warn({ err: String(err) }, "develop: tidying stopped");
      }
      const left = survey.leftoverLogs.filter((cell) => { const current = bot.blockAt(new Vec3(cell.x, cell.y, cell.z)); return current === null || TREE_LOG.test(current.name); }).length;
      data.cleared = logs.filter((log) => { const current = bot.blockAt(log.position); return current !== null && !TREE_LOG.test(current.name); }).length;
      // Preserve the blocked plot across restarts; a zero-change pass must
      // never be recorded as successful clearing.
      this.opts.logger.info({ plot: survey.offset, cleared: data.cleared, unreachable: left }, "develop: tidy done");
      if (left > 0) this.defer(survey.offset, "leftover logs unreachable from supported ground", data.cleared === 0);
      if (data.cleared === 0 && left > 0) return { ok: false, status: "failed", errorCode: "PATH_UNREACHABLE", message: `No leftover logs cleared at ${survey.offset.dx},${survey.offset.dz}; plot deferred.`, retryable: true, data };
      return { ok: true, status: "completed", message: `Took down ${data.cleared} leftover logs over the field at ${survey.offset.dx},${survey.offset.dz}.`, data };
    }
    if (next.kind === "plant_trees") {
      this.opts.logger.info({ plot: survey.offset, empty: next.farm.empty.length, saplings: countSaplings(bot) }, "develop: planting the tree farm");
      const result = await this.plantTrees(next.farm, signals);
      data.trees = result.planted;
      data.blocker = result.blocker ?? undefined;
      if (signals?.checkpoint() === false) return interrupted();
      this.opts.logger.info({ plot: survey.offset, planted: data.trees }, "develop: tree farm planted");
      if (data.trees === 0) {
        this.defer(survey.offset, result.blocker ?? "no planting progress");
        return { ok: false, status: "failed", errorCode: result.blocker === "path_unreachable" ? "PATH_UNREACHABLE" : "NOT_READY", message: `tree farm at ${survey.offset.dx},${survey.offset.dz} deferred: ${result.blocker}`, retryable: true, data };
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
      data.cleared = targets.filter((target) => ((block) => block !== null && !CLEARABLE.test(block.name))(bot.blockAt(target.position))).length;
    }
    if (signals?.checkpoint({ plot: survey.offset }) === false) return interrupted();

    if (next.kind === "building") {
      data.building = next.building;
      const level = await this.levelSite(next.origin, VILLAGE_SITE, signal);
      if (signal?.aborted === true || signals?.checkpoint() === false) return interrupted();
      this.opts.logger.info({ building: next.building, cut: level.cut, filled: level.filled }, "develop: site levelled");
      const remaining = levelPlan(next.origin, next.origin.y - 1, VILLAGE_SITE, botLookup(bot));
      if (remaining.cut.length > 0 || remaining.fill.length > 0 || remaining.blockers.length > 0) {
        this.defer(survey.offset, level.blocker ?? "building pad not verified level", level.cut === 0 && level.filled === 0 && data.cleared === 0);
        return { ok: false, status: "failed", errorCode: "NOT_READY", message: "building pad not verified level; site deferred", retryable: true, data };
      }
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
      const result = await this.plantTrees(farm, signals);
      data.trees = result.planted;
      data.blocker = result.blocker ?? undefined;
      if (signals?.checkpoint() === false) return interrupted();
      this.opts.logger.info({ plot: survey.offset, planted: data.trees }, "develop: tree farm planted");
      if (data.trees === 0) {
        this.defer(survey.offset, result.blocker ?? "no planting progress");
        return { ok: false, status: "failed", errorCode: "NOT_READY", message: `tree farm reserved but planting deferred: ${result.blocker}`, retryable: true, data };
      }
      return { ok: true, status: "completed", message: `Set the plot at ${survey.offset.dx},${survey.offset.dz} aside for trees and planted ${data.trees} saplings.`, data };
    }

    const padY = next.kind === "level_field" ? next.padY : modalGround(survey);
    const origin = { x: Math.floor(home.x) + survey.offset.dx - PLOT_HALF, y: padY + 1, z: Math.floor(home.z) + survey.offset.dz - PLOT_HALF };
    this.opts.logger.info({ plot: survey.offset, padY }, "develop: levelling a field");
    const level = survey.maxGround === survey.minGround ? { cut: 0, filled: 0, blocker: undefined } : await this.levelSite(origin, 5, signal);
    if (signal?.aborted === true || signals?.checkpoint() === false) return interrupted();
    data.cut = level.cut;
    data.filled = level.filled;
    data.blocker = level.blocker;
    const after = surveyPlot(home, survey.offset, botLookup(bot));
    const complete = after.groundColumns >= survey.groundColumns && after.minGround === padY && after.maxGround === padY;
    if (!complete) this.defer(survey.offset, level.blocker ?? "field not verified level", level.cut === 0 && level.filled === 0 && data.cleared === 0);
    this.opts.logger.info({ plot: survey.offset, padY, ...level, complete, ground: after.groundColumns, minGround: after.minGround, maxGround: after.maxGround }, "develop: field levelled");
    if (!complete) return { ok: false, status: "failed", errorCode: "NOT_READY", message: `could not fully level the field at ${survey.offset.dx},${survey.offset.dz}: ${level.blocker ?? "ground heights still differ"}`, retryable: true, data };

    // A hoe is made from carried wood; fetch some first when there is none.
    if (this.opts.fetchWood !== undefined && hoeWoodShort({ hoe: holdsHoe(bot), planks: countPlanks(bot), logs: countLogs(bot), sticks: countSticks(bot) })) {
      await this.opts.fetchWood(signal).catch((err) => this.opts.logger.warn({ err: String(err) }, "develop: could not fetch wood for a hoe"));
      if (signal?.aborted || signals?.checkpoint() === false) return interrupted();
    }
    // Till and sow it: the farm takes the cleared plot first.
    const farm = await tendFarm({ bot, home, logger: this.opts.logger, signal, shouldAbort: () => signals?.checkpoint() === false, preferPlot: survey.offset, onlyPreferredPlot: true });
    if (signals?.checkpoint() === false) return interrupted();
    data.planted = farm.planted;
    data.tilled = farm.tilled;
    this.opts.logger.info({ plot: survey.offset, cleared: data.cleared, planted: farm.planted, tilled: farm.tilled }, "develop: field done");
    // No progress at all would re-run on the same plot every few seconds
    // (14:41): fail so the restore cooldown spaces the retries.
    if (!complete || (data.cleared === 0 && level.cut === 0 && level.filled === 0 && farm.planted === 0 && farm.tilled === 0)) {
      this.defer(survey.offset, "no verified clearing, levelling, or planting progress: check seeds, hoe and materials", true);
      return { ok: false, status: "failed", errorCode: "NOT_READY", message: `could not clear or plant the field at ${survey.offset.dx},${survey.offset.dz}`, retryable: true, data };
    }
    // A plot short of seeds is finished on the next run.
    return { ok: true, status: "completed", message: `Developed a field at ${survey.offset.dx},${survey.offset.dz}: cleared ${data.cleared}, planted ${farm.planted}.`, data };
  }
}
