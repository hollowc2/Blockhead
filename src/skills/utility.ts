import type { Bot } from "mineflayer";
import type { Block } from "prismarine-block";
import type { Logger } from "pino";
import type { AgentState } from "../agent/state.js";
import type { TaskSignals } from "../agent/scheduler.js";
import type { MinecraftConfig } from "../config/schema.js";
import type { StorageRepository } from "../memory/storage.js";
import { bareName, findItem, hasItem } from "../minecraft/inventory.js";
import { withdrawFromHomeChest } from "../minecraft/containers.js";
import { findBlocksNear } from "../minecraft/world.js";
import { travelHomeAndWait } from "../minecraft/movement.js";
import { HOSTILE_MOB_NAMES } from "../policy/combat.js";
import { TOOL_FAMILIES } from "./expedition.js";
import { sleep as waitMs, withTimeout, type SkillResult } from "./skill-library.js";
import { throwIfAborted } from "../agent/world-actions.js";

/** True when a block is a bed of any color. */
export function isBedBlock(block: Block | null): boolean {
  return block !== null && /^[a-z_]*bed$/.test(bareName(block.name));
}

/**
 * Phase 13 utility skills (spec 14.7): `sleep`, `eat`, `equip_best`,
 * `replace_equipment`, and the `inspect_area` readout. Every action is short,
 * deterministic primitive orchestration — the LLM never touches inputs or
 * slots directly.
 */

/** Wall-clock budget for one home trip. */
const TRAVEL_TIMEOUT_MS = 120_000;
/** Scan radius for a bed at home. */
const BED_SCAN_RADIUS = 16;
/** How long the bot waits to fall asleep / wake up. */
const SLEEP_START_TIMEOUT_MS = 30_000;
const WAKE_TIMEOUT_MS = 300_000;
/** Poll cadence while waiting out sleep. */
const SLEEP_POLL_MS = 2_000;
/** Wall-clock budget for one eat action. */
const EAT_TIMEOUT_MS = 60_000;

export interface UtilityOptions {
  bot: Bot;
  state: AgentState;
  config: MinecraftConfig;
  /** Home storage, for replace_equipment withdrawals. */
  storage: StorageRepository;
  logger: Logger;
}

export interface UtilityData {
  action: string;
  extra: Record<string, unknown>;
  interruptions: number;
}

/**
 * Deterministic utility runner: sleep, eat, equip best, replace equipment.
 * Forbids stacking (one run at a time).
 */
export class UtilityRunner {
  private running = false;
  private signals: TaskSignals | null = null;
  private stopRequested = false;
  private interruptions = 0;
  private currentAction = "";

  constructor(private readonly opts: UtilityOptions) {}

  get isRunning(): boolean {
    return this.running;
  }

  /** Sleep in a home bed until morning (or report why that cannot happen now). */
  async sleep(options: { signals?: TaskSignals } = {}): Promise<SkillResult<UtilityData>> {
    return this.run("sleep", options, async (bot) => {
      const home = this.opts.state.home;
      if (home === null) return { ok: false, errorCode: "STORAGE_NOT_FOUND", message: "no home coordinate configured", retryable: false };
      const returned = await travelHomeAndWait(bot, home, {
        dimension: home.dimension,
        timeoutMs: TRAVEL_TIMEOUT_MS,
        shouldAbort: this.travelAbort,
        signal: this.signals?.signal,
      });
      if (this.stopRequested) return this.interruptedResult();
      if (returned.status !== "arrived" && returned.status !== "already_there") {
        return { ok: false, errorCode: "PATH_UNREACHABLE", message: `could not return home: ${returned.status}`, retryable: true };
      }

      const beds = findBlocksNear(bot, isBedBlock, BED_SCAN_RADIUS, 4).map((v) => bot.blockAt(v)).filter((block) => block !== null);
      if (beds.length === 0) return { ok: false, errorCode: "NOT_READY", message: "no bed at home to sleep in", retryable: true };
      const bed = beds[0]!;
      try {
        throwIfAborted(this.signals?.signal);
        await withTimeout(SLEEP_START_TIMEOUT_MS, bot.sleep(bed), () => undefined, this.signals?.signal);
        throwIfAborted(this.signals?.signal);
      } catch (err) {
        throwIfAborted(this.signals?.signal);
        return { ok: false, errorCode: "NOT_READY", message: `cannot sleep now: ${String(err).split(";")[0]}`, retryable: false };
      }
      if (this.stopRequested) return this.interruptedResult();
      // The server wakes the sleeper at dawn; wait for the wake, bounded.
      const deadline = Date.now() + WAKE_TIMEOUT_MS;
      while (Date.now() < deadline) {
        this.checkInterrupt();
        if (this.stopRequested) {
          try {
            throwIfAborted(this.signals?.signal);
            await bot.wake();
            throwIfAborted(this.signals?.signal);
          } catch {
            // already awake
          }
          return this.interruptedResult();
        }
        if (!bot.isSleeping) return { ok: true, message: "Slept. Morning." };
        await waitMs(SLEEP_POLL_MS);
      }
      try {
        await bot.wake();
      } catch {
        // already awake
      }
      return { ok: true, message: "Slept." };
    });
  }

