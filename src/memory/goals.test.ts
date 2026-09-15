import assert from "node:assert/strict";
import { test } from "node:test";
import { GoalStatus, type Goal, type NewGoal } from "../agent/goal.js";
import { AppDatabase } from "./database.js";
import { MIGRATIONS } from "./migrations.js";
import { GoalsRepository } from "./goals.js";

/** Build a goal-shaped input with the common default fields filled. */
function newGoal(overrides: Partial<NewGoal> = {}): NewGoal {
  return {
    description: "Prepare for a mining expedition.",
    source: "background",
    successCriteria: [
      { kind: "stockpile", stockpile: "food", min: 32 },
      { kind: "inventory", item: "iron_pickaxe", min: 1 },
    ],
    ...overrides,
  };
}

/** Wrap a NewGoal into a full Goal with identity/lifecycle fields. */
function materialize(id: string, input: NewGoal, overrides: Partial<Goal> = {}): Goal {
  return {
    ...input,
    id,
    status: GoalStatus.ACTIVE,
    createdAt: "2026-09-15T00:00:00.000Z",
    currentStep: input.currentStep ?? null,
    recentResults: [],
    ...overrides,
  };
}

function newHarness(): { goals: GoalsRepository; close: () => void } {
  const db = new AppDatabase(":memory:");
  db.runMigrations(MIGRATIONS);
  const goals = new GoalsRepository(db);
  return { goals, close: () => db.close() };
}

test("create/get round-trips a goal with JSON fields parsed back", () => {
  const h = newHarness();
  try {
    const goal = materialize("g-1", newGoal(), {
      currentStep: "collect 16 coal_ore",
      recentResults: [{ action: "collect_resource", outcome: "completed", at: "2026-09-15T01:00:00.000Z" }],
    });
    h.goals.create(goal);

    const loaded = h.goals.get("g-1");
    assert.ok(loaded !== null);
    assert.equal(loaded!.description, "Prepare for a mining expedition.");
    assert.deepEqual(loaded!.successCriteria, goal.successCriteria);
    assert.equal(loaded!.currentStep, "collect 16 coal_ore");
    assert.equal(loaded!.recentResults.length, 1);
    assert.equal(loaded!.recentResults[0]!.outcome, "completed");
  } finally {
    h.close();
  }
});

test("update persists status, note, endedAt, results, and step", () => {
  const h = newHarness();
  try {
    const goal = materialize("g-2", newGoal());
    h.goals.create(goal);

    h.goals.update({
      ...goal,
      status: GoalStatus.COMPLETED,
      note: "success criteria met",
      endedAt: "2026-09-15T02:00:00.000Z",
      currentStep: null,
      recentResults: [{ action: "ensure_item", outcome: "completed", at: "2026-09-15T01:30:00.000Z" }],
    });

    const loaded = h.goals.get("g-2")!;
    assert.equal(loaded.status, GoalStatus.COMPLETED);
    assert.equal(loaded.note, "success criteria met");
    assert.equal(loaded.endedAt, "2026-09-15T02:00:00.000Z");
    assert.equal(loaded.currentStep, null);
    assert.equal(loaded.recentResults.length, 1);
  } finally {
    h.close();
  }
});

test("getActive returns the only live goal; settled goals are not active", () => {
  const h = newHarness();
  try {
    assert.equal(h.goals.getActive(), null, "empty table has no active goal");

    const first = materialize("g-3", newGoal());
    h.goals.create(first);
    assert.equal(h.goals.getActive()!.id, "g-3");

    h.goals.update({ ...first, status: GoalStatus.CANCELLED, endedAt: "2026-09-15T00:30:00.000Z" });
    assert.equal(h.goals.getActive(), null, "a cancelled goal is not active");

    const second = materialize("g-4", newGoal());
    h.goals.create(second);
    assert.equal(h.goals.getActive()!.id, "g-4");
  } finally {
    h.close();
  }
});