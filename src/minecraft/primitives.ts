import type { Bot, Chest, Dispenser, Furnace } from "mineflayer";
import type { Block } from "prismarine-block";
import type { Entity } from "prismarine-entity";
import type { Item } from "prismarine-item";
import type { Recipe } from "prismarine-recipe";
import { requireWorldActionCleanupLease, requireWorldActionLease, throwIfAborted } from "../agent/world-actions.js";

function beforeMutation(lease: ReturnType<typeof requireWorldActionLease>, action: string, point?: { x: number; y: number; z: number }, blockName?: string): void {
  lease.beforeMutation?.({ action, point, blockName });
}

function blockPoint(block: { position?: { x: number; y: number; z: number }; name?: string }): { x: number; y: number; z: number } | undefined {
  return block.position;
}

type BoundWindow = { __worldMutationPoint?: { x: number; y: number; z: number }; __worldMutationBlockName?: string };

function bindWindow(window: object, block: { position?: { x: number; y: number; z: number }; name?: string }): void {
  const bound = window as BoundWindow;
  bound.__worldMutationPoint = blockPoint(block);
  bound.__worldMutationBlockName = block.name;
}

function windowPoint(window: object): { x: number; y: number; z: number } | undefined {
  return (window as BoundWindow).__worldMutationPoint;
}

function windowBlockName(window: object): string | undefined {
  return (window as BoundWindow).__worldMutationBlockName;
}

/** Small, lease-bound adapters for Mineflayer mutations with no higher-level orchestration. */
export async function equipItem(bot: Bot, item: Item, signal?: AbortSignal): Promise<void> {
  const lease = requireWorldActionLease(signal); signal ??= lease.signal;
  beforeMutation(lease, "equipment");
  await bot.equip(item, "hand");
  throwIfAborted(signal);
}

export async function equipToolForBlock(bot: Bot, block: Parameters<NonNullable<Bot["tool"]>["equipForBlock"]>[0], signal?: AbortSignal): Promise<void> {
  const lease = requireWorldActionLease(signal); signal ??= lease.signal;
  beforeMutation(lease, "equipment", blockPoint(block), block.name);
  await bot.tool.equipForBlock(block);
  throwIfAborted(signal);
}

/** Lease-bound placement adapters; callers must not invoke Bot.equip/placeBlock directly. */
export async function placeBlock(bot: Bot, reference: Parameters<Bot["placeBlock"]>[0], face: Parameters<Bot["placeBlock"]>[1], signal?: AbortSignal, mutationPoint?: { x: number; y: number; z: number }, blockName?: string): Promise<void> {
  const lease = requireWorldActionLease(signal); signal ??= lease.signal;
  beforeMutation(lease, "place", mutationPoint ?? blockPoint(reference), blockName);
  await bot.placeBlock(reference, face);
  throwIfAborted(signal);
}

export async function digBlock(bot: Bot, block: Parameters<Bot["dig"]>[0], signal?: AbortSignal): Promise<void> {
  const lease = requireWorldActionLease(signal); signal ??= lease.signal;
  beforeMutation(lease, "dig", blockPoint(block), block.name);
  await bot.dig(block);
  throwIfAborted(signal);
}

/**
 * Terrain code uses the same lease-bound placement primitive as construction.
 * Keeping this small adapter here makes it impossible for a terrain caller to
 * accidentally bypass the scheduler/policy boundary.
 */
export async function placeTerrainBlock(
  bot: Bot,
  reference: Parameters<Bot["placeBlock"]>[0],
  face: Parameters<Bot["placeBlock"]>[1],
  target: { x: number; y: number; z: number },
  blockName: string,
  signal?: AbortSignal,
): Promise<void> {
  await placeBlock(bot, reference, face, signal, target, blockName);
}

export async function tossItem(bot: Bot, type: number, metadata: number | null, count: number, signal?: AbortSignal): Promise<void> {
  const lease = requireWorldActionLease(signal); signal ??= lease.signal;
  beforeMutation(lease, "drop");
  await bot.toss(type, metadata, count);
  throwIfAborted(signal);
}

export async function pvpAttack(bot: Bot, target: Entity, signal?: AbortSignal): Promise<void> {
  const lease = requireWorldActionLease(signal); signal ??= lease.signal;
  beforeMutation(lease, "combat", { x: target.position.x, y: target.position.y, z: target.position.z });
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
  const lease = requireWorldActionLease(signal); signal ??= lease.signal;
  beforeMutation(lease, "collection");
  await bot.collectBlock.collect(blocks, options);
  throwIfAborted(signal);
}

export type ContainerWindow = Chest | Dispenser;

/** Open a container while retaining the caller's lease and cancellation contract. */
export async function openContainer(bot: Bot, block: Block, signal?: AbortSignal): Promise<ContainerWindow> {
  const lease = requireWorldActionLease(signal); signal ??= lease.signal;
  beforeMutation(lease, "container", blockPoint(block), block.name);
  const window = await bot.openContainer(block);
  bindWindow(window, block);
  throwIfAborted(signal);
  return window;
}

