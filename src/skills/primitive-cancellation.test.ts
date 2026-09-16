import assert from "node:assert/strict";
import { test } from "node:test";
import { WorldActionExecutor } from "../agent/world-actions.js";
import { withTimeout } from "./skill-library.js";

test("collect-style timeout awaits plugin cancellation and settlement", async () => {
  const executor = new WorldActionExecutor();
  let settled = false;
  let cancel!: () => void;
  const run = executor.run("collect-test", new AbortController().signal, async () => {
    const operation = new Promise<void>((resolve) => { cancel = resolve; });
    await assert.rejects(withTimeout(1, operation, async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
      cancel();
    }), /timed out/);
    settled = true;
  });
  await run;
  assert.equal(settled, true);
  assert.equal(executor.activeOwner, null);
});

test("PvP-style timeout does not release an owner before attack settlement", async () => {
  const executor = new WorldActionExecutor();
  let settled = false;
  let cancel!: () => void;
  const run = executor.run("pvp-test", new AbortController().signal, async () => {
    const attack = new Promise<void>((resolve) => { cancel = resolve; });
    await assert.rejects(withTimeout(1, attack, async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
      cancel();
    }), /timed out/);
    settled = true;
  });
  await run;
  assert.equal(settled, true);
  assert.equal(executor.activeOwner, null);
});
