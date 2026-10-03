import type { Bot } from "mineflayer";
import type { Logger } from "pino";
import { Vec3 } from "vec3";
import type { TaskSignals } from "../agent/scheduler.js";
import { throwIfAborted } from "../agent/world-actions.js";
import { bareName } from "../minecraft/inventory.js";
import { travelAndWait } from "../minecraft/movement.js";
import { digBlock, equipItem, equipToolForBlock, placeBlock } from "../minecraft/primitives.js";
import { HOSTILE_MOB_NAMES, isMobEntity } from "../policy/combat.js";
import { TOOL_FAMILIES } from "./expedition.js";
import { sleep as waitMs, type SkillResult } from "./skill-library.js";

/**
 * Emergency night shelter: with no bed to sleep in, CobbleBob stood in the
 * open all night and spiders and skeletons killed him three times on a fresh
 * world's first night. This digs a small sealed pocket and waits for day:
 *
 *   surface  y-1   S  .        S = the shaft he digs straight down (4 deep)
 *            y-2   S  .        P = a side pocket at the shaft's bottom,
 *            y-3   S  P          one block over, two tall; he steps in and
 *            y-4   S  P          refills the shaft from below
 *
 * Every mob on the surface then stands at least 4 blocks above his feet with
 * two blocks of untouched ground over his head, and the shaft is solid again.
 * In the morning the pathfinder digs and towers him back out.
 */

/** Ticks (time of day) from which the bot heads underground: before mobs spawn at ~13000. */
export const SHELTER_START_TICK = 12_500;
/** How far around the bot to look for a diggable spot. */
const SPOT_SEARCH_RADIUS = 6;
/** How far above/below the bot's feet the surface of a candidate column may be. */
const SPOT_SEARCH_HEIGHT = 2;
/** Shaft depth below the surface feet level. */
const SHAFT_DEPTH = 4;
/** Poll cadence while waiting for morning. */
const WAIT_POLL_MS = 2_000;
/** Max wait for a fall to settle after digging the block underfoot. */
const FALL_SETTLE_MS = 3_000;
const STEP_TIMEOUT_MS = 15_000;
const BREAKOUT_TIMEOUT_MS = 60_000;

const AIR = new Set(["air", "cave_air", "void_air"]);
const FLUIDS = new Set(["water", "flowing_water", "lava", "flowing_lava", "bubble_column"]);
/** Plants and snow layers the bot can stand in; they do not block the shaft. */
const STANDABLE_PLANTS = /^(?:short_grass|grass|tall_grass|fern|large_fern|dead_bush|snow|[a-z_]+_tulip|dandelion|poppy|azure_bluet|oxeye_daisy|cornflower|allium|blue_orchid|lily_of_the_valley|sunflower|lilac|rose_bush|peony|[a-z_]+_mushroom|sweet_berry_bush)$/;
/** Soil: diggable quickly by hand, never falls, never melts. */
const SOIL = new Set(["dirt", "coarse_dirt", "rooted_dirt", "grass_block", "podzol", "mycelium", "mud", "clay", "snow_block", "moss_block"]);
/** Stone that needs a pickaxe to dig in reasonable time (and to drop anything). */
const STONE = new Set(["stone", "deepslate", "tuff", "calcite", "andesite", "diorite", "granite", "sandstone", "red_sandstone", "terracotta", "netherrack", "blackstone", "basalt", "smooth_basalt", "dripstone_block"]);
/** Full blocks worth spending on refilling the shaft, best first. */
const FILL_PREFERENCE = ["dirt", "coarse_dirt", "cobblestone", "cobbled_deepslate", "netherrack", "andesite", "diorite", "granite", "tuff", "stone", "deepslate", "sandstone", "mud", "clay", "moss_block", "rooted_dirt", "podzol", "mycelium", "grass_block"];

export interface Cell { x: number; y: number; z: number }

/** A block lookup by integer coordinates: the block's bare name, or null when the chunk is not loaded. */
export type CellLookup = (x: number, y: number, z: number) => string | null;

export interface ShelterSpot {
  /** Surface feet cell of the shaft column (the bot stands here to start). */
  shaft: Cell;
  /** Horizontal direction from the shaft to the side pocket. */
  dir: { dx: number; dz: number };
}

