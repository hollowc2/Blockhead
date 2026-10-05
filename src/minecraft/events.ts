import type { Bot } from "mineflayer";
import type { Logger } from "pino";
import { readState } from "./bot.js";
import { dominantNearbyLog } from "./world.js";
import { itemsSummary } from "./inventory.js";
import { logger } from "../logger.js";
import type { MinecraftConfig } from "../config/schema.js";
import type { AgentState } from "../agent/state.js";
import type { Scheduler } from "../agent/scheduler.js";
import { TaskPriority } from "../agent/task.js";
import type { StockpileManager } from "../agent/maintenance.js";
import type { EventBus } from "../events/bus.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolContext } from "../tools/types.js";
import type { BootstrapRunner } from "../skills/bootstrap-survival.js";
import type { DecisionMaker } from "../llm/decider.js";
import type { AgentDecision } from "../llm/schemas.js";
import type { TasksRepository } from "../memory/tasks.js";
import type { StorageRepository } from "../memory/storage.js";
import type { GoalManager } from "../agent/goals.js";
import { stopWorldPrimitives } from "../agent/world-actions.js";
import type { TerrainToolName } from "../tools/terrain.js";

/** Shared wiring handed to mineflayer event registration. */
export interface AgentContext {
  bus: EventBus;
  state: AgentState;
  scheduler: Scheduler;
  registry: ToolRegistry;
  decider: DecisionMaker;
  owner: string;
  /** Bootstrap state machine (Phase 5); tools use it when present. */
  bootstrap?: BootstrapRunner;
  /** Task store for the LLM context digest of recent settled outcomes. */
  tasks: TasksRepository;
  /** Home-storage registry for the LLM context (registered chest locations). */
  storage: StorageRepository;
  /** Session-scoped stockpile manager for the LLM context (last measured levels). */
  maintenance: StockpileManager;
  /** Process-lifetime goal coordinator (the active autonomous objective). */
  goals?: GoalManager;
  worldProjects?: import("../agent/world-projects.js").WorldProjectManager;
}

/** Matches a bare "CobbleBob?" (case-insensitive, optional trailing punctuation). */
export const HELLO_PATTERN = /^cobblebob[!?.,]*$/i;

/**
 * Lowercase, drop a leading "cobblebob" name token, collapse whitespace and
 * trim trailing punctuation. Players habitually address the bot by name.
 */
