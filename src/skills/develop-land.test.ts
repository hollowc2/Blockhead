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

test("away from home there may be work: the run walks home and judges there", async () => {
  // 16:31 (2026-10-05): restarted 46 blocks out, development said "no work"
  // from there and the bot stood idle.
  const { DevelopLandRunner } = await import("./develop-land.js");
  const bot = { entity: { position: { x: 76, y: 97, z: 6 } }, blockAt: () => null } as never;
  const runner = new DevelopLandRunner({ bot, state: { home: { x: 65, y: 96, z: 51, dimension: "overworld" } }, logger: {} } as never);
  assert.equal(runner.hasWork(), true);
});

test("development keeps going outward once the inner rings are done", () => {
  // 21:46 (2026-10-05): every plot within 24 blocks was developed and the
  // bot stood idle.
  const plots = developmentPlots();
  assert.ok(plots.some((p) => Math.max(Math.abs(p.dx), Math.abs(p.dz)) === 48), "plots out to 48 blocks");
  const all: Record<string, FarmBlock> = {};
  for (const p of plots) if (Math.max(Math.abs(p.dx), Math.abs(p.dz)) <= 24) all[`${p.dx},63,${p.dz}`] = { name: "farmland" };
  const next = nextPlotToDevelop(HOME, world(all));
  assert.ok(next !== null && Math.max(Math.abs(next.offset.dx), Math.abs(next.offset.dz)) === 32, JSON.stringify(next?.offset));
});

test("leftover trunk over a field is taken down before the land expands", async () => {
  // Owner, 2026-10-05: the cleared areas still had partial trees hanging
  // over them. Clearing cut a trunk at crop height and left the rest.
  const { nextDevelopment } = await import("./develop-land.js");
  const land = developed(1);
  const field = developmentPlots()[3]!;
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
    land[`${field.dx + dx},63,${field.dz + dz}`] = { name: "farmland" };
    land[`${field.dx + dx},64,${field.dz + dz}`] = { name: "wheat", age: 4 };
  }
  for (let y = 67; y <= 70; y++) land[`${field.dx + 1},${y},${field.dz}`] = { name: "oak_log" };
  land[`${field.dx + 1},71,${field.dz}`] = { name: "oak_leaves" };
  const next = nextDevelopment(HOME, world(land), new Set(), { buildBusy: true, buildings: 0 });
  assert.equal(next?.kind, "tidy");
  assert.deepEqual(next?.survey.leftoverLogs.map((c) => c.y).sort(), [67, 68, 69, 70]);
  const skipped = nextDevelopment(HOME, world(land), new Set(), { buildBusy: true, buildings: 0, tidySkip: new Set([`${field.dx},${field.dz}`]) });
  assert.equal(skipped?.kind, "field", "an unreachable trunk does not hold development up");
});

test("a field run with no hoe and no wood on hand fetches wood first", async () => {
  // 2026-10-05 23:41, 23:46: "missing ingredients for 'wooden_hoe'" with 367
  // seeds held; the field at -24,0 failed twice without tilling a cell.
  const { hoeWoodShort } = await import("./farm.js");
  assert.equal(hoeWoodShort({ hoe: false, planks: 0, logs: 0, sticks: 0 }), true);
  assert.equal(hoeWoodShort({ hoe: false, planks: 3, logs: 0, sticks: 0 }), true, "three planks cannot make both the sticks and the head");
  // 04:16 (2026-10-06): the table at home was out of reach and four planks
  // could not also make a new one.
  assert.equal(hoeWoodShort({ hoe: false, planks: 4, logs: 0, sticks: 0 }), true, "a new table needs four more");
  assert.equal(hoeWoodShort({ hoe: false, planks: 0, logs: 2, sticks: 0 }), false, "two logs make the table, sticks and head");
  assert.equal(hoeWoodShort({ hoe: false, planks: 6, logs: 0, sticks: 2 }), false);
  assert.equal(hoeWoodShort({ hoe: true, planks: 0, logs: 0, sticks: 0 }), false);
});

