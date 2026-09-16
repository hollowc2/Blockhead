import assert from "node:assert/strict";
import { test } from "node:test";
import { maxWoolColorCount } from "./bootstrap-survival.js";
import { BootstrapStage, nextBootstrapStage } from "../agent/bootstrap.js";

function fakeBot(items: Array<{ name: string; count: number }>) {
  return { inventory: { items: () => items } } as any;
}

test("bed bootstrap requires three wool of one color", () => {
  assert.equal(
    maxWoolColorCount(fakeBot([
      { name: "white_wool", count: 1 },
      { name: "brown_wool", count: 1 },
      { name: "gray_wool", count: 1 },
    ])),
    1,
  );
  assert.equal(
    maxWoolColorCount(fakeBot([
      { name: "white_wool", count: 2 },
      { name: "white_wool", count: 1 },
      { name: "brown_wool", count: 2 },
    ])),
    3,
  );
});

test("core survival stages precede optional wool and bed stages", () => {
  assert.equal(nextBootstrapStage(BootstrapStage.FOOD), BootstrapStage.STORAGE);
  assert.equal(nextBootstrapStage(BootstrapStage.TORCHES), BootstrapStage.WOOL);
  assert.equal(nextBootstrapStage(BootstrapStage.WOOL), BootstrapStage.BED);
});
