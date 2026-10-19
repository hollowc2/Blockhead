import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createWorldStatsReader, MILESTONES, resolveServerStatsFile, summarizeWorldStats } from "./world-stats.js";

const UUID = "702121cc-c245-361f-972c-a421a20e5c81";
const stats = {
  "minecraft:mined": { "minecraft:stone": 5787, "minecraft:oak_log": 80, "minecraft:birch_log": 40, "minecraft:wheat": 16050, "minecraft:diamond_ore": 0 },
  "minecraft:crafted": { "minecraft:bread": 900, "minecraft:torch": 372, "minecraft:iron_pickaxe": 1 },
  "minecraft:killed": { "minecraft:zombie": 101, "minecraft:skeleton": 63, "minecraft:pig": 105 },
  "minecraft:killed_by": { "minecraft:zombie": 31, "minecraft:drowned": 30 },
  "minecraft:custom": { "minecraft:total_world_time": 24000 * 12 + 500, "minecraft:walk_one_cm": 4_000_000, "minecraft:sprint_one_cm": 1_000_000, "minecraft:deaths": 7 },
};

test("summarizes server stats into headline numbers", () => {
  const summary = summarizeWorldStats(stats, { buildsCompleted: 35, deaths: 9 });
  assert.equal(summary.day, 12);
  assert.equal(summary.blocksMined, 5787 + 120 + 16050);
  assert.equal(summary.mobsKilled, 269);
  assert.equal(summary.deaths, 9, "the larger of server and DB death counts wins");
  assert.equal(summary.distanceKm, 50);
  assert.equal(summary.buildsCompleted, 35);
  assert.equal(summary.nemesis, "zombie");
});

test("milestones unlock at their targets and report progress toward the next", () => {
  const byId = new Map(summarizeWorldStats(stats, { buildsCompleted: 35, deaths: 9 }).milestones.map((m) => [m.id, m]));
  assert.equal(byId.size, MILESTONES.length);
  assert.equal(byId.get("day-7")!.unlocked, true);
  assert.equal(byId.get("day-30")!.unlocked, false);
  assert.equal(byId.get("day-30")!.progress, 0.4);
  assert.equal(byId.get("logs-100")!.unlocked, true);
  assert.equal(byId.get("iron-pickaxe")!.unlocked, true);
  assert.equal(byId.get("diamond")!.unlocked, false);
  assert.equal(byId.get("kills-100")!.unlocked, true, "only hostile kills count; pigs do not");
  assert.equal(byId.get("kills-500")!.progress, 164 / 500);
  assert.equal(byId.get("bread-1000")!.unlocked, false);
  assert.equal(byId.get("builds-10")!.unlocked, true);
  assert.equal(byId.get("deaths-9")!.unlocked, true);
});

test("without a stats file only DB-backed numbers are known", () => {
  const summary = summarizeWorldStats(null, { buildsCompleted: 2, deaths: 1 });
  assert.equal(summary.day, null);
  assert.equal(summary.blocksMined, 0);
  assert.equal(summary.buildsCompleted, 2);
  assert.equal(summary.milestones.find((m) => m.id === "builds-1")!.unlocked, true);
});

function serverDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mc-server-"));
  writeFileSync(join(dir, "server.properties"), "motd=hi\nlevel-name=forest-world\n");
  writeFileSync(join(dir, "usercache.json"), JSON.stringify([{ name: "Someone", uuid: "eda03cb5-2559-3b6a-9157-e27b04bca6bc" }, { name: "CobbleBob", uuid: UUID }]));
  mkdirSync(join(dir, "forest-world", "stats"), { recursive: true });
  writeFileSync(join(dir, "forest-world", "stats", `${UUID}.json`), JSON.stringify({ stats, DataVersion: 4189 }));
  return dir;
}

test("finds the bot's stats file from server.properties and usercache.json", async () => {
  const dir = serverDir();
  assert.equal(await resolveServerStatsFile(dir, "cobblebob"), join(dir, "forest-world", "stats", `${UUID}.json`));
  assert.equal(await resolveServerStatsFile(dir, "Nobody"), null);
});

test("reader serves the cached summary synchronously and refreshes in the background", async () => {
  let clock = 0;
  let builds = 1;
  const reader = createWorldStatsReader({ serverDir: serverDir(), username: "CobbleBob", dbCounts: () => ({ buildsCompleted: builds, deaths: 0 }), ttlMs: 1000, now: () => clock });
  assert.equal(reader.current(), null, "first call starts a refresh");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(reader.current()?.day, 12);
  builds = 5;
  assert.equal(reader.current()?.buildsCompleted, 1, "still fresh, no re-read");
  clock = 1000;
  reader.current();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(reader.current()?.buildsCompleted, 5);
});

test("a missing server dir degrades to DB counts instead of failing", async () => {
  const errors: unknown[] = [];
  const reader = createWorldStatsReader({ serverDir: "/nonexistent/mc", username: "CobbleBob", dbCounts: () => ({ buildsCompleted: 3, deaths: 2 }), onError: (e) => errors.push(e) });
  reader.current();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(reader.current()?.buildsCompleted, 3);
  assert.equal(reader.current()?.day, null);
  assert.equal(errors.length, 1);
});
