import assert from "node:assert/strict";
import { test } from "node:test";
import { torchCraftBatches } from "./ensure-torches.js";

test("torch crafts split by fuel type: the recipe never mixes coal and charcoal", () => {
  // 21:27: 11 crafts with 8 coal + 3 charcoal failed as one batch.
  assert.deepEqual(torchCraftBatches(11, 8, 3, 12), [8, 3]);
  assert.deepEqual(torchCraftBatches(11, 20, 3, 12), [11]);
  assert.deepEqual(torchCraftBatches(11, 0, 14, 12), [11]);
  assert.deepEqual(torchCraftBatches(11, 8, 3, 5), [5], "sticks cap the total");
  assert.deepEqual(torchCraftBatches(4, 0, 0, 5), []);
});
