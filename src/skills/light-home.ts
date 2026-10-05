import type { Bot } from "mineflayer";
import type { Block } from "prismarine-block";
import type { Logger } from "pino";
import { Vec3 } from "vec3";
import type { AgentState } from "../agent/state.js";
import type { TaskSignals } from "../agent/scheduler.js";
import type { StorageRepository } from "../memory/storage.js";
import { withdrawFromHomeChest } from "../minecraft/containers.js";
import { countItem, findItem } from "../minecraft/inventory.js";
import { skySurfaceY, travelAndWait, travelHomeAndWait } from "../minecraft/movement.js";
import { findBlocksNear, isPlaceableAir, placeItemAt, type PlacementSpot } from "../minecraft/world.js";
import type { EnsureTorchesRunner } from "./ensure-torches.js";
import type { SkillResult } from "./skill-library.js";

/**
 * Home lighting. CobbleBob's home sits in dark forest: with no torches,
 * zombies, skeletons, spiders and creepers spawned around it at frozen noon,
 * killed it eight times in eight minutes (2026-10-04 20:13-20:21) and blew up
 * the home chest. Hostiles spawn only at block light 0; a torch gives 14,
 * one less per block walked, so a floor torch every LIGHT_SPACING blocks
 * keeps the whole area above 0.
 */

/** How far around home the bot keeps lit. */
export const LIGHT_RADIUS = 24;
/** Grid pitch: the farthest ground from a torch is ~7 blocks (light ~7). */
export const LIGHT_SPACING = 7;
/** A torch this close (horizontally) already lights a grid point. */
export const TORCH_COVER = 4;
/** How far from a grid point the bot may shift the torch to find ground. */
const SPOT_SEARCH = 2;
/** Torches crafted per craft batch request beyond what the grid needs. */
const TORCH_SPARE = 4;
const TRAVEL_TIMEOUT_MS = 60_000;
const PLACE_REACH = 3;

/** Grid points within `radius` of home, nearest first (home itself first). */
export function lightGrid(home: { x: number; z: number }, radius = LIGHT_RADIUS, spacing = LIGHT_SPACING): { x: number; z: number }[] {
  const cx = Math.floor(home.x);
  const cz = Math.floor(home.z);
  const points: { x: number; z: number; d: number }[] = [];
  const steps = Math.floor(radius / spacing);
  for (let i = -steps; i <= steps; i++) {
    for (let j = -steps; j <= steps; j++) {
      const d = Math.hypot(i * spacing, j * spacing);
      if (d <= radius) points.push({ x: cx + i * spacing, z: cz + j * spacing, d });
    }
  }
  return points.sort((a, b) => a.d - b.d).map(({ x, z }) => ({ x, z }));
}

/** True when an existing torch lights the grid point. */
export function coveredByTorch(point: { x: number; z: number }, torches: readonly { x: number; z: number }[], cover = TORCH_COVER): boolean {
  return torches.some((torch) => Math.hypot(torch.x - point.x, torch.z - point.z) <= cover);
}

/** Ground a floor torch can stand on: a full block that is not foliage, liquid, crop soil or a container. */
export function torchGround(block: Block | null): boolean {
  if (block === null || block.boundingBox !== "block") return false;
  return !/leaves|water|lava|farmland|chest|barrel|glass|ice|slab|stairs|fence|wall|door|trapdoor|bed|torch|carpet|snow$|cactus|pumpkin|melon|_log$/.test(block.name);
}

function key(x: number, y: number, z: number): string {
  return `${x},${y},${z}`;
}

/**
 * Where to put the torch for one grid point: the open ground cell nearest
 * the point (searching a few blocks out), never inside a reserved cell
 * (an unfinished owner build) or on top of one.
 */
