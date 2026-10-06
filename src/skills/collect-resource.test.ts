import assert from "node:assert/strict";
import { test } from "node:test";
import { carriedItemName, nearRecentDeath, sourceBlockName, withinRadiusOfHome, woodenToolLogTarget } from "./collect-resource.js";

test("cobblestone is mined from stone and still accounted as cobblestone", () => {
  // Searching for cobblestone blocks found only the home's own (PROTECTED_REGION).
  assert.equal(sourceBlockName("cobblestone"), "stone");
  assert.equal(sourceBlockName("minecraft:cobbled_deepslate"), "deepslate");
  assert.equal(carriedItemName(sourceBlockName("cobblestone")), "cobblestone");
  assert.equal(carriedItemName(sourceBlockName("cobbled_deepslate")), "cobbled_deepslate");
});

test("other resources are mined as themselves", () => {
  assert.equal(sourceBlockName("acacia_log"), "acacia_log");
  assert.equal(sourceBlockName("iron_ore"), "iron_ore");
  assert.equal(sourceBlockName("blackstone"), "blackstone");
});

test("a wooden tool's log target is a total, so one carried log still gathers a second", () => {
  // Live 19:11:05: 1 log, no planks or sticks -> 5 planks needed -> 2 logs.
  // Passing the shortfall (1) as the total gathered nothing.
  assert.equal(woodenToolLogTarget(1, 0, true), 2);
  assert.equal(woodenToolLogTarget(0, 0, true), 2);
  assert.equal(woodenToolLogTarget(0, 0, false), 1);
  assert.equal(woodenToolLogTarget(0, 4, true), 1);
  assert.equal(woodenToolLogTarget(3, 0, true), 3);
  assert.equal(woodenToolLogTarget(0, 5, true), 0);
});

test("a capped run skips known sites beyond the radius from home", () => {
  const home = { x: 65, y: 96, z: 51 };
  // The 2026-10-04 coal site: ~150 blocks out and ~60 down.
  assert.equal(withinRadiusOfHome({ x: 154, y: 37, z: 142 }, home, 32), false);
  assert.equal(withinRadiusOfHome({ x: 80, y: 80, z: 60 }, home, 32), true);
  assert.equal(withinRadiusOfHome({ x: 154, y: 37, z: 142 }, home, Number.POSITIVE_INFINITY), true, "uncapped runs go anywhere");
  assert.equal(withinRadiusOfHome({ x: 154, y: 37, z: 142 }, null, 32), true);
});

test("a site pass stops at the run's target instead of mining the whole batch", async () => {
  // 00:10-00:16: a re-arm step asked for 3 stone, mined 56 until the
  // pickaxe broke: the pass was given no target.
  const { CollectResourceRunner } = await import("./collect-resource.js");
  const { withWorldActionLease } = await import("../agent/world-actions.js");
  const { Vec3 } = await import("vec3");
  const registry = (await import("prismarine-registry")).default("1.21.4");
  let cobblestone = 0;
  const dug: string[] = [];
  // Eight stone blocks, all within reach of the bot standing at 0.5,65,0.5.
  const cells = [[1, -1], [1, 0], [1, 1], [1, 2], [2, -1], [2, 0], [2, 1], [2, 2]].map(([x, z]) => `${x},${z}`);
  const stone = (x: number, z: number) => ({ name: "stone", type: registry.blocksByName.stone!.id, boundingBox: "block", position: new Vec3(x, 64, z), material: "mineable/pickaxe", diggable: true, hardness: 1.5 });
  const bot = {
    entity: { position: new Vec3(0.5, 65, 0.5), onGround: true, velocity: new Vec3(0, 0, 0), height: 1.8 },
    registry,
    health: 20,
    food: 20,
    game: { dimension: "overworld", gameMode: "survival" },
    heldItem: { name: "stone_pickaxe" },
    inventory: { items: () => [{ name: "stone_pickaxe", count: 1 }, ...(cobblestone > 0 ? [{ name: "cobblestone", count: cobblestone }] : [])], emptySlotCount: () => 30 },
    findBlocks: (options: { matching: (block: unknown) => boolean }) => cells.map((cell) => { const [x, z] = cell.split(",").map(Number); return new Vec3(x!, 64, z!); }).filter((p) => options.matching(bot.blockAt(p))),
    blockAt: (p: { x: number; y: number; z: number }) => (p.y === 64 && cells.includes(`${p.x},${p.z}`) && !dug.includes(`${p.x},${p.z}`) ? stone(p.x, p.z) : { name: "air", boundingBox: "empty", position: new Vec3(p.x, p.y, p.z) }),
    lookAt: async () => undefined,
    equip: async () => undefined,
    dig: async (block: { position: { x: number; z: number } }) => { dug.push(`${block.position.x},${block.position.z}`); cobblestone += 1; },
    stopDigging: () => undefined,
    pathfinder: { setGoal() {}, stop() {}, isMoving: () => false, goto: async () => undefined, setMovements() {} },
    digTime: () => 100,
  };
  const runner = new CollectResourceRunner({ bot, state: { home: null, worldId: null }, config: {}, logger: { info() {}, warn() {}, debug() {} }, bus: { emit() {} } } as unknown as ConstructorParameters<typeof CollectResourceRunner>[0]);
  const visit = await withWorldActionLease({ owner: "collect-test", signal: new AbortController().signal, acknowledged: Promise.resolve() }, () =>
    (runner as unknown as { gatherAtSite: (p: unknown, bare: string, carried: string, target: number) => Promise<{ gained: number }> }).gatherAtSite(new Vec3(1, 64, 0), "stone", "cobblestone", 3));
  assert.equal(cobblestone, 3, `mined ${cobblestone}`);
  assert.equal(visit.gained, 3);
});

test("remembered tree sites go nearest first, and far ones are left to the nearby search", async () => {
  // Death 87 (22:33, 2026-10-05): a wood restore crossed a lake to a log
  // site 60 blocks out and died in the water.
  const { knownSitesInOrder } = await import("./collect-resource.js");
  const sites = [{ id: 1, x: 44, y: 94, z: 132 }, { id: 2, x: 80, y: 96, z: 70 }, { id: 3, x: 70, y: 96, z: 90 }];
  const bot = { x: 73, y: 96, z: 79 };
  assert.deepEqual(knownSitesInOrder(sites, bot, "oak_log").map((s) => s.id), [2, 3]);
  assert.deepEqual(knownSitesInOrder(sites, bot, "coal_ore").map((s) => s.id), [2, 3, 1], "ore sites are kept, nearest first");
});

test("a resource site near a recent death is not gathered from", () => {
  // 2026-10-06: iron under a lake at 64,60,125 killed the bot at 02:50
  // (80,46,113) and 02:54 (70,55,123), and again at 08:58 once the goal's
  // 6-hour pause ran out.
  const now = Date.parse("2026-10-06T15:54:00Z");
  const deaths = [{ x: 70, y: 55, z: 123, at: Date.parse("2026-10-06T09:54:43Z") }];
  assert.equal(nearRecentDeath({ x: 64, y: 60, z: 125 }, deaths, now), true, "six hours later, still avoided");
  assert.equal(nearRecentDeath({ x: 20, y: 64, z: 60 }, deaths, now), false, "elsewhere is fine");
  assert.equal(nearRecentDeath({ x: 64, y: 60, z: 125 }, deaths, now + 24 * 60 * 60_000), false, "a day later it is open again");
});
