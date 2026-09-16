import assert from "node:assert/strict";
import { request } from "node:http";
import { test } from "node:test";
import WebSocket from "ws";
import type { DashboardSnapshot } from "./types.js";
import { DashboardServer } from "./server.js";

const snapshot = (n: number): DashboardSnapshot => ({
  schema: 1, process: { startedAt: "2026-01-01T00:00:00.000Z", uptimeSeconds: n },
  connection: { connected: false, player: null, server: null },
  self: { health: null, hunger: null, position: null, dimension: null, timePhase: null },
  goal: null, task: null, action: { label: "Standing by", taskId: null }, background: { label: "Standing by", taskId: null },
  stockpiles: null, inventory: null, danger: null,
  llmLastCall: { at: null, latencyMs: null, tool: null, rationale: null },
  llmActivity: { state: "not_called", thinking: false, decisionType: null, thinkingStartedAt: null, thinkingDurationMs: null, model: null, endpoint: null, lastAction: null, lastRationale: null, lastLatencyMs: null, lastFailure: null },
  path: null, recentEvents: [], recentFailures: [], recentChat: [],
});

async function waitForPort(server: DashboardServer): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const port = server.address()?.port;
    if (port !== undefined) return port;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("server did not start");
}

async function http(port: number, method: string, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => body += chunk);
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

function running(snapshotValue: () => DashboardSnapshot): { server: DashboardServer; port: Promise<number> } {
  const server = new DashboardServer({ host: "127.0.0.1", port: 0, snapshot: snapshotValue });
  server.start();
  return { server, port: waitForPort(server) };
}

test("serves health, state, static root, and JSON 404", async () => {
  const { server, port: portPromise } = running(() => snapshot(7));
  const port = await portPromise;
  try {
    assert.deepEqual(JSON.parse((await http(port, "GET", "/health")).body), { ok: true, service: "blockhead-dashboard" });
    assert.deepEqual(JSON.parse((await http(port, "GET", "/api/state")).body), snapshot(7));
    const root = await http(port, "GET", "/");
    assert.equal(root.status, 200);
    assert.match(root.body, /CobbleBob Dashboard/);
    assert.match(root.body, /href="\/dashboard\.css"/);
    assert.match(root.body, /src="\/dashboard\.js"/);
    const css = await http(port, "GET", "/dashboard.css");
    assert.equal(css.status, 200);
    assert.match(css.body, /status-live/);
    const js = await http(port, "GET", "/dashboard.js");
    assert.equal(js.status, 200);
    assert.match(js.body, /\/api\/state/);
    assert.match(js.body, /\/ws/);
    const missing = await http(port, "GET", "/missing");
    assert.equal(missing.status, 404);
    assert.deepEqual(JSON.parse(missing.body), { error: "not found" });
  } finally { server.stop(); }
});

test("does not serve unknown static paths", async () => {
  const { server, port: portPromise } = running(() => snapshot(1));
  const port = await portPromise;
  try {
    for (const path of ["/dashboard.json", "/public/index.html", "/../package.json", "/%2e%2e/package.json"]) {
      const response = await http(port, "GET", path);
      assert.equal(response.status, 404, path);
      assert.deepEqual(JSON.parse(response.body), { error: "not found" });
    }
  } finally { server.stop(); }
});

test("rejects mutation-style requests", async () => {
  const { server, port: portPromise } = running(() => snapshot(1));
  const port = await portPromise;
  try {
    const requests: readonly (readonly [string, string])[] = [["POST", "/api/state"], ["PUT", "/"], ["DELETE", "/health"]];
    for (const [method, path] of requests) {
      const response = await http(port, method, path);
      assert.equal(response.status, 405);
      assert.deepEqual(JSON.parse(response.body), { error: "method not allowed" });
    }
  } finally { server.stop(); }
});

test("sends initial and subsequent snapshots, and stops disconnected clients", async () => {
  let count = 0;
  const { server, port: portPromise } = running(() => snapshot(++count));
  const port = await portPromise;
  const client = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const messages: DashboardSnapshot[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      client.once("error", reject);
      client.on("message", (data) => {
        messages.push((JSON.parse(data.toString()) as { data: DashboardSnapshot }).data);
        if (messages.length === 2) resolve();
      });
    });
    assert.equal(messages[0]?.process.uptimeSeconds, 1);
    assert.equal(messages[1]?.process.uptimeSeconds, 2);
    client.close();
    await new Promise((resolve) => client.once("close", resolve));
    const before = count;
    await new Promise((resolve) => setTimeout(resolve, 550));
    assert.equal(count, before);
  } finally { client.close(); server.stop(); }
});

test("drops a snapshot when a client has excessive buffered output", async () => {
  const { server, port: portPromise } = running(() => snapshot(1));
  const port = await portPromise;
  const client = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const messages: string[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      client.once("error", reject);
      client.on("message", (data) => {
        messages.push(data.toString());
        resolve();
      });
    });
    const initialMessages = messages.length;
    const serverClient = [...(server as unknown as { clients: Set<WebSocket> }).clients][0];
    assert.ok(serverClient);
    Object.defineProperty(serverClient, "bufferedAmount", { configurable: true, value: 2_000_000 });
    await new Promise((resolve) => setTimeout(resolve, 550));
    assert.equal(messages.length, initialMessages);
    delete (serverClient as unknown as Record<string, unknown>).bufferedAmount;
  } finally { client.close(); server.stop(); }
});

test("stopping closes the listener and websocket", async () => {
  const { server, port: portPromise } = running(() => snapshot(1));
  const port = await portPromise;
  const client = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise<void>((resolve, reject) => { client.once("open", resolve); client.once("error", reject); });
  server.stop();
  await new Promise((resolve) => client.once("close", resolve));
  await assert.rejects(http(port, "GET", "/health"));
});
