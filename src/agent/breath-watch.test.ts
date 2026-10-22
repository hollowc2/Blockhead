import assert from "node:assert/strict";
import { test } from "node:test";
import { LOW_OXYGEN, nearestAir, shouldSurface } from "./breath-watch.js";

const base = { alive: true, oxygen: 20, headUnderwater: true, pathfinderMoving: false, surfacing: false };

test("an idle bot low on air with its head underwater swims up until the bar refills", () => {
  // 2026-10-04 19:00: idle between tasks, it sank from y=59 to y=49 and drowned.
  assert.equal(shouldSurface(base), false, "full air: no need yet");
  assert.equal(shouldSurface({ ...base, oxygen: LOW_OXYGEN }), true);
  assert.equal(shouldSurface({ ...base, oxygen: 17, surfacing: true }), true, "keeps going until recovered");
  assert.equal(shouldSurface({ ...base, oxygen: 19, surfacing: true }), false);
});

test("the breath watch leaves the controls alone while moving, on land or dead", () => {
  assert.equal(shouldSurface({ ...base, oxygen: 5, pathfinderMoving: true }), false);
  assert.equal(shouldSurface({ ...base, oxygen: 5, headUnderwater: false }), false);
  assert.equal(shouldSurface({ ...base, oxygen: 5, alive: false }), false);
});

test("under a stone ceiling the nearest air is found to the side", () => {
  // 2026-10-22 drowning: water at y56-57 under stone, air two blocks east.
  const world = new Map<string, string>();
  for (let x = 40; x <= 50; x++) for (let y = 54; y <= 60; y++) for (let z = -100; z <= -90; z++) world.set(`${x},${y},${z}`, "stone");
  for (const x of [44, 45, 46]) for (const y of [56, 57]) world.set(`${x},${y},-96`, "water");
  world.set("47,57,-96", "air");
  const cell = (x: number, y: number, z: number) => world.get(`${x},${y},${z}`) ?? null;
  assert.deepEqual(nearestAir(cell, { x: 45, y: 57, z: -96 }), { x: 47, y: 57, z: -96 });
  world.set("45,58,-96", "water"); world.set("45,59,-96", "air");
  assert.deepEqual(nearestAir(cell, { x: 45, y: 57, z: -96 }), { x: 45, y: 59, z: -96 }, "open water overhead still goes up");
  world.set("47,57,-96", "stone"); world.set("45,59,-96", "stone");
  assert.equal(nearestAir(cell, { x: 45, y: 57, z: -96 }), null);
});
