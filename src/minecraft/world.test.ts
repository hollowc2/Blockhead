import assert from "node:assert/strict";
import { test } from "node:test";
import { Vec3 } from "vec3";
import { withWorldActionLease } from "../agent/world-actions.js";
import { collectBlocks, findBlocksNearRefined } from "./world.js";

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
