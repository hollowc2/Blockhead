import test from "node:test";
import assert from "node:assert/strict";
import { StatusServer } from "./server.js";
import type { StatusSnapshot } from "./snapshot.js";
import { createServer, request } from "node:http";
import { ViewerShellServer } from "../dashboard/viewer-shell.js";

// Node fetch adds browser Fetch Metadata. Exercise the intended CLI channel with raw HTTP.
const fetch = (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Response> => new Promise((resolve, reject) => {
  const req = request(url, { method: init.method ?? "GET", headers: init.headers }, res => {
    const chunks: Buffer[] = []; res.on("data", c => chunks.push(c));
    res.on("end", () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode! })));
  }); req.on("error", reject); req.end(init.body);
});

test("private loopback controls remain independent and browser origins cannot toggle them", async () => {
  let toggles = 0, commands = 0;
  const server = new StatusServer({ operatorToken: "test-only-operator-token-32-chars-long", host: "127.0.0.1", port: 0, status: () => ({} as StatusSnapshot), operator: {
    command: () => { commands++; return "ok"; },
    publicInteractions: { status: () => ({ modelQuestions: false }), configure: raw => { toggles++; return raw; } },
  } });
  server.start();
  try {
    while (!server.address()) await new Promise(resolve => setImmediate(resolve));
    const root = `http://127.0.0.1:${server.address()!.port}`;
    assert.equal((await fetch(root + "/public-interactions", { headers: { authorization: "Bearer test-only-operator-token-32-chars-long" } })).status, 200);
    assert.equal((await fetch(root + "/public-interactions", { method: "POST", headers: { "content-type": "application/json", origin: "https://bob.example" }, body: "{}" })).status, 403);
    assert.equal(toggles, 0);
    assert.equal((await fetch(root + "/public-interactions", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer test-only-operator-token-32-chars-long" }, body: '{"questions_enabled":false,"actions_enabled":false}' })).status, 200);
    assert.equal(toggles, 1);
    assert.equal((await fetch(root + "/command", { method: "POST", headers: { authorization: "Bearer test-only-operator-token-32-chars-long", "content-type": "text/plain" }, body: "stop" })).status, 200);
    assert.equal(commands, 1);
  } finally { server.stop(); }
});

test("operator control is absent on non-loopback bind", async () => {
  const server = new StatusServer({ operatorToken: "test-only-operator-token-32-chars-long", host: "0.0.0.0", port: 0, status: () => ({} as StatusSnapshot), operator: { publicInteractions: { status: () => { throw Error("must not call"); }, configure: () => { throw Error("must not call"); } } } });
  server.start();
  try {
    while (!server.address()) await new Promise(resolve => setImmediate(resolve));
    assert.equal((await fetch(`http://127.0.0.1:${server.address()!.port}/public-interactions`)).status, 404);
  } finally { server.stop(); }
});

test("private diagnostic GET is read-only, retains feature flags and rejects browser reads", async () => {
  let reads = 0, toggles = 0, commands = 0;
  const server = new StatusServer({ operatorToken: "test-only-operator-token-32-chars-long", host: "127.0.0.1", port: 0, status: () => ({} as StatusSnapshot), operator: {
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
    const response = await fetch(root, { headers: { authorization: "Bearer test-only-operator-token-32-chars-long" } }), body = await response.json() as Record<string, unknown>;
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
      const response = await fetch(root+path, { headers: { authorization: "Bearer test-only-operator-token-32-chars-long", "x-forwarded-for": "127.0.0.1", "x-blockhead-owner": "1" } });
      assert.equal(response.status, 404); assert(!(await response.text()).includes("PRIVATE_CANARY"));
    }
    const state = await fetch(root+"/api/state");
    assert.equal(state.status, 200); assert(!(await state.text()).includes("PRIVATE_CANARY"));
    assert.equal(privateReads, 0);
  } finally { await shell.stop(); operator.stop(); }
});

test("operator authentication, origin policy and body bounds fail before invoking hooks", async () => {
  let calls = 0;
  const token = "test-only-operator-token-32-chars-long";
  const server = new StatusServer({ host: "127.0.0.1", port: 0, bodyTimeoutMs: 30, operatorToken: token, status: () => ({} as StatusSnapshot), operator: { command: () => { calls++; return "ok"; } } });
  server.start();
  try {
    while (!server.address()) await new Promise(resolve => setImmediate(resolve));
    const root = `http://127.0.0.1:${server.address()!.port}/command`;
    for (const authorization of [undefined, "Bearer wrong", "Basic abc", "Bearer", "bearer " + token, "Bearer " + token + " extra"]) {
      const res = await fetch(root, { method: "POST", headers: { ...(authorization ? { authorization } : {}), "content-type": "text/plain" }, body: "stop" });
      assert.equal(res.status, 401);
    }
    for (const extra of [{ origin: "null" }, { origin: "https://attacker.example" }, { "sec-fetch-site": "same-origin" }, { "sec-fetch-site": "cross-site" }, { "sec-fetch-mode": "cors" }]) {
      assert.equal((await fetch(root, { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "text/plain", ...extra } as unknown as Record<string, string>, body: "stop" })).status, 403);
    }
    assert.equal((await fetch(root, { method: "POST", headers: { authorization: "Bearer " + token }, body: "stop" })).status, 415);
    assert.equal((await fetch(root, { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "text/plain" }, body: "x".repeat(4097) })).status, 413);
    const slow = await new Promise<number>((resolve, reject) => {
      const req = request(root, { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "text/plain" } }, res => { res.resume(); res.on("end", () => resolve(res.statusCode!)); });
      req.on("error", reject); req.write("st");
    });
    assert.equal(slow, 408); assert.equal(calls, 0);
    assert.equal((await fetch(root, { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "text/plain; charset=utf-8" }, body: "stop" })).status, 200);
    assert.equal(calls, 1);
  } finally { server.stop(); }
  const disabled = new StatusServer({ host: "127.0.0.1", port: 0, status: () => ({} as StatusSnapshot), operator: { command: () => { throw Error("must not call"); } } });
  disabled.start();
  try {
    while (!disabled.address()) await new Promise(resolve => setImmediate(resolve));
    assert.equal((await fetch(`http://127.0.0.1:${disabled.address()!.port}/command`, { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "text/plain" }, body: "stop" })).status, 401);
  } finally { disabled.stop(); }
});
