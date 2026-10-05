import assert from "node:assert/strict";
import { test } from "node:test";
import { fieldPickaxePlan } from "./field-craft.js";

test("the 2026-10-04 coal-run haul makes a stone pickaxe on the spot", () => {
  // Pickaxe broke 60 blocks down carrying 86 cobblestone, 5 sticks, 4 planks.
  assert.deepEqual(fieldPickaxePlan({ stone: 86, planks: 4, logs: 0, sticks: 5, table: false }), { tool: "stone_pickaxe", planks: 4 });
});

test("field pickaxe plans count the table, the sticks and a wooden head in planks", () => {
  assert.deepEqual(fieldPickaxePlan({ stone: 3, planks: 0, logs: 0, sticks: 2, table: true }), { tool: "stone_pickaxe", planks: 0 });
  assert.deepEqual(fieldPickaxePlan({ stone: 3, planks: 0, logs: 2, sticks: 0, table: false }), { tool: "stone_pickaxe", planks: 6 });
  assert.equal(fieldPickaxePlan({ stone: 3, planks: 5, logs: 0, sticks: 0, table: false }), null, "6 planks needed, 5 held");
  assert.deepEqual(fieldPickaxePlan({ stone: 0, planks: 0, logs: 3, sticks: 0, table: false }), { tool: "wooden_pickaxe", planks: 9 });
});