function normalizeInstruction(message: string): string {
  return message
    .trim()
    .toLowerCase()
    .replace(/^(cobblebob|cobble|bob)[\s,!?.]+/i, "")
    .replace(/[!?.,]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

interface DeterministicBuildCommand { tool: "build_base" | "build_structure" | "build_design"; args: Record<string, unknown>; error?: string; }
export interface DeterministicTerrainCommand { tool: TerrainToolName; args: Record<string, unknown>; error?: string; }

/** Explicit, bounded owner phrases for the four terrain operations. */
export function parseDeterministicTerrainCommand(instruction: string): DeterministicTerrainCommand | null {
  const value = instruction.trim().toLowerCase().replace(/[!?.,]+$/, "");
  let match = value.match(/^(?:please )?(?:flatten) (\d+)\s*x\s*(\d+)(?: here)?$/);
  if (match) return { tool: "flatten_area", args: { width: Number(match[1]), length: Number(match[2]), anchor: "owner" } };
  match = value.match(/^(?:please )?clear(?: out)?(?: (?:a|an|the|this))? (\d+)\s*(?:x|by)\s*(\d+)(?: area| space)?(?: here| for me)?$/);
  // A terrain prism centred on the owner would always be rejected by the
  // player-safety buffer.  Treat "clear 5x5" as the area in front of
  // the owner, leaving a one-block safety gap for the person giving the order.
  if (match) return { tool: "clear_area", args: { width: Number(match[1]), length: Number(match[2]), height: 4, anchor: "owner_front" } };
  if (/^(?:please )?clear (?:this|the|an?) (?:area|space|spot)(?: here| for me)?$/.test(value)) return { tool: "clear_area", args: { width: 8, length: 8, height: 4, anchor: "owner_front" } };
  match = value.match(/^(?:please )?dig (?:a |me a )?(\d+)\s*(?:x|by)\s*(\d+) (?:hole|pit|excavation) (\d+)(?: blocks?)? deep(?: here)?$/);
  if (match) return { tool: "excavate_volume", args: { width: Number(match[1]), length: Number(match[2]), depth: Number(match[3]), anchor: "owner" } };
  match = value.match(/^(?:please )?dig (?:a )?basement (\d+)\s*x\s*(\d+)\s*x\s*(\d+)(?: here)?$/);
  if (match) return { tool: "excavate_volume", args: { width: Number(match[1]), length: Number(match[2]), depth: Number(match[3]), anchor: "owner" } };
  match = value.match(/^(?:please )?dig (?:a )?(?:(\d+)|two)-wide staircase down (\d+) blocks?$/);
  if (match) return { tool: "dig_mineshaft", args: { width: match[1] === undefined ? 2 : Number(match[1]), height: 2, depth: Number(match[2]), anchor: "owner_front" } };
  match = value.match(/^(?:please )?dig (?:a |me a )?(?:mineshaft|mine shaft|mine|staircase mine) (?:down )?to y\s*=?\s*(-?\d+)$/);
  if (match) return { tool: "dig_mineshaft", args: { width: 1, height: 2, targetY: Number(match[1]), anchor: "owner_front" } };
  // "dig a mine": a walkable staircase down to iron level in front of the owner.
  if (/^(?:please )?(?:dig|make|build|start) (?:a |me a |us a )?(?:mineshaft|mine shaft|mine|staircase mine|branch mine)(?: here)?$/.test(value)) {
    return { tool: "dig_mineshaft", args: { width: 1, height: 2, targetY: 16, anchor: "owner_front" } };
  }
  return null;
}

const GATHER_ALIASES: Record<string, string> = {
  stone: "stone", stones: "stone", cobble: "stone", cobblestone: "stone", rock: "stone", rocks: "stone",
  deepslate: "deepslate", dirt: "dirt", sand: "sand", gravel: "gravel",
  coal: "coal_ore", "coal ore": "coal_ore", iron: "iron_ore", "iron ore": "iron_ore", "raw iron": "iron_ore",
  copper: "copper_ore", "copper ore": "copper_ore", gold: "gold_ore", "gold ore": "gold_ore",
  diamond: "diamond_ore", diamonds: "diamond_ore", redstone: "redstone_ore", lapis: "lapis_ore",
  emerald: "emerald_ore", emeralds: "emerald_ore",
};
const WOOD_WORDS = new Set(["wood", "log", "logs", "tree", "trees", "timber"]);
const WOOD_TYPES = ["oak", "spruce", "birch", "jungle", "acacia", "dark_oak", "mangrove", "cherry", "pale_oak"];

export interface DeterministicGatherCommand { resource: string; quantity: number; }

/**
 * "get 32 logs", "mine 20 iron", "collect some cobblestone", "chop 16 birch
 * wood": ordinary resource requests should not wait 30s on the LLM.
 */
export function parseDeterministicGatherCommand(instruction: string, nearbyLog: () => string): DeterministicGatherCommand | null {
  const value = instruction.trim().toLowerCase().replace(/[!?.,]+$/, "");
  const match = value.match(/^(?:please |can you |could you )?(?:get|gather|collect|mine|chop|cut|fetch|bring|go get)(?: me| us)? (\d+|some|a stack of|a few|lots of|more) (.+?)(?: for me| please)?$/);
  if (match === null) return null;
  const amount = match[1]!;
  const quantity = /^\d+$/.test(amount) ? Number(amount) : amount === "a stack of" ? 64 : amount === "a few" ? 8 : 32;
  if (quantity < 1 || quantity > 2304) return null;
  let noun = match[2]!.trim().replace(/ blocks?$/, "");
  const words = noun.split(/\s+/);
  const last = words[words.length - 1]!;
  if (WOOD_WORDS.has(last)) {
    const species = words.slice(0, -1).join("_");
    if (species === "") return { resource: nearbyLog(), quantity };
    if (WOOD_TYPES.includes(species)) return { resource: `${species}_log`, quantity };
    return null;
  }
  noun = noun.replace(/_/g, " ");
  const resource = GATHER_ALIASES[noun] ?? GATHER_ALIASES[noun.replace(/s$/, "")];
  return resource === undefined ? null : { resource, quantity };
}

/** Small, explicit owner-command rail that remains available while the LLM is down. */
export function parseDeterministicBuildCommand(instruction: string): DeterministicBuildCommand | null {
  instruction = instruction.trim().toLowerCase().replace(/[!?.,]+$/, "");
  const landmark = instruction.match(/^(?:please )?(?:build|make|construct)(?: me)? (?:a |the )?(?:medium |small |large )?(?:pentagon|pentagon building|us pentagon|sears tower|willis tower|chicago skyscraper|castle|cathedral|museum|greenhouse|bridge|mansion)(?:-inspired)?(?: skyscraper)?(?: with .*)?$/);
  if (landmark) {
    const name = instruction.match(/pentagon|sears tower|willis tower|chicago skyscraper|castle|cathedral|museum|greenhouse|bridge|mansion/)?.[0] ?? "museum";
    const template = /pentagon/.test(name) ? "pentagon_complex" : /sears|willis|chicago/.test(name) ? "bundled_tube_skyscraper" : name;
    const scale = /large/.test(instruction) ? "large" : /small/.test(instruction) ? "small" : "medium";
    return { tool: "build_design", args: { template, scale, anchor: "owner" } };
  }
  if (/^(please )?build (a |the )?(standard )?(stockpile )?shed$/.test(instruction)
    || /^(please )?build (a |the )?(standard )?base$/.test(instruction)) {
    return { tool: "build_base", args: {} };
  }

  // Common owner phrasing gets a bounded, LLM-independent blueprint. The
  // model still handles unusual designs, but ordinary requests should not
  // depend on it remembering every required dimension argument.
  const simpleShape = instruction.match(/^(?:please )?(?:build|make|construct)(?: me)? (?:a |the )?(house|home|cabin|shelter|room|wall|tower|pyramid)(?: (?:at|from) (owner|current|home))?$/);
  if (simpleShape) {
    const requested = simpleShape[1]!;
    const shape = ["house", "home", "cabin", "shelter"].includes(requested) ? "room" : requested;
    const defaults: Record<string, { width: number; height: number; length: number }> = {
      room: { width: 7, height: 4, length: 7 },
      wall: { width: 7, height: 3, length: 1 },
      tower: { width: 5, height: 8, length: 5 },
      pyramid: { width: 7, height: 4, length: 7 },
    };
    const dimensions = defaults[shape]!;
    return {
      tool: "build_structure",
      args: { shape, ...dimensions, material: "planks", anchor: simpleShape[2] ?? "owner" },
    };
  }

  const compact = instruction.match(/^(?:please )?(?:build|make|construct)(?: me)? (?:a |the )?(room|house|home|cabin|shelter|wall|tower|pyramid) (\d+)\s*x\s*(\d+)\s*x\s*(\d+)(?: (?:at|from) (owner|current|home))?$/);
  if (compact) {
    const shape = ["house", "home", "cabin", "shelter"].includes(compact[1]!) ? "room" : compact[1]!;
    return {
      tool: "build_structure",
      args: {
        shape,
        width: Number(compact[2]),
        height: Number(compact[3]),
        length: Number(compact[4]),
        material: "planks",
        anchor: compact[5] ?? "owner",
      },
    };
  }

  const match = instruction.match(/^(?:(?:please )?build (?:a )?(room|wall|tower|pyramid)(?: shaped)?(?: like a (room|wall|tower|pyramid))?|i want a stockpile shed shaped like a (room|wall|tower|pyramid)) (\d+) wide (\d+) tall (\d+) long(?: (?:from|at) (owner|current|home))?$/);
  if (!match) return null;
  const shape = (match[3] ?? match[2] ?? match[1])!;
  const width = Number(match[4]);
  const height = Number(match[5]);
  const length = Number(match[6]);
  const anchor = match[7] ?? "owner";
  if (shape === "pyramid" && height > Math.ceil(Math.min(width, length) / 2)) {
    return { tool: "build_structure", args: {}, error: `a ${width} by ${length} stepped pyramid can be at most ${Math.ceil(Math.min(width, length) / 2)} blocks tall` };
  }
  return { tool: "build_structure", args: { shape, width, height, length, material: "planks", anchor } };
}

/**
 * Human-readable kick reason. Mineflayer hands the parsed protocol compound
 * ({"type":"compound","value":{"translate":{"type":"string","value":"disconnect.spam"}}}),
 * which String() renders as "[object Object]". Prefer the translate key,
 * then a JSON dump, then the default stringification.
 */
function describeKickReason(reason: unknown): string {
  if (typeof reason === "string") return reason;
  try {
    const nested = (reason as { value?: { translate?: { value?: unknown } } }).value?.translate?.value;
    if (typeof nested === "string") return nested;
  } catch {
    // fall through to the JSON dump
  }
  try {
    return JSON.stringify(reason);
  } catch {
    return String(reason);
  }
}

function makeToolContext(bot: Bot, config: MinecraftConfig, ctx: AgentContext): ToolContext {
  return {
    bot,
    state: ctx.state,
    config,
    bus: ctx.bus,
    scheduler: ctx.scheduler,
    bootstrap: ctx.bootstrap,
    tasks: ctx.tasks,
    storage: ctx.storage,
    maintenance: ctx.maintenance,
    goals: ctx.goals,
    worldProjects: ctx.worldProjects,
  };
}

/**
 * Validate a tool name + arguments against the registry and run it.
 * Unregistered tools and invalid arguments are rejected; nothing is executed.
 */
function runTool(bot: Bot, config: MinecraftConfig, ctx: AgentContext, name: string, args: unknown): string {
  if (!ctx.registry.has(name)) {
    logger.warn({ tool: name }, "rejecting unregistered tool");
    return "";
  }
  let validated: Record<string, unknown>;
  try {
    validated = ctx.registry.validateArgs(name, args);
  } catch (err) {
    logger.warn({ tool: name, err: String(err) }, "rejecting invalid tool arguments");
    return "";
  }
  try {
    const result = ctx.registry.get(name)!.handler(validated, makeToolContext(bot, config, ctx));
    return typeof result === "string" ? result : "";
  } catch (err) {
    logger.warn({ tool: name, err: String(err) }, "tool handler threw");
    return "";
  }
}

/** Act on a validated LLM decision: either reply, or dispatch a registered tool. */
async function executeDecision(bot: Bot, config: MinecraftConfig, ctx: AgentContext, decision: AgentDecision): Promise<void> {
  const d = decision.decision;
  if (d.type === "respond") {
    bot.chat(d.response);
    logger.info({ reply: d.response }, "chat sent");
    return;
  }
  const reply = runTool(bot, config, ctx, d.tool, d.arguments ?? {});
  if (reply) {
    bot.chat(reply);
    logger.info({ reply, tool: d.tool }, "chat sent");
  }
}

const ALWAYS_BANNED_FOOD = ["pufferfish", "poisonous_potato", "spider_eye", "chorus_fruit", "suspicious_stew"];
/** Hunger at or below which rotten flesh becomes acceptable food. */
const EMERGENCY_FOOD_HUNGER = 6;

/**
 * Rotten flesh is normally banned (it causes Hunger), but when the stomach is
 * nearly empty it is strictly better than starving at 1 HP.
 */
export function updateEmergencyFoodPolicy(bot: Bot): void {
  if (bot.autoEat === undefined) return;
  const starving = Number.isFinite(bot.food) && bot.food <= EMERGENCY_FOOD_HUNGER;
  const banned = starving ? ALWAYS_BANNED_FOOD : [...ALWAYS_BANNED_FOOD, "rotten_flesh"];
  if (bot.autoEat.opts.bannedFood.length !== banned.length) bot.autoEat.setOpts({ bannedFood: banned });
  // A full stomach cannot eat: the low-health trigger then starts an eat the
  // server never completes, wedging auto-eat until the watch clears it, every
  // few seconds while health regenerates. Only use it when there is room.
  const minHealth = Number.isFinite(bot.food) && bot.food >= 20 ? 0 : AUTO_EAT_MIN_HEALTH;
  if (bot.autoEat.opts.minHealth !== minHealth) bot.autoEat.setOpts({ minHealth });
}

/** Eat below this health (when there is room to eat), regardless of hunger. */
const AUTO_EAT_MIN_HEALTH = 14;

/** An eat takes ~1.6 s; anything past this is the plugin wedged, not eating. */
const EATING_WEDGE_MS = 8_000;

/**
 * mineflayer-auto-eat 5.0.3 sets `_eating` before awaiting the food equip and
 * never clears it when that equip throws or hangs (1.21 can drop the
 * confirmation). From then on every hunger check sees "already eating" and
 * skips: the bot starved to 1 HP carrying five pieces of raw meat. Clear a
 * wedged flag so the next check eats again.
 */
/** The food equip auto-eat awaits before eating; past this it is stuck behind a tool equip. */
const FOOD_EQUIP_TIMEOUT_MS = 2_000;

/**
 * Close the two holes in auto-eat 5.0.3's `eat()` that leave `_eating` set:
 * the food equip can hang (a dig equipping its tool at the same moment, as
 * at 19:44:06 and 21:06:12), and a failed equip throws without clearing the
 * flag. The equip is bounded and the flag cleared whenever `eat()` throws.
 */
export function hardenAutoEat(bot: Bot): void {
  const autoEat = bot.autoEat as unknown as { _eating: boolean; eat(opts?: object): Promise<void>; __hardened?: boolean } | undefined;
  const inv = (bot as unknown as { util?: { inv?: { customEquip(...args: unknown[]): Promise<boolean> } } }).util?.inv;
  if (autoEat === undefined || typeof autoEat.eat !== "function" || autoEat.__hardened === true) return;
  autoEat.__hardened = true;
  if (inv !== undefined) {
    const equip = inv.customEquip.bind(inv);
    inv.customEquip = (...args: unknown[]) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), FOOD_EQUIP_TIMEOUT_MS); });
      return Promise.race([equip(...args), timeout]).finally(() => clearTimeout(timer));
    };
  }
  const eat = autoEat.eat.bind(autoEat);
  autoEat.eat = async (opts?: object) => {
    // A dig equips its tool over the food mid-eat, so every attempt during a
    // long clear fails and the plugin retries at once: four back-to-back
    // "wedged" resets at 15:37 (2026-10-05). Wait for the dig to end; the
    // next hunger check eats.
    if ((bot as unknown as { targetDigBlock?: unknown }).targetDigBlock != null) return;
    try {
      await eat(opts);
    } catch (err) {
      // "Already eating!" belongs to the eat in progress; any other throw
      // happened after the flag was set and left it set.
      if (!/Already eating/.test(String(err))) autoEat._eating = false;
      throw err;
    }
  };
}

