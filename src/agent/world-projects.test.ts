import assert from "node:assert/strict";
import { test } from "node:test";
import { EventBus } from "../events/bus.js";
import { AppDatabase } from "../memory/database.js";
import { MIGRATIONS } from "../memory/migrations.js";
import { WorldProjectsRepository } from "../memory/world-projects.js";
import { createFrozenTerrainPlan } from "../terrain/schema.js";
import { Scheduler } from "./scheduler.js";
import { TasksRepository } from "../memory/tasks.js";
import { WorldProjectManager } from "./world-projects.js";

function harness() {
  const db = new AppDatabase(":memory:");
  db.runMigrations(MIGRATIONS);
  const bus = new EventBus();
  const scheduler = new Scheduler({ bus, tasks: new TasksRepository(db) });
  const projects = new WorldProjectsRepository(db);
  return { db, bus, scheduler, projects };
}

test("terrain envelope creates one resumable generic child and resumes by geometry", () => {
  const h = harness();
  try {
    const manager = new WorldProjectManager(h.projects, h.scheduler, h.bus);
    const plan = createFrozenTerrainPlan({
      world: "world", dimension: "overworld", anchor: { x: 0, y: 64, z: 0, dimension: "overworld" },
      bounds: { minX: 0, maxX: 1, minY: 60, maxY: 64, minZ: 0, maxZ: 1 },
      specification: { kind: "excavate", anchor: "owner", width: 2, length: 2, depth: 5 },
    });
    const first = manager.createTerrainProject({ userGoal: "dig", source: "user", plan });
    const second = manager.createTerrainProject({ userGoal: "dig again", source: "user", plan });
    assert.equal(first.resumed, false);
    assert.equal(second.resumed, true);
    assert.equal(second.project.id, first.project.id);
    assert.equal(h.scheduler.queued.filter((task) => task.projectId === first.project.id).length, 1);
    assert.equal(first.task.executionPolicy, "resumable");
    assert.equal(first.task.type, "world_project_slice");
  } finally { h.db.close(); }
});

test("cancelling a generic child cancels its world project", () => {
  const h = harness();
  try {
    const manager = new WorldProjectManager(h.projects, h.scheduler, h.bus);
    const plan = createFrozenTerrainPlan({
      world: "world", dimension: "overworld", anchor: { x: 0, y: 64, z: 0, dimension: "overworld" },
      bounds: { minX: 0, maxX: 0, minY: 64, maxY: 64, minZ: 0, maxZ: 0 },
      specification: { kind: "clear", anchor: "owner", width: 1, length: 1, height: 1 },
    });
    const created = manager.createTerrainProject({ userGoal: "clear", source: "user", plan });
    h.scheduler.cancel(created.task.id);
    assert.equal(manager.getWorldProject(created.project.id)?.status, "cancelled");
  } finally { h.db.close(); }
});
