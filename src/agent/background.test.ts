import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bot } from "mineflayer";
import type { Logger } from "pino";
import type { MinecraftConfig } from "../config/schema.js";
import { EventBus } from "../events/bus.js";
import type { BootstrapRunner } from "../skills/bootstrap-survival.js";
import type { CollectResourceRunner } from "../skills/collect-resource.js";
import type { OrganizeStorageRunner } from "../skills/organize-storage.js";
import type { BaseBuilderRunner } from "../skills/base.js";
import type { DecisionMaker } from "../llm/decider.js";
import type { DecisionInput } from "../llm/context.js";
import type { ToolContext } from "../tools/types.js";
import type { NextTaskDecision } from "../llm/schemas.js";
import type { StorageRepository } from "../memory/storage.js";
import type { AgentState } from "./state.js";
import type { StockpileDeficit, StockpileManager, StockpileSnapshot } from "./maintenance.js";
import type { Scheduler } from "./scheduler.js";
import { TaskPriority, TaskStatus, type NewTask, type Task } from "./task.js";
import { BootstrapStage } from "./bootstrap.js";
import { BackgroundManager, type BackgroundManagerOptions } from "./background.js";

/**
 * Phase 7.1 regression: a stockpile restore that cannot succeed used to
 * re-enqueue every settled tick (1s apart), announcing the same "Stuck:"
 * line into game chat until the server kicked CobbleBob for spam
 * (`disconnect.spam`). The background loop now stands down a kind within its
 * restore cooldown window with a single standing-by notice, then retries
 * when the window expires. Food is never blocked by bot state: `gather_food`
 * hunts nearby passive mobs even at low health, so the manager's re-runs are
 * how the bot notices the world changed (an animal wandered near, a player
 * fed it).
 */

/** The Phase 8 crisis fixture used by every harness: food floor breached. */
function foodCrisis(): StockpileDeficit {
  return { kind: "food", target: 64, current: 0, deficit: 64 };
}

/** A just-failed background food restore, as `task.failed` carries it. */
function failedFoodTask(): Task {
  return {
    id: "fail-food-1",
    type: "stockpile_maintenance",
    priority: TaskPriority.MAINTENANCE,
    source: "background",
    objective: "Restore food stockpile to 64",
    parameters: { kind: "food", target: 64, current: 0, deficit: 64 },
    status: TaskStatus.FAILED,
    createdAt: new Date().toISOString(),
    lastError: "only 0/4 food found nearby",
  };
}

/** A just-failed director build, as `task.failed` carries it. */
function failedDirectorBuildTask(): Task {
  return {
    id: "fail-dir-build-1",
    type: "build_base",
    priority: TaskPriority.BACKGROUND,
    source: "director",
    objective: "Build the base structure at home.",
    parameters: {},
    status: TaskStatus.FAILED,
    createdAt: new Date().toISOString(),
    lastError: "walls burned down",
  };
}

/** A successfully completed director build, as `task.completed` carries it. */
function completedDirectorBuildTask(): Task {
  return {
    id: "ok-dir-build-1",
    type: "build_base",
    priority: TaskPriority.BACKGROUND,
    source: "director",
    objective: "Build the base structure at home.",
    parameters: {},
    status: TaskStatus.COMPLETED,
    createdAt: new Date().toISOString(),
  };
}

interface Harness {
  manager: BackgroundManager;
  bus: EventBus;
  /** Maintenance stub: what the crisis/shortage gates return this tick. */
  crisis: StockpileDeficit | null;
  shortage: StockpileDeficit | null;
  /** Maintenance stubs for what the manager actually issued. */
  issued: Array<{ kind: string; preempt: boolean }>;
  /** `logger.warn` payloads (standing-by notices carry `kind`). */
  warns: Array<Record<string, unknown>>;
  /** Death-loop brake flag the manager's `inDeathLoop` getter reads. */
  loop: boolean;
  /** Background tasks the manager was asked to cancel this tick. */
  cancelled: string[];
  /** Queued tasks the scheduler reports (the manager prunes stale `background` ones). */
  queued: Task[];
  /** What the director stub returns this tick. */
  directorResult: NextTaskDecision;
  /** True makes the director stub throw (model down). */
  directorFails: boolean;
  /** When set, the director stub awaits it before returning (single-flight tests). */
  decisionGate: Promise<void> | null;
  /** How many times the director stub was consulted. */
  decisionCount: number;
  /** The situation digest handed to the director on the last consultation. */
  lastSituation: string | null;
  /** Tasks the manager asked the scheduler to enqueue (director choices). */
  enqueued: Array<Task>;
  /** Whether the organize-storage probe reports work this tick. */
  organizeNeedsWork: boolean;
  /** Whether the base-structure probe reports work this tick. */
  buildNeedsWork: boolean;
  /** The live config object; tests mutate `background` keys to drive cadence. */
  config: MinecraftConfig;
  advance(ms: number): void;
}

