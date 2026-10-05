import type { Bot } from "mineflayer";
import type { Block } from "prismarine-block";
import type { Furnace } from "mineflayer";
import { itemId } from "./crafting.js";
import { countItem, findItem } from "./inventory.js";
import { requireWorldActionLease, throwIfAborted } from "../agent/world-actions.js";
import { closeFurnace, openFurnace, putFuel, putInput, takeInput, takeOutput } from "./primitives.js";
import { walkIntoReach } from "./movement.js";
import { observedDelta } from "../status/deltas.js";

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
  /**
   * Item name(s) to burn ("oak_log", "coal", ...), most preferred first; the
   * first one carried is used. Listing the output (charcoal) lets a charcoal
   * run fuel itself once its first piece is out: one charcoal smelts 8 items,
   * one log only 1.5.
   */
  fuelName: string | readonly string[];
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

/** Seconds one smelt takes; refuel when less burn time than this remains. */
const SMELT_SECONDS = 10;

/**
 * Smelt `times` input items in a placed furnace. The window stays open across
 * passes: each pass drops one input item in, adds one fuel item only when the
 * remaining burn time cannot finish it, waits for the output slot to fill,
 * and takes the result into the inventory. Fuel left unburnt in the slot is
 * taken back at the end.
 */
export async function smeltItems(bot: Bot, furnaceBlock: Block, options: SmeltOptions): Promise<SmeltResult> {
  const lease = requireWorldActionLease(options.signal);
  const signal = options.signal ?? lease.signal;
  throwIfAborted(signal);
  const outputId = itemId(bot, options.outputName);
  if (outputId === null) {
    return { ok: false, reason: `unknown item '${options.outputName}'` };
  }
  const fuelNames = typeof options.fuelName === "string" ? [options.fuelName] : options.fuelName;

  if (!(await walkIntoReach(bot, furnaceBlock, signal))) return { ok: false, reason: "could not reach the furnace" };
  throwIfAborted(signal);
  let window: Furnace | null = null;
  const beforeOutput = countItem(bot, options.outputName);
  // Output burned as fuel was produced all the same.
  let outputBurned = 0;
  // Output an earlier run left in the slot is taken, but not made by this run.
  let leftoverOutput = 0;
  const produced = (): number => countItem(bot, options.outputName) + outputBurned - leftoverOutput - beforeOutput;
  const settle = (failure: string): SmeltResult => {
    const delta = observedDelta(0, produced(), options.times);
    if (delta.status === "COMPLETE") return { ok: true, smelted: delta.delta };
    return { ok: false, reason: delta.delta > 0 ? `smelting made partial progress (${delta.delta}/${options.times}): ${failure}` : failure };
  };
  let failure: string | null;
  try {
    window = await openFurnace(bot, furnaceBlock, signal);
    throwIfAborted(signal);
    failure = await clearFurnace(window) ?? await runPasses(window);
    await reclaimFuel(window);
  } finally {
    if (window !== null) await closeFurnace(window).catch(() => undefined);
  }
  // Count only after the window closes: while it is open the taken output
  // sits in the window's mirror of the inventory, and counting then read a
  // cooked porkchop that was in hand as "no output change" (2026-10-04).
  return settle(failure ?? "smelting made no output change");

  async function runPasses(window: Furnace): Promise<string | null> {
    for (let pass = 0; pass < options.times; pass++) {
      throwIfAborted(signal);
      const input = findItem(bot, options.inputName);
      if (input === null) return `no ${options.inputName} to smelt`;
      if (needsFuel(window as FuelGauge)) {
        const fuel = fuelNames.map((name) => findItem(bot, name)).find((item) => item !== null) ?? null;
        if (fuel === null) return `no ${fuelNames.join("/")} to burn`;
        await putFuel(window, fuel.type, null, 1, signal);
        if (fuel.name === options.outputName) outputBurned += 1;
      }
      await putInput(window, input.type, null, 1, signal);

      const done = await awaitOutput(window, outputId!, options.timeoutMs ?? DEFAULT_SMELT_TIMEOUT_MS, signal);
      if (!done) return "smelting timed out";
      try {
        throwIfAborted(signal);
        await takeOutput(window, signal);
      } catch (err) {
        throwIfAborted(signal);
        return `could not take smelted item: ${String(err)}`;
      }
    }
    return null;
  }

  /**
   * Empty what an earlier run left behind: its output, and an input that is
   * not this run's. Live 2026-10-04: 2 charcoal sat in the output slot, so a
   * beef could not cook and stayed in the input slot, and every charcoal
   * batch after it threw "destination full" putting its log in.
   */
  async function clearFurnace(window: Furnace): Promise<string | null> {
    try {
      const output = window.outputItem();
      if (output !== null && output !== undefined) {
        await takeOutput(window, signal);
        if (output.name === options.outputName) leftoverOutput += output.count;
      }
      const input = window.inputItem();
      if (input !== null && input !== undefined && input.name !== options.inputName) await takeInput(window, signal);
      return null;
    } catch (err) {
      throwIfAborted(signal);
      return `could not empty the furnace: ${String(err)}`;
    }
  }

  /** Take back unburnt fuel; a charcoal run otherwise strands a piece per run. */
  async function reclaimFuel(window: Furnace): Promise<void> {
    const leftover = window.fuelItem();
    if (leftover === null || leftover === undefined) return;
    try {
      await window.takeFuel();
      if (leftover.name === options.outputName) outputBurned = Math.max(0, outputBurned - leftover.count);
    } catch {
      // Left in the furnace; the next run burns it first.
    }
  }
}

/** The furnace window's burn gauge (mineflayer sets `fuelSeconds` but does not type it). */
export interface FuelGauge {
  fuelItem(): { name: string; count: number } | null;
  fuelSeconds?: number | null;
}

/** True when the fuel slot is empty and the current burn cannot finish another item. */
export function needsFuel(window: FuelGauge): boolean {
  const slot = window.fuelItem();
  if (slot !== null && slot !== undefined) return false;
  return (window.fuelSeconds ?? 0) < SMELT_SECONDS;
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
