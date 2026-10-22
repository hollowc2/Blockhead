import assert from "node:assert/strict";
import { test } from "node:test";
import { WorldActionExecutor } from "../agent/world-actions.js";
import { smeltItems } from "./smelting.js";

function furnaceHarness(logs: number, coal: number) {
  const types: Record<string, number> = { oak_log: 1, charcoal: 2, coal: 3 };
  const stock: Record<string, number> = { oak_log: logs, coal, charcoal: 0 };
  const items = () => Object.entries(stock).filter(([, count]) => count > 0)
    .map(([name, count]) => ({ name, count, type: types[name] }));
  // Mineflayer's closed inventory stays stale until the window closes.
  let closedInventory = structuredClone(items());
  const burned: string[] = [];
  let inputs = 0;
  let fuel: any = null;
  const window = {
    slots: [null, null, null] as any[],
    fuelSeconds: 0,
    items,
    inputItem: () => null,
    fuelItem: () => fuel,
    outputItem: () => window.slots[2],
    putFuel: async (type: number) => {
      const name = Object.keys(types).find((name) => types[name] === type)!;
      assert.ok(stock[name]! > 0, `no ${name} in the open window`);
      stock[name]! -= 1;
      burned.push(name);
      fuel = { name, count: 1 };
    },
    putInput: async () => {
      assert.ok(stock.oak_log! > 0, "no log left after refuelling");
      stock.oak_log! -= 1;
      inputs += 1;
      fuel = null;
      window.slots[2] = { name: "charcoal", type: 2, count: 1 };
    },
    takeOutput: async () => { stock.charcoal! += 1; window.slots[2] = null; },
    takeFuel: async () => { stock[fuel.name]! += 1; fuel = null; },
    close: async () => { closedInventory = items(); },
  };
  const bot = {
    inventory: { items: () => closedInventory },
    registry: { itemsByName: Object.fromEntries(Object.entries(types).map(([name, id]) => [name, { id }])) },
    openFurnace: async () => window,
  } as any;
  return { bot, burned, get inputs() { return inputs; } };
}

async function smelt(h: ReturnType<typeof furnaceHarness>, times: number) {
  return new WorldActionExecutor().run("smelt-test", new AbortController().signal, async () =>
    smeltItems(h.bot, { name: "furnace", position: { x: 0, y: 64, z: 0 } } as any, {
      inputName: "oak_log", fuelName: ["coal", "charcoal", "oak_log"], outputName: "charcoal", times,
    }));
}

test("charcoal refuels from fresh output in the open window", async () => {
  // One coal covers seven items; the eighth burns charcoal this run made.
  const h = furnaceHarness(10, 1);
  const result = await smelt(h, 10);
  assert.deepEqual(result, { ok: true, smelted: 10 });
  assert.deepEqual(h.burned, ["coal", "charcoal"]);
  assert.equal(h.inputs, 10);
});

test("the final log used as fuel returns a failure instead of a missing-slot exception", async () => {
  const h = furnaceHarness(1, 0);
  const result = await smelt(h, 1);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /no oak_log to smelt after refuelling/);
  assert.equal(h.inputs, 0);
});
