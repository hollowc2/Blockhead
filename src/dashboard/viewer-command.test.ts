import assert from "node:assert/strict";
import test from "node:test";
import { createViewerCommand, MAX_COMMAND_CHARS } from "./viewer-command.js";

test("viewer tasks reach the owner channel, with validation and a rate limit that never blocks Stop", async () => {
  const delivered: string[] = [];
  let clock = 0;
  const send = createViewerCommand({ deliver: (command) => { delivered.push(command); }, now: () => clock });
  for (const raw of [undefined, {}, "", "   ", "x".repeat(MAX_COMMAND_CHARS + 1)]) assert.equal((await send(raw)).ok, false);
  assert.equal((await send(" Gather 32\noak logs ")).ok, true);
  assert.deepEqual(delivered, ["Gather 32 oak logs"]);
  assert.deepEqual(await send("go home"), { ok: false, status: 429, error: "Wait a second before sending another task." });
  assert.equal((await send("stop")).ok, true);
  assert.equal((await send("Bob, stop!")).ok, true);
  clock += 1000;
  assert.equal((await send("go home")).ok, true);
});

test("a disconnected bot fails explicitly without consuming the next send", async () => {
  let connected = false;
  const send = createViewerCommand({ deliver: () => { if (!connected) throw new Error("offline"); }, now: () => 0 });
  assert.deepEqual(await send("go home"), { ok: false, status: 503, error: "CobbleBob is disconnected. Try again when he reconnects." });
  connected = true;
  assert.equal((await send("go home")).ok, true);
});
