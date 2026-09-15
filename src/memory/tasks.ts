import { TaskPriority, TaskStatus, type Task } from "../agent/task.js";
import type { AppDatabase } from "./database.js";

interface TaskRow {
  id: string;
  type: string;
  priority: number;
  source: string;
  objective: string;
  parameters_json: string;
  status: string;
  resume_state_json: string | null;
  parent_task_id: string | null;
  interrupted_task_id: string | null;
  last_error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

const SELECT_TASK = `
  SELECT id, type, priority, source, objective, parameters_json,
         status, resume_state_json, parent_task_id, interrupted_task_id,
         last_error, created_at, started_at, completed_at
  FROM tasks`;

const UNFINISHED = `
  WHERE status NOT IN ('${TaskStatus.COMPLETED}', '${TaskStatus.FAILED}', '${TaskStatus.CANCELLED}')`;

/**
 * Task persistence (spec 21.5). A task row is the source of truth for task
 * state; the scheduler keeps an in-memory mirror that is rehydrated on boot.
 */
export class TasksRepository {
  constructor(private readonly db: AppDatabase) {}

  create(task: Task): void {
    this.db.sql
      .prepare(
        `INSERT INTO tasks
           (id, type, priority, source, objective, parameters_json, status,
            resume_state_json, parent_task_id, interrupted_task_id, last_error,
            created_at, started_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.id,
        task.type,
        task.priority,
        task.source,
        task.objective,
        JSON.stringify(task.parameters ?? {}),
        task.status,
        jsonOrNull(task.resumeState),
        task.parentTaskId ?? null,
        task.interruptedTaskId ?? null,
        task.lastError ?? null,
        task.createdAt,
        task.startedAt ?? null,
        task.completedAt ?? null,
      );
  }

  update(task: Task): void {
    this.db.sql
      .prepare(
        `UPDATE tasks SET
           priority = ?, source = ?, objective = ?, parameters_json = ?,
           status = ?, resume_state_json = ?, parent_task_id = ?,
           interrupted_task_id = ?, last_error = ?, started_at = ?, completed_at = ?
         WHERE id = ?`,
      )
      .run(
        task.priority,
        task.source,
        task.objective,
        JSON.stringify(task.parameters ?? {}),
        task.status,
        jsonOrNull(task.resumeState),
        task.parentTaskId ?? null,
        task.interruptedTaskId ?? null,
        task.lastError ?? null,
        task.startedAt ?? null,
        task.completedAt ?? null,
        task.id,
      );
  }

  get(id: string): Task | null {
    const row = this.db.sql.prepare(`${SELECT_TASK} WHERE id = ?`).get(id) as TaskRow | undefined;
    return row ? toTask(row) : null;
  }

  loadAll(): Task[] {
    const rows = this.db.sql.prepare(`${SELECT_TASK} ORDER BY created_at`).all() as TaskRow[];
    return rows.map(toTask);
  }

  /** Tasks that are still live (queued/active/paused/blocked) — restored on restart. */
  loadUnfinished(): Task[] {
    const rows = this.db.sql
      .prepare(`${SELECT_TASK} ${UNFINISHED} ORDER BY created_at`)
      .all() as TaskRow[];
    return rows.map(toTask);
  }

  /**
   * The most recently settled outcomes (completed/failed/cancelled, plus
   * tasks currently standing down as BLOCKED), newest first. Feeds the LLM
   * context digest of recent high-level results; `limit` bounds the fetch
   * (the caller dedupes identical outcomes).
   */
  recentSettled(limit = 8): Task[] {
    const bounded = Math.max(1, Math.min(limit, 32));
    const rows = this.db.sql
      .prepare(
        `${SELECT_TASK}
         WHERE status IN ('${TaskStatus.COMPLETED}', '${TaskStatus.FAILED}', '${TaskStatus.CANCELLED}', '${TaskStatus.BLOCKED}')
         ORDER BY COALESCE(completed_at, created_at) DESC, rowid DESC
         LIMIT ?`,
      )
      .all(bounded) as TaskRow[];
    return rows.map(toTask);
  }
}

function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    type: row.type,
    priority: row.priority as TaskPriority,
    source: row.source as Task["source"],
    objective: row.objective,
    parameters: JSON.parse(row.parameters_json) as Record<string, unknown>,
    status: row.status as TaskStatus,
    resumeState: row.resume_state_json ? (JSON.parse(row.resume_state_json) as object) : undefined,
    parentTaskId: row.parent_task_id ?? undefined,
    interruptedTaskId: row.interrupted_task_id ?? undefined,
    lastError: row.last_error ?? undefined,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
  };
}

function jsonOrNull(value: object | undefined): string | null {
  return value ? JSON.stringify(value) : null;
}