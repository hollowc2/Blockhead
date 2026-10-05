import assert from "node:assert/strict";
import { test } from "node:test";
import { leatherArmorPlan } from "./armor.js";

test("leather goes to the best protection first, skipping covered slots", () => {
  // 9 leather (carried before deaths 62-72): a chestplate, not helmet+boots.
  assert.deepEqual(leatherArmorPlan(9, new Set()), ["leather_chestplate"]);
  assert.deepEqual(leatherArmorPlan(24, new Set()), ["leather_chestplate", "leather_leggings", "leather_helmet", "leather_boots"]);
  assert.deepEqual(leatherArmorPlan(9, new Set([6])), ["leather_leggings"], "chest already worn");
  assert.deepEqual(leatherArmorPlan(4, new Set()), ["leather_boots"]);
  assert.deepEqual(leatherArmorPlan(3, new Set()), []);
});
