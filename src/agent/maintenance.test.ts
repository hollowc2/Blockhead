import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bot } from "mineflayer";
import type { Logger } from "pino";
import type { MinecraftConfig } from "../config/schema.js";
import { EventBus } from "../events/bus.js";
import type { CollectResourceRunner } from "../skills/collect-resource.js";
import type { SkillResult } from "../skills/skill-library.js";
import { withWorldActionLease } from "./world-actions.js";
import { CHARCOAL_BATCH, StockpileManager, type StockpileManagerOptions } from "./maintenance.js";

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
