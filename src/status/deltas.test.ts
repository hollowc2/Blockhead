import assert from "node:assert/strict";
import { test } from "node:test";
import { observedDelta, observedTransfer } from "./deltas.js";

test("observed deltas distinguish complete, partial, and zero-change outcomes", () => {
  assert.equal(observedDelta(2, 7, 5).status, "COMPLETE");
  assert.equal(observedDelta(2, 4, 5).status, "PARTIAL");
  assert.equal(observedDelta(2, 2, 5).status, "NO_OP");
  assert.equal(observedDelta(7, 7, 5).status, "ALREADY_SATISFIED");
});

test("transfer deltas credit only the intersection of source removal and target gain", () => {
  assert.deepEqual(observedTransfer(10, 6, 1, 5, 4), {
    before: 0, after: 4, delta: 4, requested: 4, status: "COMPLETE",
  });
  assert.equal(observedTransfer(10, 8, 1, 2, 4).status, "PARTIAL");
  assert.equal(observedTransfer(10, 10, 1, 1, 4).status, "NO_OP");
});
