import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bot } from "mineflayer";
import type { Logger } from "pino";
import type { MinecraftConfig } from "../config/schema.js";
import { EventBus } from "../events/bus.js";
import type { BootstrapRunner } from "../skills/bootstrap-survival.js";
import type { CollectResourceRunner } from "../skills/collect-resource.js";
import type { OrganizeStorageRunner } from "../skills/organize-storage.js";
import type { DecisionMaker } from "../llm/decider.js";
import type { NextTaskDecision } from "../llm/schemas.js";
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
  /** How many times the director stub was consulted. */
  decisionCount: number;
  /** Tasks the manager asked the scheduler to enqueue (director choices). */
  enqueued: Array<Task>;
  /** Whether the organize-storage probe reports work this tick. */
  organizeNeedsWork: boolean;
  /** The live config object; tests mutate `background` keys to drive cadence. */
  config: MinecraftConfig;
  advance(ms: number): void;
}

function newHarness(health: number, food: number): Harness {
  let now = 1_000_000;
  const bot = { entity: {}, health, food } as unknown as Bot;
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
    decisionCount: 0,
    enqueued: [],
    organizeNeedsWork: false,
    config,
    advance: (ms: number) => {
      now += ms;
    },
  };

  const options: BackgroundManagerOptions = {
    bot,
    state: {} as unknown as AgentState,
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
      decideNextTask: async (): Promise<NextTaskDecision> => {
        state.decisionCount++;
        if (state.directorFails) throw new Error("llm unreachable");
        return state.directorResult;
      },
    } as unknown as DecisionMaker,
    bootstrap: { completedStage: BootstrapStage.NORMAL_OPERATION } as unknown as BootstrapRunner,
    organizeStorage: {
      isRunning: false,
      needsAttention: async () => ({
        needsWork: state.organizeNeedsWork,
        reason: state.organizeNeedsWork ? "chests full" : "none",
      }),
    } as unknown as OrganizeStorageRunner,
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