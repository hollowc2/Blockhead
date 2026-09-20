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
import { TaskStatus } from "./task.js";

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

test("a completed slice advances the phase and does not complete the project", () => {
  const h = harness();
  try {
    const manager = new BuildProjectManager(h.projects, h.scheduler, h.bus);
    const first = manager.createOrResume({ userGoal: "Build a castle", structureType: "castle", source: "user", design: landmarkTemplate("castle", "small"), origin });
    const initialPhase = h.projects.getPhases(first.project.id)[0]!;
    const settlement = manager.settleChildTask(first.task, {
      ok: true,
      status: "completed",
      data: { currentOperationIndex: initialPhase.operationEnd, verified: initialPhase.totalOperations, remaining: 0 },
    });

    const project = h.projects.get(first.project.id)!;
    assert.equal(settlement, "complete");
    assert.equal(project.status, "active");
    assert.notEqual(project.currentPhaseId, initialPhase.id);
    assert.equal(h.projects.getPhases(first.project.id)[0]!.status, "completed");
    assert.equal(h.tasks.loadUnfinished().filter((task) => task.projectId === first.project.id).length, 2);
  } finally {
    h.db.close();
  }
});

test("all phases schedule final verification and only a clean scan completes the project", () => {
  const h = harness();
  try {
    const manager = new BuildProjectManager(h.projects, h.scheduler, h.bus);
    const first = manager.createOrResume({ userGoal: "Build a castle", structureType: "castle", source: "user", design: landmarkTemplate("castle", "small"), origin });
    let task = first.task;
    for (;;) {
      const phase = task.projectPhaseId === undefined ? undefined : h.projects.getPhases(first.project.id).find((candidate) => candidate.id === task.projectPhaseId);
      if (phase === undefined) break;
      assert.equal(manager.settleChildTask(task, { ok: true, status: "completed", data: { currentOperationIndex: phase.operationEnd, verified: phase.totalOperations, remaining: 0 } }), "complete");
      const currentProject = h.projects.get(first.project.id)!;
      const next = currentProject.currentPhaseId === undefined ? undefined : h.tasks.loadUnfinished().find((candidate) => candidate.projectId === first.project.id && candidate.type === "build_project_slice" && candidate.projectPhaseId === currentProject.currentPhaseId);
      if (next === undefined) break;
      task = next;
    }

    const projectBeforeVerification = h.projects.get(first.project.id)!;
    assert.equal(projectBeforeVerification.status, "verifying");
    const verification = h.tasks.loadUnfinished().find((candidate) => candidate.type === "build_project_verify");
    assert.ok(verification);
    assert.equal(manager.settleChildTask(verification, { ok: true, status: "completed", data: { inspected: first.project.blueprint.operations.length, verified: first.project.blueprint.operations.length, mismatches: [] } }), "complete");
    assert.equal(h.projects.get(first.project.id)?.status, "completed");
  } finally {
    h.db.close();
  }
});

test("explicit cancellation of a project child cancels the parent and cannot resume it", () => {
  const h = harness();
  try {
    const manager = new BuildProjectManager(h.projects, h.scheduler, h.bus);
    const created = manager.createOrResume({ userGoal: "Build a castle", structureType: "castle", source: "user", design: landmarkTemplate("castle", "small"), origin });
    assert.equal(h.scheduler.claim()?.id, created.task.id);
    h.scheduler.cancel(created.task.id);
    h.scheduler.settleInterrupted();
    assert.equal(created.task.status, TaskStatus.CANCELLED);
    assert.equal(h.projects.get(created.project.id)?.status, "cancelled");
    assert.equal(h.projects.getPhases(created.project.id).some((phase) => phase.status === "active"), true);
  } finally {
    h.db.close();
  }
});

test("a survival shortage blocks the phase and schedules linked acquisition work", () => {
  const h = harness();
  try {
    const manager = new BuildProjectManager(h.projects, h.scheduler, h.bus);
    const created = manager.createOrResume({ userGoal: "Build a castle", structureType: "castle", source: "user", design: landmarkTemplate("castle", "small"), origin });
    const phase = h.projects.getPhases(created.project.id)[0]!;
    const settlement = manager.settleChildTask(created.task, {
      ok: false,
      status: "blocked",
      errorCode: "INSUFFICIENT_MATERIALS",
      message: "missing stone bricks",
      data: { shortages: [{ material: "stone_bricks", required: 8, available: 0 }] },
    });

    const project = h.projects.get(created.project.id)!;
    const acquisition = h.tasks.loadUnfinished().find((task) => task.type === "build_project_acquire");
    assert.equal(settlement, "block");
    assert.equal(project.status, "blocked");
    assert.deepEqual(project.shortages, [{ material: "stone_bricks", required: 8, available: 0 }]);
    assert.equal(h.projects.getPhases(project.id)[0]?.status, "blocked");
    assert.ok(acquisition);
    assert.equal(acquisition?.projectId, project.id);
    assert.equal(acquisition?.projectPhaseId, phase.id);
    assert.equal(acquisition?.parameters.item, "stone_bricks");
    assert.equal(acquisition?.parameters.quantity, 8);
  } finally {
    h.db.close();
  }
});

