import type { Bot, Chest, Dispenser, Furnace } from "mineflayer";
import type { Block } from "prismarine-block";
import type { Entity } from "prismarine-entity";
import type { Item } from "prismarine-item";
import type { Recipe } from "prismarine-recipe";
import { digBudgetMs, raceAbort, requireWorldActionCleanupLease, requireWorldActionLease, throwIfAborted } from "../agent/world-actions.js";
import { junkToShed } from "./inventory.js";

function beforeMutation(lease: ReturnType<typeof requireWorldActionLease>, action: string, point?: { x: number; y: number; z: number }, blockName?: string, ownBuildReplacement?: boolean): void {
  lease.beforeMutation?.({ action, point, blockName, ownBuildReplacement });
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
  // `bot.equip` waits for the server's inventory confirmation and never times
  // out; on 1.21 that update can be lost, and an unbounded equip wedged the
  // bootstrap hunt for 23 minutes next to a pig.
  await raceAbort(bot.equip(item, "hand"), signal, { timeoutMs: EQUIP_TIMEOUT_MS, label: "equip" });
  throwIfAborted(signal);
}

/** Generous for a held-item swap: one click round-trip plus a resync. */
const EQUIP_TIMEOUT_MS = 5_000;

export async function equipToolForBlock(bot: Bot, block: Parameters<NonNullable<Bot["tool"]>["equipForBlock"]>[0], signal?: AbortSignal): Promise<void> {
  const lease = requireWorldActionLease(signal); signal ??= lease.signal;
  beforeMutation(lease, "equipment", blockPoint(block), block.name);
  await raceAbort(bot.tool.equipForBlock(block), signal, { timeoutMs: EQUIP_TIMEOUT_MS, label: "equip" });
  throwIfAborted(signal);
}

/** Lease-bound placement adapters; callers must not invoke Bot.equip/placeBlock directly. */
export async function placeBlock(bot: Bot, reference: Parameters<Bot["placeBlock"]>[0], face: Parameters<Bot["placeBlock"]>[1], signal?: AbortSignal, mutationPoint?: { x: number; y: number; z: number }, blockName?: string): Promise<void> {
  const lease = requireWorldActionLease(signal); signal ??= lease.signal;
  beforeMutation(lease, "place", mutationPoint ?? blockPoint(reference), blockName);
  await bot.placeBlock(reference, face);
  throwIfAborted(signal);
}

/**
 * Right-click `block` with the held item (a hoe tilling soil, seeds onto
 * farmland). The policy sees it as placing `resultName` at the block, since
 * that is the world change. `bot.activateBlock` resolves on the packet send,
 * not on the server's answer, so callers verify the block afterwards.
 */
export async function useHeldItemOn(bot: Bot, block: Block, face: Parameters<Bot["activateBlock"]>[1], resultName: string, signal?: AbortSignal): Promise<void> {
  const lease = requireWorldActionLease(signal); signal ??= lease.signal;
  beforeMutation(lease, "place", blockPoint(block), resultName);
  await raceAbort(bot.activateBlock(block, face), signal, { timeoutMs: EQUIP_TIMEOUT_MS, label: "use item" });
  throwIfAborted(signal);
}

/** `bot.dig` bounded by the lease signal and the block's dig time (see raceAbort). */
function abortableDig(bot: Bot, block: Parameters<Bot["dig"]>[0], signal: AbortSignal | undefined): Promise<void> {
  return raceAbort(bot.dig(block), signal, {
    timeoutMs: digBudgetMs(bot, block),
    label: "dig",
    onStop: () => bot.stopDigging(),
  });
}

/** Break a block the active build placed itself, for a planned replacement (door/window). */
export async function digOwnBuildBlock(bot: Bot, block: Parameters<Bot["dig"]>[0], signal?: AbortSignal): Promise<void> {
  const lease = requireWorldActionLease(signal); signal ??= lease.signal;
  beforeMutation(lease, "dig", blockPoint(block), block.name, true);
  await abortableDig(bot, block, signal);
  throwIfAborted(signal);
}

