import assert from "node:assert/strict";
import { test } from "node:test";
import { EventBus } from "../events/bus.js";
import { AppDatabase } from "../memory/database.js";
import { MIGRATIONS } from "../memory/migrations.js";
import { WorldProjectsRepository } from "../memory/world-projects.js";
import { TasksRepository } from "../memory/tasks.js";
import { Scheduler } from "../agent/scheduler.js";
import { WorldProjectManager } from "../agent/world-projects.js";
import { ToolRegistry } from "./registry.js";
import { registerTerrainTools } from "./terrain.js";

function harness(): { registry: ToolRegistry; scheduler: Scheduler; manager: WorldProjectManager; close: () => void } {
  const db = new AppDatabase(":memory:");
  db.runMigrations(MIGRATIONS);
  const bus = new EventBus();
  const scheduler = new Scheduler({ bus, tasks: new TasksRepository(db) });
  const manager = new WorldProjectManager(new WorldProjectsRepository(db), scheduler, bus);
  const registry = new ToolRegistry();
  registerTerrainTools(registry, scheduler, manager);
  return { registry, scheduler, manager, close: () => db.close() };
}

const context = (scheduler: Scheduler, manager: WorldProjectManager, bot: unknown) => ({
  bot, scheduler, worldProjects: manager, state: { worldId: 7, home: { x: 10, y: 64, z: -4, dimension: "overworld" } },
  config: { agent: { owner: "Corey" }, server: { world_key: "test-world" } },
} as never);

test("terrain tools expose exactly four bounded operations", () => {
  const h = harness();
  try { assert.deepEqual(h.registry.names(), ["clear_area", "flatten_area", "excavate_volume", "dig_mineshaft"]); }
  finally { h.close(); }
});

test("excavate tool freezes exact geometry and creates a terrain child task", () => {
  const h = harness();
  try {
    const bot = { entity: { position: { x: 0.5, y: 70.5, z: 0.5 } }, game: { dimension: "overworld" }, players: {} };
    const reply = h.registry.get("excavate_volume")!.handler({ width: 10, length: 10, depth: 5, anchor: "home" }, context(h.scheduler, h.manager, bot));
    assert.match(String(reply), /bounds 5,59,-9 to 14,63,0/);
    assert.equal(h.scheduler.active?.type, "world_project_slice");
    const project = h.manager.currentWorldProject()?.project;
    assert.equal(project?.kind, "excavate");
    assert.equal(project?.payload.type, "terrain");
    if (project?.payload.type === "terrain") assert.deepEqual(project.payload.plan.bounds, { minX: 5, maxX: 14, minY: 59, maxY: 63, minZ: -9, maxZ: 0 });
  } finally { h.close(); }
});

test("owner-front mineshaft rejects an absent owner instead of guessing", () => {
  const h = harness();
  try {
    const bot = { entity: null, game: { dimension: "overworld" }, players: {} };
    const reply = h.registry.get("dig_mineshaft")!.handler({ depth: 30, anchor: "owner_front" }, context(h.scheduler, h.manager, bot));
    assert.match(String(reply), /owner Corey is not currently visible/);
    assert.equal(h.scheduler.active, null);
  } finally { h.close(); }
});

test("clear defaults to the owner-facing footprint, outside the owner's safety buffer", () => {
  const h = harness();
  try {
    const bot = {
      game: { dimension: "overworld" },
      // Mineflayer yaw PI faces south (+Z).
      players: { Corey: { entity: { position: { x: 0.5, y: 64, z: 0.5 }, yaw: Math.PI } } },
    };
    const reply = h.registry.get("clear_area")!.handler({ width: 5, length: 5 }, context(h.scheduler, h.manager, bot));
    assert.match(String(reply), /bounds -3,64,2 to 1,67,6/);
    const project = h.manager.currentWorldProject()?.project;
    if (project?.payload.type === "terrain") assert.deepEqual(project.payload.plan.bounds, { minX: -3, maxX: 1, minY: 64, maxY: 67, minZ: 2, maxZ: 6 });
    else assert.fail("expected clear terrain project");
  } finally { h.close(); }
});

test("terrain schemas reject oversized and XOR-invalid requests", () => {
  const h = harness();
  try {
    assert.throws(() => h.registry.validateArgs("excavate_volume", { width: 32, length: 32, depth: 9 }));
    assert.throws(() => h.registry.validateArgs("dig_mineshaft", { depth: 3, targetY: 10 }));
    assert.throws(() => h.registry.validateArgs("dig_mineshaft", {}));
  } finally { h.close(); }
});

test("an owner-front mineshaft starts level with the ground the owner stands on", () => {
  const h = harness();
  try {
    const bot = {
      game: { dimension: "overworld" },
      // Owner feet at y=64 (standing on the y=63 ground), facing south.
      players: { Corey: { entity: { position: { x: 0.5, y: 64, z: 0.5 }, yaw: Math.PI } } },
    };
    h.registry.get("dig_mineshaft")!.handler({ targetY: 60, anchor: "owner_front" }, context(h.scheduler, h.manager, bot));
    const project = h.manager.currentWorldProject()?.project;
    if (project?.payload.type !== "terrain") return assert.fail("expected mineshaft terrain project");
    const plan = project.payload.plan;
    assert.equal(plan.anchor.y, 63, "segment 0's floor is the owner's ground block");
    assert.deepEqual({ z: plan.anchor.z, minY: plan.bounds.minY, maxY: plan.bounds.maxY }, { z: 2, minY: 59, maxY: 65 });
  } finally { h.close(); }
});
