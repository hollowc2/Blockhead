import assert from "node:assert/strict";
import { test } from "node:test";
import { ConnectionStateMachine } from "./connection-state.js";

test("connection lifecycle is explicit and stable health resets backoff", () => {
  const state = new ConnectionStateMachine({ baseMs: 100, maxMs: 500, jitter: 0, random: () => 0.5 });
  state.transition("CONNECTING");
  state.transition("SPAWNED");
  state.transition("READY");
  assert.equal(state.failureDelayMs(), 100);
  assert.equal(state.failureDelayMs(), 200);
  state.markStable();
  assert.equal(state.failureDelayMs(), 100);
  state.transition("INTERRUPTING");
  state.transition("REINITIALIZING");
  state.transition("DISCONNECTED");
});

test("invalid connection transitions are rejected", () => {
  const state = new ConnectionStateMachine();
  assert.throws(() => state.transition("READY"), /invalid connection transition/);
});
