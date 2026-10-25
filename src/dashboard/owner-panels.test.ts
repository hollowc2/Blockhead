import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, request } from "node:http";
import { EventBus } from "../events/bus.js";
import { AppDatabase } from "../memory/database.js";
import { MIGRATIONS } from "../memory/migrations.js";
import { TasksRepository } from "../memory/tasks.js";
import { GoalsRepository } from "../memory/goals.js";
import { StoryRepository } from "../memory/story.js";
import { Scheduler } from "../agent/scheduler.js";
import { GoalManager } from "../agent/goals.js";
import { TaskPriority, TaskStatus } from "../agent/task.js";
import { compileBuildingDesign } from "../building/compiler.js";
import { simpleStructureDesign } from "../tools/base.js";
import { CommandTracker, commandStatus, createJobControl, projectJobs } from "./jobs.js";
import { itemCondition, projectGearDetail, storedContents } from "./gear.js";
import { readHistory } from "./history.js";
import { StoryFeed } from "./story.js";
import { describePreview } from "./build-preview.js";
import { pathfinderDestination, readOwnerMap } from "./owner-map.js";
import { ViewerShellServer } from "./viewer-shell.js";
import { toPublicViewerState } from "./public-state.js";
import type { DashboardSnapshot } from "./types.js";

function harness() {
  const db = new AppDatabase(":memory:");
  db.runMigrations(MIGRATIONS);
  const bus = new EventBus();
  const tasks = new TasksRepository(db);
  const goalsRepo = new GoalsRepository(db);
  const scheduler = new Scheduler({ bus, tasks });
  const goals = new GoalManager({ bus, goals: goalsRepo, scheduler });
  return { db, bus, tasks, goalsRepo, scheduler, goals };
}

const gather = { type: "collect_resource", priority: TaskPriority.FOREGROUND, source: "user" as const, objective: "Gather 32 oak logs", parameters: { resource: "oak_log", quantity: 32 } };

test("jobs list live work with the controls that apply to each", () => {
  const { scheduler, goals } = harness();
  const running = scheduler.enqueue(gather);
  scheduler.claim();
  const waiting = scheduler.enqueue({ ...gather, objective: "Gather stone", parameters: { resource: "stone" } });
  scheduler.hold(waiting.id);
  scheduler.enqueue({ type: "defend_self", priority: TaskPriority.REFLEX, source: "system", objective: "Fight back", parameters: {} });
  goals.start({ description: "Build a house", source: "owner", successCriteria: [] });
  const jobs = projectJobs({ scheduler, goals });
  assert.equal(jobs.active?.id, running.id);
  assert.deepEqual(jobs.active?.controls, { pause: true, resume: false, cancel: true });
  const held = jobs.tasks.find((job) => job.id === waiting.id)!;
  assert.equal(held.held, true);
  assert.deepEqual(held.controls, { pause: false, resume: true, cancel: true });
  const reflex = jobs.tasks.find((job) => job.type === "defend_self")!;
  assert.deepEqual(reflex.controls, { pause: false, resume: false, cancel: false }, "safety reflexes are never owner-controlled");
  assert.equal(jobs.goals[0]?.state, "active");
});

test("job control pauses, resumes and cancels, and refuses bad or unsafe requests", async () => {
  const { scheduler, goals } = harness();
  const control = createJobControl({ scheduler, goals });
  const task = scheduler.enqueue(gather);
  assert.equal((await control({ kind: "task", id: task.id, action: "pause" })).ok, true);
  assert.ok(scheduler.queued[0]?.heldAt);
  assert.equal((await control({ kind: "task", id: task.id, action: "resume" })).ok, true);
  assert.equal(scheduler.active?.id, task.id);
  assert.deepEqual(await control({ kind: "task", id: task.id, action: "cancel" }), { ok: true, answer: "Cancelling at the next safe point." });
  assert.equal(scheduler.pendingInterruptReason, "cancel");
  assert.equal((await control({ kind: "task", id: "nope", action: "pause" })).ok, false);
  assert.equal((await control({ kind: "task", id: task.id, action: "explode" })).ok, false);
  const reflex = scheduler.enqueue({ type: "defend_self", priority: TaskPriority.REFLEX, source: "system", objective: "Fight back", parameters: {} });
  const refused = await control({ kind: "task", id: reflex.id, action: "cancel" });
  assert.equal(refused.ok, false);
  assert.equal(scheduler.queued.some((queued) => queued.id === reflex.id), true);
  const goal = goals.start({ description: "Stock the chest", source: "owner", successCriteria: [] });
  assert.equal((await control({ kind: "goal", id: goal.id, action: "pause" })).ok, true);
  assert.equal((await control({ kind: "goal", id: goal.id, action: "cancel" })).ok, true);
  assert.equal(goals.active(), null);
});

