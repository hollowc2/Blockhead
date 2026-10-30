import test from "node:test";
import assert from "node:assert/strict";
import { PublicActionController, PUBLIC_ACTIONS, type GestureBot, type GestureDispatch } from "./public-actions.js";
import { fakeGestureBot } from "./public-actions.fixture.js";
import { WorldActionExecutor } from "./world-actions.js";
import { safePublicPhysicalState } from "./public-action-safety.js";
import type { Bot } from "mineflayer";

function harness(options: { manualTicks?: boolean; budgetMs?: number } = {}) {
  const effects: unknown[] = [];
  const executor = new WorldActionExecutor();
  const bot = fakeGestureBot(effects, options);
  let session: GestureBot | null = bot, safe = true;
  const controller = new PublicActionController({ session: () => session, safe: () => safe, tryRun: (signal, action) => executor.tryRun("public", signal, action), budgetMs: options.budgetMs });
  return { controller, bot, effects, executor, setSafe: (value: boolean) => { safe = value; }, replace: (next: GestureBot | null) => { session = next; }, reconnect: () => { session = fakeGestureBot(effects); }, offline: () => { session = null; } };
}
const turn = () => new Promise(resolve => setImmediate(resolve));

test("four explicit gestures issue only their fixed effect once and report dispatch, not confirmation", async () => {
  const h = harness();
  for (const action of PUBLIC_ACTIONS) assert.equal(await h.controller.execute(action, new AbortController().signal), "dispatched");
  assert.deepEqual(h.effects, [["chat", "Hello, everyone!"], ["swing", "right"], ["look", 2 + Math.PI / 4, 0.3, true], ["look", 2, 0.3, true]]);
  assert.equal(await h.controller.execute("__proto__" as never, new AbortController().signal), "refused");
  assert.deepEqual(h.controller.diagnostics().dispatches, { refused: 1, dispatched: 4, interrupted: 0, uncertain: 0 });
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
    assert.deepEqual(await Promise.all([first, second]), ["refused", "refused"]);
    assert.deepEqual(h.effects, []); assert.equal(h.executor.pendingCount, 0); assert.equal(h.executor.activeOwner, null);
  }
});

test("concurrent visitors cannot both own the action", async () => {
  const h = harness({ manualTicks: true });
  const first = h.controller.execute("look_left", new AbortController().signal);
  const second = h.controller.execute("look_right", new AbortController().signal);
  assert.equal(await second, "refused");
  await turn(); h.bot.emit("physicsTick");
  assert.equal(await first, "dispatched");
  assert.equal(h.effects.length, 1);
});

test("occupied lease refuses without queue; aborted work cannot act", async () => {
  const h = harness(), release = Promise.withResolvers<void>();
  const held = h.executor.run("owner", new AbortController().signal, () => release.promise);
  assert.equal(await h.controller.execute("hello", new AbortController().signal), "refused");
  assert.equal(h.executor.pendingCount, 0); release.resolve(); await held;
  const aborted = new AbortController(); aborted.abort();
  assert.equal(await h.controller.execute("hello", aborted.signal), "refused");
  assert.deepEqual(h.effects, []);
});

test("a turn keeps the lease until Mineflayer's next physics tick writes it", async () => {
  const h = harness({ manualTicks: true });
  const work = h.controller.execute("look_right", new AbortController().signal);
  await turn(); await turn();
  // Local orientation changed, packet not yet written: the lease is still public.
  assert.equal(h.effects.length, 1); assert.equal(h.executor.activeOwner, "public"); assert.equal(h.controller.available(), false);
  h.bot.emit("physicsTick");
  assert.equal(await work, "dispatched");
  assert.equal(h.executor.activeOwner, null); assert.equal(h.controller.available(), true);
  assert.equal(h.bot.listenerCount("physicsTick"), 0); assert.equal(h.bot.listenerCount("end"), 0);
});

test("cancellation after the primitive started is an irreversible dispatch, never a cancellation", async () => {
  for (const interrupt of ["abort", "invalidate", "end", "replace"] as const) {
    const h = harness({ manualTicks: true }), request = new AbortController();
    const work = h.controller.execute("look_left", request.signal);
    await turn();
    assert.equal(h.effects.length, 1);
    if (interrupt === "abort") request.abort();
    if (interrupt === "invalidate") h.controller.invalidate();
    if (interrupt === "replace") h.reconnect();
    if (interrupt === "end") h.bot.emit("end"); else h.bot.emit("physicsTick");
    assert.equal(await work, "interrupted", interrupt);
    assert.equal(h.controller.diagnostics().quarantined, false);
    assert.equal(h.executor.activeOwner, null);
  }
});

