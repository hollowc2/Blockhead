import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bot } from "mineflayer";
import type { StockpileSnapshot } from "../agent/maintenance.js";
import { TaskStatus, type Task } from "../agent/task.js";
import type { ToolContext } from "../tools/types.js";
import { buildStateSnapshot, type DecisionInput } from "./context.js";

/**
 * Formatting tests for the compact LLM context digest. The snapshot is the
 * model's only view of the world, so these tests pin that it stays a compact
 * aggregate — grouped resources, equipped items with durability, home
 * awareness, and deduplicated recent outcomes — and that raw data (full
 * inventories, `attemptedSites` arrays) never leaks in.
 */

/** Prismarine-item shape as the stubs model it (name + count + optional durability). */
interface FakeItem {
  name: string;
  count: number;
  maxDurability?: number;
  durabilityUsed: number;
}

function item(name: string, count = 1, maxDurability?: number, durabilityUsed?: number): FakeItem {
  return { name, count, maxDurability, durabilityUsed: durabilityUsed ?? 0 };
}

function task(overrides: Partial<Task> & { type: string }): Task {
  const base: Task = {
    id: `task-${overrides.type}`,
    type: overrides.type,
    priority: 40,
    source: "background",
    objective: overrides.objective ?? overrides.type,
    parameters: {},
    status: overrides.status ?? TaskStatus.COMPLETED,
    createdAt: "2026-09-14T00:00:00.000Z",
    completedAt: "2026-09-14T01:00:00.000Z",
  };
  return { ...base, ...overrides };
}

/** A stub scheduler/state/repo/maint bundle cast to the real context types. */
function harness(options: {
  items?: FakeItem[];
  equipment?: Array<FakeItem | null>;
  emptySlots?: number;
  position?: { x: number; y: number; z: number };
  dimension?: string | null;
  home?: { x: number; y: number; z: number; dimension: string } | null;
  storage?: { chests: number; categories: string[] };
  stockpile?: StockpileSnapshot;
  recentTasks?: Task[];
  blocked?: { action: string; reason: string; retryInSeconds: number }[];
}): { ctx: ToolContext; input: DecisionInput } {
  const bot = {
    username: "CobbleBob",
    players: {},
    entity:
      options.equipment === undefined && options.position === undefined
        ? undefined
        : {
            position: options.position ?? null,
            equipment: options.equipment ?? [],
          },
    inventory: {
      items: () => options.items ?? [],
      emptySlotCount: () => options.emptySlots ?? 0,
    },
  } as unknown as Bot;
  const ctx = {
    bot,
    state: {
      self: {
        position: options.position ?? null,
        dimension: options.dimension ?? "overworld",
        health: 20,
        food: 20,
      },
      home: options.home,
      worldId: 1,
      recentEvents: [],
    },
    scheduler: {
      active: null,
      blockedActions: () => options.blocked ?? [],
    },
    maintenance:
      options.stockpile === undefined
        ? undefined
        : { snapshot: options.stockpile },
    storage:
      options.storage === undefined
        ? undefined
        : { list: () => options.storage!.categories.map((category) => ({ category })) },
    tasks:
      options.recentTasks === undefined
        ? undefined
        : { recentSettled: () => options.recentTasks },
  } as unknown as ToolContext;
  return { ctx, input: { from: "Corey", instruction: "get me 32 oak logs" } };
}

test("inventory summary aggregates resources into compact decision groups", () => {
  const { ctx, input } = harness({
    items: [
      item("oak_log", 5),
      item("minecraft:spruce_log", 2),
      item("oak_planks", 3),
      item("stick", 6),
      item("torch", 19),
      item("coal", 4),
      item("charcoal", 2),
      item("beef", 2),
      item("bread", 3),
      item("raw_iron", 3),
      item("iron_ingot", 2),
      item("cobblestone", 12),
      item("stone", 4),
      item("diamond", 1),
      item("sword", 1), // typo'd trash: must not appear anywhere
    ],
    emptySlots: 14,
  });
  const snapshot = buildStateSnapshot(ctx, input);
  assert.equal(snapshot.inventory.food, 5, "beef + bread, no double count");
  assert.equal(snapshot.inventory.torches, 19);
  assert.deepEqual(snapshot.inventory.wood, { logs: 7, planks: 3, sticks: 6 });
  assert.equal(snapshot.inventory.fuel, 6, "coal + charcoal combined");
  assert.equal(snapshot.inventory.iron, 5, "raw iron + ingots combined");
  assert.deepEqual(snapshot.inventory.materials, { cobblestone: 12, stone: 4, diamond: 1 });
  assert.equal(snapshot.inventory.freeSlots, 14);
  assert.equal(Object.keys(snapshot.inventory.materials).length, 3, "only nonzero materials");
});