function newHarness(health: number, food: number): Harness {
  let now = 1_000_000;
  const bot = {
    entity: {},
    health,
    food,
    // No chests anywhere: findHomeChest's scan comes up empty, so the idle
    // loop's storage-repair probe takes its stub restore path every tick.
    findBlocks: () => [],
  } as unknown as Bot;
  const bus = new EventBus();
  const warns: Array<Record<string, unknown>> = [];
  const logger = {
    info: () => {},
    warn: (obj: Record<string, unknown>, _msg: string) => {
      warns.push(obj);
    },
    error: () => {},
  } as unknown as Logger;

  const config = {
    background: {
      restore_cooldown_seconds: 60,
      announce_throttle_seconds: 30,
      // The director is enabled; the interval starts at 0 so tests drive
      // cadence directly, then raise it where the throttle is the target.
      llm_decisions: true,
      llm_decision_interval_seconds: 0,
    },
  } as unknown as MinecraftConfig;

  const state: Harness = {
    manager: undefined!,
    bus,
    crisis: foodCrisis(),
    shortage: null,
    issued: [],
    warns,
    loop: false,
    cancelled: [],
    queued: [],
    directorResult: { task: { type: "wait" } },
    directorFails: false,
    decisionGate: null,
    decisionCount: 0,
    enqueued: [],
    lastSituation: null,
    organizeNeedsWork: false,
    buildNeedsWork: false,
    config,
    advance: (ms: number) => {
      now += ms;
    },
  };

  const options: BackgroundManagerOptions = {
    bot,
    state: { worldId: null, home: null } as unknown as AgentState,
    config,
    bus,
    scheduler: {
      queued: state.queued,
      active: null,
      cancel: (id: string) => {
        state.cancelled.push(id);
      },
      enqueue: (input: NewTask): Task => {
        const task = {
          ...input,
          id: `task-${state.enqueued.length + 1}`,
          status: TaskStatus.QUEUED,
          createdAt: new Date().toISOString(),
        } as Task;
        state.enqueued.push(task);
        state.queued.push(task);
        return task;
      },
      // No dispatch in the harness: claimed tasks stay queued and get pruned
      // by the next tick's stale-task sweep, like unclaimed work in the real
      // loop. Assertions read `enqueued`/`issued`, never the claim result.
      claim: () => null,
      // Anti-loop watchdog: no watchdog wired in tests, so nothing is blocked.
      blockedActions: () => [],
    } as unknown as Scheduler,
    maintenance: {
      isBusy: () => false,
      check: async (): Promise<StockpileSnapshot> => ({
        levels: { wood: 0, food: 0, fuel: 0, torches: 0 },
        targets: { wood: 64, food: 64, fuel: 64, torches: 64 },
        deficits: [foodCrisis()],
      }),
      crisisDeficit: () => state.crisis,
      prioritize: () => state.shortage,
      runMaintenance: (deficit: StockpileDeficit, options: { preempt?: boolean } = {}) => {
        state.issued.push({ kind: deficit.kind, preempt: options.preempt === true });
      },
    } as unknown as StockpileManager,
    collect: {} as unknown as CollectResourceRunner,
    decider: {
      decideNextTask: async (
        _input: DecisionInput,
        _ctx: ToolContext,
        situation: string,
      ): Promise<NextTaskDecision> => {
        state.decisionCount++;
        state.lastSituation = situation;
        if (state.decisionGate !== null) await state.decisionGate;
        if (state.directorFails) throw new Error("llm unreachable");
        return state.directorResult;
      },
    } as unknown as DecisionMaker,
    bootstrap: {
      completedStage: BootstrapStage.NORMAL_OPERATION,
      restoreHomeChest: async (): Promise<{ ok: true; message: string }> => ({ ok: true, message: "test chest" }),
    } as unknown as BootstrapRunner,
    organizeStorage: {
      isRunning: false,
      needsAttention: async () => ({
        needsWork: state.organizeNeedsWork,
        reason: state.organizeNeedsWork ? "chests full" : "none",
      }),
    } as unknown as OrganizeStorageRunner,
    buildBase: {
      isRunning: false,
      needsAttention: async () => ({
        needsWork: state.buildNeedsWork,
        reason: state.buildNeedsWork ? "walls missing" : null,
      }),
    } as unknown as BaseBuilderRunner,
    storage: {} as unknown as StorageRepository,
    logger,
    now: () => now,
    inDeathLoop: () => state.loop,
  };

  state.manager = new BackgroundManager(options);
  state.manager.start();
  return state;
}

