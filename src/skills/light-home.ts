import type { Bot } from "mineflayer";
import type { Logger } from "pino";
import { Vec3 } from "vec3";
import type { AgentState } from "../agent/state.js";
import type { TaskSignals } from "../agent/scheduler.js";
import type { StorageRepository } from "../memory/storage.js";
import { withdrawFromHomeChest } from "../minecraft/containers.js";
import { countItem, findItem } from "../minecraft/inventory.js";
import { travelAndWait, travelHomeAndWait } from "../minecraft/movement.js";
import { findBlocksNearPoint, placeItemAt, type PlacementSpot } from "../minecraft/world.js";
import type { EnsureTorchesRunner } from "./ensure-torches.js";
import type { SkillResult } from "./skill-library.js";
import { baseLayoutFor } from "./base.js";

/**
 * Home lighting. CobbleBob's home sits in dark forest: with no torches,
 * zombies, skeletons, spiders and creepers spawned around it at frozen noon,
 * killed it eight times in eight minutes (2026-10-04 20:13-20:21) and blew up
 * the home chest. Hostiles spawn only at block light 0; a torch gives 14,
 * one less per block. A floor grid lit the open ground but left the cave
 * mouths and overhangs west of home dark (probed 23:05), so the plan works
 * from a light model of every cell a mob could spawn in.
 */

/** How far around home the bot keeps lit. */
export const LIGHT_RADIUS = 24;
/**
 * The layer around home's height that is kept lit: the ground, the shed,
 * and the cave mouths and overhangs a few blocks down the hillside, where
 * skeletons spawned in the dark at noon. Deep caves below stay unlit.
 */
const LIGHT_BELOW = 6;
const LIGHT_ABOVE = 8;
/** Light a torch gives off; it drops by one per block. */
const TORCH_LIGHT = 14;
/** Most torches one plan places before the area is re-read. */
const MAX_PLAN = 64;
/** Passes per run: each pass sees the chunks the last one walked into view. */
const MAX_PASSES = 4;
/** Torches crafted per craft batch request beyond what the plan needs. */
const TORCH_SPARE = 4;
const TRAVEL_TIMEOUT_MS = 60_000;
const PLACE_REACH = 3;
const PLAN_MEMO_MS = 60_000;

/** What the light model needs to know about a block. */
export interface BlockInfo { name: string; boundingBox: string }
/** A block lookup by coordinates; null where the chunk is not loaded. */
export type BlockView = (x: number, y: number, z: number) => BlockInfo | null;

const LIGHT_SOURCE = /^(torch|wall_torch|lantern|soul_lantern|glowstone|sea_lantern|jack_o_lantern|shroomlight|campfire|lava)$/;

/** A full cube that stops light (leaves, glass and other see-through blocks pass it). */
function opaque(block: BlockInfo): boolean {
  return block.boundingBox === "block" && !/leaves|glass|ice|slab|stairs|fence|wall|door|chest|farmland|dirt_path|water|lava|torch|lantern|glowstone|shroomlight|spawner|barrier/.test(block.name);
}

/** Ground a hostile mob can spawn on: a full block top that is not leaves, glass, slabs, farmland or a container. */
function spawnGround(block: BlockInfo | null): boolean {
  return block !== null && block.boundingBox === "block" && !/leaves|glass|ice|slab|stairs|farmland|dirt_path|chest|barrier|bedrock|furnace|crafting_table/.test(block.name);
}

/** Room for a mob: a two-high gap with no liquid. */
function spawnRoom(block: BlockInfo | null): boolean {
  return block !== null && block.boundingBox === "empty" && !/water|lava|torch|rail|lantern/.test(block.name);
}

/** Ground a floor torch can stand on: a full block that is not foliage, liquid, crop soil or a container. */
export function torchGround(block: Pick<BlockInfo, "name" | "boundingBox"> | null): boolean {
  if (block === null || block.boundingBox !== "block") return false;
  // Clicking an interactive block (a furnace, a table) opens it instead of
  // placing: the first live torch "landed" on the home furnace and the
  // server refused it (21:38).
  return !/leaves|water|lava|farmland|chest|barrel|glass|ice|slab|stairs|fence|wall|door|trapdoor|bed|torch|carpet|snow$|cactus|pumpkin|melon|_log$|furnace|smoker|crafting_table|table$|anvil|loom|stonecutter|grindstone|lectern|hopper|dispenser|dropper|beacon|note_block|jukebox|enchanting|brewing|cauldron|composter|shulker|button|lever|sign/.test(block.name);
}

function key(x: number, y: number, z: number): string {
  return `${x},${y},${z}`;
}

/**
 * Block light around home, worked out from where the light sources stand
 * the way the game does it: 14 at a torch, one less per block, stopped by
 * opaque blocks. The client's own light arrays are not used: read live,
 * open air under a clear sky came back as sky light 0 (2026-10-04).
 */
