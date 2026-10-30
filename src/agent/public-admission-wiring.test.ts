import test from "node:test";
import assert from "node:assert/strict";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { EventBus } from "../events/bus.js";
import { AppDatabase } from "../memory/database.js";
import { MIGRATIONS } from "../memory/migrations.js";
import { TasksRepository } from "../memory/tasks.js";
import { Scheduler } from "./scheduler.js";
import { TaskPriority, type NewTask } from "./task.js";
import { createPublicAdmission, PUBLIC_GESTURE_OWNER } from "./public-admission-wiring.js";
import { bindPublicOwnerChatInterrupt, bindPublicSafetyInterrupts } from "./public-action-safety.js";
import { PublicActionController, PUBLIC_ACTIONS, type GestureBot } from "./public-actions.js";
import { fakeGestureBot } from "./public-actions.fixture.js";
import type { AdmissionGate } from "./public-action-admission.js";

const OWNER = "Owner";
function userTask(): NewTask {
  return { type: "collect_resource", priority: TaskPriority.FOREGROUND, source: "user", objective: "Gather logs.", parameters: { resource: "oak_log", quantity: 4 } };
}
/** Real scheduler, world lease, event bus and admission predicate around a fake Mineflayer session. */
function wiring(options: { manualTicks?: boolean } = {}) {
  const db = new AppDatabase(":memory:"); db.runMigrations(MIGRATIONS);
  const bus = new EventBus();
  const scheduler = new Scheduler({ bus, tasks: new TasksRepository(db) });
  const effects: unknown[] = [];
  const bot = Object.assign(fakeGestureBot(effects, options), {
    isAlive: true, health: 20, food: 20, isSleeping: false, usingHeldItem: false, autoEat: { isEating: false },
    entity: { id: 1, yaw: 2, pitch: 0.3, onGround: true, isInWater: false, isInLava: false, velocity: new Vec3(0, -0.078, 0), position: new Vec3(0, 64, 0) },
    entities: {} as Record<number, unknown>, controlState: { forward: false, jump: false },
    pathfinder: { isMoving: () => false, isMining: () => false, isBuilding: () => false, goal: null },
    blockAt: () => ({ boundingBox: "empty" }),
  });
  const flags = { ready: true, fresh: true, deathLoop: false, project: null as unknown, thinking: false, goal: null as unknown, bootstrap: true, background: false };
  let live: { bot: Bot; publicSafety: { fresh(): boolean }; background: { publicWorkPending: boolean } } | null = {
    bot: bot as unknown as Bot, publicSafety: { fresh: () => flags.fresh }, background: { get publicWorkPending() { return flags.background; } },
  };
  const admission = createPublicAdmission({
    session: () => live, connectionReady: () => flags.ready, retreatHealth: () => 8, inDeathLoop: () => flags.deathLoop, scheduler,
    currentProject: () => flags.project, decisionThinking: () => flags.thinking, activeGoal: () => flags.goal, bootstrapComplete: () => flags.bootstrap,
  });
  const controller = new PublicActionController({
    session: () => (live?.bot as unknown as GestureBot) ?? null,
    safe: candidate => admission(candidate).safe,
    tryRun: (signal, action) => scheduler.tryPublicWorldAction(signal, action),
  });
  let cancels = 0;
  const cancel = (): void => { cancels++; controller.invalidate(); };
  bindPublicSafetyInterrupts(bus, cancel);
  bindPublicOwnerChatInterrupt(bot as unknown as Bot, OWNER, cancel);
  return { db, bus, scheduler, bot, effects, flags, admission, controller, cancels: () => cancels, drop: () => { live = null; } };
}
const turn = () => new Promise(resolve => setImmediate(resolve));
const diagnose = (w: ReturnType<typeof wiring>) => w.admission(w.bot as unknown as GestureBot, true);

test("the real wiring admits each gesture once under the public-gesture lease owner", async () => {
  const w = wiring();
  assert.equal(diagnose(w).safe, true);
  for (const action of PUBLIC_ACTIONS) {
    let owner: string | null = null;
    const look = w.bot.look; w.bot.look = async (...args) => { owner = w.scheduler.worldActionOwner; return look(...args); };
    const chat = w.bot.chat; w.bot.chat = (text) => { owner = w.scheduler.worldActionOwner; chat(text); };
    const swing = w.bot.swingArm; w.bot.swingArm = (arm) => { owner = w.scheduler.worldActionOwner; swing(arm); };
    assert.equal(await w.controller.execute(action, new AbortController().signal), "dispatched");
    assert.equal(owner, PUBLIC_GESTURE_OWNER);
    Object.assign(w.bot, { look, chat, swingArm: swing });
  }
  assert.equal(w.effects.length, 4);
  assert.equal(w.scheduler.worldActionOwner, null);
  w.db.close();
});

