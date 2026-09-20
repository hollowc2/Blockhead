import assert from "node:assert/strict";
import { test } from "node:test";
import { landmarkTemplate } from "../building/templates.js";
import { TaskPriority, TaskStatus, type Task } from "../agent/task.js";
import { AppDatabase } from "./database.js";
import { MIGRATIONS } from "./migrations.js";
import { BuildProjectsRepository, type BuildPhase, type BuildProject } from "./build-projects.js";
import { TasksRepository } from "./tasks.js";

const origin = { x: 10, y: 64, z: -4, dimension: "overworld" };

function project(id: string, status: BuildProject["status"] = "active"): BuildProject {
  return {
    id,
    userGoal: "Build a small castle",
    structureType: "castle",
    source: "user",
    status,
    design: landmarkTemplate("castle", "small"),
    origin,
    compilerVersion: "compiler-test-1",
    schemaVersion: "building-schema-test-1",
    blueprintHash: "sha256:test-blueprint",
    blueprint: {
      origin,
      operations: [{ id: "op-00000", x: 0, y: 0, z: 0, material: "stone_bricks", phase: "structural_shell", replaceExisting: false, structural: true }],
      estimates: { blocks: 1, materials: { stone_bricks: 1 } },
      footprint: { width: 1, depth: 1, height: 1 },
    },
    requiredResources: { stone_bricks: 1 },
    shortages: [],
    resumeState: { currentOperationIndex: 0, completedRanges: [], interruptedCount: 0 },
    verificationState: { verifiedOperations: 0, totalOperations: 1, finalVerificationPassed: false },
    createdAt: "2026-09-19T00:00:00.000Z",
    updatedAt: "2026-09-19T00:00:00.000Z",
  };
}

function phase(projectId: string, id = "phase-1"): BuildPhase {
  return {
    id, projectId, ordinal: 0, label: "structural_shell-001", operationStart: 0,
    operationEnd: 1, status: "pending", attempts: 0, verifiedOperations: 0, totalOperations: 1,
  };
}

function harness(): { db: AppDatabase; projects: BuildProjectsRepository } {
  const db = new AppDatabase(":memory:");
  db.runMigrations(MIGRATIONS);
  return { db, projects: new BuildProjectsRepository(db) };
}

test("project and ordered phases round-trip their immutable snapshot and state", () => {
  const h = harness();
  try {
    const original = project("project-1");
    h.projects.create(original, [phase(original.id)]);

    assert.deepEqual(h.projects.get(original.id), original);
    assert.deepEqual(h.projects.getPhases(original.id), [phase(original.id)]);

    h.projects.update({
      ...original,
      status: "blocked",
      currentPhaseId: "phase-1",
      shortages: [{ material: "stone_bricks", required: 1, available: 0 }],
      lastError: "missing stone bricks",
      updatedAt: "2026-09-19T00:01:00.000Z",
    });
    h.projects.updatePhase({ ...phase(original.id), status: "blocked", lastError: "missing stone bricks" });

    const loaded = h.projects.get(original.id)!;
    assert.equal(loaded.status, "blocked");
    assert.deepEqual(loaded.shortages, [{ material: "stone_bricks", required: 1, available: 0 }]);
    assert.equal(h.projects.getPhases(original.id)[0]!.status, "blocked");
  } finally {
    h.db.close();
  }
});

test("unfinished project statuses rehydrate while terminal projects do not", () => {
  const h = harness();
  try {
    for (const [id, status] of [["active", "active"], ["paused", "paused"], ["blocked", "blocked"], ["verifying", "verifying"], ["done", "completed"]] as const) {
      h.projects.create(project(`project-${id}`, status));
    }
    assert.deepEqual(h.projects.loadUnfinished().map((item) => item.id), ["project-active", "project-paused", "project-blocked", "project-verifying"]);
  } finally {
    h.db.close();
  }
});

test("project events are append-only and preserve structured details", () => {
  const h = harness();
  try {
    h.projects.create(project("project-events"));
    const id = h.projects.appendEvent({ projectId: "project-events", phaseId: "phase-1", taskId: "task-1", kind: "blocked", details: { reason: "shortage", count: 3 }, createdAt: "2026-09-19T00:00:01.000Z" });
    assert.equal(typeof id, "number");
    assert.deepEqual(h.projects.listEvents("project-events"), [{ id, projectId: "project-events", phaseId: "phase-1", taskId: "task-1", kind: "blocked", details: { reason: "shortage", count: 3 }, createdAt: "2026-09-19T00:00:01.000Z" }]);
  } finally {
    h.db.close();
  }
});

test("task project linkage round-trips without affecting legacy task fields", () => {
  const h = harness();
  try {
    const task: Task = {
      id: "task-project-1", type: "build_project_slice", priority: TaskPriority.FOREGROUND,
      source: "user", objective: "Build castle chunk", parameters: {}, status: TaskStatus.QUEUED,
      createdAt: "2026-09-19T00:00:00.000Z", projectId: "project-1", projectPhaseId: "phase-1",
    };
    const tasks = new TasksRepository(h.db);
    tasks.create(task);
    assert.deepEqual(tasks.get(task.id), task);
  } finally {
    h.db.close();
  }
});
