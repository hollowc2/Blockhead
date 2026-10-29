import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:net";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { createPrismarineViewerAdapter } from "./prismarine-adapter.js";

async function freePort(): Promise<number> {
  const server = createServer(); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert(address && typeof address !== "string");
  await new Promise<void>(resolve => server.close(() => resolve())); return address.port;
}
function botFixture(): Bot {
  const Chunk = createRequire(import.meta.url)("prismarine-chunk")("1.21.4"); const column = new Chunk();
  return Object.assign(new EventEmitter(), { version: "1.21.4", username: "FakeBob", entities: {}, entity: { position: new Vec3(8, 64, 8), yaw: 0, pitch: 0 }, inventory: Object.assign(new EventEmitter(), { slots: [] }), world: { getColumnAt: async () => column }, getEquipmentDestSlot: () => 0 }) as unknown as Bot;
}

test("public status shell survives offline startup, bot disconnection and session replacement", async () => {
  const port = await freePort(), publicPort = await freePort();
  let connected = false;
  const adapter = createPrismarineViewerAdapter({ host: "127.0.0.1", publicViewer: { port: publicPort, maxConnections: 1 }, publicState: async () => ({ public: true, connection: { connected }, viewer: { status: connected ? "running" : "stopped" } }) });
  const options = { port, dashboardPort: 1, viewDistance: 1 };
  const read = async () => {
    const response = await fetch(`http://127.0.0.1:${publicPort}/api/state`); assert.equal(response.status, 200);
    return await response.json() as { connection: { connected: boolean }; viewer: { session: string } };
  };
  try {
    await adapter.startPublicShell(options);
    const initial = await read(); assert.equal(initial.connection.connected, false);
    assert.equal((await fetch(`http://127.0.0.1:${publicPort}/`)).status, 200);
    connected = true;
    const firstBot = botFixture(), handle = await adapter.start(firstBot, options);
    const running = await read(); assert.equal(running.connection.connected, true); assert.notEqual(running.viewer.session, initial.viewer.session);
    connected = false; handle.close();
    assert.equal((await read()).connection.connected, false, "offline API remains reachable");
    assert.equal(firstBot.eventNames().length, 0);
    connected = true;
    const second = await adapter.start(botFixture(), options);
    assert.notEqual((await read()).viewer.session, running.viewer.session);
    second.close();
    assert.equal((await fetch(`http://127.0.0.1:${publicPort}/api/command`, { method: "POST" })).status, 404);
  } finally { adapter.close(); }
});

test("shutdown during public shell startup closes the eventual listener", async () => {
  const port = await freePort();
  const adapter = createPrismarineViewerAdapter({ host: "127.0.0.1", publicViewer: { port, maxConnections: 1 }, publicState: async () => ({}) });
  const start = adapter.startPublicShell({ port: await freePort(), dashboardPort: 1 });
  adapter.close(); await start;
  await assert.rejects(fetch(`http://127.0.0.1:${port}/`));
});
