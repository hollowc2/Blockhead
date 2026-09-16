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
  pause_sequence: number | null;
  work_key: string | null;
  phase: string | null;
  progress_fingerprint: string | null;
  last_progress_at: string | null;
  attempts: number | null;
}

const SELECT_TASK = `
  SELECT id, type, priority, source, objective, parameters_json,
         status, resume_state_json, parent_task_id, interrupted_task_id,
         last_error, created_at, started_at, completed_at, pause_sequence,
         work_key, phase, progress_fingerprint, last_progress_at, attempts
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
            created_at, started_at, completed_at, pause_sequence,
            work_key, phase, progress_fingerprint, last_progress_at, attempts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        task.pauseSequence ?? null,
        task.workKey ?? null,
        task.phase ?? null,
        task.progressFingerprint ?? null,
        task.lastProgressAt ?? null,
        task.attempts ?? 0,
      );
  }

  update(task: Task): void {
    this.db.sql
      .prepare(
        `UPDATE tasks SET
           priority = ?, source = ?, objective = ?, parameters_json = ?,
           status = ?, resume_state_json = ?, parent_task_id = ?,
           interrupted_task_id = ?, last_error = ?, started_at = ?, completed_at = ?, pause_sequence = ?,
           work_key = ?, phase = ?, progress_fingerprint = ?, last_progress_at = ?, attempts = ?
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
        task.pauseSequence ?? null,
        task.workKey ?? null,
        task.phase ?? null,
        task.progressFingerprint ?? null,
        task.lastProgressAt ?? null,
        task.attempts ?? 0,
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
    return rows.flatMap((row) => {
      try {
        // Validate persisted JSON before the scheduler sees a row. A malformed
        // live task is terminally quarantined, never allowed to crash startup.
        JSON.parse(row.parameters_json);
        if (row.resume_state_json !== null) JSON.parse(row.resume_state_json);
        return [toTask(row)];
      } catch (error) {
        this.db.sql.prepare("UPDATE tasks SET status = ?, last_error = ?, completed_at = ? WHERE id = ?")
          .run(TaskStatus.FAILED, `quarantined malformed task: ${String(error)}`, new Date().toISOString(), row.id);
        this.quarantine(row.id, "parameters_json/resume_state_json", error, "mark failed and exclude from execution");
        return [];
      }
    });
  }

  findLiveByWorkKey(workKey: string): Task | null {
    const row = this.db.sql.prepare(`${SELECT_TASK} WHERE work_key = ? AND status NOT IN ('completed','failed','cancelled') LIMIT 1`).get(workKey) as TaskRow | undefined;
    return row ? toTask(row) : null;
  }

  /**
   * The most recently settled outcomes (completed/failed/cancelled, plus
   * tasks currently standing down as BLOCKED), newest first. Feeds the LLM
   * context digest of recent high-level results; `limit` bounds the fetch
   * (the caller dedupes identical outcomes).
   */
  /** Remove old terminal rows while retaining a bounded recent outcome window. */
  pruneSettled(olderThan: string, keepRecent = 32): number {
    const result = this.db.sql.prepare(`
      DELETE FROM tasks
      WHERE status IN ('${TaskStatus.COMPLETED}', '${TaskStatus.FAILED}', '${TaskStatus.BLOCKED}', '${TaskStatus.CANCELLED}')
        AND COALESCE(completed_at, created_at) < ?
        AND id NOT IN (
          SELECT id FROM tasks
          WHERE status IN ('${TaskStatus.COMPLETED}', '${TaskStatus.FAILED}', '${TaskStatus.BLOCKED}', '${TaskStatus.CANCELLED}')
          ORDER BY COALESCE(completed_at, created_at) DESC, rowid DESC
          LIMIT ?
        )`).run(olderThan, Math.max(0, keepRecent));
    return result.changes;
  }

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

  private quarantine(rowId: string, field: string, error: unknown, recoveryAction: string): void {
    this.db.sql.prepare(`INSERT INTO quarantine_diagnostics
      (table_name, row_id, field, error, recovery_action, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run("tasks", rowId, field, String(error), recoveryAction, new Date().toISOString());
  }
}

function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    type: row.type,
    priority: row.priority as TaskPriority,
    source: row.source as Task["source"],
    objective: row.objective,
    parameters: parseJson(row.parameters_json, {}),
    status: row.status as TaskStatus,
    resumeState: row.resume_state_json ? parseJson(row.resume_state_json, {}) : undefined,
    parentTaskId: row.parent_task_id ?? undefined,
    interruptedTaskId: row.interrupted_task_id ?? undefined,
    lastError: row.last_error ?? undefined,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    pauseSequence: row.pause_sequence ?? undefined,
    workKey: row.work_key ?? undefined,
    phase: row.phase ?? undefined,
    progressFingerprint: row.progress_fingerprint ?? undefined,
    lastProgressAt: row.last_progress_at ?? undefined,
    attempts: row.attempts ?? 0,
  };
}

function parseJson<T>(raw: string, fallback: T): T {
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

function jsonOrNull(value: object | undefined): string | null {
  return value ? JSON.stringify(value) : null;
}