test("a viewer command is followed to the work it started and how it ended", () => {
  const { db, bus, tasks, goalsRepo, scheduler, goals } = harness();
  let clock = 1_000_000;
  const tracker = new CommandTracker({ bus, db, scheduler, task: (id) => tasks.get(id), goals: () => goals, goal: (id) => goalsRepo.get(id), now: () => clock });
  tracker.begin("gather 32 oak logs");
  assert.equal(tracker.view()[0]?.status, "waiting");
  const task = scheduler.enqueue(gather);
  bus.emit("chat.reply", { message: "Gathering 32 oak logs." });
  scheduler.claim();
  assert.equal(tracker.view()[0]?.status, "running");
  scheduler.completeActive();
  const done = tracker.view()[0]!;
  assert.equal(done.status, "done");
  assert.deepEqual(done.steps.map((step) => step.id), [task.id]);
  assert.deepEqual(done.replies, ["Gathering 32 oak logs."]);
  assert.ok(done.finishedAt);

  clock += 10 * 60_000;
  scheduler.enqueue({ ...gather, objective: "late work" });
  assert.equal(tracker.view()[0]?.steps.length, 1, "work long after the command is not attributed to it");
  const reloaded = new CommandTracker({ bus: new EventBus(), db, scheduler, task: (id) => tasks.get(id), goals: () => goals, goal: (id) => goalsRepo.get(id), now: () => clock });
  assert.equal(reloaded.view()[0]?.status, "done", "tracked commands survive a restart");
  tracker.dispose();
});

test("command status folds its steps, most urgent first", () => {
  assert.equal(commandStatus([], false, true), "waiting");
  assert.equal(commandStatus([], true, true), "answered");
  assert.equal(commandStatus(["completed", "active"], false, false), "running");
  assert.equal(commandStatus(["completed", "blocked"], false, false), "blocked");
  assert.equal(commandStatus(["completed", "failed"], false, false), "failed");
  assert.equal(commandStatus(["cancelled"], false, false), "cancelled");
  assert.equal(commandStatus(["completed", "cancelled"], false, false), "done");
});

test("gear reports durability, enchantments, free slots and carried versus stored supplies", () => {
  assert.deepEqual(itemCondition({ name: "iron_pickaxe", count: 1, maxDurability: 250, durabilityUsed: 200, enchants: [{ name: "efficiency", lvl: 3 }] }), {
    name: "iron_pickaxe", count: 1, durability: { remaining: 50, max: 250, percent: 20 }, enchantments: [{ name: "efficiency", level: 3 }],
  });
  assert.equal(itemCondition({ name: "dirt", count: 64, maxDurability: 0 }).durability, null);
  const sword = { name: "stone_sword", count: 1, maxDurability: 131, durabilityUsed: 10 };
  const bot = {
    health: 18,
    heldItem: sword,
    inventory: {
      slots: [] as unknown[],
      items: () => [sword, { name: "bread", count: 10 }, { name: "torch", count: 4 }, { name: "iron_pickaxe", count: 1, maxDurability: 250, durabilityUsed: 0 }],
      emptySlotCount: () => 30,
    },
    getEquipmentDestSlot: () => 99,
    supportFeature: () => false,
  };
  const stored = storedContents([{ lastContents: { torch: 60, "minecraft:bread": 5 }, lastSeenAt: "2026-10-24T10:00:00.000Z" }, { lastSeenAt: null }]);
  const gear = projectGearDetail({ bot: bot as never, stored: stored.stored, storageSeenAt: stored.seenAt, targets: { torches: 64 } });
  assert.equal(gear.equipment.hand?.durability?.remaining, 121);
  assert.deepEqual(gear.slots, { used: 6, free: 30, total: 36 });
  assert.deepEqual(gear.supplies.find((supply) => supply.key === "torches"), { key: "torches", label: "Torches", carried: 4, stored: 60, target: 64 });
  assert.equal(gear.supplies.find((supply) => supply.key === "food")?.stored, 5);
  const checks = Object.fromEntries(gear.readiness.map((check) => [check.key, check.ok]));
  assert.deepEqual(checks, { health: true, food: true, space: true, pickaxe: true, axe: false, weapon: true, torches: false, armor: false });
  assert.equal(gear.storageSeenAt, "2026-10-24T10:00:00.000Z");

  const axes = (items: unknown[]) => projectGearDetail({ bot: { ...bot, heldItem: null, inventory: { ...bot.inventory, items: () => items } } as never, stored: {}, storageSeenAt: null }).readiness.find((check) => check.key === "axe")?.detail;
  assert.equal(axes([{ name: "wooden_axe", count: 1, maxDurability: 59, durabilityUsed: 0 }, { name: "iron_axe", count: 1, maxDurability: 250, durabilityUsed: 50 }]), "iron axe · 80%", "the better tier wins");
  assert.equal(axes([{ name: "wooden_axe", count: 1, maxDurability: 59, durabilityUsed: 4 }, { name: "iron_axe", count: 1, maxDurability: 250, durabilityUsed: 175 }]), "wooden axe · 93%", "a worn-out tier loses to a usable one");
});

