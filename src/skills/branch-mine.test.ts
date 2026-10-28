import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bot } from "mineflayer";
import type { Block } from "prismarine-block";
import pino from "pino";
import { Vec3 } from "vec3";
import { branchMine, stepCells, type BranchMineActions } from "./branch-mine.js";

/** A solid stone world with a few overrides; dug cells become air. */
function world(overrides: Record<string, string> = {}) {
  const dug = new Set<string>();
  const names = new Map(Object.entries(overrides));
  const nameAt = (p: Vec3): string => {
    const key = p.floored().toString();
    if (dug.has(key)) return "air";
    return names.get(key) ?? "stone";
  };
  const blockAt = (p: Vec3) => {
    const name = nameAt(p);
    const solid = !/^(air|water|lava|torch)$/.test(name);
    return { name, position: p.floored(), boundingBox: solid ? "block" : "empty", hardness: solid ? 1.5 : 0 } as unknown as Block;
  };
  return { dug, names, blockAt };
}

function miner(start: Vec3, overrides: Record<string, string> = {}) {
  const w = world(overrides);
  // The bot stands in an open 1x2 pocket.
  w.dug.add(start.toString());
  w.dug.add(start.offset(0, 1, 0).toString());
  const position = new Vec3(start.x + 0.5, start.y, start.z + 0.5);
  let rawIron = 0;
  const bot = {
    entity: { position },
    health: 20,
    blockAt: w.blockAt,
    inventory: { items: () => [{ name: "stone_pickaxe", count: 1 }, ...(rawIron > 0 ? [{ name: "raw_iron", count: rawIron }] : [])] },
    findBlocks: ({ matching, maxDistance }: { matching: (b: Block) => boolean; maxDistance: number }) => {
      const out: Vec3[] = [];
      const c = position.floored();
      for (let x = -maxDistance; x <= maxDistance; x++) for (let y = -maxDistance; y <= maxDistance; y++) for (let z = -maxDistance; z <= maxDistance; z++) {
        const p = c.offset(x, y, z);
        if (matching(w.blockAt(p))) out.push(p);
      }
      return out;
    },
  } as unknown as Bot;
  const torches: string[] = [];
  const actions: BranchMineActions = {
    dig: async (_bot, block) => { w.dug.add(block.position.toString()); },
    travel: async (_bot, to) => { position.x = to.x; position.y = to.y; position.z = to.z; return true; },
    collect: async (_bot, targets) => { for (const t of targets) { w.dug.add(t.position.toString()); rawIron += 1; } },
    torch: async (_bot, _floor, at) => { torches.push(at.toString()); },
    shed: async () => 0,
    floor: async (_bot, at) => { w.dug.delete(at.toString()); w.names.set(at.toString(), "cobblestone"); return true; },
  };
  return { bot, w, position, torches, actions, get rawIron() { return rawIron; } };
}

const isIron = (block: Block) => block.name === "iron_ore" || block.name === "deepslate_iron_ore";

test("a step down opens the landing cell, head room, and the cell above", () => {
  assert.deepEqual(stepCells({ x: 0, y: 64, z: 0 }, [1, 0], true).map(String), ["(1, 63, 0)", "(1, 64, 0)", "(1, 65, 0)"]);
  assert.deepEqual(stepCells({ x: 0, y: 16, z: 0 }, [0, -1], false).map(String), ["(0, 16, -1)", "(0, 17, -1)"]);
});

test("branch mining stairs down to depth, tunnels, and mines ore the walls expose", async () => {
  // Iron one block beside the tunnel line at y=60, east of the stair's foot.
  const m = miner(new Vec3(0, 64, 0), { "(8, 60, 1)": "iron_ore", "(10, 61, -1)": "iron_ore" });
  const result = await branchMine({ bot: m.bot, logger: pino({ level: "silent" }), isOre: isIron, drop: "raw_iron", target: 2, targetY: 60, tunnelLength: 16, deadline: Date.now() + 10_000, actions: m.actions });
  assert.equal(result.mined, 2);
  assert.equal(result.reason, "target reached");
  assert.equal(m.position.y, 64, "walked its own stairs back up");
  assert.equal(Math.floor(m.position.x), 0);
});

