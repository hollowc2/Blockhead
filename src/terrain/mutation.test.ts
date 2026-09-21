import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bot } from "mineflayer";
import type { Block } from "prismarine-block";
import type { Item } from "prismarine-item";
import { WorldActionExecutor } from "../agent/world-actions.js";
import { TerrainMutationService, type ToolProvisioner } from "./mutation.js";

type Point = { x: number; y: number; z: number };

function fakeBlock(name: string, position: Point, extra: Partial<Block> = {}): Block {
  return {
    name,
    position,
    boundingBox: name === "air" ? "empty" : "block",
    diggable: name !== "bedrock",
    canHarvest: () => true,
    ...extra,
  } as unknown as Block;
}

function fakeBot(blockAt: (position: Point) => Block | null, heldItem: Item | null = null): Bot {
  return {
    entity: { position: { x: 10, y: 65, z: 10 } },
    heldItem,
    blockAt,
  } as unknown as Bot;
}

const provisioner: ToolProvisioner = {
  equipForBlock: async () => undefined,
  hasDurabilityReserve: () => true,
};

test("breakAndVerify requires an observed passable postcondition", async () => {
  const target = { x: 11, y: 64, z: 10 };
  let dug = false;
  const bot = fakeBot((position) => {
    if (position.x === target.x && position.y === target.y && position.z === target.z) {
      return fakeBlock(dug ? "air" : "stone", position);
    }
    return fakeBlock("air", position);
  }, { type: 1, maxDurability: 0, durabilityUsed: 0 } as unknown as Item);
  const executor = new WorldActionExecutor();
  const result = await executor.run("terrain-dig", new AbortController().signal, async () => {
    const service = new TerrainMutationService(bot, { toolProvisioner: provisioner, pollAttempts: 2, settleAttempts: 1, pollIntervalMs: 1 });
    const originalDig = bot.dig;
    bot.dig = async () => { dug = true; };
    const outcome = await service.breakAndVerify(target);
    bot.dig = originalDig;
    return outcome;
  });
  assert.equal(result.ok, true);
  assert.equal(result.data?.after, "passable");
  assert.equal(dug, true);
});

test("null, fluids, fixtures, and unbreakable blocks are rejected before mutation", async () => {
  const cases: Array<{ name: string; expected: string }> = [
    { name: "null", expected: "WORLD_NOT_OBSERVED" },
    { name: "lava", expected: "LAVA_HAZARD" },
    { name: "water", expected: "WATER_HAZARD" },
    { name: "chest", expected: "PROTECTED_FIXTURE" },
    { name: "bedrock", expected: "UNBREAKABLE_BLOCK" },
  ];
  for (const entry of cases) {
    let digCalls = 0;
    const point = { x: 11, y: 64, z: 10 };
    const bot = fakeBot((position) => position.x === point.x && position.y === point.y && position.z === point.z
      ? entry.name === "null" ? null : fakeBlock(entry.name, position)
      : fakeBlock("air", position));
    bot.dig = async () => { digCalls += 1; };
    const outcome = await new WorldActionExecutor().run(`terrain-${entry.name}`, new AbortController().signal, async () =>
      new TerrainMutationService(bot, { toolProvisioner: provisioner }).breakAndVerify(point));
    assert.equal(outcome.errorCode, entry.expected);
    assert.equal(digCalls, 0);
  }
});

test("observed lava beside a target is rejected before digging", async () => {
  const point = { x: 11, y: 64, z: 10 };
  let digCalls = 0;
  const bot = fakeBot((position) => {
    if (position.x === point.x && position.y === point.y && position.z === point.z) return fakeBlock("stone", position);
    if (position.x === point.x + 1 && position.y === point.y && position.z === point.z) return fakeBlock("lava", position);
    return fakeBlock("air", position);
  }, { type: 1, maxDurability: 0, durabilityUsed: 0 } as unknown as Item);
  bot.dig = async () => { digCalls += 1; };
  const outcome = await new WorldActionExecutor().run("terrain-adjacent-lava", new AbortController().signal, async () =>
    new TerrainMutationService(bot, { toolProvisioner: provisioner }).breakAndVerify(point));
  assert.equal(outcome.errorCode, "LAVA_HAZARD");
  assert.equal(digCalls, 0);
});

test("falling columns have a bounded terminal failure", async () => {
  const point = { x: 11, y: 64, z: 10 };
  let dug = false;
  const bot = fakeBot((position) => {
    if (position.x === point.x && position.y === point.y && position.z === point.z) return fakeBlock(dug ? "air" : "stone", position);
    if (position.x === point.x && position.z === point.z && position.y === point.y + 1) return fakeBlock("gravel", position);
    return fakeBlock("air", position);
  }, { type: 1, maxDurability: 0, durabilityUsed: 0 } as unknown as Item);
  const result = await new WorldActionExecutor().run("terrain-falling", new AbortController().signal, async () => {
    bot.dig = async () => { dug = true; };
    const outcome = await new TerrainMutationService(bot, { toolProvisioner: provisioner, settleAttempts: 2, pollAttempts: 1, pollIntervalMs: 1 }).breakAndVerify(point);
    assert.equal(dug, true);
    return outcome;
  });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "FALLING_BLOCKS_UNSTABLE");
});

test("an aborted signal stops before the next mutation", async () => {
  const controller = new AbortController();
  controller.abort(new Error("maintenance pause"));
  let digCalls = 0;
  const point = { x: 11, y: 64, z: 10 };
  const bot = fakeBot(() => fakeBlock("stone", point));
  bot.dig = async () => { digCalls += 1; };
  await assert.rejects(
    new WorldActionExecutor().run("terrain-abort", controller.signal, async () =>
      new TerrainMutationService(bot, { toolProvisioner: provisioner }).breakAndVerify(point)),
    /maintenance pause|aborted/i,
  );
  assert.equal(digCalls, 0);
});
