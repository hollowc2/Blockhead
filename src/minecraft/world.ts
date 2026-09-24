import type { Bot } from "mineflayer";
import type { Block } from "prismarine-block";
import type { Item } from "prismarine-item";
import { Vec3 } from "vec3";
import { withTimeout } from "../skills/skill-library.js";
import { requireWorldActionLease, throwIfAborted } from "../agent/world-actions.js";
import { cancelCollection, collectBlockOperation, equipItem, placeBlock } from "./primitives.js";

/**
 * Deterministic world perception and block-placement primitives: find blocks
 * near the bot, classify natural materials, and locate a spot to place a
 * block. Skills combine these with pathfinding/collection primitives.
 */

/** Raw (non-stripped) log blocks: "oak_log", "spruce_log", ... */
export function isRawLog(block: Block): boolean {
  const name = block.name.replace(/^minecraft:/, "");
  return !name.startsWith("stripped_") && /^[a-z_]+_log$/.test(name);
}

/** Blocks a movement/placement primitive may stand on or lean against. */
export function isSolid(block: Block | null): block is Block {
  return block !== null && block.boundingBox === "block";
}

/** Air cells (also matches liquids' empty bounding boxes implicitly). */
export function isAir(block: Block | null): boolean {
  return block !== null && block.name === "air";
}

/**
 * Cells a block may be placed into. Open air in modern Minecraft comes in
 * three registry variants — `air`, `cave_air` (overworld caves) and
 * `void_air` — and all three accept placement. Placement scans that use only
 * `isAir` miss every cave cell, which strands building/station placement in
 * exactly the caves the bot is most likely to shelter in.
 */
export function isPlaceableAir(block: Block | null): boolean {
  if (block === null) return false;
  return block.name === "air" || block.name === "cave_air" || block.name === "void_air";
}

/** True when any orthogonal neighbor of `position` is air (world-facing). */
export function hasAirNeighbor(bot: Bot, position: Vec3): boolean {
  const offsets: [number, number, number][] = [
    [0, 1, 0],
    [0, -1, 0],
    [1, 0, 0],
    [-1, 0, 0],
    [0, 0, 1],
    [0, 0, -1],
  ];
  for (const [dx, dy, dz] of offsets) {
    if (isAir(bot.blockAt(position.offset(dx, dy, dz)))) return true;
  }
  return false;
}

/**
 * Positions of up to `count` blocks matching `predicate` within
 * `maxDistance` of an arbitrary point (not necessarily the bot), nearest
 * first. Search skills anchor their expanding radius at the run's start
 * position (spec 12.2), which may be far from where the bot later stands.
 */
export function findBlocksNearPoint(
  bot: Bot,
  point: Vec3,
  predicate: (block: Block) => boolean,
  maxDistance: number,
  count: number,
): Vec3[] {
  return bot.findBlocks({
    point,
    matching: (block) => block !== null && predicate(block),
    maxDistance,
    count,
  });
}

/**
 * Positions of up to `count` blocks matching `predicate` within
 * `maxDistance` of the bot, nearest first. Returns [] before spawn.
 */
export function findBlocksNear(
  bot: Bot,
  predicate: (block: Block) => boolean,
  maxDistance: number,
  count: number,
): Vec3[] {
  const self = bot.entity;
  if (!self) return [];
  return findBlocksNearPoint(bot, self.position, predicate, maxDistance, count);
}

/**
 * Find matching blocks while applying `refine` before Mineflayer consumes the
 * result count. This matters for common underground blocks: filtering a
 * capped result after `findBlocks` returns lets the nearest buried stone fill
 * the whole list and hide exposed cave/surface stone.
 */
export function findBlocksNearRefined(
  bot: Bot,
  predicate: (block: Block) => boolean,
  refine: (position: Vec3) => boolean,
  maxDistance: number,
  count: number,
): Vec3[] {
  const self = bot.entity;
  if (!self) return [];
  return bot.findBlocks({
    point: self.position,
    matching: (block) => block !== null && predicate(block),
    useExtraInfo: (block: Block) => refine(block.position),
    maxDistance,
    count,
  });
}

