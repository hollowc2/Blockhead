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

test("one chest busy and one gone -> defer expansion until capacity is known", () => {
  const registered = [location("general", 1), location("misc", 2)];
  // The surviving busy chest may have spare capacity.
  const measurement = empty([], /* missingChests */ 1);
  const decision = decideStorageWork(measurement, registered);
  assert.equal(decision.expand, false);
  assert.equal(decision.createCategory, null);
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

test("category items with ample general capacity do not justify building", () => {
  const generalChest = chest("general", 12, 27, { iron_ingot: CATEGORY_CHEST_MIN_ITEMS });
  const registered = [location("general", 1)];
  const decision = decideStorageWork(empty([generalChest]), registered);
  assert.equal(decision.expand, false);
  assert.equal(decision.createCategory, null);
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

test("missing category takes priority when overall capacity is tight", () => {
  // General 22/27 (overall >= 0.8 -> general) but an ores chest is full:
  // the specific full chest is expanded first.
  const registered = [location("general", 1), location("ores", 2)];
  const measurement = empty([
    chest("general", 22, 27, { torch: 22 }),
    chest("ores", Math.ceil(27 * CHEST_FULL_RATIO), 27, { iron_ingot: 30 }),
  ]);
  const decision = decideStorageWork(measurement, registered);
  assert.equal(decision.expand, true);
  assert.equal(decision.createCategory, "misc");
});

test("STOCKPILE_RATIOS are sane: full threshold sits above the general threshold", () => {
  assert.ok(CHEST_FULL_RATIO > STORAGE_FULL_RATIO);
  assert.ok(CHEST_FULL_RATIO <= 1);
});
test("logs for a new chest come out of the home chest before any chopping", async () => {
  // 2026-10-05 10:44: 36 logs in the home chest, yet the chest craft went
  // chopping and the collectblock planner timed out after 240 s.
  const { OrganizeStorageRunner } = await import("./organize-storage.js");
  const { withWorldActionLease } = await import("../agent/world-actions.js");
  const { Vec3 } = await import("vec3");
  const chestAt = { x: 64, y: 96, z: 52 };
  const carried: { name: string; count: number; type: number }[] = [];
  let scans = 0;
  const bot = {
    entity: { position: new Vec3(64.5, 97, 51.5) },
    registry: { itemsByName: { oak_log: { id: 1 } } },
    inventory: { items: () => carried, emptySlotCount: () => 30 },
    blockAt: (p: { x: number; y: number; z: number }) =>
      p.x === chestAt.x && p.y === chestAt.y && p.z === chestAt.z ? { name: "chest", position: new Vec3(p.x, p.y, p.z), boundingBox: "block" } : { name: "air", boundingBox: "empty", position: new Vec3(p.x, p.y, p.z) },
    findBlocks: () => { scans += 1; return []; },
    openContainer: async () => ({
      containerItems: () => [{ name: "oak_log", count: 36, type: 1 }],
      slots: [],
      inventoryStart: 27,
      withdraw: async (_id: number, _meta: null, count: number) => { carried.push({ name: "oak_log", count, type: 1 }); },
      close: async () => {},
    }),
  };
  const storage = { list: () => [{ id: 1, ...chestAt, category: "general" }], listByCategory: () => [{ id: 1, ...chestAt, category: "general" }] };
  const runner = new OrganizeStorageRunner({ bot, state: { worldId: 1, home: { x: 65, y: 96, z: 51, dimension: "overworld" } }, storage, config: {}, logger: { info() {}, warn() {}, debug() {} }, bus: { emit() {} } } as unknown as ConstructorParameters<typeof OrganizeStorageRunner>[0]);
  const result = await withWorldActionLease({ owner: "storage-test", signal: new AbortController().signal, acknowledged: Promise.resolve() }, () =>
    (runner as unknown as { gatherLogs: (n: number) => Promise<{ ok: boolean }> }).gatherLogs(2));
  assert.equal(result.ok, true);
  assert.equal(scans, 0, "no tree search");
});


test("a full chest with ten empty home chests never triggers construction", () => {
  const chests = [chest("general", 27, 27, { oak_log: 64 }),
    ...Array.from({ length: 10 }, (_, i) => chest("general", 0, 27, {}, i + 2))];
  const decision = decideStorageWork(empty(chests), chests.map((c) => c.location));
  assert.equal(decision.expand, false);
  assert.equal(decision.reuseChestId, 2);
  assert.equal(decision.createCategory, "wood");
});

test("a newly added empty category chest stops repeat expansion of the old full one", () => {
  const chests = [chest("ores", 27, 27, { iron_ingot: 64 }), chest("ores", 0, 27, {}, 2)];
  assert.equal(decideStorageWork(empty(chests), chests.map((c) => c.location)).expand, false);
});

test("unread chests prevent expansion based on a partially measured full chest", () => {
  const full = chest("general", 27, 27, { torch: 64 });
  assert.equal(decideStorageWork(empty([full]), [full.location, location("general", 2)]).expand, false);
});

test("a full category chest uses existing general overflow capacity", () => {
  const chests = [chest("ores", 27, 27, { iron_ingot: 64 }), chest("general", 1, 27, { torch: 1 }, 2)];
  const decision = decideStorageWork(empty(chests), chests.map((c) => c.location));
  assert.equal(decision.expand, false);
  assert.match(decision.reason!, /redistribute/);
});

test("background storage checks discover nearby chests before deciding to build", async () => {
  const { OrganizeStorageRunner } = await import("./organize-storage.js");
  const { withWorldActionLease } = await import("../agent/world-actions.js");
  const { Vec3 } = await import("vec3");
  const registered: StorageLocation[] = [];
  const at = new Vec3(1, 64, 0);
  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    findBlocks: () => [at],
    blockAt: (p: { y: number }) => p.y === 64 ? { name: "chest", position: at } : { name: "air", boundingBox: "empty" },
    openContainer: async () => ({ inventoryStart: 27, slots: [], close() {} }),
  };
  const storage = {
    list: () => registered,
    register: (_world: number, input: object) => registered.push({ ...location("general", 1), ...input }),
  };
  const runner = new OrganizeStorageRunner({ bot, state: { worldId: 1, home: { x: 0, y: 64, z: 0, dimension: "overworld" } },
    storage, config: {}, bus: { emit() {} }, logger: { info() {}, warn() {} } } as unknown as ConstructorParameters<typeof OrganizeStorageRunner>[0]);
  const result = await withWorldActionLease({ owner: "storage-discovery-test", signal: new AbortController().signal, acknowledged: Promise.resolve() }, () => runner.needsAttention());
  assert.equal(registered.length, 1);
  assert.equal(result.needsWork, false);
});
