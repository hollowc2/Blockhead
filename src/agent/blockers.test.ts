import assert from "node:assert/strict";
import { test } from "node:test";
import { landmarkTemplate } from "../building/templates.js";
import { EventBus } from "../events/bus.js";
import { AppDatabase } from "../memory/database.js";
import { MIGRATIONS } from "../memory/migrations.js";
import { BuildProjectsRepository } from "../memory/build-projects.js";
import { GoalsRepository } from "../memory/goals.js";
import { TasksRepository } from "../memory/tasks.js";
import { BlockerDesk, blockerOf, describeBlocker, explainPlan, parseBlockerAnswer, type BlockerExplanation } from "./blockers.js";
import { BuildProjectManager } from "./build-projects.js";
import { GoalManager } from "./goals.js";
import { Scheduler } from "./scheduler.js";
import { TaskPriority, TaskStatus, type Task } from "./task.js";

const glass: BlockerExplanation = { need: { item: "glass", count: 18 }, missing: [{ item: "sand", count: 18, via: "gather" }], canFix: true };

test("explainPlan names the raw inputs still short, net of stock", () => {
  const stock: Record<string, number> = { sand: 4, coal: 1 };
  const explanation = explainPlan(
    { item: "glass", count: 18 },
    [
      { kind: "gather", item: "sand", quantity: 18 },
      { kind: "fuel", quantity: 3 },
      { kind: "smelt", item: "glass", quantity: 18 },
    ],
    (item) => stock[item] ?? 0,
  );
  assert.deepEqual(explanation.missing, [
    { item: "sand", count: 14, via: "gather" },
    { item: "coal", count: 2, via: "fuel" },
  ]);
  assert.equal(explanation.canFix, true);
});

test("explainPlan counts a gathered ore by the item it drops", () => {
  const explanation = explainPlan(
    { item: "iron_pickaxe", count: 1 },
    [{ kind: "gather", item: "iron_ore", quantity: 3 }, { kind: "craft", item: "iron_pickaxe", quantity: 1 }],
    (item) => (item === "raw_iron" ? 1 : 0),
    { dropOf: (item) => (item === "iron_ore" ? "raw_iron" : item) },
  );
  assert.deepEqual(explanation.missing, [{ item: "raw_iron", count: 2, via: "gather" }]);
});

test("describeBlocker says what is needed, what is missing, and the next step", () => {
  assert.equal(describeBlocker(glass), "Need 18 glass; missing 18 sand. I can gather it.");
  assert.equal(describeBlocker({ ...glass, reason: "no sand found nearby" }, "the house"), "Need 18 glass for the house; missing 18 sand (no sand found nearby). I can gather it.");
  assert.equal(
    describeBlocker({ need: { item: "glass", count: 18 }, missing: [{ item: "sand", count: 18, via: "gather" }, { item: "coal", count: 3, via: "fuel" }], canFix: true }),
    "Need 18 glass; missing 18 sand and 3 coal or charcoal. I can get them.",
  );
  assert.equal(describeBlocker({ need: { item: "beacon", count: 1 }, missing: [], canFix: false, reason: "no recipe" }), "Need 1 beacon; I can't work out how to make it (no recipe).");
});

test("blockerOf reads an explanation only from well-formed result data", () => {
  assert.deepEqual(blockerOf({ item: "glass", blocker: glass }), glass);
  assert.equal(blockerOf({ item: "glass" }), null);
  assert.equal(blockerOf(undefined), null);
  assert.equal(blockerOf({ blocker: { need: "glass" } }), null);
});

test("parseBlockerAnswer maps proceed and change-the-plan phrasings", () => {
  assert.equal(parseBlockerAnswer("go ahead"), "proceed");
  assert.equal(parseBlockerAnswer("yes"), "proceed");
  assert.equal(parseBlockerAnswer("change the plan"), "change_plan");
  assert.equal(parseBlockerAnswer("no"), "change_plan");
  assert.equal(parseBlockerAnswer("build a house"), null);
});

function harness() {
  const db = new AppDatabase(":memory:");
  db.runMigrations(MIGRATIONS);
  const bus = new EventBus();
  const tasks = new TasksRepository(db);
  const scheduler = new Scheduler({ bus, tasks });
  const projects = new BuildProjectsRepository(db);
  const buildProjects = new BuildProjectManager(projects, scheduler, bus);
  const goals = new GoalManager({ bus, goals: new GoalsRepository(db), scheduler });
  const said: string[] = [];
  let now = 1_000_000;
  const desk = new BlockerDesk({ bus, scheduler, buildProjects, goals, announce: (message) => said.push(message), now: () => now });
  return { db, bus, tasks, scheduler, projects, buildProjects, goals, desk, said, advance: (ms: number) => { now += ms; } };
}

