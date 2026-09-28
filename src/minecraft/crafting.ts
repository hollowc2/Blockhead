import type { Bot } from "mineflayer";
import { logger } from "../logger.js";
import type { Block } from "prismarine-block";
import type { Recipe } from "prismarine-recipe";
import { bareName, countItem, countPlanks, countSticks, logsByType, planksForLog } from "./inventory.js";
import { requireWorldActionLease, throwIfAborted } from "../agent/world-actions.js";
import { craftRecipe } from "./primitives.js";
import { observedDelta } from "../status/deltas.js";

/**
 * Deterministic crafting primitives. Recipes come from minecraft-data through
 * mineflayer (`bot.recipesAll`); slot mechanics, window clicks, and crafting
 * table activation stay inside mineflayer. The skill layer only supplies
 * "what to craft and how often" plus the table block when a recipe needs one.
 */

export type CraftResult =
  | { ok: true; name: string; crafted: number }
  | { ok: false; name: string; reason: string };

export interface CraftOptions {
  /** How many times to perform the recipe (each run yields `result.count`). */
  times?: number;
  /** The placed crafting table block; required by table recipes. */
  craftingTable?: Block;
  signal?: AbortSignal;
}

/**
 * The local mineflayer inventory is a prediction. Crafting clicks update it
 * optimistically, and the server's corrections (set_slot / window_items) land
 * later. A 1.21.4 server answers a `_syncWindow` resync with a full-state
 * window_items and often a second, delayed one captured before the next click
 * is processed. When that stale snapshot lands mid-craft it rolls the model's
 * cursor and grid back, mineflayer's click sequence continues on the wrong
 * state, and the ingredient stack stays on the server cursor or in the 2x2 grid
 * while the result is never picked up. So only a settled model is trusted:
 * resync, then wait until the inventory packet stream has gone quiet.
 */
const INVENTORY_QUIET_MS = 250;
const INVENTORY_SETTLE_TIMEOUT_MS = 3_000;
const INVENTORY_SETTLE_POLL_MS = 25;
/** Recipe runs retried after a run produced no settled output. */
const CRAFT_RUN_ATTEMPTS = 3;
/** Upper bound for one best-effort cleanup click; mineflayer's own wait has none. */
const CLEANUP_CLICK_TIMEOUT_MS = 1_000;
const INVENTORY_PACKETS = ["set_slot", "window_items", "set_cursor_item", "set_player_inventory"] as const;

type SyncableBot = Bot & {
  _client?: { on(event: string, listener: () => void): unknown; removeListener(event: string, listener: () => void): unknown };
  _syncWindow?: (window: unknown) => Promise<void>;
};

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Resync the player inventory with the server and wait until no inventory
 * packet has arrived for `INVENTORY_QUIET_MS` (bounded). Returns false when the
 * resync was not answered in time. A bot without the resync hook (tests, old
 * protocol versions) has nothing to wait for.
 */
async function settleInventory(bot: Bot, signal?: AbortSignal): Promise<boolean> {
  const syncable = bot as SyncableBot;
  const client = syncable._client;
  const sync = syncable._syncWindow;
  if (client === undefined || typeof sync !== "function" || bot.inventory === undefined) return true;
  // A crafting table window still open belongs to an unfinished craft; its
  // close carries the inventory sync.
  if (bot.currentWindow !== null && bot.currentWindow !== undefined) return false;

  let lastPacketAt = Date.now();
  let synced = false;
  const onPacket = (): void => { lastPacketAt = Date.now(); };
  for (const name of INVENTORY_PACKETS) client.on(name, onPacket);
  try {
    void sync.call(bot, bot.inventory).then(() => { synced = true; lastPacketAt = Date.now(); }, () => undefined);
    const deadline = Date.now() + INVENTORY_SETTLE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      throwIfAborted(signal);
      if (synced && Date.now() - lastPacketAt >= INVENTORY_QUIET_MS) return true;
      await sleep(INVENTORY_SETTLE_POLL_MS);
    }
    throwIfAborted(signal);
    return false;
  } finally {
    for (const name of INVENTORY_PACKETS) client.removeListener(name, onPacket);
  }
}

