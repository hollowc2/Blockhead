import assert from "node:assert/strict";
import { test } from "node:test";
import { EventBus } from "../events/bus.js";
import { AppDatabase } from "../memory/database.js";
import { MIGRATIONS } from "../memory/migrations.js";
import { TasksRepository } from "../memory/tasks.js";
import { Scheduler } from "./scheduler.js";
import { TaskPriority, TaskStatus, type NewTask } from "./task.js";
import { ActionWatchdog, actionFingerprint } from "./watchdog.js";

/** A controlled wall clock shared by the watchdog under test. */
let now = 0;
const clock = (): number => now;
const advance = (ms: number): void => {
  now += ms;
};

interface Harness {
  tasks: TasksRepository;
  bus: EventBus;
  watchdog: ActionWatchdog;
  scheduler: Scheduler;
}

function newHarness(options: { maxFailures?: number; cooldownMs?: number } = {}): Harness {
  const db = new AppDatabase(":memory:");
  db.runMigrations(MIGRATIONS);
  const tasks = new TasksRepository(db);
  const bus = new EventBus();
  const watchdog = new ActionWatchdog({
    maxFailures: options.maxFailures ?? 2,
    cooldownMs: options.cooldownMs ?? 60_000,
    now: clock,
  });
  const scheduler = new Scheduler({ bus, tasks, watchdog });
  return { tasks, bus, watchdog, scheduler };
}

const COAL_32 = "collect_resource:coal:32";
const COAL_64 = "collect_resource:coal:64";

function backgroundTask(type: string, parameters: Record<string, unknown>, objective = type): NewTask {
  return { type, priority: TaskPriority.BACKGROUND, source: "background", objective, parameters };
}

function userCoalTask(): NewTask {
  return {
    type: "collect_resource",
    priority: TaskPriority.FOREGROUND,
    source: "user",
    objective: "Gather 32 coal.",
    parameters: { resource: "coal", quantity: 32 },
  };
}

test("repeated failures of the same action cause a block", () => {
  now = 0;
  const watchdog = new ActionWatchdog({ maxFailures: 3, now: clock });
  watchdog.record(COAL_32, "failure", false, "no coal within 1024 blocks");
  watchdog.record(COAL_32, "failure", false, "no coal within 1024 blocks");
  assert.equal(watchdog.isBlocked(COAL_32), false, "below the threshold the action may run");
  watchdog.record(COAL_32, "failure", false, "no coal within 1024 blocks");
  assert.equal(watchdog.isBlocked(COAL_32), true, "at the threshold the action is blocked");
  const block = watchdog.blockFor(COAL_32);
  assert.equal(block?.failures, 3);
  assert.equal(block?.lastReason, "no coal within 1024 blocks");
});

test("a blocked action is not immediately rescheduled; the scheduler holds it as BLOCKED", () => {
  now = 0;
  const { scheduler, watchdog } = newHarness({ maxFailures: 2 });
  watchdog.record(COAL_32, "failure", false, "no ore in range");
  watchdog.record(COAL_32, "failure", false, "no ore in range");

  const task = scheduler.enqueue(backgroundTask("collect_resource", { resource: "coal", quantity: 32 }));
  assert.equal(scheduler.claim(), null, "nothing activates while the action is blocked");
  assert.equal(scheduler.active, null);
  assert.equal(task.status, TaskStatus.BLOCKED);

  // A fresh identical task stands down too: the block is on the ACTION, not
  // one task instance.
  const again = scheduler.enqueue(backgroundTask("collect_resource", { resource: "coal", quantity: 32 }));
  assert.equal(scheduler.claim(), null);
  assert.equal(again.status, TaskStatus.BLOCKED);
});

test("different arguments produce different fingerprints, so blocks do not collide", () => {
  now = 0;
  assert.equal(actionFingerprint("collect_resource", { resource: "coal", quantity: 32 }), COAL_32);
  assert.notEqual(COAL_32, COAL_64, "a different quantity is a different goal");
  assert.notEqual(
    COAL_32,
    actionFingerprint("collect_resource", { resource: "iron_ore", quantity: 32 }),
    "a different resource is a different goal",
  );
  assert.equal(actionFingerprint("collect_resource", { resource: " coal ", quantity: 32.9 }), COAL_32, "names trim and quantities floor");
  assert.equal(actionFingerprint("build_base", {}), "build_base:starter");
  assert.equal(actionFingerprint("go_home", {}), "go_home");

  const { scheduler, watchdog } = newHarness({ maxFailures: 2 });
  watchdog.record(COAL_32, "failure", false, "no ore in range");
  watchdog.record(COAL_32, "failure", false, "no ore in range");
  const other = scheduler.enqueue(backgroundTask("collect_resource", { resource: "coal", quantity: 64 }));
  assert.equal(scheduler.claim()?.id, other.id, "a different argument is not blocked by this action's block");
  assert.equal(other.status, TaskStatus.ACTIVE);
});

