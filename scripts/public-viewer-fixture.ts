/** Isolated local spectator fixture: no Minecraft/network/model/database connections. */
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { ReadOnlyViewerServer } from "../src/dashboard/viewer-server.js";
import { ViewerShellServer } from "../src/dashboard/viewer-shell.js";
import { PublicInteractions } from "../src/dashboard/public-interactions.js";
import { PublicActionController } from "../src/agent/public-actions.js";

const require = createRequire(import.meta.url);
const Chunk = require("prismarine-chunk")("1.21.4");
const column = new Chunk();
const data = require("minecraft-data")("1.21.4");
for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) column.setBlockStateId(new Vec3(x, 63, z), data.blocksByName.grass_block.defaultState);
const bot = Object.assign(new EventEmitter(), {
  version: "1.21.4", username: "FixtureBob", entities: {},
  entity: { position: new Vec3(8, 64, 8), yaw: 0, pitch: 0 },
  inventory: Object.assign(new EventEmitter(), { slots: [] }),
  world: { getColumnAt: async () => column }, getEquipmentDestSlot: () => 0,
}) as unknown as Bot;
async function port(): Promise<number> {
  const server = createServer(); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw Error("fixture bind");
  await new Promise<void>(resolve => server.close(() => resolve())); return address.port;
}
const viewerPort = await port(), shellPort = await port();
const viewer = new ReadOnlyViewerServer(bot, { host: "127.0.0.1", port: viewerPort, viewDistance: 2, maxPublicConnections: 6, maxConnections: 10 });
let now = 0;
const interactions = new PublicInteractions({
  config: { allowed_origin: `http://127.0.0.1:${shellPort}`, questions_enabled: true, actions_enabled: false },
  gestures: new PublicActionController({ session: () => null, safe: () => false, tryRun: () => null }),
  facts: () => ({ connected: true, health: 20, hunger: 18, time: "day", activity: "resting", actions: false }),
  now: () => now += 31_000, // Fixture only: lets local UI checks exercise multiple answers without waiting.
});
const shell = new ViewerShellServer({ host: "127.0.0.1", port: shellPort, viewerPort, statsPort: 1, mode: "public", publicInteractions: interactions,
  publicState: async () => ({ public: true, connection: { connected: true }, status: { activity: "resting", detail: "Taking a breather between chores.", since: new Date().toISOString() },
    viewer: { status: "running", session: "local-fixture" }, self: { health: 20, hunger: 18, dimension: "overworld", timePhase: "day" },
    story: [{ id: 1, at: new Date().toISOString(), icon: "build", text: "Finished a small shelter.", highlight: false }],
    world: { day: 42, blocksMined: 1234, mobsKilled: 12, distanceKm: 8, buildsCompleted: 3, deaths: 1, milestones: [] },
    inventory: { totalItems: 16, items: [{ name: "oak_log", count: 16 }] }, equipment: null, interactions: interactions.availability() }),
});
await viewer.start(); await shell.start();
console.log(JSON.stringify({ url: `http://127.0.0.1:${shellPort}`, fixture: true }));
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => { shell.stop(); viewer.close(); process.exit(0); });
