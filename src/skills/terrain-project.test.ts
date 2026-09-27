import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bot } from "mineflayer";
import type { Block } from "prismarine-block";
import { Vec3 } from "vec3";
import { WorldActionExecutor } from "../agent/world-actions.js";
import type { TaskSignals } from "../agent/scheduler.js";
import { createFrozenTerrainPlan } from "../terrain/schema.js";
import { TerrainMutationService } from "../terrain/mutation.js";
import { findSafeWorkPose, mineshaftExitRoute, reachToBlock, runClearAreaSlice, runExcavationSlice, runFlattenAreaSlice, runMineshaftSlice } from "./terrain-project.js";

type Point = { x: number; y: number; z: number };
function block(name: string, position: Point): Block {
  return { name, position, boundingBox: name === "air" ? "empty" : "block", diggable: true, canHarvest: () => true } as unknown as Block;
}
function signals(): TaskSignals {
  return { signal: new AbortController().signal, cancelled: false, checkpoint: () => true };
}

test("excavation is deterministic, resumable, and verifies observed postconditions", async () => {
  const plan = createFrozenTerrainPlan({
    world: "world", dimension: "overworld", anchor: { x: 0, y: 64, z: 0, dimension: "overworld" },
    bounds: { minX: 0, maxX: 1, minY: 63, maxY: 63, minZ: 0, maxZ: 1 },
    specification: { kind: "excavate", anchor: "owner", width: 2, length: 2, depth: 1 },
  });
  const dug = new Set<string>();
  const bot = {
    entity: { position: { x: -1, y: 64, z: 0 } },
    players: {},
    blockAt: (point: Point) => {
      if (point.y === 63 && point.x >= 0 && point.x <= 1 && point.z >= 0 && point.z <= 1) return dug.has(`${point.x},${point.y},${point.z}`) ? block("air", point) : block("stone", point);
      if (point.y === 63) return block("stone", point);
      return block("air", point);
    },
    dig: async (target: Block) => { dug.add(`${target.position.x},${target.position.y},${target.position.z}`); },
    heldItem: { type: 1, maxDurability: 0, durabilityUsed: 0 },
  } as unknown as Bot;
  const mutation = new TerrainMutationService(bot, { toolProvisioner: { equipForBlock: async () => undefined, hasDurabilityReserve: () => true }, pollAttempts: 1, settleAttempts: 1 });
  const result = await new WorldActionExecutor().run("terrain-slice", new AbortController().signal, async () => runExcavationSlice(bot, plan, { signals: signals(), mutation, maxBlocksPerSlice: 2 }));
  assert.equal(result.status, "partial", `${result.errorCode ?? ""} ${result.message ?? ""}`);
  assert.equal(result.data?.nextIndex, 2);
  assert.equal(result.data?.removed, 2);
  const resumed = await new WorldActionExecutor().run("terrain-slice-resume", new AbortController().signal, async () => runExcavationSlice(bot, plan, { signals: signals(), mutation, maxBlocksPerSlice: 8, resumeState: result.data }));
  assert.equal(resumed.status, "completed");
  assert.equal(resumed.data?.verified, 4);
  assert.equal(dug.size, 4);
});

test("narrow excavation refuses unsafe access geometry before mutation", async () => {
  const plan = createFrozenTerrainPlan({
    world: "world", dimension: "overworld", anchor: { x: 0, y: 64, z: 0, dimension: "overworld" },
    bounds: { minX: 0, maxX: 0, minY: 63, maxY: 63, minZ: 0, maxZ: 0 },
    specification: { kind: "excavate", anchor: "owner", width: 1, length: 1, depth: 1 },
  });
  const bot = { players: {}, blockAt: (point: Point) => block("stone", point) } as unknown as Bot;
  const result = await new WorldActionExecutor().run("terrain-narrow", new AbortController().signal, async () => runExcavationSlice(bot, plan, { signals: signals() }));
  assert.equal(result.errorCode, "UNSAFE_GEOMETRY");
});

