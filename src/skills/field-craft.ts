import { travelAndWait } from "../minecraft/movement.js";
import { throwIfAborted } from "../agent/world-actions.js";
import type { Bot } from "mineflayer";
import type { Logger } from "pino";
import { craftItem, craftPlanks, craftSticks, syncInventory } from "../minecraft/crafting.js";
import { countItem, countLogs, countPlanks, countSticks, findItem } from "../minecraft/inventory.js";
import { collectBlocks, diggingStanceBlocker, groundDigApproaches, isTrunkBase, findBlockNear, findPlacementSpot, placeItemAt } from "../minecraft/world.js";

const TABLE_PLANK_COST = 4;
/** A table this close is used where it stands. */
const TABLE_REACH = 4;
/** Stone the bot can make a stone pickaxe head from. */
const STONE_HEADS = ["cobblestone", "cobbled_deepslate", "blackstone"] as const;

export interface FieldCarried {
  stone: number;
  planks: number;
  logs: number;
  sticks: number;
  table: boolean;
}

export interface FieldPickaxePlan {
  tool: "stone_pickaxe" | "wooden_pickaxe";
  /** Planks to hold before crafting (table + sticks + a wooden head). */
  planks: number;
}

/**
 * What pickaxe the carried materials make away from home, or null. A stone
 * pickaxe needs 3 stone, 2 sticks and a table; sticks cost 2 planks, a table
 * 4, and every log is 4 planks.
 */
export function fieldPickaxePlan(carried: FieldCarried): FieldPickaxePlan | null {
  const tool = carried.stone >= 3 ? "stone_pickaxe" : "wooden_pickaxe";
  const planks = (carried.table ? 0 : TABLE_PLANK_COST) + (carried.sticks >= 2 ? 0 : 2) + (tool === "wooden_pickaxe" ? 3 : 0);
  return carried.planks + carried.logs * 4 >= planks ? { tool, planks } : null;
}

/**
 * Make a pickaxe where the bot stands from what it carries: set down a table
 * (carried, or crafted from planks) and craft a stone pickaxe, wooden when
 * there is no stone. The 2026-10-04 coal run broke its pickaxe 60 blocks
 * down, then hand-dug every stair cell home at 7.5 s each while carrying 86
 * cobblestone, 5 sticks and 4 planks. Returns the tool made, or null.
 */
export async function craftPickaxeInField(bot: Bot, logger: Logger, signal?: AbortSignal): Promise<string | null> {
  await syncInventory(bot, signal);
  const nearTable = findBlockNear(bot, "crafting_table", TABLE_REACH);
  const stone = STONE_HEADS.find((name) => countItem(bot, name) >= 3);
  const plan = fieldPickaxePlan({
    stone: stone === undefined ? 0 : countItem(bot, stone),
    planks: countPlanks(bot),
    logs: countLogs(bot),
    sticks: countSticks(bot),
    table: nearTable !== null || findItem(bot, "crafting_table") !== null,
  });
  if (plan === null) {
    logger.warn("field craft: not enough wood for a pickaxe");
    return null;
  }
  if (countPlanks(bot) < plan.planks) {
    const planks = await craftPlanks(bot, plan.planks, signal);
    if (!planks.ok) return fail(logger, planks.reason);
  }
  if (countSticks(bot) < 2) {
    const sticks = await craftSticks(bot, 2, signal);
    if (!sticks.ok) return fail(logger, sticks.reason);
  }
  let table = nearTable;
  if (table === null) {
    if (findItem(bot, "crafting_table") === null) {
      const crafted = await craftItem(bot, "crafting_table", { signal });
      if (!crafted.ok) return fail(logger, crafted.reason);
    }
    const item = findItem(bot, "crafting_table");
    const self = bot.entity?.position;
    const spot = self === undefined ? null : findPlacementSpot(bot, self, 2);
    if (item === null || spot === null) return fail(logger, "no spot to set the table down");
    table = await placeItemAt(bot, item, spot, signal);
    if (table === null || table.name !== "crafting_table") return fail(logger, "could not place the table");
  }
  const made = await craftItem(bot, plan.tool, { craftingTable: table, signal });
  if (!made.ok) return fail(logger, made.reason);
  logger.info({ tool: plan.tool, at: table.position }, "field craft: made a pickaxe on the spot");
  return plan.tool;
}

function fail(logger: Logger, reason: string): null {
  logger.warn({ reason }, "field craft: could not make a pickaxe");
  return null;
}

/** Bounded nearby survival work independent of home and its storage. */
export async function recoverSuppliesInField(bot: Bot, logger: Logger, signal?: AbortSignal): Promise<void> {
  // Only actual, visible trunk bases within reach. Never punch a plank wall,
  // climb into a canopy, or start another home-dependent ensure_item trip.
  for (let n = 0; n < 3 && countLogs(bot) < 3; n++) {
    throwIfAborted(signal);
    const positions = bot.findBlocks({ matching: block => /_log$/.test(block.name), maxDistance: 12, count: 32 });
    let position = positions.find(pos => isTrunkBase(bot, pos) && diggingStanceBlocker(bot, pos, true) === null);
    if (position === undefined) {
      const trunk = positions.find(pos => isTrunkBase(bot, pos));
      const approach = trunk === undefined ? undefined : groundDigApproaches(bot, trunk)[0];
      if (approach === undefined) break;
      const walked = await travelAndWait(bot, approach, { signal, timeoutMs: 10_000, range: 0.5, allowDig: false });
      if (walked.status !== "arrived" && walked.status !== "already_there") break;
      if (trunk !== undefined && diggingStanceBlocker(bot, trunk, true) === null) position = trunk;
    }
    const block = position === undefined ? null : bot.blockAt(position);
    if (block === null) break;
    await collectBlocks(bot, [block], () => countLogs(bot), 3, message => logger.info({ message }, "field wood recovery"), 15_000, undefined, signal);
    await syncInventory(bot, signal);
  }
  if (!bot.inventory.items().some(item => item.name.endsWith("_pickaxe"))) await craftPickaxeInField(bot, logger, signal);
  const table = findBlockNear(bot, "crafting_table", TABLE_REACH);
  if (table !== null && countItem(bot, "wheat") >= 3) {
    const times = Math.min(6, Math.floor(countItem(bot, "wheat") / 3));
    const made = await craftItem(bot, "bread", { times, craftingTable: table, signal });
    logger.info({ made: made.ok, times }, "field recovery: baking carried wheat");
  }
}