const DIRS = [{ dx: 1, dz: 0 }, { dx: -1, dz: 0 }, { dx: 0, dz: 1 }, { dx: 0, dz: -1 }] as const;

export function isShelterNight(timeOfDay: number): boolean {
  return timeOfDay >= SHELTER_START_TICK;
}

/**
 * Leaving at tick 0 walked into the night's zombies and spiders before the
 * sun had burned them (13:20, down to 1 HP from full). Wait for full morning,
 * and for the area to clear, but not past mid-morning: a mob in shade can
 * linger all day.
 */
const LEAVE_AFTER_TICK = 1_500;
const LEAVE_ANYWAY_TICK = 4_000;
/** Hostiles this close to the pocket keep the bot sealed in. */
const EXIT_THREAT_RADIUS = 16;

export function shelterCanLeave(timeOfDay: number, hostileNearby: boolean): boolean {
  if (isShelterNight(timeOfDay) || timeOfDay < LEAVE_AFTER_TICK) return false;
  return !hostileNearby || timeOfDay >= LEAVE_ANYWAY_TICK;
}

function passable(name: string | null): boolean {
  return name !== null && (AIR.has(name) || STANDABLE_PLANTS.test(name));
}

function fluid(name: string | null): boolean {
  return name !== null && FLUIDS.has(name);
}

/** A block the shelter may dig out: soil always, stone only with a pickaxe. */
export function diggableShelterBlock(name: string | null, hasPickaxe: boolean): boolean {
  if (name === null) return false;
  return SOIL.has(name) || (hasPickaxe && (STONE.has(name) || /(?:^|_)ore$/.test(name)));
}

/** Solid, stable ground for a roof or a floor (never falls, never melts). */
function solidGround(name: string | null): boolean {
  return diggableShelterBlock(name, true) || name === "cobblestone" || name === "cobbled_deepslate" || name === "bedrock";
}

/** The cells the shelter digs out for a spot. */
export function shelterDigCells(spot: ShelterSpot): { shaft: Cell[]; pocket: Cell[] } {
  const { shaft: s, dir } = spot;
  const shaft = Array.from({ length: SHAFT_DEPTH }, (_, i) => ({ x: s.x, y: s.y - 1 - i, z: s.z }));
  const px = s.x + dir.dx;
  const pz = s.z + dir.dz;
  const bottom = s.y - SHAFT_DEPTH;
  return { shaft, pocket: [{ x: px, y: bottom, z: pz }, { x: px, y: bottom + 1, z: pz }] };
}

/** The pocket's feet cell, where the bot spends the night. */
export function shelterPocketFeet(spot: ShelterSpot): Cell {
  return { x: spot.shaft.x + spot.dir.dx, y: spot.shaft.y - SHAFT_DEPTH, z: spot.shaft.z + spot.dir.dz };
}

/** True when `spot` can be dug and sealed safely (see the module comment). */
export function validShelterSpot(cell: CellLookup, spot: ShelterSpot, hasPickaxe: boolean): boolean {
  const { shaft: s } = spot;
  // He must be able to stand on the surface cell to start.
  if (!passable(cell(s.x, s.y, s.z)) || !passable(cell(s.x, s.y + 1, s.z))) return false;
  const { shaft, pocket } = shelterDigCells(spot);
  const dug = [...shaft, ...pocket];
  if (!dug.every((c) => diggableShelterBlock(cell(c.x, c.y, c.z), hasPickaxe))) return false;
  const bottom = s.y - SHAFT_DEPTH;
  const p = pocket[0]!;
  // Floors under the shaft (the refill's first reference) and the pocket.
  if (!solidGround(cell(s.x, bottom - 1, s.z)) || !solidGround(cell(p.x, bottom - 1, p.z))) return false;
  // Two blocks of stable roof over the pocket: nothing falls in, and a mob
  // on the surface stays 4 blocks above his feet.
  if (!solidGround(cell(p.x, bottom + 2, p.z)) || !solidGround(cell(p.x, bottom + 3, p.z))) return false;
  // No fluid may touch any dug cell, or it floods the pocket.
  const dugKeys = new Set(dug.map((c) => `${c.x},${c.y},${c.z}`));
  for (const c of dug) {
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const) {
      const n = { x: c.x + dx, y: c.y + dy, z: c.z + dz };
      if (dugKeys.has(`${n.x},${n.y},${n.z}`)) continue;
      const name = cell(n.x, n.y, n.z);
      if (name === null || fluid(name)) return false;
    }
  }
  // The pocket's walls (other than the shaft side) must be solid so it is sealed.
  for (const c of pocket) {
    for (const d of DIRS) {
      const n = { x: c.x + d.dx, y: c.y, z: c.z + d.dz };
      if (n.x === s.x && n.z === s.z) continue;
      if (!solidGround(cell(n.x, n.y, n.z))) return false;
    }
  }
  return true;
}