export class LightModel {
  private readonly light = new Map<string, number>();

  constructor(private readonly view: BlockView) {}

  /** Spread one source's light outward. */
  addSource(x: number, y: number, z: number, level = TORCH_LIGHT): void {
    const queue: [number, number, number, number][] = [[x, y, z, level]];
    for (let head = 0; head < queue.length; head++) {
      const [cx, cy, cz, l] = queue[head]!;
      const k = key(cx, cy, cz);
      if ((this.light.get(k) ?? 0) >= l) continue;
      this.light.set(k, l);
      if (l <= 1) continue;
      for (const [dx, dy, dz] of NEIGHBORS) {
        const nx = cx + dx; const ny = cy + dy; const nz = cz + dz;
        const block = this.view(nx, ny, nz);
        if (block === null || opaque(block)) continue;
        if ((this.light.get(key(nx, ny, nz)) ?? 0) < l - 1) queue.push([nx, ny, nz, l - 1]);
      }
    }
  }

  at(x: number, y: number, z: number): number {
    return this.light.get(key(x, y, z)) ?? 0;
  }
}

const NEIGHBORS: readonly [number, number, number][] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

/** A torch to place: the air cell it fills and the ground block under it. */
export interface TorchCell { x: number; y: number; z: number }

/**
 * Where torches must go so that no cell a mob could spawn in near home is
 * left at block light 0. Dark cells are taken nearest home first; each gets a
 * floor torch in it (or the nearest open cell beside it), and the light that
 * torch gives is added before the next dark cell is picked.
 */
export function planTorches(
  view: BlockView,
  home: { x: number; y: number; z: number },
  options: { radius?: number; reserved?: ReadonlySet<string>; skip?: ReadonlySet<string>; limit?: number; sources?: readonly TorchCell[] } = {},
): TorchCell[] {
  const radius = options.radius ?? LIGHT_RADIUS;
  const reserved = options.reserved ?? new Set<string>();
  const skip = options.skip ?? new Set<string>();
  const cx = Math.floor(home.x); const cy = Math.floor(home.y); const cz = Math.floor(home.z);
  const ylo = cy - LIGHT_BELOW; const yhi = cy + LIGHT_ABOVE;
  const model = new LightModel(view);
  if (options.sources !== undefined) {
    for (const source of options.sources) model.addSource(source.x, source.y, source.z);
  } else {
    const reach = radius + TORCH_LIGHT;
    for (let x = cx - reach; x <= cx + reach; x++) {
      for (let z = cz - reach; z <= cz + reach; z++) {
        for (let y = ylo - TORCH_LIGHT; y <= yhi + TORCH_LIGHT; y++) {
          const block = view(x, y, z);
          if (block !== null && LIGHT_SOURCE.test(block.name)) model.addSource(x, y, z);
        }
      }
    }
  }
  const dark: { x: number; y: number; z: number; d: number }[] = [];
  for (let x = cx - radius; x <= cx + radius; x++) {
    for (let z = cz - radius; z <= cz + radius; z++) {
      const d = Math.hypot(x - cx, z - cz);
      if (d > radius) continue;
      for (let y = ylo; y <= yhi; y++) {
        if (reserved.has(key(x, y, z))) continue;
        if (!spawnRoom(view(x, y, z)) || !spawnRoom(view(x, y + 1, z)) || !spawnGround(view(x, y - 1, z))) continue;
        if (model.at(x, y, z) === 0) dark.push({ x, y, z, d: d + Math.abs(y - cy) });
      }
    }
  }
  dark.sort((a, b) => a.d - b.d);
  const plan: TorchCell[] = [];
  const limit = options.limit ?? MAX_PLAN;
  for (const cell of dark) {
    if (plan.length >= limit) break;
    if (model.at(cell.x, cell.y, cell.z) > 0) continue;
    const torch = torchCellNear(view, cell, reserved, skip);
    if (torch === null) continue;
    plan.push(torch);
    model.addSource(torch.x, torch.y, torch.z);
  }
  return plan;
}

/** The open air cell on torch ground nearest `cell` (itself first), out of reserved and skipped cells. */
function torchCellNear(view: BlockView, cell: TorchCell, reserved: ReadonlySet<string>, skip: ReadonlySet<string>): TorchCell | null {
  let best: { at: TorchCell; d: number } | null = null;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dy = -1; dy <= 1; dy++) {
        const x = cell.x + dx; const y = cell.y + dy; const z = cell.z + dz;
        const k = key(x, y, z);
        if (reserved.has(k) || reserved.has(key(x, y - 1, z)) || skip.has(k)) continue;
        const air = view(x, y, z);
        if (air === null || !/^(air|cave_air)$/.test(air.name) || !torchGround(view(x, y - 1, z))) continue;
        const d = Math.abs(dx) + Math.abs(dy) + Math.abs(dz);
        if (best === null || d < best.d) best = { at: { x, y, z }, d };
      }
    }
  }
  return best?.at ?? null;
}

