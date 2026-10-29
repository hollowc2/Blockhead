import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { createServer as createTcpServer } from "node:net";
import { test } from "node:test";
import type { Bot } from "mineflayer";
import { io as connect, type Socket } from "socket.io-client";
import { Vec3 } from "vec3";
import { publicChunkJson, publicViewerTransform, ReadOnlyViewerServer, staticViewerFile, viewerEntityPayload } from "./viewer-server.js";

test("public transform shifts every coordinate and drops player names", () => {
  const transform = publicViewerTransform(16_000, -4_096);
  assert.deepEqual(transform("position", { pos: { x: 1, y: 64, z: 2 }, yaw: 1, addMesh: true }), { pos: { x: 16_001, y: 64, z: -4_094 }, yaw: 1, addMesh: true });
  assert.deepEqual(transform("entity", { id: 5, name: "player", username: "OwnerSecretName", pos: { x: 0, y: 70, z: 0 } }), { id: 5, name: "player", pos: { x: 16_000, y: 70, z: -4_096 } });
  assert.deepEqual(transform("entity", { id: 5, delete: true }), { id: 5, delete: true });
  assert.throws(() => transform("loadChunk", { x: 32, z: -16, chunk: "{}" }), /unsupported/);
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
  bot.inventory = Object.assign(new EventEmitter(), { slots: [] }) as never;
  bot.getEquipmentDestSlot = ((slot: string) => ({ "off-hand": 45, head: 5, torso: 6, legs: 7, feet: 8 })[slot]) as never;
  const Chunk = createRequire(import.meta.url)("prismarine-chunk")("1.20.1");
  const column = new Chunk();
  bot.world = {
    raycast: () => { bot.raycasts += 1; return null; },
    getColumnAt: async () => column,
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
    assert.equal((position as { pitch?: number }).pitch, 0, "pitch drives the first-person camera");
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

test("viewers receive equipped gear on connect and while stationary, and release subscriptions", async () => {
  const bot = fakeBot();
  const slots = bot.inventory.slots;
  slots[5] = { name: "iron_helmet" } as never;
  slots[45] = { name: "shield" } as never;
  bot.heldItem = { name: "iron_sword" } as never;
  const port = await freePort();
  const server = new ReadOnlyViewerServer(bot, { host: "127.0.0.1", port, viewDistance: 1, maxPublicConnections: 2, maxConnections: 4 });
  await server.start();
  const socket = client(port, true);
  try {
    assert.deepEqual(await next(socket, "equipment"), {
      hand: "iron_sword", "off-hand": "shield", head: "iron_helmet", torso: null, legs: null, feet: null,
    });
    let changed = next<Record<string, string | null>>(socket, "equipment");
    slots[5] = null;
    bot.inventory.emit("updateSlot", 5, null, null);
    assert.equal((await changed).head, null, "removing armor updates the model without a move");
    changed = next(socket, "equipment");
    bot.heldItem = { name: "iron_pickaxe" } as never;
    bot.emit("heldItemChanged");
    assert.equal((await changed).hand, "iron_pickaxe");
    const second = client(port, false);
    try {
      assert.equal((await next<Record<string, string>>(second, "equipment")).hand, "iron_pickaxe", "each connection gets current equipment");
    } finally { second.close(); }
  } finally {
    socket.close();
    server.close();
  }
  assert.equal(bot.inventory.listenerCount("updateSlot"), 0);
  assert.equal(bot.listenerCount("heldItemChanged"), 0);
  assert.equal(bot.listenerCount("spawn"), 0);
});

test("dropped stacks send their identity on connect, metadata changes and movement", async () => {
  const require = createRequire(import.meta.url);
  const Entity = require("prismarine-entity")("1.21.4");
  const Item = require("prismarine-item")("1.21.4");
  const registry = require("minecraft-data")("1.21.4");
  const bot = fakeBot();
  const drop = new Entity(42);
  drop.name = "item";
  drop.position = new Vec3(100, 64, 200);
  bot.entities[42] = drop;
  assert.deepEqual(viewerEntityPayload(bot, { id: 42, name: "item" }), { id: 42, name: "item", itemName: null }, "spawn can precede metadata");
  drop.metadata[registry.supportFeature("metadataIxOfItem")] = Item.toNotch(new Item(registry.itemsByName.cobblestone.id, 1));
  const port = await freePort();
  const server = new ReadOnlyViewerServer(bot, { host: "127.0.0.1", port, viewDistance: 1, maxPublicConnections: 2, maxConnections: 4 });
  await server.start();
  const socket = client(port, true);
  try {
    const first = await next<{ itemName: string; pos: { x: number }; metadata?: unknown }>(socket, "entity");
    assert.equal(first.itemName, "cobblestone");
    assert.notEqual(first.pos.x, 100, "item positions remain redacted for public viewers");
    assert.equal(first.metadata, undefined);
    let changed = next<{ itemName: string }>(socket, "entity");
    drop.metadata[registry.supportFeature("metadataIxOfItem")] = Item.toNotch(new Item(registry.itemsByName.raw_iron.id, 1));
    bot.emit("entityUpdate", drop);
    assert.equal((await changed).itemName, "raw_iron");
    changed = next(socket, "entity");
    bot.emit("entityMoved", drop);
    assert.equal((await changed).itemName, "raw_iron");
    const gone = next(socket, "entity");
    bot.emit("entityGone", drop);
    assert.deepEqual(await gone, { id: 42, delete: true });
  } finally {
    socket.close();
    server.close();
  }
  assert.equal(bot.listenerCount("entityUpdate"), 0);
});

test("real 1.21.4 chunk serialization strips sign NBT and unknown nested fields, retaining render data", () => {
  const require = createRequire(import.meta.url);
  const Chunk = require("prismarine-chunk")("1.21.4");
  const column = new Chunk();
  column.setBlockStateId(new Vec3(1, 64, 2), 1);
  column.blockEntities = { "1,64,2": { type: "compound", value: { id: { type: "string", value: "minecraft:sign" }, x: { type: "int", value: 123456 }, front_text: { type: "compound", value: { messages: { type: "list", value: { type: "string", value: ['{"text":"PRIVATE_SIGN_CANARY"}'] } } } }, custom: { type: "string", value: "SECRET_CUSTOM" } } } };
  const privateJson = column.toJson();
  assert(privateJson.includes("PRIVATE_SIGN_CANARY"));
  const modified = JSON.parse(privateJson); modified.extra = "UNKNOWN_CANARY";
  const section = JSON.parse(modified.sections[0]); section.extra = "NESTED_CANARY"; modified.sections[0] = JSON.stringify(section);
  const safe = publicChunkJson(JSON.stringify(modified), "1.21.4");
  for (const secret of ["PRIVATE_SIGN_CANARY", "SECRET_CUSTOM", "123456", "UNKNOWN_CANARY", "NESTED_CANARY", "blockEntities"]) assert(!safe.includes(secret), secret);
  const restored = Chunk.fromJson(safe);
  assert.equal(restored.getBlockStateId(new Vec3(1, 64, 2)), 1);
  for (const key of ["biomes", "skyLightSections", "blockLightSections", "worldHeight", "minY"]) assert.deepEqual(JSON.parse(safe)[key], JSON.parse(privateJson)[key]);
  assert.throws(() => publicChunkJson('{}', "1.21.4"));
  assert.throws(() => publicChunkJson(privateJson, "2.0"));
  const transform = publicViewerTransform(16, 16);
  assert.equal(transform("unknown", { metadata: "PRIVATE" }), undefined);
  assert.deepEqual(transform("entity", { id: 5, name: "pig", metadata: { secret: "PRIVATE" }, nbt: "PRIVATE" }), { id: 5, name: "pig" });
});

test("staged concurrent polling reserves seats before namespace admission; expiry releases them", async () => {
  const bot = fakeBot(), port = await freePort();
  const server = new ReadOnlyViewerServer(bot, { host: "127.0.0.1", port, viewDistance: 1, maxPublicConnections: 2, maxConnections: 3, pendingTimeoutMs: 150 });
  await server.start();
  try {
    const handshakes = await Promise.all(Array.from({ length: 6 }, (_, n) => fetch(`http://127.0.0.1:${port}/socket.io/?EIO=4&transport=polling`, { headers: { "x-blockhead-public": "1", "x-blockhead-viewer-address": `192.0.2.${n}` } })));
    assert.equal(handshakes.filter(r => r.status === 200).length, 2);
    assert.equal(server.diagnostics().public, 2);
    assert.equal(server.diagnostics().pending, 2);
    const privateResponse = await fetch(`http://127.0.0.1:${port}/socket.io/?EIO=4&transport=polling`);
    assert.equal(privateResponse.status, 200);
    assert.equal(server.diagnostics().total, 3);
    assert.equal(bot.listenerCount("move"), 0);
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.deepEqual(server.diagnostics(), { public: 0, total: 0, pending: 0 });
    const normal = connect(`http://127.0.0.1:${port}`, { transports: ["polling", "websocket"], reconnection: false, extraHeaders: { "x-blockhead-public": "1" } });
    try {
      await next(normal, "connect");
      if (normal.io.engine.transport.name !== "websocket") await new Promise(resolve => normal.io.engine.once("upgrade", resolve));
      assert.equal(server.diagnostics().total, 1, "transport upgrade has one seat");
      assert.equal(server.diagnostics().pending, 0);
    } finally { normal.close(); }
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(server.diagnostics().total, 0);
    assert.equal(bot.listenerCount("move"), 0);
    assert.equal(bot.inventory.listenerCount("updateSlot"), 0);
  } finally { server.close(); }
});

test("polling-only clients obey address caps and release seats over repeated reconnects", async () => {
  const bot = fakeBot(), port = await freePort();
  const server = new ReadOnlyViewerServer(bot, { host: "127.0.0.1", port, viewDistance: 1, maxPublicConnections: 6, maxConnections: 10, maxPublicPerAddress: 1 });
  await server.start();
  const options = { transports: ["polling"], reconnection: false, extraHeaders: { "x-blockhead-public": "1" } };
  try {
    for (let i = 0; i < 3; i++) {
      const first = connect(`http://127.0.0.1:${port}`, options);
      try {
        await next(first, "connect");
        const second = connect(`http://127.0.0.1:${port}`, options);
        try { await next(second, "connect_error"); assert.equal(server.diagnostics().public, 1); } finally { second.close(); }
      } finally { first.close(); }
      await new Promise(resolve => setTimeout(resolve, 40));
      assert.equal(server.diagnostics().total, 0); assert.equal(bot.listenerCount("move"), 0);
    }
  } finally { server.close(); }
});

test("an abandoned polling consumer is disconnected before buffers and bot subscriptions accumulate", async () => {
  const bot = fakeBot(), port = await freePort();
  const server = new ReadOnlyViewerServer(bot, { host: "127.0.0.1", port, viewDistance: 2, maxPublicConnections: 2, maxConnections: 4, maxBufferedBytes: 1024 });
  await server.start();
  try {
    const root = `http://127.0.0.1:${port}/socket.io/?EIO=4&transport=polling`;
    const headers = { "x-blockhead-public": "1" };
    const open = await (await fetch(root, { headers })).text();
    const sid = JSON.parse(open.slice(1)).sid;
    assert.equal((await fetch(root + "&sid=" + sid, { method: "POST", headers, body: "40" })).status, 200);
    // No next polling GET: the receiver has abandoned the stream.
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.equal(server.diagnostics().total, 0);
    assert.equal(bot.listenerCount("move"), 0);
    assert.equal(bot.inventory.listenerCount("updateSlot"), 0);
  } finally { server.close(); }
});

test("public wire chunks are cached geometry; private chunks retain NBT and world updates invalidate the cache", async () => {
  const bot = fakeBot(), port = await freePort();
  const Chunk = createRequire(import.meta.url)("prismarine-chunk")("1.20.1");
  const column = new Chunk(); column.blockEntities = { "1,64,2": { private: "WIRE_SIGN_CANARY", x: 123456 } };
  let serializations = 0;
  const serialize = column.toJson.bind(column); column.toJson = () => { serializations++; return serialize(); };
  bot.world = { getColumnAt: async () => column } as never;
  const server = new ReadOnlyViewerServer(bot, { host: "127.0.0.1", port, viewDistance: 1, maxPublicConnections: 3, maxConnections: 4 });
  await server.start();
  const sockets: Socket[] = [];
  try {
    for (const isPublic of [true, true, false]) {
      const socket = client(port, isPublic); sockets.push(socket);
      const payload = await next<{ chunk: string }>(socket, "loadChunk");
      assert.equal(payload.chunk.includes("WIRE_SIGN_CANARY"), !isPublic);
      if (isPublic) assert.equal(serializations, 1);
    }
    const changed = next<{ chunk: string }>(sockets[0]!, "loadChunk");
    column.setBlockStateId(new Vec3(0, 64, 0), 2);
    bot.emit("chunkColumnLoad", new Vec3(96, 0, 192));
    const result = await changed;
    assert.equal(Chunk.fromJson(result.chunk).getBlockStateId(new Vec3(0, 64, 0)), 2);
    assert(!result.chunk.includes("WIRE_SIGN_CANARY"));
  } finally { sockets.forEach(socket => socket.close()); server.close(); }
});