function userTask(type: string, item: string, quantity: number): Task {
  return { id: `t-${item}`, type, priority: TaskPriority.FOREGROUND, source: "user", objective: `${type} ${quantity} ${item}`, parameters: { item, quantity }, status: TaskStatus.ACTIVE, createdAt: new Date().toISOString() };
}

test("an owner's craft that lacks materials offers to gather them, once", () => {
  const h = harness();
  try {
    const task = userTask("craft_item", "glass", 20);
    h.bus.emit("task.blocker", { task, blocker: glass });
    h.bus.emit("task.blocker", { task, blocker: glass });
    assert.deepEqual(h.said, ['Need 18 glass; missing 18 sand. I can gather it. Say "go ahead", or "change the plan".']);
    assert.equal(h.desk.awaitingAnswer(), true);

    // "go ahead" re-asks for the owner's full 20 as an ensure_item, which
    // may mine; the offer closes.
    const reply = h.desk.resolve("proceed");
    assert.equal(reply, "On it: getting sand to make 20 glass.");
    const queued = h.tasks.loadUnfinished().find((t) => t.type === "ensure_item");
    assert.deepEqual(queued?.parameters, { item: "glass", quantity: 20 });
    assert.equal(h.desk.latest(), null);
  } finally {
    h.db.close();
  }
});

test("a bare yes stops answering a stale offer", () => {
  const h = harness();
  try {
    h.bus.emit("task.blocker", { task: userTask("craft_item", "glass", 18), blocker: glass });
    h.advance(20 * 60_000);
    assert.equal(h.desk.awaitingAnswer(), false);
    assert.notEqual(h.desk.latest(), null);
  } finally {
    h.db.close();
  }
});

test("goal steps and the bot's own work explain once but get no offer", () => {
  const h = harness();
  try {
    h.bus.emit("task.blocker", { task: { ...userTask("ensure_item", "glass", 18), source: "goal" }, blocker: glass });
    h.bus.emit("task.blocker", { task: { ...userTask("ensure_item", "glass", 18), source: "background" }, blocker: glass });
    assert.deepEqual(h.said, ["Need 18 glass; missing 18 sand. I can gather it."]);
    assert.equal(h.desk.latest(), null);
  } finally {
    h.db.close();
  }
});

const bricks: BlockerExplanation = { need: { item: "stone_bricks", count: 8 }, missing: [{ item: "cobblestone", count: 8, via: "gather" }], canFix: true };

function blockedBuild(h: ReturnType<typeof harness>) {
  const design = landmarkTemplate("castle", "small");
  const created = h.buildProjects.createOrResume({ userGoal: "Build a castle", structureType: "castle", source: "user", design, origin: { x: 10, y: 64, z: -4, dimension: "overworld" } });
  h.scheduler.claim();
  h.buildProjects.settleChildTask(created.task, { ok: false, status: "blocked", errorCode: "INSUFFICIENT_MATERIALS", data: { shortages: [{ material: "stone_bricks", required: 8, available: 0 }] } });
  h.scheduler.blockActive("missing stone bricks");
  const acquisition = h.tasks.loadUnfinished().find((t) => t.type === "build_project_acquire")!;
  // As the dispatcher settles it: the explanation becomes the failure message.
  const blocker = { ...bricks, reason: "no stone found nearby" };
  h.bus.emit("task.blocker", { task: acquisition, blocker });
  h.buildProjects.settleChildTask(acquisition, { ok: false, status: "failed", errorCode: "RESOURCE_NOT_FOUND", message: describeBlocker(blocker), retryable: false, data: { blocker } });
  h.scheduler.blockActive("no stone");
  return created.project;
}

test("a build stuck on materials explains itself and resumes on go ahead", () => {
  const h = harness();
  try {
    const project = blockedBuild(h);
    assert.deepEqual(h.said, ['Need 8 stone bricks for the castle; missing 8 cobblestone (no stone found nearby). I can gather it. Say "go ahead", or "change the plan".']);
    assert.equal(h.desk.forProject(project.id)?.summary, "Need 8 stone bricks for the castle; missing 8 cobblestone (no stone found nearby). I can gather it.");

    assert.equal(h.desk.resolve("proceed"), "On it: back to the castle, getting cobblestone first.");
    assert.equal(h.projects.get(project.id)?.status, "active");
    assert.equal(h.desk.forProject(project.id), null);
  } finally {
    h.db.close();
  }
});

