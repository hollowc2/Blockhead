import type { Bot } from "mineflayer";
import type { Block } from "prismarine-block";
import { Vec3 } from "vec3";
import type { AgentState } from "../agent/state.js";
import type { Logger } from "pino";
import type { StorageLocation, StorageRepository } from "../memory/storage.js";
import { bareName, countItem } from "./inventory.js";
import { findBlocksNear } from "./world.js";
import { requireWorldActionLease, throwIfAborted } from "../agent/world-actions.js";
import { closeWindow, deposit, openContainer, withdraw } from "./primitives.js";
import { observedTransfer } from "../status/deltas.js";

/**
 * Deterministic container primitives (spec 22/23): locate home storage and
 * move items between the bot's inventory and the home chest. The stockpile
 * layer reads these to measure "stock = carried + stored" without the LLM
 * ever seeing slots; the skills layer uses `deliverCarried` to deposit.
 */

/** Scan radius for an already-placed chest near home. */
const CHEST_SCAN_RADIUS = 12;

/** True when a block is a chest the bot may read or deposit into. */
export function isChestBlock(block: Block): boolean {
  return block.name === "chest" || block.name === "trapped_chest";
}

/**
 * Locate a home chest: the registered general (delivery) chest first (spec
 * 23 — "locate designated delivery/general chest"), then any registered
 * storage, then a block scan around the bot. A chest the scan finds near
 * home is adopted into the registry (upsert), so a destroyed or mispointed
 * registration self-heals instead of leaving storage read as carried-only.
 * Returns null when none is reachable.
 */
export function findHomeChest(bot: Bot, state: AgentState, storage: StorageRepository): Block | null {
  const worldId = state.worldId;
  if (worldId !== null) {
    const byCategory = (category: string): Block | null => {
      for (const location of storage.listByCategory(worldId, category)) {
        const block = bot.blockAt(new Vec3(location.x, location.y, location.z));
        if (block !== null && isChestBlock(block)) return block;
      }
      return null;
    };
    const general = byCategory("general");
    if (general !== null) return general;
    for (const location of storage.list(worldId)) {
      const block = bot.blockAt(new Vec3(location.x, location.y, location.z));
      if (block !== null && isChestBlock(block)) return block;
    }
  }
  const positions = findBlocksNear(bot, isChestBlock, CHEST_SCAN_RADIUS, 1);
  const first = positions[0];
  if (first === undefined) return null;
  const block = bot.blockAt(first);
  if (block === null) return null;
  // Registry missed but a chest stands near home (e.g. blocks rolled back or
  // the rows were lost): adopt it so the stockpile measurement and later
  // lookups go through the registry. Idempotent per position; only home
  // chests are adopted, never a random chest found elsewhere.
  const home = state.home;
  if (worldId !== null && home !== null && Math.hypot(first.x - home.x, first.z - home.z) <= CHEST_SCAN_RADIUS) {
    storage.register(worldId, {
      dimension: home.dimension,
      category: "general",
      label: "home_main_chest",
      x: first.x,
      y: first.y,
      z: first.z,
    });
  }
  return block;
}

/**
 * Sum every carried instance of `itemName` across all reachable home chests.
 * One open per chest; a chest that fails to open (in use, despawned, ...) is
 * skipped, never fatal — the caller re-checks on the next maintenance pass.
 * Reads the container's own slots (`containerItems`), never the mirrored
 * player inventory the container window also carries.
 */
export async function countStoredItems(
  bot: Bot,
  state: AgentState,
  storage: StorageRepository,
  signal?: AbortSignal,
): Promise<Record<string, number>> {
  requireWorldActionLease(signal);
  const worldId = state.worldId;
  if (worldId === null) return {};
  const totals: Record<string, number> = {};
  for (const location of storage.list(worldId)) {
    throwIfAborted(signal);
    const block = bot.blockAt(new Vec3(location.x, location.y, location.z));
    if (block === null || !isChestBlock(block)) continue;
    try {
      const chest = await openContainer(bot, block, signal);
      try {
        for (const item of chest.containerItems()) {
          const name = bareName(item.name);
          totals[name] = (totals[name] ?? 0) + item.count;
        }
      } finally {
        await closeWindow(chest);
      }
    } catch (err) {
      // A busy chest must not break the whole stockpile pass.
      continue;
    }
  }
  return totals;
}

