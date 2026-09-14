import assert from "node:assert/strict";
import { test } from "node:test";
import type { Block } from "prismarine-block";
import { FOOD_ITEM_NAMES, isForageFoodBlock, patrolHeadingDeg, patrolWaypoint } from "./gather-food.js";

/**
 * Patrol sweep geometry (Phase 7.2): an empty hunt radius walks the bot to
 * the ring edge on a rotating heading so the doubled next radius scans new
 * ground, and repeated hunts fan out around home instead of re-scanning the
 * same wedge. Pure helpers only — no bot, no network.
 */

test("patrolHeadingDeg rotates through 8 headings and wraps both ways", () => {
  assert.deepEqual([0, 1, 7, 8, 16, -1].map(patrolHeadingDeg), [0, 45, 315, 0, 0, 315]);
});

test("patrolWaypoint places ring-edge points from home on each heading", () => {
  // Heading 0: straight +z.
  assert.deepEqual(patrolWaypoint(0, 0, 96, 0), { x: 0, z: 96 });
  // Heading 90: straight +x.
  assert.deepEqual(patrolWaypoint(0, 0, 96, 90), { x: 96, z: 0 });
  // Heading 270: straight -x.
  assert.deepEqual(patrolWaypoint(10, -5, 48, 270), { x: -38, z: -5 });
  // Heading 45: both legs round from 96 * sin(45deg) ~= 67.88.
  assert.deepEqual(patrolWaypoint(0, 0, 96, 45), { x: 68, z: 68 });
});

/**
 * Foraging harvest rule (Phase 7): crops are only pulled when mature — an
 * immature plant yields nothing and wastes the crop — while melons and
 * mushrooms are always ripe.
 */
test("isForageFoodBlock harvests mature crops and always-ripe forage", () => {
  const block = (name: string, age?: string): Block =>
    ({ name, getProperties: () => (age !== undefined ? { age } : {}) }) as unknown as Block;

  // Crops ripen at their final growth stage.
  assert.equal(isForageFoodBlock(block("wheat", "7")), true);
  assert.equal(isForageFoodBlock(block("wheat", "4")), false);
  assert.equal(isForageFoodBlock(block("carrots", "7")), true);
  assert.equal(isForageFoodBlock(block("carrots", "6")), false);
  assert.equal(isForageFoodBlock(block("potatoes", "7")), true);
  assert.equal(isForageFoodBlock(block("potatoes", "0")), false);

  // Beetroot and berry bushes cap at age 3.
  assert.equal(isForageFoodBlock(block("beetroots", "3")), true);
  assert.equal(isForageFoodBlock(block("beetroots", "2")), false);
  assert.equal(isForageFoodBlock(block("sweet_berry_bush", "3")), true);
  assert.equal(isForageFoodBlock(block("sweet_berry_bush", "1")), false);

  // No age property: always ripe or not food at all.
  assert.equal(isForageFoodBlock(block("melon")), true);
  assert.equal(isForageFoodBlock(block("red_mushroom")), true);
  assert.equal(isForageFoodBlock(block("oak_log")), false);
  assert.equal(isForageFoodBlock(block("wheat")), false);
});

test("FOOD_ITEM_NAMES counts farmed and foraged food as food", () => {
  for (const name of [
    "wheat",
    "bread",
    "carrot",
    "potato",
    "baked_potato",
    "beetroot",
    "sweet_berries",
    "melon_slice",
    "apple",
    "brown_mushroom",
    "red_mushroom",
    "mushroom_stew",
  ]) {
    assert.equal(FOOD_ITEM_NAMES[name], true, `${name} is food`);
  }
});