import type { AppDatabase } from "./database.js";

export interface BackgroundFailureState {
  action: string;
  failedAt: number;
  retryAt: number;
  reason: string;
}

interface BackgroundFailureRow {
  action: string;
  failed_at: number;
  retry_at: number;
  reason: string;
}

/** Durable cooldown state for deterministic background restore retries. */
export class BackgroundFailuresRepository {
  constructor(private readonly db: AppDatabase) {}

  loadAll(): BackgroundFailureState[] {
    const rows = this.db.sql
      .prepare("SELECT action, failed_at, retry_at, reason FROM background_failures")
      .all() as BackgroundFailureRow[];
    return rows.map((row) => ({
      action: row.action,
      failedAt: row.failed_at,
      retryAt: row.retry_at,
      reason: row.reason,
    }));
  }

  upsert(state: BackgroundFailureState): void {
    this.db.sql
      .prepare(
        `INSERT INTO background_failures (action, failed_at, retry_at, reason)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(action) DO UPDATE SET
           failed_at = excluded.failed_at,
           retry_at = excluded.retry_at,
           reason = excluded.reason`,
      )
      .run(state.action, state.failedAt, state.retryAt, state.reason);
  }

  remove(action: string): void {
    this.db.sql.prepare("DELETE FROM background_failures WHERE action = ?").run(action);
  }
}
