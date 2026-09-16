import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import type { Item } from "prismarine-item";
import { requireWorldActionCleanupLease, requireWorldActionLease, throwIfAborted } from "../agent/world-actions.js";

/** Small, lease-bound adapters for Mineflayer mutations with no higher-level orchestration. */
export async function equipItem(bot: Bot, item: Item, signal?: AbortSignal): Promise<void> {
  requireWorldActionLease(signal);
  await bot.equip(item, "hand");
  throwIfAborted(signal);
}

export async function digBlock(bot: Bot, block: Parameters<Bot["dig"]>[0], signal?: AbortSignal): Promise<void> {
  requireWorldActionLease(signal);
  await bot.dig(block);
  throwIfAborted(signal);
}

export async function tossItem(bot: Bot, type: number, metadata: number | null, count: number, signal?: AbortSignal): Promise<void> {
  requireWorldActionLease(signal);
  await bot.toss(type, metadata, count);
  throwIfAborted(signal);
}

export async function pvpAttack(bot: Bot, target: Entity, signal?: AbortSignal): Promise<void> {
  requireWorldActionLease(signal);
  await bot.pvp.attack(target);
  throwIfAborted(signal);
}

export async function pvpStop(bot: Bot, signal?: AbortSignal): Promise<void> {
  requireWorldActionCleanupLease();
  await bot.pvp.stop();
}

export async function sleepAt(bot: Bot, bed: Parameters<Bot["sleep"]>[0], signal?: AbortSignal): Promise<void> {
  requireWorldActionLease(signal);
  await bot.sleep(bed);
  throwIfAborted(signal);
}

export async function wakeBot(bot: Bot, signal?: AbortSignal): Promise<void> {
  requireWorldActionLease(signal);
  await bot.wake();
  throwIfAborted(signal);
}

export async function eatFood(bot: Bot, food: string, signal?: AbortSignal): Promise<void> {
  requireWorldActionLease(signal);
  await bot.autoEat.eat({ food });
  throwIfAborted(signal);
}

export async function cancelEating(bot: Bot, signal?: AbortSignal): Promise<void> {
  requireWorldActionCleanupLease();
  await bot.autoEat.cancelEat();
}

export async function equipAllArmor(bot: Bot, signal?: AbortSignal): Promise<void> {
  requireWorldActionLease(signal);
  await bot.armorManager.equipAll();
  throwIfAborted(signal);
}
