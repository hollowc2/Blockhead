import assert from "node:assert/strict";
import { test } from "node:test";
import { EventBus } from "../events/bus.js";
import { TaskStatus, TaskPriority, type Task } from "../agent/task.js";
import { TaskOutcomeTracker } from "./outcomes.js";
import { buildStatusSnapshot, deriveAutonomy, type StatusInput } from "./snapshot.js";

const task = (overrides: Partial<Task> = {}): Task => ({ id: "t1", type: "gather_food", priority: TaskPriority.BACKGROUND, source: "background", objective: "Gather food", parameters: {}, status: TaskStatus.ACTIVE, createdAt: "2026-01-01T00:00:00.000Z", ...overrides });
const input = (overrides: Partial<StatusInput> = {}): StatusInput => ({
  startedAtMs: 1_000, nowMs: () => 4_000, player: "CobbleBob", connected: true,
  state: { self: { position: { x: 1, y: 2, z: 3 }, health: 20, food: 18, dimension: "overworld" }, timePhase: "day" },
  scheduler: { active: task(), queued: [], interruptPending: false, pendingInterruptReason: null, blockedActions: () => [] },
  goal: null, decider: { lastCall: { at: 2_000, latencyMs: 50, tool: "gather_food", rationale: "safe" } },
  client: { endpoint: "http://127.0.0.1:8080", modelName: "local", healthState: "ok", reachable: true, lastSuccessAt: 2_500, consecutiveFailures: 0, lastFailure: null },
  inDeathLoop: false, outcomes: { last: null, consecutiveFailures: 0, recent: () => [] }, ...overrides,
});

test("builds a machine-readable snapshot with uptime and timestamps", () => {
  const snapshot = buildStatusSnapshot(input());
  assert.equal(snapshot.schema, 1);
  assert.equal(snapshot.process.uptimeSeconds, 3);
  assert.equal(snapshot.minecraft.player, "CobbleBob");
  assert.equal(snapshot.llm.lastSuccessAgeSeconds, 1.5);
  assert.equal(snapshot.llm.lastDecision?.at, "1970-01-01T00:00:02.000Z");
});

test("reports disconnected state and pauses autonomy", () => {
  const snapshot = buildStatusSnapshot(input({ connected: false, player: null, state: { self: { position: null, health: 20, food: 20, dimension: null }, timePhase: null } }));
  assert.deepEqual(snapshot.autonomy, { paused: true, reasons: ["disconnected"] });
  assert.equal(snapshot.minecraft.position, null);
});

test("reports user work, interrupt, and death-loop pause reasons", () => {
  const scheduler = input().scheduler;
  assert.deepEqual(deriveAutonomy({ connected: true, inDeathLoop: true, scheduler: { ...scheduler, active: task({ source: "user" }), interruptPending: true, pendingInterruptReason: "pause" } }), { paused: true, reasons: ["interrupt:pause", "user-task-active", "death-loop-brake"] });
});

test("tracks consecutive task failures and resets after success", () => {
  const bus = new EventBus();
  const tracker = new TaskOutcomeTracker({ bus, now: () => 1_000 });
  bus.emit("task.failed", { task: task({ status: TaskStatus.FAILED, lastError: "no path", completedAt: "2026-01-01T00:00:01.000Z" }) });
  bus.emit("task.blocked", { task: task({ status: TaskStatus.BLOCKED }) });
  assert.equal(tracker.consecutiveFailures, 2);
  assert.equal(tracker.last?.status, "blocked");
  bus.emit("task.completed", { task: task({ status: TaskStatus.COMPLETED }) });
  assert.equal(tracker.consecutiveFailures, 0);
  assert.equal(tracker.last?.status, "completed");
  tracker.dispose();
  assert.equal(bus.listenerCount("task.failed"), 0);
});
