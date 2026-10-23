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
    blockAt: (position: Vec3) => ({ name: "cobblestone", position }),
    collectBlock: {
      collect: async (block: { position: Vec3 }) => {
        collected.push(block.position);
        cobblestone += 1;
      },
      cancelTask: async () => undefined,
    },
  } as any;
  const blocks = [1, 2, 3].map((x) => ({ name: "cobblestone", position: new Vec3(x, 63, 0) })) as any[];
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
  // Bare oak log pillars on the ground (an unfinished build, no planks yet).
  for (const x of [30, 32, 34, 36]) for (let y = 64; y < 67; y++) blocks.set(`${x},${y},-6`, "oak_log");
  // Two standing birch trees.
  for (const x of [20, 25]) { for (let y = 64; y < 69; y++) blocks.set(`${x},${y},10`, "birch_log"); blocks.set(`${x},69,10`, "birch_leaves"); }
  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    findBlocks: () => [...blocks].filter(([, name]) => name.endsWith("_log")).map(([key]) => new Vec3(...(key.split(",").map(Number) as [number, number, number]))),
    blockAt: (pos: Vec3) => { const name = blocks.get(`${pos.x},${pos.y},${pos.z}`) ?? "air"; return { name, position: pos, boundingBox: name === "air" || name.endsWith("_leaves") ? "empty" : "block" }; },
  } as unknown as Parameters<typeof dominantNearbyLog>[0];
  assert.equal(dominantNearbyLog(bot), "birch_log");
});

test("a floating log four blocks above a supported stance is within actual digging reach", async () => {
  const { groundDigApproaches } = await import("./world.js");
  const target = new Vec3(0, 69, 0);
  const bot = flatWorld({ "0,69,0": "birch_log" });
  const poses = groundDigApproaches(bot, target);
  assert.ok(poses.length > 0);
  assert.ok(poses.every(p => p.y === 65 && p.offset(0, 1.62, 0).distanceTo(target.offset(0.5, 0.5, 0.5)) <= 4.3));
  assert.equal(isReachableFromGround(bot, target), true);
  assert.equal(isReachableFromGround(flatWorld({ "0,71,0": "birch_log" }), new Vec3(0,71,0)), false);
});

test("a high log already within eye reach is dug without requesting an unreachable block-height route", async () => {
  const position = new Vec3(0.5, 65, 0.5);
  const target = { position: new Vec3(1,69,0), name: "birch_log" };
  let digs = 0;
  const bot = {
    blockAt: (p: Vec3) => ({ position: p.floored(), name: p.equals(target.position) ? "birch_log" : p.y < 65 ? "dirt" : "air", boundingBox: p.y < 65 ? "block" : "empty" }),
    entity: { position }, entities: {}, game: { dimension: "overworld" },
    tool: { equipForBlock: async () => {} },
    dig: async () => { digs++; },
    pathfinder: { goto: async () => { assert.fail("a block within eye reach needs no path"); } },
  } as any;
  const signal = new AbortController().signal;
  await withWorldActionLease({ owner: "high-log", signal, acknowledged: Promise.resolve() }, () => collectBlocks(bot,[target as any],()=>0,Infinity,()=>{},1000,undefined,signal));
  assert.equal(digs,1);
});


test("fractional farmland stance uses actual body support and eye reach", async () => {
  const { diggingStanceBlocker } = await import("./world.js");
  const target = new Vec3(114,101,71);
  const bot = {
    entity: { position: new Vec3(112.5,96.9375,69.5483) },
    blockAt: (p: Vec3) => {
      const at = p.floored();
      return { position: at, name: at.y <= 96 ? "farmland" : "air", boundingBox: at.y <= 96 ? "block" : "empty", shapes: at.y <= 96 ? [[0,0,0,1,.9375,1]] : [] };
    },
    canSeeBlock: () => true,
  } as any;
  assert.equal(diggingStanceBlocker(bot,target),null);
  assert.equal(diggingStanceBlocker(bot,new Vec3(114,103,71)),"target outside actual eye reach");
  bot.canSeeBlock = () => false;
  assert.equal(diggingStanceBlocker(bot,target,true),"target has no clear access");
  const floor = bot.blockAt;
  bot.blockAt = (p: Vec3) => p.y < 97 ? { position: p.floored(), name: "lava", boundingBox: "empty" } : floor(p);
  assert.match(diggingStanceBlocker(bot,target)!,/unsafe/);
  bot.blockAt = (p: Vec3) => p.y >= 98 ? { position: p.floored(), name: "stone", boundingBox: "block" } : floor(p);
  assert.match(diggingStanceBlocker(bot,target)!,/obstructed/);
  bot.blockAt = (p: Vec3) => ({ position:p.floored(),name:"air",boundingBox:"empty" });
  assert.match(diggingStanceBlocker(bot,target)!,/support/);
});

