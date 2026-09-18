import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bot } from "mineflayer";
import { isCreativeMode } from "./mode.js";

function botWithMode(gameMode?: number | string): Bot {
  return { game: gameMode === undefined ? undefined : { gameMode } } as unknown as Bot;
}

test("detects the numeric creative game mode", () => {
  assert.equal(isCreativeMode(botWithMode(1)), true);
  assert.equal(isCreativeMode(botWithMode(0)), false);
});

test("accepts legacy string creative reports and missing mode", () => {
  assert.equal(isCreativeMode(botWithMode("creative")), true);
  assert.equal(isCreativeMode(botWithMode()), false);
});

