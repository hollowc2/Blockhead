import assert from "node:assert/strict";
import { test } from "node:test";
import { AppDatabase } from "./database.js";
import { MIGRATIONS } from "./migrations.js";
import { BackgroundFailuresRepository } from "./background-failures.js";

test("background failure cooldowns round-trip across repository instances", () => {
  const db = new AppDatabase(":memory:");
  db.runMigrations(MIGRATIONS);
  try {
    const first = new BackgroundFailuresRepository(db);
    first.upsert({ action: "resource:coal", failedAt: 1_000, retryAt: 61_000, reason: "no ore" });

    const second = new BackgroundFailuresRepository(db);
    assert.deepEqual(second.loadAll(), [
      { action: "resource:coal", failedAt: 1_000, retryAt: 61_000, reason: "no ore" },
    ]);
    second.remove("resource:coal");
    assert.deepEqual(first.loadAll(), []);
  } finally {
    db.close();
  }
});
