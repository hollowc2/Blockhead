import assert from "node:assert/strict";
import { test } from "node:test";
import type { DashboardSnapshot } from "./types.js";
import { cachedPublicState, toPublicViewerState } from "./public-state.js";

/** A snapshot full of things that must never reach the public listener. */
const secretSnapshot = (): DashboardSnapshot => ({
  schema: 1, process: { startedAt: "2026-01-01T00:00:00.000Z", uptimeSeconds: 42 },
  connection: { connected: true, player: "CobbleBob", server: "mc.secret-host.example:25565" },
  viewer: { enabled: true, status: "running", port: 3001, distance: 6, failure: null },
  self: { health: 19.5, hunger: 17, position: { x: 1234.5, y: 64, z: -987.25 }, dimension: "overworld", timePhase: "day" },
  goal: { id: "g1", description: "Guard HomeBase at 1200 64 -950", source: "owner", status: "active", createdAt: "2026-01-01T00:00:00.000Z", currentStep: "walk home", successCriteria: [], recentResults: [], note: "owner OwnerSecretName asked", endedAt: null } as never,
  task: { id: "t1", type: "goto", priority: "high", source: "owner", objective: "return to base 1200 64 -950", status: "running", createdAt: "2026-01-01T00:00:00.000Z", startedAt: null, completedAt: null, phase: null, attempts: 1, lastError: "/home/corey/secret/path.ts:12" } as never,
  buildProject: null,
  action: { label: "Walking to 1200 64 -950", taskId: "t1" },
  background: { label: "Mining diamonds", taskId: null },
  stockpiles: null,
  inventory: { items: [{ name: "diamond", count: 12 }], totalItems: 12 },
  danger: { score: 1, nearestHostile: { type: "zombie", distance: 5 }, hostileCount: 1 },
  llmLastCall: { at: null, latencyMs: 100, tool: "goto", rationale: "SECRET-PROMPT-RATIONALE" },
  llmActivity: { state: "thinking", thinking: true, decisionType: "owner_instruction", thinkingStartedAt: null, thinkingDurationMs: null, model: "secret-model", endpoint: "http://10.0.0.5:8080/v1?api_key=sk-SECRET", lastAction: "goto", lastRationale: "SECRET-PROMPT-RATIONALE", lastLatencyMs: 100, lastFailure: { at: "x", kind: "http", error: "stack at /home/corey" } },
  path: { status: "moving", destination: { x: 1200, y: 64, z: -950 }, distance: 40 },
  recentEvents: [{ at: "x", kind: "home", message: "home set at 1200 64 -950" }],
  recentFailures: [{ at: "x", kind: "error", message: "Error: at /mnt/Repos/Games/Blockhead/src/x.ts" }],
  recentChat: [{ at: "x", sender: "OwnerSecretName", message: "the base is at 1200 64 -950" }],
});

test("public state is an allowlisted, redacted projection", () => {
  assert.deepEqual(toPublicViewerState(secretSnapshot()), {
    public: true,
    connection: { connected: true },
    self: { health: 20, hunger: 17, dimension: "overworld", timePhase: "day" },
    viewer: { status: "running" },
  });
});

test("public state leaks no coordinates, names, chat, LLM data or internals", () => {
  const body = JSON.stringify(toPublicViewerState(secretSnapshot()));
  for (const secret of ["1234", "987", "1200", "-950", "OwnerSecretName", "CobbleBob", "secret", "SECRET", "diamond", "/home", "/mnt", "zombie", "position", "chat", "llm", "3001", "Walking", "goal", "task"]) {
    assert.equal(body.includes(secret), false, `public state contains ${secret}`);
  }
});

test("public state is cached so polling does not drive snapshot cost", async () => {
  let calls = 0;
  let now = 0;
  const state = cachedPublicState(() => { calls += 1; return secretSnapshot(); }, 1000, () => now);
  await state();
  await state();
  now = 999;
  await state();
  assert.equal(calls, 1);
  now = 1000;
  await state();
  assert.equal(calls, 2);
});

test("a failed snapshot is not cached", async () => {
  let fail = true;
  const state = cachedPublicState(() => { if (fail) throw new Error("boom"); return secretSnapshot(); }, 1000, () => 0);
  await assert.rejects(state());
  fail = false;
  assert.equal((await state()).public, true);
});
