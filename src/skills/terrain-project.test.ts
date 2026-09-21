import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bot } from "mineflayer";
import type { Block } from "prismarine-block";
import { WorldActionExecutor } from "../agent/world-actions.js";
import type { TaskSignals } from "../agent/scheduler.js";
import { createFrozenTerrainPlan } from "../terrain/schema.js";
import { TerrainMutationService } from "../terrain/mutation.js";
import { runExcavationSlice } from "./terrain-project.js";

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
