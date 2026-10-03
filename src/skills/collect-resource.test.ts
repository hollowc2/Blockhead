import assert from "node:assert/strict";
import { test } from "node:test";
import { carriedItemName, sourceBlockName } from "./collect-resource.js";

test("cobblestone is mined from stone and still accounted as cobblestone", () => {
  // Searching for cobblestone blocks found only the home's own (PROTECTED_REGION).
  assert.equal(sourceBlockName("cobblestone"), "stone");
  assert.equal(sourceBlockName("minecraft:cobbled_deepslate"), "deepslate");
  assert.equal(carriedItemName(sourceBlockName("cobblestone")), "cobblestone");
  assert.equal(carriedItemName(sourceBlockName("cobbled_deepslate")), "cobbled_deepslate");
});

test("other resources are mined as themselves", () => {
  assert.equal(sourceBlockName("acacia_log"), "acacia_log");
  assert.equal(sourceBlockName("iron_ore"), "iron_ore");
  assert.equal(sourceBlockName("blackstone"), "blackstone");
});