test("the stair never opens into water: it turns, and stops when every way floods", async () => {
  // Water beside the first eastward step: the stair turns south instead.
  const m = miner(new Vec3(0, 64, 0), { "(2, 63, 0)": "water" });
  await branchMine({ bot: m.bot, logger: pino({ level: "silent" }), isOre: isIron, drop: "raw_iron", target: 1, targetY: 62, tunnelLength: 0, deadline: Date.now() + 5_000, actions: m.actions });
  assert.ok(![...m.w.dug].includes("(1, 63, 0)"), "did not dig the cell next to water");
  assert.ok([...m.w.dug].includes("(0, 63, 1)"), "the stair went south instead");

  const water: Record<string, string> = {};
  for (const [x, z] of [[2, 0], [-2, 0], [0, 2], [0, -2]] as const) water[new Vec3(x, 63, z).toString()] = "water";
  const boxed = miner(new Vec3(0, 64, 0), water);
  const result = await branchMine({ bot: boxed.bot, logger: pino({ level: "silent" }), isOre: isIron, drop: "raw_iron", target: 1, targetY: 60, tunnelLength: 0, deadline: Date.now() + 5_000, actions: boxed.actions });
  assert.equal(boxed.position.y, 64, "never stepped down");
  assert.match(result.reason, /water or lava/);
});

test("the tunnel is lit every eight steps", async () => {
  const m = miner(new Vec3(0, 20, 0));
  await branchMine({ bot: m.bot, logger: pino({ level: "silent" }), isOre: isIron, drop: "raw_iron", target: 99, targetY: 20, tunnelLength: 16, deadline: Date.now() + 10_000, actions: m.actions });
  assert.equal(m.torches.length, 2);
});

test("a repeat run walks the old tunnel and extends it into fresh rock", async () => {
  // 19:25-19:28 (2026-10-22): two runs from home walked the same tunnel and
  // mined nothing. Iron sits just past where the first run's tunnel ended.
  const old: Record<string, string> = { "(19, 20, 1)": "iron_ore" };
  const m = miner(new Vec3(0, 20, 0), old);
  for (let x = 1; x <= 16; x++) { m.w.dug.add(new Vec3(x, 20, 0).toString()); m.w.dug.add(new Vec3(x, 21, 0).toString()); }
  const result = await branchMine({ bot: m.bot, logger: pino({ level: "silent" }), isOre: isIron, drop: "raw_iron", target: 1, targetY: 20, tunnelLength: 8, deadline: Date.now() + 10_000, actions: m.actions });
  assert.equal(result.mined, 1, "reached the ore beyond the old tunnel's end");
});

test("the way back joins the trail at the nearest cell and skips one that will not take a step", async () => {
  // 19:41 (2026-10-22): ore pickup left the bot off the trail; the first
  // retrace leg stalled and it dug a new stair up from y=15 instead.
  const m = miner(new Vec3(0, 64, 0), { "(8, 60, 1)": "iron_ore" });
  const travel = m.actions.travel;
  let refused = false;
  m.actions.travel = async (bot, to, signal) => {
    if (!refused && m.rawIron > 0 && to.y === 60) { refused = true; return false; }
    return travel(bot, to, signal);
  };
  const result = await branchMine({ bot: m.bot, logger: pino({ level: "silent" }), isOre: isIron, drop: "raw_iron", target: 1, targetY: 60, tunnelLength: 16, deadline: Date.now() + 10_000, actions: m.actions });
  assert.equal(result.mined, 1);
  assert.ok(refused, "one leg was refused");
  assert.equal(m.position.y, 64, "still walked its own stairs back up");
});

test("cobblestone deep under the stair's top is dug through; near the top it is left alone", async () => {
  // 20:08 (2026-10-22): the stair stopped 32 cells down on the bot's own
  // cobblestone patch and the iron run came back empty.
  const deep = miner(new Vec3(0, 64, 0), { "(9, 55, 0)": "cobblestone", "(9, 56, 0)": "cobblestone", "(9, 57, 0)": "cobblestone" });
  const r = await branchMine({ bot: deep.bot, logger: pino({ level: "silent" }), isOre: isIron, drop: "raw_iron", target: 1, targetY: 52, tunnelLength: 0, deadline: Date.now() + 10_000, actions: deep.actions });
  assert.ok([...deep.w.dug].includes("(9, 55, 0)"), r.reason);

  const shallow = miner(new Vec3(0, 64, 0), { "(1, 63, 0)": "cobblestone" });
  await branchMine({ bot: shallow.bot, logger: pino({ level: "silent" }), isOre: isIron, drop: "raw_iron", target: 1, targetY: 60, tunnelLength: 0, deadline: Date.now() + 5_000, actions: shallow.actions });
  assert.ok(![...shallow.w.dug].includes("(1, 63, 0)"), "a block by the surface may be a build");
});

