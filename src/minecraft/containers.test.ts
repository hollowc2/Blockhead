import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bot } from "mineflayer";
import type { Logger } from "pino";
import { Vec3 } from "vec3";
import type { AgentState } from "../agent/state.js";
import { withWorldActionLease } from "../agent/world-actions.js";
import type { StorageRepository } from "../memory/storage.js";
import { adoptHomeChests, chestOpenableAt, countStoredItems, findHomeChest, deliverCarried, describeDeliveryFailure, homeStorageUnloaded, rememberChestContents, pruneBlockedChests, withdrawFirstOfEach } from "./containers.js";
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
    blockAt: () => ({ name: "air", boundingBox: "empty" }),
  } as unknown as Bot;
  assert.equal(adoptHomeChests(bot, homeState, repo), 1);
  assert.deepEqual(registered.at(-1), { x: 67, y: 96, z: 49 });
  assert.equal(adoptHomeChests(bot, homeState, repo), 0, "idempotent");
});

test("a chest under a furnace cannot open and is not the home chest", () => {
  // 20:14: the repair set the chest at 65,96,51 under the home furnace.
  const furnace = { name: "furnace", boundingBox: "block", transparent: false };
  const chest = { name: "chest", boundingBox: "block", position: new Vec3(65, 96, 51) };
  const blocked = { blockAt: (pos: Vec3) => (pos.y === 97 ? furnace : chest), entity: null } as unknown as Bot;
  assert.equal(chestOpenableAt(blocked, { x: 65, y: 96, z: 51 }), false);
  const clear = { blockAt: (pos: Vec3) => (pos.y === 97 ? { name: "air", boundingBox: "empty" } : chest) } as unknown as Bot;
  assert.equal(chestOpenableAt(clear, { x: 65, y: 96, z: 51 }), true);
  const slab = { blockAt: () => ({ name: "oak_slab", boundingBox: "block", transparent: false }) } as unknown as Bot;
  assert.equal(chestOpenableAt(slab, { x: 0, y: 0, z: 0 }), true);
  const homeState = { worldId: 1, home: null } as unknown as AgentState;
  const repo = { listByCategory: () => [{ x: 65, y: 96, z: 51 }], list: () => [{ x: 65, y: 96, z: 51 }] } as unknown as StorageRepository;
  assert.equal(findHomeChest(blocked, homeState, repo), null);
});

test("the home chest scan survives a matcher handed position-less blocks", () => {
  // mineflayer's findBlocks matches palette entries (Block.fromStateId) that
  // carry no position; reading .position.x there crashed every tick (20:39).
  const homeState = { worldId: 1, home: { x: 65, y: 96, z: 51, dimension: "overworld" } } as unknown as AgentState;
  const repo = { listByCategory: () => [], list: () => [], register() {} } as unknown as StorageRepository;
  const bot = {
    entity: { position: new Vec3(65.5, 97, 50.5) },
    blockAt: (pos: Vec3) => (pos.y === 96 ? { name: "chest", boundingBox: "block", position: pos } : { name: "air", boundingBox: "empty" }),
    findBlocks: (options: { matching: (block: unknown) => boolean }) =>
      options.matching({ name: "chest", boundingBox: "block", position: null }) ? [new Vec3(66, 96, 52)] : [],
  } as unknown as Bot;
  assert.equal(findHomeChest(bot, homeState, repo)?.name, "chest");
});

test("after a restart, an unreachable chest counts its persisted reading", async () => {
  const chest = { id: 7, x: 64, y: 96, z: 52, lastContents: { coal: 52, charcoal: 14 } };
  const storage = { list: () => [chest] } as unknown as StorageRepository;
  const away = { blockAt: () => null } as unknown as Bot;
  // Fresh process: nothing read this session (world 992 never seen).
  assert.deepEqual(await leased(() => countStoredItems(away, { worldId: 992 } as unknown as AgentState, storage)), { coal: 52, charcoal: 14 });
});

test("spare tools come from one chest visit, asking only for what it holds", async () => {
  // Live 22:00:25: six "Can't find X" withdraws per recovery, one per spare.
  const carried: { name: string; count: number }[] = [];
  const chestItems = [{ name: "stone_pickaxe", count: 1 }, { name: "coal", count: 42 }];
  const ids: Record<string, number> = { iron_axe: 1, stone_axe: 2, wooden_axe: 3, iron_pickaxe: 4, stone_pickaxe: 5, wooden_pickaxe: 6, coal: 7 };
  const asked: string[] = [];
  let opens = 0;
  const bot = {
    entity: { position: new Vec3(66.5, 96, 50.5) },
    registry: { itemsByName: Object.fromEntries(Object.entries(ids).map(([name, id]) => [name, { id }])) },
    inventory: { items: () => carried },
    findBlocks: () => [],
    blockAt: (pos: Vec3) => pos.x === CHEST.x && pos.y === CHEST.y && pos.z === CHEST.z ? { name: "chest", position: new Vec3(CHEST.x, CHEST.y, CHEST.z) } : null,
    openContainer: async () => {
      opens += 1;
      return {
        containerItems: () => chestItems,
        withdraw: async (id: number) => {
          const name = Object.keys(ids).find((key) => ids[key] === id)!;
          asked.push(name);
          carried.push({ name, count: 1 });
        },
        close: async () => {},
      };
    },
  } as unknown as Bot;
  const groups = [["iron_axe", "stone_axe", "wooden_axe"], ["iron_pickaxe", "stone_pickaxe", "wooden_pickaxe"]];
  const taken = await leased(() => withdrawFirstOfEach(bot, state, storage, groups, silent));
  assert.deepEqual(taken, ["stone_pickaxe"]);
  assert.deepEqual(asked, ["stone_pickaxe"], "no withdraw for spares the chest does not hold");
  assert.equal(opens, 1);
});

test("a registered chest under the furnace is unregistered; the real one stays", () => {
  // 65,96,51 sat under the home furnace (65,97,51), could never open, and
  // stayed registered beside the real home chest at 64,96,52.
  const rows = [{ id: 3, x: 65, y: 96, z: 51 }, { id: 4, x: 64, y: 96, z: 52 }, { id: 5, x: 200, y: 70, z: 200 }];
  const removed: number[] = [];
  const repo = { list: () => rows, remove: (_world: number, id: number) => { removed.push(id); } } as unknown as StorageRepository;
  const blocks: Record<string, { name: string; boundingBox: string }> = {
    "65,96,51": { name: "chest", boundingBox: "block" },
    "65,97,51": { name: "furnace", boundingBox: "block" },
    "64,96,52": { name: "chest", boundingBox: "block" },
    "64,97,52": { name: "air", boundingBox: "empty" },
  };
  const bot = { blockAt: (p: Vec3) => blocks[`${p.x},${p.y},${p.z}`] ?? null } as unknown as Bot;
  assert.equal(pruneBlockedChests(bot, state, repo), 1);
  assert.deepEqual(removed, [3], "the open chest and the unloaded far one are kept");
});
