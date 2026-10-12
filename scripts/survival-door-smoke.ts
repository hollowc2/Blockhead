/** Run only against an operator-enabled disposable 1.21.4 server. */
import assert from "node:assert/strict";
import { once } from "node:events";
import { createRequire } from "node:module";
import mineflayer from "mineflayer";
import { pathfinder, Movements } from "mineflayer-pathfinder";
import pino from "pino";
import { Vec3 } from "vec3";
import { WorldActionExecutor } from "../src/agent/world-actions.js";
import { placeStarterDoor } from "../src/skills/base.js";
import { travelAndWait, travelHomeAndWait } from "../src/minecraft/movement.js";
const { goals } = createRequire(import.meta.url)("mineflayer-pathfinder");

const port = Number(process.env.BLOCKHEAD_SMOKE_PORT);
if (process.env.BLOCKHEAD_DISPOSABLE_TEST !== "1" || !Number.isInteger(port) || port < 1024 || port === 25565) throw new Error("Set BLOCKHEAD_DISPOSABLE_TEST=1 and a dedicated BLOCKHEAD_SMOKE_PORT; the live port is forbidden");
const bot = mineflayer.createBot({ host: "127.0.0.1", port, username: "DoorTest", version: "1.21.4", auth: "offline" });
bot.loadPlugin(pathfinder);
const timeout = setTimeout(() => { console.error("door smoke timed out"); bot.quit(); process.exitCode = 1; }, 45_000);
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
try {
  await once(bot, "spawn");
  const movements = new Movements(bot); movements.canDig = false; movements.allow1by1towers = false;
  bot.pathfinder.setMovements(movements);
  for (const command of [
    "/gamemode creative DoorTest", "/fill 62 98 48 68 103 57 air", "/fill 62 102 48 68 102 54 oak_planks", "/setblock 65 98 54 birch_planks", "/setblock 64 100 54 oak_planks", "/setblock 64 100 55 cobblestone", "/fill 63 99 55 63 99 57 stone", "/fill 64 99 56 66 99 57 stone", "/tp DoorTest 65.6 100 56.5", "/clear DoorTest", "/give DoorTest oak_door 3", "/give DoorTest oak_planks 6", "/gamemode survival DoorTest",
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
  bot.chat("/tp DoorTest 65.5 103 52.5"); await delay(500);
  console.log("before repair", JSON.stringify({ lower: bot.blockAt(lower)?.name, upper: bot.blockAt(lower.offset(0, 1, 0))?.name, support: bot.blockAt(lower.offset(0, -1, 0))?.name, position: bot.entity?.position, mode: bot.game.gameMode }));
  const executor = new WorldActionExecutor();
  const controller = new AbortController();
  const result = await executor.run("survival-door-smoke", controller.signal, async lease => placeStarterDoor(bot, door, lower, new Set(), lease.signal, pino()));
  console.log("after repair", JSON.stringify({ lower: bot.blockAt(lower)?.name, upper: bot.blockAt(lower.offset(0, 1, 0))?.name, support: bot.blockAt(lower.offset(0, -1, 0))?.name, result: result.reason }));
  assert.equal(result.block?.name, "oak_door", result.reason ?? "door failed");
  assert.equal(bot.blockAt(lower.offset(0, -1, 0))?.name, "oak_planks");
  assert.equal(bot.blockAt(lower.offset(0, 1, 0))?.name, "oak_door");
  assert.equal(bot.pathfinder.movements.maxDropDown, 3, "doorway descent allowance must not leak into later trips");
  console.log("PASS: survival side-wall placement refused; verified floor repair and both door halves accepted");
  // A closed door is the sole exit from this sealed room. The pathfinder
  // cannot open wooden doors itself; navigation must interact and replan.
  for (const command of [
    "/gamemode creative DoorTest", "/fill 70 98 48 78 102 52 oak_planks",
    "/fill 71 99 49 77 100 51 air", "/fill 74 99 49 74 100 51 oak_planks",
    "/setblock 74 99 50 oak_door[facing=east,half=lower,open=false]",
    "/setblock 74 100 50 oak_door[facing=east,half=upper,open=false]",
    "/tp DoorTest 72.5 99 50.5", "/gamemode survival DoorTest",
  ]) { bot.chat(command); await delay(150); }
  await delay(500);
  assert.equal(bot.pathfinder.getPathTo(bot.pathfinder.movements, new goals.GoalNear(76, 99, 50, 0)).status, "noPath");
  const walked = await executor.run("closed-door-exit", controller.signal, () => travelAndWait(bot, { x: 76, y: 99, z: 50 }, { range: 0, timeoutMs: 10000, signal: controller.signal, allowDig: false }));
  assert.equal(walked.status, "arrived");
  assert.equal(bot.blockAt(new Vec3(74, 99, 50))?.getProperties().open, true);
  assert.equal(bot.blockAt(new Vec3(74, 100, 50))?.getProperties().open, true);
  console.log("PASS: closed wooden door opened and survival bot walked out through it");
  const returned = await executor.run("sheltered-home-arrival", controller.signal, () => travelHomeAndWait(bot, { x: 72, y: 99, z: 50, dimension: "overworld" }, { range: 1, timeoutMs: 10000, signal: controller.signal, allowDig: false }));
  assert.equal(returned.status, "arrived");
  assert.equal(Math.floor(bot.entity.position.y), 99, "home arrival uses the interior floor, not the roof");
  console.log("PASS: survival return home reached the interior floor beneath the roof");
} catch (error) {
  console.error(error); process.exitCode = 1;
} finally { clearTimeout(timeout); bot.quit("disposable door test complete"); }