test("the story persists and 'since your last visit' counts what happened", () => {
  const { db, bus } = harness();
  const store = new StoryRepository(db);
  let clock = Date.parse("2026-10-24T08:00:00.000Z");
  const feed = new StoryFeed({ bus, store, now: () => clock });
  const emit = (name: string, payload: unknown): void => { (bus.emit as (n: string, p: unknown) => void)(name, payload); };
  emit("resource.gather.complete", { resource: "oak_log", quantity: 32, gathered: 32, delivered: 32, status: "completed" });
  const visit = new Date(clock + 1000).toISOString();
  clock += 60_000;
  emit("build_project.verified", { project: { structureType: "simple_room", userGoal: "x" } });
  clock += 60_000;
  emit("resource.gather.complete", { resource: "oak_log", quantity: 16, gathered: 16, delivered: 16, status: "completed" });
  clock += 60_000;
  emit("resource.gather.complete", { resource: "iron_ore", quantity: 4, gathered: 4, delivered: 4, status: "completed" });
  emit("death", { killer: { name: "zombie", x: 1, y: 2, z: 3 }, position: null, dimension: "overworld", inventory: {} });

  const reloaded = new StoryFeed({ bus: new EventBus(), store });
  assert.equal(reloaded.recent().length, 5, "history survives a restart");
  assert.deepEqual(reloaded.recent().map((entry) => entry.id), [1, 2, 3, 4, 5]);

  const history = readHistory(store, visit, [{ kind: "task", title: "Gather stone", detail: "blocked", since: null }]);
  assert.equal(history.entries.length, 4);
  assert.deepEqual(history.summary.buildsFinished, ["simple room"]);
  assert.deepEqual(history.summary.gathered, [{ resource: "oak log", count: 16 }, { resource: "iron ore", count: 4 }]);
  assert.equal(history.summary.deaths, 1);
  assert.deepEqual(history.summary.killers, ["zombie"]);
  assert.equal(history.unresolved.length, 1);

  const snapshot = { connection: { connected: false }, self: { health: null, hunger: null, dimension: null, timePhase: null }, viewer: { status: "stopped" }, story: feed.recent(), world: null, inventory: null, equipment: null } as unknown as DashboardSnapshot;
  assert.equal(JSON.stringify(toPublicViewerState(snapshot)).includes("facts"), false, "story facts never reach the public viewer");
  feed.dispose();
});

test("a build preview reports footprint, entrance, materials and site state", () => {
  const origin = { x: 100, y: 64, z: -20, dimension: "overworld" };
  const design = simpleStructureDesign("room", 7, 4, 7, origin, "oak_planks");
  const operations = compileBuildingDesign(design, origin).operations;
  const placed = operations[0]!.absolute!;
  const bot = {
    inventory: { items: () => [{ name: "oak_planks", count: 20 }, { name: "oak_log", count: 5 }] },
    blockAt: (at: { x: number; y: number; z: number }) => at.x === placed.x && at.y === placed.y && at.z === placed.z ? { name: "oak_planks" } : at.y === 64 && at.x === 101 && at.z === -20 ? { name: "stone" } : { name: "air" },
  };
  const preview = describePreview({ text: "build a house at home", design, origin, structureType: "simple_room", operations, bot: bot as never, stored: { oak_planks: 30 }, resumes: false });
  assert.deepEqual([preview.footprint.width, preview.footprint.depth, preview.footprint.height], [7, 7, 5]);
  assert.equal(preview.facing, "south", "the doorway is in the +z wall");
  const planks = preview.materials.find((material) => material.material === "oak_planks")!;
  assert.equal(planks.carried, 20);
  assert.equal(planks.stored, 30);
  assert.equal(planks.missing, Math.max(0, planks.needed - 50 - 20), "logs on hand count at four planks each");
  assert.equal(preview.site.placed, 1);
  assert.equal(preview.ghost.blocks.length, operations.length * 4);
  assert.equal(preview.blocks, operations.length);
});

