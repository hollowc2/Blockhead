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
    assert.equal(h.failures.loadAll().length, 1, "expired blockers retain retry history until conditions change");
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

test("zero-change trunk cleanup fails and persists a plot cooldown across restart", async () => {
  const { WorldActionExecutor } = await import("../agent/world-actions.js");
  const h = harness();
  try {
    h.opts.actions!.home = async () => ({ status: "already_there" });
    const original = h.bot.blockAt;
    const target = new Vec3(-8,70,0);
    h.bot.blockAt = ((at: Vec3) => at.equals(target) ? { position: target, name: "birch_log", boundingBox: "block" } : original(at)) as never;
    const runner = new DevelopLandRunner(h.opts);
    (runner as any).next = () => ({ kind: "tidy", survey: { offset: { dx: -8, dz: 0 }, leftoverLogs: [{ x: -8, y: 70, z: 0 }] } });
    const result = await new WorldActionExecutor().run("tidy-no-progress", new AbortController().signal, () => runner.run());
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, "PATH_UNREACHABLE");
    assert.equal(result.data?.cleared, 0);
    assert.ok(h.runner().deferredPlots().has("-8,0"));
  } finally { h.db.close(); }
});

test("unchanged multi-plot failures back off across expiry and restart, while changed terrain recovers", () => {
  const h = harness();
  try {
    const plot = { dx: -8, dz: 0 };
    h.runner().defer(plot, "path_unreachable");
    const first = h.failures.loadAll()[0]!;
    h.advance();
    const secondRunner = h.runner();
    assert.equal(secondRunner.deferredPlots().size, 0, "one bounded probe is eligible after expiry");
    secondRunner.defer(plot, "path_unreachable");
    const second = h.failures.loadAll()[0]!;
    assert.equal(second.retryAt - second.failedAt, 2 * (first.retryAt - first.failedAt));
    h.advance();
    assert.ok(h.runner().deferredPlots().has("-8,0"), "restart preserves the longer cooldown");
    const original = h.bot.blockAt;
    h.bot.blockAt = ((at: Vec3) => at.equals(new Vec3(-8, 66, 0)) ? { name: "air", position: at } : original(at)) as never;
    // A real block-name change releases this plot immediately (not age, bot position or wall-clock alone).
    h.bot.blockAt = ((at: Vec3) => at.equals(new Vec3(-8, 66, 0)) ? { name: "birch_log", position: at } : original(at)) as never;
    assert.equal(h.runner().deferredPlots().size, 0);
    assert.equal(h.failures.loadAll().length, 0);
  } finally { h.db.close(); }
});

test("maintenance retry budget survives restart and selects useful field work instead of another blocked trunk", () => {
  const h = harness();
  try {
    h.opts.treeFarm = undefined;
    const original = h.bot.blockAt;
    h.bot.blockAt = ((at: Vec3) => {
      if (at.y === 63 && [-8, 8, 0].includes(at.x) && at.z === (at.x === 0 ? -8 : 0)) return { name: "farmland", position: at, boundingBox: "block" };
      if (at.x === -8 && at.y === 67 && at.z === 0) return { name: "birch_log", position: at, boundingBox: "block" };
      return original(at);
    }) as never;
    const runner = h.runner();
    // Different plots must share the bounded retry budget, without a permanent global failure block.
    for (const dx of [16, 24, 32]) (runner as any).defer({ dx, dz: 0 }, "leftover logs unreachable from supported ground", true);
    const restarted = new DevelopLandRunner(h.opts);
    assert.equal(restarted.nextWork()?.kind, "field", "an unattempted useful field remains eligible");
    h.advance();
    assert.equal(new DevelopLandRunner(h.opts).nextWork()?.kind, "tidy", "budget expires and maintenance can be reconsidered");
  } finally { h.db.close(); }
});