/** Deposit every carried instance of `itemName` into the home chest. */
export async function deliverCarried(
  bot: Bot,
  state: AgentState,
  storage: StorageRepository,
  itemName: string,
  logger: Logger,
  signal?: AbortSignal,
): Promise<{ delivered: number }> {
  requireWorldActionLease(signal);
  throwIfAborted(signal);
  const chest = findHomeChest(bot, state, storage);
  if (chest === null) {
    logger.warn("no chest at home to deposit into");
    return { delivered: 0 };
  }
  const before = countItem(bot, itemName);
  if (before === 0) return { delivered: 0 };

  const itemId = bot.registry.itemsByName[bareName(itemName)]?.id;
  if (itemId === undefined) {
    logger.warn({ item: itemName }, "no item id for deposit");
    return { delivered: 0 };
  }

  try {
    const container = await openContainer(bot, chest, signal);
    throwIfAborted(signal);
    try {
      await deposit(container, itemId, null, before, signal);
    } finally {
      await closeWindow(container);
    }
  } catch (err) {
    throwIfAborted(signal);
    logger.warn({ err: String(err), item: itemName }, "chest deposit failed");
    return { delivered: 0 };
  }
  return { delivered: Math.max(0, before - countItem(bot, itemName)) };
}

/**
 * Deposit every carried instance of each of `itemNames` (e.g. every meat
 * type of a food stockpile) in one container session. The chest is located
 * once for the whole call — a missing chest warns once and counts zero for
 * every item instead of repeating the same warning per item. A per-item
 * deposit failure (full chest, closed window) skips that item only.
 */
export async function deliverCarriedItems(
  bot: Bot,
  state: AgentState,
  storage: StorageRepository,
  itemNames: readonly string[],
  logger: Logger,
  signal?: AbortSignal,
): Promise<{ delivered: number }> {
  requireWorldActionLease(signal);
  throwIfAborted(signal);
  const chest = findHomeChest(bot, state, storage);
  if (chest === null) {
    logger.warn("no chest at home to deposit into");
    return { delivered: 0 };
  }
  let delivered = 0;
  try {
    const container = await openContainer(bot, chest, signal);
    throwIfAborted(signal);
    try {
      for (const name of itemNames) {
        throwIfAborted(signal);
        const before = countItem(bot, name);
        if (before === 0) continue;
        const itemId = bot.registry.itemsByName[bareName(name)]?.id;
        if (itemId === undefined) {
          logger.warn({ item: name }, "no item id for deposit");
          continue;
        }
        try {
          await deposit(container, itemId, null, before, signal);
          delivered += Math.max(0, before - countItem(bot, name));
        } catch (err) {
          throwIfAborted(signal);
          logger.warn({ err: String(err), item: name }, "chest deposit failed");
        }
      }
    } finally {
      await closeWindow(container);
    }
  } catch (err) {
    throwIfAborted(signal);
    logger.warn({ err: String(err) }, "chest deposit failed");
    return { delivered: 0 };
  }
  return { delivered };
}

/** Withdraw up to `count` of `itemName` from the home chest into the inventory. */
export async function withdrawFromHomeChest(
  bot: Bot,
  state: AgentState,
  storage: StorageRepository,
  itemName: string,
  count: number,
  logger: Logger,
  signal?: AbortSignal,
): Promise<{ withdrawn: number }> {
  requireWorldActionLease(signal);
  throwIfAborted(signal);
  const chest = findHomeChest(bot, state, storage);
  if (chest === null) {
    logger.warn("no chest at home to withdraw from");
    return { withdrawn: 0 };
  }
  const itemId = bot.registry.itemsByName[bareName(itemName)]?.id;
  if (itemId === undefined) {
    logger.warn({ item: itemName }, "no item id for withdraw");
    return { withdrawn: 0 };
  }
  const before = countItem(bot, itemName);
  try {
    const container = await openContainer(bot, chest, signal);
    throwIfAborted(signal);
    try {
      await withdraw(container, itemId, null, count, signal);
    } finally {
      await closeWindow(container);
    }
  } catch (err) {
    throwIfAborted(signal);
    logger.warn({ err: String(err), item: itemName }, "chest withdraw failed");
    return { withdrawn: 0 };
  }
  // Mineflayer inventory totals include items already carried. Report only
  // the transfer delta, otherwise an already-held stack is mistaken for a
  // successful chest withdrawal.
  return { withdrawn: Math.max(0, Math.min(count, countItem(bot, itemName) - before)) };
}

// --- Phase 11: storage measurement and organization primitives ---

/** One registered container's live measurement (spec 21.4 capacity tracking). */
export interface ChestMeasurement {
  location: StorageLocation;
  /** Live container slot capacity (27 for a chest, 54 once doubled). */
  capacitySlots: number;
  /** Occupied slots (one per held stack). */
  usedSlots: number;
  /** Item name -> amount currently inside the chest. */
  items: Record<string, number>;
}

