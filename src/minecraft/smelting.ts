import type { Bot } from "mineflayer";
import type { Block } from "prismarine-block";
import type { Furnace } from "mineflayer";
import { itemId } from "./crafting.js";
import { findItem } from "./inventory.js";
import { throwIfAborted } from "../agent/world-actions.js";

/**
 * Deterministic smelting primitives. Slot mechanics stay inside mineflayer's
 * furnace window (`bot.openFurnace` / `takeOutput`); the skill layer only
 * supplies "smelt N inputs of this item, burning that fuel, until the output
 * appears". One pass converts exactly one input item into one output item.
 */

export type SmeltResult = { ok: true; smelted: number } | { ok: false; reason: string };

export interface SmeltOptions {
  /** Item name to place in the input slot ("oak_log", "cobblestone", ...). */
  inputName: string;
  /** Item name to burn ("oak_log", "coal", ...) — any burnable the bot holds. */
  fuelName: string;
  /** Item the furnace must produce in the output slot ("charcoal"). */
  outputName: string;
  /** How many input items to convert (each takes ~10s of burn time). */
  times: number;
  /** Wall-clock budget for one smelt pass. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** How often the output slot is polled while a pass runs. */
const SMELT_POLL_MS = 500;
const DEFAULT_SMELT_TIMEOUT_MS = 120_000;

/**
 * Smelt `times` input items in a placed furnace. The window stays open across
 * passes: each pass drops one fuel item and one input item in, waits for the
 * output slot to fill, and takes the result into the inventory.
 */
export async function smeltItems(bot: Bot, furnaceBlock: Block, options: SmeltOptions): Promise<SmeltResult> {
  throwIfAborted(options.signal);
  const outputId = itemId(bot, options.outputName);
  if (outputId === null) {
    return { ok: false, reason: `unknown item '${options.outputName}'` };
  }

  throwIfAborted(options.signal);
  const window = await bot.openFurnace(furnaceBlock);
  try {
    for (let pass = 0; pass < options.times; pass++) {
      throwIfAborted(options.signal);
      const input = findItem(bot, options.inputName);
      if (input === null) return { ok: false, reason: `no ${options.inputName} to smelt` };
      const fuel = findItem(bot, options.fuelName);
      if (fuel === null) return { ok: false, reason: `no ${options.fuelName} to burn` };

      await window.putFuel(fuel.type, null, 1);
      throwIfAborted(options.signal);
      await window.putInput(input.type, null, 1);
      throwIfAborted(options.signal);

      const done = await awaitOutput(window, outputId, options.timeoutMs ?? DEFAULT_SMELT_TIMEOUT_MS, options.signal);
      if (!done) return { ok: false, reason: "smelting timed out" };
      try {
        await window.takeOutput();
        throwIfAborted(options.signal);
      } catch (err) {
        return { ok: false, reason: `could not take smelted item: ${String(err)}` };
      }
    }
    return options.times > 0
      ? { ok: true, smelted: options.times }
      : { ok: false, reason: "smelt request made no inventory change" };
  } finally {
    await window.close().catch(() => undefined);
  }
}

/** Poll the furnace's output slot (index 2) until it holds `outputId` or the budget runs out. */
async function awaitOutput(window: Furnace, outputId: number, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    const output = window.slots[2];
    if (output !== null && output !== undefined && output.type === outputId) return true;
    await sleep(SMELT_POLL_MS);
  }
  const output = window.slots[2];
  return output !== null && output !== undefined && output.type === outputId;
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}
