import type { Goal } from "../agent/goal.js";
import type { StockpileSnapshot } from "../agent/maintenance.js";
import type { Task } from "../agent/task.js";
import type { LlmCallRecord } from "../llm/decider.js";
import type { Position as DashboardPosition, GoalSummary, InventorySummary, StockpileSummary, TaskSummary, LlmLastCallSummary } from "./types.js";

export interface PositionInput { x: number; y: number; z: number }

export function projectPosition(position: PositionInput | null | undefined): DashboardPosition | null {
  if (position === null || position === undefined) return null;
  return { x: position.x, y: position.y, z: position.z };
}

export function projectTask(task: Task | null | undefined): TaskSummary | null {
  if (task === null || task === undefined) return null;
  return { id: task.id, type: task.type, priority: task.priority, source: task.source, objective: task.objective, status: task.status, createdAt: task.createdAt, startedAt: task.startedAt ?? null, completedAt: task.completedAt ?? null, phase: task.phase ?? null, attempts: task.attempts ?? null, lastError: task.lastError ?? null };
}

export function projectGoal(goal: Goal | null | undefined): GoalSummary | null {
  if (goal === null || goal === undefined) return null;
  return {
    id: goal.id, description: goal.description, source: goal.source, status: goal.status, createdAt: goal.createdAt,
    currentStep: goal.currentStep ?? null,
    successCriteria: goal.successCriteria.map((criterion) => ({ kind: criterion.kind, stockpile: criterion.kind === "stockpile" ? criterion.stockpile : null, item: criterion.kind === "inventory" ? criterion.item : null, min: criterion.min })),
    recentResults: goal.recentResults.map((result) => ({ action: result.action, outcome: result.outcome, message: result.message ?? null, at: result.at })),
    note: goal.note ?? null, endedAt: goal.endedAt ?? null,
  };
}

export function projectInventory(items: Readonly<Record<string, number>> | null | undefined): InventorySummary {
  const projected = Object.keys(items ?? {}).sort().map((name) => ({ name, count: items?.[name] ?? 0 }));
  return { items: projected, totalItems: projected.reduce((total, item) => total + item.count, 0) };
}

export function projectStockpiles(snapshot: StockpileSnapshot | null | undefined): StockpileSummary | null {
  if (snapshot === null || snapshot === undefined) return null;
  return { levels: { ...snapshot.levels }, targets: { ...snapshot.targets }, deficits: snapshot.deficits.map((deficit) => ({ kind: deficit.kind, level: deficit.current, target: deficit.target, deficit: deficit.deficit, crisis: deficit.crisis ?? null })) };
}

export function projectLlmLastCall(call: LlmCallRecord | null | undefined): LlmLastCallSummary {
  if (call === null || call === undefined) return { at: null, latencyMs: null, tool: null, rationale: null };
  return { at: new Date(call.at).toISOString(), latencyMs: call.latencyMs, tool: call.tool, rationale: call.rationale ?? null };
}
