import assert from "node:assert/strict";
import { test } from "node:test";
import { Vec3 } from "vec3";
import { withWorldActionLease } from "../agent/world-actions.js";
import { collectBlocks, dominantNearbyLog, findBlocksNearRefined, hasAirNeighbor, isReachableFromGround, isTrunkBase } from "./world.js";

test("refined block search applies exposure before the candidate cap", () => {
  let options: Record<string, unknown> | undefined;
  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    findBlocks: (value: Record<string, unknown>) => {
      options = value;
      return [new Vec3(40, 63, 0)];
    },
  } as any;

  const result = findBlocksNearRefined(bot, () => true, (position) => position.x === 40, 32, 64);
  assert.deepEqual(result, [new Vec3(40, 63, 0)]);
  assert.equal(options?.count, 64);
  assert.equal(options?.maxDistance, 32);
  assert.equal(typeof options?.useExtraInfo, "function");
  const refine = options?.useExtraInfo as (block: { position: Vec3 }) => boolean;
  assert.equal(refine({ position: new Vec3(1, 63, 0) }), false);
  assert.equal(refine({ position: new Vec3(40, 63, 0) }), true);
});

test("successful cobblestone collection stops at the requested inventory target", async () => {
  let cobblestone = 0;
  const collected: Vec3[] = [];
  const bot = {
    game: { dimension: "overworld" },
    collectBlock: {
      collect: async (block: { position: Vec3 }) => {
        collected.push(block.position);
        cobblestone += 1;
      },
      cancelTask: async () => undefined,
    },
  } as any;
  const blocks = [1, 2, 3].map((x) => ({ position: new Vec3(x, 63, 0) })) as any[];
  const signal = new AbortController().signal;

  const gained = await withWorldActionLease(
    { owner: "test:stone-success", signal, acknowledged: Promise.resolve() },
    () => collectBlocks(bot, blocks, () => cobblestone, 2, () => undefined, 1_000, undefined, signal),
  );

  assert.equal(gained, 2);
  assert.equal(cobblestone, 2);
  assert.deepEqual(collected, [new Vec3(1, 63, 0), new Vec3(2, 63, 0)]);
});

/** A flat grass world at y=64 (feet y=65) with extra blocks layered on. */
function flatWorld(extra: Record<string, string>) {
  const blockAt = (p: Vec3) => {
    const key = `${p.x},${p.y},${p.z}`;
    const name = extra[key] ?? (p.y <= 64 ? "grass_block" : "air");
    return { name, position: p, boundingBox: name === "air" ? "empty" : "block" };
  };
  return { blockAt } as never;
}

test("a trunk log at head height is reachable from the ground", () => {
  assert.equal(isReachableFromGround(flatWorld({ "0,65,0": "acacia_log", "0,66,0": "acacia_log" }), new Vec3(0, 66, 0)), true);
});

test("a canopy log 6 above the ground, over leaves, is not", () => {
  const canopy: Record<string, string> = { "0,70,0": "acacia_log" };
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) if (dx || dz) canopy[`${dx},69,${dz}`] = "acacia_leaves";
  assert.equal(isReachableFromGround(flatWorld(canopy), new Vec3(0, 70, 0)), false);
});

test("trunk logs over soil qualify; a canopy log floating over leaves does not", () => {
  const extra: Record<string, string> = { "5,65,0": "acacia_log", "5,66,0": "acacia_log", "5,67,0": "acacia_log", "0,71,0": "acacia_log" };
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) if (dx || dz) extra[`${dx},70,${dz}`] = "acacia_leaves";
  // A stump cut out from under a log: the log floats one block over grass.
  extra["9,66,0"] = "acacia_log";
  const w = flatWorld(extra);
  assert.equal(isTrunkBase(w, new Vec3(5, 65, 0)), true, "base on grass");
  assert.equal(isTrunkBase(w, new Vec3(5, 67, 0)), true, "two logs up the trunk");
  assert.equal(isTrunkBase(w, new Vec3(9, 66, 0)), true, "over a felled stump");
  assert.equal(isTrunkBase(w, new Vec3(0, 71, 0)), false, "canopy");
});

test("ore beside cave air counts as exposed", () => {
  // Coal in a cave wall borders cave_air: an air-only check saw none of it.
  const cells = new Map<string, string>([["0,11,0", "cave_air"]]);
  const blockAt = (p: Vec3) => ({ name: cells.get(`${p.x},${p.y},${p.z}`) ?? "stone", position: p });
  const bot = { blockAt } as unknown as Parameters<typeof hasAirNeighbor>[0];
  assert.equal(hasAirNeighbor(bot, new Vec3(0, 10, 0)), true);
  assert.equal(hasAirNeighbor(bot, new Vec3(0, 5, 0)), false);
});

test("the state-id exposure check treats cave air as open and unloaded chunks as closed", () => {
  const AIR = 0;
  const CAVE_AIR = 12000;
  const STONE = 1;
  const states = new Map<string, number>([["0,11,0", CAVE_AIR]]);
  const bot = {
    registry: { blocksByName: { air: { minStateId: AIR }, cave_air: { minStateId: CAVE_AIR }, void_air: { minStateId: 12001 } } },
    world: {
      getColumnAt: (p: Vec3) => (p.x < 16 ? {} : null),
      // An unloaded column reads as state 0 (air) in prismarine-world.
      getBlockStateId: (p: Vec3) => (p.x >= 16 ? AIR : states.get(`${p.x},${p.y},${p.z}`) ?? STONE),
    },
  } as unknown as Parameters<typeof hasAirNeighbor>[0];
  assert.equal(hasAirNeighbor(bot, new Vec3(0, 10, 0)), true);
  assert.equal(hasAirNeighbor(bot, new Vec3(15, 10, 0)), false, "the neighbor across the edge is unloaded, not air");
});

test("the dominant nearby log counts standing trees, not building frames or floating cut trunks", () => {
  // 2026-10-06 02:43, 05:05: building frames made oak "dominant"; 08:04 and
  // 08:20: the upper halves of oaks cut at crop height over the fields did.
  // Each time the wood restore found no oak trunk to cut and crossed a lake.
  const blocks = new Map<string, string>();
  for (let x = -10; x <= 40; x++) for (let z = -10; z <= 20; z++) blocks.set(`${x},63,${z}`, "grass_block");
  // Six oak frame columns in plank walls.
  for (let i = 0; i < 6; i++) for (let y = 64; y < 68; y++) { blocks.set(`${i * 3},${y},0`, "oak_log"); blocks.set(`${i * 3 + 1},${y},0`, "oak_planks"); }
  // Four floating oak halves with leaves, cut below at crop height.
  for (const x of [2, 6, 10, 14]) { for (let y = 67; y < 71; y++) blocks.set(`${x},${y},8`, "oak_log"); blocks.set(`${x},71,8`, "oak_leaves"); }
  // Two standing birch trees.
  for (const x of [20, 25]) { for (let y = 64; y < 69; y++) blocks.set(`${x},${y},10`, "birch_log"); blocks.set(`${x},69,10`, "birch_leaves"); }
  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    findBlocks: () => [...blocks].filter(([, name]) => name.endsWith("_log")).map(([key]) => new Vec3(...(key.split(",").map(Number) as [number, number, number]))),
    blockAt: (pos: Vec3) => { const name = blocks.get(`${pos.x},${pos.y},${pos.z}`) ?? "air"; return { name, position: pos, boundingBox: name === "air" || name.endsWith("_leaves") ? "empty" : "block" }; },
  } as unknown as Parameters<typeof dominantNearbyLog>[0];
  assert.equal(dominantNearbyLog(bot), "birch_log");
});