test("a digging stance at a block edge counts the corner that holds the bot", async () => {
  // 2026-10-23: trunk approaches stopped near ledge edges and refused to dig.
  const { diggingStanceBlocker } = await import("./world.js");
  const ground = (top: (x: number) => boolean, name = "grass_block") => ({
    entity: { position: new Vec3(10.8,64,5.5) },
    blockAt: (p: Vec3) => {
      const at = p.floored();
      const solid = at.y === 63 && top(at.x);
      return { position: at, name: solid ? name : "air", boundingBox: solid ? "block" : "empty", shapes: solid ? [[0,0,0,1,1,1]] : [] };
    },
    canSeeBlock: () => true,
  } as any);
  assert.equal(diggingStanceBlocker(ground(x => x === 10), new Vec3(12,65,5)), null, "overhanging a drop is still standing");
  assert.match(diggingStanceBlocker(ground(x => x === 11, "oak_leaves"), new Vec3(12,65,5))!, /unsafe/, "a canopy corner is never footing");
  assert.match(diggingStanceBlocker(ground(() => false), new Vec3(12,65,5))!, /support/);
});

test("observed farmland cleanup digs from safe fractional pose without routing", async () => {
  let digs = 0;
  const bot = {
    entity: { position: new Vec3(112.5,96.9375,69.5483) }, entities:{}, game:{dimension:"overworld"},
    blockAt: (p:Vec3) => ({position:p.floored(),name:p.equals(new Vec3(114,101,71)) ? "birch_log" : p.y < 97 ? "farmland" : "air",boundingBox:p.y < 97 ? "block" : "empty",shapes:p.y < 97 ? [[0,0,0,1,.9375,1]] : []}),
    tool:{equipForBlock:async()=>{}},dig:async()=>{digs++;},
    pathfinder:{goto:async()=>assert.fail("already feasible action must not repeat an empty path")},
  } as any;
  const signal = new AbortController().signal;
  await withWorldActionLease({owner:"farmland-log",signal,acknowledged:Promise.resolve()},()=>collectBlocks(bot,[{name:"birch_log",position:new Vec3(114,101,71)} as any],()=>0,Infinity,()=>{},1000,undefined,signal));
  assert.equal(digs,1);
});


test("collection refuses a fixture or unloaded replacement observed after equipment yields", async () => {
  for (const replacement of ["chest", "torch", null]) {
    const at = new Vec3(1,64,0);
    let name: string | null = "dirt";
    let digs = 0;
    const errors: string[] = [];
    const bot = {
      entity:{position:new Vec3(.5,64,.5)},game:{dimension:"overworld"},entities:{},
      blockAt:()=>name === null ? null : {name,position:at,boundingBox:"block"},
      tool:{equipForBlock:async()=>{await Promise.resolve();name=replacement;}},
      dig:async()=>{digs++;},
    } as any;
    const signal = new AbortController().signal;
    await withWorldActionLease({owner:"changed-cut",signal,acknowledged:Promise.resolve()},()=>collectBlocks(bot,[{name:"dirt",position:at} as any],()=>0,Infinity,()=>{},1000,(_block,error)=>errors.push(String(error)),signal));
    assert.equal(digs,0);
    assert.match(errors[0]!,/collection target changed/);
    assert.match(errors[0]!,new RegExp(replacement ?? "unloaded"));
  }
});

test("collector plugin is not invoked for a stale natural target", async () => {
  let collections = 0;
  const signal = new AbortController().signal;
  const bot = {
    game:{dimension:"overworld"},
    blockAt:(position:Vec3)=>({position,name:"chest"}),
    collectBlock:{collect:async()=>{collections++;},cancelTask:async()=>{}},
  } as any;
  const errors:string[]=[];
  await withWorldActionLease({owner:"changed-plugin-target",signal,acknowledged:Promise.resolve()},()=>collectBlocks(bot,[{name:"dirt",position:new Vec3(1,64,0)} as any],()=>0,Infinity,()=>{},1000,(_block,error)=>errors.push(String(error)),signal));
  assert.equal(collections,0);
  assert.match(errors[0]!,/expected dirt, observed chest/);
});