export function watchAutoEat(bot: Bot, logger: Logger, now: () => number = Date.now): () => void {
  hardenAutoEat(bot);
  let eatingSince: number | null = null;
  const timer = setInterval(() => {
    const autoEat = bot.autoEat as unknown as { isEating: boolean; _eating: boolean; cancelEat(): void } | undefined;
    if (autoEat === undefined) return;
    if (!autoEat.isEating) { eatingSince = null; return; }
    eatingSince ??= now();
    if (now() - eatingSince < EATING_WEDGE_MS) return;
    logger.warn({ food: bot.food, health: bot.health, wedgedMs: now() - eatingSince }, "auto-eat wedged; resetting");
    try { autoEat.cancelEat(); } catch { /* nothing bound to cancel */ }
    autoEat._eating = false;
    eatingSince = null;
  }, 1_000);
  timer.unref?.();
  return () => clearInterval(timer);
}

export function registerEvents(bot: Bot, config: MinecraftConfig, logger: Logger, ctx: AgentContext): void {
  bot.once("login", () => {
    const runtime = bot as Bot & { version?: string; _client?: { version?: string; protocolVersion?: number } };
    logger.info({
      username: bot.username,
      serverVersion: runtime.version ?? runtime._client?.version ?? "unknown",
      protocolVersion: runtime._client?.protocolVersion ?? null,
    }, "logged in");
  });

  bot.once("spawn", () => {
    logger.info(readState(bot), "spawned");
    ctx.state.updateSelf(readState(bot));
    // Eating is a reflex, not a task: keep auto-eat on for the whole session
    // so carried food is always used before hunger turns into starvation.
    if (bot.autoEat !== undefined) {
      bot.autoEat.setOpts({ minHunger: 16, minHealth: AUTO_EAT_MIN_HEALTH, returnToLastItem: true });
      bot.autoEat.enableAuto();
      const stopWatch = watchAutoEat(bot, logger);
      bot.once("end", stopWatch);
    }
    updateEmergencyFoodPolicy(bot);
  });

  bot.on("health", () => {
    ctx.state.updateSelf(readState(bot));
    updateEmergencyFoodPolicy(bot);
  });

  // Position otherwise only refreshed on health/spawn events, so the
  // dashboard (and a death-site fallback) showed wherever the bot last took
  // damage. Refresh on movement, at most once a second.
  let lastMoveRefresh = 0;
  bot.on("move", () => {
    const now = Date.now();
    if (now - lastMoveRefresh < 1_000) return;
    lastMoveRefresh = now;
    ctx.state.updateSelf(readState(bot));
  });

  // Recent entity that hurt the bot, newest first. Mineflayer's `death`
  // event carries no attacker, but `entityHurt` names the source entity of
  // every damage tick — that is what a mob-kill loop reads as "killed by X".
  const recentAttackers: Array<{ at: number; name: string; x: number; y: number; z: number }> = [];
  const ATTACKER_WINDOW_MS = 10_000;
  const pruneAttackers = (): void => {
    const cutoff = Date.now() - ATTACKER_WINDOW_MS;
    while (recentAttackers.length > 0 && recentAttackers[0]!.at < cutoff) recentAttackers.shift();
  };
  bot.on("entityHurt", (hurt, source) => {
    if (source === null || source === undefined) return;
    if (hurt.id !== bot.entity?.id) return; // not damage to the bot
    const raw = typeof source.name === "string" ? source.name : "";
    const name = source.type === "player" || raw !== "" ? raw : null;
    if (name === null || name === "") return;
    recentAttackers.push({ at: Date.now(), name, x: source.position.x, y: source.position.y, z: source.position.z });
    pruneAttackers();
  });

  bot.on("death", () => {
    // The player entity still exists during the death animation, so its
    // position is the death site; fall back to the last observed self
    // position when it is already gone. The client inventory cache is still
    // pre-death here (the server drops items as world entities; the empty
    // inventory arrives only with the respawn), so `itemsSummary` is the
    // death-site corpse contents the recovery gate decides on.
    const pos = bot.entity?.position ?? ctx.state.self.position;
    pruneAttackers();
    const killer = recentAttackers.length > 0 ? recentAttackers[0]! : null;
    ctx.bus.emit("death", {
      dimension: bot.game.dimension,
      position: pos ? { x: pos.x, y: pos.y, z: pos.z } : null,
      killer: killer === null ? null : { name: killer.name, x: killer.x, y: killer.y, z: killer.z },
      inventory: itemsSummary(bot),
    });
    recentAttackers.length = 0;
  });

  bot.on("respawn", () => {
    // The respawned body sits at the spawn point; refresh the folded state so
    // the recovery skill never misreads the pre-death position.
    ctx.state.updateSelf(readState(bot));
    ctx.bus.emit("respawn", {});
  });

  // Edge-triggered day/night so the bus is not flooded every time update.
  let dayPhase: "day" | "night" | null = null;
  bot.on("time", () => {
    const phase: "day" | "night" = bot.time.isDay ? "day" : "night";
    if (phase !== dayPhase) {
      dayPhase = phase;
      ctx.state.setTimePhase(phase);
      ctx.bus.emit(phase === "night" ? "time.night" : "time.day", { time: phase });
    }
  });

  bot.on("chat", async (username, message) => {
    logger.info({ from: username, message }, "chat received");
    if (username === bot.username) return;

    const trimmed = message.trim();
    if (HELLO_PATTERN.test(trimmed)) {
      bot.chat("Yep.");
      logger.info({ reply: "Yep." }, "chat sent");
      return;
    }

    const instruction = normalizeInstruction(trimmed);

    // Deterministic hard interrupts (spec 6.2): "stop" never waits on the
    // LLM, and the cancel variants share its path. Movement stops
    // immediately; the active task is cancelled cooperatively at its next
    // checkpoint and never resumes.
    const HARD_INTERRUPT_COMMANDS: ReadonlySet<string> = new Set([
      "stop",
      "cancel",
      "cancel that",
      "cancel that task",
      "forget it",
      "forget that",
      "forget that task",
      "never mind",
      "nevermind",
    ]);
    if (HARD_INTERRUPT_COMMANDS.has(instruction)) {
      ctx.bus.emit("chat.command", { from: username, command: "stop" });
      // The active autonomous goal is cancelled by the same determinist stop:
      // an owner interrupt always ends the goal it was driving.
      ctx.goals?.cancel("stopped by the owner");
      const reply = runTool(bot, config, ctx, "stop", {});
      if (reply) bot.chat(reply);
      return;
    }

    // Only the configured owner's instructions reach the LLM or the
    // deterministic soft/movement matchers (spec 15); bare "stop" stays
    // universal as a safety interrupt.
    if (username !== ctx.owner) return;

    // Phase 8 soft interrupts (spec 6.1): pause the current task, run the
    // movement action at INTERRUPT priority, then the paused task resumes.
    const SOFT_INTERRUPT_COMMANDS: Record<string, { tool: string; needsPlayer: boolean; reply: string }> = {
      "come here": { tool: "come_to_player", needsPlayer: true, reply: "Coming." },
      "follow me": { tool: "follow_player", needsPlayer: true, reply: "Following." },
      "wait here": { tool: "wait_here", needsPlayer: false, reply: "Staying put." },
    };
    const softInterrupt = SOFT_INTERRUPT_COMMANDS[instruction];
    if (softInterrupt !== undefined) {
      ctx.bus.emit("chat.command", { from: username, command: instruction });
      // Mineflayer only exposes a player entity while the server is tracking
      // that player for this client. Without an entity there is no
      // authoritative destination, so do not claim that a movement command
      // has started (or enqueue a task that can only finish immediately).
      if (softInterrupt.needsPlayer && bot.players[username]?.entity === undefined) {
        const reply = "I can't see you from here. Come within view distance, then ask me again.";
        bot.chat(reply);
        logger.info({ reply, player: username }, "movement command refused because player is not visible");
        return;
      }
      ctx.scheduler.enqueue({
        type: "interrupt",
        priority: TaskPriority.INTERRUPT,
        source: "user",
        objective: instruction,
        parameters: { tool: softInterrupt.tool, player: username },
      });
      ctx.scheduler.claim();
      bot.chat(softInterrupt.reply);
      return;
    }

    // "go home" is a direct user-requested foreground task: it preempts
    // background work and pauses another active foreground task only after
    // that task finishes at equal priority.
    if (instruction === "go home") {
      ctx.bus.emit("chat.command", { from: username, command: "go home" });
      ctx.scheduler.enqueue({
        type: "go_home",
        priority: TaskPriority.FOREGROUND,
        source: "user",
        objective: "Go home.",
        parameters: {},
      });
      ctx.scheduler.claim();
      bot.chat("Heading home.");
      return;
    }

    // Camera builds are not part of the bounded architectural vocabulary.
    // Reject them synchronously so an unsupported request never appears to
    // stall while waiting for an LLM tool decision.
    if (/^(?:please )?(?:build|make|construct)(?: me)? (?:a |the )?camera(?: .*)?$/.test(instruction)) {
      bot.chat("I can't build cameras yet. I can build rooms, towers, pyramids, and the supported landmark designs.");
      logger.info({ reply: "unsupported camera build request" }, "chat sent");
      return;
    }

    const directTerrain = parseDeterministicTerrainCommand(instruction);
    if (directTerrain !== null) {
      ctx.bus.emit("chat.command", { from: username, command: instruction });
      if (directTerrain.error) { bot.chat(`I can't start that terrain project: ${directTerrain.error}.`); return; }
      const reply = runTool(bot, config, ctx, directTerrain.tool, directTerrain.args);
      if (reply) bot.chat(reply);
      else bot.chat("I couldn't start that terrain project because its bounds or anchor are not allowed.");
      return;
    }

    if (/^(?:please )?(?:continue|resume|finish|keep)(?: building| working on)?(?: the| my| our| that)? ?(?:house|home|build|building|room|project)?$/.test(instruction)
      && ctx.worldProjects !== undefined) {
      ctx.bus.emit("chat.command", { from: username, command: instruction });
      const resumed = ctx.worldProjects.resumeLatest();
      ctx.scheduler.claim();
      bot.chat(resumed === null ? "There is no unfinished build to continue." : `Continuing the ${resumed.project.structureType.replace(/^simple_/, "")}.`);
      return;
    }

    const food = instruction.match(/^(?:please )?(?:go )?(?:get|gather|find|hunt(?: for)?|collect)(?: me| us)? (?:(\d+) |some |more )?(?:food|meat)(?: please)?$|^(?:please )?go hunt(?:ing)?$/);
    if (food !== null) {
      ctx.bus.emit("chat.command", { from: username, command: instruction });
      const reply = runTool(bot, config, ctx, "gather_food", { quantity: food[1] === undefined ? 16 : Number(food[1]) });
      if (reply) bot.chat(reply);
      return;
    }

    const directGather = parseDeterministicGatherCommand(instruction, () => dominantNearbyLog(bot));
    if (directGather !== null) {
      ctx.bus.emit("chat.command", { from: username, command: instruction });
      const reply = runTool(bot, config, ctx, "collect_resource", directGather);
      if (reply) bot.chat(reply);
      return;
    }

    const directBuild = parseDeterministicBuildCommand(instruction);
    if (directBuild !== null) {
      ctx.bus.emit("chat.command", { from: username, command: instruction });
      if (directBuild.error) {
        bot.chat(`I can't build that: ${directBuild.error}.`);
        return;
      }
      const reply = runTool(bot, config, ctx, directBuild.tool, directBuild.args);
      if (reply) bot.chat(reply);
      else bot.chat("I couldn't start that build because its dimensions, anchor, or material are not allowed.");
      return;
    }

    try {
      const decision = await ctx.decider.decide(
        { from: username, instruction },
        makeToolContext(bot, config, ctx),
      );
      await executeDecision(bot, config, ctx, decision);
    } catch (err) {
      logger.warn({ err: String(err), instruction }, "LLM decision failed");
      bot.chat("I couldn't process that request right now. Please try a supported build command such as castle, tower, house, or room.");
      logger.info({ reply: "LLM decision failure fallback" }, "chat sent");
    }
  });

  bot.on("kicked", (reason) => {
    // String(reason) collapses the server's parsed compound object to
    // "[object Object]" and the cause becomes undiagnosable after the fact.
    // Keep the raw payload for structure and derive a human-readable text.
    logger.warn(
      { reason, reasonText: describeKickReason(reason) },
      "kicked from server",
    );
  });

  bot.on("error", (err) => {
    logger.error({ err }, "bot error");
  });

  bot.on("end", async (reason) => {
    // The end event is the earliest reliable disconnect edge. Interrupt and
    // stop session primitives here as well as in the connection supervisor so
    // a pathfinder/plugin cannot continue while reconnect teardown waits.
    ctx.scheduler.requestPause();
    await stopWorldPrimitives(bot);
    logger.info({ reason }, "disconnected");
  });
}