/**
 * The nearest valid shelter spot around `origin` (the bot's feet cell), or
 * null. Columns are searched outward; within one column the surface may sit
 * a couple of blocks above or below the bot.
 */
export function findShelterSpot(cell: CellLookup, origin: Cell, hasPickaxe: boolean, radius = SPOT_SEARCH_RADIUS): ShelterSpot | null {
  const columns: Array<{ x: number; z: number; d: number }> = [];
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      const d = Math.hypot(dx, dz);
      if (d <= radius) columns.push({ x: origin.x + dx, z: origin.z + dz, d });
    }
  }
  columns.sort((a, b) => a.d - b.d);
  for (const column of columns) {
    for (let dy = 0; dy <= SPOT_SEARCH_HEIGHT; dy++) {
      for (const y of dy === 0 ? [origin.y] : [origin.y + dy, origin.y - dy]) {
        for (const dir of DIRS) {
          const spot: ShelterSpot = { shaft: { x: column.x, y, z: column.z }, dir: { dx: dir.dx, dz: dir.dz } };
          if (validShelterSpot(cell, spot, hasPickaxe)) return spot;
        }
      }
    }
  }
  return null;
}

/**
 * True when the cell at `feet` is a sealed pocket: solid on all four sides at
 * feet and head height and above the head. A resumed shelter task (paused by
 * a reflex, or a restart) that finds the bot already sealed simply waits.
 */
export function isSealedPocket(cell: CellLookup, feet: Cell): boolean {
  const solid = (x: number, y: number, z: number): boolean => {
    const name = cell(x, y, z);
    return name !== null && !passable(name) && !fluid(name);
  };
  if (!solid(feet.x, feet.y + 2, feet.z)) return false;
  for (const d of DIRS) {
    if (!solid(feet.x + d.dx, feet.y, feet.z + d.dz) || !solid(feet.x + d.dx, feet.y + 1, feet.z + d.dz)) return false;
  }
  return true;
}

export interface NightShelterOptions {
  bot: Bot;
  logger: Logger;
  /** Owner work waiting: give up the shelter so the owner is not kept waiting until morning. */
  ownerWorkPending?: () => boolean;
}

export interface NightShelterData {
  sheltered: boolean;
  spot: ShelterSpot | null;
  interruptions: number;
}

/** Deterministic runner for the `night_shelter` task. One run at a time. */
export class NightShelterRunner {
  private running = false;
  private signals: TaskSignals | null = null;
  private stopRequested = false;
  private interruptions = 0;

  constructor(private readonly opts: NightShelterOptions) {}

  get isRunning(): boolean {
    return this.running;
  }

  async run(options: { signals?: TaskSignals; resumeState?: { interruptions?: number } } = {}): Promise<SkillResult<NightShelterData>> {
    if (this.running) return { ok: false, status: "blocked", errorCode: "ALREADY_RUNNING", message: "already sheltering" };
    this.running = true;
    this.signals = options.signals ?? null;
    this.stopRequested = false;
    this.interruptions = typeof options.resumeState?.interruptions === "number" ? options.resumeState.interruptions : 0;
    const data: NightShelterData = { sheltered: false, spot: null, interruptions: this.interruptions };
    try {
      return await this.execute(data);
    } finally {
      this.running = false;
      this.signals = null;
    }
  }

