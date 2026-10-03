import assert from "node:assert/strict";
import { test } from "node:test";
import { Vec3 } from "vec3";
import { withWorldActionLease } from "../agent/world-actions.js";
import { collectBlocks, findBlocksNearRefined, isReachableFromGround } from "./world.js";

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
