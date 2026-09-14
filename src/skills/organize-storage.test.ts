import assert from "node:assert/strict";
import { test } from "node:test";
import type { StorageLocation } from "../memory/storage.js";
import type { ChestMeasurement, StorageMeasurement } from "../minecraft/containers.js";
import {
  CATEGORY_CHEST_MIN_ITEMS,
  CHEST_FULL_RATIO,
  decideStorageWork,
  normalizeCategory,
  STORAGE_FULL_RATIO,
  storageCategoryFor,
} from "./organize-storage.js";

/**
 * Phase 11 acceptance: storage expands without user micromanagement when
 * chests are full or better organization is required. These tests pin the
 * deterministic policy: the item -> category mapping, the expansion decision,
 * and the category registry coercion. The Minecraft mechanics (measurement,
 * transfer) are exercised live and only through these pure rules.
 */

/** A registered storage location fixture. */
function location(category: string, suffix: number): StorageLocation {
  return {
    id: suffix,
    worldId: 1,
    dimension: "overworld",
    category,
    label: null,
    x: suffix * 10,
    y: 64,
    z: 0,
    protected: 1,
    lastSeenAt: null,
  };
}

/** A measured chest fixture; items are "name -> count". */
function chest(
  category: string,
  usedSlots: number,
  capacitySlots: number,
  items: Record<string, number>,
  suffix = 1,
): ChestMeasurement {
  return { location: location(category, suffix), capacitySlots, usedSlots, items };
}

/** Empty measurement with the given reachable/missing state. */
function empty(chests: ChestMeasurement[], missingChests = 0): StorageMeasurement {
  let slotsUsed = 0;
  let slotsTotal = 0;
  const items: Record<string, number> = {};
  for (const chest of chests) {
    slotsUsed += chest.usedSlots;
    slotsTotal += chest.capacitySlots;
    for (const [name, count] of Object.entries(chest.items)) items[name] = (items[name] ?? 0) + count;
  }
  return { chests, slotsUsed, slotsTotal, items, missingChests, reachable: chests.length > 0 };
}

test("storageCategoryFor maps every initial category deterministically", () => {
  // wood
  assert.equal(storageCategoryFor("oak_log"), "wood");
  assert.equal(storageCategoryFor("spruce_planks"), "wood");
  assert.equal(storageCategoryFor("stick"), "wood");
  assert.equal(storageCategoryFor("minecraft:oak_log"), "wood"); // namespace stripped
  // stone
  assert.equal(storageCategoryFor("cobblestone"), "stone");
  assert.equal(storageCategoryFor("granite"), "stone");
  // ores
  assert.equal(storageCategoryFor("coal"), "ores");
  assert.equal(storageCategoryFor("charcoal"), "ores");
  assert.equal(storageCategoryFor("iron_ingot"), "ores");
  assert.equal(storageCategoryFor("raw_iron"), "ores");
  assert.equal(storageCategoryFor("iron_ore"), "ores");
  // valuables win over their ores/equipment lookalikes
  assert.equal(storageCategoryFor("diamond"), "valuables");
  assert.equal(storageCategoryFor("emerald"), "valuables");
  assert.equal(storageCategoryFor("netherite_ingot"), "valuables");
  assert.equal(storageCategoryFor("diamond_sword"), "valuables");
  // equipment
  assert.equal(storageCategoryFor("iron_pickaxe"), "equipment");
  assert.equal(storageCategoryFor("bow"), "equipment");
  assert.equal(storageCategoryFor("leather_chestplate"), "equipment");
  // mob drops
  assert.equal(storageCategoryFor("leather"), "mob_drops");
  assert.equal(storageCategoryFor("feather"), "mob_drops");
  // food
  assert.equal(storageCategoryFor("beef"), "food");
  assert.equal(storageCategoryFor("cooked_beef"), "food");
  // everything else lands in misc (general is the fallback bucket, never assigned)
  assert.equal(storageCategoryFor("torch"), "misc");
  assert.equal(storageCategoryFor("flint"), "misc");
});

test("normalizeCategory falls back to general for unknown strings", () => {
  assert.equal(normalizeCategory("ores"), "ores");
  assert.equal(normalizeCategory("general"), "general");
  assert.equal(normalizeCategory("hand_edited_garbage"), "general");
});

