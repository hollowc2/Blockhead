import assert from "node:assert/strict";
import { test } from "node:test";
import type { Recipe } from "prismarine-recipe";
import { charcoalLogsFor, fuelFor, planksPlan, ORE_SOURCE_BY_DROP, rankRecipes, resolvePlan, SMELT_INPUT_BY_OUTPUT, type EnsureStep, type RecipeCatalog } from "./ensure-item.js";

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
test("recipe ranking looks one craft deeper: sticks come from the stocked log species", () => {
  const names: Record<number, string> = { 1: "pale_oak_log", 2: "birch_log", 10: "pale_oak_planks", 12: "birch_planks", 11: "stick" };
  const recipes: Record<string, Recipe[]> = {
    pale_oak_planks: [recipe(10, 4, [[1, -1], [10, 4]])],
    birch_planks: [recipe(12, 4, [[2, -1], [12, 4]])],
    // Listed pale oak first, as the registry happened to.
    stick: [recipe(11, 4, [[10, -2], [11, 4]]), recipe(11, 4, [[12, -2], [11, 4]])],
  };
  const stock: Record<string, number> = { birch_log: 36 };
  const stocked: RecipeCatalog = {
    gatherable: (item) => item.endsWith("_log"),
    recipesProducing: (item) => recipes[item] ?? [],
    nameForId: (id) => names[id] ?? null,
    available: (item) => stock[item] ?? 0,
  };
  const ranked = rankRecipes(recipes.stick!, stocked);
  assert.equal(stocked.nameForId(ranked[0]!.delta[0]!.id), "birch_planks");
});

test("with nothing stocked, stone tools plan the stone and wood found where the bot is", async () => {
  const { createRequire } = await import("node:module");
  const { makeRecipeCatalog } = await import("./ensure-item.js");
  const require = createRequire(import.meta.url);
  const registry = require("prismarine-registry")("1.21.4");
  const { Recipe: RecipeData } = require("prismarine-recipe")(registry);
  const liveBot = (y: number, dimension = "minecraft:overworld") => ({
    registry,
    game: { dimension },
    entity: { position: { y } },
    // An acacia savanna: the only logs around.
    findBlocks: () => [{ x: 1, y, z: 1 }, { x: 2, y, z: 1 }],
    blockAt: () => ({ name: "acacia_log" }),
    recipesAll: (id: number, metadata: number | null, table: boolean) =>
      (RecipeData.find(id, metadata) as Recipe[]).filter((candidate) => !candidate.requiresTable || table),
  }) as never;
  const gathered = (y: number, dimension?: string): string[] => {
    const plan = resolvePlan("stone_axe", 1, makeRecipeCatalog(liveBot(y, dimension), () => 0));
    assert.equal(plan.ok, true);
    return plan.plan.steps.filter((step) => step.kind === "gather").map((step) => (step as { item: string }).item).sort();
  };

  // Previously the registry's first variants: cobbled_deepslate and pale_oak_log.
  assert.deepEqual(gathered(85), ["acacia_log", "cobblestone"]);
  assert.deepEqual(gathered(-30), ["acacia_log", "cobbled_deepslate"]);
  assert.deepEqual(gathered(70, "minecraft:the_nether"), ["acacia_log", "blackstone"]);
});

test("charcoal fuels its own run: 76 logs net 64, no separate fuel step", () => {
  // Previously the plan reserved a burned log per charcoal (128 logs for 64)
  // and failed outright holding 45.
  assert.equal(charcoalLogsFor(64), 76);
  assert.equal(charcoalLogsFor(16), 20);
  assert.equal(charcoalLogsFor(0), 0);
  const plan = resolvePlan("charcoal", 64, catalog);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.plan.steps, [
    { kind: "gather", item: "oak_log", quantity: 76 },
    { kind: "smelt", item: "charcoal", quantity: 64 },
  ]);
  assert.equal(plan.plan.needsFurnace, true);
});

test("a smelt's fuel step asks for one coal per 8 items, not one per item", () => {
  assert.equal(fuelFor(3), 1);
  assert.equal(fuelFor(16), 2);
  assert.equal(fuelFor(17), 3);
  const plan = resolvePlan("iron_ingot", 16, catalog);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.plan.steps.find((step) => step.kind === "fuel"), { kind: "fuel", quantity: 2 });
});

test("planks for a table come from logs when no planks are stocked", () => {
  // Live 19:43 and 20:15: re-arming after a respawn found no table and could
  // not make one: only stored planks were tried, with 48 logs at home.
  assert.deepEqual(planksPlan(4, {}, { oak_log: 36, coal: 42 }), [
    { kind: "withdraw", item: "oak_log", count: 1 },
    { kind: "craft", item: "oak_planks", times: 1 },
  ]);
  assert.deepEqual(planksPlan(4, { birch_log: 2 }, { oak_log: 36 }), [{ kind: "craft", item: "birch_planks", times: 1 }], "carried logs before a chest trip");
  assert.deepEqual(planksPlan(4, { oak_planks: 1 }, { spruce_planks: 2, oak_log: 5 }), [
    { kind: "withdraw", item: "spruce_planks", count: 2 },
    { kind: "withdraw", item: "oak_log", count: 1 },
    { kind: "craft", item: "oak_planks", times: 1 },
  ]);
  assert.deepEqual(planksPlan(4, { oak_planks: 4 }, {}), []);
  assert.deepEqual(planksPlan(4, { stripped_oak_log: 3 }, {}), [], "stripped logs are not raw logs");
});