/** Deposit through a container adapter; Mineflayer itself has no AbortSignal parameter. */
export async function deposit(window: ContainerWindow, itemType: number, metadata: number | null, count: number | null, signal?: AbortSignal): Promise<void> {
  const lease = requireWorldActionLease(signal); signal ??= lease.signal;
  beforeMutation(lease, "container", windowPoint(window), windowBlockName(window));
  await window.deposit(itemType, metadata, count);
  throwIfAborted(signal);
}

/** Withdraw through a container adapter; Mineflayer itself has no AbortSignal parameter. */
export async function withdraw(window: ContainerWindow, itemType: number, metadata: number | null, count: number | null, signal?: AbortSignal): Promise<void> {
  const lease = requireWorldActionLease(signal); signal ??= lease.signal;
  beforeMutation(lease, "container", windowPoint(window), windowBlockName(window));
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
  const lease = requireWorldActionLease(signal); signal ??= lease.signal;
  beforeMutation(lease, "window");
  const result = await window.click(...args);
  throwIfAborted(signal);
  return result;
}

/** Open a furnace through the uniform window boundary. */
export async function openFurnace(bot: Bot, block: Block, signal?: AbortSignal): Promise<Furnace> {
  const lease = requireWorldActionLease(signal); signal ??= lease.signal;
  beforeMutation(lease, "smelt", blockPoint(block), block.name);
  const window = await bot.openFurnace(block);
  bindWindow(window, block);
  throwIfAborted(signal);
  return window;
}

/** Furnace fuel/input/output adapters retain signal checks around plugin calls. */
export async function putFuel(window: Furnace, itemType: number, metadata: number | null, count: number, signal?: AbortSignal): Promise<void> {
  const lease = requireWorldActionLease(signal); signal ??= lease.signal;
  beforeMutation(lease, "smelt", windowPoint(window), windowBlockName(window));
  await window.putFuel(itemType, metadata, count);
  throwIfAborted(signal);
}

export async function putInput(window: Furnace, itemType: number, metadata: number | null, count: number, signal?: AbortSignal): Promise<void> {
  const lease = requireWorldActionLease(signal); signal ??= lease.signal;
  beforeMutation(lease, "smelt", windowPoint(window), windowBlockName(window));
  await window.putInput(itemType, metadata, count);
  throwIfAborted(signal);
}

export async function takeOutput(window: Furnace, signal?: AbortSignal): Promise<void> {
  const lease = requireWorldActionLease(signal); signal ??= lease.signal;
  beforeMutation(lease, "smelt", windowPoint(window), windowBlockName(window));
  await window.takeOutput();
  throwIfAborted(signal);
}

/** Close a furnace as lease-owned cleanup, including after the lease signal aborts. */
export async function closeFurnace(window: Furnace): Promise<void> {
  requireWorldActionCleanupLease();
  await window.close();
}

export async function sleepAt(bot: Bot, bed: Parameters<Bot["sleep"]>[0], signal?: AbortSignal): Promise<void> {
  const lease = requireWorldActionLease(signal); signal ??= lease.signal;
  beforeMutation(lease, "sleep");
  await bot.sleep(bed);
  throwIfAborted(signal);
}

export async function wakeBot(bot: Bot, signal?: AbortSignal): Promise<void> {
  const lease = requireWorldActionLease(signal); signal ??= lease.signal;
  beforeMutation(lease, "sleep");
  await bot.wake();
  throwIfAborted(signal);
}

export async function eatFood(bot: Bot, food: string, signal?: AbortSignal): Promise<void> {
  const lease = requireWorldActionLease(signal); signal ??= lease.signal;
  beforeMutation(lease, "eat");
  await bot.autoEat.eat({ food });
  throwIfAborted(signal);
}

export async function cancelEating(bot: Bot, signal?: AbortSignal): Promise<void> {
  requireWorldActionCleanupLease();
  await bot.autoEat.cancelEat();
}

export async function equipAllArmor(bot: Bot, signal?: AbortSignal): Promise<void> {
  const lease = requireWorldActionLease(signal); signal ??= lease.signal;
  beforeMutation(lease, "equipment");
  await bot.armorManager.equipAll();
  throwIfAborted(signal);
}

/** Crafting adapter: recipe-window mutation stays behind the lease boundary. */
export async function craftRecipe(bot: Bot, recipe: Recipe, times: number, table?: Block, signal?: AbortSignal): Promise<void> {
  const lease = requireWorldActionLease(signal); signal ??= lease.signal;
  beforeMutation(lease, "craft", table ? { x: table.position.x, y: table.position.y, z: table.position.z } : undefined, table?.name);
  await bot.craft(recipe, times, table);
  throwIfAborted(signal);
}