test("no registered storage at all -> create a general chest (spec 22)", () => {
  const decision = decideStorageWork(empty([]), []);
  assert.equal(decision.expand, true);
  assert.equal(decision.createCategory, "general");
});

test("every registered chest is gone -> create a general chest", () => {
  const registered = [location("general", 1)];
  const measurement = empty([], /* missingChests */ 1);
  const decision = decideStorageWork(measurement, registered);
  assert.equal(decision.expand, true);
  assert.equal(decision.createCategory, "general");
});

test("registered chests exist but are busy -> no work, re-check later", () => {
  const registered = [location("general", 1)];
  const measurement = empty([], /* missingChests */ 0);
  assert.equal(decideStorageWork(measurement, registered).expand, false);
});

test("one chest busy and one gone -> create a fresh general chest", () => {
  const registered = [location("general", 1), location("misc", 2)];
  // Neither could be opened (reachable = false), but one registered position
  // is confirmed missing: capacity is genuinely gone, so expand.
  const measurement = empty([], /* missingChests */ 1);
  const decision = decideStorageWork(measurement, registered);
  assert.equal(decision.expand, true);
  assert.equal(decision.createCategory, "general");
});

test("a full chest -> create another chest of that category", () => {
  const full = Math.ceil(27 * CHEST_FULL_RATIO);
  const registered = [location("general", 1)];
  const measurement = empty([chest("general", full, 27, { oak_log: 10 })]);
  const decision = decideStorageWork(measurement, registered);
  assert.equal(decision.expand, true);
  assert.equal(decision.createCategory, "general");
});

test("a full ores chest -> create another ores chest", () => {
  const full = Math.ceil(27 * CHEST_FULL_RATIO);
  const registered = [location("ores", 1)];
  const measurement = empty([chest("ores", full, 27, { iron_ingot: 20 })]);
  const decision = decideStorageWork(measurement, registered);
  assert.equal(decision.expand, true);
  assert.equal(decision.createCategory, "ores");
});

test("a category without a chest holding enough items -> create its first chest", () => {
  const generalChest = chest("general", 12, 27, { iron_ingot: CATEGORY_CHEST_MIN_ITEMS });
  const registered = [location("general", 1)];
  const decision = decideStorageWork(empty([generalChest]), registered);
  assert.equal(decision.expand, true);
  assert.equal(decision.createCategory, "ores");
});

test("a category below the item threshold stays without a chest", () => {
  const generalChest = chest("general", 2, 27, { iron_ingot: CATEGORY_CHEST_MIN_ITEMS - 1 });
  const registered = [location("general", 1)];
  const decision = decideStorageWork(empty([generalChest]), registered);
  assert.equal(decision.expand, false);
});

test("overall utilization at the full ratio -> create a general chest", () => {
  const registered = [location("general", 1), location("misc", 2)];
  // 11 of 27 in each chest: well below the overall ratio.
  const healthy = empty([chest("general", 11, 27, { torch: 11 }), chest("misc", 11, 27, { flint: 11 })]);
  assert.equal(decideStorageWork(healthy, registered).expand, false);
  // 44 of 54 slots (>= 0.8) triggers general expansion when no specific
  // chest is full and every category already has its chest.
  const tight = empty([chest("general", 22, 27, { torch: 22 }), chest("misc", 22, 27, { flint: 22 })]);
  const decision = decideStorageWork(tight, registered);
  assert.equal(decision.expand, true);
  assert.equal(decision.createCategory, "general");
  assert.equal(decision.reason, "storage is nearly full");
});

test("organization need beats generic expansion: full chest wins over overall ratio", () => {
  // General 22/27 (overall >= 0.8 -> general) but an ores chest is full:
  // the specific full chest is expanded first.
  const registered = [location("general", 1), location("ores", 2)];
  const measurement = empty([
    chest("general", 22, 27, { torch: 22 }),
    chest("ores", Math.ceil(27 * CHEST_FULL_RATIO), 27, { iron_ingot: 30 }),
  ]);
  const decision = decideStorageWork(measurement, registered);
  assert.equal(decision.expand, true);
  assert.equal(decision.createCategory, "ores");
});

test("STOCKPILE_RATIOS are sane: full threshold sits above the general threshold", () => {
  assert.ok(CHEST_FULL_RATIO > STORAGE_FULL_RATIO);
  assert.ok(CHEST_FULL_RATIO <= 1);
});