test("an impossible slice operation blocks the project instead of requeueing forever", () => {
  const h = harness();
  try {
    const manager = new BuildProjectManager(h.projects, h.scheduler, h.bus);
    const created = manager.createOrResume({ userGoal: "Build a castle", structureType: "castle", source: "user", design: landmarkTemplate("castle", "small"), origin });
    assert.equal(h.scheduler.claim()?.id, created.task.id);
    const phase = h.projects.getPhases(created.project.id)[0]!;
    const settlement = manager.settleChildTask(created.task, {
      ok: false,
      status: "blocked",
      errorCode: "UNSUPPORTED_OPERATION",
      message: "design operation op-00450 has no authoritative support block",
      data: { currentOperationIndex: phase.operationStart, verified: phase.operationStart, remaining: phase.totalOperations, firstUnresolvedOperationId: "op-00450" },
    });

    assert.equal(settlement, "block");
    assert.equal(h.projects.get(created.project.id)?.status, "blocked");
    assert.equal(h.projects.getPhases(created.project.id)[0]?.status, "blocked");
    assert.equal(h.tasks.loadUnfinished().filter((task) => task.projectId === created.project.id && task.type === "build_project_slice").length, 1);
    h.scheduler.blockActive("design operation op-00450 has no authoritative support block");
    assert.equal(h.tasks.loadUnfinished().find((task) => task.id === created.task.id)?.status, TaskStatus.BLOCKED);
    assert.equal(h.scheduler.claim(), null, "a blocked project cannot spin up another slice");
  } finally {
    h.db.close();
  }
});

test("successful linked acquisition clears the shortage and resumes the same phase", () => {
  const h = harness();
  try {
    const manager = new BuildProjectManager(h.projects, h.scheduler, h.bus);
    const created = manager.createOrResume({ userGoal: "Build a castle", structureType: "castle", source: "user", design: landmarkTemplate("castle", "small"), origin });
    assert.equal(h.scheduler.claim()?.id, created.task.id);
    manager.settleChildTask(created.task, {
      ok: false,
      status: "blocked",
      errorCode: "INSUFFICIENT_MATERIALS",
      data: { shortages: [{ material: "stone_bricks", required: 8, available: 0 }] },
    });
    h.scheduler.blockActive("missing stone bricks");
    const acquisition = h.tasks.loadUnfinished().find((task) => task.type === "build_project_acquire")!;
    assert.equal(h.scheduler.active?.id, acquisition.id);
    assert.equal(manager.settleChildTask(acquisition, {
      ok: true,
      status: "completed",
      message: "acquired",
      data: { item: "stone_bricks", quantity: 8, availableAtEnd: 8 },
    }), "complete");

    const project = h.projects.get(created.project.id)!;
    const phase = h.projects.getPhases(project.id)[0]!;
    assert.equal(project.status, "active");
    assert.deepEqual(project.shortages, []);
    assert.equal(phase.status, "active");
    assert.equal(h.tasks.loadUnfinished().find((task) => task.workKey === `build-project:${project.id}:${phase.id}`)?.status, TaskStatus.QUEUED);
  } finally {
    h.db.close();
  }
});

test("completed acquisition without authoritative inventory reconciliation remains blocked", () => {
  const h = harness();
  try {
    const manager = new BuildProjectManager(h.projects, h.scheduler, h.bus);
    const created = manager.createOrResume({ userGoal: "Build a castle", structureType: "castle", source: "user", design: landmarkTemplate("castle", "small"), origin });
    manager.settleChildTask(created.task, {
      ok: false,
      status: "blocked",
      errorCode: "INSUFFICIENT_MATERIALS",
      data: { shortages: [{ material: "stone_bricks", required: 8, available: 0 }] },
    });
    const acquisition = h.tasks.loadUnfinished().find((task) => task.type === "build_project_acquire")!;
    assert.equal(manager.settleChildTask(acquisition, { ok: true, status: "completed", message: "reported success" }), "block");
    const project = h.projects.get(created.project.id)!;
    assert.equal(project.status, "blocked");
    assert.deepEqual(project.shortages, [{ material: "stone_bricks", required: 8, available: 0 }]);
    assert.match(project.lastError ?? "", /without reconciling/);
  } finally {
    h.db.close();
  }
});

test("retryable acquisition failure persists a bounded durable backoff", () => {
  const h = harness();
  try {
    const manager = new BuildProjectManager(h.projects, h.scheduler, h.bus);
    const created = manager.createOrResume({ userGoal: "Build a castle", structureType: "castle", source: "user", design: landmarkTemplate("castle", "small"), origin });
    manager.settleChildTask(created.task, {
      ok: false,
      status: "blocked",
      errorCode: "INSUFFICIENT_MATERIALS",
      data: { shortages: [{ material: "stone_bricks", required: 8, available: 0 }] },
    });
    const acquisition = h.tasks.loadUnfinished().find((task) => task.type === "build_project_acquire")!;
    assert.equal(manager.settleChildTask(acquisition, { ok: false, status: "failed", retryable: true, message: "no safe route" }), "block");

    const project = h.projects.get(created.project.id)!;
    assert.equal(project.status, "blocked");
    assert.ok(project.resumeState.retryAfter);
    assert.ok(Date.parse(project.resumeState.retryAfter!) > Date.now());
    assert.match(project.lastError ?? "", /no safe route/);
  } finally {
    h.db.close();
  }
});
