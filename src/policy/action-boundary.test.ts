import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bot } from "mineflayer";
import type { MinecraftConfig } from "../config/schema.js";
import { revalidateAction } from "./action-boundary.js";
import { asEscapeMove, isEscapeMove } from "../agent/world-actions.js";

const bot = (health: number) => ({ entity: { position: { x: 0, y: 64, z: 0 } }, health, food: 20, blockAt: () => null, findBlocks: () => [] }) as unknown as Bot;
const config = {} as MinecraftConfig;
const point = { x: 5, y: 64, z: 5 };

test("critical health stops ordinary digs but not an escape move", async () => {
  // 2026-10-22 11:50: the combat perch could not dig at 3.9 HP with a zombie on it.
  assert.equal(revalidateAction(bot(3.9), "dig", point, config, null, { blockName: "stone" }).allowed, false);
  assert.equal(revalidateAction(bot(3.9), "dig", point, config, null, { blockName: "stone", escape: true }).allowed, true);
  assert.equal(revalidateAction(bot(12), "dig", point, config, null, { blockName: "stone" }).allowed, true);
  assert.equal(isEscapeMove(), false);
  assert.equal(await asEscapeMove(async () => isEscapeMove()), true);
});
