import assert from "node:assert/strict";
import { test } from "node:test";
import { EventBus } from "../events/bus.js";
import { AppDatabase } from "../memory/database.js";
import { MIGRATIONS } from "../memory/migrations.js";
import { TasksRepository } from "../memory/tasks.js";
import { Scheduler } from "./scheduler.js";
import { TaskPriority, TaskStatus, type NewTask } from "./task.js";

interface Harness {
  db: AppDatabase;
  tasks: TasksRepository;
  bus: EventBus;
  scheduler: Scheduler;
}

function newHarness(): Harness {
  const db = new AppDatabase(":memory:");
  db.runMigrations(MIGRATIONS);
  const tasks = new TasksRepository(db);
  const bus = new EventBus();
  const scheduler = new Scheduler({ bus, tasks });
  return { db, tasks, bus, scheduler };
}

/** A user-requested gather task (the Phase 8 acceptance workload). */
function userTask(objective: string): NewTask {
  return {
    type: "collect_resource",
    priority: TaskPriority.FOREGROUND,
    source: "user",
    objective,
    parameters: { resource: "oak_log", quantity: 32 },
  };
}

function maintenanceTask(objective: string): NewTask {
  return {
    type: "stockpile_maintenance",
    priority: TaskPriority.MAINTENANCE,
    source: "background",
    objective,
    parameters: { kind: "food", target: 64, current: 4, deficit: 60 },
  };
}

test("claim activates the highest-priority queued task when the slot is free", () => {
  const { scheduler: s } = newHarness();
  const task = s.enqueue(userTask("Gather 32 oak logs."));
  assert.equal(s.claim()?.id, task.id);
  assert.equal(s.active?.id, task.id);
  assert.equal(task.status, TaskStatus.ACTIVE);
});

test("a foreground user task preempts an active background task with cooperative pause", () => {
  const { scheduler: s } = newHarness();
  const background = s.enqueue({
    type: "stockpile_maintenance",
    priority: TaskPriority.BACKGROUND,
    source: "background",
    objective: "Restore wood stockpile.",
    parameters: {},
  });
  assert.equal(s.claim()?.id, background.id);

  const foreground = s.enqueue(userTask("Gather 32 iron ore."));
  // The candidate outranks the active task: pause is requested, but the
  // slot stays with the winding-down task until its executor settles.
  assert.equal(s.claim(), null);
  assert.equal(s.interruptPending, true);
  assert.equal(s.active?.id, background.id);

  // The running skill observes the pause at its next checkpoint...
  assert.equal(s.signalsFor(background).checkpoint(), false);
  // ...and the executor settles: background pauses, foreground activates.
  assert.equal(s.settleInterrupted()?.id, foreground.id);
  assert.equal(s.active?.id, foreground.id);
  assert.equal(s.queued.find((t) => t.id === background.id)?.status, TaskStatus.PAUSED);
  assert.equal(s.interruptPending, false);
});

test("hard interrupt cancels the active task and never resumes it", () => {
  const { scheduler: s } = newHarness();
  const task = s.enqueue(userTask("Gather 32 oak logs."));
  s.claim();

  s.requestCancel();
  assert.equal(s.interruptPending, true);
  assert.equal(s.signalsFor(task).checkpoint(), false);

  assert.equal(s.settleInterrupted(), null);
  assert.equal(task.status, TaskStatus.CANCELLED);
  assert.equal(s.active, null);
  assert.equal(s.queued.length, 0);
});

test("checkpoint persists resume state to the database", () => {
  const { scheduler: s, tasks } = newHarness();
  const task = s.enqueue(userTask("Gather 32 oak logs."));
  s.claim();

  const signals = s.signalsFor(task);
  assert.equal(signals.checkpoint({ attemptedSites: ["1,64,2", "3,64,4"], interruptions: 2 }), true);

  const reloaded = tasks.get(task.id);
  assert.deepEqual(reloaded?.resumeState, { attemptedSites: ["1,64,2", "3,64,4"], interruptions: 2 });
});

test("requeueActive preserves resumable progress and activates the next task", () => {
  const { scheduler: s, tasks, bus } = newHarness();
  const requeued: string[] = [];
  bus.on("task.requeued", ({ task }) => requeued.push(task.id));
  const resumable = s.enqueue({ ...userTask("Build a design."), type: "build_design", executionPolicy: "resumable" });
  const next = s.enqueue(userTask("Gather materials."));
  s.claim();
  s.signalsFor(resumable).checkpoint({ operationIndex: 12 });

  assert.equal(s.requeueActive("slice budget reached")?.id, next.id);
  assert.equal(resumable.status, TaskStatus.QUEUED);
  assert.deepEqual(tasks.get(resumable.id)?.resumeState, { operationIndex: 12 });
  assert.deepEqual(requeued, [resumable.id]);
  assert.equal(s.active?.id, next.id);
});