test("levelling verifies actual cut and fill, reports missing dirt, and preserves fixtures", async () => {
  const { WorldActionExecutor } = await import("../agent/world-actions.js");
  const h = harness();
  try {
    const cells = new Map<string, string>([["0,64,0", "farmland"], ["1,63,0", "air"], ["2,64,0", "torch"], ["2,63,0", "dirt"]]);
    h.bot.blockAt = ((at: Vec3) => ({ position: at, name: cells.get(`${at.x},${at.y},${at.z}`) ?? (at.y <= 63 ? "dirt" : "air"), boundingBox: at.y <= 63 ? "block" : "empty" })) as never;
    h.opts.actions!.collect = async (_bot, blocks) => { for (const b of blocks) cells.set(`${b.position.x},${b.position.y},${b.position.z}`, "air"); return 0; };
    h.opts.actions!.place = async (_bot, item, target) => { cells.set(`${target.position.x},${target.position.y},${target.position.z}`, item.name); return { name: item.name } as never; };
    const runner = new DevelopLandRunner(h.opts) as unknown as { levelSite(origin: { x: number; y: number; z: number }, size: number): Promise<{cut: number; filled: number; blocker?: string}> };
    const missing = await new WorldActionExecutor().run("level-missing", new AbortController().signal, () => runner.levelSite({ x: 0, y: 64, z: 0 }, 3));
    assert.equal(missing.cut, 1);
    assert.equal(missing.filled, 0);
    assert.match(missing.blocker ?? "", /missing fill material/);
    h.items.push({ name: "dirt", count: 5 });
    const done = await new WorldActionExecutor().run("level-fill", new AbortController().signal, () => runner.levelSite({ x: 0, y: 64, z: 0 }, 3));
    assert.equal(done.filled, 1);
    assert.equal(cells.get("1,63,0"), "dirt");
    assert.equal(cells.get("2,64,0"), "torch");
    assert.equal(cells.get("2,63,0"), "dirt", "fixture support survives");
    // A claimed placement acknowledgement without a world mutation is not progress.
    cells.set("1,63,0", "air");
    h.opts.actions!.place = async () => ({ name: "dirt" }) as never;
    const unverified = await new WorldActionExecutor().run("level-unverified", new AbortController().signal, () => runner.levelSite({ x: 0, y: 64, z: 0 }, 3));
    assert.equal(unverified.filled, 0);
  } finally { h.db.close(); }
});

test("bounded maintenance waits across restart when no other useful work exists", () => {
  const h = harness();
  try {
    h.opts.treeFarm = undefined;
    h.bot.blockAt = ((at: Vec3) => ({ position: at, name: at.y < 63 ? "dirt" : at.y === 63 ? "farmland" : at.x === -8 && at.z === 0 && at.y === 67 ? "birch_log" : "air", boundingBox: at.y <= 63 ? "block" : "empty" })) as never;
    const runner = h.runner();
    for (const dx of [16, 24, 32]) (runner as any).defer({ dx, dz: 0 }, "leftover logs unreachable from supported ground", true);
    const restarted = new DevelopLandRunner(h.opts);
    assert.equal(restarted.nextWork(), null);
    assert.equal(restarted.hasWork(), false, "do not enqueue zero-change tasks while all work is deferred");
    h.advance();
    assert.equal(new DevelopLandRunner(h.opts).nextWork()?.kind, "tidy");
  } finally { h.db.close(); }
});

test("new dirt releases missing-material blocker; unrelated inventory and unloaded terrain do not", () => {
  const h = harness();
  try {
    h.runner().defer({ dx: -8, dz: 0 }, "missing fill material: dirt required at -8,63,0");
    h.items.push({ name: "bread", count: 12 });
    assert.ok(h.runner().deferredPlots().has("-8,0"));
    const original = h.bot.blockAt;
    h.bot.blockAt = () => null;
    assert.ok(h.runner().deferredPlots().has("-8,0"), "chunk unload is not evidence of changed terrain");
    h.bot.blockAt = original;
    h.items.push({ name: "dirt", count: 10 });
    assert.equal(h.runner().deferredPlots().size, 0);
  } finally { h.db.close(); }
});

test("observed home chest dirt restocking releases a material blocker but unrelated supplies do not", () => {
  const h = harness();
  try {
    const supplies: Record<string, number> = {};
    h.opts.materialsAvailable = () => supplies;
    h.runner().defer({ dx: -8, dz: 0 }, "missing fill material: dirt required at -8,63,0");
    supplies.bread = 64; supplies.wheat_seeds = 128;
    assert.ok(h.runner().deferredPlots().has("-8,0"), "food or seed stock does not unblock fill");
    supplies.dirt = 12;
    assert.equal(h.runner().deferredPlots().size, 0);
  } finally { h.db.close(); }
});

