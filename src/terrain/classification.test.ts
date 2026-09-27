import { deepStrictEqual, equal } from "node:assert/strict";
import test from "node:test";
import { classifyObservedBlock } from "./classification.js";

function block(name: string, boundingBox: "block" | "empty" = "block", diggable?: boolean): Parameters<typeof classifyObservedBlock>[0] {
  return { name, boundingBox, diggable } as Parameters<typeof classifyObservedBlock>[0];
}

test("null is unobserved rather than empty", () => equal(classifyObservedBlock(null), "unobserved"));
test("air and non-full blocks are passable", () => {
  equal(classifyObservedBlock(block("air")), "passable");
  equal(classifyObservedBlock(block("air", "empty", false)), "passable");
  equal(classifyObservedBlock(block("tall_grass", "empty")), "passable");
});
test("fluids, falling blocks, fixtures, and unbreakables are distinct", () => {
  deepStrictEqual([
    classifyObservedBlock(block("water")),
    classifyObservedBlock(block("lava")),
    classifyObservedBlock(block("gravel")),
    classifyObservedBlock(block("chest")),
    classifyObservedBlock(block("bedrock")),
  ], ["fluid", "fluid", "falling", "protectedFixture", "unbreakable"]);
});
test("solid terrain remains solid", () => equal(classifyObservedBlock(block("stone")), "solid"));
