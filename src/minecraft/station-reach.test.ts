import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { withWorldActionLease } from "../agent/world-actions.js";
import { walkIntoReach } from "./movement.js";
import { needsFuel, smeltItems } from "./smelting.js";

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

test("smelted output is counted after the furnace closes, when the inventory syncs", async () => {
  // Live 2026-10-04: a cooked porkchop was in hand but the run reported
  // "smelting made no output change" because it counted with the window open.
  const inventory: { name: string; type: number; count: number }[] = [
    { name: "porkchop", type: 1, count: 1 },
    { name: "coal", type: 2, count: 1 },
  ];
  let pendingOutput = 0;
  const window = {
    slots: [] as ({ type: number } | null)[],
    fuelSeconds: 0,
    fuelItem: () => null,
    putFuel: async () => { inventory[1]!.count -= 1; window.fuelSeconds = 80; },
    putInput: async () => { inventory[0]!.count -= 1; window.slots[2] = { type: 3 }; },
    takeOutput: async () => { window.slots[2] = null; pendingOutput += 1; },
    takeFuel: async () => {},
    close: async () => { inventory.push({ name: "cooked_porkchop", type: 3, count: pendingOutput }); },
  };
  const bot = {
    entity: { position: new Vec3(0.5, 64, 0.5) },
    registry: { itemsByName: { porkchop: { id: 1 }, coal: { id: 2 }, cooked_porkchop: { id: 3 } } },
    inventory: { items: () => inventory.filter((item) => item.count > 0) },
    openFurnace: async () => window,
  } as unknown as Bot;
  const furnace = { name: "furnace", position: new Vec3(1, 64, 1) } as unknown as Parameters<typeof smeltItems>[1];
  const result = await leased(() => smeltItems(bot, furnace, { inputName: "porkchop", fuelName: ["charcoal", "coal"], outputName: "cooked_porkchop", times: 1 }));
  assert.deepEqual(result, { ok: true, smelted: 1 });
});
