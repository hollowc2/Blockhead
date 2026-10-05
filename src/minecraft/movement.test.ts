import assert from "node:assert/strict";
import { test } from "node:test";
import minecraftData from "minecraft-data";
import { Vec3 } from "vec3";
import { WorldActionExecutor } from "../agent/world-actions.js";
import { stopWorldPrimitives } from "../agent/world-actions.js";
import { climbToward, creativeFlyToAndWait, digToolKind, hasRoof, nearestShore, stepOffPerch, swimToShore, followPlayer, dropAhead, raceTrip, stepOffPartialBlock, travelAndWait, unwedge, avoidStuckCell, stuckCellCost, travelHomeAndWait, walkToward } from "./movement.js";

test("cancelled movement waits for the underlying pathfinder promise to settle", async () => {
  const events: string[] = [];
  let resolveGoto!: () => void;
  const goto = new Promise<void>((resolve) => { resolveGoto = resolve; });
  // Wait for the stop itself, not a fixed sleep: under full-suite load the
  // 5 ms timeout had not fired after 15 ms and the test flaked.
  const stopped = Promise.withResolvers<void>();
  const bot = { pathfinder: { stop: () => { events.push("stop"); stopped.resolve(); } } } as never;
  const executor = new WorldActionExecutor();
  const trip = executor.run("movement-test", new AbortController().signal, () => raceTrip(
    bot,
    goto.then(() => { events.push("goto-settled"); return { status: "arrived" as const }; }),
    { timeoutMs: 5 },
  ));

  await stopped.promise;
  assert.deepEqual(events, ["stop"]);
  resolveGoto();
  assert.deepEqual(await trip, { status: "timed_out" });
  assert.deepEqual(events, ["stop", "goto-settled"]);
});

test("a replaced follow goal cannot be stopped by the stale goal signal", async () => {
  const registry = minecraftData("1.21.11");
  const calls: string[] = [];
  const bot = {
    registry,
    entity: { position: new Vec3(0, 64, 0) },
    players: { alice: { entity: { position: new Vec3(10, 64, 0) } } },
    collectBlock: {},
    pathfinder: {
      setMovements: () => undefined,
      setGoal: (goal: unknown) => calls.push(goal === null ? "clear" : "goal"),
      stop: () => calls.push("stop"),
      goto: async () => undefined,
    },
  } as any;
  const firstController = new AbortController();
  await new WorldActionExecutor().run("follow-first", firstController.signal, async () => {
    assert.deepEqual((await followPlayer(bot, "alice")).ok, true);
  });
  await stopWorldPrimitives(bot);

  const secondController = new AbortController();
  await new WorldActionExecutor().run("follow-second", secondController.signal, async () => {
    assert.deepEqual((await followPlayer(bot, "alice")).ok, true);
  });
  const beforeStaleAbort = calls.length;
  firstController.abort(new Error("stale follow replaced"));
  assert.equal(calls.length, beforeStaleAbort);
  await stopWorldPrimitives(bot);
  assert.deepEqual(calls, ["goal", "stop", "clear", "goal", "stop", "clear"]);
});

test("home navigation recognizes the GoalNear boundary without routing forever", async () => {
  const registry = minecraftData("1.21.11");
  let gotoCalls = 0;
  const bot = {
    registry,
    game: { dimension: "overworld" },
    entity: { position: new Vec3(-43.5, -35, 0.5) },
    collectBlock: {},
    pathfinder: {
      setMovements: () => undefined,
      goto: async () => { gotoCalls += 1; },
      stop: () => undefined,
    },
  } as any;

  const controller = new AbortController();
  const result = await new WorldActionExecutor().run("home-boundary", controller.signal, () =>
    travelHomeAndWait(bot, { x: -46, y: 84, z: 0, dimension: "overworld" }, { signal: controller.signal }),
  );

  assert.deepEqual(result, { status: "already_there" });
  assert.equal(gotoCalls, 0);
});