/**
 * A cached block lookup over the bot's loaded chunks. Reads state ids
 * straight from the world (a few hundred thousand lookups per plan; full
 * Block objects were too slow).
 */
export function botBlockView(bot: Bot): BlockView {
  const cache = new Map<string, BlockInfo | null>();
  const world = (bot as unknown as { world?: { getBlockStateId?: (p: Vec3) => number; getColumnAt?: (p: Vec3) => unknown } }).world;
  const byState = (bot as unknown as { registry?: { blocksByStateId?: Record<number, BlockInfo> } }).registry?.blocksByStateId;
  const loaded = new Map<string, boolean>();
  return (x, y, z) => {
    const k = key(x, y, z);
    const hit = cache.get(k);
    if (hit !== undefined) return hit;
    let info: BlockInfo | null = null;
    const pos = new Vec3(x, y, z);
    if (world?.getBlockStateId !== undefined && world.getColumnAt !== undefined && byState !== undefined) {
      const chunk = `${x >> 4},${z >> 4}`;
      let has = loaded.get(chunk);
      if (has === undefined) { has = world.getColumnAt(pos) != null; loaded.set(chunk, has); }
      if (has) {
        const def = byState[world.getBlockStateId(pos)];
        info = def === undefined ? null : { name: def.name, boundingBox: def.boundingBox };
      }
    } else {
      const block = bot.blockAt(pos);
      info = block === null ? null : { name: block.name, boundingBox: block.boundingBox };
    }
    cache.set(k, info);
    return info;
  };
}

function toSpot(bot: Bot, cell: TorchCell): PlacementSpot | null {
  const ground = bot.blockAt(new Vec3(cell.x, cell.y - 1, cell.z));
  if (ground === null) return null;
  return { position: new Vec3(cell.x, cell.y, cell.z), reference: ground, face: new Vec3(0, 1, 0) };
}

export interface LightHomeOptions {
  bot: Bot;
  state: AgentState;
  storage: StorageRepository;
  torches: EnsureTorchesRunner;
  logger: Logger;
  /** Cells an unfinished owner build will occupy; torches stay out of them. */
  reservedCells?: () => ReadonlySet<string>;
}

export interface LightHomeData {
  needed: number;
  placed: number;
  failed: number;
}

/** Places floor torches around home until no spawnable cell near it is dark. */
export class LightHomeRunner {
  /** Torch cells that could not be reached or placed this session; not planned again. */
  private readonly skipped = new Set<string>();
  /** The last plan from home, reused by the idle check for a minute (a plan takes ~0.5 s). */
  private memo: { at: number; spots: PlacementSpot[] } | null = null;

  constructor(private readonly opts: LightHomeOptions) {}

  /**
   * Torches still needed around home. Empty when the bot is away from home
   * (unloaded chunks read as unknown, not dark).
   */
  darkSpots(options: { fresh?: boolean } = {}): PlacementSpot[] {
    if (options.fresh !== true && this.memo !== null && Date.now() - this.memo.at < PLAN_MEMO_MS) return this.memo.spots;
    const spots = this.planSpots();
    this.memo = { at: Date.now(), spots };
    return spots;
  }

  private planSpots(): PlacementSpot[] {
    const bot = this.opts.bot;
    const home = this.opts.state.home;
    const self = bot.entity?.position;
    if (home === null || self === undefined || self === null) return [];
    if (Math.hypot(self.x - home.x, self.z - home.z) > LIGHT_RADIUS) return [];
    // The base's door gap and wall cells are the builder's: a torch lit the
    // empty doorway at 14:2x on 2026-10-05 before the door could be hung.
    const reserved = new Set<string>(this.opts.reservedCells?.() ?? []);
    const layout = baseLayoutFor(home);
    for (const cell of [...layout.doorCells, ...layout.wallCells, ...layout.roofCells]) reserved.add(key(cell.x, cell.y, cell.z));
    // Sources from the palette scan: far cheaper than reading every cell.
    const sources = findBlocksNearPoint(bot, new Vec3(home.x, home.y, home.z), (block) => LIGHT_SOURCE.test(block.name), LIGHT_RADIUS + TORCH_LIGHT + LIGHT_ABOVE, 2048);
    const plan = planTorches(botBlockView(bot), home, { reserved, skip: this.skipped, sources });
    return plan.map((cell) => toSpot(bot, cell)).filter((spot): spot is PlacementSpot => spot !== null);
  }

