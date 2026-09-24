import { BootstrapStage } from "../agent/bootstrap.js";
import type { AppDatabase } from "./database.js";

interface BootstrapStateRow {
  world_id: number;
  stage: string;
  attempts: number;
  last_failure_code: string | null;
  retry_at: number | null;
  status: string;
  progress_json: string;
}

export interface BootstrapState {
  stage: BootstrapStage | null;
  attempts: number;
  failureCode: string | null;
  retryAt: number | null;
  status: "active" | "blocked" | "complete";
  progress: Record<string, unknown>;
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
    const row = this.db.sql.prepare("SELECT stage, attempts, last_failure_code, retry_at, status, progress_json FROM bootstrap_state WHERE world_id = ?").get(worldId) as BootstrapStateRow | undefined;
    if (row === undefined) return { stage: null, attempts: 0, failureCode: null, retryAt: null, status: "active", progress: {} };
    let progress: Record<string, unknown> = {};
    try { progress = JSON.parse(row.progress_json ?? "{}") as Record<string, unknown>; } catch { /* recover with empty progress */ }
    const status = row.status === "blocked" || row.status === "complete" ? row.status : "active";
    return { stage: stageFromString(row.stage), attempts: row.attempts ?? 0, failureCode: row.last_failure_code, retryAt: row.retry_at, status, progress };
  }

  /** Persist the last completed stage (idempotent). */
  save(worldId: number, stage: BootstrapStage): void {
    this.db.sql
      .prepare(
        `INSERT INTO bootstrap_state (world_id, stage, updated_at, status, progress_json) VALUES (?, ?, ?, ?, '{}')
        ON CONFLICT(world_id) DO UPDATE SET stage = excluded.stage, updated_at = excluded.updated_at, status = excluded.status, attempts = 0, last_failure_code = NULL, retry_at = NULL, progress_json = '{}'`,
      )
      .run(worldId, stage, new Date().toISOString(), stage === BootstrapStage.NORMAL_OPERATION ? "complete" : "active");
  }

  saveProgress(worldId: number, progress: Record<string, unknown>): void {
    const current = this.getState(worldId);
    this.db.sql.prepare(`
      INSERT INTO bootstrap_state (world_id, stage, updated_at, status, progress_json)
      VALUES (?, ?, ?, 'active', ?)
      ON CONFLICT(world_id) DO UPDATE SET progress_json = excluded.progress_json,
        status = 'active', updated_at = excluded.updated_at
    `).run(worldId, current.stage ?? "home", new Date().toISOString(), JSON.stringify(progress));
  }

  recordFailure(worldId: number, code: string, retryAt: number, increment = 1): void {
    const current = this.getState(worldId);
    this.db.sql.prepare(`
      INSERT INTO bootstrap_state (world_id, stage, updated_at, attempts, last_failure_code, retry_at, status, progress_json)
      VALUES (?, ?, ?, ?, ?, ?, 'active', '{}')
      ON CONFLICT(world_id) DO UPDATE SET attempts = excluded.attempts,
        last_failure_code = excluded.last_failure_code, retry_at = excluded.retry_at,
        status = 'active', progress_json = '{}', updated_at = excluded.updated_at
    `).run(worldId, current.stage ?? "home", new Date().toISOString(), current.attempts + increment, code, retryAt);
  }

  /** Terminal marker; retains the last completed stage as the resume point. */
  markBlocked(worldId: number, code: string): void {
    this.db.sql.prepare("UPDATE bootstrap_state SET status = 'blocked', last_failure_code = ?, retry_at = NULL, updated_at = ? WHERE world_id = ?")
      .run(code, new Date().toISOString(), worldId);
  }
}

function stageFromString(value: string): BootstrapStage | null {
  const stage = String(value).trim();
  for (const candidate of Object.values(BootstrapStage)) {
    if (candidate === stage) return candidate;
  }
  return null;
}
