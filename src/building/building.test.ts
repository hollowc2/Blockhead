import test from "node:test";
import assert from "node:assert/strict";
import { BuildingDesignSchema } from "./schema.js";
import { compileBuildingDesign } from "./compiler.js";
import { landmarkTemplate, recognizeLandmark } from "./templates.js";
import { validateBuildingDesign } from "./validation.js";

const origin = { x: 10, y: 64, z: -4, dimension: "overworld" };
test("schema accepts composed designs and rejects unsupported primitives", () => {
  const design = landmarkTemplate("castle", "small");
  assert.equal(BuildingDesignSchema.safeParse(design).success, true);
  assert.equal(BuildingDesignSchema.safeParse({ ...design, components: [{ type: "javascript" }] }).success, false);
});

test("compiler is deterministic and deduplicates stable coordinates", () => {
  const design = landmarkTemplate("mansion", "small");
  const a = compileBuildingDesign(design, origin);
  const b = compileBuildingDesign(design, origin);
  assert.deepEqual(a.operations, b.operations);
  assert.equal(new Set(a.operations.map((op) => `${op.x},${op.y},${op.z}`)).size, a.operations.length);
  assert.ok(a.operations.every((op) => op.id.startsWith("op-")));
});

test("Pentagon template has nested rings, courtyard space, and corridor geometry", () => {
  const blueprint = compileBuildingDesign(landmarkTemplate("pentagon_complex", "small"), origin);
  assert.ok(blueprint.operations.length > 100);
  assert.ok(blueprint.footprint.width >= 20);
  assert.ok(blueprint.operations.some((op) => op.phase === "doors_windows"));
  const center = blueprint.operations.filter((op) => Math.abs(op.x) < 3 && Math.abs(op.z) < 3);
  assert.ok(center.length < blueprint.operations.length / 12, "central courtyard remains mostly open");
  assert.ok(new Set(blueprint.operations.filter((op) => op.y === 0).map((op) => Math.abs(op.x) + Math.abs(op.z))).size > 4, "ring outline is not a square");
});

test("bundled tube template produces setback heights", () => {
  const blueprint = compileBuildingDesign(landmarkTemplate("bundled_tube_skyscraper", "medium"), origin);
  const heights = new Set(blueprint.operations.filter((op) => op.material === "stone_bricks").map((op) => op.y));
  assert.ok(heights.size > 10);
  assert.ok(blueprint.operations.some((op) => op.material === "glass"));
});

test("recognizes obvious landmarks without the LLM", () => {
  assert.equal(recognizeLandmark("build the Pentagon"), "pentagon_complex");
  assert.equal(recognizeLandmark("build a Sears Tower-inspired skyscraper"), "bundled_tube_skyscraper");
  assert.equal(recognizeLandmark("build a futuristic glass museum"), "museum");
});

test("limits and material validation fail closed", () => {
  const design = landmarkTemplate("castle", "small");
  assert.throws(() => validateBuildingDesign({ ...design, components: [{ ...design.components[0], material: "tnt" }] }));
  assert.throws(() => compileBuildingDesign(design, origin, { maxWidth: 4, maxDepth: 4, maxHeight: 4, maxOperations: 10, maxComponents: 64, maxNestingDepth: 4, maxAnchorDistance: 128, allowedMaterials: ["stone_bricks"], allowDemolition: false }));
});