test("inventory summary normalizes minecraft: prefixed names", () => {
  const { ctx, input } = harness({
    items: [item("minecraft:oak_log", 4), item("minecraft:torch", 7), item("minecraft:coal", 1)],
  });
  const snapshot = buildStateSnapshot(ctx, input);
  assert.equal(snapshot.inventory.wood.logs, 4);
  assert.equal(snapshot.inventory.torches, 7);
  assert.equal(snapshot.inventory.fuel, 1);
});

test("equipment summary maps the modern 6-slot equipment array with durability", () => {
  const { ctx, input } = harness({
    equipment: [
      item("iron_pickaxe", 1, 60, 23),
      item("torch", 1),
      item("leather_helmet", 1, 20, 3),
      null,
      item("iron_leggings", 1, 75, 40),
      null,
    ],
  });
  const snapshot = buildStateSnapshot(ctx, input);
  assert.deepEqual(snapshot.equipment.held, {
    name: "iron_pickaxe",
    durability: { used: 23, max: 60 },
  });
  assert.deepEqual(snapshot.equipment.offhand, { name: "torch" }, "no durability on torches");
  assert.deepEqual(snapshot.equipment.armor, [
    { name: "leather_helmet", durability: { used: 3, max: 20 } },
    { name: "iron_leggings", durability: { used: 40, max: 75 } },
  ]);
});

test("equipment summary handles the pre-offhand 5-slot layout", () => {
  const { ctx, input } = harness({
    equipment: [
      item("stone_sword", 1, 32, 10),
      item("leather_helmet", 1, 20, 0),
      item("leather_chestplate", 1, 40, 0),
      item("leather_leggings", 1, 40, 0),
      item("leather_boots", 1, 40, 0),
    ],
  });
  const snapshot = buildStateSnapshot(ctx, input);
  assert.equal(snapshot.equipment.offhand, null, "no offhand slot in the old layout");
  assert.equal(snapshot.equipment.armor.length, 4);
  assert.equal(snapshot.equipment.armor[0]!.name, "leather_helmet");
});

test("equipment summary is empty before the entity is known", () => {
  const { ctx, input } = harness({});
  const snapshot = buildStateSnapshot(ctx, input);
  assert.deepEqual(snapshot.equipment, { held: null, offhand: null, armor: [] });
});

test("home summary reports distance only within the home dimension", () => {
  const home = { x: 0, y: 0, z: 0, dimension: "overworld" };
  const { ctx, input } = harness({ position: { x: 30, y: 0, z: 40 }, home });
  assert.equal(buildStateSnapshot(ctx, input).home.distance, 50, "3-4-5 triangle");

  const wrongDim = harness({ position: { x: 30, y: 0, z: 40 }, dimension: "the_nether", home });
  assert.equal(buildStateSnapshot(wrongDim.ctx, wrongDim.input).home.distance, null);

  const noPos = harness({ position: undefined, home });
  assert.equal(buildStateSnapshot(noPos.ctx, noPos.input).home.distance, null);
  assert.equal(buildStateSnapshot(noPos.ctx, noPos.input).home.known, true);

  const unknown = harness({ position: { x: 0, y: 0, z: 0 }, home: null });
  assert.equal(buildStateSnapshot(unknown.ctx, unknown.input).home.known, false);
});

test("home summary includes registered storage and last measured stockpile", () => {
  const { ctx, input } = harness({
    position: { x: 0, y: 0, z: 0 },
    home: { x: 0, y: 0, z: 0, dimension: "overworld" },
    storage: { chests: 3, categories: ["general", "food", "wood"] },
    stockpile: {
      levels: { wood: 64, food: 16, fuel: 64, torches: 64 },
      targets: { wood: 64, food: 64, fuel: 64, torches: 64 },
      deficits: [{ kind: "food", target: 64, current: 16, deficit: 48 }],
    },
  });
  const snapshot = buildStateSnapshot(ctx, input);
  assert.deepEqual(snapshot.home.storage, { chests: 3, categories: ["food", "general", "wood"] });
  assert.deepEqual(snapshot.home.stockpile, {
    levels: { wood: 64, food: 16, fuel: 64, torches: 64 },
    targets: { wood: 64, food: 64, fuel: 64, torches: 64 },
    deficits: [{ kind: "food", target: 64, current: 16, deficit: 48 }],
  });
});

