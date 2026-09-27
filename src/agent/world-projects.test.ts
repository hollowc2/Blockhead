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

test("repeating a blocked terrain command requeues its child and reopens the project", () => {
  const h = harness();
  try {
    const manager = new WorldProjectManager(h.projects, h.scheduler, h.bus);
    const plan = createFrozenTerrainPlan({
      world: "world", dimension: "overworld", anchor: { x: 0, y: 64, z: 0, dimension: "overworld" },
      bounds: { minX: 0, maxX: 2, minY: 64, maxY: 67, minZ: 0, maxZ: 2 },
      specification: { kind: "clear", anchor: "owner", width: 3, length: 3, height: 4 },
    });
    const first = manager.createTerrainProject({ userGoal: "clear 3x3", source: "user", plan });
    assert.equal(h.scheduler.claim()?.id, first.task.id);
    h.scheduler.blockActive("falling block must settle");
    assert.equal(first.task.status, "blocked");

    const retried = manager.createTerrainProject({ userGoal: "clear 3x3", source: "user", plan });

    assert.equal(retried.task.id, first.task.id);
    assert.equal(retried.task.status, "queued");
    assert.equal(manager.getWorldProject(first.project.id)?.status, "active");
    assert.equal(manager.getWorldProject(first.project.id)?.lastError, undefined);
    assert.equal(h.scheduler.claim()?.id, first.task.id);
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

function clearPlan() {
  return createFrozenTerrainPlan({
    world: "world", dimension: "overworld", anchor: { x: 0, y: 64, z: 0, dimension: "overworld" },
    bounds: { minX: 0, maxX: 2, minY: 64, maxY: 67, minZ: 0, maxZ: 2 },
    specification: { kind: "clear", anchor: "owner", width: 3, length: 3, height: 4 },
  });
}

/** The active task, claiming the next queued one when the slot is empty. */
function activeTask(h: ReturnType<typeof harness>) {
  return h.scheduler.active ?? h.scheduler.claim();
}

/** Run the slice to completion; returns the now-active verify task. */
function completeSlice(h: ReturnType<typeof harness>, manager: WorldProjectManager, sliceId: string) {
  const slice = activeTask(h);
  assert.equal(slice?.id, sliceId);
  assert.equal(manager.settleChildTask(slice!, { ok: true, status: "completed" }), "complete");
  h.scheduler.completeActive();
  const verify = activeTask(h);
  assert.equal(verify?.type, "world_project_verify");
  return verify!;
}

test("a blocked verify task is woken, not left blocked, when the owner repeats the command", () => {
  const h = harness();
  try {
    const manager = new WorldProjectManager(h.projects, h.scheduler, h.bus);
    const plan = clearPlan();
    const first = manager.createTerrainProject({ userGoal: "clear", source: "user", plan });
    const verify = completeSlice(h, manager, first.task.id);
    h.scheduler.blockActive("lava beside the route");
    assert.equal(verify.status, "blocked");
    assert.equal(manager.getWorldProject(first.project.id)?.status, "verifying");

    const retried = manager.createTerrainProject({ userGoal: "clear", source: "user", plan });

    assert.equal(retried.task.id, verify.id);
    assert.equal(retried.task.status, "queued");
  } finally { h.db.close(); }
});

test("reworkable verification mismatches reopen the dig a bounded number of times", () => {
  const h = harness();
  try {
    const manager = new WorldProjectManager(h.projects, h.scheduler, h.bus);
    const first = manager.createTerrainProject({ userGoal: "clear", source: "user", plan: clearPlan() });
    let sliceId = first.task.id;
    const leftover = { ok: false, status: "blocked" as const, errorCode: "UNBREAKABLE_BLOCK" as const, message: "verification failed", retryable: false,
      data: { inspected: 36, verified: 35, mismatches: [{ position: { x: 0, y: 64, z: 0 }, state: "solid", blockName: "stone", errorCode: "UNBREAKABLE_BLOCK" }] } };
    for (let round = 1; round <= 3; round += 1) {
      const verify = completeSlice(h, manager, sliceId);
        assert.equal(manager.settleChildTask(verify, leftover), "complete", `round ${round} reopens`);
      h.scheduler.completeActive();
      const project = manager.getWorldProject(first.project.id);
      assert.equal(project?.status, "active");
      assert.equal(project?.verificationState.reopens, round);
      const slice = activeTask(h);
      assert.equal(slice?.type, "world_project_slice");
      sliceId = slice!.id;
    }
    const verify = completeSlice(h, manager, sliceId);
    assert.equal(manager.settleChildTask(verify, leftover), "block");
    assert.equal(manager.getWorldProject(first.project.id)?.status, "blocked");
  } finally { h.db.close(); }
});

test("lava found during verification blocks instead of reopening", () => {
  const h = harness();
  try {
    const manager = new WorldProjectManager(h.projects, h.scheduler, h.bus);
    const first = manager.createTerrainProject({ userGoal: "clear", source: "user", plan: clearPlan() });
    const verify = completeSlice(h, manager, first.task.id);
    const lava = { ok: false, status: "blocked" as const, errorCode: "LAVA_HAZARD" as const, message: "verification failed", retryable: false,
      data: { inspected: 36, verified: 35, mismatches: [{ position: { x: 0, y: 64, z: 0 }, state: "fluid", blockName: "lava", errorCode: "LAVA_HAZARD" }] } };
    assert.equal(manager.settleChildTask(verify, lava), "block");
    assert.equal(manager.getWorldProject(first.project.id)?.status, "blocked");
  } finally { h.db.close(); }
});

test("a child task that throws parks its project as paused, and the command resumes it", () => {
  const h = harness();
  try {
    const manager = new WorldProjectManager(h.projects, h.scheduler, h.bus);
    const plan = clearPlan();
    const first = manager.createTerrainProject({ userGoal: "clear", source: "user", plan });
    assert.equal(activeTask(h)?.id, first.task.id);
    h.scheduler.failActive("execution threw: AbortError");
    assert.equal(manager.getWorldProject(first.project.id)?.status, "paused");

    const retried = manager.createTerrainProject({ userGoal: "clear", source: "user", plan });
    assert.equal(retried.resumed, true);
    assert.equal(retried.project.id, first.project.id);
    assert.equal(retried.task.type, "world_project_slice");
    assert.equal(manager.getWorldProject(first.project.id)?.status, "active");
  } finally { h.db.close(); }
});

test("a shaft out of bridging blocks fetches material and then resumes", () => {
  const h = harness();
  try {
    const manager = new WorldProjectManager(h.projects, h.scheduler, h.bus);
    const first = manager.createTerrainProject({ userGoal: "clear", source: "user", plan: clearPlan() });
    const slice = activeTask(h)!;
    const outcome = manager.settleChildTask(slice, { ok: false, status: "blocked", errorCode: "INSUFFICIENT_MATERIALS", message: "the shaft crosses a cave and needs cobblestone or dirt to bridge the floor", retryable: true });
    assert.equal(outcome, "block");
    h.scheduler.blockActive("needs bridging blocks");
    const fetch = activeTask(h);
    assert.equal(fetch?.type, "world_project_acquire");
    assert.equal(fetch?.parameters.item, "cobblestone");
    assert.equal(manager.settleChildTask(fetch!, { ok: true, status: "completed" }), "complete");
    h.scheduler.completeActive();
    assert.equal(activeTask(h)?.id, slice.id, "the blocked slice resumes");
    assert.equal(manager.getWorldProject(first.project.id)?.status, "active");
  } finally { h.db.close(); }
});
