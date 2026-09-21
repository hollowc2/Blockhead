import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bot } from "mineflayer";
import type { Block } from "prismarine-block";
import { Vec3 } from "vec3";
import { WorldActionExecutor } from "../agent/world-actions.js";
import type { TaskSignals } from "../agent/scheduler.js";
import { createFrozenTerrainPlan } from "../terrain/schema.js";
import { TerrainMutationService } from "../terrain/mutation.js";
import { runClearAreaSlice, runExcavationSlice, runFlattenAreaSlice } from "./terrain-project.js";

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
