import type { Bot, Chest, Dispenser, Furnace } from "mineflayer";
import type { Block } from "prismarine-block";
import type { Entity } from "prismarine-entity";
import type { Item } from "prismarine-item";
import { requireWorldActionCleanupLease, requireWorldActionLease, throwIfAborted } from "../agent/world-actions.js";

/** Small, lease-bound adapters for Mineflayer mutations with no higher-level orchestration. */
export async function equipItem(bot: Bot, item: Item, signal?: AbortSignal): Promise<void> {
  requireWorldActionLease(signal);
  await bot.equip(item, "hand");
  throwIfAborted(signal);
}

export async function equipToolForBlock(bot: Bot, block: Parameters<NonNullable<Bot["tool"]>["equipForBlock"]>[0], signal?: AbortSignal): Promise<void> {
  requireWorldActionLease(signal);
  await bot.tool.equipForBlock(block);
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

export async function cancelCollection(bot: Bot): Promise<void> {
  requireWorldActionCleanupLease();
  await bot.collectBlock.cancelTask();
}

/** Start a collectblock operation under the same lease/signal boundary as all other mutations. */
export async function collectBlockOperation(
  bot: Bot,
  blocks: Parameters<NonNullable<Bot["collectBlock"]>["collect"]>[0],
  options: { ignoreNoPath: boolean },
  signal?: AbortSignal,
): Promise<void> {
  requireWorldActionLease(signal);
  await bot.collectBlock.collect(blocks, options);
  throwIfAborted(signal);
}

export type ContainerWindow = Chest | Dispenser;

/** Open a container while retaining the caller's lease and cancellation contract. */
export async function openContainer(bot: Bot, block: Block, signal?: AbortSignal): Promise<ContainerWindow> {
  requireWorldActionLease(signal);
  const window = await bot.openContainer(block);
  throwIfAborted(signal);
  return window;
}

/** Deposit through a container adapter; Mineflayer itself has no AbortSignal parameter. */
export async function deposit(window: ContainerWindow, itemType: number, metadata: number | null, count: number | null, signal?: AbortSignal): Promise<void> {
  requireWorldActionLease(signal);
  await window.deposit(itemType, metadata, count);
  throwIfAborted(signal);
}

/** Withdraw through a container adapter; Mineflayer itself has no AbortSignal parameter. */
export async function withdraw(window: ContainerWindow, itemType: number, metadata: number | null, count: number | null, signal?: AbortSignal): Promise<void> {
  requireWorldActionLease(signal);
  await window.withdraw(itemType, metadata, count);
  throwIfAborted(signal);
}

/** Close a container as lease-owned cleanup, including after the lease signal aborts. */
export async function closeWindow(window: { close: () => Promise<void> }): Promise<void> {
  requireWorldActionCleanupLease();
  await window.close();
}

/** Execute a window click through the same lease and cancellation boundary. */
export async function clickWindow<T>(window: { click: (...args: any[]) => Promise<T> }, args: any[], signal?: AbortSignal): Promise<T> {
  requireWorldActionLease(signal);
  const result = await window.click(...args);
  throwIfAborted(signal);
  return result;
}

/** Open a furnace through the uniform window boundary. */
export async function openFurnace(bot: Bot, block: Block, signal?: AbortSignal): Promise<Furnace> {
  requireWorldActionLease(signal);
  const window = await bot.openFurnace(block);
  throwIfAborted(signal);
  return window;
}

/** Furnace fuel/input/output adapters retain signal checks around plugin calls. */
export async function putFuel(window: Furnace, itemType: number, metadata: number | null, count: number, signal?: AbortSignal): Promise<void> {
  requireWorldActionLease(signal);
  await window.putFuel(itemType, metadata, count);
  throwIfAborted(signal);
}

export async function putInput(window: Furnace, itemType: number, metadata: number | null, count: number, signal?: AbortSignal): Promise<void> {
  requireWorldActionLease(signal);
  await window.putInput(itemType, metadata, count);
  throwIfAborted(signal);
}

export async function takeOutput(window: Furnace, signal?: AbortSignal): Promise<void> {
  requireWorldActionLease(signal);
  await window.takeOutput();
  throwIfAborted(signal);
}

/** Close a furnace as lease-owned cleanup, including after the lease signal aborts. */
export async function closeFurnace(window: Furnace): Promise<void> {
  requireWorldActionCleanupLease();
  await window.close();
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
