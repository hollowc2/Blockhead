import assert from "node:assert/strict";
import { test } from "node:test";
import minecraftData from "minecraft-data";
import { Vec3 } from "vec3";
import { WorldActionExecutor } from "../agent/world-actions.js";
import { stopWorldPrimitives } from "../agent/world-actions.js";
import { followPlayer, raceTrip, travelHomeAndWait } from "./movement.js";

test("cancelled movement waits for the underlying pathfinder promise to settle", async () => {
  const events: string[] = [];
  let resolveGoto!: () => void;
  const goto = new Promise<void>((resolve) => { resolveGoto = resolve; });
  const bot = { pathfinder: { stop: () => events.push("stop") } } as never;
  const executor = new WorldActionExecutor();
  const trip = executor.run("movement-test", new AbortController().signal, () => raceTrip(
    bot,
    goto.then(() => { events.push("goto-settled"); return { status: "arrived" as const }; }),
    { timeoutMs: 5 },
  ));

  await new Promise((resolve) => setTimeout(resolve, 15));
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
