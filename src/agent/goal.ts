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
import type { BlockBounds, TerrainAnchor } from "../terrain/schema.js";

export enum GoalStatus {
  ACTIVE = "active",
  COMPLETED = "completed",
  BLOCKED = "blocked",
  CANCELLED = "cancelled",
  /** Waiting in the owner's goal queue; promoted to ACTIVE when the goals ahead of it settle. */
  QUEUED = "queued",
}

export type GoalSource = "owner" | "background" | "system";

/** A block position in one dimension (a chest a goal delivers into). */
export interface GoalBlockRef {
  x: number;
  y: number;
  z: number;
  dimension: string;
}

/**
 * A deterministic, evaluable readiness condition — a definition of "done"
 * the goal driver measures against the world, never the LLM's say-so:
 *  - `stockpile`: a stockpile level (carried + home chest, from the
 *    maintenance snapshot);
 *  - `inventory`: a carried + equipped item count;
 *  - `building_verified`: the home base shed measures complete
 *    (`target: "base"`), or a build project passed its final block-by-block
 *    verification (`target: "project"`; bound to a concrete `projectId` the
 *    first time a matching project is seen);
 *  - `chest_contains`: one specific chest, frozen to coordinates when the
 *    goal is created, holds at least `min` of an item as last read open;
 *  - `area_cleared`: every cell of a frozen box reads passable (or water)
 *    under the same check the clear-area verifier uses; an unloaded cell is
 *    unmet.
 * Anything the LLM worded as a criterion outside these shapes is kept in the
 * goal's description/prompt instead.
 */
export type SuccessCriterion =
  | { kind: "stockpile"; stockpile: StockpileKind; min: number }
  | { kind: "inventory"; item: string; min: number }
  | { kind: "building_verified"; target: "base" }
  | { kind: "building_verified"; target: "project"; match?: string; projectId?: string; projectName?: string }
  | { kind: "chest_contains"; item: string; min: number; chest: GoalBlockRef; label?: string }
  | AreaClearedCriterion;

/**
 * A frozen clear-area box. The anchor and dimensions are kept with the
 * bounds so the goal can create the same terrain project `clear_area` would
 * have (same geometry hash, so an existing one resumes rather than duplicates).
 */
export interface AreaClearedCriterion {
  kind: "area_cleared";
  dimension: string;
  bounds: BlockBounds;
  anchor: { x: number; y: number; z: number };
  anchorKind: TerrainAnchor;
  width: number;
  length: number;
  height: number;
  /** The terrain project the goal started for this box (set by its clear_area action). */
  projectId?: string;
}

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
export const UNFINISHED_GOAL_STATUSES: readonly GoalStatus[] = [GoalStatus.ACTIVE, GoalStatus.QUEUED];

/** The observable facts a goal's criteria are evaluated against. */
export interface GoalFacts {
  /** Stockpile levels (carried + stored); a missing bookkeeping level reads 0. */
  stockpile?: Partial<Record<StockpileKind, number>>;
  /** Carried + equipped item counts by bare item name. */
  inventory?: Record<string, number>;
  /** True when the home base shed measured complete this tick (unknown = unmet). */
  baseVerified?: boolean;
  /** Build project status by project id (only "completed" passed final verification). */
  projects?: Record<string, string>;
  /** Last-read contents of goal chests, keyed by `chestKey`. */
  chests?: Record<string, Record<string, number>>;
  /** Clear-area inspection by `boundsKey`: cells inspected and cells verified clear. */
  areas?: Record<string, { inspected: number; verified: number }>;
}

/** Stable key for a goal chest position. */
export function chestKey(at: GoalBlockRef): string {
  return `${at.dimension}:${at.x},${at.y},${at.z}`;
}

/** Stable key for an area box. */
export function boundsKey(dimension: string, bounds: BlockBounds): string {
  return `${dimension}:${bounds.minX},${bounds.minY},${bounds.minZ}:${bounds.maxX},${bounds.maxY},${bounds.maxZ}`;
}

