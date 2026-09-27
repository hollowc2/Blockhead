import assert from "node:assert/strict";
import { test } from "node:test";
import type { Block } from "prismarine-block";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { WorldActionExecutor } from "../agent/world-actions.js";
import { createFrozenTerrainPlan } from "./schema.js";
import { classifyObservedBlock } from "./classification.js";
import { TerrainMutationService } from "./mutation.js";
import { runClearAreaSlice, runFlattenAreaSlice } from "../skills/terrain-project.js";

type Point = { x: number; y: number; z: number };

function block(name: string, position: Point): Block {
  return {
    name,
    position,
    boundingBox: name === "air" ? "empty" : "block",
    diggable: true,
    canHarvest: () => true,
  } as unknown as Block;
}

function signals() {
  return { signal: new AbortController().signal, cancelled: false, checkpoint: () => true };
}

test("release-gate classification never treats an unknown cell as empty", () => {
  assert.equal(classifyObservedBlock(null), "unobserved");
  assert.equal(classifyObservedBlock(block("water", { x: 0, y: 0, z: 0 })), "fluid");
  assert.equal(classifyObservedBlock(block("minecraft:gravel", { x: 0, y: 0, z: 0 })), "falling");
  assert.equal(classifyObservedBlock(block("minecraft:barrel", { x: 0, y: 0, z: 0 })), "protectedFixture");
  assert.equal(classifyObservedBlock(block("minecraft:bedrock", { x: 0, y: 0, z: 0 })), "unbreakable");
});

test("clear leaves existing holes and blocks outside the frozen prism untouched", async () => {
  const plan = createFrozenTerrainPlan({
    world: "world", dimension: "overworld", anchor: { x: 0, y: 64, z: 0, dimension: "overworld" },
    bounds: { minX: 0, maxX: 1, minY: 64, maxY: 64, minZ: 0, maxZ: 0 },
    specification: { kind: "clear", anchor: "owner", width: 2, length: 1, height: 1 },
  });
  const dug = new Set<string>();
  const bot = {
    entity: { position: { x: -1, y: 65, z: 0 } }, players: {},
    blockAt: (point: Point) => {
      if (point.y === 63) return block("stone", point);
      if (point.x === 0 && point.y === 64) return block("air", point);
      if (point.x === 1 && point.y === 64) return dug.has("1,64,0") ? block("air", point) : block("leaves", point);
      if (point.x === 2 && point.y === 64) return block("oak_log", point);
      return block("air", point);
    },
    dig: async (target: Block) => { dug.add(`${target.position.x},${target.position.y},${target.position.z}`); },
    heldItem: { type: 1, maxDurability: 0, durabilityUsed: 0 },
  } as unknown as Bot;
  const mutation = new TerrainMutationService(bot, { toolProvisioner: { equipForBlock: async () => undefined, hasDurabilityReserve: () => true }, pollAttempts: 1, settleAttempts: 1 });
  const result = await new WorldActionExecutor().run("stage10-clear", new AbortController().signal, async () =>
    runClearAreaSlice(bot, plan, { signals: signals(), mutation }));
  assert.equal(result.status, "completed");
  assert.deepEqual([...dug], ["1,64,0"]);
  assert.equal(bot.blockAt(new Vec3(2, 64, 0))?.name, "oak_log");
});

test("flatten blocks an excessive cut before any mutation", async () => {
  const plan = createFrozenTerrainPlan({
    world: "world", dimension: "overworld", anchor: { x: 0, y: 64, z: 0, dimension: "overworld" },
    bounds: { minX: 0, maxX: 0, minY: 0, maxY: 20, minZ: 0, maxZ: 0 },
    specification: { kind: "flatten", anchor: "owner", width: 1, length: 1 },
  });
  let digCalls = 0;
  const bot = {
    entity: { position: { x: -1, y: 21, z: 0 } }, players: {},
    blockAt: (point: Point) => block("stone", point),
    dig: async () => { digCalls += 1; },
  } as unknown as Bot;
  const result = await new WorldActionExecutor().run("stage10-flatten-limit", new AbortController().signal, async () =>
    runFlattenAreaSlice(bot, plan, { signals: signals(), walkingY: 0 }));
  assert.equal(result.errorCode, "UNSAFE_GEOMETRY");
  assert.equal(digCalls, 0);
});
