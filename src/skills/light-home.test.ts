import assert from "node:assert/strict";
import { test } from "node:test";
import { LightModel, planTorches, torchGround, type BlockInfo, type BlockView } from "./light-home.js";

const AIR: BlockInfo = { name: "air", boundingBox: "empty" };
const GRASS: BlockInfo = { name: "grass_block", boundingBox: "block" };
const STONE: BlockInfo = { name: "stone", boundingBox: "block" };

/** Flat grass at y=95 (open air from 96 up) with extra blocks laid on top. */
function world(extra: Record<string, BlockInfo> = {}): BlockView {
  return (x, y, z) => extra[`${x},${y},${z}`] ?? (y >= 96 ? AIR : y === 95 ? GRASS : STONE);
}

test("torches stand on full ground blocks, not leaves, water, farmland or chests", () => {
  const block = (name: string, boundingBox = "block") => ({ name, boundingBox });
  assert.equal(torchGround(block("grass_block")), true);
  assert.equal(torchGround(block("stone")), true);
  for (const name of ["oak_leaves", "water", "farmland", "chest", "oak_slab", "glass", "furnace", "crafting_table"]) assert.equal(torchGround(block(name)), false, name);
  assert.equal(torchGround(block("short_grass", "empty")), false);
  assert.equal(torchGround(null), false);
});

test("light drops one per block and stops at a wall", () => {
  const wall: Record<string, BlockInfo> = {};
  for (let y = 96; y < 110; y++) for (let z = -20; z <= 20; z++) wall[`3,${y},${z}`] = STONE;
  const model = new LightModel(world(wall));
  model.addSource(0, 96, 0);
  assert.equal(model.at(0, 96, 0), 14);
  assert.equal(model.at(2, 96, 0), 12);
  assert.equal(model.at(-5, 96, 3), 6);
  assert.equal(model.at(4, 96, 0), 0, "behind the wall, nothing reaches straight through");
});

test("an open field is lit with torches until no spawnable cell is dark", () => {
  const view = world();
  const home = { x: 0, y: 96, z: 0 };
  const plan = planTorches(view, home, { radius: 20 });
  assert.ok(plan.length > 0 && plan.length < 40, `a sensible number of torches: ${plan.length}`);
  assert.deepEqual(plan[0], { x: 0, y: 96, z: 0 }, "home first");
  const model = new LightModel(view);
  for (const torch of plan) model.addSource(torch.x, torch.y, torch.z);
  for (let x = -20; x <= 20; x++) for (let z = -20; z <= 20; z++) {
    if (Math.hypot(x, z) <= 20) assert.ok(model.at(x, 96, z) > 0, `ground at ${x},${z} is lit`);
  }
  assert.deepEqual(planTorches(view, home, { radius: 20, sources: plan }), [], "nothing left once they stand");
});

test("a cave mouth under an overhang gets its own torch though the field above is lit", () => {
  // Live 23:05: the floor grid lit the ground, but roofed cells 12-20 blocks
  // west of home (x 42-53, y 92-96) stayed dark and spawned skeletons at noon.
  const extra: Record<string, BlockInfo> = {};
  // A pocket at y=92..93 under a stone roof at y=94-95, opening only at x=-14.
  for (let x = -20; x <= -14; x++) for (let z = -2; z <= 2; z++) {
    extra[`${x},91,${z}`] = STONE;
    extra[`${x},92,${z}`] = AIR;
    extra[`${x},93,${z}`] = AIR;
    extra[`${x},94,${z}`] = STONE;
    extra[`${x},95,${z}`] = GRASS;
  }
  const view = world(extra);
  const field = planTorches(world(), { x: 0, y: 96, z: 0 }, { radius: 24 });
  const plan = planTorches(view, { x: 0, y: 96, z: 0 }, { radius: 24, sources: field });
  assert.ok(plan.length > 0, "the pocket is still dark with only the field lit");
  assert.ok(plan.every((t) => t.y === 92 && t.x <= -14), `torches go inside the pocket: ${JSON.stringify(plan)}`);
});

test("reserved build cells and spots that failed before are left out", () => {
  const view = world();
  const reserved = new Set(["0,96,0"]);
  const plan = planTorches(view, { x: 0, y: 96, z: 0 }, { radius: 4, reserved, skip: new Set(["1,96,0"]) });
  assert.ok(plan.length > 0);
  assert.ok(!plan.some((t) => (t.x === 0 && t.z === 0) || (t.x === 1 && t.z === 0)), JSON.stringify(plan));
});

test("no torch is planned in the base's door gap or walls", async () => {
  // 2026-10-05 14:2x: with the doorway cleared, a torch went into it before
  // the door could be hung. Here the doorway is the only cell a mob could
  // spawn in (glass floor everywhere else).
  const { LightHomeRunner } = await import("./light-home.js");
  const { baseLayoutFor } = await import("./base.js");
  const { Vec3 } = await import("vec3");
  const home = { x: 0, y: 96, z: 0, dimension: "overworld" };
  const layout = baseLayoutFor(home as never);
  const door = layout.doorCells[0]!;
  const GLASS: BlockInfo = { name: "glass", boundingBox: "block" };
  const view: BlockView = (x, y, z) => (y === 95 ? (x === door.x && z === door.z ? GRASS : GLASS) : y > 95 ? AIR : STONE);
  const bot = {
    entity: { position: new Vec3(0.5, 96, 0.5) },
    blockAt: (p: { x: number; y: number; z: number }) => ({ ...view(p.x, p.y, p.z)!, position: new Vec3(p.x, p.y, p.z) }),
    findBlocks: () => [],
  };
  const runner = new LightHomeRunner({ bot, state: { home }, logger: { info() {}, warn() {} } } as unknown as ConstructorParameters<typeof LightHomeRunner>[0]);
  const spots = runner.darkSpots({ fresh: true });
  assert.deepEqual(spots.map((s) => [s.position.x, s.position.y, s.position.z]), [], "the doorway is the builder's");
});
