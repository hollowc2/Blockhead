import assert from "node:assert/strict";
import { test } from "node:test";
import { WorldActionExecutor, stopWorldPrimitives } from "./world-actions.js";

test("world actions serialize and a cancelled waiter never acquires the lease", async () => {
  const executor = new WorldActionExecutor();
  const firstController = new AbortController();
  const secondController = new AbortController();
  const order: string[] = [];
  const first = executor.run("first", firstController.signal, async () => {
    order.push("first-start");
    await new Promise((resolve) => setTimeout(resolve, 10));
    order.push("first-end");
  });
  const second = executor.run("second", secondController.signal, async () => {
    order.push("second-start");
  });
  const secondRejected = assert.rejects(second, /cancelled/);
  secondController.abort(new Error("cancelled"));
  await first;
  await secondRejected;
  assert.deepEqual(order, ["first-start", "first-end"]);
  assert.equal(executor.activeOwner, null);
});

test("a failed world action releases ownership and cleanup stops every primitive", async () => {
  const executor = new WorldActionExecutor();
  await assert.rejects(executor.run("broken", new AbortController().signal, async () => {
    throw new Error("boom");
  }), /boom/);
  assert.equal(executor.activeOwner, null);

  const calls: string[] = [];
  await stopWorldPrimitives({
    pathfinder: { stop: () => calls.push("path-stop"), setGoal: () => calls.push("goal-clear") },
    collectBlock: { cancelTask: () => { calls.push("collect-cancel"); } },
    pvp: { stop: () => { calls.push("pvp-stop"); } },
    currentWindow: { close: () => calls.push("window-close") },
  });
  assert.deepEqual(calls, ["path-stop", "goal-clear", "collect-cancel", "pvp-stop", "window-close"]);
});
