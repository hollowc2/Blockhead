import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { withWorldActionLease } from "../agent/world-actions.js";
import { walkIntoReach } from "./movement.js";
import { needsFuel } from "./smelting.js";

function leased<T>(action: () => Promise<T>): Promise<T> {
  const controller = new AbortController();
  return withWorldActionLease({ owner: "station-test", signal: controller.signal, acknowledged: Promise.resolve() }, action);
}

test("a station already within reach needs no walk", async () => {
  const bot = { entity: { position: new Vec3(0.5, 64, 0.5) } } as unknown as Bot;
  assert.equal(await leased(() => walkIntoReach(bot, { position: { x: 2, y: 64, z: 1 } })), true);
});

test("a station beyond reach that cannot be walked to is reported, not clicked", async () => {
  // Previously the click went out from 10+ blocks away and every craft try
  // burned a 20 s "Event windowOpen did not fire" timeout.
  const bot = { entity: { position: new Vec3(0.5, 64, 0.5) } } as unknown as Bot;
  assert.equal(await leased(() => walkIntoReach(bot, { position: { x: 12, y: 64, z: 0 } })), false);
});

test("the furnace is refueled only when its burn cannot finish another item", () => {
  const gauge = (slot: { name: string; count: number } | null, fuelSeconds: number | null) => ({ fuelItem: () => slot, fuelSeconds });
  assert.equal(needsFuel(gauge(null, null)), true, "unlit furnace");
  assert.equal(needsFuel(gauge(null, 4)), true, "burn ends mid-item");
  assert.equal(needsFuel(gauge(null, 60)), false, "charcoal still burning");
  assert.equal(needsFuel(gauge({ name: "charcoal", count: 1 }, 0)), false, "fuel already queued");
});
