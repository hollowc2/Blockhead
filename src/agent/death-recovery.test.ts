import assert from "node:assert/strict";
import { test } from "node:test";
import type { Logger } from "pino";
import { EventBus } from "../events/bus.js";
import type { DeathEventsRepository } from "../memory/deaths.js";
import type { AgentState } from "./state.js";
import type { Scheduler } from "./scheduler.js";
import { TaskPriority, TaskStatus, type NewTask, type Task } from "./task.js";
import { DeathRecoveryManager, type DeathRecoveryManagerOptions } from "./death-recovery.js";

/**
 * Phase 10 regression: CobbleBob spent an evening dying at the exact same
 * spawn site (~60 deaths), every recovery trip a 10-20s sweep that came back
 * empty (`items_despawned`; the drops are destroyed instantly in the fire /
 * lava / kill zone he respawns into). The death-loop brake declares a loop
 * after a few consecutive same-site rapid deaths: further deaths record but
 * enqueue no recovery trip, the loop is surfaced once, and a death somewhere
 * new (the user walked the bot out) clears the brake and resumes normal
 * per-death recovery.
 */

const SITE = { x: 10, y: 64, z: 10 };
const FAR_SITE = { x: 500, y: 64, z: 500 };
/** The respawn flows the fake scheduler enqueues (type + deathId). */
type Enqueued = { type: string; deathId: number | null };

interface Harness {
  manager: DeathRecoveryManager;
  bus: EventBus;
  enqueued: Enqueued[];
  warns: Array<Record<string, unknown>>;
  loops: Array<Record<string, unknown>>;
  clock: { now: number };
}

function newHarness(): Harness {
  const clock = { now: 1_000_000 };
  const bus = new EventBus();
  const enqueued: Enqueued[] = [];
  const warns: Array<Record<string, unknown>> = [];
  const loops: Array<Record<string, unknown>> = [];
  const logger = {
    info: () => {},
    warn: (obj: Record<string, unknown>, _msg: string) => {
      warns.push(obj);
    },
    error: () => {},
  } as unknown as Logger;

  let nextId = 0;
  const deaths = {
    record: (_worldId: string, data: { x: number; y: number; z: number; dimension: string }) => {
      const id = ++nextId;
      const stored = { id, ...data, recovered: false, recoveryFailedReason: null };
      store.set(id, stored);
      return stored;
    },
    get: (id: number) => (store.get(id) as { id: number; x: number; y: number; z: number; dimension: string } | undefined) ?? null,
    markFailed: () => {},
    markRecovered: () => {},
  } as unknown as DeathEventsRepository;
  const store = new Map<number, object>();

  const scheduler = {
    enqueue: (input: NewTask): Task => {
      const task: Task = {
        ...input,
        id: `t${nextId}`,
        status: TaskStatus.QUEUED,
        createdAt: new Date().toISOString(),
        parameters: input.parameters ?? {},
      };
      const deathId = Number(task.parameters.deathId);
      enqueued.push({
        type: task.type,
        deathId: Number.isFinite(deathId) ? deathId : null,
      });
      return task;
    },
    claim: () => null,
    requestPause: () => {},
    requestCancel: () => {},
    cancel: () => null,
    queued: [],
    active: null,
  } as unknown as Scheduler;

  const state = {
    worldId: "world-1",
    addEvent: () => {},
  } as unknown as AgentState;

  const manager = new DeathRecoveryManager({
    bus,
    scheduler,
    state,
    deaths,
    logger,
    now: () => clock.now,
  } as DeathRecoveryManagerOptions);

  return { manager, bus, enqueued, warns, loops, clock };
}

function die(h: Harness, site: { x: number; y: number; z: number }): void {
  h.bus.emit("death", { dimension: "overworld", position: site, killer: null });
}

function dieByMob(h: Harness, site: { x: number; y: number; z: number }, name: string): void {
  h.bus.emit("death", {
    dimension: "overworld",
    position: site,
    killer: { name, x: site.x, y: site.y, z: site.z },
  });
}

function respawn(h: Harness): void {
  h.bus.emit("respawn", {});
}

