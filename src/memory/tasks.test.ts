import assert from "node:assert/strict";
import { test } from "node:test";
import { AppDatabase } from "./database.js";
import { MIGRATIONS } from "./migrations.js";
import { TasksRepository } from "./tasks.js";
import { TaskPriority, TaskStatus, type Task } from "../agent/task.js";

function task(id: string, status: TaskStatus, createdAt: string, completedAt?: string): Task {
  return {
    id,
    type: "test",
    priority: TaskPriority.BACKGROUND,
    source: "background",
    objective: id,
    parameters: {},
    status,
    createdAt,
    completedAt,
  };
}

test("pruneSettled removes old terminal and blocked rows but keeps live and recent rows", () => {
  const db = new AppDatabase(":memory:");
  db.runMigrations(MIGRATIONS);
  const tasks = new TasksRepository(db);
  const old = "2020-01-01T00:00:00.000Z";
  const recent = "2099-01-01T00:00:00.000Z";
  for (const status of [TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.BLOCKED, TaskStatus.CANCELLED]) {
    tasks.create(task(`old-${status}`, status, old, status === TaskStatus.BLOCKED ? undefined : old));
  }
  tasks.create(task("paused", TaskStatus.PAUSED, old));
  tasks.create(task("recent", TaskStatus.COMPLETED, recent, recent));

  const removed = tasks.pruneSettled("2025-01-01T00:00:00.000Z", 0);
  assert.equal(removed, 4);
  assert.deepEqual(tasks.loadAll().map((row) => row.id).sort(), ["paused", "recent"]);
  db.close();
});

test("project execution policy survives task persistence", () => {
  const db = new AppDatabase(":memory:");
  db.runMigrations(MIGRATIONS);
  const tasks = new TasksRepository(db);
  tasks.create({
    ...task("project-acquire", TaskStatus.QUEUED, "2026-09-19T00:00:00.000Z"),
    type: "build_project_acquire",
    projectId: "project-1",
    projectPhaseId: "phase-1",
    executionPolicy: "resumable",
    workKey: "build-project:project-1:phase-1:acquire:stone",
  });
  assert.equal(tasks.get("project-acquire")?.executionPolicy, "resumable");
  assert.equal(tasks.get("project-acquire")?.projectId, "project-1");
  db.close();
});