test("a run that starts while the last one unwinds waits for it instead of blocking", async () => {
  // 20:13: three re-arm runs started while a paused one was still unwinding,
  // each returned "already producing ..." as blocked, and never ran again.
  const { EnsureItemRunner } = await import("./ensure-item.js");
  const runner = new EnsureItemRunner({ config: {} } as unknown as ConstructorParameters<typeof EnsureItemRunner>[0]);
  const started: string[] = [];
  (runner as unknown as { execute: (item: string) => Promise<unknown> }).execute = async (item: string) => {
    started.push(item);
    await new Promise((resolve) => setTimeout(resolve, 30));
    return { ok: true, status: "completed" };
  };
  const first = runner.run("stone_sword", 1);
  const second = await runner.run("stone_axe", 1);
  await first;
  assert.equal(second.status, "completed");
  assert.deepEqual(started, ["stone_sword", "stone_axe"]);
});

test("a smelt step fetches fuel from the chest when none is carried", async () => {
  // 2026-10-05 09:54: 66 fuel in the chest, none in hand: the step counted
  // the chest as fuel on hand, skipped the withdraw, and failed "no fuel to burn".
  const { EnsureItemRunner } = await import("./ensure-item.js");
  const carried: { name: string; count: number }[] = [{ name: "raw_iron", count: 3 }];
  const bot = { inventory: { items: () => carried } };
  const runner = new EnsureItemRunner({ bot, config: {} } as unknown as ConstructorParameters<typeof EnsureItemRunner>[0]);
  const internals = runner as unknown as {
    stored: Record<string, number>;
    materialize: (name: string, count: number) => Promise<{ ok: boolean }>;
    materializeFuel: (count: number) => Promise<{ ok: boolean }>;
    stepSmelt: (step: { item: string; quantity: number }, furnace: null, data: object) => Promise<{ reason: string } | null>;
  };
  internals.stored = { coal: 66 };
  internals.materialize = async () => ({ ok: true });
  const fetched: number[] = [];
  internals.materializeFuel = async (count) => { fetched.push(count); carried.push({ name: "coal", count }); return { ok: true }; };
  const failure = await internals.stepSmelt({ item: "iron_ingot", quantity: 3 }, null, {});
  assert.deepEqual(fetched, [1]);
  assert.match(failure?.reason ?? "", /no furnace/, "got as far as the furnace");
});

function stockedCatalog(stock: Record<string, number>): RecipeCatalog {
  return {
    ...catalog,
    available: (item) => stock[item] ?? 0,
    nameForId: (id) => id === 21 ? "iron_chestplate" : catalog.nameForId(id),
    recipesProducing: (item) => item === "iron_chestplate"
      ? [recipe(21, 1, [[15, -8], [21, 1]], true)]
      : catalog.recipesProducing(item),
  };
}

