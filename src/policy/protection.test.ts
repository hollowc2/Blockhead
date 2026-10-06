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
  assert.equal(classifyBlock("red_bed"), "infrastructure");
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

test("structural blocks cannot be destroyed merely because a task is user-sourced", () => {
  const unrequested = checkBlockDestruction("oak_planks", inside, region, false);
  assert.equal(unrequested.allowed, false);
  assert.equal(unrequested.code, "PROTECTED_REGION");
  assert.equal(checkBlockDestruction("oak_planks", inside, region, true).allowed, false);
});

test("spec 8.2: outside the region everything is free", () => {
  assert.equal(checkBlockDestruction("oak_planks", outside, region, false).allowed, true);
  assert.equal(checkBlockDestruction("chest", outside, region, false).allowed, true);
});

test("spec 8.2: fire and lava placement are forbidden inside the region", () => {
  assert.equal(checkBlockPlacement("fire", inside, region).allowed, false);
  assert.equal(checkBlockPlacement("lava", inside, region).allowed, false);
  // Torches are lighting for the base, not fire.
  assert.equal(checkBlockPlacement("torch", inside, region).allowed, true);
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
    server: { host: "h", port: 25565, username: "CobbleBob", world_key: "test-world" },
    home: { x: 0, y: 64, z: 0 },
  });
  const bot = { entity: { position: inside }, health: 20, findBlocks: () => [] } as any;
  const deniedPlace = revalidateAction(bot, "place", inside, config, region, { blockName: "lava" });
  assert.equal(deniedPlace.allowed, false);
  const deniedContainer = revalidateAction(bot, "container", inside, config, {
    ...region,
    policy: { ...region.policy, useContainers: false },
  });
  assert.equal(deniedContainer.allowed, false);
});

test("inside the home region: natural terrain may be dug, built blocks only as the build's own replacement", () => {
  const config = MinecraftConfigSchema.parse({
    server: { host: "h", port: 25565, username: "CobbleBob", world_key: "test-world" },
    home: { x: 0, y: 64, z: 0 },
  });
  const bot = { entity: { position: inside }, health: 20, findBlocks: () => [] } as any;
  assert.equal(revalidateAction(bot, "dig", inside, config, region, { blockName: "oak_leaves" }).allowed, true);
  assert.equal(revalidateAction(bot, "dig", inside, config, region, { blockName: "stone" }).allowed, true);
  assert.equal(revalidateAction(bot, "dig", inside, config, region, { blockName: "birch_planks" }).allowed, false);
  assert.equal(revalidateAction(bot, "dig", inside, config, region, { blockName: "birch_planks", ownBuildReplacement: true, projectId: "p1" }).allowed, true);
  assert.equal(revalidateAction(bot, "dig", inside, config, region, { blockName: "chest", ownBuildReplacement: true, projectId: "p1" }).allowed, false);
});

test("the boundary refuses digs and fights only at critical health; animals are always fair game", () => {
  const config = MinecraftConfigSchema.parse({
    server: { host: "h", port: 25565, username: "CobbleBob", world_key: "test-world" },
    home: { x: 0, y: 64, z: 0 },
  });
  const at = (health: number) => ({ entity: { position: outside }, health, findBlocks: () => [] }) as any;
  assert.equal(revalidateAction(at(4), "combat", outside, config, region, { blockName: "zombie" }).allowed, false);
  assert.equal(revalidateAction(at(8), "combat", outside, config, region, { blockName: "zombie" }).allowed, true, "skills own the retreat policy above critical");
  assert.equal(revalidateAction(at(1), "combat", outside, config, region, { blockName: "sheep" }).allowed, true, "a starving bot may still kill a sheep");
  assert.equal(revalidateAction(at(8), "dig", outside, config, region, { blockName: "birch_leaves" }).allowed, true);
  assert.equal(revalidateAction(at(5), "dig", outside, config, region, { blockName: "stone" }).allowed, true);
  assert.equal(revalidateAction(at(4), "dig", outside, config, region, { blockName: "stone" }).allowed, false);
  const starving = { ...at(1), food: 0 };
  assert.equal(revalidateAction(starving, "dig", outside, config, region, { blockName: "dirt" }).allowed, true, "no regen to wait for: it may dig into a shelter");
});

test("field levelling may cut farmland in the home region while fixtures stay protected", () => {
  assert.equal(classifyBlock("farmland"), "terrain");
  assert.equal(checkBlockDestruction("farmland", inside, region, false).allowed, true);
  for (const block of ["dirt_path", "cobblestone", "oak_planks", "chest", "torch"]) {
    assert.equal(checkBlockDestruction(block, inside, region, false).allowed, false, block);
  }
});
