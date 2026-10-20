import test from "node:test";
import assert from "node:assert/strict";
import { StatusServer } from "./server.js";
import type { StatusSnapshot } from "./snapshot.js";
import { createServer } from "node:http";
import { ViewerShellServer } from "../dashboard/viewer-shell.js";

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

test("private diagnostic GET is read-only, retains feature flags and rejects browser reads", async () => {
  let reads = 0, toggles = 0, commands = 0;
  const server = new StatusServer({ host: "127.0.0.1", port: 0, status: () => ({} as StatusSnapshot), operator: {
    command: () => { commands++; return "unused"; },
    publicInteractions: {
      status: () => { reads++; return { configuredActions: false, modelQuestions: false, admission: { safe: false, checks: { threats: "blocked" } }, protocol: { private: "PRIVATE_CANARY" } }; },
      configure: () => { toggles++; return {}; },
    },
  } });
  server.start();
  try {
    while (!server.address()) await new Promise(resolve => setImmediate(resolve));
    const root = `http://127.0.0.1:${server.address()!.port}/public-interactions`;
    const response = await fetch(root), body = await response.json() as Record<string, unknown>;
    assert.equal(response.status, 200); assert.equal(body.configuredActions, false); assert.equal(body.modelQuestions, false);
    assert(JSON.stringify(body).includes("PRIVATE_CANARY")); assert.equal(reads, 1);
    assert.equal((await fetch(root, { headers: { origin: "https://bob.example" } })).status, 403);
    assert.equal((await fetch(root, { headers: { "sec-fetch-site": "cross-site" } })).status, 403);
    assert.equal(reads, 1); assert.equal(toggles, 0); assert.equal(commands, 0);
  } finally { server.stop(); }
});

test("public viewer cannot proxy private diagnostics even when its stats upstream is the operator server", async () => {
  let privateReads = 0;
  const operator = new StatusServer({ host: "127.0.0.1", port: 0, status: () => ({} as StatusSnapshot), operator: {
    publicInteractions: { status: () => { privateReads++; return { secret: "PRIVATE_CANARY" }; }, configure: () => { throw Error("must not toggle"); } },
  } });
  const temporary = createServer();
  await new Promise<void>(resolve => temporary.listen(0, "127.0.0.1", resolve));
  const address = temporary.address(); assert(address && typeof address !== "string");
  await new Promise<void>(resolve => temporary.close(() => resolve()));
  operator.start();
  while (!operator.address()) await new Promise(resolve => setImmediate(resolve));
  const shell = new ViewerShellServer({ host: "127.0.0.1", port: address.port, viewerPort: 1, statsPort: operator.address()!.port,
    mode: "public", publicState: async () => ({ connected: true }) });
  try {
    await shell.start();
    const root = `http://127.0.0.1:${address.port}`;
    for (const path of ["/public-interactions", "/status", "/health"]) {
      const response = await fetch(root+path);
      assert.equal(response.status, 404); assert(!(await response.text()).includes("PRIVATE_CANARY"));
    }
    const state = await fetch(root+"/api/state");
    assert.equal(state.status, 200); assert(!(await state.text()).includes("PRIVATE_CANARY"));
    assert.equal(privateReads, 0);
  } finally { await shell.stop(); operator.stop(); }
});
