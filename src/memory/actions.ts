import type { AppDatabase } from "./database.js";

export interface ActionState {
  action: string;
  failures: number;
  blockedAt: number | null;
  retryAt: number | null;
  lastReason: string | null;
  updatedAt: number;
}

interface ActionStateRow {
  action: string;
  failures: number;
  blocked_at: number | null;
  retry_at: number | null;
  last_reason: string | null;
  updated_at: number;
}

export class ActionsRepository {
  constructor(private readonly db: AppDatabase) {}

  loadAll(): ActionState[] {
    const rows = this.db.sql
      .prepare("SELECT action, failures, blocked_at, retry_at, last_reason, updated_at FROM action_states")
      .all() as ActionStateRow[];
    return rows.map(toActionState);
  }

  upsert(state: Omit<ActionState, "updatedAt">): void {
    this.db.sql
      .prepare(
        `INSERT INTO action_states (action, failures, blocked_at, retry_at, last_reason, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(action) DO UPDATE SET
           failures = excluded.failures,
           blocked_at = excluded.blocked_at,
           retry_at = excluded.retry_at,
           last_reason = excluded.last_reason,
           updated_at = excluded.updated_at`,
      )
      .run(state.action, state.failures, state.blockedAt, state.retryAt, state.lastReason, Date.now());
  }

  remove(action: string): void {
    this.db.sql.prepare("DELETE FROM action_states WHERE action = ?").run(action);
  }
}

function toActionState(row: ActionStateRow): ActionState {
  return {
    action: row.action,
    failures: row.failures,
    blockedAt: row.blocked_at,
    retryAt: row.retry_at,
    lastReason: row.last_reason,
    updatedAt: row.updated_at,
  };
}
