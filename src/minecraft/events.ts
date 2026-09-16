import type { Bot } from "mineflayer";
import type { Logger } from "pino";
import { readState } from "./bot.js";
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

export function registerEvents(bot: Bot, config: MinecraftConfig, logger: Logger, ctx: AgentContext): void {
  bot.once("login", () => {
    logger.info({ username: bot.username }, "logged in");
  });

  bot.once("spawn", () => {
    logger.info(readState(bot), "spawned");
    ctx.state.updateSelf(readState(bot));
  });

  bot.on("health", () => {
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

    try {
      const decision = await ctx.decider.decide(
        { from: username, instruction },
        makeToolContext(bot, config, ctx),
      );
      await executeDecision(bot, config, ctx, decision);
    } catch (err) {
      logger.warn({ err: String(err), instruction }, "LLM decision failed");
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
    ctx.scheduler.requestCancel();
    await stopWorldPrimitives(bot);
    logger.info({ reason }, "disconnected");
  });
}
