import assert from "node:assert/strict";
import { test } from "node:test";
import { WorldActionExecutor } from "../agent/world-actions.js";
import { craftRecipe, deposit, openContainer } from "./primitives.js";

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
