import assert from "node:assert/strict";
import { test } from "node:test";
import { EventBus } from "../events/bus.js";
import { AppDatabase } from "../memory/database.js";
import { MIGRATIONS } from "../memory/migrations.js";
import { ActionsRepository } from "../memory/actions.js";
import { TasksRepository } from "../memory/tasks.js";
import { Scheduler } from "./scheduler.js";
import { TaskPriority, TaskStatus } from "./task.js";
import { ActionWatchdog } from "./watchdog.js";

const action = "collect_resource:coal:32";
let now = 0;
const clock = (): number => now;

function setup() {
  const db = new AppDatabase(":memory:");
  db.runMigrations(MIGRATIONS);
  const persistence = new ActionsRepository(db);
  const watchdog = new ActionWatchdog({ maxFailures: 2, cooldownMs: 60_000, now: clock, persistence });
  return { db, persistence, watchdog };
}

function task() {
  return { type: "collect_resource", priority: TaskPriority.BACKGROUND, source: "background" as const, objective: "coal", parameters: { resource: "coal", quantity: 32 } };
}

test("watchdog block and failure count survive restart", () => {
  now = 0;
  const first = setup();
  first.watchdog.record(action, "failure", false, "no ore");
  first.watchdog.record(action, "failure", false, "no ore");

  const secondWatchdog = new ActionWatchdog({ maxFailures: 2, cooldownMs: 60_000, now: clock, persistence: first.persistence });
  secondWatchdog.rehydrate();
  const scheduler = new Scheduler({ bus: new EventBus(), tasks: new TasksRepository(first.db), watchdog: secondWatchdog });
  const blocked = scheduler.enqueue(task());
  assert.equal(scheduler.claim(), null);
  assert.equal(blocked.status, TaskStatus.BLOCKED);
  now = 60_001;
  assert.equal(scheduler.claim()?.id, blocked.id);
});

test("failure streak continues after restart", () => {
  now = 0;
  const first = setup();
  first.watchdog.record(action, "failure");
  const second = new ActionWatchdog({ maxFailures: 2, cooldownMs: 60_000, now: clock, persistence: first.persistence });
  second.rehydrate();
  second.record(action, "failure");
  assert.equal(second.isBlocked(action), true);
});

test("owner intent removes persisted watchdog state", () => {
  now = 0;
  const { persistence, watchdog } = setup();
  watchdog.record(action, "failure");
  watchdog.noteOwnerIntent(action);
  const restored = new ActionWatchdog({ now: clock, persistence });
  restored.rehydrate();
  assert.equal(restored.failureCount(action), 0);
  assert.equal(restored.blockFor(action), null);
});

test("expired persisted blocks release parked tasks after restart and status reads", () => {
  now = 0;
  const { db, persistence, watchdog } = setup();
  watchdog.record(action, "failure");
  watchdog.record(action, "failure");
  const tasks = new TasksRepository(db);
  const scheduler = new Scheduler({ bus: new EventBus(), tasks, watchdog });
  const parked = scheduler.enqueue(task());
  assert.equal(scheduler.claim(), null);
  now = 60_001;
  const restored = new ActionWatchdog({ now: clock, persistence });
  restored.rehydrate();
  assert.equal(restored.blockFor(action), null);
  assert.deepEqual(restored.activeBlocks(), []);
  const restarted = new Scheduler({ bus: new EventBus(), tasks, watchdog: restored });
  restarted.loadFromPersistence();
  assert.equal(restarted.claim()?.id, parked.id);
  assert.equal(persistence.loadAll().length, 0);
});


test("a legacy watchdog task whose expiry record was deleted is recovered", () => {
  now = 0;
  const { db, persistence, watchdog } = setup();
  watchdog.record(action, "failure");
  watchdog.record(action, "failure");
  const tasks = new TasksRepository(db);
  const scheduler = new Scheduler({ bus: new EventBus(), tasks, watchdog });
  const parked = scheduler.enqueue(task());
  assert.equal(scheduler.claim(), null);
  persistence.remove(action); // Legacy activeBlocks() deleted this at expiry.
  now = 60_001;
  const restored = new ActionWatchdog({ now: clock, persistence });
  restored.rehydrate();
  const restarted = new Scheduler({ bus: new EventBus(), tasks, watchdog: restored });
  restarted.loadFromPersistence();
  assert.equal(restarted.claim()?.id, parked.id);
});
