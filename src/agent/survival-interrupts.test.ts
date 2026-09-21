import assert from "node:assert/strict";
import { test } from "node:test";
import { EventBus } from "../events/bus.js";
import { AppDatabase } from "../memory/database.js";
import { MIGRATIONS } from "../memory/migrations.js";
import { TasksRepository } from "../memory/tasks.js";
import { WorldProjectsRepository } from "../memory/world-projects.js";
import { createFrozenTerrainPlan } from "../terrain/schema.js";
import { ActionWatchdog } from "./watchdog.js";
import { Scheduler } from "./scheduler.js";
import { WorldProjectManager } from "./world-projects.js";
import { SurvivalInterruptCoordinator } from "./survival-interrupts.js";
import { DestructiveAuthorizationRegistry } from "../policy/destructive-authorization.js";

function harness(): { bus: EventBus; scheduler: Scheduler; projects: WorldProjectManager; db: AppDatabase; authorizations: DestructiveAuthorizationRegistry } {
  const db = new AppDatabase(":memory:");
  db.runMigrations(MIGRATIONS);
  const bus = new EventBus();
  const scheduler = new Scheduler({ bus, tasks: new TasksRepository(db), watchdog: new ActionWatchdog() });
  const authorizations = new DestructiveAuthorizationRegistry();
  const projects = new WorldProjectManager(new WorldProjectsRepository(db), scheduler, bus, authorizations, () => 7);
  return { bus, scheduler, projects, db, authorizations };
}

function plan() {
  return createFrozenTerrainPlan({
    world: "world", dimension: "overworld", anchor: { x: 0, y: 64, z: 0, dimension: "overworld" },
    bounds: { minX: 0, maxX: 1, minY: 63, maxY: 63, minZ: 0, maxZ: 1 },
    specification: { kind: "excavate", anchor: "owner", width: 2, length: 2, depth: 1 },
  });
}

test("inventory pressure pauses a terrain slice and schedules one linked deposit", () => {
  const h = harness();
  const coordinator = new SurvivalInterruptCoordinator({ bus: h.bus, scheduler: h.scheduler, projects: h.projects });
  const created = h.projects.createTerrainProject({ userGoal: "excavate", source: "user", plan: plan() });
  h.scheduler.claim();
  h.bus.emit("inventory.full", { freeSlots: 0 });
  assert.equal(h.scheduler.interruptPending, true);
  const deposit = h.scheduler.queued.find((task) => task.type === "world_project_deposit");
  assert.equal(deposit?.projectId, created.project.id);
  coordinator.dispose();
  h.db.close();
});

test("tool break requests a replacement child instead of another terrain slice", () => {
  const h = harness();
  const coordinator = new SurvivalInterruptCoordinator({ bus: h.bus, scheduler: h.scheduler, projects: h.projects });
  h.projects.createTerrainProject({ userGoal: "excavate", source: "user", plan: plan() });
  h.scheduler.claim();
  h.bus.emit("tool.broken", { item: "iron_pickaxe", durability: 0 });
  const replacement = h.scheduler.queued.find((task) => task.type === "world_project_replace_tool");
  assert.equal(replacement?.parameters.item, "iron_pickaxe");
  coordinator.dispose();
  h.db.close();
});

test("terrain authorization becomes dormant at a checkpoint and is reissued on resume", () => {
  const h = harness();
  const created = h.projects.createTerrainProject({ userGoal: "excavate", source: "user", plan: plan() });
  const task = created.task;
  assert.equal(h.authorizations.get(task.id)?.state, "active");
  h.scheduler.claim();
  h.scheduler.requestPause();
  h.scheduler.settleInterrupted();
  assert.equal(h.authorizations.get(task.id)?.state, "dormant");
  h.scheduler.claim();
  assert.equal(h.authorizations.get(task.id)?.state, "active");
  h.db.close();
});
