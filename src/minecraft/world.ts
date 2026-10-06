import type { Bot } from "mineflayer";
import { logger } from "../logger.js";
import type { Block } from "prismarine-block";
import type { Item } from "prismarine-item";
import { Vec3 } from "vec3";
import { withTimeout } from "../skills/skill-library.js";
import { requireWorldActionLease, throwIfAborted } from "../agent/world-actions.js";
import { cancelCollection, collectBlockOperation, digBlock, equipItem, equipToolForBlock, placeBlock } from "./primitives.js";
import { isDroppedItemEntity } from "../policy/combat.js";
import { travelAndWait } from "./movement.js";

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

/**
 * True when a block can be reached from real ground without scaffolding: some
 * cell within two blocks sideways, with feet at most three below the block,
 * has open feet and head room over a solid floor that is not leaves or a log
 * (standing in a canopy is how the pathfinder towered for acacia logs). With
 * a ~4.5 block reach that covers a trunk up to about head height + 2.
 */
export function isReachableFromGround(bot: Bot, position: Vec3): boolean {
  const open = (block: Block | null): boolean => block !== null && block.boundingBox === "empty" && !/water|lava/.test(block.name);
  const ground = (block: Block | null): boolean => isSolid(block) && !/_leaves$|_log$|_wood$/.test(block.name);
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      if (dx === 0 && dz === 0) continue;
      for (let dy = -3; dy <= 0; dy++) {
        const feet = position.offset(dx, dy, dz);
        if (open(bot.blockAt(feet)) && open(bot.blockAt(feet.offset(0, 1, 0))) && ground(bot.blockAt(feet.offset(0, -1, 0)))) return true;
      }
    }
  }
  return false;
}

/** Soil and stone a tree grows from: a log directly on one is a trunk base. */
const TREE_GROUND = /^(grass_block|dirt|coarse_dirt|podzol|rooted_dirt|mycelium|moss_block|mud|muddy_mangrove_roots|stone|deepslate|andesite|diorite|granite|sand|red_sand|gravel|clay|snow_block|terracotta|[a-z_]+_terracotta)$/;

/**
 * A trunk log within reach of someone standing on natural ground: soil or
 * stone at most three blocks below it (through air or more trunk), with an
 * open standing spot on that ground beside the column. Acacia canopies left
 * floating over cut stumps, and old scaffold pillars, fail it.
 */
export function isTrunkBase(bot: Bot, position: Vec3): boolean {
  let groundY: number | null = null;
  for (let depth = 1; depth <= 3; depth++) {
    const block = bot.blockAt(position.offset(0, -depth, 0));
    if (block === null) return false;
    const name = block.name.replace(/^minecraft:/, "");
    if (TREE_GROUND.test(name)) { groundY = position.y - depth; break; }
    if (block.boundingBox !== "empty" && !/_log$/.test(name)) return false;
  }
  if (groundY === null) return false;
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    const floor = bot.blockAt(new Vec3(position.x + dx, groundY, position.z + dz));
    const feet = bot.blockAt(new Vec3(position.x + dx, groundY + 1, position.z + dz));
    const head = bot.blockAt(new Vec3(position.x + dx, groundY + 2, position.z + dz));
    if (floor !== null && TREE_GROUND.test(floor.name.replace(/^minecraft:/, "")) && feet?.boundingBox === "empty" && head?.boundingBox === "empty") return true;
  }
  return false;
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

const NEIGHBOR_OFFSETS: readonly [number, number, number][] = [
  [0, 1, 0],
  [0, -1, 0],
  [1, 0, 0],
  [-1, 0, 0],
  [0, 0, 1],
  [0, 0, -1],
];

/** Registry state ids of `air`, `cave_air`, `void_air` (each has one state). */
const airStateIdCache = new WeakMap<Bot, Set<number> | null>();

function openAirStateIds(bot: Bot): Set<number> | null {
  if (airStateIdCache.has(bot)) return airStateIdCache.get(bot) ?? null;
  const ids = readOpenAirStateIds(bot);
  airStateIdCache.set(bot, ids);
  return ids;
}

function readOpenAirStateIds(bot: Bot): Set<number> | null {
  const byName = (bot as { registry?: { blocksByName?: Record<string, { minStateId?: number }> } }).registry?.blocksByName;
  if (byName === undefined) return null;
  const ids = ["air", "cave_air", "void_air"].map((name) => byName[name]?.minStateId).filter((id): id is number => typeof id === "number");
  return ids.length > 0 ? new Set(ids) : null;
}

/**
 * True when any orthogonal neighbor of `position` is open air (world-facing).
 * Cave air counts: ore exposed in a cave borders `cave_air`, and an `air`-only
 * check never saw any of it as reachable. Reads raw state ids (no Block
 * objects) because site scans call it on every matching block.
 */
