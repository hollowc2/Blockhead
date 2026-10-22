import assert from "node:assert/strict";
import { test } from "node:test";
import { ironKitPlan, leatherArmorPlan, missingIronKit } from "./armor.js";

test("leather goes to the best protection first, skipping covered slots", () => {
  // 9 leather (carried before deaths 62-72): a chestplate, not helmet+boots.
  assert.deepEqual(leatherArmorPlan(9, new Set()), ["leather_chestplate"]);
  assert.deepEqual(leatherArmorPlan(24, new Set()), ["leather_chestplate", "leather_leggings", "leather_helmet", "leather_boots"]);
  assert.deepEqual(leatherArmorPlan(9, new Set([6])), ["leather_leggings"], "chest already worn");
  assert.deepEqual(leatherArmorPlan(4, new Set()), ["leather_boots"]);
  assert.deepEqual(leatherArmorPlan(3, new Set()), []);
});

test("the iron kit skips worn or carried pieces and pays for the shield first", () => {
  const none = new Map<number, string>();
  assert.deepEqual(missingIronKit([], none).map((p) => p.item), ["shield", "iron_chestplate", "iron_helmet", "iron_boots"]);
  const worn = new Map([[45, "shield"], [5, "diamond_helmet"], [6, "leather_chestplate"]]);
  assert.deepEqual(missingIronKit(["iron_boots"], worn).map((p) => p.item), ["iron_chestplate"], "leather does not cover iron");
  const missing = missingIronKit([], none);
  assert.deepEqual(ironKitPlan(6, missing), ["shield", "iron_helmet"]);
  assert.deepEqual(ironKitPlan(18, missing), ["shield", "iron_chestplate", "iron_helmet", "iron_boots"]);
  assert.deepEqual(ironKitPlan(0, missing), []);
});
