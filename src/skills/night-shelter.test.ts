import assert from "node:assert/strict";
import { test } from "node:test";
import { ownerWorkPending, shelterDecision, type ShelterDecisionInput } from "../agent/night-shelter.js";
import { findShelterSpot, isSealedPocket, isShelterNight, shelterDigCells, shelterPocketFeet, validShelterSpot, type CellLookup } from "./night-shelter.js";

/** Flat world: grass at y=63 over dirt (60-62) over stone; air above. */
function flatWorld(overrides: Record<string, string> = {}): CellLookup {
  return (x, y, z) => {
    const key = `${x},${y},${z}`;
    if (key in overrides) return overrides[key]!;
    if (y >= 64) return "air";
    if (y === 63) return "grass_block";
    if (y >= 60) return "dirt";
    return "stone";
  };
}

const night: ShelterDecisionInput = {
  timeOfDay: 14_000,
  dimension: "minecraft:overworld",
  isSleeping: false,
  inWater: false,
  bedAvailable: false,
  ownerWorkPending: false,
  shelterLive: false,
  cooldownActive: false,
};

test("shelter triggers at dusk with no bed, and not by day", () => {
  assert.equal(shelterDecision(night).shelter, true);
  assert.equal(shelterDecision({ ...night, timeOfDay: 12_600 }).shelter, true);
  assert.equal(shelterDecision({ ...night, timeOfDay: 6_000 }).shelter, false);
  assert.equal(shelterDecision({ ...night, timeOfDay: 0 }).shelter, false);
  assert.equal(isShelterNight(23_999), true);
});

test("shelter stands down for a bed, sleep, water, owner work, a live task, and the cooldown", () => {
  assert.equal(shelterDecision({ ...night, bedAvailable: true }).shelter, false);
  assert.equal(shelterDecision({ ...night, isSleeping: true }).shelter, false);
  assert.equal(shelterDecision({ ...night, inWater: true }).shelter, false);
  assert.equal(shelterDecision({ ...night, ownerWorkPending: true }).shelter, false);
  assert.equal(shelterDecision({ ...night, shelterLive: true }).shelter, false);
  assert.equal(shelterDecision({ ...night, cooldownActive: true }).shelter, false);
  assert.equal(shelterDecision({ ...night, dimension: "minecraft:the_nether" }).shelter, false);
});

test("owner work pending counts active and queued user tasks only", () => {
  const task = (source: string) => ({ source }) as never;
  assert.equal(ownerWorkPending({ active: null, queued: [] } as never), false);
  assert.equal(ownerWorkPending({ active: task("user"), queued: [] } as never), true);
  assert.equal(ownerWorkPending({ active: task("maintenance"), queued: [task("user")] } as never), true);
  assert.equal(ownerWorkPending({ active: task("background"), queued: [task("maintenance")] } as never), false);
});

test("a flat dirt field gives a spot right under the bot, soil only, without a pickaxe", () => {
  const spot = findShelterSpot(flatWorld(), { x: 0, y: 64, z: 0 }, false);
  assert.notEqual(spot, null);
  assert.deepEqual(spot!.shaft, { x: 0, y: 64, z: 0 });
  const { shaft, pocket } = shelterDigCells(spot!);
  assert.deepEqual(shaft.map((c) => c.y), [63, 62, 61, 60]);
  assert.deepEqual(pocket.map((c) => c.y), [60, 61]);
  // Pocket feet 4 below the surface feet level: mobs on top stay > 3 blocks up.
  assert.equal(shelterPocketFeet(spot!).y, 60);
});

test("stone needs a pickaxe", () => {
  // Thin soil: stone from y=62 down.
  const rocky: CellLookup = (x, y, z) => (y >= 64 ? "air" : y === 63 ? "grass_block" : "stone");
  assert.equal(findShelterSpot(rocky, { x: 0, y: 64, z: 0 }, false), null);
  assert.notEqual(findShelterSpot(rocky, { x: 0, y: 64, z: 0 }, true), null);
});

test("water next to any dug cell rejects the spot, and the search moves on", () => {
  const spot = { shaft: { x: 0, y: 64, z: 0 }, dir: { dx: 1, dz: 0 } };
  const wet = flatWorld({ "-1,61,0": "water" });
  assert.equal(validShelterSpot(wet, spot, false), false);
  const found = findShelterSpot(wet, { x: 0, y: 64, z: 0 }, false);
  assert.notEqual(found, null);
  assert.notDeepEqual(found!.shaft, { x: 0, y: 64, z: 0 });
});

test("falling or missing roof blocks reject the spot", () => {
  const spot = { shaft: { x: 0, y: 64, z: 0 }, dir: { dx: 1, dz: 0 } };
  assert.equal(validShelterSpot(flatWorld(), spot, false), true);
  assert.equal(validShelterSpot(flatWorld({ "1,62,0": "gravel" }), spot, false), false);
  assert.equal(validShelterSpot(flatWorld({ "1,63,0": "air" }), spot, false), false);
  // Unloaded chunk next to the pocket: refuse rather than guess.
  assert.equal(validShelterSpot((x, y, z) => (x === 2 ? null : flatWorld()(x, y, z)), spot, false), false);
});

test("the surface cell must be standable", () => {
  const spot = { shaft: { x: 0, y: 64, z: 0 }, dir: { dx: 1, dz: 0 } };
  assert.equal(validShelterSpot(flatWorld({ "0,64,0": "short_grass" }), spot, false), true);
  assert.equal(validShelterSpot(flatWorld({ "0,65,0": "oak_log" }), spot, false), false);
});

test("a sealed pocket is recognized, an open shaft is not", () => {
  const spot = { shaft: { x: 0, y: 64, z: 0 }, dir: { dx: 1, dz: 0 } };
  const { shaft, pocket } = shelterDigCells(spot);
  const dug: Record<string, string> = {};
  for (const c of [...shaft, ...pocket]) dug[`${c.x},${c.y},${c.z}`] = "air";
  const feet = shelterPocketFeet(spot);
  assert.equal(isSealedPocket(flatWorld(dug), feet), false);
  // Refill the two shaft cells beside the pocket.
  assert.equal(isSealedPocket(flatWorld({ ...dug, "0,60,0": "dirt", "0,61,0": "dirt" }), feet), true);
});