export async function digBlock(bot: Bot, block: Parameters<Bot["dig"]>[0], signal?: AbortSignal): Promise<void> {
  const lease = requireWorldActionLease(signal); signal ??= lease.signal;
  beforeMutation(lease, "dig", blockPoint(block), block.name);
  await abortableDig(bot, block, signal);
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

/**
 * Toss junk (see `junkToShed`) when the inventory is nearly full, so a gather
 * or hunt has room for what it picks up. Returns the number of items dropped.
 */
export async function shedJunk(bot: Bot, protect: readonly string[] = [], signal?: AbortSignal): Promise<number> {
  const plan = junkToShed(bot.inventory.items(), bot.inventory.emptySlotCount(), protect);
  let dropped = 0;
  for (const [name, count] of Object.entries(plan)) {
    const id = bot.registry.itemsByName[name]?.id;
    if (id === undefined) continue;
    await tossItem(bot, id, null, count, signal);
    dropped += count;
  }
  return dropped;
}

/**
 * Fight `target` until it dies or despawns, or the fight is stopped
 * (`pvpStop`, a timeout wrapper, or the plugin losing sight of it).
 * `bot.pvp.attack` only *starts* the fight and resolves at once; awaiting it
 * alone made every caller see a live mob, give up and call stop, so the bot
 * never landed more than a swing.
 */
export async function pvpAttack(bot: Bot, target: Entity, signal?: AbortSignal): Promise<void> {
  const lease = requireWorldActionLease(signal); signal ??= lease.signal;
  beforeMutation(lease, "combat", { x: target.position.x, y: target.position.y, z: target.position.z }, target.name ?? undefined);
  const fightSignal = signal;
  // mineflayer-pvp emits this on the bot but does not declare it.
  const pvpEvents = bot as unknown as NodeJS.EventEmitter;
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: unknown): void => {
      bot.off("entityGone", onGone);
      bot.off("entityDead", onDead);
      pvpEvents.off("stoppedAttacking", onStopped);
      fightSignal.removeEventListener("abort", onAbort);
      if (error === undefined) resolve(); else reject(error);
    };
    const onGone = (entity: Entity): void => { if (entity.id === target.id) finish(); };
    // The corpse stays in bot.entities through the death animation; record
    // the death so kill checks (isLiveMob, combatOutcomeObserved) see it.
    const onDead = (entity: Entity): void => {
      if (entity.id !== target.id) return;
      (entity as Entity & { health?: number }).health = 0;
      finish();
    };
    const onStopped = (): void => finish();
    const onAbort = (): void => finish(fightSignal.reason ?? new Error("combat aborted"));
    bot.on("entityGone", onGone);
    bot.on("entityDead", onDead);
    pvpEvents.on("stoppedAttacking", onStopped);
    fightSignal.addEventListener("abort", onAbort, { once: true });
    bot.pvp.attack(target).then(() => {
      if (bot.entities[target.id] === undefined) finish();
    }, finish);
  });
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
/** Farthest a container can be opened from (eye to block centre). */
const CONTAINER_REACH = 5.5;

export async function openContainer(bot: Bot, block: Block, signal?: AbortSignal): Promise<ContainerWindow> {
  const lease = requireWorldActionLease(signal); signal ??= lease.signal;
  beforeMutation(lease, "container", blockPoint(block), block.name);
  // Out of reach, Mineflayer waits 20s for a window that never opens. Fail
  // fast so the caller can walk over (or report) instead.
  const eye = bot.entity?.position.offset(0, 1.62, 0);
  const reach = eye === undefined ? 0 : eye.distanceTo(block.position.offset(0.5, 0.5, 0.5));
  if (reach > CONTAINER_REACH) throw new Error(`${block.name} is out of reach (${reach.toFixed(1)} blocks away)`);
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