test("a stuck food crisis re-enqueues at most once per cooldown window and retries after expiry", async () => {
  const h = newHarness(12, 19); // health fine: hunting is not blocked by state

  // Actionable crisis: preempts immediately.
  await h.manager.tick();
  assert.deepEqual(h.issued, [{ kind: "food", preempt: true }]);

  // The restore fails; the `task.failed` bus event records it.
  h.bus.emit("task.failed", { task: failedFoodTask() });

  // Inside the window: no re-enqueue, exactly one standing-by notice.
  h.advance(1_000);
  await h.manager.tick();
  assert.deepEqual(h.issued, [{ kind: "food", preempt: true }]);
  assert.equal(h.warns.filter((w) => w.kind === "food").length, 1);

  // Further ticks stay silent — no per-tick notice while the block holds.
  h.advance(1_000);
  await h.manager.tick();
  assert.deepEqual(h.issued, [{ kind: "food", preempt: true }]);
  assert.equal(h.warns.filter((w) => w.kind === "food").length, 1, "no per-tick re-notice");

  // Window expired: the kind is retried without any restart (acceptance
  // "starts after the cooldown expiry without a restart").
  h.advance(59_000);
  await h.manager.tick();
  assert.equal(h.issued.length, 2);
  assert.deepEqual(h.issued[1], { kind: "food", preempt: true });

  h.manager.stop();
});

test("a food crisis is attempted even at unregenerable low health, then stands down into the cooldown", async () => {
  // The evidenced world state: health 2.8/20, hunger 17/20 (< regen 18).
  const h = newHarness(2.8, 17);

  // The crisis launches immediately: the skill itself kills nearby passive
  // mobs at low health (they cannot fight back, and their meat is the only
  // recovery a starving bot can reach), so the manager no longer blocks.
  await h.manager.tick();
  assert.deepEqual(h.issued, [{ kind: "food", preempt: true }]);

  // The restore fails; the `task.failed` bus event records it.
  h.bus.emit("task.failed", { task: failedFoodTask() });

  // Inside the cooldown window: no re-enqueue, exactly one standing-by notice.
  h.advance(1_000);
  await h.manager.tick();
  assert.equal(h.issued.length, 1, "food stands down inside the cooldown window");
  assert.equal(h.warns.filter((w) => w.kind === "food").length, 1);

  // Window expired: the kind is retried even though health never changed —
  // a re-run is how the bot learns an animal wandered within reach.
  h.advance(59_000);
  await h.manager.tick();
  assert.equal(h.issued.length, 2);
  assert.deepEqual(h.issued[1], { kind: "food", preempt: true });

  h.manager.stop();
});

test("directed stockpile restores honor the per-kind failure cooldown", async () => {
  const h = newHarness(12, 19);
  h.crisis = null;
  h.shortage = null;
  h.directorResult = { task: { type: "stockpile_maintenance", kind: "food" } };

  // The LLM director picks the food restore; it runs at BACKGROUND priority.
  await h.manager.tick();
  assert.equal(h.decisionCount, 1);
  assert.deepEqual(h.issued, [{ kind: "food", preempt: false }]);

  // The restore fails; the `task.failed` bus event records it.
  h.bus.emit("task.failed", { task: failedFoodTask() });

  // Inside the window the director is consulted but its pick is vetoed —
  // no re-enqueue, exactly one standing-by notice.
  h.advance(1_000);
  await h.manager.tick();
  assert.equal(h.decisionCount, 2, "the director is still consulted");
  assert.equal(h.issued.length, 1, "directed restore stands down inside the cooldown window");
  assert.equal(h.warns.filter((w) => w.kind === "food").length, 1);

  // Window expired: the same directed decision runs again.
  h.advance(59_000);
  await h.manager.tick();
  assert.equal(h.issued.length, 2);
  assert.deepEqual(h.issued[1], { kind: "food", preempt: false });

  h.manager.stop();
});