export function torchSpotNear(bot: Bot, point: { x: number; z: number }, reserved: ReadonlySet<string>): PlacementSpot | null {
  let best: { spot: PlacementSpot; d: number } | null = null;
  for (let dx = -SPOT_SEARCH; dx <= SPOT_SEARCH; dx++) {
    for (let dz = -SPOT_SEARCH; dz <= SPOT_SEARCH; dz++) {
      const x = point.x + dx;
      const z = point.z + dz;
      const y = skySurfaceY(bot, x, z);
      if (y === null) continue;
      if (reserved.has(key(x, y, z)) || reserved.has(key(x, y - 1, z))) continue;
      const cell = bot.blockAt(new Vec3(x, y, z));
      const ground = bot.blockAt(new Vec3(x, y - 1, z));
      if (!isPlaceableAir(cell) || !torchGround(ground)) continue;
      const d = Math.hypot(dx, dz);
      if (best === null || d < best.d) best = { spot: { position: new Vec3(x, y, z), reference: ground!, face: new Vec3(0, 1, 0) }, d };
    }
  }
  return best?.spot ?? null;
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

/** Places floor torches on a grid around home until every point is lit. */
export class LightHomeRunner {
  constructor(private readonly opts: LightHomeOptions) {}

  /** Positions of torches standing around home (loaded chunks only). */
  private torchesNear(): Vec3[] {
    const bot = this.opts.bot;
    return findBlocksNear(bot, (block) => block.name === "torch" || block.name === "wall_torch", LIGHT_RADIUS + 16, 512);
  }

  /**
   * Grid points around home with no torch nearby and a place to put one.
   * Empty when the bot is away from home (unloaded chunks read as unknown).
   */
  darkSpots(): PlacementSpot[] {
    const bot = this.opts.bot;
    const home = this.opts.state.home;
    const self = bot.entity?.position;
    if (home === null || self === undefined || self === null) return [];
    if (Math.hypot(self.x - home.x, self.z - home.z) > LIGHT_RADIUS) return [];
    const torches = this.torchesNear();
    const reserved = this.opts.reservedCells?.() ?? new Set<string>();
    const spots: PlacementSpot[] = [];
    for (const point of lightGrid(home)) {
      if (coveredByTorch(point, torches)) continue;
      const spot = torchSpotNear(bot, point, reserved);
      if (spot !== null) spots.push(spot);
    }
    return spots;
  }

  async run(options: { signals?: TaskSignals } = {}): Promise<SkillResult<LightHomeData>> {
    const bot = this.opts.bot;
    const signals = options.signals;
    const signal = signals?.signal;
    const home = this.opts.state.home;
    const data: LightHomeData = { needed: 0, placed: 0, failed: 0 };
    if (home === null) return { ok: false, status: "failed", errorCode: "NOT_READY", message: "no home to light", retryable: false, data };

    const travel = await travelHomeAndWait(bot, home, { dimension: home.dimension, timeoutMs: TRAVEL_TIMEOUT_MS * 2, signal, shouldAbort: () => signals?.checkpoint() === false });
    if (signals?.checkpoint() === false) return { ok: false, status: "interrupted", message: "interrupted", data };
    if (travel.status !== "arrived" && travel.status !== "already_there") {
      return { ok: false, status: "failed", errorCode: "PATH_UNREACHABLE", message: `could not reach home: ${travel.status}`, retryable: true, data };
    }

    let spots = this.darkSpots();
    data.needed = spots.length;
    if (spots.length === 0) return { ok: true, status: "completed", message: "Home is lit.", data };
    this.opts.logger.info({ dark: spots.length }, "lighting home: dark spots to torch");

    // Torches: carried, then the home chest, then crafted into the chest.
    const want = spots.length;
    if (countItem(bot, "torch") < want) {
      await withdrawFromHomeChest(bot, this.opts.state, this.opts.storage, "torch", want - countItem(bot, "torch"), this.opts.logger, signal).catch(() => ({ withdrawn: 0 }));
    }
    if (countItem(bot, "torch") < want) {
      const crafted = await this.opts.torches.run(want - countItem(bot, "torch") + TORCH_SPARE, signals === undefined ? {} : { signals });
      if (crafted.status === "interrupted") return { ok: false, status: "interrupted", message: "interrupted", data };
      await withdrawFromHomeChest(bot, this.opts.state, this.opts.storage, "torch", want - countItem(bot, "torch"), this.opts.logger, signal).catch(() => ({ withdrawn: 0 }));
    }
    if (countItem(bot, "torch") === 0) {
      return { ok: false, status: "failed", errorCode: "INSUFFICIENT_MATERIALS", message: "no torches to light home with", retryable: true, data };
    }

    // Light the spots nearest home first; re-check each one, since a torch
    // just placed may already cover the next.
    spots = this.darkSpots();
    for (const planned of spots) {
      if (signals?.checkpoint({ placed: data.placed }) === false) return { ok: false, status: "interrupted", message: "interrupted", data };
      if (countItem(bot, "torch") === 0) break;
      if (coveredByTorch(planned.position, this.torchesNear())) continue;
      const walked = await travelAndWait(bot, planned.position, { range: PLACE_REACH, timeoutMs: TRAVEL_TIMEOUT_MS, signal, shouldAbort: () => signals?.checkpoint() === false });
      if (signals?.checkpoint() === false) return { ok: false, status: "interrupted", message: "interrupted", data };
      if (walked.status !== "arrived" && walked.status !== "already_there") { data.failed += 1; continue; }
      const torch = findItem(bot, "torch");
      if (torch === null) break;
      const placed = await placeItemAt(bot, torch, planned, signal).catch(() => null);
      if (placed !== null && /torch/.test(placed.name)) data.placed += 1;
      else data.failed += 1;
    }

    const left = this.darkSpots().length;
    this.opts.logger.info({ placed: data.placed, failed: data.failed, stillDark: left }, "lighting home: pass finished");
    if (left === 0) return { ok: true, status: "completed", message: `Lit up home: placed ${data.placed} torches.`, data };
    if (data.placed > 0) return { ok: true, status: "partial", message: `Placed ${data.placed} torches; ${left} spots still dark.`, data };
    return { ok: false, status: "failed", errorCode: "NOT_READY", message: `could not light ${left} dark spots around home`, retryable: true, data };
  }
}
