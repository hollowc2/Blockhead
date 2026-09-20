import test from "node:test";
import assert from "node:assert/strict";
import { BuildingDesignSchema } from "./schema.js";
import { BUILDING_COMPILER_VERSION, DEFAULT_BLUEPRINT_CHUNK_SIZE, compileBuildingDesign, createBlueprintPhases } from "./compiler.js";
import { landmarkTemplate, recognizeLandmark } from "./templates.js";
import { validateBuildingDesign } from "./validation.js";

const origin = { x: 10, y: 64, z: -4, dimension: "overworld" };
test("schema accepts composed designs and rejects unsupported primitives", () => {
  const design = landmarkTemplate("castle", "small");
  assert.equal(BuildingDesignSchema.safeParse(design).success, true);
  assert.equal(BuildingDesignSchema.safeParse({ ...design, components: [{ type: "javascript" }] }).success, false);
});

test("compiler is deterministic and deduplicates coordinates within each phase", () => {
  const design = landmarkTemplate("mansion", "small");
  const a = compileBuildingDesign(design, origin);
  const b = compileBuildingDesign(design, origin);
  assert.deepEqual(a.operations, b.operations);
  assert.equal(new Set(a.operations.map((op) => `${op.phase}:${op.x},${op.y},${op.z}`)).size, a.operations.length);
  assert.ok(a.operations.every((op) => op.id.startsWith("op-")));
});

test("compiler freezes versions, provenance, absolute targets, hash, and deterministic chunks", () => {
  const design = landmarkTemplate("castle", "small");
  const blueprint = compileBuildingDesign(design, origin);
  const repeat = compileBuildingDesign(design, origin);
  assert.equal(blueprint.compilerVersion, BUILDING_COMPILER_VERSION);
  assert.equal(blueprint.schemaVersion, "1.0.0");
  assert.equal(blueprint.hash, repeat.hash);
  assert.deepEqual(blueprint.phases, repeat.phases);
  assert.ok(blueprint.operations.every((operation) => operation.componentId !== undefined));
  assert.deepEqual(blueprint.operations[0]?.absolute, { x: origin.x + blueprint.operations[0]!.x, y: origin.y + blueprint.operations[0]!.y, z: origin.z + blueprint.operations[0]!.z, dimension: origin.dimension });
  assert.ok(blueprint.phases!.length > 1);
  assert.ok(blueprint.phases!.every((phase) => phase.operationEnd - phase.operationStart <= DEFAULT_BLUEPRINT_CHUNK_SIZE));
});

test("castle door replacements retain bottom-up structural support", () => {
  const blueprint = compileBuildingDesign(landmarkTemplate("castle", "small"), origin);
  const indexByCell = new Map(blueprint.operations.map((operation, index) => [operation, index] as const)
    .filter(([operation]) => operation.phase === "structural_shell")
    .map(([operation, index]) => [`${operation.x},${operation.y},${operation.z}`, index]));
  const doorCells = blueprint.operations.filter((operation) => operation.phase === "doors_windows");
  assert.ok(doorCells.length > 0);
  for (const door of doorCells) {
    const support = blueprint.operations.find((operation) => operation.phase === "structural_shell" && operation.x === door.x && operation.y === door.y && operation.z === door.z);
    assert.ok(support, `replacement at ${door.x},${door.y},${door.z} retains its structural cell`);
    assert.ok(blueprint.operations.indexOf(support!) < blueprint.operations.indexOf(door));
  }
  const upperGate = blueprint.operations.find((operation) => operation.phase === "structural_shell" && operation.x === 0 && operation.y === 3 && operation.z === 0)!;
  assert.ok((indexByCell.get(`${upperGate.x},${upperGate.y - 1},${upperGate.z}`) ?? Infinity) < blueprint.operations.indexOf(upperGate));
});

test("legacy designs receive stable component IDs and chunk boundaries respect compiler phases", () => {
  const legacy = { ...landmarkTemplate("mansion", "small"), components: landmarkTemplate("mansion", "small").components.map(({ id: _id, ...component }) => component) };
  const parsed = BuildingDesignSchema.parse(legacy);
  assert.deepEqual(parsed.components.slice(0, 2).map((component) => component.id), ["component-001", "component-002"]);
  const blueprint = compileBuildingDesign(parsed, origin);
  for (const phase of blueprint.phases!) {
    assert.equal(new Set(blueprint.operations.slice(phase.operationStart, phase.operationEnd).map((operation) => operation.phase)).size, 1);
  }
  assert.deepEqual(createBlueprintPhases(blueprint.operations, 7), createBlueprintPhases(blueprint.operations, 7));
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
