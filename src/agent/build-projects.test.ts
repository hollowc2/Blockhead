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

test("identical phase labels from separate projects receive distinct stored IDs", () => {
  const h = harness();
  try {
    const manager = new BuildProjectManager(h.projects, h.scheduler, h.bus);
    const design = landmarkTemplate("castle", "small");
    const first = manager.createOrResume({ userGoal: "Build a castle", structureType: "castle", source: "user", design, origin });
    const second = manager.createOrResume({
      userGoal: "Build a second castle",
      structureType: "castle",
      source: "user",
      design,
      origin: { ...origin, x: origin.x + 100 },
    });
    const firstPhase = h.projects.getPhases(first.project.id)[0]!;
    const secondPhase = h.projects.getPhases(second.project.id)[0]!;

    assert.equal(first.resumed, false);
    assert.equal(second.resumed, false);
    assert.equal(firstPhase.label, secondPhase.label);
    assert.notEqual(firstPhase.id, secondPhase.id);
    assert.ok(firstPhase.id.startsWith(`${first.project.id}:`));
    assert.ok(secondPhase.id.startsWith(`${second.project.id}:`));
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
    const finalCells = new Set(first.project.blueprint.operations.map((operation) => `${operation.absolute?.dimension}:${operation.absolute?.x},${operation.absolute?.y},${operation.absolute?.z}`)).size;
    assert.equal(manager.settleChildTask(verification, { ok: true, status: "completed", data: { inspected: finalCells, verified: finalCells, mismatches: [] } }), "complete");
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

test("rehydration safely reactivates a recoverable frozen blueprint at the exact cursor", () => {
  const h = harness();
  try {
    const manager = new BuildProjectManager(h.projects, h.scheduler, h.bus);
    const created = manager.createOrResume({ userGoal: "Build a castle", structureType: "castle", source: "user", design: landmarkTemplate("castle", "small"), origin });
    const phase = h.projects.getPhases(created.project.id)[0]!;
    const project = h.projects.get(created.project.id)!;
    project.compilerVersion = "1.0.0";
    project.blueprint.operations[phase.operationStart] = { id: "op-00450", x: 0, y: 2, z: 0, material: "stone_bricks", phase: "structural_shell", replaceExisting: false, structural: true };
    project.blueprint.operations[project.blueprint.operations.length - 1] = { id: "op-door-upper", x: 0, y: 1, z: 0, material: "oak_door", phase: "doors_windows", replaceExisting: true, structural: false };
    h.projects.update(project);
    assert.equal(h.scheduler.claim()?.id, created.task.id);
    manager.settleChildTask(created.task, { ok: false, status: "blocked", errorCode: "UNSUPPORTED_OPERATION", message: "design operation op-00450 has no authoritative support block", data: { currentOperationIndex: phase.operationStart, verified: 0, remaining: phase.totalOperations } });
    h.scheduler.blockActive("design operation op-00450 has no authoritative support block");

    const restartedScheduler = new Scheduler({ bus: new EventBus(), tasks: h.tasks });
    restartedScheduler.loadFromPersistence();
    const restartedManager = new BuildProjectManager(h.projects, restartedScheduler, new EventBus());
    restartedManager.rehydrate();

    const recovered = h.projects.get(project.id)!;
    assert.equal(recovered.status, "active");
    assert.equal(recovered.resumeState.currentOperationIndex, phase.operationStart);
    assert.equal(recovered.verificationState.verifiedOperations, 0);
    assert.equal(restartedScheduler.queued[0]?.status, TaskStatus.QUEUED);
  } finally {
    h.db.close();
  }
});

test("legacy project progress never regresses behind an advanced global cursor", () => {
  const h = harness();
  try {
    const manager = new BuildProjectManager(h.projects, h.scheduler, h.bus);
    const created = manager.createOrResume({ userGoal: "Build a castle", structureType: "castle", source: "user", design: landmarkTemplate("castle", "small"), origin });
    const phase = h.projects.getPhases(created.project.id)[0]!;
    const project = h.projects.get(created.project.id)!;
    project.verificationState.verifiedOperations = 7;
    h.projects.update(project);
    manager.settleChildTask(created.task, { ok: false, status: "partial", retryable: true, data: { currentOperationIndex: phase.operationStart + 12, verified: 5, remaining: phase.totalOperations - 12 } });
    const reconciled = h.projects.get(project.id)!;
    assert.equal(reconciled.resumeState.currentOperationIndex, phase.operationStart + 12);
    assert.equal(reconciled.verificationState.verifiedOperations, phase.operationStart + 12);
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

test("an active development build whose slice the scheduler blocked is retried too", async () => {
  // 2026-10-06 01:01: the cottage slice "made no progress repeatedly" (the
  // roof cell held the bot's head) and was blocked, but the project stayed
  // active, so the blocked-project retry never saw it.
  const { villageDesign } = await import("../building/village.js");
  const h = harness();
  try {
    const manager = new BuildProjectManager(h.projects, h.scheduler, h.bus);
    const village = manager.createOrResume({ userGoal: "Develop the land", structureType: "village:cottage", source: "goal", design: villageDesign("cottage"), origin });
    h.scheduler.claim();
    h.scheduler.blockActive("no progress after 4 attempts: design slice could not verify operation op-00127");
    const project = h.projects.get(village.project.id)!;
    assert.equal(project.status, "active");
    project.updatedAt = "2026-10-06T08:01:50.000Z";
    h.projects.update(project);
    const isVillage = (p: { structureType?: string }) => p.structureType?.startsWith("village:") === true;
    assert.equal(manager.retryBlocked(isVillage, 5 * 60_000, Date.parse("2026-10-06T08:03:00.000Z")), 0, "not yet");
    assert.equal(manager.retryBlocked(isVillage, 5 * 60_000, Date.parse("2026-10-06T08:27:00.000Z")), 1);
    assert.ok(h.scheduler.queued.some((task) => task.projectId === village.project.id && task.status === TaskStatus.QUEUED), "its slice is queued again");
  } finally {
    h.db.close();
  }
});

test("a blocked development build is retried after a while; an owner's blocked build is not", async () => {
  // 2026-10-05: the second cottage blocked on a torch and, blocked, held the
  // one-building slot so no further building could start.
  const { villageDesign } = await import("../building/village.js");
  const h = harness();
  try {
    const manager = new BuildProjectManager(h.projects, h.scheduler, h.bus);
    const block = (projectId: string, at: string) => {
      const project = h.projects.get(projectId)!;
      project.status = "blocked";
      project.lastError = "design blocked at 0,64,0 by torch";
      project.updatedAt = at;
      h.projects.update(project);
      for (const phase of h.projects.getPhases(projectId)) { if (phase.status === "active") { phase.status = "blocked"; h.projects.updatePhase(phase); } }
    };
    const village = manager.createOrResume({ userGoal: "Develop the land", structureType: "village:cottage", source: "goal", design: villageDesign("cottage"), origin });
    h.scheduler.claim();
    h.scheduler.blockActive("design blocked at 0,64,0 by torch");
    block(village.project.id, "2026-10-05T22:57:42.000Z");
    const owner = manager.createOrResume({ userGoal: "Build a castle", structureType: "castle", source: "user", design: landmarkTemplate("castle", "small"), origin: { ...origin, x: 200 } });
    block(owner.project.id, "2026-10-04T03:18:10.000Z");
    const isVillage = (p: { structureType?: string }) => p.structureType?.startsWith("village:") === true;

    assert.equal(manager.retryBlocked(isVillage, 5 * 60_000, Date.parse("2026-10-05T22:59:00.000Z")), 0, "not yet: blocked under 5 minutes");
    assert.equal(manager.retryBlocked(isVillage, 5 * 60_000, Date.parse("2026-10-05T23:10:00.000Z")), 1);
    assert.equal(h.projects.get(village.project.id)!.status, "active");
    assert.equal(h.projects.get(owner.project.id)!.status, "blocked", "the owner's build waits for the owner");
  } finally {
    h.db.close();
  }
});

test("a finished development building keeps its whole site reserved", async () => {
  // 2026-10-06 06:45: a slim watchtower's site read as open ground and a
  // second watchtower was started on top of the first.
  const { villageDesign } = await import("../building/village.js");
  const h = harness();
  try {
    const manager = new BuildProjectManager(h.projects, h.scheduler, h.bus);
    const tower = manager.createOrResume({ userGoal: "Develop the land", structureType: "village:watchtower", source: "goal", design: villageDesign("watchtower"), origin });
    const project = h.projects.get(tower.project.id)!;
    project.status = "completed";
    h.projects.update(project);
    const cells = manager.siteCells("village:", 7);
    assert.equal(cells.size, 49);
    assert.ok(cells.has(`${origin.x},${origin.y},${origin.z}`));
    assert.ok(cells.has(`${origin.x + 6},${origin.y},${origin.z + 6}`), "the corner the tower leaves open is still the site");
    assert.equal(manager.reservedCells().size, 0, "a finished build no longer reserves its blocks");
  } finally {
    h.db.close();
  }
});

test("a development build that blocks on every retry is given up", async () => {
  // 2026-10-06 06:45: a second watchtower over the first blocked on the
  // first one's door every retry and held the one-building slot.
  const { villageDesign } = await import("../building/village.js");
  const h = harness();
  try {
    const manager = new BuildProjectManager(h.projects, h.scheduler, h.bus);
    const village = manager.createOrResume({ userGoal: "Develop the land", structureType: "village:watchtower", source: "goal", design: villageDesign("watchtower"), origin });
    const isVillage = (p: { structureType?: string }) => p.structureType?.startsWith("village:") === true;
    let t = Date.parse("2026-10-06T14:00:00.000Z");
    for (let i = 0; i < 7; i++) {
      const project = h.projects.get(village.project.id)!;
      if (project.status === "cancelled") break;
      project.status = "blocked";
      project.lastError = "design blocked at 81,96,82 by oak_door";
      project.updatedAt = new Date(t).toISOString();
      h.projects.update(project);
      t += 6 * 60_000;
      manager.retryBlocked(isVillage, 5 * 60_000, t);
    }
    const final = h.projects.get(village.project.id)!;
    assert.equal(final.status, "cancelled");
    assert.match(final.lastError ?? "", /still blocked after 6 retries/);
  } finally {
    h.db.close();
  }
});
