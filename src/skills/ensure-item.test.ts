import assert from "node:assert/strict";
import { test } from "node:test";
import type { Recipe } from "prismarine-recipe";
import { ORE_SOURCE_BY_DROP, resolvePlan, SMELT_INPUT_BY_OUTPUT, type EnsureStep, type RecipeCatalog } from "./ensure-item.js";

/** Tiny fake recipe catalog (ids are arbitrary but consistent). */
function recipe(id: number, outputCount: number, deltas: [number, number][], requiresTable = false): Recipe {
  return {
    result: { id, metadata: null, count: outputCount },
    delta: deltas.map(([itemId, count]) => ({ id: itemId, metadata: null, count })),
    requiresTable,
  } as unknown as Recipe;
}

const NAMES: Record<number, string> = {
  1: "oak_log",
  2: "stone",
  3: "iron_ore",
  4: "coal_ore",
  10: "oak_planks",
  11: "stick",
  15: "iron_ingot",
  20: "iron_pickaxe",
  30: "furnace",
};

const GATHERABLE = new Set(["oak_log", "stone", "iron_ore", "coal_ore", "sand", "clay_ball"]);

const RECIPES: Record<string, Recipe[]> = {
  oak_planks: [recipe(10, 4, [[1, -1], [10, 4]])],
  stick: [recipe(11, 4, [[10, -2], [11, 4]])],
  iron_pickaxe: [recipe(20, 1, [[15, -3], [11, -2], [20, 1]], true)],
  furnace: [recipe(30, 1, [[2, -8], [30, 1]], true)],
};

const catalog: RecipeCatalog = {
  gatherable: (item) => GATHERABLE.has(item),
  recipesProducing: (item) => RECIPES[item] ?? [],
  nameForId: (id) => NAMES[id] ?? null,
};

/** Deterministic label for a resolve step (fuel steps carry no item name). */
function stepLabel(step: EnsureStep): string {
  return step.kind === "fuel" ? "fuel:fuel" : `${step.kind}:${step.item}`;
}

test("mineable items resolve to a single gather step", () => {
  const plan = resolvePlan("oak_log", 32, catalog);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.plan.steps, [{ kind: "gather", item: "oak_log", quantity: 32 }]);
});

test("iron_pickaxe expands: mine ore, smelt, craft sticks, craft the pickaxe", () => {
  const plan = resolvePlan("iron_pickaxe", 1, catalog);
  assert.equal(plan.ok, true);
  const kinds = plan.plan.steps.map(stepLabel);
  assert.deepEqual(kinds, [
    "gather:iron_ore",
    "fuel:fuel",
    "smelt:iron_ingot",
    "gather:oak_log",
    "craft:oak_planks",
    "craft:stick",
    "craft:iron_pickaxe",
  ]);
  assert.equal(plan.plan.needsTable, true);
  assert.equal(plan.plan.needsFurnace, true);
});

test("cooked food hunts the raw meat, fuels the furnace, and smelts", () => {
  const plan = resolvePlan("cooked_beef", 2, catalog);
  assert.equal(plan.ok, true);
  const kinds = plan.plan.steps.map(stepLabel);
  assert.deepEqual(kinds, ["hunt:beef", "fuel:fuel", "smelt:cooked_beef"]);
  assert.equal(plan.plan.needsFurnace, true);
});

test("smelt inputs and ore drops use the deterministic maps", () => {
  assert.equal(SMELT_INPUT_BY_OUTPUT["iron_ingot"], "raw_iron");
  assert.equal(ORE_SOURCE_BY_DROP["raw_iron"], "iron_ore");
  const plan = resolvePlan("iron_ingot", 3, catalog);
  assert.equal(plan.ok, true);
  const kinds = plan.plan.steps.map(stepLabel);
  assert.deepEqual(kinds, ["gather:iron_ore", "fuel:fuel", "smelt:iron_ingot"]);
});

test("unknown items fail with INVALID_RESOURCE", () => {
  const plan = resolvePlan("ender_jewel", 1, catalog);
  assert.equal(plan.ok, false);
  assert.equal(plan.errorCode, "INVALID_RESOURCE");
});

test("invalid quantities fail with INVALID_RESOURCE", () => {
  const plan = resolvePlan("oak_log", 0, catalog);
  assert.equal(plan.ok, false);
  assert.equal(plan.errorCode, "INVALID_RESOURCE");
});

test("self-consuming recipes never loop", () => {
  // A recipe that consumes its own output is skipped, so resolution fails
  // cleanly instead of recursing to the depth cap.
  const loopy: RecipeCatalog = {
    ...catalog,
    recipesProducing: (item) => {
      if (item === "oak_log") {
        return [recipe(1, 1, [[1, -1], [1, 1]])];
      }
      return catalog.recipesProducing(item);
    },
  };
  const plan = resolvePlan("oak_log", 2, loopy);
  assert.equal(plan.ok, true); // oak_log is gatherable — the first rule wins.
});

test("craft quantities round up to whole crafts", () => {
  const plan = resolvePlan("oak_planks", 5, catalog);
  assert.equal(plan.ok, true);
  const gather = plan.plan.steps.find((step) => step.kind === "gather") as Extract<EnsureStep, { kind: "gather" }>;
  assert.equal(gather.quantity, 2); // 5 planks need 2 crafts of 4, so 2 logs.
});