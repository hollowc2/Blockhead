import assert from "node:assert/strict";
import { test } from "node:test";
import { EventBus } from "../events/bus.js";
import { AppDatabase } from "../memory/database.js";
import { MIGRATIONS } from "../memory/migrations.js";
import { GoalsRepository } from "../memory/goals.js";
import { TaskPriority, TaskStatus, type Task } from "./task.js";
import {
  GoalStatus,
  evaluateSuccessCriteria,
  type Goal,
  type GoalResult,
  type NewGoal,
} from "./goal.js";
import { GoalManager } from "./goals.js";

function newGen(overrides: Partial<NewGoal> = {}): NewGoal {
  return {
    description: "Prepare for a mining expedition.",
    source: "owner",
    successCriteria: [
      { kind: "stockpile", stockpile: "food", min: 32 },
      { kind: "inventory", item: "iron_pickaxe", min: 1 },
    ],
    ...overrides,
  };
}

/** A settled goal-sourced task event payload. */
function goalTask(goalId: string, overrides: Partial<Task> = {}): { task: Task } {
  return {
    task: {
      id: `task-${Math.random()}`,
      type: "collect_resource",
      priority: TaskPriority.BACKGROUND,
      source: "goal",
      objective: "[goal] collect 16 coal_ore",
      parameters: { resource: "coal_ore", quantity: 16, goalId },
      status: overrides.status ?? TaskStatus.COMPLETED,
      createdAt: "2026-09-15T00:00:00.000Z",
      lastError: overrides.status === TaskStatus.FAILED ? "ups" : undefined,
      ...overrides,
    },
  };
}

interface Harness {
  bus: EventBus;
  manager: GoalManager;
  close: () => void;
  events: string[];
}

function newHarness(): Harness {
  const bus = new EventBus();
  const db = new AppDatabase(":memory:");
  db.runMigrations(MIGRATIONS);
  const repo = new GoalsRepository(db);
  const manager = new GoalManager({ bus, goals: repo });
  const events: string[] = [];
  for (const name of ["goal.started", "goal.completed", "goal.blocked", "goal.cancelled"] as const) {
    bus.on(name, () => events.push(name));
  }
  return { bus, manager, close: () => db.close(), events };
}

test("start records an active goal and emits goal.started", () => {
  const h = newHarness();
  try {
    const goal = h.manager.start(newGen());
    assert.equal(h.manager.active()!.id, goal.id);
    assert.equal(goal.source, "owner");
    assert.equal(h.events[0], "goal.started");
  } finally {
    h.close();
  }
});

test("start replaces an active goal (cancels the old one)", () => {
  const h = newHarness();
  try {
    const first = h.manager.start(newGen({ description: "first" }));
    const second = h.manager.start(newGen({ description: "second" }));
    assert.equal(h.manager.active()!.id, second.id);
    assert.equal(h.events[0], "goal.started");
    assert.equal(h.events[1], "goal.cancelled", "the old goal was superseded");
    assert.equal(h.events[2], "goal.started");
    assert.equal(first.status, GoalStatus.CANCELLED);
  } finally {
    h.close();
  }
});

test("a settled goal-sourced task records a capped result against the goal", () => {
  const h = newHarness();
  try {
    const goal = h.manager.start(newGen());
    h.bus.emit("task.completed", goalTask(goal.id));
    h.bus.emit("task.failed", goalTask(goal.id, { status: TaskStatus.FAILED }));

    const active = h.manager.active()!;
    assert.equal(active.recentResults.length, 2);
    assert.equal(active.recentResults[0]!.action, "collect_resource");
    assert.equal(active.recentResults[0]!.outcome, "completed");
    assert.equal(active.recentResults[1]!.outcome, "failed");
  } finally {
    h.close();
  }
});

test("results from an unrelated or mismatched task are ignored", () => {
  const h = newHarness();
  try {
    const goal = h.manager.start(newGen());
    h.bus.emit("task.completed", goalTask("other-goal"));
    h.bus.emit("task.completed", {
      task: {
        ...goalTask(goal.id).task,
        id: "user-task",
        source: "user",
      },
    });

    assert.equal(h.manager.active()!.recentResults.length, 0, "no mismatched result recorded");
  } finally {
    h.close();
  }
});

test("task.blocked for the goal's action blocks the goal (terminal)", () => {
  const h = newHarness();
  try {
    const goal = h.manager.start(newGen());
    h.bus.emit("task.blocked", goalTask(goal.id, { status: TaskStatus.BLOCKED, lastError: "3 failed attempts" }));

    assert.equal(h.manager.active(), null, "blocked goal is no longer active");
    assert.equal(h.events[1], "goal.blocked");
  } finally {
    h.close();
  }
});

test("cancel clears the goal; subsequent start works", () => {
  const h = newHarness();
  try {
    const goal = h.manager.start(newGen());
    h.manager.cancel("stopped by the owner");
    assert.equal(h.manager.active(), null);
    assert.equal(h.events[1], "goal.cancelled");

    const next = h.manager.start(newGen({ description: "again" }));
    assert.equal(h.manager.active()!.id, next.id);
  } finally {
    h.close();
  }
});

test("a goal rehydrates the persisted active row on construction", () => {
  const bus = new EventBus();
  const db = new AppDatabase(":memory:");
  try {
    db.runMigrations(MIGRATIONS);
    const repo = new GoalsRepository(db);
    const first = new GoalManager({ bus, goals: repo });
    const goal = first.start(newGen());
    first.dispose();

    const second = new GoalManager({ bus, goals: repo });
    assert.equal(second.active()!.id, goal.id, "restart resumes the same active goal");
    second.dispose();
  } finally {
    db.close();
  }
});

// --- evaluateSuccessCriteria (pure) ---

function criterionGoal(criteria: Goal["successCriteria"]): Goal {
  return {
    id: "g",
    description: "d",
    source: "owner",
    status: GoalStatus.ACTIVE,
    createdAt: "2026-09-15T00:00:00.000Z",
    successCriteria: criteria,
    currentStep: null,
    recentResults: [] as GoalResult[],
  };
}

test("evaluateSuccessCriteria: all satisfied when facts clear the thresholds", () => {
  const goal = criterionGoal([
    { kind: "stockpile", stockpile: "food", min: 32 },
    { kind: "stockpile", stockpile: "torches", min: 64 },
    { kind: "inventory", item: "iron_pickaxe", min: 1 },
  ]);
  const check = evaluateSuccessCriteria(goal, {
    stockpile: { food: 40, torches: 64 },
    inventory: { iron_pickaxe: 1 },
  });
  assert.equal(check.satisfied, true);
  assert.equal(check.met.length, 3);
  assert.equal(check.unmet.length, 0);
});

test("evaluateSuccessCriteria: any unmet or unknown fact blocks completion", () => {
  const goal = criterionGoal([
    { kind: "stockpile", stockpile: "food", min: 32 },
    { kind: "inventory", item: "iron_pickaxe", min: 1 },
  ]);
  const low = evaluateSuccessCriteria(goal, { stockpile: { food: 10 }, inventory: { iron_pickaxe: 1 } });
  assert.equal(low.satisfied, false);
  assert.equal(low.unmet.length, 1);

  // The stockpile level was never measured -> treated as unmet (never premature).
  const unknown = evaluateSuccessCriteria(goal, { inventory: { iron_pickaxe: 1 } });
  assert.equal(unknown.satisfied, false);
});