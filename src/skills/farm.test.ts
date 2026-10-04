import assert from "node:assert/strict";
import { test } from "node:test";
import { chooseFarmCells, isMatureWheat, sowingOrder, type FarmBlock, type FarmLookup } from "./farm.js";

const HOME = { x: 0, y: 64, z: 0 };

/** Flat grass at y=63 everywhere, with per-position overrides. */
function world(overrides: Record<string, FarmBlock> = {}): FarmLookup {
  return (x, y, z) => {
    const hit = overrides[`${x},${y},${z}`];
    if (hit !== undefined) return hit;
    if (y < 63) return { name: "stone" };
    if (y === 63) return { name: "grass_block" };
    return { name: "air" };
  };
}

test("chooseFarmCells picks a full 5x5 plot of tillable soil off the base", () => {
  const cells = chooseFarmCells(HOME, world());
  assert.equal(cells.length, 25);
  assert.ok(cells.every((c) => c.soil === "tillable" && c.y === 63));
  // Clear of the base footprint (walls are 3 out from home).
  assert.ok(cells.every((c) => Math.max(Math.abs(c.x), Math.abs(c.z)) >= 6));
  // Never in front of the base door (+Z).
  assert.ok(cells.every((c) => c.z <= 2));
});

test("chooseFarmCells sticks with the plot that already has farmland", () => {
  // One farmland cell on the east plot outweighs the default west choice.
  const cells = chooseFarmCells(HOME, world({ "8,63,0": { name: "farmland" } }));
  assert.ok(cells.every((c) => c.x >= 6));
  assert.equal(cells.filter((c) => c.soil === "farmland").length, 1);
});

test("chooseFarmCells prefers a plot near water", () => {
  const cells = chooseFarmCells(HOME, world({ "0,63,-8": { name: "water" } }));
  assert.ok(cells.every((c) => c.z <= -6));
  assert.ok(cells.every((c) => c.hydrated));
});

test("chooseFarmCells skips soil under a block it cannot clear", () => {
  const cells = chooseFarmCells(HOME, world({ "-8,63,-1": { name: "farmland" }, "-8,64,0": { name: "oak_planks" }, "-7,64,0": { name: "short_grass" } }));
  assert.equal(cells.length, 24);
  assert.equal(cells.find((c) => c.x === -7 && c.z === 0)?.above, "short_grass");
});

test("sowing fills empty farmland before tilling, and leaves growing wheat alone", () => {
  const cells = chooseFarmCells(HOME, world({
    "-8,63,0": { name: "farmland" },
    "-8,63,1": { name: "farmland" },
    "-8,64,1": { name: "wheat", age: 3 },
    "-8,63,2": { name: "farmland" },
    "-8,64,2": { name: "wheat", age: 7 },
  }));
  const order = sowingOrder(cells);
  assert.deepEqual([order[0]!.x, order[0]!.z], [-8, 0]);
  assert.equal(order.length, 23);
  assert.deepEqual(cells.filter(isMatureWheat).map((c) => [c.x, c.z]), [[-8, 2]]);
});

test("chooseFarmCells finds the surface when home's Y has drifted below it", () => {
  const cells = chooseFarmCells({ x: 0, y: 54, z: 0 }, world());
  assert.equal(cells.length, 25);
  assert.ok(cells.every((c) => c.y === 63));
});