test("success clears failure state; partial progress reduces it", () => {
  now = 0;
  const watchdog = new ActionWatchdog({ maxFailures: 3, now: clock });

  // Success resets below-threshold failures.
  watchdog.record(COAL_32, "failure");
  watchdog.record(COAL_32, "failure");
  watchdog.record(COAL_32, "success");
  assert.equal(watchdog.failureCount(COAL_32), 0);
  watchdog.record(COAL_32, "failure");
  assert.equal(watchdog.isBlocked(COAL_32), false, "the count restarted after the success");

  // Partial progress halves the count (floor), so two failures + a partial
  // run buys back attempts instead of accumulating.
  watchdog.record(COAL_32, "failure");
  watchdog.record(COAL_32, "failure");
  watchdog.record(COAL_32, "partial");
  watchdog.record(COAL_32, "failure");
  assert.equal(watchdog.isBlocked(COAL_32), false, "2 -> partial -> 1 -> failure -> 2 is under the threshold");
  watchdog.record(COAL_32, "failure");
  assert.equal(watchdog.isBlocked(COAL_32), true);

  // Success clears an active block outright.
  watchdog.record(COAL_32, "success");
  assert.equal(watchdog.blockFor(COAL_32), null);
  assert.equal(watchdog.failureCount(COAL_32), 0);

  // Partial progress lifts an active block (progress means not stuck).
  watchdog.record(COAL_32, "failure");
  watchdog.record(COAL_32, "failure");
  watchdog.record(COAL_32, "failure");
  assert.equal(watchdog.isBlocked(COAL_32), true);
  watchdog.record(COAL_32, "partial");
  assert.equal(watchdog.blockFor(COAL_32), null, "3 -> partial -> 1 lifts the block");
});

test("cooldown expiry allows exactly one retry", () => {
  now = 0;
  const { scheduler, watchdog } = newHarness({ maxFailures: 2, cooldownMs: 60_000 });
  watchdog.record(COAL_32, "failure");
  watchdog.record(COAL_32, "failure");

  const task = scheduler.enqueue(backgroundTask("collect_resource", { resource: "coal", quantity: 32 }));
  assert.equal(scheduler.claim(), null);
  assert.equal(task.status, TaskStatus.BLOCKED);

  advance(30_000);
  assert.equal(scheduler.claim(), null, "still inside the cooldown window");
  assert.equal(task.status, TaskStatus.BLOCKED);

  advance(30_001);
  assert.equal(scheduler.claim()?.id, task.id, "after the cooldown the held task runs again");
  assert.equal(task.status, TaskStatus.ACTIVE);
  assert.equal(scheduler.active?.id, task.id);
});

test("owner-issued commands bypass the block and reset the failure state", () => {
  now = 0;
  const { scheduler, watchdog } = newHarness({ maxFailures: 2 });
  watchdog.record(COAL_32, "failure");
  watchdog.record(COAL_32, "failure");
  assert.equal(watchdog.isBlocked(COAL_32), true);

  const owner = scheduler.enqueue(userCoalTask());
  assert.equal(scheduler.claim()?.id, owner.id, "an explicit owner command always runs");
  assert.equal(owner.status, TaskStatus.ACTIVE);

  // The owner's run resets the action's failure state, so later failures
  // start over instead of inheriting the block.
  watchdog.record(COAL_32, "failure", true);
  assert.equal(watchdog.failureCount(COAL_32), 1);
  assert.equal(watchdog.isBlocked(COAL_32), false);

  watchdog.record(COAL_32, "failure");
  watchdog.record(COAL_32, "failure");
  watchdog.noteOwnerIntent(COAL_32);
  assert.equal(watchdog.isBlocked(COAL_32), false, "fresh owner intent clears an active block");
});

test("blocked actions are surfaced to the LLM context with a reason and retry time", () => {
  now = 0;
  const { scheduler, watchdog } = newHarness({ maxFailures: 2, cooldownMs: 60_000 });
  watchdog.record(COAL_32, "failure", false, "no ore in range");
  watchdog.record(COAL_32, "failure", false, "no ore in range");

  const blocks = scheduler.blockedActions();
  assert.equal(blocks.length, 1);
  const block = blocks[0]!;
  assert.equal(block.action, COAL_32);
  assert.match(block.reason, /2 failed attempts/);
  assert.match(block.reason, /no ore in range/);
  assert.ok(block.retryInSeconds > 0 && block.retryInSeconds <= 60, "retry window is within the cooldown");
});