test("a step with no floor gets one laid instead of ending the run", async () => {
  // 2026-10-27: the ground under home was hollow, and every iron run in a
  // day stopped on the first step ("no floor") with nothing mined.
  const hollow: Record<string, string> = {};
  for (const [x, z] of [[1, 0], [0, 1], [-1, 0], [0, -1]] as const) hollow[new Vec3(x, 62, z).toString()] = "air";
  const m = miner(new Vec3(0, 64, 0), { ...hollow, "(6, 60, 1)": "iron_ore" });
  const result = await branchMine({ bot: m.bot, logger: pino({ level: "silent" }), isOre: isIron, drop: "raw_iron", target: 1, targetY: 60, tunnelLength: 16, deadline: Date.now() + 10_000, actions: m.actions });
  assert.equal(result.mined, 1, result.reason);
  assert.equal(m.w.names.get("(1, 62, 0)"), "cobblestone", "laid the missing floor");
});

test("the stair starts the way that already has a floor", async () => {
  const m = miner(new Vec3(0, 64, 0), { "(1, 62, 0)": "air" });
  m.actions.floor = async () => false;
  await branchMine({ bot: m.bot, logger: pino({ level: "silent" }), isOre: isIron, drop: "raw_iron", target: 1, targetY: 62, tunnelLength: 0, deadline: Date.now() + 5_000, actions: m.actions });
  assert.ok([...m.w.dug].includes("(0, 63, 1)"), "went south, where the floor was");
  assert.equal(m.position.y, 64, "and walked back up");
});

test("a stair blocked near its depth tunnels from there instead of climbing home empty", async () => {
  // 2026-10-28 17:47: a cave at y=33 stopped the stair on its way to 16.
  const cave: Record<string, string> = { "(8, 38, 1)": "iron_ore" };
  for (let x = -10; x <= 10; x++) for (let z = -10; z <= 10; z++) for (let y = 30; y <= 36; y++) cave[new Vec3(x, y, z).toString()] = "air";
  const m = miner(new Vec3(0, 40, 0), cave);
  m.actions.floor = async () => false;
  const result = await branchMine({ bot: m.bot, logger: pino({ level: "silent" }), isOre: isIron, drop: "raw_iron", target: 1, targetY: 16, tunnelLength: 16, deadline: Date.now() + 10_000, actions: m.actions });
  assert.equal(result.mined, 1, result.reason);
});

test("no floor is laid into an open cave; the stair goes around it", async () => {
  // 2026-10-28 19:41: bridging down through the cavern under home led into a skeleton and two zombies.
  const cave: Record<string, string> = {};
  for (let x = -4; x <= 4; x++) for (let z = -4; z <= 4; z++) for (let y = 58; y <= 62; y++) cave[new Vec3(x, y, z).toString()] = "air";
  const m = miner(new Vec3(0, 64, 0), cave);
  let laid = 0;
  const floor = m.actions.floor;
  m.actions.floor = async (bot, at, signal) => { laid += 1; return floor(bot, at, signal); };
  await branchMine({ bot: m.bot, logger: pino({ level: "silent" }), isOre: isIron, drop: "raw_iron", target: 1, targetY: 60, tunnelLength: 0, deadline: Date.now() + 5_000, actions: m.actions });
  assert.equal(laid, 0, "never bridged into the cave");
  assert.equal(m.position.y, 64, "stayed on the rock above it");
});

test("the tunnel turns away from gravel that would fall into the bot's head cell", async () => {
  // 2026-10-28 18:40: suffocated under gravel in its own tunnel at y=15.
  const m = miner(new Vec3(0, 20, 0), { "(3, 22, 0)": "gravel" });
  await branchMine({ bot: m.bot, logger: pino({ level: "silent" }), isOre: isIron, drop: "raw_iron", target: 99, targetY: 20, tunnelLength: 6, deadline: Date.now() + 10_000, actions: m.actions });
  assert.ok(![...m.w.dug].includes("(3, 21, 0)"), "did not open the cell under the gravel");
});
