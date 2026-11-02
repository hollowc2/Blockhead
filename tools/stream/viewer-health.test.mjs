import test from "node:test";
import assert from "node:assert/strict";
import { BroadcastViewerHealth } from "./viewer-health.mjs";

test("a broadcast recovers after viewer retries stall, even when screenshots keep arriving", () => {
  const health = new BroadcastViewerHealth();
  assert.equal(health.shouldRecover("connected", 0), false);
  assert.equal(health.shouldRecover("reconnecting", 1000), false);
  assert.equal(health.shouldRecover("connecting", 20_000), false);
  assert.equal(health.shouldRecover("loading-world", 60_000), false);
  assert.equal(health.shouldRecover("reconnecting", 120_999), false);
  assert.equal(health.shouldRecover("reconnecting", 121_000), true);
  assert.equal(health.shouldRecover("reconnecting", 121_001), false);
  assert.equal(health.shouldRecover("reconnecting", 241_000), true);
});

test("offline Minecraft is left alone and a healthy scene resets the stall timer", () => {
  const health = new BroadcastViewerHealth();
  assert.equal(health.shouldRecover("unavailable", 0), false);
  assert.equal(health.shouldRecover("connected", 100_000), false);
  assert.equal(health.shouldRecover("unavailable", 110_000), false);
  assert.equal(health.shouldRecover("unavailable", 229_999), false);
  assert.equal(health.shouldRecover("offline", 230_000), false);
  assert.equal(health.shouldRecover("offline", 1_000_000), false);
  assert.equal(health.shouldRecover("connecting", 1_000_001), false);
  assert.equal(health.shouldRecover("connected", 1_020_000), false);
});

test("missing or failed graphics states recover without a reload storm", () => {
  const health = new BroadcastViewerHealth({ stallMs: 10, cooldownMs: 100 });
  assert.equal(health.shouldRecover(null, 0), false);
  assert.equal(health.shouldRecover("webgl-failed", 10), true);
  assert.equal(health.shouldRecover("connected", 11), false);
  assert.equal(health.shouldRecover(null, 12), false);
  assert.equal(health.shouldRecover(null, 22), false);
  assert.equal(health.shouldRecover(null, 110), true);
});
