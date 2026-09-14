import type { Bot } from "mineflayer";
import type { Logger } from "pino";
import type { AgentState } from "../agent/state.js";
import type { TaskSignals } from "../agent/scheduler.js";
import type { MinecraftConfig } from "../config/schema.js";
import type { StorageRepository } from "../memory/storage.js";
import { bareName, countItem, findItem } from "../minecraft/inventory.js";
import { deliverCarried, withdrawFromHomeChest } from "../minecraft/containers.js";
import { travelAndWait, travelHomeAndWait } from "../minecraft/movement.js";
import { resourceStem } from "./skill-library.js";
import { storageCategoryFor } from "./organize-storage.js";
import { withTimeout, type SkillResult } from "./skill-library.js";

/**
 * Phase 13 delivery skills (spec 14.4): `give_item`, `store_items`, and
 * `retrieve_items`. Deterministic inventory/container orchestration; the LLM
 * only names the player/items. `give_item` walks to the player and tosses
 * the quantity; `store_items` deposits carried items matching a filter into
 * the home chest; `retrieve_items` withdraws items back out.
 */

/** Wall-clock budget for one home trip. */
const TRAVEL_TIMEOUT_MS = 120_000;
/** Wall-clock budget for one give-item trip. */
const GIVE_TIMEOUT_MS = 120_000;
/** Range at which the bot stands to toss items to a player. */
const GIVE_RANGE = 4;

export interface DeliveryOptions {
  bot: Bot;
  state: AgentState;
  config: MinecraftConfig;
  /** Home storage registration (spec 22). */
  storage: StorageRepository;
  logger: Logger;
}

export interface DeliveryData {
  action: "give" | "store" | "retrieve";
  player: string | null;
  item: string | null;
  quantity: number;
  handled: number;
  interruptions: number;
}

/**
 * Deterministic delivery runner: give / store / retrieve. One run at a time.
 */
export class DeliveryRunner {
  private running = false;
  private signals: TaskSignals | null = null;
  private stopRequested = false;
  private interruptions = 0;

  constructor(private readonly opts: DeliveryOptions) {}

  get isRunning(): boolean {
    return this.running;
  }

  /** Walk to `player` and toss `quantity` of `item` to them. */
  async give(
    player: string,
    item: string,
    quantity: number,
    options: { signals?: TaskSignals; resumeState?: { interruptions?: number } } = {},
  ): Promise<SkillResult<DeliveryData>> {
    return this.run("give", player, item, quantity, options, async (bot, data) => {
      const target = bot.players[player]?.entity ?? null;
      if (target === null) {
        return { ok: true, message: `Can't see ${player} to give them anything.`, data };
      }
      const travel = await travelAndWait(bot, target.position, {
        timeoutMs: GIVE_TIMEOUT_MS,
        range: GIVE_RANGE,
        shouldAbort: this.travelAbort,
      });
      if (this.stopRequested) return this.interruptedResult(data);
      if (travel.status !== "arrived" && travel.status !== "already_there") {
        return { ok: false, message: `could not reach ${player}: ${travel.status}`, errorCode: "PATH_UNREACHABLE", retryable: true, data };
      }
      const held = findItem(bot, item);
      if (held === null) {
        return { ok: false, message: `I am not carrying ${item}`, errorCode: "RESOURCE_NOT_FOUND", retryable: false, data };
      }
      const count = Math.min(quantity, countItem(bot, item));
      try {
        await withTimeout(30_000, bot.toss(held.type, held.metadata, count), () => undefined);
      } catch (err) {
        return { ok: false, message: `could not toss ${item}: ${String(err)}`, errorCode: "NOT_READY", retryable: true, data };
      }
      data.handled = count;
      return { ok: true, message: `Gave ${count} ${item} to ${player}.`, data };
    });
  }

  /** Deposit carried items matching `filter` into the home chest. */
  async store(
    filter: string | null,
    _location: string | null,
    options: { signals?: TaskSignals; resumeState?: { interruptions?: number } } = {},
  ): Promise<SkillResult<DeliveryData>> {
    return this.run("store", null, filter ?? "all", 0, options, async (bot, data) => {
      const home = this.opts.state.home;
      if (home === null) {
        return { ok: false, message: "no home coordinate configured", errorCode: "STORAGE_NOT_FOUND", retryable: false, data };
      }
      const returned = await travelHomeAndWait(bot, home, {
        dimension: home.dimension,
        timeoutMs: TRAVEL_TIMEOUT_MS,
        shouldAbort: this.travelAbort,
      });
      if (this.stopRequested) return this.interruptedResult(data);
      if (returned.status !== "arrived" && returned.status !== "already_there") {
        return { ok: false, message: `could not return home: ${returned.status}`, errorCode: "PATH_UNREACHABLE", retryable: true, data };
      }

      const matches = (name: string): boolean => {
        if (filter === null || filter === "") return true;
        const bare = bareName(name);
        return bare === filter || storageCategoryFor(bare) === filter || resourceStem(bare) === filter;
      };
      const names = [...new Set(bot.inventory.items().map((item) => bareName(item.name)))].filter(matches);
      let delivered = 0;
      for (const name of names) {
        const result = await deliverCarried(bot, this.opts.state, this.opts.storage, name, this.opts.logger);
        delivered += result.delivered;
        if (this.stopRequested) return this.interruptedResult(data);
      }
      data.handled = delivered;
      return delivered > 0
        ? { ok: true, message: `Stored ${delivered} items.`, data }
        : { ok: true, message: "Nothing to store.", data };
    });
  }

