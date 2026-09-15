import type { Task } from "../agent/task.js";
import type { Goal } from "../agent/goal.js";
import type { SelfState } from "../agent/state.js";
import type { BlockView } from "../agent/watchdog.js";
import type { LlmCallRecord } from "../llm/decider.js";
import type { TaskOutcome } from "./outcomes.js";

export interface StatusSnapshot {
  schema: 1;
  process: { startedAt: string; uptimeSeconds: number };
  minecraft: { connected: boolean; player: string | null; health: number; hunger: number; position: SelfState["position"]; dimension: string | null; timePhase: "day" | "night" | null };
  task: { active: TaskSummary | null; queued: TaskSummary[]; interrupt: { pending: boolean; reason: "pause" | "cancel" | null }; blockedActions: readonly BlockView[] };
  goal: Goal | null;
  llm: { endpoint: string; model: string; state: "unknown" | "ok" | "failing"; reachable: boolean | null; lastSuccessAt: string | null; lastSuccessAgeSeconds: number | null; consecutiveFailures: number; lastFailure: { at: string; kind: string; error: string } | null; lastDecision: { at: string; latencyMs: number; tool: string; rationale: string | null } | null };
  autonomy: { paused: boolean; reasons: string[] };
  lastTaskResult: TaskOutcome | null;
  consecutiveTaskFailures: number;
  recentTaskResults: readonly TaskOutcome[];
}

export interface TaskSummary {
  id: string; type: string; source: Task["source"]; priority: number; objective: string; status: Task["status"]; startedAt: string | null; lastError: string | null;
}

export interface StatusInput {
  startedAtMs: number;
  nowMs?: () => number;
  player: string | null;
  connected: boolean;
  state: { self: SelfState; timePhase: "day" | "night" | null };
  scheduler: { active: Task | null; queued: readonly Task[]; interruptPending: boolean; pendingInterruptReason: "pause" | "cancel" | null; blockedActions(): readonly BlockView[] };
  goal: Goal | null;
  decider: { lastCall: LlmCallRecord | null };
  client: { endpoint: string; modelName: string; healthState: "unknown" | "ok" | "failing"; reachable: boolean | null; lastSuccessAt: number | null; consecutiveFailures: number; lastFailure: { at: number; kind: string; error: string } | null };
  inDeathLoop: boolean;
  outcomes: { last: TaskOutcome | null; consecutiveFailures: number; recent(): readonly TaskOutcome[] };
}

function taskSummary(task: Task): TaskSummary {
  return { id: task.id, type: task.type, source: task.source, priority: task.priority, objective: task.objective, status: task.status, startedAt: task.startedAt ?? null, lastError: task.lastError ?? null };
}

export function deriveAutonomy(input: Pick<StatusInput, "connected" | "scheduler" | "inDeathLoop">): { paused: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!input.connected) reasons.push("disconnected");
  if (input.scheduler.interruptPending && input.scheduler.pendingInterruptReason !== null) reasons.push(`interrupt:${input.scheduler.pendingInterruptReason}`);
  if (input.scheduler.active?.source === "user") reasons.push("user-task-active");
  if (input.scheduler.queued.some((task) => task.source === "user" && task.priority >= 70)) reasons.push("user-work-pending");
  if (input.inDeathLoop) reasons.push("death-loop-brake");
  return { paused: reasons.length > 0, reasons };
}

export function buildStatusSnapshot(input: StatusInput): StatusSnapshot {
  const now = (input.nowMs ?? Date.now)();
  const lastSuccessAt = input.client.lastSuccessAt;
  const lastDecision = input.decider.lastCall;
  return {
    schema: 1,
    process: { startedAt: new Date(input.startedAtMs).toISOString(), uptimeSeconds: Math.max(0, (now - input.startedAtMs) / 1000) },
    minecraft: { connected: input.connected, player: input.player, health: input.state.self.health, hunger: input.state.self.food, position: input.state.self.position, dimension: input.state.self.dimension, timePhase: input.state.timePhase },
    task: { active: input.scheduler.active === null ? null : taskSummary(input.scheduler.active), queued: input.scheduler.queued.map(taskSummary), interrupt: { pending: input.scheduler.interruptPending, reason: input.scheduler.pendingInterruptReason }, blockedActions: input.scheduler.blockedActions() },
    goal: input.goal,
    llm: { endpoint: input.client.endpoint, model: input.client.modelName, state: input.client.healthState, reachable: input.client.reachable, lastSuccessAt: lastSuccessAt === null ? null : new Date(lastSuccessAt).toISOString(), lastSuccessAgeSeconds: lastSuccessAt === null ? null : Math.max(0, (now - lastSuccessAt) / 1000), consecutiveFailures: input.client.consecutiveFailures, lastFailure: input.client.lastFailure === null ? null : { ...input.client.lastFailure, at: new Date(input.client.lastFailure.at).toISOString() }, lastDecision: lastDecision === null ? null : { ...lastDecision, at: new Date(lastDecision.at).toISOString() } },
    autonomy: deriveAutonomy(input),
    lastTaskResult: input.outcomes.last,
    consecutiveTaskFailures: input.outcomes.consecutiveFailures,
    recentTaskResults: input.outcomes.recent(),
  };
}
