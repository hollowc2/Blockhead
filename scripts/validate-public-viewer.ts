/** Bounded, isolated launch workload. No production bot, database or inference. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { writeFile } from "node:fs/promises";
import { io as connect, type Socket } from "socket.io-client";
import { Vec3 } from "vec3";
import type { Bot } from "mineflayer";
import { ReadOnlyViewerServer } from "../src/dashboard/viewer-server.js";
import { ViewerShellServer } from "../src/dashboard/viewer-shell.js";
import { LlamaClient } from "../src/llm/client.js";
import { answerWithModel } from "../src/dashboard/public-model-chat.js";
import { PublicInteractions } from "../src/dashboard/public-interactions.js";
import { PublicActionController } from "../src/agent/public-actions.js";

async function freePort(): Promise<number> {
  const server = createServer(); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert(address && typeof address !== "string");
  await new Promise<void>(resolve => server.close(() => resolve())); return address.port;
}
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert(check(), "bounded cleanup/queue transition completed within one second");
}
const require = createRequire(import.meta.url), Chunk = require("prismarine-chunk")("1.21.4");
const column = new Chunk(); column.blockEntities = { sign: { text: "LOAD_PRIVATE_CANARY", x: 123456 } };
column.setBlockStateId(new Vec3(0, 63, 0), 1);
const bot = Object.assign(new EventEmitter(), { version: "1.21.4", username: "FakeBob", entities: {}, entity: { position: new Vec3(8, 64, 8), yaw: 0, pitch: 0 }, inventory: Object.assign(new EventEmitter(), { slots: [] }), world: { getColumnAt: async () => column }, getEquipmentDestSlot: () => 0 }) as unknown as Bot;
let finishSlow!: () => void, slowStarted!: () => void;
const slowBegan = new Promise<void>(resolve => { slowStarted = resolve; });
const modelCalls: string[] = [];
const model = new LlamaClient({ baseUrl: "http://fixture-model.invalid", timeoutMs: 5000, maxRetries: 0, fetchImpl: async (url, options) => {
  if (String(url).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "fixture" }] }));
  const label = JSON.parse(String(options!.body)).messages.at(-1).content; modelCalls.push(label);
  if (label === "private hold") { slowStarted(); await new Promise<void>(resolve => { finishSlow = resolve; }); }
  return new Response(JSON.stringify({ choices: [{ message: { content: "Local fixture answer." } }] }));
} });
const viewerPort = await freePort(), shellPort = await freePort();
const root = `http://127.0.0.1:${shellPort}`;
const gestures = new PublicActionController({ session: () => null, safe: () => false, tryRun: () => null });
const interactions = new PublicInteractions({ config: { allowed_origin: root, questions_enabled: true, actions_enabled: false }, gestures,
  facts: () => ({ connected: true, health: 20, hunger: 20, time: "day", activity: "resting", actions: false }),
  modelAnswer: (question, facts, signal, deadline) => answerWithModel(messages => model.complete(messages, { signal, deadline, priority: "public" }), facts, question, signal),
});
const viewer = new ReadOnlyViewerServer(bot, { host: "127.0.0.1", port: viewerPort, viewDistance: 2, maxPublicConnections: 6, maxConnections: 10 });
const shell = new ViewerShellServer({ host: "127.0.0.1", port: shellPort, viewerPort, statsPort: 1, mode: "public", publicInteractions: interactions,
  publicState: async () => ({ public: true, connection: { connected: true }, viewer: { status: "running" }, interactions: interactions.availability() }),
});
const sockets: Socket[] = [];
const chunkBytes: number[] = [];
const errors: unknown[] = [];
let admitted = 0, refused = 0;
function join(n: number, isPublic = true, polling = false): Promise<Socket | null> {
  return new Promise(resolve => {
    const socket = connect(isPublic ? root : `http://127.0.0.1:${viewerPort}`, { transports: polling ? ["polling", "websocket"] : ["websocket"], reconnection: false, forceNew: true, timeout: 1500, extraHeaders: isPublic ? { "x-forwarded-for": `192.0.2.${n}` } : {} });
    sockets.push(socket);
    socket.on("loadChunk", payload => { if (isPublic) { if (JSON.stringify(payload).includes("LOAD_PRIVATE_CANARY")) errors.push("public metadata"); chunkBytes.push(Buffer.byteLength(JSON.stringify(payload))); } });
    socket.once("connect", () => { admitted++; resolve(socket); });
    socket.once("connect_error", () => { refused++; socket.close(); resolve(null); });
  });
}
const loop = monitorEventLoopDelay({ resolution: 10 }); loop.enable();
const memoryBefore = process.memoryUsage().rss;
let peakRss = memoryBefore;
const memoryTimer = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 20);
const began = performance.now();
const apiLatency: number[] = [];
try {
  await viewer.start(); await shell.start();
  const burst = await Promise.all(Array.from({ length: 12 }, (_, i) => join(i + 1)));
  assert.equal(burst.filter(Boolean).length, 6);
  assert.deepEqual(viewer.diagnostics(), { pending: 0, public: 6, total: 6 });
  const privateSeats = await Promise.all(Array.from({ length: 4 }, (_, i) => join(i, false)));
  assert.equal(privateSeats.filter(Boolean).length, 4);
  assert.equal(viewer.diagnostics().total, 10);
  const saturated = viewer.diagnostics();
  const peakBotListeners = Object.fromEntries(bot.eventNames().map(event => [String(event), bot.listenerCount(event)]));
  assert(Object.values(peakBotListeners).every(count => count <= 1), "one bot listener per viewer event at saturation");
  for (let i = 0; i < 20; i++) {
    const at = performance.now(); const response = await fetch(root + "/api/state"); assert.equal(response.status, 200); await response.json(); apiLatency.push(performance.now() - at);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  burst.forEach(socket => socket?.close()); privateSeats.forEach(socket => socket?.close());
  await until(() => viewer.diagnostics().total === 0 && bot.listenerCount("move") === 0);
  const baselineListeners = Object.fromEntries(bot.eventNames().map(event => [String(event), bot.listenerCount(event)]));
  const rounds: unknown[] = [];
  for (let round = 0; round < 3; round++) {
    const group = await Promise.all(Array.from({ length: 6 }, (_, i) => join(40 + round * 6 + i, true, true)));
    assert.equal(group.filter(Boolean).length, 6);
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(viewer.diagnostics().total, 6, "polling upgrades count once");
    group.forEach(socket => socket?.close());
    await until(() => viewer.diagnostics().total === 0 && bot.listenerCount("move") === 0);
    const listeners = Object.fromEntries(bot.eventNames().map(event => [String(event), bot.listenerCount(event)]));
    assert.deepEqual(listeners, baselineListeners);
    rounds.push({ round, ...viewer.diagnostics(), moveListeners: bot.listenerCount("move"), inventoryListeners: bot.inventory.listenerCount("updateSlot") });
  }
  const hold = model.complete([{ role: "user", content: "private hold" }]); await slowBegan;
  const abort = new AbortController();
  const question = fetch(root + "/api/public/question", { method: "POST", headers: { origin: root, "content-type": "application/json" }, body: '{"question":"health"}', signal: abort.signal }).catch(() => null);
  await until(() => model.queueState.publicQueued === 1);
  const queued = model.queueState;
  const owner = model.complete([{ role: "user", content: "owner queued" }]);
  const peakQueue = model.queueState;
  abort.abort(); await question;
  await until(() => model.queueState.publicQueued === 0);
  finishSlow(); await Promise.all([hold, owner]);
  await until(() => model.queueState.running === 0);
  assert.deepEqual(modelCalls, ["private hold", "owner queued"], "abandoned public work never executes");
  assert.equal((interactions.diagnostics() as { modelOutstanding: number }).modelOutstanding, 0);
  assert.equal(errors.length, 0);
  const durationMs = performance.now() - began;
  loop.disable(); clearInterval(memoryTimer);
  const sorted = apiLatency.toSorted((a, b) => a - b);
  const result = { recordedAt: new Date().toISOString(), isolated: true, workload: "12 simultaneous public websocket clients into 6 seats, 4 reserved private seats, 20 API reads, 3 reconnect rounds of 6 polling/upgrading clients, one mocked held inference with queued abandoned public and owner work", durationMs: Math.round(durationMs), publicBurst: { admitted: 6, refused: 6 }, saturated, peakBotListeners, buffersAndChunks: viewer.resources(), totalAdmittedIncludingReconnects: admitted, totalRefused: refused, rounds, api: { requests: 20, maxMs: +Math.max(...apiLatency).toFixed(2), p95Ms: +sorted[18]!.toFixed(2) }, eventLoop: { p99Ms: +(loop.percentile(99) / 1e6).toFixed(2), maxMs: +(loop.max / 1e6).toFixed(2) }, memory: { beforeRssMiB: +(memoryBefore / 2 ** 20).toFixed(2), peakRssMiB: +(peakRss / 2 ** 20).toFixed(2), afterRssMiB: +(process.memoryUsage().rss / 2 ** 20).toFixed(2) }, publicChunkPackets: chunkBytes.length, maxChunkPacketBytes: Math.max(0, ...chunkBytes), model: { queued, peakQueue, after: model.queueState, abandonedInferenceStarts: 0 }, finalSeats: viewer.diagnostics(), finalMoveListeners: bot.listenerCount("move"), finalInventoryListeners: bot.inventory.listenerCount("updateSlot"), thresholds: { apiMaxMs: 1000, cleanupMs: 1000, eventLoopP99Ms: 250 }, limitations: "Flat shared synthetic chunk and fake stationary bot. Loopback proxy and mocked inference; no real game churn, external edge, GPU/model work, bandwidth limits or production sizing guarantee. OS RSS includes runtime/module caches and is not a leak slope." };
  assert(result.api.maxMs < result.thresholds.apiMaxMs); assert(result.eventLoop.p99Ms < result.thresholds.eventLoopP99Ms);
  shell.stop(); viewer.close();
  assert.equal(bot.eventNames().length, 0, "shutdown releases shared upstream subscriptions");
  const output = process.argv[2]; if (output) await writeFile(output, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
} finally {
  clearInterval(memoryTimer); loop.disable(); sockets.forEach(socket => socket.close()); shell.stop(); viewer.close();
}
