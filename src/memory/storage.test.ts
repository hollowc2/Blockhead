import assert from "node:assert/strict";
import { test } from "node:test";
import { AppDatabase } from "./database.js";
import { MIGRATIONS } from "./migrations.js";
import { StorageRepository } from "./storage.js";

test("a chest's last reading survives a new repository (a restart)", () => {
  const db = new AppDatabase(":memory:");
  db.runMigrations(MIGRATIONS);
  try {
    const worldId = (db.sql.prepare("INSERT INTO worlds (server_key, world_key, created_at) VALUES ('t', 'w', ?) RETURNING id").get(new Date().toISOString()) as { id: number }).id;
    const repo = new StorageRepository(db);
    const chest = repo.register(worldId, { dimension: "overworld", category: "general", x: 64, y: 96, z: 52 });
    assert.equal(chest.lastContents, undefined);
    repo.rememberContents(worldId, chest.id, { coal: 52, charcoal: 14 });
    assert.deepEqual(new StorageRepository(db).list(worldId)[0]?.lastContents, { coal: 52, charcoal: 14 });
  } finally {
    db.close();
  }
});
