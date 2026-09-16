import type { Logger } from "pino";
import type { Bot } from "mineflayer";
import type { Task } from "./task.js";

export interface HeartbeatInput {
  task: Task | null;
  primitive: string | null;
  leaseOwner: string | null;
  connectionState: string;
  pathfinderState?: string | null;
}

/** Structured, bounded diagnostic record for long-running stalls. */
export function heartbeat(logger: Logger, bot: Bot, input: HeartbeatInput): void {
  const counts: Record<string, number> = {};
  for (const item of bot.inventory?.items?.() ?? []) counts[item.name] = (counts[item.name] ?? 0) + item.count;
  logger.info({
    event: "heartbeat",
    taskId: input.task?.id ?? null,
    workKey: input.task?.workKey ?? null,
    phase: input.task?.phase ?? null,
    primitive: input.primitive,
    progressFingerprint: input.task?.progressFingerprint ?? null,
    progressAgeMs: input.task?.lastProgressAt ? Math.max(0, Date.now() - Date.parse(input.task.lastProgressAt)) : null,
    attemptCount: input.task?.attempts ?? 0,
    leaseOwner: input.leaseOwner,
    connectionState: input.connectionState,
    pathfinderState: input.pathfinderState ?? null,
    openWindow: bot.currentWindow?.constructor?.name ?? null,
    health: bot.health,
    inventorySummary: Object.fromEntries(Object.entries(counts).slice(0, 32)),
  }, "agent heartbeat");
}
