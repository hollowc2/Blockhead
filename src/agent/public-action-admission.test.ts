import test from "node:test";
import assert from "node:assert/strict";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { assessPublicAdmission, type AdmissionCheck, type AdmissionGate } from "./public-action-admission.js";
import { assessPublicPhysicalState, assessPublicThreatState, safePublicPhysicalState, safePublicThreatState } from "./public-action-safety.js";
import { PublicActionController, PUBLIC_ACTIONS } from "./public-actions.js";
import { WorldActionExecutor } from "./world-actions.js";

const names: AdmissionGate[] = ["session", "physical", "freshness", "threats", "death_loop", "scheduler", "projects", "lease_waiters", "lease_owner", "active_task", "queued_tasks", "interrupt", "background", "decision", "goal", "bootstrap"];
test("all named gates refuse every action and diagnostics report multiple independent blockers", async () => {
  for (const blocked of names) {
    let effects = 0;
    const checks: AdmissionCheck[] = names.map(name => [name, () => name !== blocked]);
    const report = assessPublicAdmission(checks, true);
    assert.equal(report.checks[blocked], "blocked");
    assert.equal(report.safe, false);
    const bot = { entity: { yaw: 0, pitch: 0 }, chat: () => effects++, swingArm: () => effects++, look: async () => { effects++; } };
    const executor = new WorldActionExecutor();
    const controller = new PublicActionController({ session: () => bot, safe: () => assessPublicAdmission(checks).safe, tryRun: (signal, run) => executor.tryRun("public", signal, run) });
    for (const action of PUBLIC_ACTIONS) assert.equal(await controller.execute(action, new AbortController().signal), false);
    assert.equal(effects, 0); assert.equal(executor.activeOwner, null); assert.equal(executor.pendingCount, 0);
  }
  const report = assessPublicAdmission([["physical", () => false], ["threats", () => false]], true);
  assert.deepEqual(report, { safe: false, checks: { physical: "blocked", threats: "blocked" } });
});

test("normal admission short circuits; diagnostic exceptions/non-booleans fail closed without exception text", () => {
  let reads = 0;
  const checks: AdmissionCheck[] = [["session", () => false], ["threats", () => { reads++; throw Error("PRIVATE_CANARY"); }]];
  assert.deepEqual(assessPublicAdmission(checks), { safe: false, checks: { session: "blocked" } });
  assert.equal(reads, 0);
  const report = assessPublicAdmission(checks, true);
  assert.equal(reads, 1); assert.equal(report.checks.threats, "unknown");
  assert(!JSON.stringify(report).includes("PRIVATE_CANARY"));
  assert.equal(assessPublicAdmission([]).safe, false);
  assert.equal(assessPublicAdmission([["session", (() => Promise.resolve(true)) as unknown as () => boolean]]).safe, false);
});

test("a gate changing after reservation refuses every gesture at the final safety check", async () => {
  for (const changed of names) for (const action of PUBLIC_ACTIONS) {
    let blocked: AdmissionGate | null = null, effects = 0;
    const checks: AdmissionCheck[] = names.map(name => [name, () => name !== blocked]);
    const bot = { entity: { yaw: 0, pitch: 0.2 }, chat: () => effects++, swingArm: () => effects++, look: async () => { effects++; } };
    const executor = new WorldActionExecutor();
    const controller = new PublicActionController({ session: () => bot, safe: () => assessPublicAdmission(checks).safe,
      tryRun: (signal, run) => executor.tryRun("public", signal, async lease => { await Promise.resolve(); return run(lease); }) });
    assert.equal(assessPublicAdmission(checks, true).safe, true);
    const work = controller.execute(action, new AbortController().signal);
    blocked = changed;
    assert.equal(assessPublicAdmission(checks, true).checks[changed], "blocked");
    assert.equal(await work, false, `${changed}/${action}`);
    assert.equal(effects, 0); assert.equal(executor.activeOwner, null);
  }
});

function physicalBot(): Bot {
  return { entity: { id: 1, onGround: true, isInWater: false, isInLava: false, yaw: 0, pitch: 0.2, velocity: new Vec3(0, 0, 0), position: new Vec3(0, 64, 0) },
    entities: {}, health: 20, food: 20, isSleeping: false, usingHeldItem: false, autoEat: { isEating: false },
    controlState: { forward: false }, pathfinder: { isMoving: () => false, isMining: () => false, isBuilding: () => false, goal: null },
    blockAt: () => ({ boundingBox: "empty" }),
  } as unknown as Bot;
}
test("physical diagnosis uses the admission predicate, preserves boundaries and observes without mutations", () => {
  const bot = physicalBot();
  assert.equal(safePublicPhysicalState(bot, 8), true);
  const baseline = JSON.stringify(bot);
  assert.equal(assessPublicPhysicalState(bot, 8, true).safe, true);
  assert.equal(JSON.stringify(bot), baseline);
  bot.food = 10; bot.health = 8;
  const report = assessPublicPhysicalState(bot, 8, true);
  assert.equal(report.safe, safePublicPhysicalState(bot, 8));
  assert.equal(report.checks.hunger, "blocked"); assert.equal(report.checks.health, "blocked");
  bot.food = 10.01; bot.health = 8.01;
  assert.equal(safePublicPhysicalState(bot, 8), true);
  bot.pathfinder.isMoving = () => { throw Error("PRIVATE_CANARY"); };
  assert.equal(assessPublicPhysicalState(bot, 8, true).checks.path_moving, "unknown");
  assert.equal(safePublicPhysicalState(bot, 8), false);
  Object.defineProperty(bot, "entity", { get() { throw Error("PRIVATE_CANARY"); } });
  assert.equal(assessPublicPhysicalState(bot, 8, true).safe, false);
  assert(!JSON.stringify(assessPublicPhysicalState(bot, 8, true)).includes("PRIVATE_CANARY"));
});

test("threat reasons distinguish unreviewed mobs, missing visibility and actual exposure without narrowing policy", () => {
  const bot = physicalBot();
  bot.entities[7] = { id: 7, name: "enderman", type: "hostile", position: new Vec3(1000, -1000, 0), metadata: { 17: false, 18: false } } as never;
  assert.deepEqual(assessPublicThreatState(bot), { safe: false, reason: "unreviewed_mob", mob: "enderman" });
  assert.equal(safePublicThreatState(bot), false);
  bot.entities[7] = { id: 7, type: "hostile", name: "skeleton", position: new Vec3(3, 64, 0) } as never;
  assert.equal(assessPublicThreatState(bot).reason, "exposed_threat");
  bot.blockAt = () => null;
  assert.equal(assessPublicThreatState(bot).reason, "unknown_visibility");
  bot.blockAt = () => { throw Error("PRIVATE_CANARY"); };
  assert.deepEqual(assessPublicThreatState(bot), { safe: false, reason: "observation_error" });
});
