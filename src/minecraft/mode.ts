import type { Bot } from "mineflayer";
import type { Item } from "prismarine-item";
import prismarineItem from "prismarine-item";

/** Minecraft's protocol game-mode id for creative mode. */
export const CREATIVE_GAME_MODE = 1;

/** Mineflayer normally exposes a numeric mode; accept legacy string reports too. */
export function isCreativeMode(bot: Bot): boolean {
  const game = (bot as unknown as { game?: { gameMode?: number | string; gamemode?: number | string } }).game;
  if (game === undefined) return false;
  const mode = game.gameMode ?? game.gamemode;
  return mode === CREATIVE_GAME_MODE || mode === "creative";
}

/**
 * Put the client into the flight state Minecraft expects for creative play.
 * Mineflayer exposes this through its built-in creative plugin, but it is not
 * enough to merely inspect the server game mode: movement remains grounded
 * until startFlying() is called.
 */
export function enableCreativeFlight(bot: Bot): boolean {
  if (!isCreativeMode(bot)) return false;
  const creative = (bot as Bot & { creative?: { startFlying?: () => void } }).creative;
  if (creative?.startFlying === undefined) return false;
  try {
    creative.startFlying();
    return true;
  } catch {
    return false;
  }
}

/** Supply an item directly from the creative catalogue, when requested. */
export async function provideCreativeItem(bot: Bot, itemName: string, quantity: number, signal?: AbortSignal): Promise<Item | null> {
  if (!isCreativeMode(bot) || quantity <= 0) return null;
  const creative = (bot as Bot & { creative?: { setInventorySlot?: (slot: number, item: Item) => Promise<void> } }).creative;
  const definition = bot.registry.itemsByName[itemName];
  if (creative?.setInventorySlot === undefined || definition === undefined) return null;
  const count = (): number => bot.inventory.items()
    .filter((item) => item.name.replace(/^minecraft:/, "") === itemName)
    .reduce((total, item) => total + item.count, 0);
  const existing = (): Item | null => bot.inventory.items().find((item) => item.name.replace(/^minecraft:/, "") === itemName) ?? null;
  if (count() >= quantity) return existing();
  const ItemConstructor = prismarineItem as unknown as (registry: typeof bot.registry) => new (type: number, count: number) => Item;
  const CreativeItem = ItemConstructor(bot.registry);
  for (const slot of Array.from({ length: 9 }, (_, index) => index).filter((index) => bot.inventory.slots[index] === null)) {
    if (signal?.aborted) return null;
    const missing = quantity - count();
    if (missing <= 0) return existing();
    try {
      await creative.setInventorySlot(slot, new CreativeItem(definition.id, Math.min(64, missing)));
    } catch {
      return null;
    }
  }
  return count() >= quantity ? existing() : null;
}
