import { createBot, type Bot, type Plugin } from "mineflayer";
import { pathfinder } from "mineflayer-pathfinder";
import { plugin as collectBlock } from "mineflayer-collectblock";
import { plugin as tool } from "mineflayer-tool";
import { loader as autoEat } from "mineflayer-auto-eat";
import armorManager from "mineflayer-armor-manager";
import { plugin as pvp } from "mineflayer-pvp";
import type { MinecraftConfig } from "../config/schema.js";

const PLUGINS: Plugin[] = [pathfinder, collectBlock, tool, autoEat, armorManager, pvp];

export function createCobbleBob(config: MinecraftConfig): Bot {
  const bot = createBot({
    host: config.server.host,
    port: config.server.port,
    username: config.server.username,
    auth: "offline",
    logErrors: false, // logged via pino in events.ts
  });
  bot.loadPlugins(PLUGINS);
  return bot;
}

export interface BotState {
  position: { x: number; y: number; z: number } | null;
  health: number;
  food: number;
  dimension: string | null;
}

export function readState(bot: Bot): BotState {
  const pos = bot.entity?.position;
  return {
    position: pos ? { x: pos.x, y: pos.y, z: pos.z } : null,
    health: bot.health,
    food: bot.food,
    dimension: bot.game.dimension,
  };
}