test("change the plan sets the build aside and cancels the goal waiting on it", () => {
  const h = harness();
  try {
    const project = blockedBuild(h);
    h.goals.start({ description: "Finish the castle.", source: "owner", successCriteria: [{ kind: "building_verified", target: "project", projectId: project.id, projectName: "castle" }] });
    h.goals.enqueue({ description: "Gather iron.", source: "owner", successCriteria: [] });

    const reply = h.desk.resolve("change_plan");
    assert.equal(reply, 'OK, the castle is set aside (say "continue the build" to pick it back up). Next: Gather iron.');
    assert.equal(h.projects.get(project.id)?.status, "paused");
    assert.equal(h.goals.active()?.description, "Gather iron.");

    // "continue the build" still finds and reopens it.
    assert.equal(h.buildProjects.resumeLatest()?.project.id, project.id);
  } finally {
    h.db.close();
  }
});

test("a blocked owner goal says why and what comes next", () => {
  const h = harness();
  try {
    h.goals.start({ description: "Finish the house.", source: "owner", successCriteria: [] });
    h.goals.enqueue({ description: "Stock the chest.", source: "owner", successCriteria: [] });
    h.goals.block("build the house is failed");
    assert.deepEqual(h.said, ['Can\'t finish "Finish the house.": build the house is failed. Moving on to: Stock the chest.']);
  } finally {
    h.db.close();
  }
});

test("an owner stop drops open offers so a later yes restarts nothing", () => {
  const h = harness();
  try {
    h.bus.emit("task.blocker", { task: userTask("craft_item", "glass", 18), blocker: glass });
    h.bus.emit("chat.command", { from: "Corey", command: "stop" });
    assert.equal(h.desk.latest(), null);
    assert.equal(h.desk.resolve("proceed"), "Nothing is blocked right now.");
  } finally {
    h.db.close();
  }
});

test("a build stuck before a restart is re-adopted silently from its explained error", () => {
  const h = harness();
  try {
    const project = blockedBuild(h);
    const restarted = harness();
    try {
      const stored = h.projects.get(project.id)!;
      assert.match(stored.lastError ?? "", /^Need /);
      restarted.desk.adopt([stored, { ...stored, id: "village", structureType: "village:cottage" }]);
      assert.deepEqual(restarted.said, []);
      assert.equal(restarted.desk.forProject(project.id)?.summary, stored.lastError);
      assert.equal(restarted.desk.forProject("village"), null);
    } finally {
      restarted.db.close();
    }
  } finally {
    h.db.close();
  }
});

test("describeBlocker pluralizes logs and torches", () => {
  assert.equal(
    describeBlocker({ need: { item: "torch", count: 32 }, missing: [{ item: "coal", count: 8, via: "fuel" }], canFix: true }),
    "Need 32 torches; missing 8 coal or charcoal. I can get it.",
  );
  assert.equal(
    describeBlocker({ need: { item: "planks", count: 24 }, missing: [{ item: "log", count: 6, via: "gather" }], canFix: true, reason: "no trees within 64 blocks" }),
    "Need 24 planks; missing 6 logs (no trees within 64 blocks). I can gather it.",
  );
});

test("an owner's shed build short of logs reruns the same task on go ahead", () => {
  const h = harness();
  try {
    const task: Task = { id: "shed", type: "build_base", priority: TaskPriority.FOREGROUND, source: "user", objective: "Build the base.", parameters: {}, status: TaskStatus.ACTIVE, createdAt: new Date().toISOString() };
    h.bus.emit("task.blocker", { task, blocker: { need: { item: "planks", count: 24 }, missing: [{ item: "log", count: 6, via: "gather" }], canFix: true } });
    assert.deepEqual(h.said, ['Need 24 planks; missing 6 logs. I can gather it. Say "go ahead", or "change the plan".']);
    assert.equal(h.desk.resolve("proceed"), "On it: getting logs and trying again.");
    const rerun = h.tasks.loadUnfinished().find((t) => t.type === "build_base");
    assert.equal(rerun?.source, "user");
    assert.equal(h.desk.latest(), null);

    h.bus.emit("task.blocker", { task, blocker: { need: { item: "planks", count: 24 }, missing: [{ item: "log", count: 6, via: "gather" }], canFix: true } });
    assert.equal(h.desk.resolve("change_plan"), "OK, dropping that. What should I do instead?");
  } finally {
    h.db.close();
  }
});
