import assert from "node:assert/strict";
import { test } from "node:test";
import { developmentPlots, type FarmBlock, type FarmLookup } from "./farm.js";
import { nextPlotToDevelop, surveyPlot } from "./develop-land.js";

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

test("development plots run outward ring by ring, home plots first", () => {
  const plots = developmentPlots();
  assert.deepEqual(plots.slice(0, 3), [{ dx: -8, dz: 0 }, { dx: 8, dz: 0 }, { dx: 0, dz: -8 }]);
  const rings = plots.map((p) => Math.max(Math.abs(p.dx), Math.abs(p.dz)));
  assert.deepEqual([...rings].sort((a, b) => a - b), rings, "never an outer ring before an inner one");
  assert.ok(plots.length > 20, `${plots.length} plots`);
});

test("a tree on a plot is cleared at crop and walking height; the canopy is left", () => {
  const tree: Record<string, FarmBlock> = {};
  for (let y = 64; y <= 69; y++) tree[`16,${y},0`] = { name: "oak_log" };
  for (let y = 67; y <= 70; y++) tree[`17,${y},0`] = { name: "oak_leaves" };
  tree["15,64,1"] = { name: "short_grass" };
  const survey = surveyPlot(HOME, { dx: 16, dz: 0 }, world(tree));
  assert.equal(survey.groundColumns, 25);
  assert.deepEqual(survey.clear.map((c) => `${c.x},${c.y},${c.z}:${c.name}`).sort(), ["15,64,1:short_grass", "16,64,0:oak_log", "16,65,0:oak_log"]);
});

test("the next plot skips farmland, water and an owner's reserved build", () => {
  const overrides: Record<string, FarmBlock> = {};
  // The three home plots are already fields.
  for (const [cx, cz] of [[-8, 0], [8, 0], [0, -8]]) overrides[`${cx},63,${cz}`] = { name: "farmland" };
  // The nearest ring-2 plot (-16,0... by order) is a lake.
  const first = developmentPlots()[3]!;
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) overrides[`${first.dx + dx},63,${first.dz + dz}`] = { name: "water" };
  const second = developmentPlots()[4]!;
  const reserved = new Set([`${second.dx},64,${second.dz}`]);
  const next = nextPlotToDevelop(HOME, world(overrides), reserved);
  assert.ok(next !== null);
  assert.deepEqual(next.offset, developmentPlots()[5]);
});

test("a plot of growing wheat is a field already", () => {
  // 14:36 (2026-10-05): the west home plot, all wheat, was taken for an
  // undeveloped plot because a crop on top hid the farmland.
  const overrides: Record<string, FarmBlock> = {};
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
    overrides[`${-8 + dx},63,${dz}`] = { name: "farmland" };
    overrides[`${-8 + dx},64,${dz}`] = { name: "wheat", age: 3 };
  }
  const survey = surveyPlot(HOME, { dx: -8, dz: 0 }, world(overrides));
  assert.equal(survey.farmland, 25);
  assert.notDeepEqual(nextPlotToDevelop(HOME, world(overrides))?.offset, { dx: -8, dz: 0 });
});

test("every third outer plot is a building site, and gets its building on open ground", async () => {
  const { nextDevelopment, siteIndex } = await import("./develop-land.js");
  const outer = developmentPlots().slice(3);
  assert.equal(siteIndex(outer[0]!), null);
  assert.equal(siteIndex(outer[1]!), 0);
  assert.equal(siteIndex(outer[4]!), 1);
  // Home plots and the first outer plot are already fields.
  const fields: Record<string, FarmBlock> = {};
  for (const p of [...developmentPlots().slice(0, 3), outer[0]!]) fields[`${p.dx},63,${p.dz}`] = { name: "farmland" };
  const next = nextDevelopment(HOME, world(fields));
  assert.ok(next?.kind === "building");
  assert.equal(next.building, "cottage");
  assert.deepEqual(next.origin, { x: outer[1]!.dx - 3, y: 64, z: outer[1]!.dz - 3 });
});

test("a busy builder keeps making fields; a trunk in the way makes the site a field", async () => {
  const { nextDevelopment } = await import("./develop-land.js");
  const outer = developmentPlots().slice(3);
  const fields: Record<string, FarmBlock> = {};
  for (const p of [...developmentPlots().slice(0, 3), outer[0]!]) fields[`${p.dx},63,${p.dz}`] = { name: "farmland" };
  const busy = nextDevelopment(HOME, world(fields), new Set(), true);
  assert.equal(busy?.kind, "field");
  assert.deepEqual(busy?.survey.offset, outer[2]);
  const tree = { ...fields };
  for (let y = 64; y <= 70; y++) tree[`${outer[1]!.dx + 3},${y},${outer[1]!.dz}`] = { name: "oak_log" };
  const blocked = nextDevelopment(HOME, world(tree));
  assert.equal(blocked?.kind, "field", "a tall trunk inside the volume");
  assert.deepEqual(blocked?.survey.offset, outer[1]);
});

test("a built site is left alone", async () => {
  const { nextDevelopment } = await import("./develop-land.js");
  const outer = developmentPlots().slice(3);
  const built: Record<string, FarmBlock> = {};
  for (const p of [...developmentPlots().slice(0, 3), outer[0]!]) built[`${p.dx},63,${p.dz}`] = { name: "farmland" };
  for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) built[`${outer[1]!.dx + dx},68,${outer[1]!.dz + dz}`] = { name: "oak_planks" };
  const next = nextDevelopment(HOME, world(built));
  assert.notDeepEqual(next?.survey.offset, outer[1]);
});
