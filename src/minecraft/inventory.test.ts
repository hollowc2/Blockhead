import { test } from "node:test";
import assert from "node:assert/strict";
import { droppableItemsSummary } from "./inventory.js";

test("the death record counts worn armor and the off-hand shield", () => {
  const slots: Array<{ name: string; count: number } | null> = Array(46).fill(null);
  slots[5] = { name: "iron_helmet", count: 1 };
  slots[45] = { name: "shield", count: 1 };
  slots[36] = { name: "bread", count: 4 };
  const bot = { inventory: { slots, items: () => [slots[36]!] } };
  assert.deepEqual(droppableItemsSummary(bot as never), { bread: 4, iron_helmet: 1, shield: 1 });
});