test("recent tasks dedupe identical outcomes and compact scalar progress", () => {
  const { ctx, input } = harness({
    recentTasks: [
      task({ type: "stockpile_maintenance", status: TaskStatus.FAILED, lastError: "could not return home: timed_out", resumeState: { quantity: 16, interruptions: 1 } }),
      task({ type: "stockpile_maintenance", status: TaskStatus.FAILED, lastError: "could not return home: timed_out", resumeState: { quantity: 12, interruptions: 1 } }),
      task({ type: "collect_resource", status: TaskStatus.COMPLETED, resumeState: { resource: "oak_log", quantity: 64, attemptedSites: ["-61,91,5", "-61,93,0", "-62,90,3"], interruptions: 1 } }),
      task({ type: "build_base", status: TaskStatus.BLOCKED, lastError: "3 failed attempts: walls missing", resumeState: {} }),
      task({ type: "go_home", status: TaskStatus.CANCELLED }),
    ],
  });
  const snapshot = buildStateSnapshot(ctx, input);
  assert.equal(snapshot.recentTasks.length, 4, "the duplicate failed restore collapses");
  const [first, ...rest] = snapshot.recentTasks;
  assert.equal(first!.status, "failed");
  assert.equal(first!.reason, "could not return home: timed_out");
  assert.deepEqual(first!.progress, { quantity: 16, interruptions: 1 });
  const collect = rest.find((outcome) => outcome.type === "collect_resource")!;
  assert.deepEqual(collect.progress, { resource: "oak_log", quantity: 64, interruptions: 1 });
  assert.equal(
    JSON.stringify(snapshot).includes("attemptedSites"),
    false,
    "raw coordinate arrays never reach the model",
  );
  const blocked = rest.find((outcome) => outcome.type === "build_base")!;
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.reason, "3 failed attempts: walls missing");
  assert.equal(blocked.progress, null, "empty resume state stays null");
  assert.equal(rest.some((outcome) => outcome.type === "go_home" && outcome.status === "cancelled"), true);
});

test("recent tasks is empty when the task store is not wired", () => {
  const { ctx, input } = harness({});
  assert.deepEqual(buildStateSnapshot(ctx, input).recentTasks, []);
});

test("blocked actions flow through from the watchdog view", () => {
  const blocked = [{ action: "collect_resource:coal:32", reason: "3 failed attempts: no coal found", retryInSeconds: 512 }];
  const { ctx, input } = harness({ blocked });
  assert.deepEqual(buildStateSnapshot(ctx, input).blockedActions, blocked);
});

test("compact progress compacts the active task's resume state", () => {
  const { ctx, input } = harness({});
  (ctx.scheduler as { active: object }).active = {
    objective: "Collect 64 oak logs",
    resumeState: { resource: "oak_log", quantity: 41, attemptedSites: ["-61,91,5"], interruptions: 0 },
    lastError: null,
  };
  const snapshot = buildStateSnapshot(ctx, input);
  assert.deepEqual(snapshot.task.progress, { resource: "oak_log", quantity: 41, interruptions: 0 });
  assert.equal(JSON.stringify(snapshot).includes("attemptedSites"), false);
});

test("snapshot serializes to a bounded structured JSON shape", () => {
  const { ctx, input } = harness({
    items: [item("oak_log", 41), item("bread", 7)],
    position: { x: 0, y: 64, z: 0 },
    home: { x: 0, y: 64, z: 0, dimension: "overworld" },
  });
  const snapshot = buildStateSnapshot(ctx, input);
  const json = JSON.stringify(snapshot);
  for (const key of ["inventory", "equipment", "home", "recentTasks", "blockedActions"]) {
    assert.equal(json.includes(`"${key}"`), true, `${key} present`);
  }
  assert.ok(json.length < 1200, `snapshot stays compact (${json.length} bytes)`);
});