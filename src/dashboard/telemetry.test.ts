import { deepStrictEqual, equal, notStrictEqual, ok } from "node:assert/strict";
import test from "node:test";
import type { Bot } from "mineflayer";
import type { AgentState } from "../agent/state.js";
import type { Scheduler } from "../agent/scheduler.js";
import type { GoalManager } from "../agent/goals.js";
import type { DashboardTelemetrySource } from "./telemetry.js";
import { DashboardTelemetryCollector } from "./telemetry.js";

const history = {
  recentEvents: () => [{ at: "2026-01-01T00:00:00.000Z", category: "task", severity: "info", message: "Task activated" }],
  recentFailures: () => [],
  recentChat: () => [],
};

function source(overrides: Partial<DashboardTelemetrySource> = {}): DashboardTelemetrySource {
  const task = {
    id: "task-1", type: "collect_resource", priority: 70, source: "user", objective: "Gather wood",
    parameters: {}, status: "active", createdAt: "2026-01-01T00:00:00.000Z", startedAt: "2026-01-01T00:00:01.000Z",
  } as const;
  return {
    startedAtMs: 0,
    nowMs: () => 5_000,
    bot: () => null,
    maintenance: () => null,
    hostile: () => null,
    state: { self: { position: null, health: 20, food: 20, dimension: null }, timePhase: null } as unknown as AgentState,
    scheduler: { active: null, queued: [] } as unknown as Scheduler,
    goals: () => null,
    eventHistory: history as never,
    ...overrides,
  };
}

test("collects a disconnected snapshot with explicit unavailable values", () => {
  const snapshot = new DashboardTelemetryCollector(source()).snapshot();
  equal(snapshot.connection.connected, false);
  equal(snapshot.inventory, null);
  equal(snapshot.equipment, null);
  equal(snapshot.stockpiles, null);
  equal(snapshot.danger, null);
  equal(snapshot.goal, null);
  equal(snapshot.self.health, null);
  equal(snapshot.process.uptimeSeconds, 5);
});

test("collects a connected bot snapshot without retaining the bot", () => {
  const bot = { username: "CobbleBob", entity: { position: { x: 1, y: 64, z: -2 } }, inventory: { items: () => [{ name: "oak_log", count: 3 }] } } as unknown as Bot;
  const snapshot = new DashboardTelemetryCollector(source({
    bot: () => bot,
    state: { self: { position: { x: 1, y: 64, z: -2 }, health: 18, food: 16, dimension: "overworld" }, timePhase: "day" } as unknown as AgentState,
  })).snapshot();
  equal(snapshot.connection.connected, true);
  equal(snapshot.connection.player, "CobbleBob");
  deepStrictEqual(snapshot.inventory?.items, [{ name: "oak_log", count: 3 }]);
  equal(snapshot.self.timeOfDay, null, "no clock before the first time packet");
  notStrictEqual(snapshot.inventory, (bot as unknown as { inventory: unknown }).inventory);
});

test("reads the current bot from the getter after a reconnect", () => {
  const firstBot = { username: "FirstBot", entity: { position: { x: 1, y: 64, z: 1 } }, inventory: { items: () => [] } } as unknown as Bot;
  const secondBot = { username: "SecondBot", entity: { position: { x: 2, y: 64, z: 2 } }, inventory: { items: () => [] } } as unknown as Bot;
  let currentBot: Bot | null = firstBot;
  const collector = new DashboardTelemetryCollector(source({ bot: () => currentBot }));

  equal(collector.snapshot().connection.player, "FirstBot");
  currentBot = secondBot;
  equal(collector.snapshot().connection.player, "SecondBot");
  currentBot = null;
  equal(collector.snapshot().connection.connected, false);
});

test("tracks actual equipped gear, equipment changes and reconnects without retaining items", () => {
  const sword = { name: "iron_sword", count: 1, nbt: { customName: "secret" } };
  const slots: Record<number, unknown> = { 5: { name: "iron_helmet", count: 1 }, 6: { name: "iron_chestplate", count: 1 }, 7: { name: "iron_leggings", count: 1 }, 8: { name: "iron_boots", count: 1 }, 45: { name: "shield", count: 1 } };
  const destinations: Record<string, number> = { head: 5, torso: 6, legs: 7, feet: 8, "off-hand": 45 };
  let bot: Bot | null = { entity: {}, heldItem: sword, inventory: { items: () => [sword], slots }, getEquipmentDestSlot: (slot: string) => destinations[slot] } as unknown as Bot;
  const collector = new DashboardTelemetryCollector(source({ bot: () => bot }));
  const first = collector.snapshot();
  deepStrictEqual(first.equipment, {
    hand: { name: "iron_sword", count: 1 }, "off-hand": { name: "shield", count: 1 },
    head: { name: "iron_helmet", count: 1 }, torso: { name: "iron_chestplate", count: 1 },
    legs: { name: "iron_leggings", count: 1 }, feet: { name: "iron_boots", count: 1 },
  });
  notStrictEqual(first.equipment?.hand, sword);
  sword.name = "iron_pickaxe";
  slots[5] = null;
  equal(collector.snapshot().equipment?.hand?.name, "iron_pickaxe");
  equal(collector.snapshot().equipment?.head, null);
  equal(first.equipment?.hand?.name, "iron_sword");
  bot = null;
  equal(collector.snapshot().equipment, null);
});