  async run(options: { signals?: TaskSignals } = {}): Promise<SkillResult<LightHomeData>> {
    const bot = this.opts.bot;
    const signals = options.signals;
    const signal = signals?.signal;
    const home = this.opts.state.home;
    const data: LightHomeData = { needed: 0, placed: 0, failed: 0 };
    if (home === null) return { ok: false, status: "failed", errorCode: "NOT_READY", message: "no home to light", retryable: false, data };
    const interrupted = (): SkillResult<LightHomeData> => ({ ok: false, status: "interrupted", message: "interrupted", data });

    const travel = await travelHomeAndWait(bot, home, { dimension: home.dimension, timeoutMs: TRAVEL_TIMEOUT_MS * 2, signal, shouldAbort: () => signals?.checkpoint() === false });
    if (signals?.checkpoint() === false) return interrupted();
    if (travel.status !== "arrived" && travel.status !== "already_there") {
      return { ok: false, status: "failed", errorCode: "PATH_UNREACHABLE", message: `could not reach home: ${travel.status}`, retryable: true, data };
    }

    let left = 0;
    // Walking out to the edge loads chunks the first plan could not see, so
    // a pass that placed torches is followed by another from home.
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      if (pass > 0) {
        await travelHomeAndWait(bot, home, { dimension: home.dimension, timeoutMs: TRAVEL_TIMEOUT_MS, signal, shouldAbort: () => signals?.checkpoint() === false });
        if (signals?.checkpoint() === false) return interrupted();
      }
      const spots = this.darkSpots({ fresh: true });
      left = spots.length;
      if (pass === 0) data.needed = spots.length;
      if (spots.length === 0) break;
      this.opts.logger.info({ dark: spots.length, pass }, "lighting home: dark spots to torch");
      const torches = await this.stockTorches(spots.length, signals);
      if (torches === "interrupted") return interrupted();
      if (torches === 0) {
        if (data.placed > 0) break;
        return { ok: false, status: "failed", errorCode: "INSUFFICIENT_MATERIALS", message: "no torches to light home with", retryable: true, data };
      }
      const placedBefore = data.placed;
      for (const spot of spots) {
        if (signals?.checkpoint({ placed: data.placed }) === false) return interrupted();
        if (countItem(bot, "torch") === 0) break;
        const at = spot.position;
        const walked = await travelAndWait(bot, at, { range: PLACE_REACH, timeoutMs: TRAVEL_TIMEOUT_MS, signal, shouldAbort: () => signals?.checkpoint() === false });
        if (signals?.checkpoint() === false) return interrupted();
        const torch = findItem(bot, "torch");
        if (torch === null) break;
        const placed = walked.status === "arrived" || walked.status === "already_there"
          ? await placeItemAt(bot, torch, toSpot(bot, at) ?? spot, signal).catch(() => null)
          : null;
        if (placed !== null && /torch/.test(placed.name)) {
          data.placed += 1;
        } else {
          data.failed += 1;
          this.skipped.add(key(at.x, at.y, at.z));
        }
      }
      if (data.placed === placedBefore) break;
    }

    if (data.placed === 0 && left > 0) {
      return { ok: false, status: "failed", errorCode: "NOT_READY", message: `could not light ${left} dark spots around home`, retryable: true, data };
    }
    left = this.darkSpots({ fresh: true }).length;
    this.opts.logger.info({ placed: data.placed, failed: data.failed, stillDark: left }, "lighting home: pass finished");
    // Placing torches is progress even when some remain (a skipped spot, or
    // torches ran out): the next background check starts another run.
    if (left === 0) return { ok: true, status: "completed", message: data.placed > 0 ? `Lit up home: placed ${data.placed} torches.` : "Home is lit.", data };
    return { ok: true, status: "completed", message: `Placed ${data.placed} torches; ${left} spots still dark.`, data };
  }

  /** Torches on hand for `want` spots: carried, then the home chest, then crafted into the chest. */
  private async stockTorches(want: number, signals: TaskSignals | undefined): Promise<number | "interrupted"> {
    const bot = this.opts.bot;
    const signal = signals?.signal;
    if (countItem(bot, "torch") < want) {
      await withdrawFromHomeChest(bot, this.opts.state, this.opts.storage, "torch", want - countItem(bot, "torch"), this.opts.logger, signal).catch(() => ({ withdrawn: 0 }));
    }
    if (countItem(bot, "torch") < want) {
      const crafted = await this.opts.torches.run(want - countItem(bot, "torch") + TORCH_SPARE, signals === undefined ? {} : { signals });
      if (crafted.status === "interrupted") return "interrupted";
      await withdrawFromHomeChest(bot, this.opts.state, this.opts.storage, "torch", want - countItem(bot, "torch"), this.opts.logger, signal).catch(() => ({ withdrawn: 0 }));
    }
    return countItem(bot, "torch");
  }
}