test("unsettled primitive retains the lease after the deadline and quarantines for the process lifetime", async () => {
  const h = harness({ budgetMs: 20 }), release = Promise.withResolvers<void>();
  h.bot.look = () => release.promise;
  assert.equal(await h.controller.execute("look_left", new AbortController().signal), "uncertain");
  assert.equal(h.controller.available(), false); assert.equal(h.executor.activeOwner, "public");
  assert.deepEqual({ ...h.controller.diagnostics(), dispatches: undefined }, { active: true, quarantined: true, quarantineCause: "timeout", dispatches: undefined });
  // A replacement session cannot receive the late continuation or clear quarantine.
  const replacement = fakeGestureBot(h.effects);
  h.replace(replacement);
  release.resolve(); await turn(); h.bot.emit("physicsTick"); await turn();
  assert.equal(h.executor.activeOwner, null); assert.equal(h.controller.available(), false);
  assert.equal(h.controller.diagnostics().active, false);
  assert.equal(await h.controller.execute("hello", new AbortController().signal), "refused");
  assert.equal(h.effects.length, 0);
});

test("a turn whose physics tick never comes is uncertain, quarantined, and holds the lease until the connection ends", async () => {
  const h = harness({ manualTicks: true, budgetMs: 20 });
  assert.equal(await h.controller.execute("look_right", new AbortController().signal), "uncertain");
  assert.equal(h.executor.activeOwner, "public");
  h.bot.emit("end"); await turn();
  assert.equal(h.executor.activeOwner, null);
  assert.equal(h.controller.diagnostics().quarantineCause, "timeout");
});

test("a primitive that throws after starting is uncertain and quarantines; before starting it is refused", async () => {
  const h = harness();
  h.bot.chat = () => { throw Error("write after end"); };
  assert.equal(await h.controller.execute("hello", new AbortController().signal), "uncertain");
  assert.equal(h.controller.diagnostics().quarantineCause, "primitive_error");
  assert.equal(h.executor.activeOwner, null);
  const outcomes: GestureDispatch[] = [];
  for (const action of PUBLIC_ACTIONS) outcomes.push(await h.controller.execute(action, new AbortController().signal));
  assert.deepEqual(outcomes, ["refused", "refused", "refused", "refused"]);
});

test("repeated sessions leave no listeners, lease or active state behind", async () => {
  const h = harness();
  for (let n = 0; n < 20; n++) {
    h.reconnect();
    assert.equal(await h.controller.execute(n % 2 ? "look_left" : "wave", new AbortController().signal), "dispatched");
  }
  assert.equal(h.bot.listenerCount("physicsTick") + h.bot.listenerCount("end"), 0);
  assert.equal(h.executor.activeOwner, null); assert.equal(h.executor.pendingCount, 0);
  assert.equal(h.controller.diagnostics().active, false);
});

function physical() {
  return { isAlive: true, entity: { yaw: 0, pitch: 0.2, onGround: true, isInWater: false, isInLava: false, velocity: { x: 0, y: -0.078, z: 0 } }, health: 20, food: 20, isSleeping: false, usingHeldItem: false, autoEat: { isEating: false }, controlState: { forward: false }, pathfinder: { isMoving: () => false, isMining: () => false, isBuilding: () => false } };
}
test("physical admission fails closed for unsafe or missing observations", () => {
  assert.equal(safePublicPhysicalState(physical() as unknown as Bot, 8), true);
  for (const patch of [{ entity: undefined }, { isAlive: false }, { isAlive: undefined }, { health: 8 }, { health: Infinity }, { food: 8 }, { food: 10 }, { food: Infinity }, { isSleeping: true }, { usingHeldItem: true }, { autoEat: undefined }, { autoEat: { isEating: true } }, { pathfinder: undefined }, { pathfinder: {} }, { controlState: { forward: true } }, { targetDigBlock: {} }, { currentWindow: {} }, { pvp: { target: {} } }]) {
    assert.equal(safePublicPhysicalState({ ...physical(), ...patch } as unknown as Bot, 8), false, JSON.stringify(patch));
  }
  for (const patch of [{ onGround: false }, { isInWater: true }, { isInWater: undefined }, { isInLava: true }, { vehicle: {} }, { yaw: NaN }, { velocity: { x: 1, y: 0, z: 0 } }]) {
    const bot = physical(); Object.assign(bot.entity, patch); assert.equal(safePublicPhysicalState(bot as unknown as Bot, 8), false);
  }
});
