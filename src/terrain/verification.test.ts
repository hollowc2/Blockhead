import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bot } from "mineflayer";
import type { Block } from "prismarine-block";
import { verifyExcavationVolume } from "./verification.js";

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
