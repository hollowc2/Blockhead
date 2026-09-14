import { fstatSync } from "node:fs";
import type { Bot } from "mineflayer";
import type { MinecraftConfig } from "../config/schema.js";
import type { AgentState } from "../agent/state.js";
import type { Scheduler } from "../agent/scheduler.js";
import { TaskStatus } from "../agent/task.js";
import type { StockpileManager } from "../agent/maintenance.js";
import type { HostileTracker } from "../minecraft/entities.js";
import { itemsSummary } from "../minecraft/inventory.js";
import type { DecisionMaker } from "../llm/decider.js";
import type { LlamaClient } from "../llm/client.js";
import type { EventBus } from "../events/bus.js";
import { computeDangerScore } from "./danger.js";
import { age, fit, meters, round1, titleCase, visibleWidth } from "./format.js";
import {
  actionForTask,
  renderPanels,
  summarizeInventory,
  INVENTORY_LIMIT,
  type DashboardSnapshot,
  type StockpileLine,
} from "./panels.js";

/**
 * Phase 12 development dashboard (spec 33): a live terminal readout of what
 * CobbleBob is doing and why. The app is a passive observer — it subscribes
 * to the bus for the event feed and reads plain state/task/inventory values
 * every tick. It never drives the bot, the scheduler, or the LLM; minecraft
 * chat remains the command interface.
 */

/** Redraw cadence (spec 33: "real time or near real time"). */
const REFRESH_MS = 1_000;
/** How many formatted events are kept in the ring before older ones drop. */
const EVENT_RING_MAX = 40;
/** Panels' line caps before the fit-to-screen budget trims them. */
const EVENT_CAP = 6;

interface EventFeedItem {
  at: number;
  text: string;
}

export interface DashboardSource {
  bus: EventBus;
  state: AgentState;
  scheduler: Scheduler;
  decider: DecisionMaker;
  client: LlamaClient;
  config: MinecraftConfig;
  /** Session-scoped live bot, or null between connect attempts. */
  bot(): Bot | null;
  /** Session-scoped stockpile manager, or null between connect attempts. */
  maintenance(): StockpileManager | null;
  /** Session-scoped hostile sensor, or null between connect attempts. */
  hostile(): HostileTracker | null;
}

/** The phases displayed in stockpile order (spec 33 example order). */
const STOCKPILE_DISPLAY_ORDER: readonly ["wood", "food", "fuel", "torches"] = ["wood", "food", "fuel", "torches"];