test("a failed director task is recorded and suppresses the same directed pick during cooldown", async () => {
  const h = newHarness(12, 19);
  h.crisis = null;
  h.shortage = null;
  h.directorResult = { task: { type: "build_base" } };

  // The directed build runs once, sourced from the director.
  await h.manager.tick();
  assert.equal(h.decisionCount, 1);
  assert.equal(h.enqueued.length, 1);
  assert.equal(h.enqueued[0]!.source, "director");

  // A director-sourced failure lands in the same per-kind cooldown as a
  // background-sourced one: the tracking must not skip `director` tasks.
  h.bus.emit("task.failed", { task: failedDirectorBuildTask() });

  // Inside the window the same directed pick is vetoed — one standing-by
  // notice, no re-enqueue — and the digest handed to the director lists the
  // failure.
  h.advance(1_000);
  await h.manager.tick();
  assert.equal(h.decisionCount, 2, "the director is still consulted");
  assert.equal(h.enqueued.length, 1, "directed build stands down inside the cooldown window");
  assert.equal(h.warns.filter((w) => w.kind === "build").length, 1);
  assert.match(h.lastSituation ?? "", /Recent failures: build restore failed \(walls burned down\)/);

  // Window expired: the same directed pick runs again.
  h.advance(59_000);
  await h.manager.tick();
  assert.equal(h.enqueued.length, 2);
  assert.equal(h.enqueued[1]!.type, "build_base");

  h.manager.stop();
});

test("a successful director task is not marked failed and stays immediately re-pickable", async () => {
  const h = newHarness(12, 19);
  h.crisis = null;
  h.shortage = null;
  h.directorResult = { task: { type: "build_base" } };

  // The directed build runs and completes successfully.
  await h.manager.tick();
  assert.equal(h.enqueued.length, 1);
  h.bus.emit("task.completed", { task: completedDirectorBuildTask() });

  // The same directed pick runs again immediately: a completion must never
  // put the task into the failure cooldown — no notice, no digest entry.
  await h.manager.tick();
  assert.equal(h.enqueued.length, 2);
  assert.equal(h.warns.filter((w) => w.kind === "build").length, 0, "no standing-by notice after success");
  assert.doesNotMatch(h.lastSituation ?? "", /Recent failures/, "no recent failure recorded after success");

  h.manager.stop();
});

test("the LLM director maps choices to background tasks and honors wait", async () => {
  const h = newHarness(12, 19);
  h.crisis = null;
  h.shortage = null;
  h.directorResult = {
    task: { type: "collect_resource", resource: "iron_ore", quantity: 12 },
    rationale: "Stockpiles are fine; iron is the next useful goal.",
  };
  await h.manager.tick();
  assert.equal(h.decisionCount, 1);
  assert.equal(h.enqueued.length, 1);
  const task = h.enqueued[0]!;
  assert.equal(task.type, "collect_resource");
  assert.equal(task.priority, TaskPriority.BACKGROUND);
  assert.equal(task.source, "director");
  assert.deepEqual(task.parameters, { resource: "iron_ore", quantity: 12 });

  // "wait": nothing enqueued and no deterministic ladder work either — the
  // decision is the plan.
  h.directorResult = { task: { type: "wait" } };
  h.enqueued.length = 0;
  h.issued.length = 0;
  await h.manager.tick();
  assert.equal(h.decisionCount, 2);
  assert.equal(h.enqueued.length, 0);
  assert.equal(h.issued.length, 0);

  h.manager.stop();
});

test("the director consults the LLM at most once per interval and then stands by", async () => {
  const h = newHarness(12, 19);
  h.crisis = null;
  h.shortage = null;
  h.config.background!.llm_decision_interval_seconds = 60;

  await h.manager.tick();
  assert.equal(h.decisionCount, 1);

  h.advance(10_000);
  await h.manager.tick();
  assert.equal(h.decisionCount, 1, "inside the window the loop stands by without a new decision");

  h.advance(50_000);
  await h.manager.tick();
  assert.equal(h.decisionCount, 2, "after the window expires a fresh decision runs");

  h.manager.stop();
});

