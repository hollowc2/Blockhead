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
}