test("does not query an unsupported off-hand slot on older Minecraft versions", () => {
  const bot = { entity: {}, inventory: { items: () => [], slots: [] }, supportFeature: () => true,
    getEquipmentDestSlot: (slot: string) => { if (slot === "off-hand") throw new Error("unsupported slot"); return 5; },
  } as unknown as Bot;
  equal(new DashboardTelemetryCollector(source({ bot: () => bot })).snapshot().equipment?.["off-hand"], null);
});

test("projects an active goal and active task", () => {
  const goal = { id: "goal-1", description: "Prepare", source: "owner", status: "active", createdAt: "2026-01-01T00:00:00.000Z", currentStep: "gather", successCriteria: [], recentResults: [] };
  const task = { id: "task-1", type: "collect_resource", priority: 70, source: "user", objective: "Gather wood", parameters: {}, status: "active", createdAt: "2026-01-01T00:00:00.000Z" };
  const snapshot = new DashboardTelemetryCollector(source({
    goals: () => ({ active: () => goal } as unknown as GoalManager),
    scheduler: { active: task, queued: [] } as unknown as Scheduler,
  })).snapshot();
  equal(snapshot.goal?.description, "Prepare");
  equal(snapshot.task?.objective, "Gather wood");
  equal(snapshot.action.taskId, "task-1");
});

test("handles missing optional services and serializes as JSON", () => {
  const snapshot = new DashboardTelemetryCollector(source({ decider: null, client: null })).snapshot();
  const parsed = JSON.parse(JSON.stringify(snapshot)) as typeof snapshot;
  deepStrictEqual(parsed, snapshot);
  equal(snapshot.llmLastCall.at, null);
  deepStrictEqual(snapshot.llmActivity, {
    state: "disconnected", thinking: false, decisionType: null, thinkingStartedAt: null, thinkingDurationMs: null,
    model: null, endpoint: null, lastAction: null, lastRationale: null, lastLatencyMs: null, lastFailure: null,
  });
});

test("exposes an active thinking decision and duration", () => {
  const snapshot = new DashboardTelemetryCollector(source({
    nowMs: () => 5_000,
    decider: { activity: { thinking: true, callType: "background_director", startedAt: "1970-01-01T00:00:02.000Z" }, lastCall: null } as never,
    client: { modelName: "local-model", endpoint: "http://llm", lastFailure: null } as never,
  })).snapshot();

  deepStrictEqual(snapshot.llmActivity, {
    state: "thinking", thinking: true, decisionType: "background_director",
    thinkingStartedAt: "1970-01-01T00:00:02.000Z", thinkingDurationMs: 3_000,
    model: "local-model", endpoint: "http://llm", lastAction: null, lastRationale: null, lastLatencyMs: null, lastFailure: null,
  });
});

test("distinguishes a successful idle model from a model that has not been called", () => {
  const client = { modelName: "local-model", endpoint: "http://llm", lastFailure: null } as never;
  const notCalled = new DashboardTelemetryCollector(source({ client, decider: { activity: { thinking: false, callType: null, startedAt: null }, lastCall: null } as never })).snapshot();
  equal(notCalled.llmActivity.state, "not_called");

  const idle = new DashboardTelemetryCollector(source({
    client,
    decider: {
      activity: { thinking: false, callType: null, startedAt: null },
      lastCall: { at: 1_000, latencyMs: 250, tool: "respond", rationale: "safe", success: true, error: null },
    } as never,
  })).snapshot();
  deepStrictEqual(idle.llmActivity, {
    state: "idle", thinking: false, decisionType: null, thinkingStartedAt: null, thinkingDurationMs: null,
    model: "local-model", endpoint: "http://llm", lastAction: "respond", lastRationale: "safe", lastLatencyMs: 250, lastFailure: null,
  });
});

test("preserves concise failure metadata without prompts or raw responses", () => {
  const snapshot = new DashboardTelemetryCollector(source({
    scheduler: { active: { id: "task-1", type: "wait", priority: 20, source: "system", objective: "Wait", parameters: {}, status: "active", createdAt: "now" }, queued: [] } as never,
    decider: {
      activity: { thinking: false, callType: null, startedAt: null },
      lastCall: { at: 1_000, latencyMs: 400, tool: "unknown", rationale: null, success: false, error: "connection refused" },
    } as never,
    client: { modelName: "local-model", endpoint: "http://llm", lastFailure: { at: 2_000, kind: "network_error", error: "connection refused" } } as never,
  })).snapshot();

  deepStrictEqual(snapshot.llmActivity.lastFailure, { at: "1970-01-01T00:00:02.000Z", kind: "network_error", error: "connection refused" });
  equal(snapshot.llmActivity.state, "working");
  ok(!("prompt" in snapshot.llmActivity));
  ok(!("response" in snapshot.llmActivity));
});

