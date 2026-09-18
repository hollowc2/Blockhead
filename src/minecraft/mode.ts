import type { Bot } from "mineflayer";

/** Minecraft's protocol game-mode id for creative mode. */
export const CREATIVE_GAME_MODE = 1;

/** Mineflayer normally exposes a numeric mode; accept legacy string reports too. */
export function isCreativeMode(bot: Bot): boolean {
  const game = (bot as unknown as { game?: { gameMode?: number | string; gamemode?: number | string } }).game;
  if (game === undefined) return false;
  const mode = game.gameMode ?? game.gamemode;
  return mode === CREATIVE_GAME_MODE || mode === "creative";
}
