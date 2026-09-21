import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bot } from "mineflayer";
import type { Block } from "prismarine-block";
import { verifyClearArea, verifyExcavationVolume, verifyFlattenArea, verifyMineshaft } from "./verification.js";
import { createFrozenTerrainPlan } from "./schema.js";

type Point = { x: number; y: number; z: number };
function block(name: string, position: Point): Block {
  return { name, position, boundingBox: name === "air" ? "empty" : "block", diggable: true } as unknown as Block;
}
function botAt(read: (point: Point) => Block | null): Bot {
  return { blockAt: read } as unknown as Bot;
}

test("verifyExcavationVolume requires every cell to be observed and passable", () => {
  const bounds = { minX: 0, maxX: 1, minY: 60, maxY: 60, minZ: 0, maxZ: 1 };
  const result = verifyExcavationVolume(botAt((point) => point.x === 1 && point.z === 1 ? block("stone", point) : block("air", point)), bounds);
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "UNBREAKABLE_BLOCK");
  assert.equal(result.data?.inspected, 4);
  assert.equal(result.data?.verified, 3);
});
test("verifyExcavationVolume classifies null and fluids as terminal mismatches", () => {
  const bounds = { minX: 0, maxX: 0, minY: 60, maxY: 61, minZ: 0, maxZ: 0 };
  const nullResult = verifyExcavationVolume(botAt((point) => point.y === 60 ? null : block("air", point)), bounds);
  assert.equal(nullResult.errorCode, "WORLD_NOT_OBSERVED");
  const lavaResult = verifyExcavationVolume(botAt((point) => point.y === 60 ? block("lava", point) : block("air", point)), bounds);
  assert.equal(lavaResult.errorCode, "LAVA_HAZARD");
});

test("verifyClearArea requires every requested cell to be passable", () => {
  const bounds = { minX: 0, maxX: 1, minY: 64, maxY: 64, minZ: 0, maxZ: 0 };
  const result = verifyClearArea(botAt((point) => point.x === 1 ? block("stone", point) : block("air", point)), bounds);
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "UNBREAKABLE_BLOCK");
  assert.equal(result.data?.verified, 1);
});

test("verifyFlattenArea requires solid support and two blocks of headroom", () => {
  const bounds = { minX: 0, maxX: 0, minY: 62, maxY: 63, minZ: 0, maxZ: 0 };
  const result = verifyFlattenArea(botAt((point) => {
    if (point.y === 62) return block("stone", point);
    return block("air", point);
  }), bounds, 63);
  assert.equal(result.ok, true);
  assert.equal(result.data?.verified, 1);
  const blocked = verifyFlattenArea(botAt((point) => point.y === 62 ? block("water", point) : block("air", point)), bounds, 63);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.errorCode, "WATER_HAZARD");
});

test("verifyMineshaft requires a clear corridor and solid floors for both directions", () => {
  const plan = createFrozenTerrainPlan({
    world: "world", dimension: "overworld", anchor: { x: 0, y: 64, z: 0, dimension: "overworld" },
    bounds: { minX: 0, maxX: 0, minY: 62, maxY: 66, minZ: 0, maxZ: 1 },
    specification: { kind: "mineshaft", anchor: "owner_front", width: 1, height: 2, depth: 1, direction: "south" },
  });
  const bot = botAt((point) => {
    if ((point.z === 0 && (point.y === 65 || point.y === 66)) || (point.z === 1 && (point.y === 64 || point.y === 65))) return block("air", point);
    if ((point.z === 0 && point.y === 63) || (point.z === 1 && point.y === 62)) return block("stone", point);
    return block("stone", point);
  });
  const result = verifyMineshaft(bot, plan);
  assert.equal(result.ok, true);
  assert.equal(result.data?.routeForward, true);
  assert.equal(result.data?.routeBackward, true);
});