const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const ANSI_SGR = /\x1b\[[0-9;]*m/g;

/** True when the dashboard should take the terminal: stdout is a TTY and the config allows it. */
export function shouldEnableTui(config: MinecraftConfig, stdoutIsTty: boolean): boolean {
  if (!stdoutIsTty) return false;
  return config.tui?.enabled ?? true;
}

/**
 * Detect whether stdout is a terminal. Node 20+ moved the console to
 * `node:console` streams and dropped `process.stdout.isatty()`, so probe the
 * fd instead: POSIX terminals are character devices (`S_IFCHR` 0x2000).
 * Returns false for pipes, files, and sockets.
 */
export function detectStdoutIsTty(): boolean {
  try {
    return (fstatSync(1).mode & 0xf000) === 0x2000;
  } catch {
    return false;
  }
}

export class TuiApp {
  private readonly source: DashboardSource;
  private readonly color: boolean;
  private readonly startedAt = Date.now();
  private readonly events: EventFeedItem[] = [];
  private readonly unsubscribers: Array<() => void> = [];
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private expeditionTier: "expedition" | "deep" | null = null;

  constructor(source: DashboardSource) {
    this.source = source;
    this.color = process.env.NO_COLOR === undefined;
  }

  /** Start the dashboard: subscribe, render the first frame, hide the cursor. */
  start(): void {
    if (this.timer !== null) return;
    this.subscribe();
    this.timer = setInterval(() => this.tick(), REFRESH_MS);
    this.timer.unref?.();
    this.draw();
    process.once("exit", () => process.stdout.write("\x1b[?25h"));
  }

  /** Stop the dashboard and restore the terminal (cursor, cleared frame). */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers.length = 0;
    if (this.stopped) return;
    this.stopped = true;
    process.stdout.write("\x1b[?25h\x1b[2J\x1b[H");
  }

  // --- event feed ---

  private subscribe(): void {
    const bus = this.source.bus;
    const push = (text: string): void => {
      this.events.push({ at: Date.now(), text });
      if (this.events.length > EVENT_RING_MAX) this.events.shift();
    };

    this.unsubscribers.push(
      bus.on("chat.command", (p) => push(`Command: ${p.command}`)),
      bus.on("hostile.detected", (p) =>
        push(`${titleCase(p.type)} detected - ${p.distance === null ? "?" : meters(p.distance)}`),
      ),
      bus.on("task.activated", (p) => push(`Task started: ${p.task.objective}`)),
      bus.on("task.completed", (p) => push(`Task complete: ${p.task.objective}`)),
      bus.on("task.failed", (p) => push(`Task failed: ${p.task.objective} (${p.task.lastError ?? "unknown"})`)),
      bus.on("task.cancelled", (p) => push(`Task cancelled: ${p.task.objective}`)),
      bus.on("task.paused", (p) => push(`Task paused: ${p.task.objective}`)),
      bus.on("death", (p) =>
        push(`Died${p.position === null ? "" : ` at ${round1(p.position.x)}, ${round1(p.position.y)}, ${round1(p.position.z)}`}`),
      ),
      bus.on("respawn", () => push("Respawned")),
      bus.on("death.recovery.completed", (p) =>
        push(p.recovered ? `Death recovery complete (${p.durationMs}ms)` : `Death recovery failed: ${p.failureReason ?? "unknown"}`),
      ),
      bus.on("death.loop_detected", (p) =>
        push(
          `DEATH LOOP at ${round1(p.x)}, ${round1(p.y)}, ${round1(p.z)}${p.killer === null ? "" : ` — ${p.killer} camping`} — recovery paused; move CobbleBob or relocate the spawn`,
        ),
      ),
      bus.on("bootstrap.stage", (p) => push(`Bootstrap: ${String(p.stage)} — ${p.note}`)),
      bus.on("bootstrap.complete", () => push("Bootstrap complete")),
      bus.on("bootstrap.failed", (p) => push(`Bootstrap stuck: ${String(p.stage)} — ${p.reason}`)),
      bus.on("resource.gather.started", (p) => push(`Gathering started: ${p.resource} x${p.quantity}`)),
      bus.on("resource.gather.complete", (p) =>
        push(`Gather ${p.status}: ${p.gathered}/${p.quantity} ${p.resource} (${p.delivered} delivered)`),
      ),
      bus.on("resource.gather.failed", (p) => push(`Gather failed: ${p.resource} — ${p.reason}`)),
      bus.on("storage.checked", (p) => {
        if (p.needsWork) push("Storage needs attention: chests full or disorganized");
      }),
      bus.on("director.decided", (p) => push(`Directed: ${p.task}`)),
      bus.on("expedition.entered", (p) => {
        this.expeditionTier = p.tier === "near" ? null : p.tier;
        push(`Expedition ${p.tier}: ${meters(p.distanceFromHome)} from home`);
      }),
      bus.on("expedition.denied", (p) => push(`Expedition refused: ${p.failures[0] ?? "supplies insufficient"}`)),
      bus.on("expedition.left", (p) => {
        this.expeditionTier = null;
        push(`Back within ${meters(p.distanceFromHome)} of home`);
      }),
      bus.on("tool.low_durability", (p) => push(`Tool low: ${titleCase(p.item)}`)),
      bus.on("tool.broken", (p) => push(`Tool broke: ${titleCase(p.item)}`)),
    );
  }

  // --- per-tick snapshot ---

  private snapshot(): DashboardSnapshot {
    const { state, scheduler, decider, client, config } = this.source;
    const bot = this.source.bot();
    const entity = bot?.entity;
    const connected = entity !== null && entity !== undefined;
    const maintenance = this.source.maintenance();
    const hostile = this.source.hostile();
    const lastCall = decider.lastCall;
    const active = scheduler.active;

    const stockpiles: StockpileLine[] | null = maintenance === null
      ? null
      : STOCKPILE_DISPLAY_ORDER.map((kind) => ({
          kind,
          level: maintenance.snapshot?.levels[kind] ?? null,
          target: maintenance.targets[kind],
        }));

    const queuedBackground = scheduler.queued.find(
      (task) =>
        task.status === TaskStatus.QUEUED &&
        (task.source === "background" || task.source === "director"),
    );
    let backgroundActivity: string;
    if (!connected) {
      backgroundActivity = "Disconnected — retrying";
    } else if (
      active !== null &&
      (active.source === "background" || active.source === "maintenance" || active.source === "director")
    ) {
      backgroundActivity = actionForTask(active);
    } else if (maintenance?.isBusy() === true) {
      backgroundActivity = "Measuring stockpiles";
    } else if (queuedBackground !== undefined) {
      backgroundActivity = `Queued: ${actionForTask(queuedBackground)}`;
    } else {
      backgroundActivity = "Standing by";
    }

    return {
      botName: config.agent?.name ?? "CobbleBob",
      connected,
      health: state.self.health,
      hunger: state.self.food,
      position: state.self.position,
      dimension: state.self.dimension,
      timePhase: state.timePhase,
      danger: computeDangerScore({
        health: state.self.health,
        hunger: state.self.food,
        night: state.timePhase === "night",
        nearestHostileMeters: hostile?.nearest()?.distance ?? null,
        expeditionTier: this.expeditionTier,
      }),
      activeTask: active,
      pausedTasks: scheduler.queued.filter((task) => task.status === TaskStatus.PAUSED),
      waitingUserTasks: scheduler.queued.filter(
        (task) => task.status === TaskStatus.QUEUED && task.source === "user",
      ),
      pendingInterrupt: scheduler.pendingInterruptReason,
      backgroundActivity,
      stockpiles,
      inventory: bot === null ? [] : summarizeInventory(itemsSummary(bot)),
      llm: {
        model: client.modelName,
        endpoint: client.endpoint,
        lastCallAgeMs: lastCall === null ? null : Date.now() - lastCall.at,
        latencyMs: lastCall?.latencyMs ?? null,
        tool: lastCall?.tool ?? null,
        rationale: lastCall?.rationale ?? null,
      },
      events: this.events.map((item) => this.stamp(item)),
    };
  }

  /** Prepend the wall-clock HH:MM:SS to an event line. */
  private stamp(item: EventFeedItem): string {
    const date = new Date(item.at);
    const pad = (n: number): string => (n < 10 ? "0" : "") + n;
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}  ${item.text}`;
  }

  // --- render ---

  private tick(): void {
    this.draw();
  }

  private draw(): void {
    const width = process.stdout.columns ?? 80;
    const height = process.stdout.rows ?? 24;
    const snapshot = this.snapshot();

    // Fit budget: first shrink the variable panels (EVENT lines, then
    // INVENTORY lines), then drop whole panels from the bottom (EVENT, LLM,
    // INVENTORY, ...) before anything is cut mid-panel — the required
    // STATE/TASK/BACKGROUND/ACTION/LLM readouts must stay intact.
    let eventMax = EVENT_CAP;
    let inventoryMax = INVENTORY_LIMIT;
    const composed = (): { title: string; lines: string[] }[] =>
      renderPanels(snapshot, { eventMax, inventoryMax }).map((panel) => ({
        title: this.color ? `${BOLD}${panel.title}${RESET}` : panel.title,
        lines: [...panel.lines],
      }));

    const titleLine = this.color ? `${BOLD}${fit(`BLOCKHEAD — ${snapshot.botName}`, width)}${RESET}` : fit(`BLOCKHEAD — ${snapshot.botName}`, width);
    const render = (blocks: { title: string; lines: string[] }[], withStatus: boolean): string[] => {
      const lines: string[] = [titleLine];
      if (withStatus) lines.push(this.statusLine(snapshot, width));
      for (const block of blocks) {
        lines.push(block.title);
        for (const line of block.lines) lines.push(fit(line, width));
      }
      return lines;
    };

    let blocks = composed();
    let lines = render(blocks, true);
    let overflow = lines.length - height;
    while (overflow > 0 && eventMax > 1) {
      eventMax -= 1;
      overflow -= 1;
    }
    while (overflow > 0 && inventoryMax > 3) {
      inventoryMax -= 1;
      overflow -= 1;
    }
    blocks = composed();
    lines = render(blocks, true);
    if (lines.length > height) {
      // The status line is the first casualty; the required panels never are.
      blocks = composed();
      lines = render(blocks, false);
    }
    while (lines.length > height && blocks.length > 0) {
      blocks.pop(); // EVENT, then INVENTORY, then LLM, bottom-up
      lines = render(blocks, false);
    }
    if (lines.length > height) {
      lines = lines.slice(0, height); // truly degenerate terminal
    }

    const frame = ["\x1b[?25l", "\x1b[H", "\x1b[2J", ...lines, "\x1b[0m"].join("\r\n");
    process.stdout.write(frame);
  }

  /** The connection status + uptime line under the title. */
  private statusLine(snapshot: DashboardSnapshot, width: number): string {
    const bullet = snapshot.connected ? "\x1b[32m●\x1b[0m" : "\x1b[31m○\x1b[0m";
    const plain = `${bullet} ${snapshot.connected ? "connected" : "not connected"}    uptime ${age(Date.now() - this.startedAt)}`;
    if (visibleWidth(plain) <= width) return plain;
    // A truncated line loses its styling rather than overflowing the frame.
    return fit(plain.replace(ANSI_SGR, ""), width);
  }
}