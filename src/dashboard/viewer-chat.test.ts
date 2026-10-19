import assert from "node:assert/strict";
import { test } from "node:test";
import type { LlmMessage } from "../llm/client.js";
import type { DashboardSnapshot } from "./types.js";
import { buildViewerChatMessages, cleanAnswer, cleanQuestion, createViewerChat, MAX_QUESTION_CHARS } from "./viewer-chat.js";

const snapshot = (): DashboardSnapshot => ({
  schema: 1, process: { startedAt: "2026-01-01T00:00:00.000Z", uptimeSeconds: 42 },
  connection: { connected: true, player: "CobbleBob", server: "127.0.0.1:25565" },
  viewer: { enabled: true, status: "running", port: 3001, distance: 6, failure: null },
  self: { health: 18, hunger: 15, position: { x: 10, y: 64, z: -20 }, dimension: "overworld", timePhase: "day" },
  goal: { id: "g1", description: "Prepare for a mining expedition", source: "director", status: "active", createdAt: "x", currentStep: "ensure 1 iron_pickaxe", successCriteria: [], recentResults: [], note: null, endedAt: null } as never,
  task: { id: "t1", type: "mine", priority: "normal", source: "goal", objective: "Mine iron ore", status: "running", createdAt: "x", startedAt: null, completedAt: null, phase: "descending", attempts: 1, lastError: null } as never,
  buildProject: null,
  action: { label: "Mining iron ore", taskId: "t1" },
  background: { label: "", taskId: null },
  stockpiles: null,
  inventory: { items: [{ name: "diamond", count: 3 }], totalItems: 3 } as never,
  danger: { score: 0.1, nearestHostile: null, hostileCount: 0 },
  llmLastCall: {} as never,
  llmActivity: { state: "idle", thinking: false, decisionType: null, thinkingStartedAt: null, thinkingDurationMs: null, model: "m", endpoint: "http://10.0.0.5:8080", lastAction: null, lastRationale: "Need an iron pickaxe first.", lastLatencyMs: null, lastFailure: null },
  path: null,
  recentEvents: [{ at: "x", kind: "k", message: "picked up iron ore" }],
  recentFailures: [],
  recentChat: [{ at: "x", sender: "Owner", message: "PRIVATE-CHAT-LINE" }],
});

test("viewer chat prompt carries the bot's state and the question, but not chat logs or endpoints", () => {
  const messages = buildViewerChatMessages(snapshot(), "what are you doing?");
  assert.equal(messages[0]!.role, "system");
  const user = messages[1]!.content;
  for (const expected of ["Mining iron ore", "Prepare for a mining expedition", "ensure 1 iron_pickaxe", "Need an iron pickaxe first.", "picked up iron ore", "what are you doing?"]) {
    assert(user.includes(expected), `prompt missing ${expected}`);
  }
  assert(user.includes("hostilesInLoadedArea") && !user.includes("hostileCount"), "loaded-area mob count must not read as nearby");
  for (const secret of ["PRIVATE-CHAT-LINE", "10.0.0.5", "diamond"]) assert.equal(user.includes(secret), false, `prompt leaks ${secret}`);
});

test("questions are trimmed, flattened and length-checked", () => {
  assert.equal(cleanQuestion("  hi\n\tthere  "), "hi there");
  assert.equal(cleanQuestion(""), null);
  assert.equal(cleanQuestion("   "), null);
  assert.equal(cleanQuestion(42), null);
  assert.equal(cleanQuestion("x".repeat(MAX_QUESTION_CHARS + 1)), null);
});

test("answers drop think blocks and are capped", () => {
  assert.equal(cleanAnswer("<think>plan</think> I'm mining iron."), "I'm mining iron.");
  assert(cleanAnswer("a ".repeat(500)).length <= 600);
});

test("viewer chat answers through the LLM and returns its text", async () => {
  let seen: LlmMessage[] = [];
  const ask = createViewerChat({ complete: async (messages) => { seen = messages; return " I'm mining iron for a pickaxe. "; }, snapshot });
  assert.deepEqual(await ask("what are you doing?"), { ok: true, answer: "I'm mining iron for a pickaxe." });
  assert.equal(seen.length, 2);
});

test("viewer chat rejects bad questions without calling the LLM", async () => {
  let calls = 0;
  const ask = createViewerChat({ complete: async () => { calls++; return "x"; }, snapshot });
  assert.deepEqual(await ask(""), { ok: false, status: 400, error: `Ask a question of 1–${MAX_QUESTION_CHARS} characters.` });
  assert.equal(calls, 0);
});

test("one question at a time, with a cooldown between questions", async () => {
  let clock = 0;
  let release!: (value: string) => void;
  const ask = createViewerChat({ complete: () => new Promise<string>((resolve) => { release = resolve; }), snapshot, cooldownMs: 5000, now: () => clock });
  const first = ask("one");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await ask("two")).ok, false, "a second question while busy is refused");
  release("done");
  assert.deepEqual(await first, { ok: true, answer: "done" });
  const tooSoon = await ask("three");
  assert.equal(tooSoon.ok === false && tooSoon.status, 429);
  clock = 5000;
  const later = ask("four");
  await new Promise((resolve) => setImmediate(resolve));
  release("ok");
  assert.deepEqual(await later, { ok: true, answer: "ok" });
});

test("LLM failures become a 503, not a thrown error", async () => {
  const ask = createViewerChat({ complete: async () => { throw new Error("connection refused"); }, snapshot });
  assert.deepEqual(await ask("hello?"), { ok: false, status: 503, error: "CobbleBob's brain is unavailable right now." });
});
