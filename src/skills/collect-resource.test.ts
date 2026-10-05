import assert from "node:assert/strict";
import { test } from "node:test";
import { carriedItemName, sourceBlockName, woodenToolLogTarget } from "./collect-resource.js";

test("cobblestone is mined from stone and still accounted as cobblestone", () => {
  // Searching for cobblestone blocks found only the home's own (PROTECTED_REGION).
  assert.equal(sourceBlockName("cobblestone"), "stone");
  assert.equal(sourceBlockName("minecraft:cobbled_deepslate"), "deepslate");
  assert.equal(carriedItemName(sourceBlockName("cobblestone")), "cobblestone");
  assert.equal(carriedItemName(sourceBlockName("cobbled_deepslate")), "cobbled_deepslate");
});

test("other resources are mined as themselves", () => {
  assert.equal(sourceBlockName("acacia_log"), "acacia_log");
  assert.equal(sourceBlockName("iron_ore"), "iron_ore");
  assert.equal(sourceBlockName("blackstone"), "blackstone");
});

test("a wooden tool's log target is a total, so one carried log still gathers a second", () => {
  // Live 19:11:05: 1 log, no planks or sticks -> 5 planks needed -> 2 logs.
  // Passing the shortfall (1) as the total gathered nothing.
  assert.equal(woodenToolLogTarget(1, 0, true), 2);
  assert.equal(woodenToolLogTarget(0, 0, true), 2);
  assert.equal(woodenToolLogTarget(0, 0, false), 1);
  assert.equal(woodenToolLogTarget(0, 4, true), 1);
  assert.equal(woodenToolLogTarget(3, 0, true), 3);
  assert.equal(woodenToolLogTarget(0, 5, true), 0);
});
