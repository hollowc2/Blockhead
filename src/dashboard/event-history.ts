import type { EventBus } from "../events/bus.js";
import type { EventName, EventPayload } from "../events/types.js";

export interface DashboardEvent {
  at: string;
  category: string;
  severity: "info" | "success" | "warning" | "error";
  message: string;
}

export interface EventHistoryOptions {
  bus: EventBus;
  maxEntries?: number;
  maxRecentFailures?: number;
  maxRecentChat?: number;
  now?: () => number;
  /** Maximum size of a rendered event message. */
  maxMessageLength?: number;
}

const DEFAULT_MAX_ENTRIES = 75;
const DEFAULT_MAX_MESSAGE_LENGTH = 320;

type Severity = DashboardEvent["severity"];

function text(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed === "" ? fallback : trimmed;
}

function count(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "?";
}

/**
 * Session-only event history for dashboard consumers. The collector stores
 * rendered strings, never event payloads, so task/goal and Minecraft objects
 * cannot be retained accidentally.
 */
export class EventHistory {
  private readonly now: () => number;
  private readonly maxEntries: number;
  private readonly maxRecentFailures: number;
  private readonly maxRecentChat: number;
  private readonly maxMessageLength: number;
  private readonly entries: DashboardEvent[] = [];
  private readonly failures: DashboardEvent[] = [];
  private readonly chat: DashboardEvent[] = [];
  private readonly unsubscribers: Array<() => void> = [];
  private disposed = false;

  constructor(options: EventHistoryOptions) {
    this.now = options.now ?? Date.now;
    this.maxEntries = boundedSize(options.maxEntries, DEFAULT_MAX_ENTRIES);
    this.maxRecentFailures = boundedSize(options.maxRecentFailures, this.maxEntries);
    this.maxRecentChat = boundedSize(options.maxRecentChat, this.maxEntries);
    this.maxMessageLength = boundedSize(options.maxMessageLength, DEFAULT_MAX_MESSAGE_LENGTH);

    const on = <K extends EventName>(name: K, handler: (payload: EventPayload<K>) => void): void => {
      this.unsubscribers.push(options.bus.on(name, handler));
    };

    on("chat.command", (p) => this.record("chat", "info", `Command from ${text(p.from, "unknown")}: ${text(p.command, "(empty)")}`, false, true));
    on("task.activated", (p) => this.task(p, "activated", "info"));
    on("task.paused", (p) => this.task(p, "paused", "warning"));
    on("task.completed", (p) => this.task(p, "completed", "success"));
    on("task.failed", (p) => this.task(p, "failed", "error", true));
    on("task.blocked", (p) => this.task(p, "blocked", "warning", true));
    on("task.cancelled", (p) => this.task(p, "cancelled", "warning", true));
    on("goal.started", (p) => this.goal(p, "started", "info"));
    on("goal.completed", (p) => this.goal(p, "completed", "success"));
    on("goal.blocked", (p) => this.goal(p, "blocked", "warning", true));
    on("goal.cancelled", (p) => this.goal(p, "cancelled", "warning", true));
    on("bootstrap.stage", (p) => this.record("bootstrap", "info", `Bootstrap stage ${text((p as { stage?: unknown }).stage, "unknown")}: ${text((p as { note?: unknown }).note, "no note")}`));
    on("bootstrap.complete", () => this.record("bootstrap", "success", "Bootstrap complete"));
    on("bootstrap.failed", (p) => this.record("bootstrap", "error", `Bootstrap failed at ${text((p as { stage?: unknown }).stage, "unknown")}: ${text((p as { reason?: unknown }).reason, "unknown reason")}`, true));
    on("resource.gather.started", (p) => this.record("resource", "info", `Gathering ${text((p as { resource?: unknown }).resource, "resource")} x${count((p as { quantity?: unknown }).quantity)}`));
    on("resource.gather.complete", (p) => this.resourceComplete(p));
    on("resource.gather.failed", (p) => this.record("resource", "error", `Gather failed: ${text((p as { resource?: unknown }).resource, "resource")} — ${text((p as { reason?: unknown }).reason, "unknown reason")}`, true));
    on("expedition.entered", (p) => this.record("expedition", "info", `Expedition entered (${text((p as { tier?: unknown }).tier, "unknown")}, ${count((p as { distanceFromHome?: unknown }).distanceFromHome)}m)`));
    on("expedition.denied", (p) => this.record("expedition", "warning", `Expedition denied: ${firstFailure(p)}`, true));
    on("expedition.left", (p) => this.record("expedition", "info", `Expedition left (${count((p as { distanceFromHome?: unknown }).distanceFromHome)}m from home)`));
    on("death", (p) => this.record("death", "error", `Death${positionSuffix(p)}${inventorySuffix(p)}`, true));
    on("respawn", () => this.record("death", "success", "Respawned"));
    on("death.recorded", (p) => this.record("death", p.worthRecovering ? "warning" : "info", p.worthRecovering ? "Death recorded; recovery needed" : "Death recorded; recovery skipped"));
    on("death.recovery.completed", (p) => {
      const value = p as { recovered?: unknown; failureReason?: unknown };
      this.record("death", value.recovered === true ? "success" : "error", value.recovered === true ? "Death recovery complete" : `Death recovery failed: ${text(value.failureReason, "unknown reason")}`, value.recovered !== true);
    });
    on("hostile.detected", (p) => this.record("hostile", "warning", `${text((p as { type?: unknown }).type, "Hostile")} detected`));
    on("tool.low_durability", (p) => this.record("tool", "warning", `Tool low: ${text((p as { item?: unknown }).item, "unknown tool")}`));
    on("tool.broken", (p) => this.record("tool", "error", `Tool broke: ${text((p as { item?: unknown }).item, "unknown tool")}`, true));
    on("director.decided", (p) => this.record("director", "info", `Director chose ${text((p as { task?: unknown }).task, "unknown task")}${rationaleSuffix(p)}`));
  }