test("a tree farm plot reads its sapling cells: planted, grown, or empty", async () => {
  // Owner, 2026-10-06: "start a tree farm if needed".
  const { surveyTreeFarm } = await import("./develop-land.js");
  const plot = developmentPlots()[3]!;
  const at = (dx: number, dz: number, y: number) => `${plot.dx + dx},${y},${plot.dz + dz}`;
  const farm = surveyTreeFarm(HOME, plot, world({
    [at(-2, -2, 64)]: { name: "birch_sapling" },
    [at(2, 2, 64)]: { name: "birch_log" },
    [at(2, -2, 64)]: { name: "short_grass" },
  }));
  assert.equal(farm.saplings, 1);
  assert.equal(farm.trees, 1);
  assert.equal(farm.empty.length, 3);
  assert.deepEqual(farm.empty.find((cell) => cell.x === plot.dx + 2 && cell.z === plot.dz - 2), { x: plot.dx + 2, y: 64, z: plot.dz - 2, cover: "short_grass" });
});

test("short of trees, an outer plot is set aside for a tree farm, then planted and kept off", async () => {
  const { nextDevelopment, TREE_FARM_PLOTS } = await import("./develop-land.js");
  const land = world(developed(0));
  // Home plots done, no trees around: the nearest outer plot becomes the farm.
  const first = nextDevelopment(HOME, land, new Set(), { buildBusy: true, buildings: 0, treeFarm: { plots: [], wanted: true, canPlant: true } });
  assert.equal(first?.kind, "tree_farm");
  const farmPlot = first!.survey.offset;
  assert.deepEqual(farmPlot, developmentPlots()[3]);
  // Set aside and empty: it is planted next.
  const plant = nextDevelopment(HOME, land, new Set(), { buildBusy: true, buildings: 0, treeFarm: { plots: [farmPlot], wanted: true, canPlant: true } });
  assert.equal(plant?.kind, "plant_trees");
  assert.ok(plant?.kind === "plant_trees" && plant.farm.empty.length === 5);
  // With no saplings and a hunt on cooldown, development goes on elsewhere
  // and never turns the farm into a field.
  const later = nextDevelopment(HOME, land, new Set(), { buildBusy: true, buildings: 0, treeFarm: { plots: [farmPlot], wanted: false, canPlant: false } });
  assert.equal(later?.kind, "field");
  assert.notDeepEqual(later?.survey.offset, farmPlot);
  // Enough trees again: no more plots set aside.
  const plenty = nextDevelopment(HOME, land, new Set(), { buildBusy: true, buildings: 0, treeFarm: { plots: [farmPlot], wanted: false, canPlant: false } });
  assert.notEqual(plenty?.kind, "tree_farm");
  assert.equal(TREE_FARM_PLOTS, 2);
});

test("field levelling uses crop-covered heights and cuts farmland and fills crops", async () => {
  const { levelPlan, modalGround } = await import("./develop-land.js");
  const land = developed(0);
  land["-9,63,0"] = { name: "wheat", age: 4 };
  land["-9,62,0"] = { name: "farmland" };
  land["-7,64,0"] = { name: "farmland" };
  land["-7,65,0"] = { name: "wheat", age: 7 };
  const survey = surveyPlot(HOME, { dx: -8, dz: 0 }, world(land));
  assert.equal(survey.minGround, 62);
  assert.equal(survey.maxGround, 64);
  assert.equal(modalGround(survey), 63);
  assert.equal(modalGround({ ...survey, groundYs: [64, 62] }), 62);
  const plan = levelPlan({ x: -10, z: -2 }, 63, 5, world(land));
  assert.deepEqual(plan.cut, [{ x: -7, y: 65, z: 0 }, { x: -7, y: 64, z: 0 }]);
  assert.deepEqual(plan.fill, [{ x: -9, y: 63, z: 0 }]);
});

