import assert from "node:assert/strict";
import { test } from "node:test";
import { AppDatabase } from "./database.js";
import { MIGRATIONS } from "./migrations.js";
import { WorldProjectsRepository, type WorldProject } from "./world-projects.js";
import { BuildProjectsRepository } from "./build-projects.js";
import { landmarkTemplate } from "../building/templates.js";

test("world project envelopes and phases survive a repository round trip", () => {
  const db = new AppDatabase(":memory:");
  db.runMigrations(MIGRATIONS);
  try {
    const repo = new WorldProjectsRepository(db);
    const project: WorldProject = { id: "terrain-1", kind: "excavate", userGoal: "dig", source: "user", status: "active", world: "server-world", dimension: "overworld", geometryHash: "hash", payload: { type: "terrain", plan: { planVersion: 1, world: "server-world", dimension: "overworld", anchor: { x: 0, y: 64, z: 0, dimension: "overworld" }, bounds: { minX: 0, maxX: 1, minY: 60, maxY: 64, minZ: 0, maxZ: 1 }, specification: { kind: "excavate", anchor: "owner", width: 2, length: 2, depth: 5 }, geometryHash: "hash" } }, resumeState: {}, verificationState: {}, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
    repo.create(project, [{ id: "terrain-1:0", projectId: project.id, ordinal: 0, label: "slice", status: "active", progress: {}, attempts: 1 }]);
    assert.deepEqual(repo.get(project.id), project);
    assert.equal(repo.getPhases(project.id)[0]?.label, "slice");
  } finally { db.close(); }
});

test("v17 build rows are copied into the generic envelope during migration", () => {
  const db = new AppDatabase(":memory:");
  db.runMigrations(MIGRATIONS.slice(0, 17));
  try {
    const builds = new BuildProjectsRepository(db);
    const design = landmarkTemplate("castle", "small");
    const project = {
      id: "build-legacy", userGoal: "build", structureType: "castle", source: "user" as const, status: "active" as const,
      design, origin: { x: 1, y: 64, z: 2, dimension: "overworld" }, compilerVersion: "c", schemaVersion: "s", blueprintHash: "legacy-hash",
      blueprint: { origin: { x: 1, y: 64, z: 2, dimension: "overworld" }, operations: [], estimates: { blocks: 0, materials: {} }, footprint: { width: 1, depth: 1, height: 1 } },
      requiredResources: {}, shortages: [], resumeState: { currentOperationIndex: 0, completedRanges: [], interruptedCount: 0 }, verificationState: { verifiedOperations: 0, totalOperations: 0, finalVerificationPassed: false },
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    };
    builds.create(project);
    db.runMigrations(MIGRATIONS);
    const envelope = new WorldProjectsRepository(db).get("build-legacy");
    assert.equal(envelope?.kind, "build");
    assert.equal(envelope?.geometryHash, "legacy-hash");
    assert.equal(envelope?.payload.type, "build");
  } finally { db.close(); }
});

test("v16 build rows migrate idempotently after the v17 task columns are added", () => {
  const db = new AppDatabase(":memory:");
  db.runMigrations(MIGRATIONS.slice(0, 16));
  try {
    const builds = new BuildProjectsRepository(db);
    const design = landmarkTemplate("castle", "small");
    builds.create({
      id: "build-v16", userGoal: "build", structureType: "castle", source: "user", status: "active",
      design, origin: { x: 4, y: 64, z: 5, dimension: "overworld" }, compilerVersion: "c", schemaVersion: "s", blueprintHash: "v16-hash",
      blueprint: { origin: { x: 4, y: 64, z: 5, dimension: "overworld" }, operations: [], estimates: { blocks: 0, materials: {} }, footprint: { width: 1, depth: 1, height: 1 } },
      requiredResources: {}, shortages: [], resumeState: { currentOperationIndex: 0, completedRanges: [], interruptedCount: 0 },
      verificationState: { verifiedOperations: 0, totalOperations: 0, finalVerificationPassed: false },
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    });
    db.runMigrations(MIGRATIONS);
    db.runMigrations(MIGRATIONS);
    const envelope = new WorldProjectsRepository(db).get("build-v16");
    assert.equal(envelope?.kind, "build");
    assert.equal(envelope?.geometryHash, "v16-hash");
    const count = db.sql.prepare("SELECT COUNT(*) AS count FROM world_projects WHERE id = ?").get("build-v16") as { count: number } | undefined;
    assert.equal(count?.count, 1);
  } finally { db.close(); }
});
