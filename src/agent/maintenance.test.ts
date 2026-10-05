import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bot } from "mineflayer";
import type { Logger } from "pino";
import type { MinecraftConfig } from "../config/schema.js";
import { EventBus } from "../events/bus.js";
import type { CollectResourceRunner } from "../skills/collect-resource.js";
import type { SkillResult } from "../skills/skill-library.js";
import { withWorldActionLease } from "./world-actions.js";
import { CHARCOAL_BATCH, FUEL_COAL_RADIUS, StockpileManager, type StockpileManagerOptions } from "./maintenance.js";

const quietLogger = { info: () => undefined, warn: () => undefined, debug: () => undefined } as unknown as Logger;

function leased<T>(action: () => Promise<T>): Promise<T> {
  const controller = new AbortController();
  return withWorldActionLease({ owner: "maintenance-test", signal: controller.signal, acknowledged: Promise.resolve() }, action);
}

test("with no coal reachable, a fuel restore asks for one charcoal batch on top of the stock", async () => {
  const carried = [{ name: "charcoal", count: 10, type: 1 }];
  const bot = { inventory: { items: () => carried, slots: [] }, entity: null } as unknown as Bot;
  const collect = {
    run: async (): Promise<SkillResult> => ({ ok: false, status: "failed", errorCode: "RESOURCE_NOT_FOUND", message: "only 0/54 coal ores found nearby" } as SkillResult),
  } as unknown as CollectResourceRunner;
  const manager = new StockpileManager({
    bot,
    state: { worldId: null, home: null },
    config: {} as MinecraftConfig,
    bus: new EventBus(),
    storage: {},
    scheduler: {},
    collect,
    food: {},
    torches: {},
    logger: quietLogger,
  } as unknown as StockpileManagerOptions);
  const asked: number[] = [];
  manager.setCharcoalProducer(async (quantity) => {
    asked.push(quantity);
    return { ok: true, status: "completed" } as SkillResult;
  });

  const snapshot = await leased(() => manager.check());
  const fuel = snapshot.deficits.find((deficit) => deficit.kind === "fuel");
  assert.ok(fuel !== undefined);
  assert.equal(fuel.deficit, 54);
  await manager.restore(fuel);
  // Previously: all 64 at once (128 logs) — a total the producer reads as
  // "ensure 54 charcoal", which also ignored the 10 already held.
  assert.deepEqual(asked, [10 + CHARCOAL_BATCH]);
});

function fuelManager(coal: () => SkillResult): { manager: StockpileManager; asked: number[]; coalRuns: () => number } {
  const bot = { inventory: { items: () => [], slots: [] }, entity: null } as unknown as Bot;
  let coalRuns = 0;
  const collect = {
    run: async (): Promise<SkillResult> => {
      coalRuns += 1;
      return coal();
    },
  } as unknown as CollectResourceRunner;
  const manager = new StockpileManager({
    bot,
    state: { worldId: null, home: null },
    config: {} as MinecraftConfig,
    bus: new EventBus(),
    storage: {},
    scheduler: {},
    collect,
    food: {},
    torches: {},
    logger: quietLogger,
  } as unknown as StockpileManagerOptions);
  const asked: number[] = [];
  manager.setCharcoalProducer(async (quantity) => {
    asked.push(quantity);
    return { ok: true, status: "completed" } as SkillResult;
  });
  return { manager, asked, coalRuns: () => coalRuns };
}

test("an interrupted coal run is not 'no coal': the restore reports the interruption", async () => {
  // Live 2026-10-04: 8 of 9 "no coal reachable" lines were preemptions, and
  // the charcoal run then started under the paused signal and never ran.
  const { manager, asked } = fuelManager(() => ({ ok: false, status: "interrupted", message: "interrupted" }) as SkillResult);
  const result = await manager.restore({ kind: "fuel", target: 64, current: 10, deficit: 54, attempts: 1 });
  assert.equal(result.status, "interrupted");
  assert.deepEqual(asked, []);
});

test("a fuel restore looks for coal only near home when it can make charcoal", async () => {
  let radius: number | undefined;
  const { manager } = fuelManager(() => ({ ok: true, status: "completed" }) as SkillResult);
  (manager as unknown as { opts: { collect: { run: (r: string, q: number, o: { maxRadius?: number }) => Promise<SkillResult> } } }).opts.collect.run = async (_r, _q, o) => {
    radius = o.maxRadius;
    return { ok: true, status: "completed" } as SkillResult;
  };
  await manager.restore({ kind: "fuel", target: 64, current: 10, deficit: 54, attempts: 1 });
  assert.equal(radius, FUEL_COAL_RADIUS);
});

test("a resumed fuel restore smelts a charcoal batch at home instead of restarting the coal trip", async () => {
  const { manager, asked, coalRuns } = fuelManager(() => ({ ok: true, status: "completed" }) as SkillResult);
  await manager.restore({ kind: "fuel", target: 64, current: 10, deficit: 54, attempts: 2 });
  assert.equal(coalRuns(), 0);
  assert.deepEqual(asked, [CHARCOAL_BATCH]);
  await manager.restore({ kind: "fuel", target: 64, current: 10, deficit: 54, attempts: 1 });
  assert.equal(coalRuns(), 1);
});

test("a resumed restore re-plans from the latest stock and settles when already covered", async () => {
  // 19:09 food crisis queued at 0 with deficit 16; by 19:57 the stock was 23.
  const { manager } = fuelManager(() => ({ ok: true, status: "completed" }) as SkillResult);
  (manager as unknown as { lastSnapshot: unknown }).lastSnapshot = { levels: { wood: 30, food: 23, fuel: 54, torches: 0 } };
  const food = manager.replan({ kind: "food", target: 64, current: 0, deficit: 16, crisis: true });
  assert.equal(food.deficit, 0);
  const result = await manager.restore({ kind: "food", target: 64, current: 0, deficit: 16, crisis: true });
  assert.equal(result.status, "completed");
  assert.equal(manager.replan({ kind: "fuel", target: 64, current: 10, deficit: 54 }).deficit, 10, "only the remaining shortage");
  assert.equal(manager.replan({ kind: "food", target: 64, current: 0, deficit: 16, crisis: false }).deficit, 16, "never more than queued");
});