test("a single death enqueues exactly one recovery on respawn", () => {
  const h = newHarness();
  die(h, SITE);
  respawn(h);
  assert.equal(h.enqueued.length, 1);
  assert.equal(h.enqueued[0]!.type, "death_recovery");
  assert.equal(h.manager.inDeathLoop, false);
});

test("three rapid same-site deaths brake recovery and surface the loop once", () => {
  const h = newHarness();

  // Two ordinary same-site deaths: each respawn recovers.
  die(h, SITE);
  respawn(h);
  die(h, SITE);
  respawn(h);
  assert.equal(h.enqueued.length, 2);

  // The third consecutive same-site death declares the loop.
  h.clock.now += 1_000;
  die(h, SITE);
  assert.equal(h.manager.inDeathLoop, true);
  respawn(h);
  assert.equal(h.enqueued.length, 2, "no recovery trip for the loop death");
  assert.equal(
    h.warns.some((w) => w.consecutiveDeaths === 3 && w.deathId === 3),
    true,
    "loop warn carries the death id and count",
  );

  // Further same-site deaths stay braked: recorded, but never a new trip
  // and never a second warn.
  h.clock.now += 5_000;
  die(h, SITE);
  respawn(h);
  assert.equal(h.manager.inDeathLoop, true);
  assert.equal(h.enqueued.length, 2);
  assert.equal(h.warns.filter((w) => w.consecutiveDeaths !== undefined).length, 1, "one warn per brake");
});

test("death.loop_detected fires exactly once for the loop death", () => {
  const h = newHarness();
  h.bus.on("death.loop_detected", (p) =>
    void h.loops.push({ consecutiveDeaths: p.consecutiveDeaths, x: p.x, y: p.y, z: p.z, killer: p.killer }),
  );

  for (let i = 0; i < 3; i++) {
    die(h, SITE);
    respawn(h);
  }
  h.clock.now += 1_000;
  die(h, SITE);
  respawn(h);

  assert.equal(h.loops.length, 1);
  const loop = h.loops[0]!;
  assert.equal(loop.consecutiveDeaths, 3);
  assert.equal(loop.x, SITE.x);
  assert.equal(loop.z, SITE.z);
  assert.equal(loop.killer, null, "no attacker observed at death time");
});

test("the mob that killed the bot is named in the loop warning", () => {
  const h = newHarness();
  for (let i = 0; i < 3; i++) {
    dieByMob(h, SITE, "zombie");
    respawn(h);
  }
  assert.equal(h.manager.inDeathLoop, true);
  const loopWarn = h.warns.find((w) => w.killer !== undefined && w.killer !== null && w.consecutiveDeaths !== undefined);
  assert.equal(loopWarn?.killer, "zombie");
  assert.equal(loopWarn?.consecutiveDeaths, 3);
});

test("a death at a new site clears the brake and resumes normal recovery", () => {
  const h = newHarness();
  for (let i = 0; i < 3; i++) {
    die(h, SITE);
    respawn(h);
  }
  assert.equal(h.manager.inDeathLoop, true);

  // The user walked the bot out; it dies somewhere new. The old kill zone
  // is no longer the threat: recovery runs again.
  const before = h.enqueued.length;
  die(h, FAR_SITE);
  assert.equal(h.manager.inDeathLoop, false);
  respawn(h);
  assert.equal(h.enqueued.length, before + 1);
  assert.equal(h.enqueued.at(-1)!.type, "death_recovery");
});

test("the brake expires and a later same-site death is treated fresh", () => {
  const h = newHarness();
  for (let i = 0; i < 3; i++) {
    die(h, SITE);
    respawn(h);
  }
  assert.equal(h.manager.inDeathLoop, true);

  // Long quiet stretch: the brake window passes and the rapid-death window
  // prunes the old evidence.
  h.clock.now += 11 * 60_000;
  assert.equal(h.manager.inDeathLoop, false);

  die(h, SITE);
  respawn(h);
  assert.equal(h.manager.inDeathLoop, false);
  assert.equal(h.enqueued.at(-1)!.type, "death_recovery", "recovery is not stuck in the brake forever");
});