test("clear removes only the requested prism and preserves the ground", async () => {
  const plan = createFrozenTerrainPlan({
    world: "world", dimension: "overworld", anchor: { x: 0, y: 64, z: 0, dimension: "overworld" },
    bounds: { minX: 0, maxX: 1, minY: 64, maxY: 64, minZ: 0, maxZ: 0 },
    specification: { kind: "clear", anchor: "owner", width: 2, length: 1, height: 1 },
  });
  const dug = new Set<string>();
  const bot = {
    entity: { position: { x: -1, y: 65, z: 0 } }, players: {},
    blockAt: (point: Point) => point.y === 63 ? block("stone", point) : point.y === 64 ? (dug.has(`${point.x},${point.y},${point.z}`) ? block("air", point) : block("leaves", point)) : block("air", point),
    dig: async (target: Block) => { dug.add(`${target.position.x},${target.position.y},${target.position.z}`); },
    heldItem: { type: 1, maxDurability: 0, durabilityUsed: 0 },
  } as unknown as Bot;
  const mutation = new TerrainMutationService(bot, { toolProvisioner: { equipForBlock: async () => undefined, hasDurabilityReserve: () => true }, pollAttempts: 1, settleAttempts: 1 });
  const result = await new WorldActionExecutor().run("terrain-clear", new AbortController().signal, async () => runClearAreaSlice(bot, plan, { signals: signals(), mutation }));
  assert.equal(result.status, "completed");
  assert.deepEqual([...dug].sort(), ["0,64,0", "1,64,0"]);
  assert.equal(bot.blockAt(new Vec3(0, 63, 0))?.name, "stone");
});

test("clear accepts supported gravel on the preserved ground layer", async () => {
  const plan = createFrozenTerrainPlan({
    world: "world", dimension: "overworld", anchor: { x: 0, y: 64, z: 0, dimension: "overworld" },
    bounds: { minX: 0, maxX: 0, minY: 64, maxY: 67, minZ: 0, maxZ: 0 },
    specification: { kind: "clear", anchor: "owner_front", width: 1, length: 1, height: 4 },
  });
  const bot = {
    entity: { position: { x: -2, y: 64, z: 0 } }, players: {},
    blockAt: (point: Point) => point.y === 61 ? block("stone", point) : point.y === 62 || point.y === 63 ? block("gravel", point) : block("air", point),
    heldItem: { type: 1, maxDurability: 0, durabilityUsed: 0 },
  } as unknown as Bot;
  const result = await new WorldActionExecutor().run("terrain-gravel-ground", new AbortController().signal, async () => runClearAreaSlice(bot, plan, { signals: signals() }));
  assert.equal(result.status, "completed", `${result.errorCode ?? ""} ${result.message ?? ""}`);
  assert.equal(bot.blockAt(new Vec3(0, 63, 0))?.name, "gravel");
});

test("a tall clear target can be reached safely from the walking plane", async () => {
  const bot = {
    entity: { position: { x: -2, y: 64, z: 0 } },
    blockAt: (point: Point) => point.y === 63 ? block("stone", point) : block("air", point),
  } as unknown as Bot;
  const result = await findSafeWorkPose(
    bot,
    { x: 0, y: 67, z: 0 },
    { minX: 0, maxX: 4, minY: 64, maxY: 67, minZ: 0, maxZ: 4 },
    new AbortController().signal,
  );
  assert.equal(result.status, "completed", `${result.errorCode ?? ""} ${result.message ?? ""}`);
  assert.equal(result.data?.position.y, 64);
});

test("flatten cuts high terrain to an exact walking plane", async () => {
  const plan = createFrozenTerrainPlan({
    world: "world", dimension: "overworld", anchor: { x: 0, y: 64, z: 0, dimension: "overworld" },
    bounds: { minX: 0, maxX: 1, minY: 62, maxY: 64, minZ: 0, maxZ: 0 },
    specification: { kind: "flatten", anchor: "owner", width: 2, length: 1 },
  });
  const dug = new Set<string>();
  const bot = {
    entity: { position: { x: -1, y: 65, z: 0 } }, players: {},
    blockAt: (point: Point) => {
      if (point.y === 61 || point.y === 62) return block("stone", point);
      if (point.y === 63) return block("air", point);
      if (point.y === 64) return dug.has(`${point.x},${point.y},${point.z}`) ? block("air", point) : block("dirt", point);
      return block("air", point);
    },
    dig: async (target: Block) => { dug.add(`${target.position.x},${target.position.y},${target.position.z}`); },
    heldItem: { type: 1, maxDurability: 0, durabilityUsed: 0 },
  } as unknown as Bot;
  const mutation = new TerrainMutationService(bot, { toolProvisioner: { equipForBlock: async () => undefined, hasDurabilityReserve: () => true }, pollAttempts: 1, settleAttempts: 1 });
  const result = await new WorldActionExecutor().run("terrain-flatten", new AbortController().signal, async () => runFlattenAreaSlice(bot, plan, { signals: signals(), mutation, walkingY: 63 }));
  assert.equal(result.status, "completed", `${result.errorCode ?? ""} ${result.message ?? ""}`);
  assert.deepEqual([...dug].sort(), ["0,64,0", "1,64,0"]);
});

