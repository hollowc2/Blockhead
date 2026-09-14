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
  /** Reasons pushed through `deaths.markSkipped`, in order. */
  skipped: string[];
  /** How many times the fake scheduler was asked to pause active work. */
  pauses: { count: number };
}

function newHarness(): Harness {
  const clock = { now: 1_000_000 };
  const bus = new EventBus();
  const enqueued: Enqueued[] = [];
  const warns: Array<Record<string, unknown>> = [];
  const loops: Array<Record<string, unknown>> = [];
  const skipped: string[] = [];
  const logger = {
    info: () => {},
    warn: (obj: Record<string, unknown>, _msg: string) => {
      warns.push(obj);
    },
    error: () => {},
  } as unknown as Logger;

  let nextId = 0;
  const deaths = {
    record: (
      worldId: string,
      data: { x: number; y: number; z: number; dimension: string; inventory?: Record<string, number> },
    ) => {
      const id = ++nextId;
      const stored = {
        id,
        worldId,
        ...data,
        inventory: data.inventory ?? {},
        recovered: false,
        recoveryFailedReason: null,
        recoverySkippedReason: null,
        createdAt: new Date().toISOString(),
      };
      store.set(id, stored);
      return stored;
    },
    get: (id: number) => store.get(id),
    markFailed: () => {},
    markRecovered: () => {},
    markSkipped: (id: number, reason: string) => {
      const stored = store.get(id) as
        | { recoverySkippedReason: string | null; recovered: boolean }
        | undefined;
      if (stored !== undefined && !stored.recovered && stored.recoverySkippedReason === null) {
        stored.recoverySkippedReason = reason;
      }
      skipped.push(reason);
    },
  } as unknown as DeathEventsRepository;
  const store = new Map<number, object>();

  const pauses = { count: 0 };
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
    requestPause: () => {
      pauses.count += 1;
    },
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

  return { manager, bus, enqueued, warns, loops, clock, skipped, pauses };
}

/** Default carried kit so a plain `die` exercises the recovery-worthy path. */
const CARRIED_KIT = { iron_ingot: 3, oak_log: 4 };

function die(h: Harness, site: { x: number; y: number; z: number }, inventory: Record<string, number> = CARRIED_KIT): void {
  h.bus.emit("death", { dimension: "overworld", position: site, killer: null, inventory });
}

function dieByMob(
  h: Harness,
  site: { x: number; y: number; z: number },
  name: string,
  inventory: Record<string, number> = CARRIED_KIT,
): void {
  h.bus.emit("death", {
    dimension: "overworld",
    position: site,
    killer: { name, x: site.x, y: site.y, z: site.z },
    inventory,
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
  assert.equal(h.pauses.count, 1, "ordinary work pauses once for a worthy corpse");
  assert.deepEqual(h.skipped, [], "the corpse held items; no skip");
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

test("a death carrying nothing is skipped: no pause, no trip, reason recorded", () => {
  const h = newHarness();
  const recorded: Array<{ worthRecovering: boolean; skipReason: string | null; inventory: Record<string, number> }> = [];
  h.bus.on("death.recorded", (p) =>
    void recorded.push({ worthRecovering: p.worthRecovering, skipReason: p.skipReason, inventory: p.inventory }),
  );

  die(h, SITE, {});
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]!.worthRecovering, false);
  assert.equal(recorded[0]!.skipReason, "nothing_carried");
  assert.deepEqual(recorded[0]!.inventory, {}, "verdict carries the empty corpse contents");
  assert.equal(h.pauses.count, 0, "an empty corpse never pauses ordinary work");
  assert.deepEqual(h.skipped, ["nothing_carried"], "the skip reason is persisted on the row");

  respawn(h);
  assert.equal(h.enqueued.length, 0, "no recovery task for an empty corpse");
});

test("a corpse of only discard junk is skipped too", () => {
  const h = newHarness();
  die(h, SITE, { dirt: 5, rotten_flesh: 2 });
  assert.deepEqual(h.skipped, ["only_expendable_items"]);
  assert.equal(h.pauses.count, 0);
  respawn(h);
  assert.equal(h.enqueued.length, 0, "no trip for a corpse of auto-discard candidates");
});

test("a common-or-better corpse keeps the trip (unknown items default to common)", () => {
  const h = newHarness();
  // Sticks are "common"; unclassified modded loot would land there too, so a
  // common corpse must never be skipped — the sweep re-verifies on site.
  die(h, SITE, { stick: 4 });
  assert.deepEqual(h.skipped, [], "common items are still worth a visit");
  respawn(h);
  assert.equal(h.enqueued.length, 1);
  assert.equal(h.enqueued[0]!.type, "death_recovery");
});

test("skipped deaths still feed the death-loop brake", () => {
  const h = newHarness();
  die(h, SITE, {});
  respawn(h);
  die(h, SITE, {});
  respawn(h);
  die(h, SITE, {});
  assert.equal(h.manager.inDeathLoop, true, "repeated empty deaths prove the kill zone too");
  assert.equal(h.enqueued.length, 0, "none of the empty corpses ever tripped");
});