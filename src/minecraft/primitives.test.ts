import assert from "node:assert/strict";
import { test } from "node:test";
import { WorldActionExecutor } from "../agent/world-actions.js";
import { deposit, openContainer } from "./primitives.js";

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