test("a director failure falls back to the deterministic ladder", async () => {
  const h = newHarness(12, 19);
  h.crisis = null;
  h.shortage = foodCrisis();
  h.directorFails = true;
  await h.manager.tick();
  assert.equal(h.decisionCount, 1);
  assert.deepEqual(h.issued, [{ kind: "food", preempt: false }]);

  // No shortage but storage work: the ladder still organizes storage, so a
  // dead LLM never stalls the bot.
  h.shortage = null;
  h.organizeNeedsWork = true;
  h.issued.length = 0;
  await h.manager.tick();
  assert.equal(h.enqueued.length, 1);
  assert.equal(h.enqueued[0]!.type, "organize_storage");
  assert.equal(h.enqueued[0]!.source, "background");

  h.manager.stop();
});

test("a missing base structure runs the build before storage expansion", async () => {
  const h = newHarness(12, 19);
  h.crisis = null;
  h.shortage = null;
  h.directorFails = true;
  h.buildNeedsWork = true;
  h.organizeNeedsWork = true; // storage also wants work; the shed wins

  await h.manager.tick();
  assert.equal(h.enqueued.length, 1);
  assert.equal(h.enqueued[0]!.type, "build_base");
  assert.equal(h.enqueued[0]!.priority, TaskPriority.BACKGROUND);
  assert.equal(h.enqueued[0]!.source, "background");

  h.manager.stop();
});

test("the director can direct a base build", async () => {
  const h = newHarness(12, 19);
  h.crisis = null;
  h.shortage = null;
  h.directorResult = { task: { type: "build_base" } };

  await h.manager.tick();
  assert.equal(h.decisionCount, 1);
  assert.equal(h.enqueued.length, 1);
  assert.equal(h.enqueued[0]!.type, "build_base");
  assert.equal(h.enqueued[0]!.source, "director");

  h.manager.stop();
});

test("the situation digest tells the director whether the base structure is incomplete", async () => {
  const h = newHarness(12, 19);
  h.crisis = null;
  h.shortage = null;
  h.directorResult = { task: { type: "wait" } };

  h.buildNeedsWork = true;
  await h.manager.tick();
  assert.match(h.lastSituation ?? "", /Base structure: incomplete \(walls missing\)\./);

  h.buildNeedsWork = false;
  await h.manager.tick();
  assert.match(h.lastSituation ?? "", /Base structure: complete\./);

  h.manager.stop();
});

test("the death-loop brake stands the loop down and prunes stale background work", async () => {
  const h = newHarness(12, 19);
  h.loop = true;
  h.queued.push({
    id: "stale-food",
    type: "stockpile_maintenance",
    priority: TaskPriority.MAINTENANCE,
    source: "background",
    objective: "Restore food stockpile to 64",
    parameters: { kind: "food" },
    status: TaskStatus.QUEUED,
    createdAt: new Date().toISOString(),
  });

  // A looming food crisis is NOT restored while the bot is dying at a kill
  // zone: the wandering hunt would feed the loop. Stale background work is
  // still pruned so it cannot run behind the brake.
  await h.manager.tick();
  assert.deepEqual(h.issued, [], "no restore while the death-loop brake holds");
  assert.deepEqual(h.cancelled, ["stale-food"]);

  // The brake lifting restores normal operation: next tick acts again.
  h.loop = false;
  await h.manager.tick();
  assert.deepEqual(h.issued, [{ kind: "food", preempt: true }]);

  h.manager.stop();
});

/**
 * The settle-event director kick is a real 1s `setTimeout` in the manager.
 * These tests replace the clock with node:test mock timers so the wiring
 * (event -> one pending kick -> decision-eligible pass) is exercised end to
 * end instead of poking internals. The harness's own `now`/`advance` clock
 * is separate and untouched, so the decision-interval gate stays real.
 */