  /** Withdraw the listed items (with optional counts) from the home chest. */
  async retrieve(
    items: { item: string; quantity: number }[],
    _location: string | null,
    options: { signals?: TaskSignals; resumeState?: { interruptions?: number } } = {},
  ): Promise<SkillResult<DeliveryData>> {
    return this.run("retrieve", null, "items", 0, options, async (bot, data) => {
      const home = this.opts.state.home;
      if (home === null) {
        return { ok: false, message: "no home coordinate configured", errorCode: "STORAGE_NOT_FOUND", retryable: false, data };
      }
      const returned = await travelHomeAndWait(bot, home, {
        dimension: home.dimension,
        timeoutMs: TRAVEL_TIMEOUT_MS,
        shouldAbort: this.travelAbort,
      });
      if (this.stopRequested) return this.interruptedResult(data);
      if (returned.status !== "arrived" && returned.status !== "already_there") {
        return { ok: false, message: `could not return home: ${returned.status}`, errorCode: "PATH_UNREACHABLE", retryable: true, data };
      }

      let withdrawn = 0;
      for (const entry of items) {
        const name = bareName(entry.item);
        const count = Math.max(1, Math.floor(entry.quantity));
        const result = await withdrawFromHomeChest(bot, this.opts.state, this.opts.storage, name, count, this.opts.logger);
        withdrawn += result.withdrawn;
        if (this.stopRequested) return this.interruptedResult(data);
      }
      data.handled = withdrawn;
      return withdrawn > 0
        ? { ok: true, message: `Retrieved ${withdrawn} items.`, data }
        : { ok: true, message: "Nothing to retrieve.", data };
    });
  }

  // --- plumbing ---

  private async run(
    action: "give" | "store" | "retrieve",
    player: string | null,
    item: string | null,
    quantity: number,
    options: { signals?: TaskSignals; resumeState?: { interruptions?: number } },
    execute: (bot: Bot, data: DeliveryData) => Promise<
      | { ok: true; message: string; data: DeliveryData }
      | { ok: false; message: string; errorCode: string; retryable: boolean; data: DeliveryData }
    >,
  ): Promise<SkillResult<DeliveryData>> {
    if (this.running) {
      return { ok: false, status: "blocked", errorCode: "ALREADY_RUNNING", message: "delivery skill already running" };
    }
    this.running = true;
    this.signals = options.signals ?? null;
    this.interruptions = typeof options.resumeState?.interruptions === "number" ? options.resumeState.interruptions : 0;
    this.stopRequested = false;
    try {
      const data: DeliveryData = {
        action,
        player,
        item,
        quantity,
        handled: 0,
        interruptions: this.interruptions,
      };
      if (this.opts.bot.entity === null) {
        return { ok: false, status: "failed", errorCode: "NOT_READY", message: "bot is not spawned", retryable: false, data };
      }
      const result = await execute(this.opts.bot, data);
      if (!result.ok) {
        return { ok: false, status: "failed", errorCode: result.errorCode, message: result.message, retryable: result.retryable, data: result.data };
      }
      this.opts.logger.info({ action, message: result.message }, "delivery status");
      return { ok: true, status: "completed", data: result.data, message: result.message };
    } finally {
      this.running = false;
      this.signals = null;
    }
  }

  private checkInterrupt(): void {
    if (this.stopRequested || this.signals === null) return;
    if (!this.signals.checkpoint({ interruptions: this.interruptions + 1 })) {
      this.stopRequested = true;
      this.interruptions += 1;
    }
  }

  private travelAbort = (): boolean => {
    this.checkInterrupt();
    return this.stopRequested;
  };

  private interruptedResult<T>(
    data: DeliveryData,
  ): { ok: false; message: string; errorCode: string; retryable: true; data: DeliveryData } {
    this.opts.logger.info({ action: data.action }, "delivery interrupted");
    return { ok: false, message: "interrupted", errorCode: "NOT_READY", retryable: true, data };
  }
}