test("a trip cut short by a pause reports aborted, not an unreachable destination", async () => {
  const registry = minecraftData("1.21.11");
  let paused = false;
  const bot = {
    registry,
    game: { dimension: "overworld" },
    entity: { position: new Vec3(0.5, 64, 0.5) },
    blockAt: () => null,
    collectBlock: {},
    pathfinder: {
      setMovements: () => undefined,
      // The self-defense reflex pauses the task and replaces the goal before
      // the trip's next shouldAbort poll.
      goto: async () => { paused = true; throw new Error("GoalChanged: The goal was changed before it could be completed!"); },
      stop: () => undefined,
      setGoal: () => undefined,
    },
  } as any;

  const controller = new AbortController();
  const result = await new WorldActionExecutor().run("paused-trip", controller.signal, () =>
    travelAndWait(bot, { x: 6, y: 64, z: 0 }, { range: 1, timeoutMs: 5_000, shouldAbort: () => paused }),
  );

  assert.deepEqual(result, { status: "aborted" });
});

test("creative flight sends packets and detects arrival without a move event", async () => {
  const packets: Array<{ x: number; y: number; z: number }> = [];
  const bot = {
    entity: { position: new Vec3(0, -60, 0) },
    creative: { startFlying: () => undefined, stopFlying: () => undefined },
    _client: { write: (_name: string, packet: { x: number; y: number; z: number }) => packets.push(packet) },
    supportFeature: () => true,
    physics: { gravity: 0 },
  } as any;
  const controller = new AbortController();
  const result = await new WorldActionExecutor().run("creative-arrival", controller.signal, () =>
    creativeFlyToAndWait(bot, { x: 2, y: -56, z: 0 }, { timeoutMs: 1_000, signal: controller.signal }),
  );
  assert.deepEqual(result, { status: "arrived" });
  assert.ok(packets.length > 0);
  assert.ok(bot.entity.position.distanceTo(new Vec3(2, -56, 0)) <= 0.75);
});

test("creative flight has a bounded timeout and cancellation", async () => {
  const bot = {
    entity: { position: new Vec3(0, -60, 0) },
    creative: { startFlying: () => undefined, stopFlying: () => undefined },
    _client: { write: () => undefined },
    supportFeature: () => true,
    physics: { gravity: 0 },
  } as any;
  const timeoutController = new AbortController();
  const timedOut = await new WorldActionExecutor().run("creative-timeout", timeoutController.signal, () =>
    creativeFlyToAndWait(bot, { x: 100, y: -60, z: 0 }, { timeoutMs: 110, signal: timeoutController.signal }),
  );
  assert.deepEqual(timedOut, { status: "timed_out" });

  const leaseController = new AbortController();
  const cancelController = new AbortController();
  const cancelled = new WorldActionExecutor().run("creative-cancel", leaseController.signal, () =>
    creativeFlyToAndWait(bot, { x: 100, y: -60, z: 0 }, { timeoutMs: 1_000, signal: cancelController.signal }),
  );
  setTimeout(() => cancelController.abort(), 10);
  assert.deepEqual(await cancelled, { status: "aborted" });
});

test("walkToward returns on abort even when a dig never settles (death mid-dig)", async () => {
  const events: string[] = [];
  const stone = { name: "stone", boundingBox: "block", hardness: 1.5, position: new Vec3(1, 64, 0) };
  const bot = {
    entity: { position: new Vec3(0.5, 64, 0.5) },
    inventory: { items: () => [] },
    blockAt: (pos: Vec3) => (pos.x === 1 && pos.y === 64 && pos.z === 0 ? stone : null),
    lookAt: async () => undefined,
    // Mineflayer settles a dig only on a block update to air, which never
    // arrives once the bot has died and respawned.
    dig: () => { events.push("dig"); return new Promise<void>(() => undefined); },
    stopDigging: () => events.push("stopDigging"),
    clearControlStates: () => undefined,
    setControlState: () => undefined,
  } as any;
  const controller = new AbortController();
  const walk = walkToward(bot, { x: 20, y: 64, z: 0 }, { signal: controller.signal, timeoutMs: 60_000 });
  while (!events.includes("dig")) await new Promise((resolve) => setTimeout(resolve, 20));
  const abortedAt = Date.now();
  controller.abort(new Error("task paused"));
  const result = await walk;
  assert.equal(result.arrived, false);
  assert.ok(Date.now() - abortedAt < 500, "walkToward must not wait on the wedged dig");
  assert.deepEqual(events, ["dig", "stopDigging"]);
});