/** A storage-wide measurement across every registered container. */
export interface StorageMeasurement {
  chests: ChestMeasurement[];
  /** Sum of every measured chest's slot capacity. */
  slotsTotal: number;
  /** Sum of occupied slots across every measured chest. */
  slotsUsed: number;
  /** Item name -> amount across every measured chest. */
  items: Record<string, number>;
  /**
   * Registered positions whose block is not a chest anymore (despawned,
   * destroyed, ...). A nonzero count with `reachable` false means every
   * registered storage is gone, which the organization decision treats as
   * "create a fresh chest".
   */
  missingChests: number;
  /**
   * True when at least one registered chest was opened. A false value means
   * every registered chest was busy or gone — the caller should re-check
   * later instead of acting on stale totals.
   */
  reachable: boolean;
}

/**
 * Open every registered home chest once and measure slot usage and contents.
 * Capacity comes live from the container window (`inventoryStart` is the
 * first player slot of the window, so all slots before it are the chest), so
 * doubled chests report 54 without hardcoding block sizes. Chests that fail
 * to open are skipped, never fatal.
 */
export async function measureStorage(
  bot: Bot,
  state: AgentState,
  storage: StorageRepository,
  signal?: AbortSignal,
): Promise<StorageMeasurement> {
  requireWorldActionLease(signal);
  const worldId = state.worldId;
  if (worldId === null) {
    return { chests: [], slotsTotal: 0, slotsUsed: 0, items: {}, missingChests: 0, reachable: false };
  }
  const chests: ChestMeasurement[] = [];
  let missingChests = 0;
  for (const location of storage.list(worldId)) {
    throwIfAborted(signal);
    const block = bot.blockAt(new Vec3(location.x, location.y, location.z));
    if (block === null || !isChestBlock(block)) {
      missingChests += 1;
      continue;
    }
    try {
      const chest = await openContainer(bot, block, signal);
      try {
        const items: Record<string, number> = {};
        let usedSlots = 0;
        for (let slot = 0; slot < chest.inventoryStart; slot++) {
          const item = chest.slots[slot];
          if (item === null || item === undefined) continue;
          usedSlots++;
          const name = bareName(item.name);
          items[name] = (items[name] ?? 0) + item.count;
        }
        chests.push({
          location,
          capacitySlots: chest.inventoryStart,
          usedSlots,
          items,
        });
      } finally {
        await closeWindow(chest);
      }
    } catch (err) {
      // A busy chest is skipped; `reachable` reports whether any was read.
      continue;
    }
  }
  const totals: StorageMeasurement = {
    chests,
    slotsTotal: 0,
    slotsUsed: 0,
    items: {},
    missingChests,
    reachable: chests.length > 0,
  };
  for (const chest of chests) {
    totals.slotsTotal += chest.capacitySlots;
    totals.slotsUsed += chest.usedSlots;
    for (const [name, count] of Object.entries(chest.items)) {
      totals.items[name] = (totals.items[name] ?? 0) + count;
    }
  }
  return totals;
}

/**
 * Move up to `count` of `itemName` from `from` into `to`, opening one
 * container at a time (the bot has a single container window). A deposit can
 * be partial when the target is short on room, so the source is re-read
 * after the transfer to report the amount actually moved. A failed open or
 * an unknown item id moves zero, never an error.
 */
export async function transferItem(
  bot: Bot,
  from: Block,
  to: Block,
  itemName: string,
  count: number,
  logger: Logger,
  signal?: AbortSignal,
): Promise<{ moved: number }> {
  requireWorldActionLease(signal);
  throwIfAborted(signal);
  const itemId = bot.registry.itemsByName[bareName(itemName)]?.id;
  if (itemId === undefined) {
    logger.warn({ item: itemName }, "no item id for transfer");
    return { moved: 0 };
  }
  let sourceBefore = 0;
  let sourceAfter = 0;
  let destinationBefore = 0;
  let destinationAfter = 0;
  try {
    const source = await openContainer(bot, from, signal);
    throwIfAborted(signal);
    try {
      sourceBefore = source.containerCount(itemId, null);
      await withdraw(source, itemId, null, count, signal);
      sourceAfter = source.containerCount(itemId, null);
    } finally {
      await closeWindow(source);
    }
  } catch (err) {
    throwIfAborted(signal);
    logger.warn({ err: String(err), item: itemName }, "transfer withdraw failed");
    return { moved: 0 };
  }
  try {
    const target = await openContainer(bot, to, signal);
    throwIfAborted(signal);
    try {
      destinationBefore = target.containerCount(itemId, null);
      await deposit(target, itemId, null, count, signal);
      destinationAfter = target.containerCount(itemId, null);
    } finally {
      await closeWindow(target);
    }
  } catch (err) {
    throwIfAborted(signal);
    logger.warn({ err: String(err), item: itemName }, "transfer deposit failed");
    return { moved: 0 };
  }
  // A transfer is successful only for the intersection of the source delta
  // and destination delta. This handles partial deposits and pre-existing
  // stacks without ever crediting a requested amount optimistically.
  const result = observedTransfer(sourceBefore, sourceAfter, destinationBefore, destinationAfter, count);
  return { moved: result.delta };
}