  events(): readonly DashboardEvent[] { return this.entries.slice(); }
  recentEvents(): readonly DashboardEvent[] { return this.events(); }
  recentFailures(): readonly DashboardEvent[] { return this.failures.slice(); }
  recentChat(): readonly DashboardEvent[] { return this.chat.slice(); }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers.length = 0;
  }

  cleanup(): void { this.dispose(); }

  private task(payload: unknown, state: string, severity: Severity, failure = false): void {
    const task = (payload as { task?: { objective?: unknown; lastError?: unknown } } | undefined)?.task;
    const objective = text(task?.objective, "unnamed task");
    const error = state === "failed" ? ` — ${text(task?.lastError, "unknown reason")}` : "";
    this.record("task", severity, `Task ${state}: ${objective}${error}`, failure);
  }

  private goal(payload: unknown, state: string, severity: Severity, failure = false): void {
    const goal = (payload as { goal?: { description?: unknown; note?: unknown } } | undefined)?.goal;
    const description = text(goal?.description, "unnamed goal");
    const note = state === "blocked" ? ` — ${text(goal?.note, "no progress")}` : "";
    this.record("goal", severity, `Goal ${state}: ${description}${note}`, failure);
  }

  private resourceComplete(payload: unknown): void {
    const value = payload as { resource?: unknown; quantity?: unknown; gathered?: unknown; delivered?: unknown; status?: unknown };
    const status = text(value.status, "complete");
    const severity: Severity = status === "completed" ? "success" : status === "failed" ? "error" : "warning";
    this.record("resource", severity, `Gather ${status}: ${count(value.gathered)}/${count(value.quantity)} ${text(value.resource, "resource")} (${count(value.delivered)} delivered)`, status === "failed" || status === "blocked");
  }

  private record(category: string, severity: Severity, message: string, failure = false, chat = false): void {
    const event = { at: new Date(this.now()).toISOString(), category, severity, message: truncate(message, this.maxMessageLength) } satisfies DashboardEvent;
    pushBounded(this.entries, event, this.maxEntries);
    if (failure) pushBounded(this.failures, event, this.maxRecentFailures);
    if (chat) pushBounded(this.chat, event, this.maxRecentChat);
  }
}

function boundedSize(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value !== undefined && value > 0 ? value : fallback;
}

function pushBounded<T>(list: T[], value: T, max: number): void {
  list.push(value);
  if (list.length > max) list.splice(0, list.length - max);
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

function firstFailure(payload: unknown): string {
  const failures = (payload as { failures?: unknown })?.failures;
  return Array.isArray(failures) ? text(failures[0], "supplies insufficient") : "supplies insufficient";
}

function positionSuffix(payload: unknown): string {
  const position = (payload as { position?: { x?: unknown; y?: unknown; z?: unknown } | null })?.position;
  return position ? ` at ${count(position.x)}, ${count(position.y)}, ${count(position.z)}` : "";
}

function inventorySuffix(payload: unknown): string {
  const inventory = (payload as { inventory?: unknown })?.inventory;
  if (!inventory || typeof inventory !== "object") return "";
  const total = Object.values(inventory as Record<string, unknown>).reduce(
    (sum, value) => sum + (typeof value === "number" && Number.isFinite(value) ? value : 0),
    0,
  );
  return total === 0 ? " (carrying nothing)" : ` (carrying ${total} item${total === 1 ? "" : "s"})`;
}

function rationaleSuffix(payload: unknown): string {
  const rationale = text((payload as { rationale?: unknown })?.rationale, "");
  return rationale === "" ? "" : ` — ${rationale}`;
}