test("steep field is skipped but remains available as a building site", async () => {
  const { nextDevelopment, FIELD_MAX_STEP } = await import("./develop-land.js");
  const land = developed(0);
  const p = developmentPlots()[3]!;
  for (let y = 64; y <= 63 + 4; y++) land[`${p.dx},${y},${p.dz}`] = { name: "dirt" };
  assert.equal(FIELD_MAX_STEP, 3);
  assert.notDeepEqual(nextDevelopment(HOME, world(land))?.survey.offset, p);
  // Exclude all other sites so the 4-block slope is the only choice.
  for (const other of developmentPlots().slice(4)) for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) land[`${other.dx + dx},63,${other.dz + dz}`] = { name: "water" };
  assert.equal(nextDevelopment(HOME, world(land), new Set(), { buildBusy: false, buildings: 0 })?.kind, "building");
});

test("uneven developed fields are repaired after tidy and before tree planting or expansion", async () => {
  const { nextDevelopment } = await import("./develop-land.js");
  const land = developed(0);
  land["-9,64,0"] = { name: "farmland" };
  const state = { buildBusy: true, buildings: 0, treeFarm: { plots: [developmentPlots()[3]!], wanted: false, canPlant: true } };
  const next = nextDevelopment(HOME, world(land), new Set(), state);
  assert.equal(next?.kind, "level_field");
  assert.ok(next?.kind === "level_field" && next.padY === 63);
  assert.equal(nextDevelopment(HOME, world(developed(0)), new Set(), state)?.kind, "plant_trees");
  assert.equal(nextDevelopment(HOME, world(land), new Set(), { ...state, levelSkip: new Set(["-8,0"]) })?.kind, "plant_trees");
  assert.equal(nextDevelopment(HOME, world(land), new Set(["-10,95,0"]), state)?.kind, "plant_trees");
  assert.notEqual(nextDevelopment(HOME, world(land), new Set(), { ...state, treeFarm: { plots: [{ dx: -8, dz: 0 }], wanted: false, canPlant: false } })?.kind, "level_field");
  land["-12,67,0"] = { name: "birch_log" };
  assert.equal(nextDevelopment(HOME, world(land), new Set(), state)?.kind, "tidy");
});

test("gap tidy takes floating logs but leaves standing trunks, frames and protected columns", async () => {
  const { nextDevelopment } = await import("./develop-land.js");
  const land = developed(0);
  land["-12,67,0"] = { name: "birch_log" };
  for (let y = 64; y <= 69; y++) land[`-12,${y},1`] = { name: "birch_log" };
  land["-11,67,-2"] = { name: "birch_log" };
  land["-11,67,-3"] = { name: "oak_planks" };
  land["-12,68,-4"] = { name: "birch_log" };
  land["-5,68,0"] = { name: "birch_log" };
  const state = { buildBusy: true, buildings: 0, treeFarm: { plots: [{ dx: -16, dz: 0 }], wanted: false, canPlant: false } };
  const next = nextDevelopment(HOME, world(land), new Set(["-12,90,-4"]), state);
  assert.equal(next?.kind, "tidy");
  assert.deepEqual(next?.survey.leftoverLogs, [{ x: -12, y: 67, z: 0, name: "birch_log" }, { x: -5, y: 68, z: 0, name: "birch_log" }]);
  const protectedFarm = nextDevelopment(HOME, world(land), new Set(["-12,90,-4"]), { ...state, treeFarm: { ...state.treeFarm, plots: [{ dx: -14, dz: 0 }] } });
  assert.deepEqual(protectedFarm?.survey.leftoverLogs, [{ x: -5, y: 68, z: 0, name: "birch_log" }]);
});

test("levelling never cuts through a crafted obstruction or cuts paths", async () => {
  const { levelPlan } = await import("./develop-land.js");
  const plan = levelPlan({ x: 0, z: 0 }, 63, 2, world({ "0,65,0": { name: "oak_planks" }, "0,64,0": { name: "dirt" }, "1,64,1": { name: "dirt_path" } }));
  assert.deepEqual(plan, { cut: [], fill: [] });
});