test("chestplate uses five existing ingots and smelts only three raw iron", () => {
  const result = resolvePlan("iron_chestplate", 1, stockedCatalog({ iron_ingot: 5, raw_iron: 4, coal: 1 }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.plan.steps, [
    { kind: "fuel", quantity: 1 },
    { kind: "smelt", item: "iron_ingot", quantity: 3 },
    { kind: "craft", item: "iron_chestplate", quantity: 1, table: true },
  ]);
});

test("stocked ingots skip mining, fuel and smelting entirely", () => {
  const result = resolvePlan("iron_chestplate", 1, stockedCatalog({ iron_ingot: 8 }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.plan.steps, [{ kind: "craft", item: "iron_chestplate", quantity: 1, table: true }]);
  assert.equal(result.plan.needsFurnace, false);
});

test("partially completed top-level smelting produces only the ingot shortfall", () => {
  const result = resolvePlan("iron_ingot", 11, stockedCatalog({ iron_ingot: 7, raw_iron: 4, coal: 1 }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.plan.steps, [
    { kind: "fuel", quantity: 1 },
    { kind: "smelt", item: "iron_ingot", quantity: 4 },
  ]);
});

test("already-crafted outputs and ingredients satisfy the plan without new work", () => {
  const result = resolvePlan("iron_chestplate", 1, stockedCatalog({ iron_chestplate: 1 }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.plan.steps, []);
});

test("a partial ore stock plans a total target rather than its shortfall", () => {
  const result = resolvePlan("iron_chestplate", 1, stockedCatalog({ raw_iron: 4 }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.plan.steps[0], { kind: "gather", item: "iron_ore", quantity: 8 });
});

test("rounded recipe surplus and shared ingredients are reserved across branches", () => {
  const shared: RecipeCatalog = {
    ...stockedCatalog({ oak_planks: 2 }),
    nameForId: (id) => id === 40 ? "test_item" : catalog.nameForId(id),
    recipesProducing: (item) => item === "test_item"
      ? [recipe(40, 1, [[10, -2], [11, -2], [40, 1]], true)]
      : catalog.recipesProducing(item),
  };
  const result = resolvePlan("test_item", 1, shared);
  assert.equal(result.ok, true);
  assert.deepEqual(result.plan.steps, [
    { kind: "gather", item: "oak_log", quantity: 1 },
    { kind: "craft", item: "oak_planks", quantity: 1, table: false },
    { kind: "craft", item: "stick", quantity: 1, table: false },
    { kind: "craft", item: "test_item", quantity: 1, table: true },
  ]);
});

test("gather runner receives carried stock plus shortfall, and only observed delivery is booked", async () => {
  const { EnsureItemRunner } = await import("./ensure-item.js");
  const carried = [{ name: "raw_iron", count: 4 }];
  const targets: number[] = [];
  const runner = new EnsureItemRunner({
    bot: { inventory: { items: () => carried } }, config: {},
    collect: { run: async (_item: string, target: number) => {
      targets.push(target);
      carried.length = 0;
      return { ok: true, status: "completed", data: { gathered: 4, delivered: 8 } };
    } },
  } as unknown as ConstructorParameters<typeof EnsureItemRunner>[0]);
  const internal = runner as unknown as {
    stored: Record<string, number>;
    mode: string;
    stepGather: (step: { item: string; quantity: number }, data: { gathered: number }) => Promise<unknown>;
  };
  internal.stored = { raw_iron: 2 };
  internal.mode = "ensure";
  assert.equal(await internal.stepGather({ item: "iron_ore", quantity: 10 }, { gathered: 0 }), null);
  assert.deepEqual(targets, [8], "gather 4 new raw iron, keeping 2 already stored");
  assert.equal(internal.stored.raw_iron, 10);
});

test("existing finished tools reduce the top-level craft count", () => {
  const result = resolvePlan("iron_pickaxe", 3, stockedCatalog({ iron_pickaxe: 2, iron_ingot: 3, stick: 2 }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.plan.steps, [{ kind: "craft", item: "iron_pickaxe", quantity: 1, table: true }]);
});

test("whole-craft surplus supplies a later sibling without another log", () => {
  const shared: RecipeCatalog = {
    ...catalog,
    nameForId: (id) => id === 40 ? "test_item" : catalog.nameForId(id),
    recipesProducing: (item) => item === "test_item"
      ? [recipe(40, 1, [[10, -6], [11, -2], [40, 1]], true)]
      : catalog.recipesProducing(item),
  };
  const result = resolvePlan("test_item", 1, shared);
  assert.equal(result.ok, true);
  assert.deepEqual(result.plan.steps, [
    { kind: "gather", item: "oak_log", quantity: 2 },
    { kind: "craft", item: "oak_planks", quantity: 2, table: false },
    { kind: "craft", item: "stick", quantity: 1, table: false },
    { kind: "craft", item: "test_item", quantity: 1, table: true },
  ]);
});

test("coal reserved for a recipe is replenished before smelting burns coal first", () => {
  const shared: RecipeCatalog = {
    ...stockedCatalog({ coal: 1, charcoal: 1, raw_iron: 1 }),
    nameForId: (id) => id === 40 ? "test_item" : id === 41 ? "coal" : catalog.nameForId(id),
    recipesProducing: (item) => item === "test_item"
      ? [recipe(40, 1, [[41, -1], [15, -1], [40, 1]], true)]
      : catalog.recipesProducing(item),
  };
  const result = resolvePlan("test_item", 1, shared);
  assert.equal(result.ok, true);
  assert.deepEqual(result.plan.steps, [
    { kind: "fuel", quantity: 3 },
    { kind: "smelt", item: "iron_ingot", quantity: 1 },
    { kind: "craft", item: "test_item", quantity: 1, table: true },
  ]);
});

test("a gather result without delivery evidence cannot invent stored ore", async () => {
  const { EnsureItemRunner } = await import("./ensure-item.js");
  const runner = new EnsureItemRunner({
    bot: { inventory: { items: () => [] } }, config: {},
    collect: { run: async () => ({ ok: true, status: "completed" }) },
  } as unknown as ConstructorParameters<typeof EnsureItemRunner>[0]);
  const internal = runner as unknown as {
    stored: Record<string, number>;
    mode: string;
    stepGather: (step: { item: string; quantity: number }, data: { gathered: number }) => Promise<unknown>;
  };
  internal.stored = {};
  internal.mode = "ensure";
  await internal.stepGather({ item: "iron_ore", quantity: 4 }, { gathered: 0 });
  assert.equal(internal.stored.raw_iron, 0);
});