export interface GoalCriteriaCheck {
  satisfied: boolean;
  met: SuccessCriterion[];
  /** Criteria not yet met (an unknown/unmeasured fact counts as unmet — never premature completion). */
  unmet: SuccessCriterion[];
}

/** Human label for a criterion, shown to the LLM ("food stockpile >= 32"). */
export function criterionLabel(criterion: SuccessCriterion): string {
  switch (criterion.kind) {
    case "stockpile":
      return `${criterion.stockpile} stockpile >= ${criterion.min}`;
    case "inventory":
      return `carried ${criterion.item} >= ${criterion.min}`;
    case "building_verified":
      if (criterion.target === "base") return "home base shed verified complete";
      return `build ${criterion.projectName ?? criterion.match ?? "project"} verified complete`;
    case "chest_contains":
      return `chest at ${criterion.chest.x},${criterion.chest.y},${criterion.chest.z}${criterion.label ? ` (${criterion.label})` : ""} holds ${criterion.item} >= ${criterion.min}`;
    case "area_cleared": {
      const b = criterion.bounds;
      return `area ${criterion.width}x${criterion.length}x${criterion.height} at ${b.minX},${b.minY},${b.minZ}..${b.maxX},${b.maxY},${b.maxZ} fully cleared`;
    }
  }
}

/**
 * Where a criterion stands right now, for the LLM ("chest holds 12/32
 * iron_ingot", "area 340/400 cells clear"). Unknown facts say so instead of
 * reading as zero.
 */
export function criterionProgress(criterion: SuccessCriterion, facts: GoalFacts): string {
  switch (criterion.kind) {
    case "stockpile":
      return `${criterion.stockpile} stockpile ${facts.stockpile?.[criterion.stockpile] ?? "unknown"}/${criterion.min}`;
    case "inventory":
      return `carrying ${facts.inventory?.[criterion.item] ?? "unknown"}/${criterion.min} ${criterion.item}`;
    case "building_verified": {
      if (criterion.target === "base") {
        return facts.baseVerified === undefined ? "base shed not measured" : facts.baseVerified ? "base shed complete" : "base shed incomplete";
      }
      if (criterion.projectId === undefined) return `no build project${criterion.match ? ` matching "${criterion.match}"` : ""} started yet`;
      return `build ${criterion.projectName ?? criterion.projectId} is ${facts.projects?.[criterion.projectId] ?? "missing"}`;
    }
    case "chest_contains": {
      const contents = facts.chests?.[chestKey(criterion.chest)];
      return contents === undefined
        ? `chest contents not read yet (0 known of ${criterion.min} ${criterion.item})`
        : `chest holds ${contents[criterion.item] ?? 0}/${criterion.min} ${criterion.item}`;
    }
    case "area_cleared": {
      const area = facts.areas?.[boundsKey(criterion.dimension, criterion.bounds)];
      return area === undefined ? "area not observed (unloaded or another dimension)" : `area ${area.verified}/${area.inspected} cells clear`;
    }
  }
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
  switch (criterion.kind) {
    case "stockpile": {
      const level = facts.stockpile?.[criterion.stockpile];
      return level !== undefined && level >= criterion.min;
    }
    case "inventory": {
      const count = facts.inventory?.[criterion.item];
      return count !== undefined && count >= criterion.min;
    }
    case "building_verified":
      if (criterion.target === "base") return facts.baseVerified === true;
      // A project only reaches "completed" after its final verification
      // inspected every planned block and found each one in place.
      return criterion.projectId !== undefined && facts.projects?.[criterion.projectId] === "completed";
    case "chest_contains": {
      const count = facts.chests?.[chestKey(criterion.chest)]?.[criterion.item];
      return count !== undefined && count >= criterion.min;
    }
    case "area_cleared": {
      const area = facts.areas?.[boundsKey(criterion.dimension, criterion.bounds)];
      return area !== undefined && area.inspected > 0 && area.verified === area.inspected;
    }
  }
}