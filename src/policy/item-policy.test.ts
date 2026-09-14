import assert from "node:assert/strict";
import { test } from "node:test";
import { ITEM_VALUE_ORDER, ItemPolicy } from "./item-policy.js";

const policy = new ItemPolicy();

test("spec 24.1: critical items classify critical", () => {
  for (const name of [
    "diamond",
    "netherite_scrap",
    "netherite_ingot",
    "ancient_debris",
    "elytra",
    "totem_of_undying",
    "enchanted_golden_apple",
    "shulker_box",
    "dragon_egg",
    "nether_star",
    "beacon",
    "heart_of_the_sea",
    "diamond_pickaxe",
    "diamond_sword",
    "netherite_chestplate",
  ]) {
    assert.equal(policy.classify(name), "critical", name);
  }
});

test("spec 24.2: valuable items classify valuable", () => {
  for (const name of [
    "emerald",
    "gold_ingot",
    "iron_ingot",
    "lapis_lazuli",
    "redstone",
    "ender_pearl",
    "blaze_rod",
    "ghast_tear",
    "echo_shard",
    "nautilus_shell",
    "saddle",
    "name_tag",
    "obsidian",
    "iron_pickaxe",
    "gold_sword",
    "chainmail_boots",
    "leather_helmet",
    "netherite_smithing_template",
    "music_disc_cat",
    "iron_horse_armor",
  ]) {
    assert.equal(policy.classify(name), "valuable", name);
  }
});

test("spec 24.3: useful bulk items classify useful", () => {
  for (const name of [
    "coal",
    "charcoal",
    "raw_iron",
    "raw_copper",
    "raw_gold",
    "oak_log",
    "stripped_spruce_log",
    "oak_planks",
    "cobblestone",
    "stone",
    "bread",
    "cooked_beef",
    "leather",
    "white_wool",
    "string",
    "bone",
    "gunpowder",
    "arrow",
    "torch",
    "minecraft:oak_log",
  ]) {
    assert.equal(policy.classify(name), "useful", name);
  }
});

test("spec 24.4: expendable items classify expendable", () => {
  for (const name of [
    "dirt",
    "gravel",
    "netherrack",
    "rotten_flesh",
    "wheat_seeds",
    "poppy",
    "dandelion",
    "wooden_pickaxe",
    "stone_axe",
  ]) {
    assert.equal(policy.classify(name), "expendable", name);
  }
});

test("unknown items default to common", () => {
  assert.equal(policy.classify("glass"), "common");
  assert.equal(policy.classify("cobweb"), "common");
  assert.equal(policy.classify("blue_ice"), "common");
});

test("namespaced names classify identically", () => {
  assert.equal(policy.classify("minecraft:elytra"), policy.classify("elytra"));
  assert.equal(policy.classify("minecraft:oak_log"), policy.classify("oak_log"));
});

test("custom-named items are critical regardless of base name", () => {
  assert.equal(policy.classify("oak_planks", { customName: "Lucky Planks" }), "critical");
  assert.equal(policy.classify("oak_planks", { customName: "" }), "useful");
});

test("rare enchanted books are critical, plain books are useful", () => {
  assert.equal(policy.classify("enchanted_book", { enchants: [{ name: "mending" }] }), "critical");
  assert.equal(policy.classify("enchanted_book", { enchants: [{ name: "sharpness" }] }), "common");
  assert.equal(policy.classify("book"), "useful");
});

test("enchanted equipment is valuable", () => {
  assert.equal(policy.classify("iron_sword", { enchants: [{ name: "sharpness" }] }), "valuable");
  assert.equal(policy.classify("bow", { enchants: [{ name: "power" }] }), "valuable");
  assert.equal(policy.classify("bow"), "common");
});

test("config overrides win over built-in rules (spec 24.5)", () => {
  const overridden = new ItemPolicy({ cobblestone: "critical", dirt: "useful" });
  assert.equal(overridden.classify("cobblestone"), "critical");
  assert.equal(overridden.classify("dirt"), "useful");
  // Non-overridden names still use the built-in rules.
  assert.equal(overridden.classify("diamond"), "critical");
  assert.equal(overridden.classify("glass"), "common");
});

test("value rank orders critical before valuable before useful before common", () => {
  const ranks = ITEM_VALUE_ORDER.map((value) => policy.rank(value));
  assert.deepEqual(ranks, [1, 2, 3, 4, 5]);
});