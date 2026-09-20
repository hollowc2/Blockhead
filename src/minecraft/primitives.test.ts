import assert from "node:assert/strict";
import { test } from "node:test";
import { WorldActionExecutor } from "../agent/world-actions.js";
import { craftRecipe, deposit, openContainer } from "./primitives.js";
import { placeItemAt, type PlacementSpot } from "./world.js";

test("a hanging container mutation retains the lease until the plugin settles", async () => {
  const executor = new WorldActionExecutor();
  const controller = new AbortController();
  let settleDeposit!: () => void;
  let replacementStarted = false;
  const bot = {
    openContainer: async () => ({
      deposit: () => new Promise<void>((resolve) => { settleDeposit = resolve; }),
      withdraw: async () => undefined,
      close: async () => undefined,
    }),
  } as any;

  const first = executor.run("hanging-window", controller.signal, async () => {
    const window = await openContainer(bot, {} as any);
    await deposit(window, 1, null, 1);
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const replacement = executor.run("replacement-window", new AbortController().signal, async () => {
    replacementStarted = true;
  });
  controller.abort(new Error("window cancelled"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(replacementStarted, false);
  settleDeposit();
  await assert.rejects(first, /window cancelled|aborted/i);
  await replacement;
  assert.equal(replacementStarted, true);
  assert.equal(executor.activeOwner, null);
});

test("window adapters reject an already-aborted signal before mutation", async () => {
  const executor = new WorldActionExecutor();
  const controller = new AbortController();
  controller.abort(new Error("missing window"));
  let opened = false;
  const bot = { openContainer: async () => { opened = true; return {} as any; } } as any;
  await assert.rejects(
    executor.run("aborted-window", controller.signal, async () => openContainer(bot, {} as any, controller.signal)),
    /missing window|aborted/i,
  );
  assert.equal(opened, false);
});

test("an explicit signal cannot bypass the active lease requirement", async () => {
  let opened = false;
  const bot = { openContainer: async () => { opened = true; return {} as any; } } as any;
  await assert.rejects(openContainer(bot, {} as any, new AbortController().signal), /active scheduler lease/);
  assert.equal(opened, false);
});

test("crafting is rejected outside a scheduler lease", async () => {
  let crafted = false;
  const bot = { craft: async () => { crafted = true; } } as any;
  await assert.rejects(craftRecipe(bot, {} as any, 1, undefined, new AbortController().signal), /active scheduler lease/);
  assert.equal(crafted, false);
});

test("window mutations retain the opened block for each policy recheck", async () => {
  const executor = new WorldActionExecutor();
  const seen: Array<{ action: string; point?: { x: number; y: number; z: number } }> = [];
  const bot = {
    openContainer: async () => ({ deposit: async () => undefined, close: async () => undefined }),
  } as any;
  const block = { name: "chest", position: { x: 9, y: 64, z: -3 } } as any;
  await executor.run("window-policy-point", new AbortController().signal, async () => {
    const window = await openContainer(bot, block);
    await deposit(window, 1, null, 1);
  }, { beforeMutation: (mutation) => seen.push({ action: mutation.action, point: mutation.point }) });
  assert.deepEqual(seen, [
    { action: "container", point: block.position },
    { action: "container", point: block.position },
  ]);
});

test("placement waits for a late authoritative block update and reports every poll", async () => {
  const executor = new WorldActionExecutor();
  const controller = new AbortController();
  const item = { name: "oak_planks", count: 1 } as any;
  const target = { x: 2, y: 64, z: 2 };
  const reference = { name: "stone", position: { x: 2, y: 63, z: 2 } } as any;
  let polls = 0;
  let placed = false;
  const observations: string[] = [];
  const bot = {
    inventory: { items: () => [item] },
    equip: async () => undefined,
    placeBlock: async () => { placed = true; },
    blockAt: () => {
      polls += 1;
      return placed && polls >= 3 ? { name: "oak_planks", boundingBox: "block", position: target } as any : { name: "air", boundingBox: "empty", position: target } as any;
    },
  } as any;
  const spot: PlacementSpot = { position: target as any, reference, face: { x: 0, y: 1, z: 0 } as any };
  const result = await executor.run("late-placement", controller.signal, async () => placeItemAt(bot, item, spot, controller.signal, {
    onPoll: (observation) => observations.push(observation.block?.name ?? "null"),
  }));
  assert.equal(result?.name, "oak_planks");
  assert.deepEqual(observations.slice(0, 3), ["air", "air", "oak_planks"]);
  assert.equal(placed, true);
});

test("a placement error still checks whether the server accepted the block", async () => {
  const executor = new WorldActionExecutor();
  const controller = new AbortController();
  const item = { name: "oak_planks", count: 1 } as any;
  const target = { x: 4, y: 64, z: 4 };
  const bot = {
    inventory: { items: () => [item] },
    equip: async () => undefined,
    placeBlock: async () => { throw Object.assign(new Error("client acknowledgement lost"), { acceptedByServer: true }); },
    blockAt: () => ({ name: "oak_planks", boundingBox: "block", position: target } as any),
  } as any;
  const spot: PlacementSpot = { position: target as any, reference: { name: "stone", position: { x: 4, y: 63, z: 4 } } as any, face: { x: 0, y: 1, z: 0 } as any };
  const result = await executor.run("accepted-after-error", controller.signal, async () => placeItemAt(bot, item, spot, controller.signal));
  assert.equal(result?.name, "oak_planks");
});

test("placement skips an equip round-trip when the requested item is already held", async () => {
  const executor = new WorldActionExecutor();
  const item = { name: "stone_bricks", count: 1 } as any;
  let equips = 0;
  const target = { x: 6, y: 64, z: 6 };
  const bot = {
    heldItem: item,
    inventory: { items: () => [item] },
    equip: async () => { equips += 1; },
    placeBlock: async () => undefined,
    blockAt: () => ({ name: "stone_bricks", boundingBox: "block", position: target } as any),
  } as any;
  const spot: PlacementSpot = { position: target as any, reference: { name: "stone", position: { x: 6, y: 63, z: 6 } } as any, face: { x: 0, y: 1, z: 0 } as any };
  const result = await executor.run("held-placement", new AbortController().signal, async () => placeItemAt(bot, item, spot));
  assert.equal(result?.name, "stone_bricks");
  assert.equal(equips, 0);
});

test("placement confirmation supports a bounded fast polling policy", async () => {
  const executor = new WorldActionExecutor();
  const item = { name: "stone_bricks", count: 1 } as any;
  const target = { x: 8, y: 64, z: 8 };
  let polls = 0;
  const bot = {
    inventory: { items: () => [item] },
    equip: async () => undefined,
    placeBlock: async () => undefined,
    blockAt: () => {
      polls += 1;
      return { name: "air", boundingBox: "empty", position: target } as any;
    },
  } as any;
  const spot: PlacementSpot = { position: target as any, reference: { name: "stone", position: { x: 8, y: 63, z: 8 } } as any, face: { x: 0, y: 1, z: 0 } as any };
  const result = await executor.run("fast-placement-poll", new AbortController().signal, async () => placeItemAt(bot, item, spot, undefined, { maxPolls: 3, pollIntervalMs: 1 }));
  assert.equal(result, null);
  assert.equal(polls, 3);
});