/** The nearest matching block (or null), or a specific named block. */
export function findBlockNear(bot: Bot, name: string, maxDistance: number): Block | null {
  const positions = findBlocksNear(bot, (block) => block.name === name, maxDistance, 1);
  const first = positions[0];
  return first !== undefined ? bot.blockAt(first) : null;
}

/**
 * Try to collect each block in `ordered` until `countHeld()` reaches
 * `targetTotal`, one block at a time. A block the pathfinder cannot reach
 * (a "Took to long to decide path to goal!" timeout or NoPath — e.g. ore on
 * an unreachable ledge, or buried in an unloaded pocket) is SKIPPED instead
 * of letting one bad target fail the whole pass: mineflayer-collectblock's
 * `ignoreNoPath` option does not actually skip (it is a no-op in
 * collectblock 1.6), so the skip happens here. `logSkip` reports each
 * skipped block for diagnostics; `announce` reports partial success when
 * some blocks were collected but others were not. `timeoutMs` is one total
 * pass budget, not a multiplier per candidate; each individual target also
 * has a 15-second cap. Returns how many new units `countHeld()` gained.
 * Callers own fallbacks (radius expansion).
 */
export async function collectBlocks(
  bot: Bot,
  ordered: Block[],
  countHeld: () => number,
  targetTotal: number,
  announce: (message: string) => void,
  timeoutMs: number,
  logSkip?: (block: Block, err: unknown) => void,
  signal?: AbortSignal,
  failedTargets?: Set<string>,
): Promise<number> {
  requireWorldActionLease(signal);
  const before = countHeld();
  let skipped = 0;
  const deadline = Date.now() + timeoutMs;
  const perTargetTimeoutMs = Math.min(15_000, timeoutMs);
  for (const block of ordered) {
    throwIfAborted(signal);
    if (countHeld() >= targetTotal) break;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    const targetKey = `${String(bot.game.dimension ?? "unknown").replace(/^minecraft:/, "")}:${block.position.x},${block.position.y},${block.position.z}`;
    if (failedTargets?.has(targetKey)) continue;
    try {
      await withTimeout(Math.max(1, Math.min(perTargetTimeoutMs, remainingMs)), collectBlockOperation(bot, block, { ignoreNoPath: true }, signal), async () => {
        await cancelCollection(bot);
      }, signal);
    } catch (err) {
      // An aborted primitive must never advance to another target. The old
      // implementation treated cancellation like an unreachable block and
      // could keep acting after a replacement task acquired the lease.
      throwIfAborted(signal);
      skipped++;
      failedTargets?.add(targetKey);
      logSkip?.(block, err);
      continue;
    }
  }
  const gained = countHeld() - before;
  if (gained > 0 && skipped > 0) {
    announce(`Collected blocks but ${skipped} were unreachable.`);
  }
  return gained;
}

/** A block-space position to place something near `center` (home). */
export interface PlacementSpot {
  /** The cell the new block will occupy. */
  position: Vec3;
  /** The solid block the new block leans against (below the new cell). */
  reference: Block;
  /** Direction from `reference` toward `position`, for `bot.placeBlock`. */
  face: Vec3;
}

/**
 * Find an air cell with a solid block directly beneath inside a small box
 * around `center`, preferring cells close to the center horizontally and low
 * vertically. The bot's own cell is excluded (a player blocks its own spot).
 * `exclude` skips cells the caller already tried (e.g. a failed placement).
 * Returns null when no such spot is found nearby.
 */