export function hasAirNeighbor(bot: Bot, position: Vec3): boolean {
  const world = (bot as { world?: { getBlockStateId?: (p: Vec3) => number; getColumnAt?: (p: Vec3) => unknown } }).world;
  const air = world?.getBlockStateId !== undefined && world.getColumnAt !== undefined ? openAirStateIds(bot) : null;
  for (const [dx, dy, dz] of NEIGHBOR_OFFSETS) {
    const neighbor = position.offset(dx, dy, dz);
    if (air !== null && world !== undefined) {
      // An unloaded column reads as state 0 (air); it is unknown, not open.
      if (world.getColumnAt!(neighbor) && air.has(world.getBlockStateId!(neighbor))) return true;
    } else if (isPlaceableAir(bot.blockAt(neighbor))) {
      return true;
    }
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
/** `findBlocksNearPoint` with a position filter applied inside the scan, so `count` holds only matches that pass it. */
export function findBlocksNearPointRefined(
  bot: Bot,
  point: Vec3,
  predicate: (block: Block) => boolean,
  refine: (position: Vec3) => boolean,
  maxDistance: number,
  count: number,
): Vec3[] {
  return bot.findBlocks({
    point,
    matching: (block) => block !== null && predicate(block),
    useExtraInfo: (block: Block) => refine(block.position),
    maxDistance,
    count,
  });
}

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
/** The key `collectBlocks` records a failed target under (dimension + cell). */
export function collectTargetKey(bot: Bot, position: { x: number; y: number; z: number }): string {
  return `${String(bot.game?.dimension ?? "unknown").replace(/^minecraft:/, "")}:${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`;
}

/** Eye-to-block-centre distance a block may be dug from without moving. */
const DIRECT_DIG_REACH = 4.3;

function withinDirectReach(bot: Bot, position: Vec3): boolean {
  const eye = bot.entity?.position.offset(0, 1.62, 0);
  return eye !== undefined && eye.distanceTo(position.offset(0.5, 0.5, 0.5)) <= DIRECT_DIG_REACH;
}

/** Walk over the item drops a dig left near `position` (best effort, bounded). */
async function pickUpDropsNear(bot: Bot, position: Vec3, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 300));
  const drops = Object.values(bot.entities)
    .filter((entity) => isDroppedItemEntity(entity) && entity.position.distanceTo(position) <= 4)
    .slice(0, 4);
  for (const drop of drops) {
    throwIfAborted(signal);
    if (bot.entities[drop.id] === undefined) continue;
    await travelAndWait(bot, drop.position, { range: 1, timeoutMs: 4_000, signal });
  }
}

/** Beyond this distance a collect target is walked to before collectblock takes over. */
const APPROACH_FIRST_DISTANCE = 4;

/** Extra per-target collection budget for each block of distance to walk. */
const PER_BLOCK_TRAVEL_MS = 500;

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
    const targetKey = collectTargetKey(bot, block.position);
    if (failedTargets?.has(targetKey)) continue;
    // The budget covers the walk there: a flat 15 s timed out every trunk
    // beyond ~20 blocks once the trees near home were gone (15 in a row).
    const distance = bot.entity?.position.distanceTo(block.position) ?? 0;
    const targetBudgetMs = perTargetTimeoutMs + Math.round(distance * PER_BLOCK_TRAVEL_MS);
    // collectblock plans with GoalLookAtBlock (a clear sight line to a face).
    // In a forest the leaves and neighbouring trunks block that line, and the
    // search ran out on every log (~30k nodes) while a plain GoalNear found
    // the same trunks in under half a second. Walk up first; the look-and-dig
    // from two blocks away is then trivial.
    if (distance > APPROACH_FIRST_DISTANCE) {
      const approach = await travelAndWait(bot, block.position, { range: 2, timeoutMs: Math.max(1, Math.min(targetBudgetMs, remainingMs)), signal });
      throwIfAborted(signal);
      if (approach.status !== "arrived" && approach.status !== "already_there") {
        skipped++;
        failedTargets?.add(targetKey);
        logSkip?.(block, new Error(`could not approach: ${approach.status}`));
        continue;
      }
    }
    // Within reach, dig directly: the server checks reach, not sight lines,
    // and collectblock's look-at goal made the bot tower on dirt to see a log
    // from above, then dig out its own footing (two fall deaths).
    if (withinDirectReach(bot, block.position)) {
      try {
        try { await equipToolForBlock(bot, block, signal); } catch (err) { throwIfAborted(signal); }
        await digBlock(bot, block, signal);
        await pickUpDropsNear(bot, block.position, signal);
        continue;
      } catch (err) {
        throwIfAborted(signal);
        if (err instanceof Error && err.name === "AbortError") throw err;
        skipped++;
        failedTargets?.add(targetKey);
        logSkip?.(block, err);
        continue;
      }
    }
    try {
      await withTimeout(Math.max(1, Math.min(perTargetTimeoutMs, deadline - Date.now())), collectBlockOperation(bot, block, { ignoreNoPath: true }, signal), async () => {
        await cancelCollection(bot);
      }, signal);
    } catch (err) {
      // An aborted primitive must never advance to another target. The old
      // implementation treated cancellation like an unreachable block and
      // could keep acting after a replacement task acquired the lease.
      throwIfAborted(signal);
      // Cancellation of the surrounding work (not an unreachable block):
      // stop here instead of blacklisting every remaining target.
      if (err instanceof Error && err.name === "AbortError") throw err;
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
    if (!isSolid(below) || isInteractableBlock(below)) continue;
    if (!isPlaceableAir(bot.blockAt(position))) continue;
    return { position, reference: below, face: new Vec3(0, 1, 0) };
  }
  return null;
}

