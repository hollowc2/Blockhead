import test from "node:test";
import assert from "node:assert/strict";
import { StatusServer } from "./server.js";
import type { StatusSnapshot } from "./snapshot.js";

test("private loopback controls remain independent and browser origins cannot toggle them", async () => {
  let toggles = 0, commands = 0;
  const server = new StatusServer({ host: "127.0.0.1", port: 0, status: () => ({} as StatusSnapshot), operator: {
    command: () => { commands++; return "ok"; },
    publicInteractions: { status: () => ({ modelQuestions: false }), configure: raw => { toggles++; return raw; } },
  } });
  server.start();
  try {
    while (!server.address()) await new Promise(resolve => setImmediate(resolve));
    const root = `http://127.0.0.1:${server.address()!.port}`;
    assert.equal((await fetch(root + "/public-interactions")).status, 200);
    assert.equal((await fetch(root + "/public-interactions", { method: "POST", headers: { "content-type": "application/json", origin: "https://bob.example" }, body: "{}" })).status, 403);
    assert.equal(toggles, 0);
    assert.equal((await fetch(root + "/public-interactions", { method: "POST", headers: { "content-type": "application/json" }, body: '{"questions_enabled":false,"actions_enabled":false}' })).status, 200);
    assert.equal(toggles, 1);
    assert.equal((await fetch(root + "/command", { method: "POST", body: "stop" })).status, 200);
    assert.equal(commands, 1);
  } finally { server.stop(); }
});

test("operator control is absent on non-loopback bind", async () => {
  const server = new StatusServer({ host: "0.0.0.0", port: 0, status: () => ({} as StatusSnapshot), operator: { publicInteractions: { status: () => { throw Error("must not call"); }, configure: () => { throw Error("must not call"); } } } });
  server.start();
  try {
    while (!server.address()) await new Promise(resolve => setImmediate(resolve));
    assert.equal((await fetch(`http://127.0.0.1:${server.address()!.port}/public-interactions`)).status, 404);
  } finally { server.stop(); }
});