test("a bot standing on the home chest walks off it before planning a trip", async () => {
  const { Vec3 } = await import("vec3");
  const position = new Vec3(65.5, 97.875, 49.5);
  const controls: string[] = [];
  const blockAt = (p: InstanceType<typeof Vec3>) => {
    const key = `${p.x},${p.y},${p.z}`;
    if (key === "65,97,49") return { name: "chest", boundingBox: "block" };
    if (p.y <= 96) return { name: "grass_block", boundingBox: "block" };
    return { name: "air", boundingBox: "empty" };
  };
  const bot = {
    entity: { position },
    blockAt,
    lookAt: async () => undefined,
    setControlState: (control: string, on: boolean) => {
      controls.push(`${control}:${on}`);
      if (on) position.x = 66.5; // walking east lands on open ground
    },
  } as never;
  await stepOffPartialBlock(bot);
  assert.deepEqual(controls, ["forward:true", "forward:false"]);
});

test("dropAhead sees a valley past a bridge edge and level ground", async () => {
  const { Vec3 } = await import("vec3");
  const ground = (groundY: (x: number) => number) => ({
    blockAt: (p: InstanceType<typeof Vec3>) => (p.y <= groundY(p.x) ? { name: "dirt", boundingBox: "block" } : { name: "air", boundingBox: "empty" }),
  }) as never;
  // Standing on a bridge at feet y=97 (block 96 under x<=82), valley floor at 71 beyond.
  const bridge = ground((x) => (x <= 82 ? 96 : 71));
  assert.ok(dropAhead(bridge, new Vec3(82.5, 97, 0.5), new Vec3(90, 97, 0.5)) > 3);
  const flat = ground(() => 96);
  assert.equal(dropAhead(flat, new Vec3(82.5, 97, 0.5), new Vec3(90, 97, 0.5)), 0);
});

test("unwedge moves a bot pinned on a block face toward its cell centre", async () => {
  const { Vec3 } = await import("vec3");
  const entity = { position: new Vec3(43.86, 91.42, -2.3), velocity: new Vec3(0.1, 0, 0.1), onGround: false };
  unwedge({ entity } as never);
  assert.ok(Math.abs(entity.position.z - -2.38) < 1e-9, "off the z=-2 face by 0.08");
  assert.ok(Math.abs(entity.position.x - 43.78) < 1e-9);
  assert.equal(entity.velocity.x, 0);
});

test("a cell the pathfinder kept failing costs extra for a few minutes", () => {
  avoidStuckCell({ x: 44.2, y: 92, z: -2.7 }, 1_000);
  assert.ok(stuckCellCost({ x: 44, y: 92, z: -3 }, 2_000) > 0);
  assert.ok(stuckCellCost({ x: 45, y: 93, z: -2 }, 2_000) > 0, "its neighbours too");
  assert.equal(stuckCellCost({ x: 50, y: 92, z: -3 }, 2_000), 0);
  assert.equal(stuckCellCost({ x: 44, y: 92, z: -3 }, 1_000 + 4 * 60_000), 0, "expires");
});

/** A solid-stone world with the given air cells; digging turns a cell to air. */
function stoneWorld(air: Vec3[], extra: Record<string, string> = {}) {
  const open = new Set(air.map((cell) => cell.toString()));
  const blockAt = (pos: Vec3) => {
    const at = pos.floored();
    const key = at.toString();
    const name = extra[key] ?? (open.has(key) ? "air" : "stone");
    const solid = name !== "air" && !/water|lava/.test(name);
    return { name, position: at, boundingBox: solid ? "block" : "empty", hardness: solid ? 1.5 : 0, material: "mineable/pickaxe" };
  };
  return { open, blockAt };
}

