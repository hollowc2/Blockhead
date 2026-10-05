import assert from "node:assert/strict";
import type { Bot } from "mineflayer";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { Block } from "prismarine-block";
import { cookPlan, FOOD_ITEM_NAMES, FORAGE_SCAN_MAX_RADIUS, fuelForCooking, huntOutcomeMessage, MAX_COOK_PER_RUN, watchEaten, forageScanRadius, isForageFoodBlock, nextHuntRadius, patrolHeadingDeg, patrolWaypoint, waitForDrops, pickSighting, isFarmFed } from "./gather-food.js";

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
  // Wheat cannot be eaten; the farm bakes it into bread.
  assert.equal(FOOD_ITEM_NAMES.wheat, undefined);
});
test("the hunt radius sequence always scans the configured maximum ring", () => {
  const radii: number[] = [];
  for (let radius = 48; radius <= 128; radius = nextHuntRadius(radius, 128)) radii.push(radius);
  assert.deepEqual(radii, [48, 96, 128]);
  const exact: number[] = [];
  for (let radius = 48; radius <= 96; radius = nextHuntRadius(radius, 96)) exact.push(radius);
  assert.deepEqual(exact, [48, 96]);
});

test("waitForDrops catches loot that spawns after the kill registers", async () => {
  let scans = 0;
  const found = await waitForDrops(() => (++scans >= 3 ? ["porkchop"] : []), 1_000, 5);
  assert.deepEqual(found, ["porkchop"]);
  assert.equal(scans, 3);
});

test("waitForDrops gives up after the settle window when nothing drops", async () => {
  const started = Date.now();
  const found = await waitForDrops<string>(() => [], 30, 5);
  assert.deepEqual(found, []);
  assert.ok(Date.now() - started >= 30);
});

test("the forage block scan never spans the outer hunt rings", () => {
  // A synchronous findBlocks over the 192-block ring stalled the event loop
  // ~5 s and the server kicked the bot for floating (2026-10-04 x3).
  assert.equal(forageScanRadius(48), 48);
  assert.equal(forageScanRadius(192), FORAGE_SCAN_MAX_RADIUS);
  assert.equal(forageScanRadius(256), FORAGE_SCAN_MAX_RADIUS);
  assert.ok(FORAGE_SCAN_MAX_RADIUS <= 64);
});

test("a hunt whose drop auto-eat consumed is reported as eaten, not 'no food dropped'", () => {
  // Server stats 2026-10-04: 169 porkchops picked up, 138 eaten raw; the
  // inventory count alone made nearly every hunt read "no food dropped".
  assert.equal(huntOutcomeMessage("pig", 0, 2), "Hunted pig; ate 2 on the spot.");
  assert.equal(huntOutcomeMessage("cow", -1, 0), "Hunted cow; no food dropped.");
  assert.equal(huntOutcomeMessage("sheep", 2, 1), null);
});

test("watchEaten counts food auto-eat finishes until stopped", () => {
  const autoEat = new EventEmitter();
  const watch = watchEaten({ autoEat } as unknown as Bot);
  autoEat.emit("eatFinish", { food: { name: "porkchop" } });
  autoEat.emit("eatFinish", { food: { name: "cooked_beef" } });
  watch.stop();
  autoEat.emit("eatFinish", { food: { name: "porkchop" } });
  assert.equal(watch.count(), 2);
});

test("raw food is planned for cooking, capped per run, with fuel at 8 items per piece", () => {
  const plan = cookPlan([
    { name: "porkchop", count: 10 },
    { name: "minecraft:beef", count: 3 },
    { name: "bread", count: 4 },
    { name: "cooked_mutton", count: 2 },
  ]);
  assert.deepEqual(plan, [
    { raw: "porkchop", cooked: "cooked_porkchop", count: 10 },
    { raw: "beef", cooked: "cooked_beef", count: 3 },
  ]);
  const capped = cookPlan([{ name: "porkchop", count: 64 }, { name: "beef", count: 5 }]);
  assert.deepEqual(capped, [{ raw: "porkchop", cooked: "cooked_porkchop", count: MAX_COOK_PER_RUN }]);
  assert.equal(fuelForCooking(13), 2);
  assert.equal(fuelForCooking(8), 1);
});

