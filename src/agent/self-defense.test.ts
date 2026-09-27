import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { Bot } from "mineflayer";
import pino from "pino";
import { EventBus } from "../events/bus.js";
import { AppDatabase } from "../memory/database.js";
import { MIGRATIONS } from "../memory/migrations.js";
import { TasksRepository } from "../memory/tasks.js";
import { Scheduler } from "./scheduler.js";
import { SelfDefenseReflex } from "./self-defense.js";
import { TaskPriority } from "./task.js";

function harness() {
  const db = new AppDatabase(":memory:");
  db.runMigrations(MIGRATIONS);
  const bus = new EventBus();
  const scheduler = new Scheduler({ bus, tasks: new TasksRepository(db) });
  const emitter = new EventEmitter();
  const self = { id: 1, type: "player", name: "CobbleBob", position: { x: 0, y: 64, z: 0 } };
  const bot = Object.assign(emitter, { entity: self, health: 20, entities: {} as Record<number, unknown> }) as unknown as Bot & { entities: Record<number, unknown> };
  let clock = 0;
  const reflex = new SelfDefenseReflex({ bot, bus, scheduler, logger: pino({ level: "silent" }), now: () => clock });
  return { db, bus, scheduler, bot, self, reflex, advance: (ms: number) => { clock += ms; } };
}

const activeType = (h: ReturnType<typeof harness>): string | undefined => h.scheduler.active?.type;
const zombie = (x: number, y = 64) => ({ id: 7, type: "hostile", name: "zombie", position: { x, y, z: 0 } });

test("a zombie closing in triggers one emergency defense pass that preempts owner work", () => {
  const h = harness();
  try {
    const owner = h.scheduler.enqueue({ type: "collect_resource", priority: TaskPriority.FOREGROUND, source: "user", objective: "get logs", parameters: {} });
    assert.equal(h.scheduler.claim()?.id, owner.id);
    h.bot.entities[7] = zombie(10);
    h.reflex.scan();
    assert.equal(h.scheduler.queued.filter((task) => task.type === "defend_self").length, 0, "10 blocks away is not an attack");
    h.bot.entities[7] = zombie(4);
    h.reflex.scan();
    h.reflex.scan();
    const defense = h.scheduler.queued.filter((task) => task.type === "defend_self");
    assert.equal(defense.length, 1, "deduplicated");
    assert.equal(defense[0]?.priority, TaskPriority.REFLEX);
    assert.equal(h.scheduler.interruptPending, true, "owner work asked to pause");
  } finally { h.reflex.detach(); h.db.close(); }
});

test("damage from a hostile triggers defense; a mob on another floor does not", () => {
  const h = harness();
  try {
    h.bot.entities[7] = zombie(3, 50);
    h.reflex.scan();
    assert.equal(h.scheduler.active, null, "a zombie 14 blocks below in the mine is not an attack");
    h.reflex.attach();
    (h.bot as unknown as EventEmitter).emit("entityHurt", h.self, { id: 9, type: "hostile", name: "skeleton", position: { x: 12, y: 64, z: 0 } });
    assert.equal(activeType(h), "defend_self");
  } finally { h.reflex.detach(); h.db.close(); }
});

test("a failed pass stands the reflex down for a cooldown", () => {
  const h = harness();
  try {
    h.reflex.attach();
    h.bot.entities[7] = zombie(3);
    h.reflex.scan();
    assert.equal(activeType(h), "defend_self");
    h.scheduler.failActive("could not approach the zombie");
    h.advance(5_000);
    h.reflex.scan();
    assert.equal(h.scheduler.active, null, "cooling down after a failure");
    h.advance(30_000);
    h.reflex.scan();
    assert.equal(activeType(h), "defend_self");
  } finally { h.reflex.detach(); h.db.close(); }
});

test("the defense reflex preempts an emergency death-recovery trip", () => {
  const h = harness();
  try {
    const recovery = h.scheduler.enqueue({ type: "death_recovery", priority: TaskPriority.EMERGENCY, source: "system", objective: "Recover items", parameters: {} });
    assert.equal(h.scheduler.claim()?.id, recovery.id);
    h.bot.entities[7] = zombie(3);
    h.reflex.scan();
    assert.equal(h.scheduler.interruptPending, true, "death recovery is asked to pause for the fight");
  } finally { h.reflex.detach(); h.db.close(); }
});