test("flatten rejects fluids before any mutation", async () => {
  const plan = createFrozenTerrainPlan({
    world: "world", dimension: "overworld", anchor: { x: 0, y: 64, z: 0, dimension: "overworld" },
    bounds: { minX: 0, maxX: 0, minY: 62, maxY: 63, minZ: 0, maxZ: 0 },
    specification: { kind: "flatten", anchor: "owner", width: 1, length: 1 },
  });
  let digCalls = 0;
  const bot = { players: {}, blockAt: (point: Point) => point.y === 62 ? block("lava", point) : block("air", point), dig: async () => { digCalls += 1; } } as unknown as Bot;
  const result = await new WorldActionExecutor().run("terrain-flatten-lava", new AbortController().signal, async () => runFlattenAreaSlice(bot, plan, { signals: signals() }));
  assert.equal(result.errorCode, "LAVA_HAZARD");
  assert.equal(digCalls, 0);
});

test("mineshaft descends by verified segments and resumes from a safe waypoint", async () => {
  const plan = createFrozenTerrainPlan({
    world: "world", dimension: "overworld", anchor: { x: 0, y: 64, z: 0, dimension: "overworld" },
    bounds: { minX: 0, maxX: 0, minY: 62, maxY: 66, minZ: 0, maxZ: 1 },
    specification: { kind: "mineshaft", anchor: "owner_front", width: 1, height: 2, depth: 1, direction: "south" },
  });
  const dug = new Set<string>();
  const corridor = (point: Point): boolean => (point.z === 0 && (point.y === 65 || point.y === 66)) || (point.z === 1 && (point.y === 64 || point.y === 65));
  const bot = {
    entity: { position: { x: 0, y: 64, z: 0 } }, players: {},
    blockAt: (point: Point) => {
      if (corridor(point)) return dug.has(`${point.x},${point.y},${point.z}`) ? block("air", point) : block("stone", point);
      if ((point.z === -1 && point.y === 64) || (point.z === 0 && point.y === 64) || (point.z === 1 && point.y === 63)) return block("stone", point);
      if (point.x === -1 || point.x === 1) return block("stone", point);
      return block("air", point);
    },
    dig: async (target: Block) => { dug.add(`${target.position.x},${target.position.y},${target.position.z}`); },
    heldItem: { type: 1, maxDurability: 0, durabilityUsed: 0 },
  } as unknown as Bot;
  const mutation = new TerrainMutationService(bot, { toolProvisioner: { equipForBlock: async () => undefined, hasDurabilityReserve: () => true }, pollAttempts: 1, settleAttempts: 1 });
  const first = await new WorldActionExecutor().run("mineshaft-1", new AbortController().signal, async () => runMineshaftSlice(bot, plan, { signals: signals(), mutation, maxBlocksPerSlice: 1 }));
  assert.equal(first.status, "partial", `${first.errorCode ?? ""} ${first.message ?? ""}`);
  assert.equal(first.data?.lastVerifiedSegment, 0);
  const resumed = await new WorldActionExecutor().run("mineshaft-2", new AbortController().signal, async () => runMineshaftSlice(bot, plan, { signals: signals(), mutation, maxBlocksPerSlice: 2, resumeState: first.data }));
  assert.equal(resumed.status, "completed", `${resumed.errorCode ?? ""} ${resumed.message ?? ""}`);
  assert.equal(resumed.data?.lastSafeWaypoint.z, 1);
  assert.equal(dug.size, 4);
});

test("the exit route from deep in a mineshaft climbs its own steps to the entrance", () => {
  const plan = createFrozenTerrainPlan({
    world: "world", dimension: "overworld", anchor: { x: 0, y: 70, z: 0, dimension: "overworld" },
    bounds: { minX: -21, maxX: 0, minY: 48, maxY: 72, minZ: 0, maxZ: 0 },
    specification: { kind: "mineshaft", anchor: "owner_front", width: 1, height: 2, targetY: 50, direction: "west" },
  });
  // Standing on segment 20: feet at y = 70 - 20 + 1 = 51, x = -20.
  const route = mineshaftExitRoute(plan, { x: -19.5, y: 51, z: 0.5 });
  assert.deepEqual(route, [
    { x: -14, y: 57, z: 0 }, { x: -8, y: 63, z: 0 }, { x: -2, y: 69, z: 0 }, { x: 0, y: 71, z: 0 },
  ]);
  assert.equal(mineshaftExitRoute(plan, { x: 40, y: 51, z: 0 }), null, "not in the shaft");
});

test("reach is measured to a block's nearest face, so canopy is reachable from the ground", () => {
  // Standing beside a birch on y=71 ground: the y=77 leaf's underside is in reach.
  const eye = { x: -65.5, y: 71 + 1.62, z: 323.5 };
  assert.ok(reachToBlock(eye, { x: -67, y: 77, z: 323 }) <= 4.5);
  assert.ok(reachToBlock(eye, { x: -67, y: 79, z: 323 }) > 4.5);
  assert.equal(reachToBlock({ x: 0.5, y: 0.5, z: 0.5 }, { x: 0, y: 0, z: 0 }), 0);
});