  private async execute(data: NightShelterData): Promise<SkillResult<NightShelterData>> {
    const bot = this.opts.bot;
    if (bot.entity === null || bot.entity === undefined) return this.fail(data, "NOT_READY", "bot is not spawned");
    const cell = this.lookup();

    if (!isSealedPocket(cell, this.feet())) {
      if (!isShelterNight(bot.time.timeOfDay)) return { ok: true, status: "completed", data, message: "It is day; no shelter needed." };
      const dug = await this.digIn(data, cell);
      if (dug !== null) return dug;
    } else {
      this.opts.logger.info({ at: this.feet() }, "night shelter: already sealed in; waiting for day");
    }
    data.sheltered = true;

    // Wait out the night, sealed in.
    while (!shelterCanLeave(bot.time.timeOfDay, this.hostileNearby())) {
      this.checkInterrupt();
      if (this.stopRequested) return this.interrupted(data);
      if (this.opts.ownerWorkPending?.() === true) {
        this.opts.logger.info("night shelter: owner work is waiting; leaving the shelter early");
        break;
      }
      await waitMs(WAIT_POLL_MS);
    }

    this.opts.logger.info({ at: this.feet() }, "night shelter: day, breaking out");
    const out = await this.breakOut(data);
    if (out !== null) return out;
    return { ok: true, status: "completed", data, message: "Morning. Out of the shelter." };
  }

  /** Dig the shaft and pocket, step in, refill the shaft. Null on success. */
  private async digIn(data: NightShelterData, cell: CellLookup): Promise<SkillResult<NightShelterData> | null> {
    const bot = this.opts.bot;
    const signal = this.signals?.signal;
    const hasPickaxe = TOOL_FAMILIES.pickaxe.some((name) => bot.inventory.items().some((item) => bareName(item.name) === name));
    const spot = findShelterSpot(cell, this.feet(), hasPickaxe);
    if (spot === null) return this.fail(data, "RESOURCE_NOT_FOUND", "no safe ground to dig a night shelter in nearby");
    data.spot = spot;
    this.opts.logger.info({ spot, hasPickaxe }, "night shelter: digging in");

    // Stand exactly on the shaft column.
    const start = await travelAndWait(bot, spot.shaft, { range: 0, timeoutMs: STEP_TIMEOUT_MS, allowDig: false, shouldAbort: this.travelAbort, signal });
    if (this.stopRequested) return this.interrupted(data);
    if (start.status !== "arrived" && start.status !== "already_there") return this.fail(data, "PATH_UNREACHABLE", `could not reach the shelter spot: ${start.status}`);

    // Dig straight down, dropping one block at a time.
    const { shaft, pocket } = shelterDigCells(spot);
    for (const c of shaft) {
      const failure = await this.dig(data, c);
      if (failure !== null) return failure;
      await this.settleAt(c.y);
    }
    // Dig the side pocket (feet then head) and step in.
    for (const c of pocket) {
      const failure = await this.dig(data, c);
      if (failure !== null) return failure;
    }
    const feet = shelterPocketFeet(spot);
    const step = await travelAndWait(bot, feet, { range: 0, timeoutMs: STEP_TIMEOUT_MS, allowDig: false, shouldAbort: this.travelAbort, signal });
    if (this.stopRequested) return this.interrupted(data);
    if (step.status !== "arrived" && step.status !== "already_there") return this.fail(data, "PATH_UNREACHABLE", `could not step into the shelter pocket: ${step.status}`);

    // Refill the shaft bottom-up; the first two blocks seal the pocket.
    const bottomUp = [...shaft].reverse();
    let placed = 0;
    for (const c of bottomUp) {
      this.checkInterrupt();
      if (this.stopRequested) return this.interrupted(data);
      const item = this.fillItem();
      if (item === null) break;
      const reference = bot.blockAt(new Vec3(c.x, c.y - 1, c.z));
      if (reference === null) break;
      try {
        throwIfAborted(signal);
        await equipItem(bot, item, signal);
        await placeBlock(bot, reference, new Vec3(0, 1, 0), signal, c, bareName(item.name));
        placed += 1;
      } catch (err) {
        if (signal?.aborted === true) return this.interrupted(data);
        this.opts.logger.warn({ at: c, err: String(err) }, "night shelter: could not refill the shaft");
        break;
      }
    }
    if (placed < 2 && !isSealedPocket(this.lookup(), this.feet())) {
      return this.fail(data, "INSUFFICIENT_MATERIALS", "could not seal the night shelter");
    }
    this.opts.logger.info({ at: this.feet(), refilled: placed }, "night shelter: dug in");
    return null;
  }

