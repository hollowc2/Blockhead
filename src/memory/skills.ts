import { randomUUID } from "node:crypto";
import type { AppDatabase } from "./database.js";

/**
 * Compact success record for a completed skill (spec 20.2). Kept intentionally
 * small so locally-stored runs can serve as few-shot examples at decision time.
 */
export interface SkillSuccess {
  id: string;
  skillName: string;
  parameters: Record<string, unknown>;
  startingConditions: {
    biomeOrRegion?: string;
    inventorySummary: Record<string, number>;
    homeDistance: number;
    timeOfDay?: string;
  };
  outcome: {
    durationMs: number;
    interruptions: number;
    finalInventoryDelta: Record<string, number>;
  };
  description: string;
  createdAt: string;
}

/** Skill success record ingestion (spec 20.2 / 21 schema). */
export class SkillsRepository {
  constructor(private readonly db: AppDatabase) {}

  /** Insert one success record; row id and timestamp are generated here. */
  record(success: Omit<SkillSuccess, "id" | "createdAt">): SkillSuccess {
    const record: SkillSuccess = {
      ...success,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    this.db.sql
      .prepare(
        `INSERT INTO skill_successes
           (id, skill_name, parameters_json, starting_conditions_json, outcome_json, description, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.skillName,
        JSON.stringify(record.parameters),
        JSON.stringify(record.startingConditions),
        JSON.stringify(record.outcome),
        record.description,
        record.createdAt,
      );
    return record;
  }

  /**
   * The most recent successful runs, newest first (spec 20.2). Local runs
   * seed the decision few-shots; `limit` bounds the query and dedupe of the
   * caller. Recent-first ordering makes the freshest, most representative
   * run of each skill shape the next decision.
   */
  recent(options?: { limit?: number; skillName?: string }): SkillSuccess[] {
    const limit = Math.max(1, Math.min(options?.limit ?? 5, 50));
    const rows = options?.skillName
      ? this.db.sql
          .prepare(
            `SELECT id, skill_name, parameters_json, starting_conditions_json, outcome_json, description, created_at
             FROM skill_successes
             WHERE skill_name = ?
             ORDER BY created_at DESC, rowid DESC
             LIMIT ?`,
          )
          .all(options.skillName, limit)
      : this.db.sql
          .prepare(
            `SELECT id, skill_name, parameters_json, starting_conditions_json, outcome_json, description, created_at
             FROM skill_successes
             ORDER BY created_at DESC, rowid DESC
             LIMIT ?`,
          )
          .all(limit);
    return rows.map((row) => parseSkillSuccess(row as Record<string, unknown>));
  }
}

/** Parse one skill_successes row back into a SkillSuccess. */
function parseSkillSuccess(row: Record<string, unknown>): SkillSuccess {
  return {
    id: String(row.id),
    skillName: String(row.skill_name),
    parameters: JSON.parse(String(row.parameters_json)) as Record<string, unknown>,
    startingConditions: JSON.parse(String(row.starting_conditions_json)) as SkillSuccess["startingConditions"],
    outcome: JSON.parse(String(row.outcome_json)) as SkillSuccess["outcome"],
    description: String(row.description),
    createdAt: String(row.created_at),
  };
}