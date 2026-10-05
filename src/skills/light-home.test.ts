import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bot } from "mineflayer";
import type { Block } from "prismarine-block";
import { Vec3 } from "vec3";
import { coveredByTorch, LIGHT_RADIUS, LIGHT_SPACING, lightGrid, torchGround, torchSpotNear } from "./light-home.js";

test("the light grid covers home outward, nearest first, within the radius", () => {
  const grid = lightGrid({ x: 65.5, z: 51.5 });
  assert.deepEqual(grid[0], { x: 65, z: 51 }, "home itself first");
  assert.ok(grid.every((p) => Math.hypot(p.x - 65, p.z - 51) <= LIGHT_RADIUS));
  assert.ok(grid.length > 30, `enough points to cover the area: ${grid.length}`);
  // Every ground cell in the radius is within ~spacing/sqrt(2)*2 of a grid point.
  const offsets = Array.from({ length: 41 }, (_, i) => i - 20);
  const cells = offsets.flatMap((dx) => offsets.map((dz) => [dx, dz] as const)).filter(([dx, dz]) => Math.hypot(dx, dz) <= 20);
  const worst = Math.max(...cells.map(([dx, dz]) => Math.min(...grid.map((p) => Math.abs(p.x - 65 - dx) + Math.abs(p.z - 51 - dz)))));
  assert.ok(worst <= LIGHT_SPACING, `farthest walk to a torch ${worst} keeps block light > 0`);
});

test("a torch within reach of a grid point covers it", () => {
  assert.equal(coveredByTorch({ x: 0, z: 0 }, [{ x: 3, z: 2 }]), true);
  assert.equal(coveredByTorch({ x: 0, z: 0 }, [{ x: 6, z: 0 }]), false);
  assert.equal(coveredByTorch({ x: 0, z: 0 }, []), false);
});

test("torches stand on full ground blocks, not leaves, water, farmland or chests", () => {
  const block = (name: string, boundingBox = "block") => ({ name, boundingBox }) as Block;
  assert.equal(torchGround(block("grass_block")), true);
  assert.equal(torchGround(block("stone")), true);
  for (const name of ["oak_leaves", "water", "farmland", "chest", "oak_slab", "glass"]) assert.equal(torchGround(block(name)), false, name);
  assert.equal(torchGround(block("short_grass", "empty")), false);
  assert.equal(torchGround(null), false);
});

test("a torch spot steps aside from farmland and never lands in an owner's build", () => {
  // Flat grass at y=95 (stand at 96), farmland at x=0, a reserved build cell at x=1.
  const blockAt = (pos: Vec3): Block | null => {
    if (pos.y > 96 || pos.y === 96) return { name: "air", boundingBox: "empty" } as Block;
    if (pos.y === 95) return { name: pos.x === 0 ? "farmland" : "grass_block", boundingBox: "block" } as Block;
    return { name: "dirt", boundingBox: "block" } as Block;
  };
  const bot = { blockAt } as unknown as Bot;
  const reserved = new Set(["1,96,0", "-1,96,0"]);
  const spot = torchSpotNear(bot, { x: 0, z: 0 }, reserved);
  assert.ok(spot !== null);
  assert.notEqual(spot.position.x, 0, "not on farmland");
  assert.ok(!reserved.has(`${spot.position.x},${spot.position.y},${spot.position.z}`), "not in the build");
  assert.equal(spot.position.y, 96);
  assert.equal(spot.reference.name, "grass_block");
});