export function findPlacementSpot(
  bot: Bot,
  center: { x: number; y: number; z: number },
  maxRadius = 4,
  exclude: Vec3[] = [],
): PlacementSpot | null {
  const self = bot.entity;
  if (!self) return null;
  const baseY = Math.floor(center.y);
  const ownCell = self.position.floored();
  const candidates: Vec3[] = [];
  for (let radius = 0; radius <= maxRadius; radius++) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue;
        const cx = Math.floor(center.x) + dx;
        const cz = Math.floor(center.z) + dz;
        for (let dy = 0; dy <= 3; dy++) {
          candidates.push(new Vec3(cx, baseY + dy, cz));
        }
      }
    }
  }
  for (const position of candidates) {
    if (position.equals(ownCell)) continue;
    if (exclude.some((tried) => tried.equals(position))) continue;
    const lower = new Vec3(position.x, position.y - 1, position.z);
    const below = bot.blockAt(lower);
    if (!isSolid(below)) continue;
    if (!isPlaceableAir(bot.blockAt(position))) continue;
    return { position, reference: below, face: new Vec3(0, 1, 0) };
  }
  return null;
}

/**
 * Equip `item` and place it at `spot`. Returns the block the server ended up
 * with at that cell (the caller verifies the desired type), or null when the
 * item could not be equipped or the placement produced no block.
 */
export interface PlacementObservation {
  attempt: number;
  block: Block | null;
  inventoryCount: number;
}

export interface PlaceItemAtOptions {
  onPlaceAccepted?: () => void;
  onPoll?: (observation: PlacementObservation) => void;
  /**
   * Confirmation policy for a placement whose server acknowledgement may lag.
   * Defaults deliberately remain conservative for survival interactions.
   */
  maxPolls?: number;
  pollIntervalMs?: number;
}

export async function placeItemAt(bot: Bot, item: Item, spot: PlacementSpot, signal?: AbortSignal, options?: PlaceItemAtOptions): Promise<Block | null> {
  requireWorldActionLease(signal);
  throwIfAborted(signal);
  const inventoryBefore = bot.inventory.items().filter((carried) => carried.name === item.name).reduce((sum, carried) => sum + carried.count, 0);
  // A blueprint commonly places dozens of the same material in a row.  An
  // equip round-trip for each one adds a server tick without changing state.
  if (bot.heldItem?.name !== item.name) {
    try {
      await equipItem(bot, item, signal);
      throwIfAborted(signal);
    } catch (err) {
      throwIfAborted(signal);
      return null;
    }
  }
  let placementError: unknown = null;
  try {
    await placeBlock(bot, spot.reference, spot.face, signal, { x: spot.position.x, y: spot.position.y, z: spot.position.z }, item.name);
    options?.onPlaceAccepted?.();
    throwIfAborted(signal);
  } catch (err) {
    throwIfAborted(signal);
    // Mineflayer can reject after the server has accepted the interaction.
    // Continue polling the target so an eventual authoritative update is not
    // mistaken for a lost placement; callers can then retry only if it is
    // still not the expected block.
    placementError = err;
  }
  // placeBlock resolves when the placement packet is accepted; the block
  // cache can lag behind by several ticks. Poll briefly for the authoritative
  // block update before declaring a valid placement a failure.
  const maxPolls = options?.maxPolls ?? 6;
  const pollIntervalMs = options?.pollIntervalMs ?? 150;
  for (let attempt = 0; attempt < maxPolls; attempt++) {
    throwIfAborted(signal);
    const placed = bot.blockAt(spot.position);
    const inventoryAfter = bot.inventory.items().filter((carried) => carried.name === item.name).reduce((sum, carried) => sum + carried.count, 0);
    options?.onPoll?.({ attempt, block: placed, inventoryCount: inventoryAfter });
    if (placed !== null && placed.name !== "air") return placed;
    if (attempt < maxPolls - 1) await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
    // A delayed inventory packet is observable independently of the block
    // cache; keep polling rather than treating the accepted mutation as lost.
    void inventoryBefore;
    void inventoryAfter;
  }
  void placementError;
  return null;
}
