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

/** The three home plots as fields, plus `outer` outer plots as fields. */
function developed(outer: number): Record<string, FarmBlock> {
  const fields: Record<string, FarmBlock> = {};
  for (const p of developmentPlots().slice(0, 3 + outer)) fields[`${p.dx},63,${p.dz}`] = { name: "farmland" };
  return fields;
}

test("fields and buildings stay in balance: two outer fields per building", async () => {
  const { nextDevelopment, FIELDS_PER_BUILDING } = await import("./develop-land.js");
  assert.equal(FIELDS_PER_BUILDING, 2);
  // Building, field, field, building, ...: one building and one field
  // makes a field next.
  assert.equal(nextDevelopment(HOME, world(developed(1)), new Set(), { buildBusy: false, buildings: 1 })?.kind, "field");
  // One building and two fields: the second building is due, and it is a shed.
  const next = nextDevelopment(HOME, world(developed(2)), new Set(), { buildBusy: false, buildings: 1 });
  assert.equal(next?.kind, "building");
  assert.ok(next?.kind === "building" && next.building === "storage_shed");
  // While a building is going up, fields keep coming.
  assert.equal(nextDevelopment(HOME, world(developed(4)), new Set(), { buildBusy: true, buildings: 1 })?.kind, "field");
});

test("a building goes on the flattest nearby plot; steep ground is levelled, not skipped", async () => {
  const { nextDevelopment } = await import("./develop-land.js");
  const outer = developmentPlots().slice(3);
  const land = developed(0);
  // The nearest open plot is a 3-block slope; the second is flat.
  for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) {
    const x = outer[0]!.dx + dx; const z = outer[0]!.dz + dz;
    for (let y = 64; y <= 63 + Math.max(0, dx + 1); y++) land[`${x},${y},${z}`] = { name: "dirt" };
    land[`${x},${63 + Math.max(0, dx + 1)},${z}`] = { name: "grass_block" };
  }
  const flat = nextDevelopment(HOME, world(land), new Set(), { buildBusy: false, buildings: 0 });
  assert.ok(flat?.kind === "building");
  assert.deepEqual(flat.survey.offset, outer[1], "the flat plot wins");
  // With only the slope left nearby, it is still built on (levelled).
  const steepOnly = { ...land };
  for (const p of outer.slice(1)) for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) steepOnly[`${p.dx + dx},63,${p.dz + dz}`] = { name: "water" };
  const slope = nextDevelopment(HOME, world(steepOnly), new Set(), { buildBusy: false, buildings: 0 });
  assert.ok(slope?.kind === "building");
  assert.deepEqual(slope.survey.offset, outer[0]);
});

test("levelling cuts ground above the pad and fills dips up to it", async () => {
  const { levelPlan } = await import("./develop-land.js");
  const land: Record<string, FarmBlock> = { "1,64,1": { name: "dirt" }, "1,65,1": { name: "grass_block" }, "2,63,2": { name: "air" } };
  const plan = levelPlan({ x: 0, z: 0 }, 63, 7, world(land));
  assert.deepEqual(plan.cut, [{ x: 1, y: 65, z: 1 }, { x: 1, y: 64, z: 1 }], "top down");
  assert.deepEqual(plan.fill, [{ x: 2, y: 63, z: 2 }]);
});

test("a built site is left alone", async () => {
  const { nextDevelopment } = await import("./develop-land.js");
  const outer = developmentPlots().slice(3);
  const built = developed(0);
  for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) built[`${outer[0]!.dx + dx},68,${outer[0]!.dz + dz}`] = { name: "oak_planks" };
  const next = nextDevelopment(HOME, world(built), new Set(), { buildBusy: false, buildings: 0 });
  assert.notDeepEqual(next?.survey.offset, outer[0]);
});