const flushMacrotasks = async (): Promise<void> => {
  // The kicked pass awaits a few already-resolved stubs; each flush drains
  // the microtask chain plus one macrotask, which is enough to settle it.
  for (let i = 0; i < 5; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

test("a task completion schedules a fresh LLM decision inside the decision interval", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = newHarness(12, 19);
  h.crisis = null;
  h.shortage = null;
  h.config.background!.llm_decision_interval_seconds = 60;
  h.directorResult = { task: { type: "build_base" } };

  // First decision arms the interval gate.
  await h.manager.tick();
  assert.equal(h.decisionCount, 1);
  assert.equal(h.enqueued.length, 1);

  // Without an event, the loop stands by inside the window...
  h.advance(10_000);
  await h.manager.tick();
  assert.equal(h.decisionCount, 1, "plain ticks stay gated inside the interval");

  // ...until a task completes: the settle event kicks a fresh decision
  // within the window instead of waiting for the interval to expire.
  h.bus.emit("task.completed", { task: completedDirectorBuildTask() });
  t.mock.timers.tick(1_000);
  await flushMacrotasks();
  assert.equal(h.decisionCount, 2, "completion triggers a decision despite the interval");
  assert.equal(h.enqueued.length, 2, "the fresh decision enqueued new work");

  h.manager.stop();
  t.mock.timers.reset();
});

test("a task failure schedules a fresh LLM decision inside the decision interval", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = newHarness(12, 19);
  h.crisis = null;
  h.shortage = null;
  h.config.background!.llm_decision_interval_seconds = 60;
  h.directorResult = { task: { type: "build_base" } };

  await h.manager.tick();
  assert.equal(h.decisionCount, 1);
  assert.equal(h.enqueued.length, 1);

  // The directed build fails; the settle event records it and kicks a fresh
  // decision. The failure is visible in the digest the fresh decision sees.
  h.bus.emit("task.failed", { task: failedDirectorBuildTask() });
  t.mock.timers.tick(1_000);
  await flushMacrotasks();
  assert.equal(h.decisionCount, 2, "failure triggers a decision despite the interval");
  assert.match(h.lastSituation ?? "", /Recent failures: build restore failed \(walls burned down\)/);

  h.manager.stop();
  t.mock.timers.reset();
});

test("only one LLM decision runs at a time; a settle event during a decision re-checks once after", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = newHarness(12, 19);
  h.crisis = null;
  h.shortage = null;
  h.config.background!.llm_decision_interval_seconds = 60;
  let release!: () => void;
  h.decisionGate = new Promise<void>((resolve) => {
    release = resolve;
  });

  // A settle event starts a decision that blocks on the gate.
  h.bus.emit("task.completed", { task: completedDirectorBuildTask() });
  t.mock.timers.tick(1_000);
  await flushMacrotasks();
  assert.equal(h.decisionCount, 1, "the first decision started");

  // A second settle arrives while the decision is in flight: no concurrent
  // decision call is made — the kick is retained, never stacked.
  h.bus.emit("task.completed", { task: completedDirectorBuildTask() });
  t.mock.timers.tick(2_000);
  await flushMacrotasks();
  assert.equal(h.decisionCount, 1, "no second decision while one is in flight");

  // The in-flight decision finishes; the retained kick re-checks exactly
  // once, sequentially.
  release();
  await flushMacrotasks();
  assert.equal(h.decisionCount, 2, "the retained kick re-decides after the in-flight decision");

  h.manager.stop();
  t.mock.timers.reset();
});

test("repeated settle events coalesce into one decision and never duplicate concurrent calls", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = newHarness(12, 19);
  h.crisis = null;
  h.shortage = null;
  h.config.background!.llm_decision_interval_seconds = 60;

  // Decide once; the interval gate now stands plain ticks down.
  await h.manager.tick();
  assert.equal(h.decisionCount, 1);

  // A burst of five completions collapses into ONE pending kick — and the
  // kick does not fire before its delay elapses.
  for (let i = 0; i < 5; i++) {
    h.bus.emit("task.completed", { task: completedDirectorBuildTask() });
  }
  t.mock.timers.tick(999);
  await flushMacrotasks();
  assert.equal(h.decisionCount, 1, "kick not fired before its delay elapses");

  t.mock.timers.tick(1);
  await flushMacrotasks();
  assert.equal(h.decisionCount, 2, "one kick -> exactly one fresh decision for the burst");

  // A later burst gets its own single decision.
  for (let i = 0; i < 5; i++) {
    h.bus.emit("task.completed", { task: completedDirectorBuildTask() });
  }
  t.mock.timers.tick(1_000);
  await flushMacrotasks();
  assert.equal(h.decisionCount, 3, "each burst yields exactly one decision");

  h.manager.stop();
  t.mock.timers.reset();
});