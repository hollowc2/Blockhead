import assert from "node:assert/strict";
import test from "node:test";
import { compileBuildingDesign } from "../building/compiler.js";
import { preferredPlank, simpleStructureDesign } from "./base.js";

test("a simple room leaves a doorway so the door never replaces a wall block", () => {
  const origin = { x: 0, y: 64, z: 0, dimension: "overworld" };
  const blueprint = compileBuildingDesign(simpleStructureDesign("room", 7, 4, 7, origin, "birch_planks"), origin);
  const at = (x: number, y: number, z: number) => blueprint.operations.filter((op) => op.x === x && op.y === y && op.z === z);
  // Door column: exactly one door operation per cell, no plank underneath it.
  for (const y of [0, 1]) {
    const ops = at(3, y, 6);
    assert.equal(ops.length, 1, `door cell y=${y}`);
    assert.match(ops[0]!.material, /_door$/);
  }
  // Lintel above the doorway and the rest of the front wall are planks.
  assert.equal(at(3, 2, 6)[0]?.material, "birch_planks");
  assert.equal(at(2, 0, 6)[0]?.material, "birch_planks");
  assert.equal(at(4, 0, 6)[0]?.material, "birch_planks");
});

test("preferred plank follows the wood the bot can supply", () => {
  const bot = { inventory: { items: () => [{ name: "birch_log", count: 10 }, { name: "oak_planks", count: 12 }] } };
  assert.equal(preferredPlank(bot), "birch_planks");
});

test("a room built at home goes on the nearest plot clear of the home fixtures", async () => {
  const { Vec3 } = await import("vec3");
  const { clearPlotNear } = await import("./base.js");
  // Chest, furnace and table around the home point (65,97,51).
  const fixtures = [new Vec3(65, 97, 49), new Vec3(65, 97, 51), new Vec3(66, 97, 50)];
  const bot = { findBlocks: () => fixtures };
  const plot = clearPlotNear(bot, { x: 65, y: 97, z: 51 }, 7, 7, 4);
  if (plot === null) throw new Error("no plot found");
  for (const f of fixtures) {
    const inside: boolean = f.x >= plot.x - 1 && f.x <= plot.x + 7 && f.z >= plot.z - 1 && f.z <= plot.z + 7;
    assert.equal(inside, false, `fixture ${f} clear of the 7x7 footprint at ${plot.x},${plot.z}`);
  }
  assert.deepEqual(clearPlotNear({ findBlocks: () => [] }, { x: 65, y: 97, z: 51 }, 7, 7, 4), { x: 65, y: 97, z: 51 }, "nothing in the way: build at home");
});
