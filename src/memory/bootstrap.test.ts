import assert from "node:assert/strict";
import { test } from "node:test";
import { BootstrapStage } from "../agent/bootstrap.js";
import { BootstrapRepository } from "./bootstrap.js";
import { AppDatabase } from "./database.js";
import { MIGRATIONS } from "./migrations.js";

function insertWorld(db: AppDatabase): number {
  const row = db.sql.prepare(
    "INSERT INTO worlds (server_key, world_key, created_at) VALUES ('test', 'world', ?) RETURNING id",
  ).get(new Date().toISOString()) as { id: number };
  return row.id;
}

test("stone bootstrap progress survives repository recreation and clears on stage completion", () => {
  const db = new AppDatabase(":memory:");
  db.runMigrations(MIGRATIONS);
  try {
    const worldId = insertWorld(db);
    const repo = new BootstrapRepository(db);
    repo.save(worldId, BootstrapStage.CRAFTING);
    repo.saveProgress(worldId, {
      kind: "stone_tools",
      nextSite: 2,
      mineAttempts: 1,
      visitedSites: [{ x: 40, z: 0 }],
      failedSites: [{ x: 40, z: 0, reason: "trench exposed water" }],
    });

    const restarted = new BootstrapRepository(db).getState(worldId);
    assert.equal(restarted.stage, BootstrapStage.CRAFTING);
    assert.equal(restarted.status, "active");
    assert.deepEqual(restarted.progress.failedSites, [{ x: 40, z: 0, reason: "trench exposed water" }]);

    repo.save(worldId, BootstrapStage.STONE_TOOLS);
    assert.deepEqual(repo.getState(worldId).progress, {});
  } finally { db.close(); }
});

test("blocking preserves the last completed stage and reports a distinct lifecycle", () => {
  const db = new AppDatabase(":memory:");
  db.runMigrations(MIGRATIONS);
  try {
    const worldId = insertWorld(db);
    const repo = new BootstrapRepository(db);
    repo.save(worldId, BootstrapStage.CRAFTING);
    repo.markBlocked(worldId, "stone_tools: bounded search exhausted");
    const state = repo.getState(worldId);
    assert.equal(state.stage, BootstrapStage.CRAFTING);
    assert.equal(state.status, "blocked");
    assert.match(state.failureCode ?? "", /bounded search exhausted/);
  } finally { db.close(); }
});

test("recording a retryable failure resets exhausted stage-local progress", () => {
  const db = new AppDatabase(":memory:");
  db.runMigrations(MIGRATIONS);
  try {
    const worldId = insertWorld(db);
    const repo = new BootstrapRepository(db);
    repo.save(worldId, BootstrapStage.CRAFTING);
    repo.saveProgress(worldId, { kind: "stone_tools", nextSite: 6 });
    repo.recordFailure(worldId, "stone_tools: bounded search exhausted", Date.now() + 30_000);
    repo.markBlocked(worldId, "stone_tools: bounded search exhausted");

    const state = repo.getState(worldId);
    assert.equal(state.status, "blocked");
    assert.deepEqual(state.progress, {});
  } finally { db.close(); }
});

test("v19 resumes legacy terminal stone failures from crafting", () => {
  const db = new AppDatabase(":memory:");
  db.runMigrations(MIGRATIONS.slice(0, 18));
  try {
    const worldId = insertWorld(db);
    db.sql.prepare(`INSERT INTO bootstrap_state
      (world_id, stage, updated_at, attempts, last_failure_code, retry_at)
      VALUES (?, 'blocked', ?, 3, 'stone_tools: surface stone exhausted: trench hit water', NULL)`)
      .run(worldId, new Date().toISOString());
    db.runMigrations(MIGRATIONS);
    const state = new BootstrapRepository(db).getState(worldId);
    assert.equal(state.stage, BootstrapStage.CRAFTING);
    assert.equal(state.status, "active");
    assert.equal(state.attempts, 0);
  } finally { db.close(); }
});
