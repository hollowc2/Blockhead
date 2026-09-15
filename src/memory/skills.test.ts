import assert from "node:assert/strict";
import { test } from "node:test";
import { AppDatabase } from "./database.js";
import { MIGRATIONS } from "./migrations.js";
import { SkillsRepository, type SkillSuccess } from "./skills.js";

function newHarness(): { skills: SkillsRepository; close: () => void } {
  const db = new AppDatabase(":memory:");
  db.runMigrations(MIGRATIONS);
  const skills = new SkillsRepository(db);
  return { skills, close: () => db.close() };
}

function success(name: string, parameters: Record<string, unknown>, description: string): Omit<SkillSuccess, "id" | "createdAt"> {
  return {
    skillName: name,
    parameters,
    startingConditions: { inventorySummary: {}, homeDistance: 12 },
    outcome: { durationMs: 1000, interruptions: 0, finalInventoryDelta: {} },
    description,
  };
}

test("recent() returns recorded runs newest-first with JSON fields parsed back", () => {
  const h = newHarness();
  try {
    h.skills.record(success("collect_resource", { resource: "oak_log", quantity: 32 }, "first"));
    h.skills.record(success("gather_food", { quantity: 12 }, "second"));

    const rows = h.skills.recent({ limit: 10 });
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.skillName, "gather_food", "newest insert first (rowid tiebreak)");
    assert.equal(rows[1]!.skillName, "collect_resource");
    assert.deepEqual(rows[1]!.parameters, { resource: "oak_log", quantity: 32 });
    assert.equal(rows[1]!.startingConditions.homeDistance, 12);
    assert.equal(rows[0]!.outcome.durationMs, 1000);
    assert.ok(rows[0]!.createdAt.length > 0);
  } finally {
    h.close();
  }
});

test("recent({ skillName }) filters and recent({ limit }) trims", () => {
  const h = newHarness();
  try {
    for (let i = 1; i <= 3; i++) {
      h.skills.record(success("collect_resource", { resource: "stone", quantity: i }, `run ${i}`));
    }
    h.skills.record(success("gather_food", { quantity: 8 }, "food run"));

    const only = h.skills.recent({ skillName: "collect_resource", limit: 10 });
    assert.equal(only.length, 3);
    assert.equal(only[0]!.parameters.quantity, 3);

    const trimmed = h.skills.recent({ limit: 2 });
    assert.equal(trimmed.length, 2);
    assert.equal(trimmed[0]!.skillName, "gather_food");
    assert.equal(trimmed[1]!.parameters.quantity, 3);
  } finally {
    h.close();
  }
});

test("recent() on an empty library returns an empty list", () => {
  const h = newHarness();
  try {
    assert.deepEqual(h.skills.recent(), []);
  } finally {
    h.close();
  }
});