async function boundedClick(click: Promise<unknown>): Promise<void> {
  await Promise.race([click.catch(() => undefined), sleep(CLEANUP_CLICK_TIMEOUT_MS)]);
}

/**
 * Return anything a desynced craft stranded on the cursor or in the 2x2
 * crafting grid to the inventory. The server never clears the player's own
 * grid by itself, and a craft that starts with a loaded cursor or grid crafts
 * the wrong thing. Returns true when it clicked anything.
 */
async function clearCraftingLeftovers(bot: Bot): Promise<boolean> {
  const inventory = bot.inventory;
  if (inventory === undefined) return false;
  let clicked = false;
  const held = inventory.selectedItem;
  if (held !== null && held !== undefined) {
    const room = inventory.findItemRange(inventory.inventoryStart, inventory.inventoryEnd, held.type, held.metadata, true, held.nbt) !== null ||
      inventory.firstEmptySlotRange(inventory.inventoryStart, inventory.inventoryEnd) !== null;
    // With no room mineflayer would toss the stack; leave it on the cursor.
    if (room) {
      await boundedClick(bot.putSelectedItemRange(inventory.inventoryStart, inventory.inventoryEnd, inventory, null));
      clicked = true;
    }
  }
  for (const slot of [1, 2, 3, 4]) {
    if (inventory.slots[slot] === null || inventory.slots[slot] === undefined) continue;
    await boundedClick(bot.clickWindow(slot, 0, 1));
    clicked = true;
  }
  return clicked;
}

/**
 * Bring the local inventory model in line with the server and put back
 * anything left on the cursor or in the crafting grid. Every crafting count
 * (ingredients before a run, output after it) is read after this.
 */
export async function syncInventory(bot: Bot, signal?: AbortSignal): Promise<void> {
  const lease = requireWorldActionLease(signal); signal ??= lease.signal;
  await settleInventory(bot, signal);
  if (await clearCraftingLeftovers(bot)) await settleInventory(bot, signal);
}

export function failure(name: string, reason: string): CraftResult {
  return { ok: false, name, reason };
}

/** Numeric minecraft-data id for an item name, or null when unknown. */
export function itemId(bot: Bot, name: string): number | null {
  return bot.registry.itemsByName[bareName(name)]?.id ?? null;
}

/**
 * True when `recipe` can be performed `times` times with the current
 * inventory. `recipe.delta` lists net count changes: consumed ingredients are
 * negative, so this mirrors the mineflayer requirements test.
 */
export function recipeUsable(bot: Bot, recipe: Recipe, times: number): boolean {
  for (const delta of recipe.delta) {
    if (delta.count < 0 && bot.inventory.count(delta.id, delta.metadata) + delta.count * times < 0) {
      return false;
    }
  }
  return true;
}

/**
 * Craft `name` `times` times. `craftingTable` must be the placed block for
 * table recipes (mineflayer activates it to open the crafting window).
 */