  /** Back to the surface: the pathfinder digs natural ground and towers up. */
  private async breakOut(data: NightShelterData): Promise<SkillResult<NightShelterData> | null> {
    const bot = this.opts.bot;
    const self = bot.entity?.position;
    if (self === undefined || self === null) return null;
    const surfaceY = Math.floor(self.y) + SHAFT_DEPTH;
    const out = await travelAndWait(bot, { x: Math.floor(self.x), y: surfaceY, z: Math.floor(self.z) }, {
      range: 2,
      timeoutMs: BREAKOUT_TIMEOUT_MS,
      allowDig: true,
      shouldAbort: this.travelAbort,
      signal: this.signals?.signal,
    });
    if (this.stopRequested) return this.interrupted(data);
    if (out.status !== "arrived" && out.status !== "already_there") {
      // Not fatal: the next trip anywhere digs out the same way.
      this.opts.logger.warn({ travel: out }, "night shelter: break-out trip did not reach the surface");
    }
    return null;
  }

  private async dig(data: NightShelterData, c: Cell): Promise<SkillResult<NightShelterData> | null> {
    const bot = this.opts.bot;
    const signal = this.signals?.signal;
    this.checkInterrupt();
    if (this.stopRequested) return this.interrupted(data);
    const block = bot.blockAt(new Vec3(c.x, c.y, c.z));
    if (block === null) return this.fail(data, "NOT_READY", "shelter block is not loaded");
    if (passable(bareName(block.name))) return null;
    try {
      throwIfAborted(signal);
      await equipToolForBlock(bot, block, signal);
      await digBlock(bot, block, signal);
    } catch (err) {
      if (signal?.aborted === true) return this.interrupted(data);
      return this.fail(data, "NOT_READY", `could not dig the shelter: ${String(err)}`);
    }
    return null;
  }

  /** Wait until the bot has dropped onto the floor at `floorY + 0`'s cell (feet at `y`). */
  private async settleAt(y: number): Promise<void> {
    const deadline = Date.now() + FALL_SETTLE_MS;
    while (Date.now() < deadline) {
      const entity = this.opts.bot.entity;
      if (entity !== null && entity !== undefined && entity.onGround && Math.floor(entity.position.y + 0.01) <= y) return;
      await waitMs(100);
    }
  }

  private fillItem(): ReturnType<Bot["inventory"]["items"]>[number] | null {
    const items = this.opts.bot.inventory.items();
    for (const name of FILL_PREFERENCE) {
      const item = items.find((candidate) => bareName(candidate.name) === name);
      if (item !== undefined) return item;
    }
    return null;
  }

  private feet(): Cell {
    const p = this.opts.bot.entity.position;
    return { x: Math.floor(p.x), y: Math.floor(p.y + 0.01), z: Math.floor(p.z) };
  }

  private lookup(): CellLookup {
    const bot = this.opts.bot;
    return (x, y, z) => {
      const block = bot.blockAt(new Vec3(x, y, z));
      return block === null ? null : bareName(block.name);
    };
  }

  /** A hostile mob within reach of the shelter exit. */
  private hostileNearby(): boolean {
    const self = this.opts.bot.entity?.position;
    if (self === undefined || self === null) return false;
    return Object.values(this.opts.bot.entities).some((entity) => isMobEntity(entity) && HOSTILE_MOB_NAMES.has(entity.name ?? "")
      && entity.position !== undefined && entity.position.distanceTo(self) <= EXIT_THREAT_RADIUS);
  }

  private checkInterrupt(): void {
    if (this.stopRequested || this.signals === null) return;
    if (!this.signals.checkpoint({ interruptions: this.interruptions + 1 })) {
      this.stopRequested = true;
      this.interruptions += 1;
    }
  }

  private travelAbort = (): boolean => {
    this.checkInterrupt();
    return this.stopRequested;
  };

  private interrupted(data: NightShelterData): SkillResult<NightShelterData> {
    data.interruptions = this.interruptions;
    this.opts.logger.info("night shelter interrupted");
    return { ok: false, status: "interrupted", retryable: true, data, message: "interrupted" };
  }

  private fail(data: NightShelterData, errorCode: string, reason: string): SkillResult<NightShelterData> {
    this.opts.logger.warn({ errorCode, reason }, "night shelter failed");
    return { ok: false, status: "failed", errorCode, message: reason, retryable: true, data };
  }
}
