/**
 * Task model (spec section 5). Pure types — no runtime dependencies — so the
 * scheduler, persistence layer, and event payloads can share it.
 */

export enum TaskStatus {
  QUEUED = "queued",
  ACTIVE = "active",
  PAUSED = "paused",
  BLOCKED = "blocked",
  COMPLETED = "completed",
  FAILED = "failed",
  CANCELLED = "cancelled",
}

export enum TaskPriority {
  EMERGENCY = 100,
  INTERRUPT = 90,
  MAINTENANCE = 80,
  FOREGROUND = 70,
  BACKGROUND = 40,
  OPTIONAL = 20,
}

export type TaskSource = "user" | "system" | "maintenance" | "background" | "director" | "goal";

export interface Task {
  id: string;
  type: string;
  priority: TaskPriority;
  source: TaskSource;
  objective: string;
  parameters: Record<string, unknown>;
  status: TaskStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  parentTaskId?: string;
  interruptedTaskId?: string;
  resumeState?: object;
  lastError?: string;
}

/** Task inputs before the system assigns identity and lifecycle fields. */
export type NewTask = Omit<Task, "id" | "status" | "createdAt">;

/** Statuses that mean the task is still live and should survive a restart. */
export const UNFINISHED_STATUSES: readonly TaskStatus[] = [
  TaskStatus.QUEUED,
  TaskStatus.ACTIVE,
  TaskStatus.PAUSED,
  TaskStatus.BLOCKED,
];