test("blockActive retains blocked work as live persisted task", () => {
  const { scheduler: s, tasks } = newHarness();
  const task = s.enqueue(userTask("Build a design."));
  s.claim();

  assert.equal(s.blockActive("missing material"), null);
  assert.equal(task.status, TaskStatus.BLOCKED);
  assert.equal(tasks.get(task.id)?.status, TaskStatus.BLOCKED);
  assert.equal(s.queued.find((candidate) => candidate.id === task.id)?.status, TaskStatus.BLOCKED);
});

test("Phase 8 acceptance: wood -> iron -> food maintenance -> iron -> wood", () => {
  const { scheduler: s, bus } = newHarness();
  const activated: string[] = [];
  bus.on("task.activated", ({ task }) => activated.push(task.objective));

  // CobbleBob gathers wood.
  const wood = s.enqueue(userTask("Gather 32 oak logs."));
  s.claim();
  assert.equal(s.active?.id, wood.id);

  // User requests iron: wood pauses, iron runs.
  const iron = s.enqueue(userTask("Gather 32 iron ore."));
  s.claim();
  s.settleInterrupted();
  assert.equal(s.active?.id, iron.id);
  assert.equal(s.queued.find((t) => t.id === wood.id)?.status, TaskStatus.PAUSED);

  // Food runs low: maintenance preempts iron.
  const food = s.enqueue(maintenanceTask("Restore food stockpile to 64."));
  s.claim();
  s.settleInterrupted();
  assert.equal(s.active?.id, food.id);
  assert.equal(s.queued.find((t) => t.id === iron.id)?.status, TaskStatus.PAUSED);

  // Food restored, iron finishes, wood resumes last (LIFO among paused).
  s.completeActive();
  assert.equal(s.active?.id, iron.id);
  s.completeActive();
  assert.equal(s.active?.id, wood.id);
  s.completeActive();
  assert.equal(s.active, null);

  assert.deepEqual(activated, [
    "Gather 32 oak logs.",
    "Gather 32 iron ore.",
    "Restore food stockpile to 64.",
    "Gather 32 iron ore.",
    "Gather 32 oak logs.",
  ]);
  assert.equal(wood.status, TaskStatus.COMPLETED);
  assert.equal(iron.status, TaskStatus.COMPLETED);
  assert.equal(food.status, TaskStatus.COMPLETED);
});

test("at equal priority fresh queued work beats paused work; paused resumes LIFO", () => {
  const { scheduler: s } = newHarness();

  const a = s.enqueue(userTask("A"));
  s.claim();
  const b = s.enqueue(userTask("B"));
  s.claim();
  s.settleInterrupted(); // B active, A paused

  const c = s.enqueue(userTask("C"));
  s.claim();
  s.settleInterrupted(); // C active, A and B paused

  assert.equal(s.active?.objective, "C");
  s.completeActive();
  // B was paused after A, so B resumes first (LIFO).
  assert.equal(s.active?.objective, "B");
  s.completeActive();
  assert.equal(s.active?.objective, "A");
  s.completeActive();
  assert.equal(s.active, null);
});

test("a maintenance task outranks and preempts an active foreground task", () => {
  const { scheduler: s } = newHarness();
  const foreground = s.enqueue(userTask("Gather 32 iron ore."));
  s.claim();
  const maintenance = s.enqueue(maintenanceTask("Restore food stockpile to 64."));
  s.claim();
  assert.equal(s.active?.id, foreground.id); // winding down
  assert.equal(s.settleInterrupted()?.id, maintenance.id);
  assert.equal(s.active?.id, maintenance.id);
  assert.equal(s.queued.find((t) => t.id === foreground.id)?.status, TaskStatus.PAUSED);
});

test("a lower-priority queued task never preempts an active task", () => {
  const { scheduler: s } = newHarness();
  const foreground = s.enqueue(userTask("Gather 32 iron ore."));
  s.claim();
  const maintenance = s.enqueue({
    type: "stockpile_maintenance",
    priority: TaskPriority.BACKGROUND,
    source: "background",
    objective: "Restore wood stockpile.",
    parameters: {},
  });
  assert.equal(s.claim(), null);
  assert.equal(s.interruptPending, false);
  assert.equal(s.active?.id, foreground.id);

  s.completeActive();
  assert.equal(s.active?.id, maintenance.id); // background runs after foreground
});