test("a bot in a sealed pocket staircases up to the destination's height", async () => {
  // Live 2026-10-04: trapped at y=37, the walkToward stall detector climbed
  // ~1 block per 8 s and the watchdog cancelled the trip every 5 minutes.
  const world = stoneWorld([new Vec3(0, 60, 0), new Vec3(0, 61, 0)]);
  const position = new Vec3(0.5, 60, 0.5);
  const bot = {
    entity: { position },
    blockAt: world.blockAt,
    inventory: { items: () => [] },
    lookAt: async () => {},
    dig: async (block: { position: Vec3 }) => { world.open.add(block.position.toString()); },
    stopDigging: () => {},
    setControlState: () => {},
    pathfinder: {
      setGoal: () => {},
      goto: async (goal: { x: number; y: number; z: number }) => {
        // The one-block step succeeds when both cells of the step are open.
        if (!world.open.has(new Vec3(goal.x, goal.y, goal.z).toString()) || !world.open.has(new Vec3(goal.x, goal.y + 1, goal.z).toString())) throw new Error("blocked");
        position.x = goal.x + 0.5; position.y = goal.y; position.z = goal.z + 0.5;
      },
    },
  } as unknown as Parameters<typeof climbToward>[0];
  const gained = await climbToward(bot, { x: 20, y: 70, z: 0 }, (block) => block !== null && block.boundingBox === "block", () => {}, { deadline: Date.now() + 5_000 });
  assert.ok(gained >= 8, `gained ${gained}`);
  assert.ok(position.x > 5, "the stair heads toward the destination");
});

test("the staircase never opens a cell next to lava", async () => {
  // Lava sits over the head cell every step and the pillar would open, so
  // the climb must stop rather than dig.
  const world = stoneWorld([new Vec3(0, 60, 0), new Vec3(0, 61, 0)], { "(0, 63, 0)": "lava" });
  const dug: string[] = [];
  const bot = {
    entity: { position: new Vec3(0.5, 60, 0.5) },
    blockAt: world.blockAt,
    inventory: { items: () => [] },
    lookAt: async () => {},
    dig: async (block: { position: Vec3 }) => { dug.push(block.position.toString()); world.open.add(block.position.toString()); },
    stopDigging: () => {},
    setControlState: () => {},
    pathfinder: { setGoal: () => {}, goto: async () => { throw new Error("blocked"); } },
  } as unknown as Parameters<typeof climbToward>[0];
  await climbToward(bot, { x: 20, y: 70, z: 0 }, (block) => block !== null && block.boundingBox === "block", () => {}, { deadline: Date.now() + 2_000 });
  assert.deepEqual(dug, []);
});

test("dig tools follow the block's material, not its name", () => {
  assert.equal(digToolKind({ name: "andesite", material: "mineable/pickaxe" }), "pickaxe");
  assert.equal(digToolKind({ name: "coal_ore", material: "mineable/pickaxe" }), "pickaxe");
  assert.equal(digToolKind({ name: "dirt", material: "mineable/shovel" }), "shovel");
  assert.equal(digToolKind({ name: "oak_log", material: "mineable/axe" }), "axe");
  assert.equal(digToolKind({ name: "tuff" }), "pickaxe");
});

/** An open-air world: a perch column at (0, 0..top-1, 0) over flat ground at y=-1. */
function perchWorld(top: number, groundY: number, extra: Record<string, string> = {}) {
  return (pos: Vec3) => {
    const at = pos.floored();
    const name = extra[at.toString()] ?? (at.y <= groundY ? "stone" : at.x === 0 && at.z === 0 && at.y < top ? "cobblestone" : "air");
    const solid = name !== "air" && !/water|lava/.test(name);
    return { name, position: at, boundingBox: solid ? "block" : "empty", hardness: solid ? 2 : 0, material: "mineable/pickaxe" };
  };
}

