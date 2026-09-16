import type { GoalStatus, GoalSource, SuccessCriterion } from "../agent/goal.js";
import type { StockpileKind } from "../agent/maintenance.js";
import type { TaskPriority, TaskSource, TaskStatus } from "../agent/task.js";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface BotConnectionInfo { connected: boolean; player: string | null; server: string | null }
export interface Position { x: number; y: number; z: number }
export interface SelfSummary { health: number | null; hunger: number | null; position: Position | null; dimension: string | null; timePhase: "day" | "night" | null }
export interface GoalCriterionSummary { kind: SuccessCriterion["kind"]; stockpile: StockpileKind | null; item: string | null; min: number }
export interface GoalResultSummary { action: string; outcome: string; message: string | null; at: string }
export interface GoalSummary { id: string; description: string; source: GoalSource; status: GoalStatus; createdAt: string; currentStep: string | null; successCriteria: readonly GoalCriterionSummary[]; recentResults: readonly GoalResultSummary[]; note: string | null; endedAt: string | null }
export interface TaskSummary { id: string; type: string; priority: TaskPriority; source: TaskSource; objective: string; status: TaskStatus; createdAt: string; startedAt: string | null; completedAt: string | null; phase: string | null; attempts: number | null; lastError: string | null }
export interface ActionLabel { label: string; taskId: string | null }
export interface BackgroundActivity { label: string; taskId: string | null }
export interface StockpileLine { kind: StockpileKind; level: number | null; target: number | null; deficit: number | null; crisis: boolean | null }
export interface StockpileSummary { levels: Record<StockpileKind, number>; targets: Record<StockpileKind, number>; deficits: readonly StockpileLine[] }
export interface InventoryItemSummary { name: string; count: number }
export interface InventorySummary { items: readonly InventoryItemSummary[]; totalItems: number }
export interface LlmLastCallSummary { at: string | null; latencyMs: number | null; tool: string | null; rationale: string | null }
export interface PathSummary { status: string; destination: Position | null; distance: number | null }
export interface RecentEvent { at: string; kind: string; message: string }
export interface RecentFailure { at: string; kind: string; message: string }
export interface RecentChatEntry { at: string; sender: string; message: string }
export interface DangerSummary { score: number; nearestHostile: { type: string; distance: number } | null; hostileCount: number }

export interface DashboardSnapshot {
  schema: 1;
  process: { startedAt: string; uptimeSeconds: number };
  connection: BotConnectionInfo;
  self: SelfSummary;
  goal: GoalSummary | null;
  task: TaskSummary | null;
  action: ActionLabel;
  background: BackgroundActivity;
  stockpiles: StockpileSummary | null;
  inventory: InventorySummary | null;
  danger: DangerSummary | null;
  llmLastCall: LlmLastCallSummary;
  path: PathSummary | null;
  recentEvents: readonly RecentEvent[];
  recentFailures: readonly RecentFailure[];
  recentChat: readonly RecentChatEntry[];
}