test("a sighting near a recent death is not walked to again", () => {
  const now = 10_000_000;
  const home = { x: 65, z: 51 };
  const pit = { x: 30.5, y: 71, z: 134.5, at: now - 60_000 };
  const meadow = { x: 90, y: 96, z: 40, at: now - 120_000 };
  assert.deepEqual(pickSighting([pit, meadow], home, 1024, [], now), pit, "newest wins with no deaths");
  const deaths = [{ x: 26.4, y: 71, z: 136.6, at: now - 30_000 }];
  assert.deepEqual(pickSighting([pit, meadow], home, 1024, deaths, now), meadow);
  assert.equal(pickSighting([pit], home, 1024, deaths, now), null);
  const oldDeath = [{ x: 26.4, y: 71, z: 136.6, at: now - 31 * 60_000 }];
  assert.deepEqual(pickSighting([pit], home, 1024, oldDeath, now), pit, "an old death no longer blocks the spot");
});

test("after an animal kill, waitForDrops holds out for the meat past an early feather", async () => {
  let scans = 0;
  const found = await waitForDrops(
    () => (++scans >= 4 ? ["feather", "chicken"] : ["feather"]),
    1_000,
    5,
    undefined,
    (drops) => drops.includes("chicken"),
  );
  assert.deepEqual(found, ["feather", "chicken"]);
  assert.ok(scans >= 4, "did not stop at the feather alone");
});

test("a trip home cut short by a pause is reported interrupted, not stuck", async () => {
  // Live 21:58:44: the pause aborted the walk home mid-trip, travel
  // returned "aborted" before its own poll saw the pause, and the run
  // reported "Stuck: could not return home: aborted" as a failure.
  const { GatherFoodRunner } = await import("./gather-food.js");
  const { withWorldActionLease } = await import("../agent/world-actions.js");
  const { Vec3 } = await import("vec3");
  const controller = new AbortController();
  let paused = false;
  const pause = (): void => { paused = true; controller.abort(new Error("task paused")); };
  const bot = Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(100, 64, 0), onGround: true, velocity: new Vec3(0, 0, 0) },
    game: { dimension: "overworld", gameMode: "survival" },
    inventory: { items: () => [], emptySlotCount: () => 30 },
    autoEat: { enableAuto() {} },
    registry: (await import("prismarine-registry")).default("1.21.4"),
    pathfinder: { setMovements() {}, setGoal() {}, stop() {}, isMoving: () => false, movements: null, goto: () => new Promise((_, reject) => setTimeout(() => { pause(); reject(new Error("GoalChanged")); }, 20)) },
    blockAt: () => null,
    clearControlStates() {},
    setControlState() {},
  }) as unknown as Bot;
  const silent = { info() {}, warn() {}, debug() {}, error() {} };
  const runner = new GatherFoodRunner({
    bot,
    state: { home: { x: 0, y: 64, z: 0, dimension: "overworld" }, worldId: 1 },
    config: {},
    bus: { emit() {} },
    storage: {},
    skills: { recordSuccess() {} },
    logger: silent,
  } as unknown as ConstructorParameters<typeof GatherFoodRunner>[0]);
  const signals = { signal: controller.signal, get cancelled() { return controller.signal.aborted; }, checkpoint: () => !paused };
  const result = await withWorldActionLease({ owner: "food-test", signal: new AbortController().signal, acknowledged: Promise.resolve() }, () => runner.run(4, { signals }));
  assert.equal(result.status, "interrupted", result.message);
});