test("in the open the climb never towers up", async () => {
  // 18:31 2026-10-04: climbToward pillared three blocks up in open air and
  // the bot sat stranded on its own cobblestone column for 10+ minutes.
  let placed = 0;
  const bot = {
    entity: { position: new Vec3(0.5, 64, 0.5), onGround: true },
    blockAt: perchWorld(0, 63),
    inventory: { items: () => [{ name: "cobblestone", count: 32 }] },
    lookAt: async () => {},
    dig: async () => {},
    equip: async () => {},
    placeBlock: async () => { placed += 1; },
    setControlState: () => {},
    pathfinder: { setGoal: () => {}, goto: async () => { throw new Error("blocked"); } },
  } as unknown as Parameters<typeof climbToward>[0];
  assert.equal(hasRoof(bot, new Vec3(0.5, 64, 0.5)), false);
  await climbToward(bot, { x: 20, y: 70, z: 0 }, (block) => block !== null && block.boundingBox === "block", () => {}, { deadline: Date.now() + 1_000 });
  assert.equal(placed, 0);
});

function perchBot(health: number, blockAt: ReturnType<typeof perchWorld>) {
  const position = new Vec3(0.5, 3, 0.5); // on a 3-block column; ground at y=-2 is a 4-block drop
  const controls: Record<string, boolean> = {};
  const bot = {
    health,
    entity: { position, onGround: true },
    blockAt,
    lookAt: async () => {},
    clearControlStates: () => {},
    setControlState: (control: string, on: boolean) => {
      controls[control] = on;
      if (control === "forward" && on) { position.x = 1.5; position.y = 0; }
    },
  } as unknown as Parameters<typeof stepOffPerch>[0];
  return { bot, position };
}

test("a bot stranded on a perch steps off onto a landing within 5 blocks", async () => {
  const { bot, position } = perchBot(20, perchWorld(3, -2));
  assert.equal(await stepOffPerch(bot, { x: 50, z: 0 }), true);
  assert.equal(position.y, 0);
});

test("a perch rescue refuses lava landings, deep drops, and low health", async () => {
  const lava: Record<string, string> = {};
  for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) lava[new Vec3(x, -2, z).toString()] = "lava";
  assert.equal(await stepOffPerch(perchBot(20, perchWorld(3, -2, lava)).bot, { x: 50, z: 0 }), false, "lava below");
  assert.equal(await stepOffPerch(perchBot(20, perchWorld(3, -4)).bot, { x: 50, z: 0 }), false, "7-block drop");
  assert.equal(await stepOffPerch(perchBot(6, perchWorld(3, -2)).bot, { x: 50, z: 0 }), false, "low health");
});

/** A pool of water (x < 3, y 58..59) with an andesite bank at x >= 3 whose top is y=59. */
function poolWorld(pos: Vec3) {
  const at = pos.floored();
  let name = "air";
  if (at.y < 58) name = "andesite";
  else if (at.x >= 3 && at.y <= 59) name = "andesite";
  else if (at.x < 3 && at.y <= 59) name = "water";
  const solid = name === "andesite";
  return { name, position: at, boundingBox: solid ? "block" : "empty" };
}

test("a bot treading water in a cave pool swims to the bank", async () => {
  // 18:59 2026-10-04: in a pool every route leg was noPath after one node and
  // the coal haul never reached the chest.
  const position = new Vec3(0.5, 59.4, 0.5);
  const entity = { position, onGround: false };
  const bot = {
    entity,
    blockAt: poolWorld,
    lookAt: async () => {},
    clearControlStates: () => {},
    setControlState: (control: string, on: boolean) => {
      if (control === "forward" && on) { position.x = 3.5; position.y = 60; entity.onGround = true; }
    },
  } as unknown as Parameters<typeof swimToShore>[0];
  const shore = nearestShore(bot, { x: 50, z: 0 });
  assert.ok(shore !== null && shore.x >= 3 && shore.y === 60, `shore ${shore}`);
  assert.equal(await swimToShore(bot, { x: 50, z: 0 }), true);
});

test("a bot on dry ground is not sent swimming", async () => {
  const bot = { entity: { position: new Vec3(4.5, 60, 0.5), onGround: true }, blockAt: poolWorld } as unknown as Parameters<typeof swimToShore>[0];
  assert.equal(await swimToShore(bot, { x: 50, z: 0 }), false);
});