test("cleanup backoff ignores incidental leaf and crop churn but releases on trunk or support changes", () => {
  const h = harness();
  try {
    const cells = new Map<string, string>([["-8,67,0", "birch_log"], ["-7,68,0", "birch_leaves"], ["-9,64,0", "wheat"]]);
    const original = h.bot.blockAt;
    h.bot.blockAt = ((at: Vec3) => cells.has(`${at.x},${at.y},${at.z}`) ? { position: at, name: cells.get(`${at.x},${at.y},${at.z}`) } : original(at)) as never;
    const reason = "leftover logs unreachable from supported ground";
    h.runner().defer({ dx: -8, dz: 0 }, reason);
    cells.set("-7,68,0", "air"); cells.set("-9,64,0", "air");
    assert.ok(h.runner().deferredPlots().has("-8,0"), "leaf decay and harvesting do not unblock the same unreachable trunk");
    h.advance();
    h.runner().defer({ dx: -8, dz: 0 }, reason);
    assert.equal(JSON.parse(h.failures.loadAll()[0]!.reason).attempts, 2, "incidental churn does not reset exponential history");
    cells.set("-8,67,0", "air");
    assert.equal(h.runner().deferredPlots().size, 0, "removed obstruction is a relevant change");
    cells.set("-8,67,0", "birch_log");
    h.runner().defer({ dx: -8, dz: 0 }, reason);
    cells.set("-8,63,0", "air");
    assert.equal(h.runner().deferredPlots().size, 0, "changed standing support merits re-evaluation");
  } finally { h.db.close(); }
});

test("planned plot disappearing after the home approach cannot mutate another plot under its identity", async () => {
  const { WorldActionExecutor } = await import("../agent/world-actions.js");
  const h = harness();
  try {
    h.opts.treeFarm = undefined;
    const logs = new Set(["-8,67,0", "8,67,0"]);
    const original = h.bot.blockAt;
    h.bot.blockAt = ((at: Vec3) => {
      if (logs.has(`${at.x},${at.y},${at.z}`)) return { position: at, name: "birch_log", boundingBox: "block" };
      if (at.y === 63 && [-8, 8].includes(at.x) && at.z === 0) return { position: at, name: "farmland", boundingBox: "block" };
      return original(at);
    }) as never;
    let collections = 0;
    h.opts.actions!.collect = async (_bot, blocks) => { collections++; for (const b of blocks) logs.delete(`${b.position.x},${b.position.y},${b.position.z}`); return 0; };
    const runner = new DevelopLandRunner(h.opts);
    const planned = runner.nextWork();
    assert.deepEqual(planned, { kind: "tidy", plot: "-8,0" });
    h.opts.actions!.home = async () => { logs.delete("-8,67,0"); return { status: "already_there" }; };
    const result = await new WorldActionExecutor().run("stale-development-plan", new AbortController().signal, () => runner.run({ planned: planned as any }));
    assert.equal(result.errorCode, "DEVELOPMENT_PLAN_STALE");
    assert.equal(result.data?.plot, null);
    assert.equal(collections, 0, "no mutation attempted against an unplanned plot");
    assert.ok(logs.has("8,67,0"));
    const fresh = runner.nextWork();
    assert.deepEqual(fresh, { kind: "tidy", plot: "8,0" });
    const completed = await new WorldActionExecutor().run("fresh-development-plan", new AbortController().signal, () => runner.run({ planned: fresh as any }));
    assert.deepEqual(completed.data?.plot, { dx: 8, dz: 0 });
    assert.equal(completed.data?.cleared, 1);
    assert.equal(collections, 1);
    assert.equal(logs.has("8,67,0"), false);
  } finally { h.db.close(); }
});

test("candidate exclusions select a different plot and return null when every candidate is excluded", () => {
  const h = harness();
  try {
    h.opts.treeFarm = undefined;
    const runner = new DevelopLandRunner(h.opts);
    const first = runner.nextWork();
    assert.equal(first?.plot, "-8,0");
    const alternative = runner.nextWork(work => work.plot !== first?.plot);
    assert.equal(alternative?.plot, "8,0");
    assert.equal(runner.nextWork(() => false), null);
  } finally { h.db.close(); }
});
