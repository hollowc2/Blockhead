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
  notStrictEqual(snapshot.inventory, (bot as unknown as { inventory: unknown }).inventory);
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
