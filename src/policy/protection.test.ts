import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_HOME_POLICY, createProtectedRegion } from "../minecraft/protection.js";
import { checkBlockDestruction, checkBlockPlacement, classifyBlock } from "./protection.js";
import { revalidateAction } from "./action-boundary.js";
import { MinecraftConfigSchema } from "../config/schema.js";

const region = createProtectedRegion({
  name: "home",
  dimension: "overworld",
  center: { x: 0, z: 0 },
  sizeX: 100,
  sizeZ: 100,
});

const inside = { x: 5, y: 64, z: 5 };
const outside = { x: 500, y: 64, z: 500 };

test("classifyBlock: terrain (trees, ores, stone) vs structural vs infrastructure", () => {
  assert.equal(classifyBlock("oak_log"), "terrain");
  assert.equal(classifyBlock("oak_leaves"), "terrain");
  assert.equal(classifyBlock("iron_ore"), "terrain");
  assert.equal(classifyBlock("deepslate_coal_ore"), "terrain");
  assert.equal(classifyBlock("stone"), "terrain");
  assert.equal(classifyBlock("dirt"), "terrain");
  assert.equal(classifyBlock("chest"), "infrastructure");
  assert.equal(classifyBlock("trapped_chest"), "infrastructure");
  assert.equal(classifyBlock("oak_planks"), "structural");
  assert.equal(classifyBlock("brick_wall"), "structural");
  assert.equal(classifyBlock("red_bed"), "structural");
});

test("spec 8.2: natural terrain may be gathered inside the region", () => {
  const verdict = checkBlockDestruction("oak_log", inside, region, false);
  assert.equal(verdict.allowed, true);
  assert.equal(checkBlockDestruction("iron_ore", inside, region, false).allowed, true);
});

test("spec 8.2: registered storage is never destroyed automatically", () => {
  const verdict = checkBlockDestruction("chest", inside, region, true);
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.code, "PROTECTED_REGION");
});

test("spec 8.2: structural blocks need an explicit request inside the region", () => {
  const unrequested = checkBlockDestruction("oak_planks", inside, region, false);
  assert.equal(unrequested.allowed, false);
  assert.equal(unrequested.code, "PROTECTED_REGION");
  // "Restricted by default: unrequested demolition" — a request lifts it.
  assert.equal(checkBlockDestruction("oak_planks", inside, region, true).allowed, true);
});

test("spec 8.2: outside the region everything is free", () => {
  assert.equal(checkBlockDestruction("oak_planks", outside, region, false).allowed, true);
  assert.equal(checkBlockDestruction("chest", outside, region, false).allowed, true);
});

test("spec 8.2: fire and lava placement are forbidden inside the region", () => {
  assert.equal(checkBlockPlacement("torch", inside, region).allowed, false);
  assert.equal(checkBlockPlacement("lava", inside, region).allowed, false);
  // Permitted infrastructure placement (the bot's own furniture) stays legal.
  assert.equal(checkBlockPlacement("crafting_table", inside, region).allowed, true);
  assert.equal(checkBlockPlacement("chest", inside, region).allowed, true);
  // Outside the region placement is free.
  assert.equal(checkBlockPlacement("lava", outside, region).allowed, true);
});

test("the default home policy allows containers, beds, tables, furnaces; forbids mining and fire", () => {
  assert.equal(DEFAULT_HOME_POLICY.useContainers, true);
  assert.equal(DEFAULT_HOME_POLICY.useBeds, true);
  assert.equal(DEFAULT_HOME_POLICY.useCraftingTables, true);
  assert.equal(DEFAULT_HOME_POLICY.useFurnaces, true);
  assert.equal(DEFAULT_HOME_POLICY.mine, false);
  assert.equal(DEFAULT_HOME_POLICY.fire, false);
  assert.equal(DEFAULT_HOME_POLICY.lava, false);
  assert.equal(DEFAULT_HOME_POLICY.breakStructure, false);
});

test("last-safe-point policy revalidation rejects protected mutations before the adapter call", () => {
  const config = MinecraftConfigSchema.parse({
    server: { host: "h", port: 25565, username: "CobbleBob" },
    home: { x: 0, y: 64, z: 0 },
  });
  const bot = { entity: { position: inside }, health: 20, findBlocks: () => [] } as any;
  const deniedPlace = revalidateAction(bot, "place", inside, config, region, { blockName: "torch" });
  assert.equal(deniedPlace.allowed, false);
  const deniedContainer = revalidateAction(bot, "container", inside, config, {
    ...region,
    policy: { ...region.policy, useContainers: false },
  });
  assert.equal(deniedContainer.allowed, false);
});
