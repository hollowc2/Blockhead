import test from "node:test";
import assert from "node:assert/strict";
import { assessAutonomy, assessBot, BotHealthMonitor, fetchSnapshot } from "./bot-health.mjs";

const PRIVATE = "CANARY-private-9f3e";
const snapshot = (mc = {}, extra = {}) => ({
  schema: 1,
  minecraft: { connected: true, player: PRIVATE, health: 20, hunger: 20, position: { x: 1234.5, y: 64, z: -987.5 }, dimension: "overworld", timePhase: "day", serverObservationAgeMs: 800, ...mc },
  task: { active: { objective: PRIVATE } }, goal: { text: PRIVATE },
  llm: { endpoint: `http://${PRIVATE}:8080`, state: "ok", lastFailure: { error: PRIVATE } },
  autonomy: { paused: false, reasons: [] }, consecutiveTaskFailures: 0, ...extra,
});

test("a connected, alive bot with fresh server observations is healthy", () => {
  assert.deepEqual(assessBot(snapshot()), { ok: true });
});

test("connection, life and freshness are distinct failures", () => {
  assert.equal(assessBot(snapshot({ connected: false })).reason, "bot-disconnected");
  assert.equal(assessBot(snapshot({ health: 0 })).reason, "bot-dead");
  assert.equal(assessBot(snapshot({ serverObservationAgeMs: null })).reason, "bot-stale", "after respawn until the server speaks");
  assert.equal(assessBot(snapshot({ serverObservationAgeMs: 31_000 })).reason, "bot-stale");
  assert.equal(assessBot({ schema: 2 }).reason, "bot-unknown");
  assert.equal(assessBot(null).reason, "bot-unknown");
});

test("a quiet but live connection is not stale: the budget is 30 s of server time updates", () => {
  assert.equal(assessBot(snapshot({ serverObservationAgeMs: 12_000 })).ok, true);
});

test("idle, paused, owner work, model outage and the death-loop brake never fail bot health", () => {
  for (const extra of [
    { autonomy: { paused: true, reasons: ["interrupt:pause"] } },
    { autonomy: { paused: true, reasons: ["user-task-active"] } },
    { autonomy: { paused: true, reasons: ["death-loop-brake"] } },
    { llm: { state: "failing" } },
    { consecutiveTaskFailures: 12 },
    { task: { active: null } },
  ]) assert.equal(assessBot(snapshot({}, extra)).ok, true, JSON.stringify(extra));
  assert.equal(assessAutonomy(snapshot({}, { autonomy: { paused: true, reasons: ["death-loop-brake"] } })), "death-loop-brake");
  assert.equal(assessAutonomy(snapshot({}, { llm: { state: "failing" } })), "model-degraded");
  assert.equal(assessAutonomy(snapshot({}, { autonomy: { paused: true, reasons: ["interrupt:pause"] } })), "paused");
  assert.equal(assessAutonomy(snapshot()), "ok");
});

test("no private field survives the projection", () => {
  const m = new BotHealthMonitor();
  m.observe(0, snapshot());
  const projected = JSON.stringify({ health: m.health(0), autonomy: m.autonomy, last: m.last });
  assert.ok(!projected.includes(PRIVATE), projected);
  assert.ok(!projected.includes("1234"), projected);
});

test("slow replies from a busy bot do not count as loss until the reachability budget", () => {
  const m = new BotHealthMonitor();
  assert.equal(m.health(0).reason, "bot-unknown");
  m.observe(1_000, snapshot());
  m.observe(3_000, null); m.observe(5_000, null); m.observe(9_000, null);
  assert.equal(m.health(10_999).ok, true);
  assert.equal(m.health(11_001).reason, "bot-unreachable");
  m.observe(12_000, snapshot());
  assert.equal(m.health(12_000).ok, true);
});

test("fetchSnapshot returns null on error, non-200 and malformed bodies", async () => {
  const fake = (status, body) => async () => ({ ok: status === 200, text: async () => body });
  assert.equal(await fetchSnapshot("x", { fetchFn: fake(500, "{}") }), null);
  assert.equal(await fetchSnapshot("x", { fetchFn: fake(200, "not json") }), null);
  assert.equal(await fetchSnapshot("x", { fetchFn: async () => { throw new Error("ECONNREFUSED"); } }), null);
  assert.deepEqual(await fetchSnapshot("x", { fetchFn: fake(200, '{"schema":1}') }), { schema: 1 });
});
