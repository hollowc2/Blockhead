import { createBot, type Bot, type Plugin } from "mineflayer";
import { pathfinder } from "mineflayer-pathfinder";
import { plugin as collectBlock } from "mineflayer-collectblock";
import { plugin as tool } from "mineflayer-tool";
import { loader as autoEat } from "mineflayer-auto-eat";
import armorManager from "mineflayer-armor-manager";
import { plugin as pvp } from "mineflayer-pvp";
import type { Block } from "prismarine-block";
import type { MinecraftConfig } from "../config/schema.js";

const PLUGINS: Plugin[] = [pathfinder, collectBlock, tool, autoEat, armorManager, pvp];

/** A `NoItem`-style error, matching mineflayer-tool's error shape. */
function noHarvestableToolError(): Error {
  const err = new Error("Bot does not have a harvestable tool!");
  err.name = "NoItem";
  return err;
}

/**
 * mineflayer-tool's `equipForBlock` recurses without bound — a fast 4GB OOM
 * — when the bot carries no item that can harvest the block and the caller
 * passed `getFromChest`: `retrieveTools` returns *silently* when no chest
 * locations are configured, then the function re-enters itself with
 * identical state forever. This bot never configures tool chests, so that
 * arm can only explode; short-circuit it with the NoItem error upstream
 * would raise after one (non-recursive) attempt. Bare fists stay a valid
 * harvest option for blocks that can be mined by hand (logs, crops); ore
 * still needs a real tool. bootstrap's direct calls (no `getFromChest`)
 * pass through untouched.
 */
function guardToolRecursion(bot: Bot): void {
  type EquipForBlock = (block: Block, options?: { requireHarvest?: boolean; getFromChest?: boolean; maxTools?: number }, cb?: (err?: Error) => void) => Promise<void>;
  type GuardedEquip = EquipForBlock & { __blockheadGuarded?: true };
  if (bot.tool.equipForBlock === undefined || (bot.tool.equipForBlock as GuardedEquip).__blockheadGuarded === true) return;
  const original = bot.tool.equipForBlock.bind(bot.tool);
  const guarded: EquipForBlock & { __blockheadGuarded?: true } = (
    block: Block,
    options: { requireHarvest?: boolean; getFromChest?: boolean; maxTools?: number } = {},
    cb?: (err?: Error) => void,
  ): Promise<void> => {
    const wantsChest = options.getFromChest === true;
    const hasChest = (bot.tool.chestLocations?.length ?? 0) > 0;
    // Mirrors mineflayer-tool's own candidate filter: bare fists count as a
    // harvest option only for blocks that can actually be mined by hand
    // (logs, crops) — ore needs a real tool.
    const carriesHarvester = block.canHarvest(null) || bot.inventory.items().some((item) => block.canHarvest(item.type));
    if (wantsChest && !hasChest && !carriesHarvester) {
      const err = noHarvestableToolError();
      if (typeof cb === "function") cb(err);
      return new Promise<void>((_, reject) => reject(err));
    }
    return original(block, options, cb);
  };
  guarded.__blockheadGuarded = true;
  bot.tool.equipForBlock = guarded;
}

export function createCobbleBob(config: MinecraftConfig): Bot {
  const bot = createBot({
    host: config.server.host,
    port: config.server.port,
    username: config.server.username,
    auth: "offline",
    logErrors: false, // logged via pino in events.ts
  });
  bot.loadPlugins(PLUGINS);
  // The plugin loader injects `bot.tool` on the `inject_allowed` event
  // (after the protocol handshake), so the guard can only be installed once
  // the client is actually in the game.
  bot.once("login", () => guardToolRecursion(bot));
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