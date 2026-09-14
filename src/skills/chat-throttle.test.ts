import assert from "node:assert/strict";
import { test } from "node:test";
import { ChatThrottle, GLOBAL_CHAT_INTERVAL_MS } from "./skill-library.js";

/**
 * Phase 7.1 regression: a stuck restore loop announced the identical
 * "Stuck:" line into game chat once per attempt (~1s apart), which trips the
 * server's `disconnect.spam` kick. The throttle allows each distinct message
 * at most once per window and always passes a changed reason, so a stuck
 * reason goes quiet while progress is still heard. Log output is never
 * throttled — only the game-chat line is.
 */

test("identical messages pass once per window; a changed reason passes immediately", () => {
  let now = 1_000_000;
  const throttle = new ChatThrottle(30_000, () => now);

  // First failure attempt announces.
  assert.equal(throttle.allow("Stuck: no animals within 256 blocks."), true);

  // Nine identical follow-up attempts inside the window stay silent.
  for (let i = 0; i < 9; i++) {
    now += 1_000;
    assert.equal(throttle.allow("Stuck: no animals within 256 blocks."), false, `attempt ${i + 2} throttled`);
  }

  // A different reason (state changed) is heard immediately.
  assert.equal(throttle.allow("Stuck: health too low to hunt."), true);

  // ...but switching back to the stuck reason cannot bypass its window —
  // alternating A/B/A would otherwise re-announce every attempt.
  now += 1_000;
  assert.equal(throttle.allow("Stuck: no animals within 256 blocks."), false);
  assert.equal(throttle.allow("Stuck: health too low to hunt."), false, "B is still inside its own window too");

  // The stuck reason can be heard once more after the window expires.
  now += 30_000;
  assert.equal(throttle.allow("Stuck: no animals within 256 blocks."), true);
});

test("the process-wide chat budget caps ANY two messages within the window, whatever their content", () => {
  // The module-level budget is exactly a ChatThrottle keyed on one fixed
  // slot: per-message throttles already stop identical repeats, so this
  // instance models the layer that stops cross-skill bursts (a stuck food
  // hunt plus a torches expansion back-to-back) a spam filter reads as
  // flooding. Denied attempts do not consume the slot.
  let now = 0;
  const budget = new ChatThrottle(GLOBAL_CHAT_INTERVAL_MS, () => now);

  assert.equal(budget.allow("__chat_budget__"), true);
  now += GLOBAL_CHAT_INTERVAL_MS - 1_000;
  assert.equal(budget.allow("__chat_budget__"), false, "still inside the global window");
  now += 1_000;
  assert.equal(budget.allow("__chat_budget__"), true, "window expired: next announcement allowed");
});

test("a windowless throttle never drops a repeat (sanity: window > 0 enforced by config)", () => {
  let now = 0;
  const throttle = new ChatThrottle(1, () => now);
  assert.equal(throttle.allow("hi"), true);
  now += 1;
  assert.equal(throttle.allow("hi"), true);
});