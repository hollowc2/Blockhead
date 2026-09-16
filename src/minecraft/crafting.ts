import type { Bot } from "mineflayer";
import type { Block } from "prismarine-block";
import type { Recipe } from "prismarine-recipe";
import { bareName, countItem, countPlanks, countSticks, logsByType, planksForLog } from "./inventory.js";
import { throwIfAborted } from "../agent/world-actions.js";

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
  throwIfAborted(options.signal);
  const times = options.times ?? 1;
  const id = itemId(bot, name);
  if (id === null) return failure(name, `unknown item '${name}'`);

  const table = options.craftingTable;
  const recipes = bot.recipesAll(id, null, table !== undefined);
  const recipe = recipes.find((candidate) => recipeUsable(bot, candidate, times));
  if (!recipe) {
    return failure(name, recipes.length === 0 ? `no recipe for '${name}'` : `missing ingredients for '${name}'`);
  }

  try {
    const before = countItem(bot, name);
    await bot.craft(recipe, times, table);
    throwIfAborted(options.signal);
    const crafted = Math.max(0, countItem(bot, name) - before);
    return crafted > 0 ? { ok: true, name, crafted } : failure(name, "craft completed without an output delta");
  } catch (err) {
    return failure(name, String(err));
  }
}

/**
 * Craft planks (of the wood types held) until at least `targetTotal` planks
 * are carried. Each craft converts one log into four planks; recipes run per
 * owned log type so mixed inventories are handled.
 */
export async function craftPlanks(bot: Bot, targetTotal: number, signal?: AbortSignal): Promise<CraftResult> {
  throwIfAborted(signal);
  const initial = countPlanks(bot);
  let planks = initial;
  if (planks >= targetTotal) return { ok: true, name: "planks", crafted: 0 };

  for (const [logName, logCount] of Object.entries(logsByType(bot))) {
    if (planks >= targetTotal) break;
    const id = itemId(bot, planksForLog(logName));
    if (id === null) continue;
    const recipe = bot.recipesAll(id, null, false).find((candidate) => recipeUsable(bot, candidate, 1));
    if (!recipe) continue;

    const craftsNeeded = Math.ceil((targetTotal - planks) / 4);
    const times = Math.min(craftsNeeded, logCount);
    try {
      await bot.craft(recipe, times);
      throwIfAborted(signal);
    } catch (err) {
      return failure(planksForLog(logName), String(err));
    }
    planks = countPlanks(bot);
  }

  return planks >= targetTotal
    ? { ok: true, name: "planks", crafted: planks - initial }
    : failure("planks", `not enough logs to craft ${targetTotal} planks (${planks} held)`);
}

/**
 * Craft sticks (two planks make four sticks) until at least `targetTotal`
 * sticks are carried.
 */
export async function craftSticks(bot: Bot, targetTotal: number, signal?: AbortSignal): Promise<CraftResult> {
  throwIfAborted(signal);
  const initial = countSticks(bot);
  if (initial >= targetTotal) return { ok: true, name: "stick", crafted: 0 };

  const id = itemId(bot, "stick");
  if (id === null) return failure("stick", "unknown item 'stick'");
  const recipe = bot.recipesAll(id, null, false).find((candidate) => recipeUsable(bot, candidate, 1));
  if (!recipe) return failure("stick", "missing ingredients (two planks) for sticks");

  const times = Math.ceil((targetTotal - initial) / 4);
  try {
    await bot.craft(recipe, times);
    throwIfAborted(signal);
    return { ok: true, name: "stick", crafted: countSticks(bot) - initial };
  } catch (err) {
    return failure("stick", String(err));
  }
}
