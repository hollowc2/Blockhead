import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import test from "node:test";
import type { LlamaClient } from "./client.js";
import { DecisionMaker } from "./decider.js";

const valid = JSON.stringify({ decision: { type: "respond", response: "Done" }, rationale: "  concise   answer " });
const ctx = {
  bot: { entity: null, players: {}, inventory: { items: () => [], emptySlotCount: () => 36 } },
  state: { self: { position: null, dimension: null, health: 20, food: 20 }, recentEvents: [], home: null, worldId: null },
  scheduler: { active: null, blockedActions: () => [] },
  config: {},
} as never;
const registry = { names: () => [], describe: () => "[]" } as never;
const debugLog = { write: () => undefined } as never;

function decider(complete: (messages: unknown[]) => Promise<string>, maxRetries = 1): DecisionMaker {
  return new DecisionMaker({ client: { complete } as unknown as LlamaClient, registry, debugLog, maxRetries });
}

test("activity is idle before a request and inactive after success", async () => {
  const maker = decider(async () => valid);
  deepStrictEqual(maker.activity, { thinking: false, callType: null, startedAt: null });
  await maker.decide({ from: "owner", instruction: "hello" }, ctx);
  equal(maker.activity.thinking, false);
  equal(maker.lastCall?.success, true);
});

test("activity is visible during a delayed owner instruction", async () => {
  let release!: () => void;
  const pending = new Promise<string>((resolve) => { release = () => resolve(valid); });
  const maker = decider(async () => pending);
  const request = maker.decide({ from: "owner", instruction: "hello" }, ctx);
  equal(maker.activity.thinking, true);
  equal(maker.activity.callType, "owner_instruction");
  release();
  await request;
});

test("activity remains active across schema repair retries", async () => {
  let calls = 0;
  const maker = decider(async () => {
    calls++;
    equal(maker.activity.thinking, true);
    return calls === 1 ? "not json" : valid;
  });
  await maker.decide({ from: "owner", instruction: "hello" }, ctx);
  equal(calls, 2);
  equal(maker.activity.thinking, false);
});

test("failed requests record final failure metadata and clean up", async () => {
  const maker = decider(async () => { throw new Error("connection refused; secret-token=hidden"); }, 0);
  await rejects(maker.decide({ from: "owner", instruction: "hello" }, ctx), /connection refused/);
  equal(maker.activity.thinking, false);
  equal(maker.lastCall?.success, false);
  equal(maker.lastCall?.error, "connection refused; secret-token=[redacted]");
  equal(maker.lastCall?.tool, "unknown");
});

test("last-call success data is concise and complete", async () => {
  const maker = decider(async () => valid);
  await maker.decide({ from: "owner", instruction: "hello" }, ctx);
  deepStrictEqual(maker.lastCall && { tool: maker.lastCall.tool, rationale: maker.lastCall.rationale, success: maker.lastCall.success, error: maker.lastCall.error }, { tool: "respond", rationale: "concise answer", success: true, error: null });
  equal(typeof maker.lastCall?.at, "number");
  equal(typeof maker.lastCall?.latencyMs, "number");
});

test("concurrent activity is preserved until the final request finishes", async () => {
  let firstRelease!: () => void;
  let secondRelease!: () => void;
  const first = new Promise<string>((resolve) => { firstRelease = () => resolve(valid); });
  const second = new Promise<string>((resolve) => { secondRelease = () => resolve(valid); });
  let calls = 0;
  const maker = decider(async () => ++calls === 1 ? first : second);
  const a = maker.decide({ from: "owner", instruction: "a" }, ctx);
  const b = maker.decide({ from: "owner", instruction: "b" }, ctx);
  equal(maker.activity.thinking, true);
  firstRelease();
  await a;
  equal(maker.activity.thinking, true);
  secondRelease();
  await b;
  equal(maker.activity.thinking, false);
});
