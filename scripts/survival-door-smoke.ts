/** Run only against an operator-enabled disposable 1.21.4 server. */
import assert from "node:assert/strict";
import { once } from "node:events";
import mineflayer from "mineflayer";
import pino from "pino";
import { Vec3 } from "vec3";
import { WorldActionExecutor } from "../src/agent/world-actions.js";
import { placeStarterDoor } from "../src/skills/base.js";

const port = Number(process.env.BLOCKHEAD_SMOKE_PORT);
if (process.env.BLOCKHEAD_DISPOSABLE_TEST !== "1" || !Number.isInteger(port) || port < 1024 || port === 25565) throw new Error("Set BLOCKHEAD_DISPOSABLE_TEST=1 and a dedicated BLOCKHEAD_SMOKE_PORT; the live port is forbidden");
const bot = mineflayer.createBot({ host: "127.0.0.1", port, username: "DoorTest", version: "1.21.4", auth: "offline" });
const timeout = setTimeout(() => { console.error("door smoke timed out"); bot.quit(); process.exitCode = 1; }, 45_000);
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
try {
  await once(bot, "spawn");
  for (const command of [
    "/gamemode creative DoorTest", "/fill 63 98 52 67 103 57 air", "/setblock 65 98 54 birch_planks", "/setblock 64 100 54 oak_planks", "/fill 64 99 56 66 99 57 stone", "/tp DoorTest 65.6 100 56.5", "/give DoorTest oak_door 3", "/give DoorTest oak_planks 6", "/gamemode survival DoorTest",
  ]) { bot.chat(command); await delay(150); }
  await delay(500);
  const lower = new Vec3(65, 100, 54);
  assert.equal(bot.blockAt(lower.offset(0, -1, 0))?.name, "air");
  const door = bot.inventory.items().find(item => item.name === "oak_door");
  assert.ok(door);
  await bot.equip(door, "hand");
  // Reproduce the former side-wall fallback in survival mode.
  await bot.placeBlock(bot.blockAt(new Vec3(64, 100, 54))!, new Vec3(1, 0, 0)).catch(() => {});
  assert.equal(bot.blockAt(lower)?.name, "air", "unsupported side-reference placement must be refused");
  console.log("before repair", JSON.stringify({ lower: bot.blockAt(lower)?.name, upper: bot.blockAt(lower.offset(0, 1, 0))?.name, support: bot.blockAt(lower.offset(0, -1, 0))?.name, position: bot.entity?.position, mode: bot.game.gameMode }));
  const executor = new WorldActionExecutor();
  const controller = new AbortController();
  const result = await executor.run("survival-door-smoke", controller.signal, async lease => placeStarterDoor(bot, door, lower, new Set(), lease.signal, pino(), { travel: async () => ({ status: "already_there" }) }));
  console.log("after repair", JSON.stringify({ lower: bot.blockAt(lower)?.name, upper: bot.blockAt(lower.offset(0, 1, 0))?.name, support: bot.blockAt(lower.offset(0, -1, 0))?.name, result: result.reason }));
  assert.equal(result.block?.name, "oak_door", result.reason ?? "door failed");
  assert.equal(bot.blockAt(lower.offset(0, -1, 0))?.name, "oak_planks");
  assert.equal(bot.blockAt(lower.offset(0, 1, 0))?.name, "oak_door");
  console.log("PASS: survival side-wall placement refused; verified floor repair and both door halves accepted");
} catch (error) {
  console.error(error); process.exitCode = 1;
} finally { clearTimeout(timeout); bot.quit("disposable door test complete"); }