test("a sheep standing in the lake is not hunted", async () => {
  // Death 73 (21:58): a sheep by the lake east of home drew the hunt and its
  // drop sweep into the water, where drowned killed the bot.
  const { nearestMatchingMob, inWater } = await import("./gather-food.js");
  const { Vec3 } = await import("vec3");
  const mob = (id: number, x: number) => ({ id, type: "animal", name: "sheep", position: new Vec3(x, 62, 0), isValid: true, health: 8 });
  const bot = {
    entity: { position: new Vec3(0, 63, 0) },
    entities: { 1: mob(1, 3), 2: mob(2, 9) },
    blockAt: (pos: { x: number }) => ({ name: pos.x === 3 ? "water" : "grass_block" }),
  } as unknown as Bot;
  assert.equal(inWater(bot, { x: 3.4, y: 62, z: 0.2 }), true);
  assert.equal(nearestMatchingMob(bot, 32, (name) => name === "sheep")?.id, 2, "the nearer sheep in the water is passed over");
});

test("sightings near a death in the log are skipped after a restart", () => {
  const now = Date.parse("2026-10-05T05:00:00Z");
  const death = { x: 104, y: 62, z: 2, at: Date.parse("2026-10-05T04:58:52Z") };
  const near = { x: 101, y: 76, z: 10, at: now - 60_000 };
  const far = { x: 20, y: 90, z: 20, at: now - 120_000 };
  assert.deepEqual(pickSighting([near, far], { x: 65, z: 51 }, 192, [death], now), far);
});

test("a sighting far below home (a cave or a lake floor) is not walked to", () => {
  // 23:16: a sighting at y=44 under the west lake (surface 62) led the bot
  // into the water among drowned.
  const now = Date.now();
  const deep = { x: -45, y: 44, z: 58, at: now - 1_000 };
  const field = { x: 90, y: 95, z: 60, at: now - 5_000 };
  assert.deepEqual(pickSighting([deep, field], { x: 65, y: 96, z: 51 }, 192, [], now), field);
  assert.deepEqual(pickSighting([deep], { x: 65, z: 51 }, 192, [], now), deep, "no home height, no filter");
});

test("with the farm growing and the bot fed, hunts stay near home", () => {
  // Deaths 74 and 75 were hunts 100 blocks out with 69 wheat just planted.
  assert.equal(isFarmFed(69, 20), true);
  assert.equal(isFarmFed(69, 9), false, "hungry: hunt as far as it takes");
  assert.equal(isFarmFed(5, 20), false, "a farm that is barely started does not feed the bot");
});

test("forage leaves the farm's wheat to the farm pass", async () => {
  // 00:26:46: forage went for five ripe farm cells with the collectblock
  // planner and stalled 4 minutes until its 240 s timeout.
  const { GatherFoodRunner } = await import("./gather-food.js");
  const { Vec3 } = await import("vec3");
  const wheat = { name: "wheat", position: new Vec3(3, 64, 0), getProperties: () => ({ age: 7 }) };
  let collected = 0;
  const bot = Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(0, 64, 0) },
    entities: {},
    inventory: { items: () => [] },
    findBlocks: () => [wheat.position],
    blockAt: () => wheat,
    collectBlock: { collect: async () => { collected += 1; } },
  }) as unknown as Bot;
  const runner = new GatherFoodRunner({ bot, state: { home: null, worldId: null }, config: {}, bus: { emit() {} }, storage: {}, skills: {}, logger: { info() {}, warn() {}, debug() {} } } as unknown as ConstructorParameters<typeof GatherFoodRunner>[0]);
  (runner as unknown as { farmTended: boolean }).farmTended = true;
  const { withWorldActionLease } = await import("../agent/world-actions.js");
  const foraged = await withWorldActionLease({ owner: "forage-test", signal: new AbortController().signal, acknowledged: Promise.resolve() }, () =>
    (runner as unknown as { forageNear: (radius: number) => Promise<{ blocks: number }> }).forageNear(48));
  assert.equal(foraged.blocks, 0);
  assert.equal(collected, 0, "no collect of farm wheat");
});
