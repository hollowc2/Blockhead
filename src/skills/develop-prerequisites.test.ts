import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bot } from "mineflayer";
import type { AgentState } from "../agent/state.js";
import { Vec3 } from "vec3";
import pino from "pino";
import { AppDatabase } from "../memory/database.js";
import { MIGRATIONS } from "../memory/migrations.js";
import { BackgroundFailuresRepository } from "../memory/background-failures.js";
import { DevelopLandRunner, nextDevelopment, type TreePlantResult, type TreeFarmSurvey, type DevelopLandOptions } from "./develop-land.js";
import { type PlotOffset } from "./farm.js";

type Internals = {
  plantTrees(farm: TreeFarmSurvey): Promise<TreePlantResult>;
  gatherSaplings(): Promise<void>;
  defer(plot: PlotOffset, reason: string): void;
  deferredPlots(): ReadonlySet<string>;
};
function harness() {
  const db = new AppDatabase(":memory:"); db.runMigrations(MIGRATIONS);
  const failures = new BackgroundFailuresRepository(db);
  const items: { name: string; count: number }[] = [];
  const leaf = new Vec3(1, 65, 0);
  let fetches = 0, collections = 0, now = 1_000;
  const bot = {
    entity: { position: new Vec3(0, 64, 0) }, entities: {},
    inventory: { items: () => items },
    findBlocks: () => [leaf],
    blockAt: (at: Vec3) => ({ position: at, name: at.equals(leaf) ? "birch_leaves" : at.y < 64 ? "grass_block" : "air", boundingBox: at.equals(leaf) || at.y < 64 ? "block" : "empty" }),
  } as unknown as Bot;
  const opts: DevelopLandOptions = {
    bot, state: { worldId: 1, home: { x: 0, y: 64, z: 0 } } as AgentState, logger: pino({ level: "silent" }), failures, now: () => now,
    treeFarm: { load: () => [], save: () => {}, fetchSaplings: async () => { fetches++; } },
    actions: { collect: async () => { collections++; return undefined as never; }, travel: async () => ({ status: "already_there" }), place: async () => null },
  };
  return { db, failures, opts, items, bot, runner: () => new DevelopLandRunner(opts) as unknown as Internals, fetches: () => fetches, collections: () => collections, advance: () => { now += 21 * 60_000; } };
}
const farm: TreeFarmSurvey = { offset: { dx: 8, dz: 0 }, empty: [{ x: 8, y: 64, z: 0, cover: null }], saplings: 0, trees: 0 };

test("reachable leaves with no drops persist the prerequisite cooldown across restarts", async () => {
  const h = harness();
  try {
    const first = await h.runner().plantTrees(farm);
    assert.deepEqual(first, { planted: 0, blocker: "no_saplings" });
    assert.equal(h.collections(), 1);
    const restarted = h.runner();
    await restarted.gatherSaplings();
    assert.equal(h.fetches(), 1, "a restart does not repeat the empty hunt");
    h.advance(); await restarted.gatherSaplings();
    assert.equal(h.fetches(), 2, "expiry permits a fresh inventory/world check");
  } finally { h.db.close(); }
});
test("carried saplings distinguish unreachable ground from unavailable saplings", async () => {
  const h = harness();
  try {
    h.items.push({ name: "birch_sapling", count: 1 });
    h.opts.actions!.travel = async () => ({ status: "timed_out" });
    assert.deepEqual(await h.runner().plantTrees(farm), { planted: 0, blocker: "path_unreachable" });
    assert.equal(h.fetches(), 0);
    h.opts.actions!.travel = async () => ({ status: "arrived" });
    assert.deepEqual(await h.runner().plantTrees(farm), { planted: 0, blocker: "placement_refused" });
    h.opts.actions!.place = async () => ({ name: "birch_sapling" }) as never;
    assert.deepEqual(await h.runner().plantTrees(farm), { planted: 1, blocker: null });
  } finally { h.db.close(); }
});
test("an unreachable leaf is excluded rather than consuming the collection budget", async () => {
  const h = harness();
  try {
    h.bot.blockAt = ((at: Vec3) => ({ position: at, name: "birch_leaves", boundingBox: "block" })) as never;
    await h.runner().gatherSaplings();
    assert.equal(h.collections(), 0);
  } finally { h.db.close(); }
});
test("per-plot deferral survives restart and leaves another feasible plot available", () => {
  const h = harness();
  try {
    h.runner().defer({ dx: -8, dz: 0 }, "path_unreachable");
    const restarted = h.runner();
    const next = nextDevelopment({ x: 0, y: 64, z: 0 }, (_x, y) => ({ name: y < 64 ? "grass_block" : "air" }), new Set(), { buildBusy: true, buildings: 0, deferredPlots: restarted.deferredPlots() });
    assert.notDeepEqual(next?.survey.offset, { dx: -8, dz: 0 });
    assert.equal(restarted.deferredPlots().size, 1);
    h.advance(); assert.equal(restarted.deferredPlots().size, 0);
    assert.equal(h.failures.loadAll().length, 0);
  } finally { h.db.close(); }
});

test("new carried saplings release a no-saplings plot without erasing path blockers", () => {
  const h = harness();
  try {
    const runner = h.runner();
    runner.defer({ dx: -8, dz: 0 }, "no_saplings");
    runner.defer({ dx: 8, dz: 0 }, "path_unreachable");
    h.items.push({ name: "birch_sapling", count: 1 });
    assert.deepEqual([...h.runner().deferredPlots()], ["8,0"]);
  } finally { h.db.close(); }
});
