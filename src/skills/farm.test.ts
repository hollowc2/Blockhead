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

test("the farm grows by a plot when the seeds cover it", () => {
  // One plot baked 8 bread a pass while the food floor preempted everything.
  // Harvested farmland dries back to dirt, so the plot is never all farmland.
  const north: Record<string, FarmBlock> = {};
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) if (dx !== 0) north[`${dx},63,${-8 + dz}`] = { name: "farmland" };
  assert.equal(chooseFarmCells(HOME, world(north), 30).length, 25, "30 seeds: the north plot only");
  const grown = chooseFarmCells(HOME, world(north), 110);
  assert.equal(grown.length, 75, "110 seeds (live 23:25): all three plots");
  assert.equal(grown.filter((c) => c.z <= -6).length, 25, "the north plot is kept whole");
  assert.deepEqual(grown.slice(0, 25).map((c) => c.z <= -6), Array(25).fill(true), "and listed first");
});

test("every plot that already has farmland stays in the farm", () => {
  const cells = chooseFarmCells(HOME, world({ "8,63,0": { name: "farmland" }, "-8,63,0": { name: "farmland" } }));
  assert.equal(cells.length, 50);
  assert.equal(cells.filter((c) => c.soil === "farmland").length, 2);
});

test("a table is not placed from out of reach", async () => {
  // 23:15 and 23:38: the bot stood at the north plot 8.5 blocks from the
  // spot beside home; the server never answered and the farm had no table.
  const { placeNewTable } = await import("./farm.js");
  const { withWorldActionLease } = await import("../agent/world-actions.js");
  const { Vec3 } = await import("vec3");
  const placed: unknown[] = [];
  const bot = {
    entity: { position: new Vec3(63.5, 95, 42.5) },
    inventory: { items: () => [{ name: "crafting_table", type: 1, count: 1 }] },
    heldItem: { name: "crafting_table" },
    blockAt: (p: { x: number; y: number; z: number }) => (p.y <= 95 ? { name: "grass_block", boundingBox: "block", position: new Vec3(p.x, p.y, p.z) } : { name: "air", boundingBox: "empty", position: new Vec3(p.x, p.y, p.z) }),
    placeBlock: async (...args: unknown[]) => { placed.push(args); },
  } as unknown as import("mineflayer").Bot;
  const logger = { warn() {}, info() {} } as unknown as import("pino").Logger;
  const home = { x: 65, y: 96, z: 51, dimension: "overworld" } as import("../minecraft/movement.js").HomeLocation;
  const table = await withWorldActionLease({ owner: "farm-test", signal: new AbortController().signal, acknowledged: Promise.resolve() }, () => placeNewTable(bot, home, logger));
  assert.equal(table, null);
  assert.deepEqual(placed, [], "no placement packet from 8.5 blocks away");
});

test("an outer plot joins the farm only once development cleared it", () => {
  const all = chooseFarmCells(HOME, world(), 500);
  assert.equal(all.length, 75, "the three home plots only, however many seeds");
  const withOuter = chooseFarmCells(HOME, world(), 500, { dx: 16, dz: 0 });
  assert.equal(withOuter.length, 100);
  assert.equal(withOuter.filter((c) => c.x >= 14).length, 25);
});