test("the map reads remembered places for Bob's dimension and his pathfinder goal", () => {
  const { db } = harness();
  db.sql.prepare("INSERT INTO worlds (id, server_key, world_key, created_at) VALUES (1, 's', 'w', 'now')").run();
  db.sql.prepare("INSERT INTO locations (world_id, dimension, name, category, x, y, z, created_at, updated_at) VALUES (1, 'overworld', 'home', 'home', 0, 64, 0, 'now', 'now'), (1, 'overworld', 'mine', 'waypoint', 40, 12, 40, 'now', 'now'), (1, 'the_nether', 'portal', 'waypoint', 5, 70, 5, 'now', 'now')").run();
  db.sql.prepare("INSERT INTO resource_sites (world_id, dimension, resource, x, y, z, depleted) VALUES (1, 'minecraft:overworld', 'iron_ore', 30, 20, 10, 0)").run();
  db.sql.prepare("INSERT INTO death_events (world_id, dimension, x, y, z, recovered, created_at) VALUES (1, 'overworld', -10, 60, 5, 1, '2026-10-24T09:00:00.000Z')").run();
  const goal = new (class GoalNear { x = 12; y = 64; z = 8; })();
  const bot = { entity: { position: { x: 1, y: 64, z: 2 }, yaw: 0 }, game: { dimension: "minecraft:overworld" }, pathfinder: { goal } };
  const map = readOwnerMap({ db, worldId: 1, bot: bot as never, routes: null, build: null });
  assert.equal(map.dimension, "overworld");
  assert.deepEqual(map.home, { x: 0, y: 64, z: 0, label: "Home" });
  assert.deepEqual(map.locations.map((location) => location.label), ["mine"], "other dimensions are left out");
  assert.equal(map.resources[0]?.label, "iron ore");
  assert.equal(map.deaths[0]?.recovered, true);
  assert.deepEqual(map.destination, { x: 12, y: 64, z: 8, label: "Near" });
  const follow = pathfinderDestination({ pathfinder: { goal: { entity: { position: { x: 3, y: 4, z: 5 }, username: "Corey" } } } } as never);
  assert.equal(follow?.label, "Following Corey");
});

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as { port: number };
      server.close(() => resolve(address.port));
    });
  });
}

function send(port: number, method: string, path: string, body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: body === undefined ? {} : { "content-type": "application/json" } }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { data += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("the private shell serves the owner API and the public shell never does", async () => {
  const seen: unknown[] = [];
  const privateApi = {
    job: async (body: unknown) => { seen.push(body); return { ok: true as const, answer: "Paused." }; },
    preview: async (body: unknown) => ({ status: 200, body: { preview: body } }),
    history: async (since: string | null) => ({ status: 200, body: { since } }),
    map: async () => ({ status: 200, body: { dimension: "overworld" } }),
  };
  const port = await freePort();
  const shell = new ViewerShellServer({ host: "127.0.0.1", port, viewerPort: 1, statsPort: 1, privateApi });
  const publicPort = await freePort();
  const publicShell = new ViewerShellServer({ host: "127.0.0.1", port: publicPort, viewerPort: 1, statsPort: 1, mode: "public", privateApi, publicState: async () => ({}) });
  await shell.start();
  await publicShell.start();
  try {
    const job = await send(port, "POST", "/api/job", JSON.stringify({ kind: "task", id: "t1", action: "pause" }));
    assert.deepEqual([job.status, JSON.parse(job.body)], [200, { answer: "Paused." }]);
    assert.deepEqual(seen, [{ kind: "task", id: "t1", action: "pause" }]);
    assert.equal((await send(port, "GET", "/api/job")).status, 405);
    const preview = await send(port, "POST", "/api/preview", JSON.stringify({ command: "build a tower" }));
    assert.deepEqual(JSON.parse(preview.body), { preview: { command: "build a tower" } });
    assert.deepEqual(JSON.parse((await send(port, "GET", "/api/history?since=2026-10-24T00:00:00.000Z")).body), { since: "2026-10-24T00:00:00.000Z" });
    assert.equal((await send(port, "GET", "/api/map")).status, 200);
    for (const path of ["/api/job", "/api/preview", "/api/history", "/api/map"]) {
      const post = path.endsWith("job") || path.endsWith("preview");
      assert.equal((await send(publicPort, post ? "POST" : "GET", path, post ? "{}" : undefined)).status, 404, `${path} is private`);
    }
  } finally {
    shell.stop();
    publicShell.stop();
  }
});
