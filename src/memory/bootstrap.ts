import { BootstrapStage } from "../agent/bootstrap.js";
import type { AppDatabase } from "./database.js";

interface BootstrapStateRow {
  world_id: number;
  stage: string;
  attempts: number;
  last_failure_code: string | null;
  retry_at: number | null;
}

export interface BootstrapState {
  stage: BootstrapStage | null;
  attempts: number;
  failureCode: string | null;
  retryAt: number | null;
}

/**
 * Persisted bootstrap progress (spec 7.2: "Bootstrap should be resumable
 * after restart"). One row per world holding the last completed stage; the
 * runner resumes from the next stage in `BOOTSTRAP_STAGE_ORDER`.
 */
export class BootstrapRepository {
  constructor(private readonly db: AppDatabase) {}

  /** Last completed stage for a world, or null before bootstrap starts. */
  get(worldId: number): BootstrapStage | null {
    const row = this.db.sql
      .prepare("SELECT world_id, stage FROM bootstrap_state WHERE world_id = ?")
      .get(worldId) as BootstrapStateRow | undefined;
    return row ? stageFromString(row.stage) : null;
  }

  getState(worldId: number): BootstrapState {
    const row = this.db.sql.prepare("SELECT stage, attempts, last_failure_code, retry_at FROM bootstrap_state WHERE world_id = ?").get(worldId) as BootstrapStateRow | undefined;
    if (row === undefined) return { stage: null, attempts: 0, failureCode: null, retryAt: null };
    return { stage: stageFromString(row.stage), attempts: row.attempts ?? 0, failureCode: row.last_failure_code, retryAt: row.retry_at };
  }

  /** Persist the last completed stage (idempotent). */
  save(worldId: number, stage: BootstrapStage): void {
    this.db.sql
      .prepare(
        `INSERT INTO bootstrap_state (world_id, stage, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(world_id) DO UPDATE SET stage = excluded.stage, updated_at = excluded.updated_at, attempts = 0, last_failure_code = NULL, retry_at = NULL`,
      )
      .run(worldId, stage, new Date().toISOString());
  }

  recordFailure(worldId: number, code: string, retryAt: number): void {
    const current = this.getState(worldId);
    this.db.sql.prepare(`
      INSERT INTO bootstrap_state (world_id, stage, updated_at, attempts, last_failure_code, retry_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(world_id) DO UPDATE SET attempts = excluded.attempts,
        last_failure_code = excluded.last_failure_code, retry_at = excluded.retry_at, updated_at = excluded.updated_at
    `).run(worldId, current.stage ?? "home", new Date().toISOString(), current.attempts + 1, code, retryAt);
  }
}

function stageFromString(value: string): BootstrapStage | null {
  const stage = String(value).trim();
  for (const candidate of Object.values(BootstrapStage)) {
    if (candidate === stage) return candidate;
  }
  return null;
}
