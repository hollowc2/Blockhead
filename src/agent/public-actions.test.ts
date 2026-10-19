import test from "node:test";
import assert from "node:assert/strict";
import { PublicActionController, PUBLIC_ACTIONS, type GestureBot } from "./public-actions.js";
import { WorldActionExecutor } from "./world-actions.js";
import { safePublicPhysicalState } from "./public-action-safety.js";
import type { Bot } from "mineflayer";

function harness() {
  const effects: unknown[] = [];
  const executor = new WorldActionExecutor();
  const bot: GestureBot = { entity: { yaw: 2, pitch: 0.3 }, chat: text => { effects.push(["chat", text]); }, swingArm: arm => { effects.push(["swing", arm]); }, look: async (...args) => { effects.push(["look", ...args]); } };
  let session: GestureBot | null = bot, safe = true;
  const controller = new PublicActionController({ session: () => session, safe: () => safe, tryRun: (signal, action) => executor.tryRun("public", signal, action) });
  return { controller, bot, effects, executor, setSafe: (value: boolean) => { safe = value; }, reconnect: () => { session = { ...bot }; }, offline: () => { session = null; } };
}
test("four explicit gestures issue only their fixed effect once", async () => {
  const h = harness();
  for (const action of PUBLIC_ACTIONS) assert.equal(await h.controller.execute(action, new AbortController().signal), true);
  assert.deepEqual(h.effects, [["chat", "Hello, everyone!"], ["swing", "right"], ["look", 2 + Math.PI / 4, 0.3, true], ["look", 2 - Math.PI / 4, 0.3, true]]);
  assert.equal(await h.controller.execute("__proto__" as never, new AbortController().signal), false);
});
test("ownership is immediate, concurrent work never queues, invalidation/reconnect prevents stale effects", async () => {
  for (const invalidate of [(h: ReturnType<typeof harness>) => h.controller.invalidate(), (h: ReturnType<typeof harness>) => h.reconnect(), (h: ReturnType<typeof harness>) => h.setSafe(false), (h: ReturnType<typeof harness>) => h.offline()]) {
    const h = harness();
    // Pause between ownership reservation and execution to exercise the last safety check.
    const original = h.executor.tryRun.bind(h.executor);
    h.executor.tryRun = (owner, signal, action) => original(owner, signal, async lease => { await Promise.resolve(); return action(lease); });
    const first = h.controller.execute("hello", new AbortController().signal);
    const second = h.controller.execute("wave", new AbortController().signal);
    invalidate(h);
    assert.deepEqual(await Promise.all([first, second]), [false, false]);
    assert.deepEqual(h.effects, []); assert.equal(h.executor.pendingCount, 0);
  }
});
test("occupied lease refuses without queue; aborted work cannot act", async () => {
  const h = harness(), release = Promise.withResolvers<void>();
  const held = h.executor.run("owner", new AbortController().signal, () => release.promise);
  assert.equal(await h.controller.execute("hello", new AbortController().signal), false);
  assert.equal(h.executor.pendingCount, 0); release.resolve(); await held;
  const aborted = new AbortController(); aborted.abort();
  assert.equal(await h.controller.execute("hello", aborted.signal), false);
  assert.deepEqual(h.effects, []);
});
test("unsettled primitive retains lease after deadline and quarantines gestures", async () => {
  const h = harness(), release = Promise.withResolvers<void>(); h.bot.look = () => release.promise;
  assert.equal(await h.controller.execute("look_left", new AbortController().signal), false);
  assert.equal(h.controller.available(), false); assert.equal(h.executor.activeOwner, "public");
  release.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.executor.activeOwner, null); assert.equal(h.controller.available(), false);
});
function physical() {
  return { entity: { yaw: 0, pitch: 0.2, onGround: true, isInWater: false, isInLava: false, velocity: { x: 0, y: -0.078, z: 0 } }, health: 20, food: 20, isSleeping: false, usingHeldItem: false, autoEat: { isEating: false }, controlState: { forward: false }, pathfinder: { isMoving: () => false, isMining: () => false, isBuilding: () => false } };
}
test("physical admission fails closed for unsafe or missing observations", () => {
  assert.equal(safePublicPhysicalState(physical() as unknown as Bot, 8), true);
  for (const patch of [{ entity: undefined }, { health: 8 }, { food: 8 }, { isSleeping: true }, { usingHeldItem: true }, { autoEat: undefined }, { autoEat: { isEating: true } }, { pathfinder: undefined }, { controlState: { forward: true } }, { targetDigBlock: {} }, { currentWindow: {} }, { pvp: { target: {} } }]) {
    assert.equal(safePublicPhysicalState({ ...physical(), ...patch } as unknown as Bot, 8), false);
  }
  for (const patch of [{ onGround: false }, { isInWater: true }, { isInWater: undefined }, { isInLava: true }, { vehicle: {} }, { yaw: NaN }, { velocity: { x: 1, y: 0, z: 0 } }]) {
    const bot = physical(); Object.assign(bot.entity, patch); assert.equal(safePublicPhysicalState(bot as unknown as Bot, 8), false);
  }
});
