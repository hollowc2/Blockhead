import assert from "node:assert/strict";
import { test } from "node:test";
import { landmarkTemplate } from "../building/templates.js";
import { EventBus } from "../events/bus.js";
import { AppDatabase } from "../memory/database.js";
import { MIGRATIONS } from "../memory/migrations.js";
import { BuildProjectsRepository } from "../memory/build-projects.js";
import { TasksRepository } from "../memory/tasks.js";
import { BuildProjectManager } from "./build-projects.js";
import { Scheduler } from "./scheduler.js";

const origin = { x: 10, y: 64, z: -4, dimension: "overworld" };

function harness() {
  const db = new AppDatabase(":memory:");
  db.runMigrations(MIGRATIONS);
  const bus = new EventBus();
  const tasks = new TasksRepository(db);
  const scheduler = new Scheduler({ bus, tasks });
  const projects = new BuildProjectsRepository(db);
  return { db, bus, tasks, scheduler, projects };
}

test("creating a project freezes phases and schedules exactly one slice", () => {
  const h = harness();
  try {
    const manager = new BuildProjectManager(h.projects, h.scheduler, h.bus);
    const design = landmarkTemplate("castle", "small");
    const result = manager.createOrResume({ userGoal: "Build a castle", structureType: "castle", source: "user", design, origin });
    const project = h.projects.get(result.project.id)!;
    const phases = h.projects.getPhases(project.id);

    assert.equal(result.resumed, false);
    assert.equal(result.task.type, "build_project_slice");
    assert.equal(result.task.projectId, project.id);
    assert.equal(result.task.projectPhaseId, phases[0]!.id);
    assert.equal(result.task.executionPolicy, "resumable");
    assert.equal(result.task.workKey, `build-project:${project.id}:${phases[0]!.id}`);
    assert.equal(project.blueprintHash, project.blueprint.hash);
    assert.equal(project.currentPhaseId, phases[0]!.id);
    assert.equal(phases[0]!.status, "active");
    assert.ok(phases.length > 1);
    assert.equal(h.tasks.loadUnfinished().length, 1);
    assert.equal(h.projects.listEvents(project.id).map((event) => event.kind).join(","), "slice_scheduled");
  } finally {
    h.db.close();
  }
});

test("repeating the same design resumes its project without another live slice", () => {
  const h = harness();
  try {
    const manager = new BuildProjectManager(h.projects, h.scheduler, h.bus);
    const input = { userGoal: "Build a castle", structureType: "castle", source: "user" as const, design: landmarkTemplate("castle", "small"), origin };
    const first = manager.createOrResume(input);
    const second = manager.createOrResume(input);

    assert.equal(second.resumed, true);
    assert.equal(second.project.id, first.project.id);
    assert.equal(second.task.id, first.task.id);
    assert.equal(h.tasks.loadUnfinished().filter((task) => task.projectId === first.project.id).length, 1);
  } finally {
    h.db.close();
  }
});

test("rehydration restores the frozen project and reuses an existing live child task", () => {
  const h = harness();
  try {
    const design = landmarkTemplate("castle", "small");
    const firstManager = new BuildProjectManager(h.projects, h.scheduler, h.bus);
    const first = firstManager.createOrResume({ userGoal: "Build a castle", structureType: "castle", source: "user", design, origin });
    const hash = first.project.blueprintHash;

    const restartedTasks = new TasksRepository(h.db);
    const restartedScheduler = new Scheduler({ bus: new EventBus(), tasks: restartedTasks });
    restartedScheduler.loadFromPersistence();
    const restartedManager = new BuildProjectManager(h.projects, restartedScheduler, new EventBus());
    const restored = restartedManager.rehydrate();

    assert.equal(restored.length, 1);
    assert.equal(restored[0]!.id, first.project.id);
    assert.equal(restored[0]!.blueprintHash, hash);
    assert.deepEqual(restored[0]!.origin, origin);
    assert.equal(restartedScheduler.queued.length, 1);
    assert.equal(restartedScheduler.queued[0]!.id, first.task.id);
    assert.equal(restartedTasks.loadUnfinished().length, 1);
  } finally {
    h.db.close();
  }
});
