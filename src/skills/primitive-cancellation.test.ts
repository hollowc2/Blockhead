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

test("pvpAttack waits for the target to die instead of resolving when the fight starts", async () => {
  const { EventEmitter } = await import("node:events");
  const { pvpAttack } = await import("../minecraft/primitives.js");
  const executor = new WorldActionExecutor();
  const bot = Object.assign(new EventEmitter(), {
    entities: { 5: {} } as Record<number, unknown>,
    pvp: { attack: async () => {} },
  });
  const cow = { id: 5, name: "cow", position: { x: 0, y: 64, z: 0 } };
  let finished = false;
  const run = executor.run("hunt-test", new AbortController().signal, async (lease) => {
    await pvpAttack(bot as never, cow as never, lease.signal);
    finished = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(finished, false, "the fight is still on while the cow lives");
  delete bot.entities[5];
  bot.emit("entityGone", cow);
  await run;
  assert.equal(finished, true);
});

test("a target that dies mid-fight reads as defeated before its corpse despawns", async () => {
  const { EventEmitter } = await import("node:events");
  const { pvpAttack } = await import("../minecraft/primitives.js");
  const { combatOutcomeObserved } = await import("../policy/combat.js");
  const executor = new WorldActionExecutor();
  const sheep = { id: 6, name: "sheep", position: { x: 0, y: 64, z: 0 }, isValid: true } as { id: number; name: string; position: unknown; isValid: boolean; health?: number };
  const bot = Object.assign(new EventEmitter(), { entities: { 6: sheep } as Record<number, unknown>, pvp: { attack: async () => {} } });
  const run = executor.run("hunt-test", new AbortController().signal, async (lease) => pvpAttack(bot as never, sheep as never, lease.signal));
  await new Promise((resolve) => setTimeout(resolve, 5));
  bot.emit("entityDead", sheep);
  await run;
  assert.equal(combatOutcomeObserved(bot as never, sheep as never), true, "still listed in bot.entities, but dead");
});