test("cancelling the active task waits for cooperative settlement before activating the next candidate", () => {
  const { scheduler: s, bus } = newHarness();
  const cancelled: string[] = [];
  const activated: string[] = [];
  bus.on("task.cancelled", ({ task }) => cancelled.push(task.id));
  bus.on("task.activated", ({ task }) => activated.push(task.id));

  const a = s.enqueue(userTask("A"));
  const b = s.enqueue(userTask("B"));
  // Newest queued user instruction wins when nothing is active.
  assert.equal(s.claim()?.id, b.id);

  // Cancellation requests an interrupt but must not free the slot yet.
  assert.equal(s.cancel(b.id)?.id, b.id);
  assert.equal(s.active?.id, b.id);
  assert.equal(b.status, TaskStatus.ACTIVE);
  assert.equal(s.interruptPending, true);
  assert.equal(s.pendingInterruptReason, "cancel");
  assert.equal(s.queued.find((task) => task.id === a.id)?.status, TaskStatus.QUEUED);
  assert.deepEqual(cancelled, []);
  assert.deepEqual(activated, [b.id]);

  // The running skill observes the interrupt and the executor settles it.
  assert.equal(s.signalsFor(b).checkpoint(), false);
  assert.equal(s.settleInterrupted()?.id, a.id);
  assert.equal(b.status, TaskStatus.CANCELLED);
  assert.equal(s.active?.id, a.id);
  assert.deepEqual(cancelled, [b.id]);
  assert.deepEqual(activated, [b.id, a.id]);
});

test("cancelling a queued task does not disturb the active task", () => {
  const { scheduler: s } = newHarness();
  const a = s.enqueue(userTask("A"));
  const b = s.enqueue(userTask("B"));
  assert.equal(s.claim()?.id, b.id);
  assert.equal(s.cancel(a.id)?.id, a.id);
  assert.equal(a.status, TaskStatus.CANCELLED);
  assert.equal(s.active?.id, b.id);
});

test("paused tasks survive a restart and resume from persistence", () => {
  const harness = newHarness();
  const s = harness.scheduler;
  const task = s.enqueue(userTask("Gather 32 oak logs."));
  s.claim();
  s.signalsFor(task).checkpoint({ attemptedSites: ["1,64,2"], interruptions: 1 });
  s.requestPause();
  s.settleInterrupted();
  assert.equal(task.status, TaskStatus.PAUSED);

  // Simulate a restart: a fresh scheduler over the same database.
  const restarted = new Scheduler({ bus: new EventBus(), tasks: new TasksRepository(harness.db) });
  restarted.loadFromPersistence();
  assert.equal(restarted.active?.id ?? null, null);
  assert.equal(restarted.queued.length, 1);

  const resumed = restarted.activateNext();
  assert.equal(resumed?.id, task.id);
  assert.equal(restarted.active?.id, task.id);
  assert.deepEqual(task.resumeState, { attemptedSites: ["1,64,2"], interruptions: 1 });
});

test("restart preserves most-recently-paused ordering", () => {
  const harness = newHarness();
  const s = harness.scheduler;
  const first = s.enqueue(userTask("first"));
  s.claim();
  const second = s.enqueue(userTask("second"));
  s.claim();
  s.settleInterrupted(); // first paused, second active
  const third = s.enqueue(userTask("third"));
  s.claim();
  s.settleInterrupted(); // second paused after first, third active

  const persistedFirst = harness.tasks.get(first.id);
  const persistedSecond = harness.tasks.get(second.id);
  assert.ok((persistedSecond?.pauseSequence ?? 0) > (persistedFirst?.pauseSequence ?? 0));

  const restarted = new Scheduler({ bus: new EventBus(), tasks: new TasksRepository(harness.db) });
  restarted.loadFromPersistence();
  restarted.completeActive();
  assert.equal(restarted.active?.id, second.id);
});

test("an active task rehydrated after a crash is dispatched as ACTIVE", () => {
  const harness = newHarness();
  const s = harness.scheduler;
  const task = s.enqueue(userTask("Gather 32 oak logs."));
  s.claim();
  assert.equal(task.status, TaskStatus.ACTIVE);

  const restarted = new Scheduler({ bus: new EventBus(), tasks: new TasksRepository(harness.db) });
  restarted.loadFromPersistence();
  assert.equal(restarted.active?.id, task.id);
  assert.equal(restarted.queued.length, 0);
});
