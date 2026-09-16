import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { startDashboard } from "./lifecycle.js";
import type { DashboardSnapshot } from "./types.js";

const snapshot = (): DashboardSnapshot => ({
  schema: 1, process: { startedAt: "2026-01-01T00:00:00.000Z", uptimeSeconds: 0 },
  connection: { connected: false, player: null, server: null },
  self: { health: null, hunger: null, position: null, dimension: null, timePhase: null },
  goal: null, task: null, action: { label: "Standing by", taskId: null }, background: { label: "Standing by", taskId: null },
  stockpiles: null, inventory: null, danger: null,
  llmLastCall: { at: null, latencyMs: null, tool: null, rationale: null },
  llmActivity: { state: "not_called", thinking: false, decisionType: null, thinkingStartedAt: null, thinkingDurationMs: null, model: null, endpoint: null, lastAction: null, lastRationale: null, lastLatencyMs: null, lastFailure: null },
  path: null, recentEvents: [], recentFailures: [], recentChat: [],
});

test("disabled dashboard does not create a server", () => {
  assert.equal(startDashboard({ enabled: false, host: "127.0.0.1", port: 0, snapshot }), null);
});

test("dashboard starts without a bot session and can be stopped cleanly", async () => {
  const server = startDashboard({ enabled: true, host: "127.0.0.1", port: 0, snapshot });
  assert.ok(server);
  for (let attempt = 0; attempt < 50 && server.address() === null; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.notEqual(server.address(), null);
  server.stop();
  assert.equal(server.address(), null);
});

test("dashboard startup failure is contained", async () => {
  const occupied = createServer();
  await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", () => resolve()));
  const port = (occupied.address() as { port: number }).port;
  const dashboard = startDashboard({ enabled: true, host: "127.0.0.1", port, snapshot });
  assert.ok(dashboard);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(dashboard.address(), null);
  dashboard.stop();
  await new Promise<void>((resolve, reject) => occupied.close((error) => error ? reject(error) : resolve()));
});