test("does not mutate source state while projecting", () => {
  const self = { position: null, health: 20, food: 20, dimension: null };
  const task = { id: "task-1", type: "wait", priority: 20, source: "system", objective: "Wait", parameters: {}, status: "active", createdAt: "2026-01-01T00:00:00.000Z" };
  const scheduler = { active: task, queued: [] };
  const state = { self, timePhase: null } as unknown as AgentState;
  new DashboardTelemetryCollector(source({ state, scheduler: scheduler as unknown as Scheduler })).snapshot();
  deepStrictEqual(self, { position: null, health: 20, food: 20, dimension: null });
  deepStrictEqual(task, { id: "task-1", type: "wait", priority: 20, source: "system", objective: "Wait", parameters: {}, status: "active", createdAt: "2026-01-01T00:00:00.000Z" });
  ok(true);
});

test("gathers broadcast inputs: vitals, decisions, the config model label and every private term", () => {
  const bot = { username: "CobbleBob", entity: { position: { x: 1, y: 64, z: -2 } }, players: { CobbleBob: {}, Visitor: {} }, inventory: { items: () => [] } } as unknown as Bot;
  const config = {
    agent: { name: "CobbleBob", owner: "Barnabyisbig" },
    server: { host: "mc.secret-host.example", port: 25565, username: "CobbleBob" },
    llm: { base_url: "http://llm-box.lan:8080" },
    dashboard: { public_viewer: { model_label: "Qwen3.5 9B", interactions: { allowed_origin: "https://maia.tailceb694.ts.net", model_questions: { base_url: "http://127.0.0.1:8000" } } } },
  } as never;
  let since: number | null = null;
  const snapshot = new DashboardTelemetryCollector(source({
    config,
    bot: () => bot,
    nowMs: () => 7_200_000,
    decider: {
      activity: { thinking: false, callType: null, startedAt: null },
      lastCall: { at: 1_000, latencyMs: 400, tool: "unknown", rationale: null, success: false, error: "down" },
      lastDecision: { at: 500, latencyMs: 812, tool: "collect_resource", rationale: "Gather wood.", spectator: "Chopping some trees.", callType: "background_director" },
      decisionsSince: (at: number) => { since = at; return 12; },
    } as never,
    broadcast: { vitals: () => [{ at: "2026-01-01T00:00:00.000Z", health: 20, hunger: 18 }], names: () => ["Barnabyisbig", "LeftEarlier"] },
  })).snapshot();
  const inputs = snapshot.broadcast!;
  equal(since, 3_600_000);
  equal(inputs.decisionsLastHour, 12);
  deepStrictEqual(inputs.lastDecision, { at: "1970-01-01T00:00:00.500Z", latencyMs: 812, tool: "collect_resource", callType: "background_director", rationale: "Gather wood.", spectator: "Chopping some trees." });
  equal(inputs.modelLabel, "Qwen3.5 9B");
  deepStrictEqual(inputs.vitals, [{ at: "2026-01-01T00:00:00.000Z", health: 20, hunger: 18 }]);
  const terms = inputs.privateTerms.map((term) => term.toLowerCase());
  for (const term of ["barnabyisbig", "cobblebob", "visitor", "leftearlier", "mc.secret-host.example", "secret-host", "llm-box", "maia", "tailceb694", "maia.tailceb694.ts.net"]) ok(terms.includes(term), term);
  // Short host labels would reject ordinary words ("net" in "nether").
  for (const label of ["ts", "net", "mc", "lan"]) ok(!terms.includes(label), label);
  equal(new Set(terms).size, terms.length, "terms are deduplicated");
});

test("broadcast inputs degrade to empty without a decider, tracker or config", () => {
  const snapshot = new DashboardTelemetryCollector(source()).snapshot();
  deepStrictEqual({ ...snapshot.broadcast, privateTerms: [] }, { vitals: [], decisionsLastHour: 0, lastDecision: null, privateTerms: [], modelLabel: null });
});

test("reports the world clock as whole ticks into the day while connected", () => {
  const time = { timeOfDay: 0 as number | null };
  const bot = { username: "CobbleBob", entity: { position: { x: 1, y: 64, z: -2 } }, time, inventory: { items: () => [] } } as unknown as Bot;
  let current: Bot | null = bot;
  const collector = new DashboardTelemetryCollector(source({ bot: () => current }));
  for (const [raw, ticks] of [[6012.7, 6012], [23_999, 23_999], [48_123, 123], [-50, 23_950], [null, null]] as const) {
    time.timeOfDay = raw;
    equal(collector.snapshot().self.timeOfDay, ticks, String(raw));
  }
  current = null;
  equal(collector.snapshot().self.timeOfDay, null);
});
