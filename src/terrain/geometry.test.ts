import { deepStrictEqual, equal, rejects, throws } from "node:assert/strict";
import test from "node:test";
import { deterministicSerpentine, mineshaftSegment, resolveExcavationBounds, resolveFootprintBounds, resolveOwnerFrontBounds, snapCardinalYaw } from "./geometry.js";
import { ExcavateVolumeSpecSchema, MineshaftSpecSchema, terrainGeometryHash } from "./schema.js";

const anchor = { x: 0, y: 10, z: 0, dimension: "overworld" };

test("footprints use the existing negative bias for even dimensions", () => {
  deepStrictEqual(resolveFootprintBounds(anchor, 10, 10, 10, 10), { minX: -5, maxX: 4, minY: 10, maxY: 10, minZ: -5, maxZ: 4 });
  deepStrictEqual(resolveFootprintBounds(anchor, 3, 5, 10, 12), { minX: -2, maxX: 0, minY: 10, maxY: 12, minZ: -3, maxZ: 1 });
});

test("excavation bounds are an explicit range below the anchor", () => {
  deepStrictEqual(resolveExcavationBounds(anchor, 10, 10, 5), { minX: -5, maxX: 4, minY: 5, maxY: 9, minZ: -5, maxZ: 4 });
});

test("owner-front bounds retain one block of gap in the snapped direction", () => {
  const owner = { position: anchor, yaw: 0 };
  deepStrictEqual(resolveOwnerFrontBounds(owner, 4, 6, 10, 10), { minX: -2, maxX: 1, minY: 10, maxY: 10, minZ: 2, maxZ: 7 });
  deepStrictEqual(resolveOwnerFrontBounds({ position: anchor, yaw: Math.PI }, 4, 6, 10, 10), { minX: -2, maxX: 1, minY: 10, maxY: 10, minZ: -7, maxZ: -2 });
});

test("cardinal yaw snapping follows Mineflayer's 0=south convention", () => {
  equal(snapCardinalYaw(0), "south");
  equal(snapCardinalYaw(Math.PI / 2), "west");
  equal(snapCardinalYaw(Math.PI), "north");
  equal(snapCardinalYaw(-Math.PI / 2), "east");
});

test("owner-front geometry rejects malformed owner yaw", () => {
  rejects(async () => { snapCardinalYaw(Number.NaN); }, /finite/);
});

test("mineshaft segments descend one walking level per forward segment", () => {
  deepStrictEqual(mineshaftSegment(anchor, "south", 2, 3, 4), { minX: -1, maxX: 0, minY: 7, maxY: 9, minZ: 4, maxZ: 4 });
});

test("serpentine traversal is deterministic and reverses each row", () => {
  deepStrictEqual([...deterministicSerpentine({ minX: 0, maxX: 1, minY: 0, maxY: 0, minZ: 0, maxZ: 1 })], [
    { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 1, y: 0, z: 1 }, { x: 0, y: 0, z: 1 },
  ]);
});

test("terrain schemas enforce volume and mineshaft XOR limits", () => {
  throws(() => ExcavateVolumeSpecSchema.parse({ kind: "excavate", anchor: "owner", width: 32, length: 32, depth: 9 }), /8192/);
  throws(() => MineshaftSpecSchema.parse({ kind: "mineshaft", anchor: "owner_front", width: 1, height: 2 }), /exactly one/);
  throws(() => MineshaftSpecSchema.parse({ kind: "mineshaft", anchor: "owner_front", width: 1, height: 2, targetY: -40, depth: 30 }), /exactly one/);
  equal(MineshaftSpecSchema.parse({ kind: "mineshaft", anchor: "owner_front", width: 2, height: 3, targetY: -40 }).targetY, -40);
});

test("geometry hashes use canonical frozen fields and ignore runtime fields", () => {
  const base = { world: "world-1", dimension: "minecraft:overworld", anchor, bounds: resolveExcavationBounds(anchor, 2, 2, 2), specification: { kind: "excavate" as const, anchor: "owner" as const, width: 2, length: 2, depth: 2 } };
  const equivalent = { ...base, dimension: "overworld", specification: { depth: 2, length: 2, width: 2, anchor: "owner" as const, kind: "excavate" as const }, runtimeCursor: 99 };
  equal(terrainGeometryHash(base), terrainGeometryHash(equivalent));
});