export async function craftItem(bot: Bot, name: string, options: CraftOptions = {}): Promise<CraftResult> {
  const lease = requireWorldActionLease(options.signal);
  const signal = options.signal ?? lease.signal;
  throwIfAborted(signal);
  const times = options.times ?? 1;
  const id = itemId(bot, name);
  if (id === null) return failure(name, `unknown item '${name}'`);

  // Recipe choice and every count below read a settled model: an unsettled
  // one can hide carried ingredients (bogus "missing ingredient") or show
  // output the server never produced.
  await syncInventory(bot, signal);
  const table = options.craftingTable;
  const recipes = bot.recipesAll(id, null, table !== undefined);
  const recipe = recipes.find((candidate) => recipeUsable(bot, candidate, times));
  if (!recipe) {
    return failure(name, recipes.length === 0 ? `no recipe for '${name}'` : `missing ingredients for '${name}'`);
  }

  // One recipe run at a time, each checked against the settled inventory:
  // mineflayer's multi-run craft keeps clicking on its own predictions.
  const before = countItem(bot, name);
  let lastError: string | null = null;
  for (let run = 0; run < times; run += 1) {
    let done = false;
    for (let attempt = 0; attempt < CRAFT_RUN_ATTEMPTS && !done; attempt += 1) {
      throwIfAborted(signal);
      if (!recipeUsable(bot, recipe, 1)) break;
      const runBefore = countItem(bot, name);
      let runError: string | null = null;
      try {
        await craftRecipe(bot, recipe, 1, table, signal);
      } catch (err) {
        throwIfAborted(signal);
        runError = String(err);
      }
      throwIfAborted(signal);
      await syncInventory(bot, signal);
      done = countItem(bot, name) > runBefore;
      if (!done) {
        lastError = runError ?? "craft completed without an output delta";
        logger.warn({ item: name, run, attempt, err: lastError }, "craft run produced no settled output; retrying");
      }
    }
    if (!done) break;
  }
  const crafted = Math.max(0, countItem(bot, name) - before);
  if (crafted > 0) return { ok: true, name, crafted };
  return failure(name, lastError ?? `missing ingredients for '${name}'`);
}

/**
 * Craft planks (of the wood types held) until at least `targetTotal` planks
 * are carried. Each craft converts one log into four planks; recipes run per
 * owned log type so mixed inventories are handled.
 */
export async function craftPlanks(bot: Bot, targetTotal: number, signal?: AbortSignal): Promise<CraftResult> {
  const lease = requireWorldActionLease(signal); signal ??= lease.signal;
  throwIfAborted(signal);
  await syncInventory(bot, signal);
  const initial = countPlanks(bot);
  let planks = initial;
  if (planks >= targetTotal) return failure("planks", "craft request made no inventory change (target already satisfied)");

  for (const [logName, logCount] of Object.entries(logsByType(bot))) {
    if (planks >= targetTotal) break;
    const id = itemId(bot, planksForLog(logName));
    if (id === null) continue;
    const recipe = bot.recipesAll(id, null, false).find((candidate) => recipeUsable(bot, candidate, 1));
    if (!recipe) continue;

    const craftsNeeded = Math.ceil((targetTotal - planks) / 4);
    const times = Math.min(craftsNeeded, logCount);
    const crafted = await craftItem(bot, planksForLog(logName), { times, signal });
    if (!crafted.ok && countPlanks(bot) <= planks) return failure(planksForLog(logName), crafted.reason);
    planks = countPlanks(bot);
  }

  const delta = observedDelta(initial, planks, Math.max(1, targetTotal - initial));
  return planks >= targetTotal && delta.delta > 0
    ? { ok: true, name: "planks", crafted: delta.delta }
    : failure("planks", `not enough logs to craft ${targetTotal} planks (${planks} held)`);
}

/**
 * Craft sticks (two planks make four sticks) until at least `targetTotal`
 * sticks are carried.
 */
export async function craftSticks(bot: Bot, targetTotal: number, signal?: AbortSignal): Promise<CraftResult> {
  const lease = requireWorldActionLease(signal); signal ??= lease.signal;
  throwIfAborted(signal);
  await syncInventory(bot, signal);
  const initial = countSticks(bot);
  if (initial >= targetTotal) return failure("stick", "craft request made no inventory change (target already satisfied)");

  const id = itemId(bot, "stick");
  if (id === null) return failure("stick", "unknown item 'stick'");
  const recipe = bot.recipesAll(id, null, false).find((candidate) => recipeUsable(bot, candidate, 1));
  if (!recipe) return failure("stick", "missing ingredients (two planks) for sticks");

  const crafted = await craftItem(bot, "stick", { times: Math.ceil((targetTotal - initial) / 4), signal });
  const delta = observedDelta(initial, countSticks(bot), Math.max(1, targetTotal - initial));
  return delta.delta > 0 ? { ok: true, name: "stick", crafted: delta.delta } : failure("stick", crafted.ok ? "craft completed without an output delta" : crafted.reason);
}
