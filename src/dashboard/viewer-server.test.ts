import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer as createTcpServer } from "node:net";
import { test } from "node:test";
import type { Bot } from "mineflayer";
import { io as connect, type Socket } from "socket.io-client";
import { Vec3 } from "vec3";
import { publicViewerTransform, ReadOnlyViewerServer, staticViewerFile } from "./viewer-server.js";

test("public transform shifts every coordinate and drops player names", () => {
  const transform = publicViewerTransform(16_000, -4_096);
  assert.deepEqual(transform("position", { pos: { x: 1, y: 64, z: 2 }, yaw: 1, addMesh: true }), { pos: { x: 16_001, y: 64, z: -4_094 }, yaw: 1, addMesh: true });
  assert.deepEqual(transform("entity", { id: 5, name: "player", username: "OwnerSecretName", pos: { x: 0, y: 70, z: 0 } }), { id: 5, name: "player", pos: { x: 16_000, y: 70, z: -4_096 } });
  assert.deepEqual(transform("entity", { id: 5, delete: true }), { id: 5, delete: true });
  assert.deepEqual(transform("loadChunk", { x: 32, z: -16, chunk: "{}" }), { x: 16_032, z: -4_112, chunk: "{}" });
  assert.deepEqual(transform("unloadChunk", { x: 32, z: -16 }), { x: 16_032, z: -4_112 });
  assert.deepEqual(transform("blockUpdate", { pos: { x: 1, y: 2, z: 3 }, stateId: 9 }), { pos: { x: 16_001, y: 2, z: -4_093 }, stateId: 9 });
  assert.equal(transform("version", "1.20.1"), "1.20.1");
});

test("static viewer files stay inside the bundle", () => {
  assert.match(staticViewerFile("/") ?? "", /public[\\/]index\.html$/);
  assert.match(staticViewerFile("/worker.js") ?? "", /public[\\/]worker\.js$/);
  for (const path of ["/../package.json", "/textures/../../package.json", "/%2e%2e/x.js", "/lib/mineflayer.js/../../x.js", "/index.js.LICENSE.txt", "/x.ts"]) {
    assert.equal(staticViewerFile(path), null, path);
  }
});

interface FakeBot extends EventEmitter {
  raycasts: number;
  chats: unknown[];
}

function fakeBot(): FakeBot & Bot {
  const bot = new EventEmitter() as FakeBot & Bot & Record<string, unknown>;
  bot.raycasts = 0;
  bot.chats = [];
  bot.version = "1.20.1";
  bot.username = "CobbleBob";
  bot.entities = {};
  bot.entity = { position: new Vec3(100, 64, 200), yaw: 0, pitch: 0 } as never;
  bot.world = {
    raycast: () => { bot.raycasts += 1; return null; },
    getColumnAt: async () => ({ toJson: () => "{}" }),
  } as never;
  bot.chat = ((text: string) => { bot.chats.push(text); }) as never;
  const originalEmit = bot.emit.bind(bot);
  bot.emit = ((event: string, ...args: unknown[]) => {
    if (event === "chat" || event === "blockClicked") bot.chats.push(event);
    return originalEmit(event, ...args);
  }) as never;
  return bot;
}

async function freePort(): Promise<number> {
  const server = createTcpServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  await new Promise<void>(resolve => server.close(() => resolve()));
  return address.port;
}

function client(port: number, isPublic: boolean): Socket {
  return connect(`http://127.0.0.1:${port}`, {
    transports: ["websocket"],
    reconnection: false,
    extraHeaders: isPublic ? { "x-blockhead-public": "1" } : {},
  });
}

const next = <T>(socket: Socket, event: string): Promise<T> =>
  new Promise((resolve) => socket.once(event, (payload: T) => resolve(payload)));

test("viewer socket is read-only: inbound events reach nothing and floods are dropped", async () => {
  const bot = fakeBot();
  const port = await freePort();
  const server = new ReadOnlyViewerServer(bot, { host: "127.0.0.1", port, viewDistance: 2, maxPublicConnections: 2, maxConnections: 4 });
  await server.start();
  const socket = client(port, true);
  try {
    assert.equal(await next<string>(socket, "version"), "1.20.1");
    const chunk = await next<{ x: number; z: number }>(socket, "loadChunk");
    assert.equal(Math.abs(chunk.x % 16), 0);
    const position = await new Promise<{ pos: { x: number; y: number; z: number } }>(resolve => {
      socket.once("position", resolve);
      bot.emit("move");
    });
    assert.notEqual(position.pos.x, 100, "public coordinates must be offset");
    assert.equal(position.pos.y, 64);

    for (const [event, payload] of [
      ["mouseClick", { origin: { x: 100, y: 65, z: 200 }, direction: { x: 0, y: -1, z: 0 }, button: 2 }],
      ["chat", "hello"], ["command", "come here"], ["blockClicked", {}], ["move", {}], ["position", {}],
    ] as const) socket.emit(event, payload);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(bot.raycasts, 0, "mouseClick must not raycast");
    assert.deepEqual(bot.chats, [], "inbound events must not reach the bot");
    assert.equal(socket.connected, true, "a normal click rate keeps the viewer connected");

    const disconnected = next(socket, "disconnect");
    for (let i = 0; i < 50; i += 1) socket.emit("mouseClick", { origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: 1 }, button: 0 });
    await disconnected;
    assert.equal(bot.raycasts, 0);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(bot.listenerCount("move"), 0, "disconnect removes bot listeners");
  } finally {
    socket.close();
    server.close();
  }
});

test("public viewer connections are capped", async () => {
  const bot = fakeBot();
  const port = await freePort();
  const server = new ReadOnlyViewerServer(bot, { host: "127.0.0.1", port, viewDistance: 1, maxPublicConnections: 1, maxConnections: 2 });
  await server.start();
  const first = client(port, true);
  const sockets = [first];
  try {
    await next(first, "connect");
    const second = client(port, true);
    sockets.push(second);
    await next(second, "connect_error");
    const privateClient = client(port, false);
    sockets.push(privateClient);
    await next(privateClient, "connect");
    const position = await new Promise<{ pos: { x: number } }>(resolve => {
      privateClient.once("position", resolve);
      bot.emit("move");
    });
    assert.equal(position.pos.x, 100, "tailnet viewers keep real coordinates");
  } finally {
    for (const socket of sockets) socket.close();
    server.close();
  }
});
