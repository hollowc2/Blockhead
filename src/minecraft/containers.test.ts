import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bot } from "mineflayer";
import type { Logger } from "pino";
import { Vec3 } from "vec3";
import type { AgentState } from "../agent/state.js";
import { withWorldActionLease } from "../agent/world-actions.js";
import type { StorageRepository } from "../memory/storage.js";
import { adoptHomeChests, countStoredItems, deliverCarried, describeDeliveryFailure, homeStorageUnloaded, rememberChestContents } from "./containers.js";
import { junkToShed, MIN_FREE_SLOTS_FOR_GATHER } from "./inventory.js";

function leased<T>(action: () => Promise<T>): Promise<T> {
  const controller = new AbortController();
  return withWorldActionLease({ owner: "containers-test", signal: controller.signal, acknowledged: Promise.resolve() }, action);
}

const silent = { warn() {}, info() {}, debug() {} } as unknown as Logger;
const state = { worldId: 1, home: null, protectedRegion: null } as unknown as AgentState;
const CHEST = { x: 67, y: 96, z: 49 };
const storage = {
  listByCategory: () => [{ ...CHEST }],
  list: () => [{ ...CHEST }],
  register() {},
} as unknown as StorageRepository;

/** A bot standing at `at`, carrying `coal` coal, next to (or far from) the home chest. */
function fakeBot(at: Vec3, coal: number, chestExists = true) {
  const carried = [{ name: "coal", count: coal }];
  const opened: string[] = [];
  const bot = {
    entity: { position: at },
    registry: { itemsByName: { coal: { id: 1 } } },
    inventory: { items: () => carried.filter((item) => item.count > 0) },
    findBlocks: () => [],
    blockAt: (pos: Vec3) =>
      chestExists && pos.x === CHEST.x && pos.y === CHEST.y && pos.z === CHEST.z
        ? { name: "chest", position: new Vec3(CHEST.x, CHEST.y, CHEST.z) }
        : null,
    openContainer: async () => {
      opened.push("chest");
      return {
        deposit: async (_id: number, _meta: null, count: number) => { carried[0]!.count -= count; },
        close: async () => {},
      };
    },
  };
  return { bot: bot as unknown as Bot, opened };
}

test("a chest beyond window reach is reported unreachable, never 'no chest'", async () => {
  // Live 2026-10-04 15:07: returnHome stopped 5.5 blocks from the chest at
  // 67,96,49; the open failed and the owner was told there was no chest.
  const { bot, opened } = fakeBot(new Vec3(73, 98, 52), 55);
  const result = await leased(() => deliverCarried(bot, state, storage, "coal", silent));
  assert.equal(result.delivered, 0);
  assert.equal(result.failure, "unreachable");
  assert.deepEqual(opened, [], "no click from out of reach");
  assert.match(describeDeliveryFailure(result.failure), /could not reach/);
});

test("a chest within reach takes the deposit", async () => {
  const { bot, opened } = fakeBot(new Vec3(66.5, 96, 50.5), 55);
  const result = await leased(() => deliverCarried(bot, state, storage, "coal", silent));
  assert.deepEqual(result, { delivered: 55 });
  assert.deepEqual(opened, ["chest"]);
});

test("only a missing chest is reported as 'no chest'", async () => {
  const { bot } = fakeBot(new Vec3(66.5, 96, 50.5), 55, false);
  const result = await leased(() => deliverCarried(bot, { ...state, worldId: null } as AgentState, storage, "coal", silent));
  assert.equal(result.failure, "no_chest");
  assert.match(describeDeliveryFailure(result.failure), /no chest/);
  assert.match(describeDeliveryFailure("chest_full"), /full/);
});

test("junk is shed only when the inventory is nearly full, keeping a stack of cobblestone", () => {
  const items = [
    { name: "cobblestone", count: 64 },
    { name: "cobblestone", count: 31 },
    { name: "granite", count: 5 },
    { name: "gravel", count: 3 },
    { name: "poppy", count: 2 },
    { name: "wheat_seeds", count: 20 },
    { name: "wooden_pickaxe", count: 1 },
    { name: "coal", count: 55 },
  ];
  assert.deepEqual(junkToShed(items, MIN_FREE_SLOTS_FOR_GATHER), {}, "room to spare");
  assert.deepEqual(junkToShed(items, 1), { cobblestone: 31, granite: 5, gravel: 3, poppy: 2 });
  assert.deepEqual(junkToShed(items, 0, ["minecraft:gravel"]), { cobblestone: 31, granite: 5, poppy: 2 }, "the gathered item is kept");
});

test("a chest out of range counts what it held when last read, not zero", async () => {
  const chest = { x: 67, y: 96, z: 49 };
  const storage = { list: () => [chest] } as unknown as StorageRepository;
  const state = { worldId: 991 } as unknown as AgentState;
  const away = { blockAt: () => null } as unknown as Bot;
  assert.deepEqual(await leased(() => countStoredItems(away, state, storage)), {}, "never read: nothing known");
  rememberChestContents(991, chest, { coal: 54, oak_log: 33 });
  assert.deepEqual(await leased(() => countStoredItems(away, state, storage)), { coal: 54, oak_log: 33 });
  const broken = { blockAt: () => ({ name: "air" }) } as unknown as Bot;
  assert.deepEqual(await leased(() => countStoredItems(broken, state, storage)), {}, "a loaded non-chest drops the memory");
  assert.deepEqual(await leased(() => countStoredItems(away, state, storage)), {});
});

test("a home chest in an unloaded chunk is not reported missing", () => {
  const unloaded = { blockAt: () => null } as unknown as Bot;
  assert.equal(homeStorageUnloaded(unloaded, state, storage), true);
  const loaded = { blockAt: () => ({ name: "air" }) } as unknown as Bot;
  assert.equal(homeStorageUnloaded(loaded, state, storage), false, "loaded and gone: really missing");
});

test("a chest standing at home but missing from the registry is adopted", () => {
  // 20:14: the real home chest (67,96,49) was pruned and a new one placed.
  const registered: Array<{ x: number; y: number; z: number }> = [{ x: 65, y: 96, z: 51 }];
  const homeState = { worldId: 1, home: { x: 65, y: 96, z: 51, dimension: "overworld" } } as unknown as AgentState;
  const repo = {
    list: () => registered.map((at, id) => ({ id, ...at })),
    register: (_w: number, at: { x: number; y: number; z: number }) => { registered.push({ x: at.x, y: at.y, z: at.z }); },
  } as unknown as StorageRepository;
  const bot = {
    entity: { position: new Vec3(65.5, 97, 50.5) },
    findBlocks: () => [new Vec3(65, 96, 51), new Vec3(67, 96, 49), new Vec3(120, 70, 51)],
  } as unknown as Bot;
  assert.equal(adoptHomeChests(bot, homeState, repo), 1);
  assert.deepEqual(registered.at(-1), { x: 67, y: 96, z: 49 });
  assert.equal(adoptHomeChests(bot, homeState, repo), 0, "idempotent");
});