  /** Eat a bit of carried food (auto-eat already handles hunger passively). */
  async eat(options: { signals?: TaskSignals } = {}): Promise<SkillResult<UtilityData>> {
    return this.run("eat", options, async (bot) => {
      const food = bot.inventory.items().find((item) => bot.autoEat && bot.autoEat.foodsByName?.[bareName(item.name)] !== undefined);
      if (food === undefined) return { ok: false, errorCode: "RESOURCE_NOT_FOUND", message: "no food to eat", retryable: false };
      if (bot.food >= 20) return { ok: true, message: "Not hungry." };
      try {
        throwIfAborted(this.signals?.signal);
        await withTimeout(EAT_TIMEOUT_MS, bot.autoEat.eat({ food: food.name }), () => bot.autoEat.cancelEat(), this.signals?.signal);
        throwIfAborted(this.signals?.signal);
      } catch (err) {
        throwIfAborted(this.signals?.signal);
        return { ok: false, errorCode: "NOT_READY", message: `could not eat: ${String(err)}`, retryable: true };
      }
      return { ok: true, message: "Ate." };
    });
  }

  /** Equip the best carried tool of each family plus armor. */
  async equipBest(options: { signals?: TaskSignals } = {}): Promise<SkillResult<UtilityData>> {
    return this.run("equip_best", options, async (bot) => {
      if (bot.entity === null) return { ok: false, errorCode: "NOT_READY", message: "bot is not spawned", retryable: false };
      let equipped = 0;
      const familyNames: readonly ("axe" | "pickaxe")[] = ["pickaxe", "axe"];
      for (const family of familyNames) {
        const names = TOOL_FAMILIES[family];
        // Highest tier first; prefer undamaged.
        for (let i = names.length - 1; i >= 0; i--) {
          const item = findItem(bot, names[i] ?? "");
          if (item === null) continue;
          try {
            throwIfAborted(this.signals?.signal);
            await bot.equip(item, "hand");
            throwIfAborted(this.signals?.signal);
          } catch {
            continue;
          }
          equipped += 1;
          break;
        }
      }
      try {
        throwIfAborted(this.signals?.signal);
        await bot.armorManager.equipAll();
        throwIfAborted(this.signals?.signal);
        equipped += 1;
      } catch (err) {
        this.opts.logger.info({ err: String(err) }, "equip_best armor skipped");
      }
      if (this.stopRequested) return this.interruptedResult();
      return equipped > 0 ? { ok: true, message: "Equipped." } : { ok: true, message: "Nothing to equip." };
    });
  }

  /**
   * Replace broken carried equipment: withdraw a fresh copy from the home
   * chest when stocked; nothing is dropped and nothing is crafted here
   * (ensure_item covers crafting).
   */
  async replaceEquipment(options: { signals?: TaskSignals } = {}): Promise<SkillResult<UtilityData>> {
    return this.run("replace_equipment", options, async (bot) => {
      const home = this.opts.state.home;
      if (home === null) return { ok: false, errorCode: "STORAGE_NOT_FOUND", message: "no home coordinate configured", retryable: false };
      const returned = await travelHomeAndWait(bot, home, {
        dimension: home.dimension,
        timeoutMs: TRAVEL_TIMEOUT_MS,
        shouldAbort: this.travelAbort,
        signal: this.signals?.signal,
      });
      if (this.stopRequested) return this.interruptedResult();
      if (returned.status !== "arrived" && returned.status !== "already_there") {
        return { ok: false, errorCode: "PATH_UNREACHABLE", message: `could not return home: ${returned.status}`, retryable: true };
      }

      const broken: string[] = [];
      for (const item of bot.inventory.items()) {
        if (item.maxDurability > 0 && item.durabilityUsed >= item.maxDurability) broken.push(bareName(item.name));
      }
      let replaced = 0;
      for (const name of broken) {
        if (hasItem(bot, name)) continue; // a fresh copy already sits in the inventory
        const withdrawn = await withdrawFromHomeChest(bot, this.opts.state, this.opts.storage, name, 1, this.opts.logger);
        if (withdrawn.withdrawn > 0) replaced += 1;
      }
      if (this.stopRequested) return this.interruptedResult();
      return replaced > 0
        ? { ok: true, message: `Replaced ${replaced} broken item${replaced === 1 ? "" : "s"}.` }
        : { ok: true, message: broken.length > 0 ? "No replacements in stock." : "Nothing broken." };
    });
  }

