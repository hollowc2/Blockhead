import assert from "node:assert/strict";
import { test } from "node:test";
import { BootstrapRunner, groundLevelAt, isNearAnySite, isNearSurfaceElevation, isUsableStoneRelocation, maxWoolColorCount, stoneExplorationSites } from "./bootstrap-survival.js";
import { BootstrapStage, nextBootstrapStage } from "../agent/bootstrap.js";
import { Vec3 } from "vec3";

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

test("a blocked bootstrap remains resumable from its last completed stage", () => {
  const runner = new BootstrapRunner({
    state: { worldId: 9 },
    stages: {
      get: () => BootstrapStage.CRAFTING,
      getState: () => ({ stage: BootstrapStage.CRAFTING, status: "blocked" }),
    },
  } as any);

  assert.equal(runner.currentStage, BootstrapStage.STONE_TOOLS);
});

test("stone exploration sites are bounded and meaningfully separated", () => {
  const home = { x: -61, y: 63, z: -11 };
  const sites = stoneExplorationSites(home);
  assert.equal(sites.length, 7);
  for (const site of sites) {
    assert.ok(Math.hypot(site.x - home.x, site.z - home.z) <= 96);
  }
  for (let a = 1; a < sites.length; a++) {
    for (let b = a + 1; b < sites.length; b++) {
      assert.ok(Math.hypot(sites[a]!.x - sites[b]!.x, sites[a]!.z - sites[b]!.z) >= 32);
    }
  }
});

test("a flooded first hole is excluded from subsequent site selection", () => {
  const sites = stoneExplorationSites({ x: 0, y: 64, z: 0 });
  const flooded = [{ x: sites[1]!.x, z: sites[1]!.z, reason: "trench exposed water" }];
  assert.equal(isNearAnySite(sites[1]!, flooded, 24), true);
  assert.equal(isNearAnySite(sites[2]!, flooded, 24), false);
});

test("all bounded stone sites can be exhausted without repeating a failed route", () => {
  const sites = stoneExplorationSites({ x: 0, y: 64, z: 0 });
  const failed = sites.slice(1, 4).map((site, index) => ({ x: site.x, z: site.z, reason: `hazard-${index}` }));
  assert.deepEqual(
    sites.slice(1).filter((site) => !isNearAnySite(site, failed, 24)).map((site) => [site.x, site.z]),
    sites.slice(4).map((site) => [site.x, site.z]),
  );
});

test("a partial route endpoint is rescanned only when bounded and separated", () => {
  const home = { x: 0, z: 0 };
  const visited = [{ x: 0, z: 0 }, { x: 40, z: 0 }];
  assert.equal(isUsableStoneRelocation({ x: 0, z: 40 }, home, visited), true);
  assert.equal(isUsableStoneRelocation({ x: 20, z: 0 }, home, visited), false);
  assert.equal(isUsableStoneRelocation({ x: 97, z: 0 }, home, visited), false);
});

test("surface stone search excludes deep cave faces", () => {
  assert.equal(isNearSurfaceElevation({ y: 63 }, { y: 64 }), true);
  assert.equal(isNearSurfaceElevation({ y: 57 }, { y: 63 }), true);
  assert.equal(isNearSurfaceElevation({ y: 40 }, { y: 64 }), false);
});

function columnBot(column: Record<number, string>, feet: { x: number; y: number; z: number } | null = null) {
  const block = (name: string) => ({ name, boundingBox: name === "air" || name === "torch" ? "empty" : "block", hardness: 1 });
  const position = feet && { ...feet, floored: () => new Vec3(feet.x, feet.y, feet.z) };
  return {
    entity: position && { position },
    blockAt: (v: Vec3) => block(v.x === 0 && v.z === 0 ? column[v.y] ?? (v.y < 90 ? "stone" : "air") : "air"),
  } as never;
}

test("home ground level ignores a roof built over the home column", () => {
  const house = { 95: "dirt", 96: "oak_planks", 101: "oak_planks", 102: "torch" };
  assert.equal(groundLevelAt(columnBot(house), 0, 0), 97);
  assert.equal(groundLevelAt(columnBot(house, { x: 0, y: 97, z: 0 }), 0, 0), 97, "standing inside the house counts");
  assert.equal(groundLevelAt(columnBot({ ...house, 100: "oak_planks" }), 0, 0), 97, "a two-layer roof is still a roof");
});

test("home ground level still lands on natural overhangs and plank floors", () => {
  assert.equal(groundLevelAt(columnBot({ 95: "dirt", 101: "stone" }), 0, 0), 102);
  assert.equal(groundLevelAt(columnBot({ 95: "dirt", 96: "oak_planks" }), 0, 0), 97);
});
