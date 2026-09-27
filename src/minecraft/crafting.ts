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

/** Server inventory packets can trail a successful crafting click briefly. */
const INVENTORY_SETTLE_TIMEOUT_MS = 2_000;
const INVENTORY_SETTLE_POLL_MS = 25;

async function settledCount(count: () => number, before: number, signal: AbortSignal): Promise<number> {
  const deadline = Date.now() + INVENTORY_SETTLE_TIMEOUT_MS;
  let current = count();
  while (current <= before && Date.now() < deadline) {
    throwIfAborted(signal);
    await new Promise<void>((resolve) => setTimeout(resolve, INVENTORY_SETTLE_POLL_MS));
    current = count();
  }
  throwIfAborted(signal);
  return current;
}

/** Shift-click anything sitting in the player's 2x2 crafting grid back into the inventory. */
async function clearCraftingGrid(bot: Bot): Promise<void> {
  const inventory = bot.inventory;
  if (inventory === undefined) return;
  for (const slot of [1, 2, 3, 4]) {
    if (inventory.slots[slot] === null || inventory.slots[slot] === undefined) continue;
    try { await bot.clickWindow(slot, 0, 1); } catch { /* best effort */ }
  }
}

/** Ask the server to resend every inventory slot (bounded wait). */
async function resyncInventory(bot: Bot): Promise<void> {
  const sync = (bot as Bot & { _syncWindow?: (window: unknown) => Promise<void> })._syncWindow;
  if (typeof sync !== "function" || bot.inventory === undefined) return;
  await Promise.race([
    sync.call(bot, bot.inventory).catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, 1_500)),
  ]);
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

  const table = options.craftingTable;
  const recipes = bot.recipesAll(id, null, table !== undefined);
  const recipe = recipes.find((candidate) => recipeUsable(bot, candidate, times));
  if (!recipe) {
    return failure(name, recipes.length === 0 ? `no recipe for '${name}'` : `missing ingredients for '${name}'`);
  }

  // One recipe run at a time, re-reading the authoritative inventory between
  // runs: on this server Mineflayer's multi-run craft (and a craft started
  // right after a chest withdrawal) can act on a stale inventory model and
  // throw "missing ingredient" even though the items are carried.
  const before = countItem(bot, name);
  let lastError: unknown = null;
  for (let run = 0; run < times; run += 1) {
    throwIfAborted(signal);
    // The local model lags the server, most of all right after a chest
    // withdrawal: ingredients that are really carried can read as missing.
    // Resync before concluding the run is impossible (13 logs once crafted
    // only 10 runs of planks this way).
    let usable = recipeUsable(bot, recipe, 1);
    for (let recheck = 0; !usable && recheck < 3; recheck += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 300));
      throwIfAborted(signal);
      await resyncInventory(bot);
      usable = recipeUsable(bot, recipe, 1);
    }
    if (!usable) break;
    let done = false;
    for (let attempt = 0; attempt < 4 && !done; attempt += 1) {
      try {
        // Make the local inventory model match the server before clicking;
        // a stale model is what produces the bogus "missing ingredient".
        await resyncInventory(bot);
        // A desynced earlier craft can leave items in the 2x2 grid, and the
        // next click then crafts something else from them (stray buttons).
        await clearCraftingGrid(bot);
        const runBefore = countItem(bot, name);
        await craftRecipe(bot, recipe, 1, table, signal);
        throwIfAborted(signal);
        await settledCount(() => countItem(bot, name), runBefore, signal);
        done = true;
      } catch (err) {
        throwIfAborted(signal);
        lastError = err;
        logger.warn({ item: name, run, attempt, err: String(err) }, "craft run failed; resyncing and retrying");
        await new Promise<void>((resolve) => setTimeout(resolve, 600));
      }
    }
    if (!done) break;
  }
  const after = countItem(bot, name);
  const crafted = Math.max(0, after - before);
  if (crafted > 0) return { ok: true, name, crafted };
  return failure(name, lastError === null ? "craft completed without an output delta" : String(lastError));
}

/**
 * Craft planks (of the wood types held) until at least `targetTotal` planks
 * are carried. Each craft converts one log into four planks; recipes run per
 * owned log type so mixed inventories are handled.
 */
export async function craftPlanks(bot: Bot, targetTotal: number, signal?: AbortSignal): Promise<CraftResult> {
  const lease = requireWorldActionLease(signal); signal ??= lease.signal;
  throwIfAborted(signal);
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
  const initial = countSticks(bot);
  if (initial >= targetTotal) return failure("stick", "craft request made no inventory change (target already satisfied)");

  const id = itemId(bot, "stick");
  if (id === null) return failure("stick", "unknown item 'stick'");
  const recipe = bot.recipesAll(id, null, false).find((candidate) => recipeUsable(bot, candidate, 1));
  if (!recipe) return failure("stick", "missing ingredients (two planks) for sticks");

  const times = Math.ceil((targetTotal - initial) / 4);
  try {
    throwIfAborted(signal);
    await craftRecipe(bot, recipe, times, undefined, signal);
    throwIfAborted(signal);
    const after = await settledCount(() => countSticks(bot), initial, signal);
    const delta = observedDelta(initial, after, Math.max(1, targetTotal - initial));
    return delta.delta > 0 ? { ok: true, name: "stick", crafted: delta.delta } : failure("stick", "craft completed without an output delta");
  } catch (err) {
    throwIfAborted(signal);
    return failure("stick", String(err));
  }
}
