import { deepStrictEqual, equal } from "node:assert/strict";
import test from "node:test";
import { GoalStatus } from "../agent/goal.js";
import { TaskPriority, TaskStatus } from "../agent/task.js";
import { projectGoal, projectInventory, projectPosition, projectStockpiles, projectTask } from "./projections.js";

const task = { id: "task-1", type: "collect_resource", priority: TaskPriority.FOREGROUND, source: "user" as const, objective: "Collect oak logs", parameters: { resource: "oak_log" }, status: TaskStatus.ACTIVE, createdAt: "2026-09-16T10:00:00.000Z", startedAt: "2026-09-16T10:01:00.000Z", attempts: 1 };

function assertJsonSafe(value: unknown): void {
  const encoded = JSON.stringify(value);
  deepStrictEqual(JSON.parse(encoded), value);
  if (value !== null && typeof value === "object") {
    equal(Object.getPrototypeOf(value), Array.isArray(value) ? Array.prototype : Object.prototype);
    for (const child of Object.values(value)) assertJsonSafe(child);
  }
}

test("projects null and active tasks with explicit nulls", () => {
  equal(projectTask(null), null);
  deepStrictEqual(projectTask(task), { id: "task-1", type: "collect_resource", priority: 70, source: "user", objective: "Collect oak logs", status: "active", createdAt: "2026-09-16T10:00:00.000Z", startedAt: "2026-09-16T10:01:00.000Z", completedAt: null, phase: null, attempts: 1, lastError: null });
});

test("projects goals, positions, inventory, and stockpiles", () => {
  deepStrictEqual(projectGoal({ id: "goal-1", description: "Stock food", source: "owner", status: GoalStatus.ACTIVE, createdAt: "2026-09-16T10:00:00.000Z", successCriteria: [{ kind: "inventory", item: "bread", min: 8 }], currentStep: null, recentResults: [] }), { id: "goal-1", description: "Stock food", source: "owner", status: "active", createdAt: "2026-09-16T10:00:00.000Z", currentStep: null, successCriteria: [{ kind: "inventory", stockpile: null, item: "bread", min: 8 }], recentResults: [], note: null, endedAt: null });
  deepStrictEqual(projectPosition({ x: 1.5, y: 64, z: -2 }), { x: 1.5, y: 64, z: -2 });
  deepStrictEqual(projectInventory({ stone: 3, oak_log: 2 }), { items: [{ name: "oak_log", count: 2 }, { name: "stone", count: 3 }], totalItems: 5 });
  deepStrictEqual(projectStockpiles({ levels: { wood: 2, food: 64, fuel: 4, torches: 8 }, targets: { wood: 64, food: 64, fuel: 64, torches: 64 }, deficits: [{ kind: "wood", target: 64, current: 2, deficit: 62, crisis: true }] }), { levels: { wood: 2, food: 64, fuel: 4, torches: 8 }, targets: { wood: 64, food: 64, fuel: 64, torches: 64 }, deficits: [{ kind: "wood", level: 2, target: 64, deficit: 62, crisis: true }] });
});

test("outputs are JSON-safe and inputs are unchanged", () => {
  const goal = { id: "g", description: "d", source: "system" as const, status: GoalStatus.ACTIVE, createdAt: "now", successCriteria: [], currentStep: null, recentResults: [] };
  const inventory = { z: 1, a: 2 };
  const stockpiles = { levels: { wood: 1, food: 2, fuel: 3, torches: 4 }, targets: { wood: 5, food: 6, fuel: 7, torches: 8 }, deficits: [] };
  const before = JSON.stringify({ task, goal, inventory, stockpiles });
  const output = [projectTask(task), projectGoal(goal), projectPosition({ x: 1, y: 2, z: 3 }), projectInventory(inventory), projectStockpiles(stockpiles)];
  assertJsonSafe(output);
  equal(JSON.stringify({ task, goal, inventory, stockpiles }), before);
  equal(projectPosition(undefined), null);
  equal(projectStockpiles(null), null);
});