/**
 * Blocks that open a UI (or toggle) on right-click. Clicking one to place a
 * block against it interacts instead, so it can never be a placement
 * reference.
 */
export function isInteractableBlock(block: Block | null): boolean {
  if (block === null) return false;
  const name = block.name.replace(/^minecraft:/, "");
  return /(?:chest|barrel|shulker_box|furnace|smoker|crafting_table|_table|anvil|_bed|_door|trapdoor|fence_gate|button|lever|hopper|dropper|dispenser|brewing_stand|beacon|loom|stonecutter|grindstone|lectern|jukebox|note_block|composter|cauldron|bell|repeater|comparator|daylight_detector)$/.test(name)
    || name === "chest" || name === "ender_chest" || name === "trapped_chest";
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
  logger.warn({ item: item.name, at: spot.position, reference: spot.reference.name, err: placementError === null ? null : String(placementError), bot: bot.entity?.position }, "placement not observed");
  return null;
}

/** The log type that is most common around the bot (what "wood" means here). */
const CRAFTED_BLOCK = /_planks$|^cobblestone$|_fence$|_door$|_slab$|_stairs$|glass/;

export function touchesCraftedBlock(bot: { blockAt(position: Vec3): { name: string } | null }, position: Vec3): boolean {
  return [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
    .some(([dx, dy, dz]) => CRAFTED_BLOCK.test(bot.blockAt(position.offset(dx!, dy!, dz!))?.name ?? ""));
}


/** Whether the log column through `position` ends in leaves, as a tree's trunk does. */
function trunkHasLeaves(bot: Pick<Bot, "blockAt">, position: Vec3): boolean {
  let top = position;
  for (let i = 0; i < 32 && /_log$/.test(bot.blockAt(top.offset(0, 1, 0))?.name ?? ""); i++) top = top.offset(0, 1, 0);
  return [top.offset(0, 1, 0), top.offset(1, 0, 0), top.offset(-1, 0, 0), top.offset(0, 0, 1), top.offset(0, 0, -1)]
    .some((cell) => /_leaves$/.test(bot.blockAt(cell)?.name ?? ""));
}

/** Log species around the bot: standing trees, every log outside a building, and one sample position per tree species. */
export function nearbyLogCensus(bot: Pick<Bot, "findBlocks" | "blockAt" | "entity">): { trees: Record<string, number>; loose: Record<string, number>; samples: Record<string, { x: number; y: number; z: number }> } {
  const trees: Record<string, number> = {};
  const loose: Record<string, number> = {};
  const samples: Record<string, { x: number; y: number; z: number }> = {};
  try {
    const positions = bot.findBlocks({ matching: (block) => block !== null && /_log$/.test(block.name) && !block.name.startsWith("stripped_"), maxDistance: 64, count: 200 });
    for (const found of positions) {
      const position = new Vec3(found.x, found.y, found.z);
      const name = bot.blockAt(position)?.name;
      if (name === undefined || touchesCraftedBlock(bot, position)) continue;
      loose[name] = (loose[name] ?? 0) + 1;
      // A tree also carries leaves: a bare log pillar on the ground passed
      // as a trunk the collector would never cut (08:31).
      if (isTrunkBase(bot as Bot, position) && trunkHasLeaves(bot, position)) {
        trees[name] = (trees[name] ?? 0) + 1;
        samples[name] ??= { x: position.x, y: position.y, z: position.z };
      }
    }
  } catch { /* no world view yet */ }
  return { trees, loose, samples };
}

/**
 * The wood species to gather: the most common tree the collector would cut,
 * a trunk standing on the ground with leaves, outside any building. The
 * village's oak frames outnumbered the birch woods (2026-10-06 02:43, 05:05),
 * and later the floating upper halves of oaks cut at crop height over the
 * fields did (08:04, 08:20): each time the wood restore chose oak, found no
 * oak trunk to cut within 64 blocks and crossed the lake for some.
 */
export function dominantNearbyLog(bot: Pick<Bot, "findBlocks" | "blockAt" | "entity">): string {
  const { trees, loose } = nearbyLogCensus(bot);
  let best = "oak_log";
  let bestCount = 0;
  for (const [name, count] of Object.entries(Object.keys(trees).length > 0 ? trees : loose)) if (count > bestCount) { best = name; bestCount = count; }
  return best;
}

