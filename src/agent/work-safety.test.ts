import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bot } from "mineflayer";
import pino from "pino";
import { Vec3 } from "vec3";
import { EventBus } from "../events/bus.js";
import { AppDatabase } from "../memory/database.js";
import { MIGRATIONS } from "../memory/migrations.js";
import { TasksRepository } from "../memory/tasks.js";
import { Scheduler } from "./scheduler.js";
import { TaskPriority, TaskStatus } from "./task.js";
import { WorkSafetyCoordinator, taskSafeToRun } from "./work-safety.js";

function harness() {
  const db = new AppDatabase(":memory:"); db.runMigrations(MIGRATIONS);
  const bus = new EventBus();
  const scheduler = new Scheduler({ bus, tasks: new TasksRepository(db) });
  const bot = { health: 20, entity: { position: new Vec3(0, 64, 0) }, entities: {} } as unknown as Bot;
  const safety = new WorkSafetyCoordinator({ bot, scheduler, bus, logger: pino({ level: "silent" }) });
  safety.attach();
  return { db, bot, bus, scheduler, safety, close: () => { safety.detach(); db.close(); } };
}
test("a healthy checkpoint waits for carried food while bread retrieval can run", () => {
  const h = harness();
  try {
    h.bot.food = 20;
    const stock: { name: string; count: number }[] = [];
    h.bot.inventory = { items: () => stock } as never;
    const work = h.scheduler.enqueue({ type: "upgrade_equipment", source: "goal", priority: TaskPriority.BACKGROUND, objective: "tools", parameters: {} });
    assert.equal(h.scheduler.claim(), null);
    assert.equal(h.scheduler.activate(work.id), null);
    const food = h.scheduler.enqueue({ type: "ensure_item", source: "background", priority: TaskPriority.MAINTENANCE, objective: "food", parameters: { item: "bread", quantity: 6 } });
    assert.equal(taskSafeToRun(h.bot, food), true);
    assert.equal(h.scheduler.claim()?.id, food.id);
    stock.push({ name: "bread", count: 6 });
    h.scheduler.completeActive();
    assert.equal(h.scheduler.active?.id, work.id);
  } finally { h.close(); }
});
test("a failed retreat cannot resume a discretionary checkpoint while hurt", () => {
  const h = harness();
  try {
    const work = h.scheduler.enqueue({ type: "upgrade_equipment", source: "background", priority: TaskPriority.BACKGROUND, objective: "tools", parameters: {} });
    h.scheduler.claim(); h.scheduler.checkpoint({ gathered: 3 });
    h.scheduler.enqueue({ type: "defend_self", source: "maintenance", priority: TaskPriority.REFLEX, objective: "fight", parameters: {} });
    h.scheduler.claim(); h.scheduler.settleInterrupted();
    assert.equal(h.scheduler.active?.type, "defend_self");
    h.bot.health = 6;
    h.scheduler.failActive("could not retreat");
    assert.equal(h.scheduler.active, null);
    assert.equal(work.status, TaskStatus.PAUSED);
    assert.deepEqual(work.resumeState, { gathered: 3 });
    assert.equal(h.scheduler.activate(work.id), null, "direct activation also honors safety");
    h.bot.health = 20; h.safety.scan();
    assert.equal((h.scheduler.active as { id: string } | null)?.id, work.id);
    assert.deepEqual(work.resumeState, { gathered: 3 });
  } finally { h.close(); }
});
test("damage immediately pauses autonomous work; food recovery can still run", () => {
  const h = harness();
  try {
    h.scheduler.enqueue({ type: "develop_land", source: "background", priority: TaskPriority.BACKGROUND, objective: "field", parameters: {} });
    h.scheduler.claim(); h.bot.health = 9;
    h.bus.emit("damage.received", { health: 9 } as never);
    assert.equal(h.scheduler.interruptPending, true);
    h.scheduler.settleInterrupted();
    assert.equal(h.scheduler.active, null);
    h.scheduler.enqueue({ type: "stockpile_maintenance", source: "background", priority: TaskPriority.MAINTENANCE, objective: "food", parameters: { kind: "food" } });
    assert.equal(h.scheduler.claim()?.type, "stockpile_maintenance");
  } finally { h.close(); }
});
test("unsafe work rehydrated after restart remains parked without losing its checkpoint", () => {
  const h = harness();
  try {
    const task = h.scheduler.enqueue({ type: "upgrade_equipment", source: "background", priority: TaskPriority.BACKGROUND, objective: "tools", parameters: {} });
    h.scheduler.claim(); h.scheduler.checkpoint({ gathered: 3 }); h.scheduler.requestPause(); h.scheduler.settleInterrupted();
    h.safety.detach();
    const restarted = new Scheduler({ bus: new EventBus(), tasks: new TasksRepository(h.db) });
    h.bot.health = 6;
    const safety = new WorkSafetyCoordinator({ bot: h.bot, bus: new EventBus(), scheduler: restarted, logger: pino({ level: "silent" }) });
    safety.attach(); restarted.loadFromPersistence();
    try { assert.equal(restarted.claim(), null); assert.deepEqual(restarted.queued.find(t => t.id === task.id)?.resumeState, { gathered: 3 }); }
    finally { safety.detach(); }
  } finally { h.close(); }
});

test("an ACTIVE crash checkpoint is parked when the session guard binds before dispatch", () => {
  const h = harness();
  try {
    const task = h.scheduler.enqueue({ type: "upgrade_equipment", source: "background", priority: TaskPriority.BACKGROUND, objective: "tools", parameters: {} });
    h.scheduler.claim(); h.scheduler.checkpoint({ gathered: 3 });
    h.safety.detach();
    const bus = new EventBus();
    const restarted = new Scheduler({ bus, tasks: new TasksRepository(h.db) });
    restarted.loadFromPersistence();
    assert.equal(restarted.active?.id, task.id);
    h.bot.health = 6;
    const safety = new WorkSafetyCoordinator({ bot: h.bot, bus, scheduler: restarted, logger: pino({ level: "silent" }) });
    safety.attach();
    try {
      assert.equal(restarted.active, null);
      assert.equal(restarted.queued.find(t => t.id === task.id)?.status, TaskStatus.PAUSED);
      assert.deepEqual(restarted.queued.find(t => t.id === task.id)?.resumeState, { gathered: 3 });
    } finally { safety.detach(); }
  } finally { h.close(); }
});
