import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { ViewerSession, retryUntil } from "./public/viewer-session.mjs";
import { installViewerLifecycle } from "../../scripts/viewer-lifecycle.mjs";

function fixture(mode = "3d") {
  let now = 0, nextId = 0, mounts = 0, releases = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const states: string[] = [];
  const session = new ViewerSession({ mode, origin: "https://bob.example", token: () => `token-${++nextId}`, random: () => 0,
    schedule: (run: () => void, ms: number) => { const id = ++nextId; timers.set(id, { at: now + ms, run }); return id; }, cancel: (id: number) => timers.delete(id),
    changed: (state: string) => states.push(state), mount: () => { mounts++; return {}; }, release: () => { releases++; },
  });
  const advance = (ms: number) => { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.run(); } };
  const update = (extra = {}) => session.update({ reachable: true, connected: true, running: true, session: "one", ...extra });
  const message = (state: string, extra = {}) => session.message(session.source, "https://bob.example", { type: "bob-viewer", version: 1, token: session.token, state, ...extra });
  return { session, update, message, advance, states, counts: () => ({ mounts, releases, timers: timers.size }) };
}

test("socket connection waits for geometry; messages require origin, source, token and exact schema", () => {
  const f = fixture(); f.update(); assert.equal(f.session.state, "connecting");
  f.message("socket-connected"); assert.equal(f.session.state, "loading-world");
  const data = { type: "bob-viewer", version: 1, token: f.session.token, state: "ready" };
  assert.equal(f.session.message({}, "https://bob.example", data), false);
  assert.equal(f.session.message(f.session.source, "https://evil.example", data), false);
  assert.equal(f.message("ready", { html: "<script>" }), false);
  assert.equal(f.message("ready", { token: "old" }), false);
  assert.equal(f.message("tool"), false);
  f.message("ready"); assert.equal(f.session.state, "connected");
  const oldSource = f.session.source, oldToken = f.session.token;
  f.update({ session: "two" }); assert.equal(f.session.state, "connecting");
  assert.equal(f.session.message(oldSource, "https://bob.example", { ...data, token: oldToken }), false);
  f.session.stop(); assert.equal(f.counts().timers, 0);
});

test("capacity retries are bounded, release pending frames, and manual recovery mounts one frame", () => {
  const f = fixture(); f.update();
  for (const delay of [15_000, 30_000, 60_000]) {
    f.message("capacity"); assert.equal(f.session.state, "capacity"); assert.equal(f.session.token, null);
    f.advance(delay); assert.equal(f.session.state, "connecting");
  }
  f.message("capacity"); f.advance(3600_000); assert.equal(f.counts().mounts, 4);
  f.session.retry(); assert.equal(f.counts().mounts, 5); f.session.retry(); assert.equal(f.counts().mounts, 5);
  f.message("ready"); assert.equal(f.session.state, "connected"); f.session.stop();
});

test("lightweight never mounts; pause releases; hidden tabs get a grace period and reacquire on return", () => {
  const f = fixture("lightweight"); f.update(); assert.equal(f.counts().mounts, 0);
  f.session.setMode("3d"); f.message("ready"); f.session.visibility(false);
  f.advance(59_999); assert(f.session.token); f.advance(1); assert.equal(f.session.token, null);
  f.session.visibility(true); assert.equal(f.counts().mounts, 2);
  f.session.pause(); f.session.visibility(false); f.advance(60_000); f.session.visibility(true); assert.equal(f.counts().mounts, 2);
  f.session.retry(); assert.equal(f.counts().mounts, 3);
  f.message("webgl-failed"); assert.equal(f.session.token, null); f.advance(3600_000); assert.equal(f.counts().mounts, 3);
  f.session.retry(); f.message("ready");
  f.update({ reachable: false }); assert.equal(f.session.state, "connected", "API loss need not discard a working renderer");
  f.update({ connected: false }); assert.equal(f.session.state, "offline"); assert.equal(f.session.token, null);
  f.update(); assert.equal(f.session.state, "connecting"); f.session.stop();
});

test("countdowns account for latency and reject invalid or unbounded waits", () => {
  assert.equal(retryUntil(1000, 3000, 5000), 6000);
  assert.equal(retryUntil(1000, 3000, NaN), 0);
  assert.equal(retryUntil(1000, 3000, 1e12), 3603_000);
});

test("renderer bridge only claims ready after chunks, version, geometry and a rendered frame", () => {
  const socket = Object.assign(new EventEmitter(), { disconnect: () => undefined });
  const messages: { state: string }[] = [];
  const win = { location: { search: "?visit=00000000-0000-0000-0000-000000000000", origin: "https://bob.example" }, document: { hidden: false }, parent: { postMessage: (data: { state: string }, origin: string) => { assert.equal(origin, "https://bob.example"); messages.push(data); } }, addEventListener: () => undefined };
  const lifecycle = installViewerLifecycle(socket, win);
  const world = { world: { sectionMeshs: {} as Record<string, unknown> } };
  socket.emit("connect"); lifecycle.frame(world); assert.equal(messages.at(-1)!.state, "socket-connected");
  socket.emit("version", "1.21.4"); socket.emit("loadChunk", {}); lifecycle.frame(world); assert.equal(messages.at(-1)!.state, "socket-connected");
  world.world.sectionMeshs.one = { geometry: { attributes: { position: { count: 12 } } } }; lifecycle.frame(world); assert.equal(messages.at(-1)!.state, "ready");
  socket.emit("disconnect"); assert.equal(messages.at(-1)!.state, "disconnected");
  socket.emit("connect_error", { context: { responseText: '{"message":"capacity"}' } }); assert.equal(messages.at(-1)!.state, "capacity");
  lifecycle.webgl(); assert.equal(messages.at(-1)!.state, "webgl-failed");
});

test("frame tokens use browser crypto that works on ordinary private HTTP origins", async t => {
  t.mock.method(crypto, "randomUUID", () => { throw new Error("unavailable on insecure origins"); });
  const { frameToken } = await import("./public/viewer-session.mjs");
  const first = frameToken(), second = frameToken();
  assert.match(first, /^[a-f0-9-]{36}$/); assert.notEqual(first, second);
});
