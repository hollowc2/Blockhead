import assert from "node:assert/strict";
import { test } from "node:test";
import { raceTrip } from "./movement.js";

test("cancelled movement waits for the underlying pathfinder promise to settle", async () => {
  const events: string[] = [];
  let resolveGoto!: () => void;
  const goto = new Promise<void>((resolve) => { resolveGoto = resolve; });
  const bot = { pathfinder: { stop: () => events.push("stop") } } as never;
  const trip = raceTrip(bot, goto.then(() => { events.push("goto-settled"); return { status: "arrived" as const }; }), { timeoutMs: 5 });

  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.deepEqual(events, ["stop"]);
  resolveGoto();
  assert.deepEqual(await trip, { status: "timed_out" });
  assert.deepEqual(events, ["stop", "goto-settled"]);
});