  // --- plumbing ---

  private async run(
    action: string,
    options: { signals?: TaskSignals },
    execute: (bot: Bot) => Promise<{ ok: boolean; message: string; errorCode?: string; retryable?: boolean }>,
  ): Promise<SkillResult<UtilityData>> {
    if (this.running) {
      return { ok: false, status: "blocked", errorCode: "ALREADY_RUNNING", message: "utility skill already running" };
    }
    this.running = true;
    this.signals = options.signals ?? null;
    this.currentAction = action;
    this.stopRequested = false;
    try {
      if (this.opts.bot.entity === null) {
        return { ok: false, status: "failed", errorCode: "NOT_READY", message: "bot is not spawned", retryable: false, data: this.data() };
      }
      const result = await execute(this.opts.bot);
      if (!result.ok) {
        return { ok: false, status: "failed", errorCode: result.errorCode ?? "NOT_READY", message: result.message, retryable: result.retryable ?? true, data: this.data() };
      }
      return { ok: true, status: "completed", data: this.data(), message: result.message };
    } finally {
      this.running = false;
      this.signals = null;
    }
  }

  private data(): UtilityData {
    return { action: this.currentAction, extra: {}, interruptions: this.interruptions };
  }

  private checkInterrupt(): void {
    if (this.stopRequested || this.signals === null) return;
    if (!this.signals.checkpoint({ action: this.currentAction, interruptions: this.interruptions + 1 })) {
      this.stopRequested = true;
      this.interruptions += 1;
    }
  }

  private travelAbort = (): boolean => {
    this.checkInterrupt();
    return this.stopRequested;
  };

  private interruptedResult(): { ok: false; message: string; errorCode: string; retryable: true } {
    this.opts.logger.info({ action: this.currentAction }, "utility interrupted");
    return { ok: false, message: "interrupted", errorCode: "NOT_READY", retryable: true };
  }
}

// --- inspect_area: a synchronous readout tool (no scheduler task) ---

/** Radius for the `inspect_area` scan. */
const INSPECT_RADIUS = 32;

/**
 * A short, deterministic neighborhood readout for `inspect_area`: position,
 * dimension, time of day, hostiles/players in view, and the nearest block of
 * each interesting kind. Pure perception — the LLM reads the reply from chat.
 */
export function inspectArea(bot: Bot, state: AgentState): string {
  const self = state.self.position;
  if (self === null) return "Not spawned.";
  const lines: string[] = [];
  lines.push(`At ${Math.round(self.x)}, ${Math.round(self.y)}, ${Math.round(self.z)} (${state.self.dimension ?? "unknown"}).`);
  lines.push(`Time: ${state.timePhase ?? "unknown"}. Health ${state.self.health}, food ${state.self.food}.`);

  let hostiles = 0;
  let players: string[] = [];
  for (const entity of Object.values(bot.entities)) {
    const distance = Math.hypot(entity.position.x - self.x, entity.position.y - self.y, entity.position.z - self.z);
    if (distance > INSPECT_RADIUS) continue;
    if (entity.type === "mob" && HOSTILE_MOB_NAMES.has(entity.name ?? "")) hostiles += 1;
    if (entity.type === "player" && entity.name !== bot.username) players.push(entity.name ?? "player");
  }
  if (hostiles > 0) lines.push(`${hostiles} hostile${hostiles === 1 ? "" : "s"} within ${INSPECT_RADIUS} blocks.`);
  if (players.length > 0) lines.push(`Players near: ${players.join(", ")}.`);

  const interests: Record<string, string> = {
    oak_log: "trees",
    iron_ore: "iron ore",
    coal_ore: "coal",
    water: "water",
    crafting_table: "a crafting table",
    furnace: "a furnace",
    bed: "a bed",
    chest: "a chest",
  };
  const seen: string[] = [];
  for (const [blockName, label] of Object.entries(interests)) {
    const found = findBlocksNear(bot, (block) => blockName === "bed" ? isBedBlock(block) : block.name === blockName, INSPECT_RADIUS, 1);
    if (found.length > 0) seen.push(label);
  }
  if (seen.length > 0) {
    lines.push(`Nearby: ${seen.join(", ")}.`);
  } else {
    lines.push("Nothing notable in view.");
  }
  return lines.join(" ");
}
