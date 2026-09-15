/**
 * Goal model (persistent objective layer). Pure types — no runtime
 * dependencies — so the goal manager, persistence layer, event payloads, and
 * the LLM schemas can share it.
 *
 * A goal is the objective that survives across multiple deterministic skill
 * runs: code establishes it (owner instruction or a background recipe), the
 * LLM picks ONE next high-level action from a closed vocabulary, the existing
 * TaskDispatcher executes it as a `source: "goal"` task, and the result is
 * recorded against the goal before the LLM chooses the next action.
 */

import type { StockpileKind } from "./maintenance.js";

export enum GoalStatus {
  ACTIVE = "active",
  COMPLETED = "completed",
  BLOCKED = "blocked",
  CANCELLED = "cancelled",
}

export type GoalSource = "owner" | "background" | "system";

/**
 * A deterministic, evaluable readiness condition. Two closed kinds map onto
 * facts the goal driver can measure: a `stockpile` level (carried + home
 * chest, from the maintenance snapshot) or a carried+equipped `inventory`
 * count. Anything the LLM worded as a criterion outside these shapes is kept
 * in the goal's description/prompt instead.
 */
export type SuccessCriterion =
  | { kind: "stockpile"; stockpile: StockpileKind; min: number }
  | { kind: "inventory"; item: string; min: number };

/** How one settled skill run (or LLM terminal action) contributed to the goal. */
export interface GoalResult {
  action: string;
  outcome: "completed" | "partial" | "failed" | "blocked" | "cancelled" | "standing_by";
  message?: string;
  at: string;
}

export interface Goal {
  id: string;
  description: string;
  source: GoalSource;
  status: GoalStatus;
  createdAt: string;
  successCriteria: SuccessCriterion[];
  /** The high-level action currently being executed for the goal. */
  currentStep: string | null;
  recentResults: GoalResult[];
  /** Terminal-state note: why the goal completed/blocked/cancelled. */
  note?: string;
  endedAt?: string;
}

/** Goal inputs before the system assigns identity and lifecycle fields. */
export type NewGoal = Omit<Goal, "id" | "status" | "createdAt" | "recentResults" | "currentStep" | "note" | "endedAt"> & {
  currentStep?: string | null;
};

/** Statuses that mean the goal is still live (resumed on restart). */
export const UNFINISHED_GOAL_STATUSES: readonly GoalStatus[] = [GoalStatus.ACTIVE];

/** The observable facts a goal's criteria are evaluated against. */
export interface GoalFacts {
  /** Stockpile levels (carried + stored); a missing bookkeeping level reads 0. */
  stockpile?: Partial<Record<StockpileKind, number>>;
  /** Carried + equipped item counts by bare item name. */
  inventory?: Record<string, number>;
}

export interface GoalCriteriaCheck {
  satisfied: boolean;
  met: SuccessCriterion[];
  /** Criteria not yet met (an unknown/unmeasured fact counts as unmet — never premature completion). */
  unmet: SuccessCriterion[];
}

/** Human label for a criterion, shown to the LLM ("food stockpile >= 32"). */
export function criterionLabel(criterion: SuccessCriterion): string {
  if (criterion.kind === "stockpile") {
    return `${criterion.stockpile} stockpile >= ${criterion.min}`;
  }
  return `carried ${criterion.item} >= ${criterion.min}`;
}

/**
 * Deterministic evaluation of a goal's success criteria. A criterion whose
 * fact source is unavailable (no stockpile measurement yet, or a count for an
 * item not supplied) counts as unmet, so a goal is never declared complete on
 * missing information.
 */
export function evaluateSuccessCriteria(
  goal: Pick<Goal, "successCriteria">,
  facts: GoalFacts,
): GoalCriteriaCheck {
  const met: SuccessCriterion[] = [];
  const unmet: SuccessCriterion[] = [];
  for (const criterion of goal.successCriteria) {
    if (criterionSatisfied(criterion, facts)) met.push(criterion);
    else unmet.push(criterion);
  }
  return { satisfied: unmet.length === 0, met, unmet };
}

function criterionSatisfied(criterion: SuccessCriterion, facts: GoalFacts): boolean {
  if (criterion.kind === "stockpile") {
    const level = facts.stockpile?.[criterion.stockpile];
    if (level === undefined) return false;
    return level >= criterion.min;
  }
  const count = facts.inventory?.[criterion.item];
  if (count === undefined) return false;
  return count >= criterion.min;
}