test("every live blocker, set through the real scheduler/lease where one exists, refuses all four gestures", async () => {
  const cases: [AdmissionGate, (w: ReturnType<typeof wiring>) => void | (() => void)][] = [
    ["session", w => { w.flags.ready = false; }],
    ["physical", w => { (w.bot as unknown as { isAlive: boolean }).isAlive = false; }],
    ["freshness", w => { w.flags.fresh = false; }],
    ["threats", w => { (w.bot.entities as Record<number, unknown>)[9] = { id: 9, name: "enderman", type: "hostile", isValid: true, position: new Vec3(60, 20, 60) }; }],
    ["death_loop", w => { w.flags.deathLoop = true; }],
    ["scheduler", w => { w.scheduler.halt(); }],
    ["projects", w => { w.flags.project = { project: { status: "paused" } }; }],
    ["lease_owner", w => { const release = Promise.withResolvers<void>(); void w.scheduler.runWorldAction("task:owner", new AbortController().signal, () => release.promise); return () => release.resolve(); }],
    ["queued_tasks", w => { w.scheduler.enqueue(userTask()); }],
    ["active_task", w => { w.scheduler.enqueue(userTask()); w.scheduler.claim(); }],
    ["background", w => { w.flags.background = true; }],
    ["decision", w => { w.flags.thinking = true; }],
    ["goal", w => { w.flags.goal = { id: "g" }; }],
    ["bootstrap", w => { w.flags.bootstrap = false; }],
  ];
  for (const [gate, block] of cases) {
    const w = wiring();
    const release = block(w);
    const report = diagnose(w);
    assert.equal(report.checks[gate], "blocked", gate);
    assert.equal(report.safe, false);
    for (const action of PUBLIC_ACTIONS) assert.equal(await w.controller.execute(action, new AbortController().signal), "refused", `${gate}/${action}`);
    assert.deepEqual(w.effects, [], gate);
    release?.();
    await turn();
    w.db.close();
  }
});

test("a lease waiter and a pending interrupt block admission through the real scheduler", async () => {
  const w = wiring();
  const release = Promise.withResolvers<void>();
  const held = w.scheduler.runWorldAction("task:a", new AbortController().signal, () => release.promise);
  const waiting = w.scheduler.runWorldAction("task:b", new AbortController().signal, async () => undefined);
  const report = diagnose(w);
  assert.equal(report.checks.lease_waiters, "blocked"); assert.equal(report.checks.lease_owner, "blocked");
  release.resolve(); await held; await waiting;
  w.scheduler.enqueue(userTask()); w.scheduler.claim(); w.scheduler.requestPause();
  assert.equal(diagnose(w).checks.interrupt, "blocked");
  w.db.close();
});

test("the enderman refusal applies to all four gestures at any loaded distance; false metadata does not prove calm", async () => {
  for (const [x, metadata] of [[2, { 17: false, 18: false }], [120, {}], [-90, { 17: false }]] as const) {
    const w = wiring();
    (w.bot.entities as Record<number, unknown>)[9] = { id: 9, name: "enderman", type: "hostile", isValid: true, metadata, position: new Vec3(x, 64, 0) };
    for (const action of PUBLIC_ACTIONS) assert.equal(await w.controller.execute(action, new AbortController().signal), "refused");
    assert.deepEqual(w.effects, []);
    w.db.close();
  }
});

test("owner chat on any path and survival/task events preempt a reserved gesture before its effect", async () => {
  const triggers: [string, (w: ReturnType<typeof wiring>) => void][] = [
    ["owner chat (LLM path)", w => { w.bot.emit("chat", OWNER, "what are you doing?"); }],
    ["owner command", w => { w.bus.emit("chat.command", { from: OWNER, command: "stop" }); }],
    ["damage", w => { w.bus.emit("damage.received", { health: 15 } as never); }],
    ["hunger", w => { w.bus.emit("hunger.low", { food: 8 } as never); }],
    ["night", w => { w.bus.emit("time.night", { time: "night" } as never); }],
    ["task created", w => { w.scheduler.enqueue(userTask()); }],
    ["death", w => { w.bus.emit("death.recorded", {} as never); }],
  ];
  for (const [name, trigger] of triggers) for (const action of PUBLIC_ACTIONS) {
    const w = wiring();
    const original = w.scheduler.tryPublicWorldAction.bind(w.scheduler);
    w.scheduler.tryPublicWorldAction = (signal, run) => original(signal, async lease => { await Promise.resolve(); return run(lease); });
    const work = w.controller.execute(action, new AbortController().signal);
    trigger(w);
    assert.equal(await work, "refused", `${name}/${action}`);
    assert.deepEqual(w.effects, []);
    assert.equal(w.scheduler.worldActionOwner, null);
    w.db.close();
  }
  const w = wiring();
  w.bot.emit("chat", "Visitor", "hello"); w.bot.emit("chat", "Visitor", "do something");
  assert.equal(w.cancels(), 0, "only the owner's chat preempts");
  w.db.close();
});

test("owner work arriving mid-turn waits only for the sent packet, keeps priority and is never stopped", async () => {
  const w = wiring({ manualTicks: true });
  const gesture = w.controller.execute("look_left", new AbortController().signal);
  await turn();
  assert.equal(w.effects.length, 1);
  // Owner work is queued and its world action waits behind the one-tick primitive, not a public queue.
  w.scheduler.enqueue(userTask());
  let ownerRan = false;
  const owner = w.scheduler.runWorldAction("task:owner", new AbortController().signal, async () => { ownerRan = true; });
  assert.equal(w.scheduler.worldActionDiagnostics.pending, 1); assert.equal(ownerRan, false);
  w.bot.emit("physicsTick");
  assert.equal(await gesture, "interrupted", "the turn was already handed to the client and is recorded as irreversible");
  await owner;
  assert.equal(ownerRan, true);
  assert.equal(w.bot.controlState.forward, false, "public cleanup never touches movement controls");
  assert.equal(w.scheduler.queued.length, 1, "owner task untouched");
  assert.equal(await w.controller.execute("hello", new AbortController().signal), "refused");
  w.db.close();
});

test("a dropped session refuses without effects; a late settlement cannot act on a replacement", async () => {
  const w = wiring({ manualTicks: true });
  const work = w.controller.execute("look_right", new AbortController().signal);
  await turn();
  w.drop();
  w.bot.emit("end");
  assert.equal(await work, "interrupted");
  assert.equal(await w.controller.execute("hello", new AbortController().signal), "refused");
  assert.equal(w.effects.length, 1);
  w.db.close();
});
