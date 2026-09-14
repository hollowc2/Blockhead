import { BootstrapStage } from "../agent/bootstrap.js";
import type { AppDatabase } from "./database.js";

interface BootstrapStateRow {
  world_id: number;
  stage: string;
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

  /** Persist the last completed stage (idempotent). */
  save(worldId: number, stage: BootstrapStage): void {
    this.db.sql
      .prepare(
        `INSERT INTO bootstrap_state (world_id, stage, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(world_id) DO UPDATE SET stage = excluded.stage, updated_at = excluded.updated_at`,
      )
      .run(worldId, stage, new Date().toISOString());
  }
}

function stageFromString(value: string): BootstrapStage | null {
  const stage = String(value).trim();
  for (const candidate of Object.values(BootstrapStage)) {
    if (candidate === stage) return candidate;
  }
  return null;
}