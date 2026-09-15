import { GoalStatus, type Goal, type SuccessCriterion } from "../agent/goal.js";
import type { AppDatabase } from "./database.js";

interface GoalRow {
  id: string;
  description: string;
  source: string;
  status: string;
  success_criteria_json: string;
  current_step: string | null;
  recent_results_json: string;
  note: string | null;
  created_at: string;
  ended_at: string | null;
}

const SELECT_GOAL = `
  SELECT id, description, source, status, success_criteria_json,
         current_step, recent_results_json, note, created_at, ended_at
  FROM goals`;

/**
 * Goal persistence. A goal row is the source of truth for goal state; the
 * GoalManager keeps an in-memory mirror that is rehydrated on boot, so an
 * active autonomous goal survives a restart and the background loop resumes
 * driving it.
 */
export class GoalsRepository {
  constructor(private readonly db: AppDatabase) {}

  create(goal: Goal): void {
    this.db.sql
      .prepare(
        `INSERT INTO goals
           (id, description, source, status, success_criteria_json,
            current_step, recent_results_json, note, created_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        goal.id,
        goal.description,
        goal.source,
        goal.status,
        JSON.stringify(goal.successCriteria),
        goal.currentStep ?? null,
        JSON.stringify(goal.recentResults),
        goal.note ?? null,
        goal.createdAt,
        goal.endedAt ?? null,
      );
  }

  update(goal: Goal): void {
    this.db.sql
      .prepare(
        `UPDATE goals SET
           description = ?, source = ?, status = ?, success_criteria_json = ?,
           current_step = ?, recent_results_json = ?, note = ?, ended_at = ?
         WHERE id = ?`,
      )
      .run(
        goal.description,
        goal.source,
        goal.status,
        JSON.stringify(goal.successCriteria),
        goal.currentStep ?? null,
        JSON.stringify(goal.recentResults),
        goal.note ?? null,
        goal.endedAt ?? null,
        goal.id,
      );
  }

  get(id: string): Goal | null {
    const row = this.db.sql.prepare(`${SELECT_GOAL} WHERE id = ?`).get(id) as GoalRow | undefined;
    return row ? toGoal(row) : null;
  }

  /** The single live goal, or null. There is at most one active goal at a time. */
  getActive(): Goal | null {
    const row = this.db.sql
      .prepare(`${SELECT_GOAL} WHERE status = ? LIMIT 1`)
      .get(GoalStatus.ACTIVE) as GoalRow | undefined;
    return row ? toGoal(row) : null;
  }
}

function toGoal(row: GoalRow): Goal {
  const results = JSON.parse(row.recent_results_json) as Goal["recentResults"];
  return {
    id: row.id,
    description: row.description,
    source: row.source as Goal["source"],
    status: row.status as GoalStatus,
    successCriteria: JSON.parse(row.success_criteria_json) as SuccessCriterion[],
    currentStep: row.current_step ?? null,
    recentResults: Array.isArray(results) ? results : [],
    note: row.note ?? undefined,
    createdAt: row.created_at,
    endedAt: row.ended_at ?? undefined,
  };
}