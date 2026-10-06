import assert from "node:assert/strict";
import { test } from "node:test";
import { compileBuildingDesign } from "./compiler.js";
import { VILLAGE_ORDER, VILLAGE_SITE, villageDesign, type VillageBuilding } from "./village.js";

const KINDS: VillageBuilding[] = ["cottage", "storage_shed", "barn", "windmill", "watchtower"];
const ORIGIN = { x: 0, y: 64, z: 0, dimension: "overworld" };

test("every village building compiles and fits its 7x7 site", () => {
  for (const kind of KINDS) {
    const blueprint = compileBuildingDesign(villageDesign(kind), ORIGIN);
    assert.ok(blueprint.operations.length > 20, `${kind}: ${blueprint.operations.length} blocks`);
    for (const op of blueprint.operations) {
      assert.ok(op.x >= 0 && op.x < VILLAGE_SITE && op.z >= 0 && op.z < VILLAGE_SITE, `${kind} block at ${op.x},${op.z} leaves the site`);
    }
  }
  assert.ok(VILLAGE_ORDER.every((kind) => KINDS.includes(kind)));
});

test("every block in build order rests on the ground or a block already placed", () => {
  // Survival placement needs a neighbor to click against; a peaked roof's
  // upper rings and an overhanging cap have none.
  for (const kind of KINDS) {
    const blueprint = compileBuildingDesign(villageDesign(kind), ORIGIN);
    const placed = new Set<string>();
    for (const op of blueprint.operations) {
      if (op.replaceExisting) continue;
      const neighbors = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
      const supported = op.y === 0 || neighbors.some(([dx, dy, dz]) => placed.has(`${op.x + dx!},${op.y + dy!},${op.z + dz!}`));
      assert.ok(supported, `${kind}: ${op.material} at ${op.x},${op.y},${op.z} has nothing to rest on`);
      placed.add(`${op.x},${op.y},${op.z}`);
    }
  }
});

test("village buildings use only materials the bot can make", () => {
  const makeable = /^(oak_planks|birch_planks|cobblestone|oak_log|oak_fence|oak_door)$/;
  for (const kind of KINDS) {
    const { estimates } = compileBuildingDesign(villageDesign(kind), ORIGIN);
    for (const material of Object.keys(estimates.materials)) assert.match(material, makeable, `${kind} needs ${material}`);
  }
});

test("no village block is out of reach from the ground", async () => {
  // 18:17 (2026-10-05): the first windmill's sail at +7, out in front of
  // its tower, could not be reached and the build looped for ten minutes.
  const { VILLAGE_MAX_HEIGHT } = await import("./village.js");
  for (const kind of KINDS) {
    for (const op of compileBuildingDesign(villageDesign(kind), ORIGIN).operations) {
      assert.ok(op.y <= VILLAGE_MAX_HEIGHT, `${kind}: ${op.material} at height ${op.y}`);
    }
  }
});
