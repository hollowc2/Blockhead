import assert from "node:assert/strict";
import { test } from "node:test";
import type { DashboardSnapshot, TaskSummary } from "./types.js";
import { publicStatus } from "./public-status.js";

const task = (type: string, status = "active"): TaskSummary => ({ id: "t1", type, priority: 70, source: "user", objective: "SECRET objective at 1200 64 -950", status, createdAt: "2026-10-25T00:00:00.000Z", startedAt: "2026-10-25T00:01:00.000Z", completedAt: null, phase: null, attempts: 1, lastError: null }) as never;
const snap = (over: Partial<DashboardSnapshot> = {}): DashboardSnapshot => ({
  connection: { connected: true, player: "Bob", server: null },
  self: { health: 20, hunger: 20, position: null, dimension: "overworld", timePhase: "day" },
  task: null, buildProject: null, worldProject: null, ...over,
}) as DashboardSnapshot;

test("public status maps work to a handful of coarse labels", () => {
  assert.equal(publicStatus(snap({ task: task("build_project_slice") })).activity, "building");
  assert.equal(publicStatus(snap({ task: task("collect_resource") })).activity, "gathering");
  assert.equal(publicStatus(snap({ task: task("travel_to") })).activity, "exploring");
  assert.equal(publicStatus(snap({ task: task("sleep") })).activity, "resting");
  assert.equal(publicStatus(snap({ task: task("death_recovery") })).activity, "recovering");
  assert.equal(publicStatus(snap({ task: task("organize_storage") })).activity, "working");
  assert.equal(publicStatus(snap()).activity, "resting");
  assert.equal(publicStatus(snap({ connection: { connected: false, player: null, server: null }, task: task("collect_resource") })).activity, "offline");
});

test("low health or hunger reads as recovering whatever the task", () => {
  assert.equal(publicStatus(snap({ task: task("collect_resource"), self: { health: 6, hunger: 20, position: null, dimension: null, timePhase: null } })).activity, "recovering");
  assert.equal(publicStatus(snap({ self: { health: 20, hunger: 4, position: null, dimension: null, timePhase: null } })).activity, "recovering");
});

test("an underway build counts as building between slices; a paused one does not", () => {
  assert.equal(publicStatus(snap({ buildProject: { status: "active" } as never })).activity, "building");
  assert.equal(publicStatus(snap({ buildProject: { status: "paused" } as never })).activity, "resting");
  assert.equal(publicStatus(snap({ task: task("collect_resource", "queued") })).activity, "resting");
});

test("public status carries only fixed text and the task start time", () => {
  const status = publicStatus(snap({ task: task("collect_resource") }));
  assert.deepEqual(Object.keys(status), ["activity", "detail", "since"]);
  assert.equal(status.since, "2026-10-25T00:01:00.000Z");
  assert(!JSON.stringify(status).includes("SECRET"));
});
