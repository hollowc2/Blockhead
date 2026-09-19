import type { Bot } from "mineflayer";
import type { Item } from "prismarine-item";
import prismarineItem from "prismarine-item";
import { bareName, countItem, findItem } from "./inventory.js";

export const CREATIVE_GAME_MODE = 1;
export const APPROVED_CREATIVE_MATERIALS: ReadonlySet<string> = new Set([
  "cobblestone", "stone_bricks", "smooth_stone", "dark_oak_planks", "oak_planks",
  "glass", "glass_pane", "iron_bars", "stone", "torch", "lantern", "bookshelf",
  "bookshelf_block", "chest", "crafting_table", "furnace", "oak_door", "cyan_concrete",
  "magenta_concrete", "yellow_concrete", "red_carpet", "blue_carpet", "purple_carpet",
  "white_bed", "blue_bed", "red_bed", "flower_pot",
]);

export function isCreativeMode(bot: Bot): boolean {
  const game = (bot as unknown as { game?: { gameMode?: number | string; gamemode?: number | string } }).game;
  if (game === undefined) return false;
  const mode = game.gameMode ?? game.gamemode;
  return mode === CREATIVE_GAME_MODE || mode === "creative";
}

export interface CreativeProvisionDiagnostics {
  itemName: string; quantity: number; serverVersion: string; protocolVersion: number | null;
  selectedSlot: number | null; packet: "set_creative_slot" | null; packetError: string | null;
  inventoryUpdateObserved: boolean; retryCount: number; finalReason: string;
}
export type CreativeProvisionResult =
  | { ok: true; item: Item; diagnostics: CreativeProvisionDiagnostics }
  | { ok: false; diagnostics: CreativeProvisionDiagnostics };
export interface CreativeProvisionOptions { approvedMaterials?: ReadonlySet<string> | readonly string[]; }

const provisionChains = new WeakMap<object, Promise<void>>();
const RETRIES = 3;
const CONFIRM_TIMEOUT_MS = 50;

function serverVersion(bot: Bot): string {
  const b = bot as unknown as { version?: string; _client?: { version?: string } };
  return b.version ?? b._client?.version ?? "unknown";
}
function protocolVersion(bot: Bot): number | null {
  const value = (bot.registry as unknown as { version?: { version?: number } | number }).version;
  return typeof value === "number" ? value : value?.version ?? null;
}
function abortError(): Error { return new Error("creative item provisioning cancelled"); }
function waitForAbort(signal: AbortSignal | undefined, ms: number): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => { if (timer !== undefined) clearTimeout(timer); reject(abortError()); };
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
  });
}
function enqueue<T>(bot: Bot, work: () => Promise<T>): Promise<T> {
  const previous = provisionChains.get(bot) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(work);
  provisionChains.set(bot, current.then(() => undefined, () => undefined));
  return current;
}
function matches(item: Item | null | undefined, name: string): item is Item {
  return item !== null && item !== undefined && bareName(item.name) === name;
}
async function creativeSetSlot(bot: Bot, slot: number, item: Item, signal?: AbortSignal): Promise<void> {
  const registry = bot.registry as unknown as { supportFeature?: (name: string) => boolean };
  const client = (bot as Bot & { _client?: { write?: (packet: string, payload: unknown) => void } })._client;
  // Minecraft 1.21.5 changed this clientbound request's item field from Slot
  // to UntrustedSlot. Mineflayer 4.39 still exposes the old plugin method;
  // write the version-correct payload ourselves for protocol 770+.
  if (protocolVersion(bot) !== null && protocolVersion(bot)! >= 770 && client?.write !== undefined && registry.supportFeature?.("itemsWithComponents")) {
    const ItemClass = (prismarineItem as unknown as (registry: typeof bot.registry) => { toNotch: (item: Item) => unknown })(bot.registry);
    const payload = ItemClass.toNotch(item);
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const inventory = bot.inventory as unknown as { on: (event: string, listener: (oldItem: Item | null, newItem: Item | null) => void) => void; off: (event: string, listener: (...args: unknown[]) => void) => void };
      const event = `updateSlot:${slot}`;
      const cleanup = (): void => { if (timer !== undefined) clearTimeout(timer); inventory.off(event, listener as (...args: unknown[]) => void); signal?.removeEventListener("abort", onAbort); };
      const onAbort = (): void => { cleanup(); reject(abortError()); };
      const listener = (_old: Item | null, updated: Item | null): void => {
        if (matches(updated, bareName(item.name)) && updated.count >= item.count) { cleanup(); resolve(); }
      };
      inventory.on(event, listener);
      signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => { cleanup(); reject(new Error("timed out waiting for server inventory update")); }, 5_000);
      try { client.write!("set_creative_slot", { slot, item: payload }); } catch (error) { cleanup(); reject(error); }
    });
    return;
  }
  const creative = (bot as Bot & { creative?: { setInventorySlot?: (slot: number, item: Item) => Promise<void> } }).creative;
  if (creative?.setInventorySlot === undefined) throw new Error("creative inventory API is unavailable");
  await creative.setInventorySlot(slot, item);
}

/** Provision only approved architectural items, and return only after the
 * authoritative Mineflayer inventory mirror contains the requested item. */
export function provideCreativeItem(bot: Bot, rawName: string, quantity: number, signal?: AbortSignal, options?: CreativeProvisionOptions): Promise<CreativeProvisionResult> {
  return enqueue(bot, () => provideCreativeItemSerialized(bot, rawName, quantity, signal, options));
}

async function provideCreativeItemSerialized(bot: Bot, rawName: string, quantity: number, signal?: AbortSignal, options?: CreativeProvisionOptions): Promise<CreativeProvisionResult> {
  const itemName = bareName(rawName);
  const diagnostics: CreativeProvisionDiagnostics = {
    itemName, quantity, serverVersion: serverVersion(bot), protocolVersion: protocolVersion(bot),
    selectedSlot: null, packet: null, packetError: null, inventoryUpdateObserved: false, retryCount: 0, finalReason: "unknown",
  };
  if (signal?.aborted) { diagnostics.finalReason = "cancelled"; return { ok: false, diagnostics }; }
  if (!isCreativeMode(bot)) { diagnostics.finalReason = "creative mode is required"; return { ok: false, diagnostics }; }
  if (!Number.isInteger(quantity) || quantity <= 0) { diagnostics.finalReason = "quantity must be a positive integer"; return { ok: false, diagnostics }; }
  const approved = options?.approvedMaterials ?? APPROVED_CREATIVE_MATERIALS;
  const isApproved = typeof (approved as ReadonlySet<string>).has === "function"
    ? (approved as ReadonlySet<string>).has(itemName)
    : (approved as readonly string[]).includes(itemName);
  if (!isApproved) { diagnostics.finalReason = "material is not approved for creative provisioning"; return { ok: false, diagnostics }; }
  const definition = bot.registry.itemsByName[itemName];
  if (definition === undefined) { diagnostics.finalReason = "item is not present in the connected bot registry"; return { ok: false, diagnostics }; }
  const existing = findItem(bot, itemName);
  if (countItem(bot, itemName) >= quantity && existing !== null) {
    diagnostics.finalReason = "existing inventory stack reused";
    return { ok: true, item: existing, diagnostics };
  }
  const ItemConstructor = prismarineItem as unknown as (registry: typeof bot.registry) => new (type: number, count: number) => Item;
  const creative = (bot as Bot & { creative?: { setInventorySlot?: (slot: number, item: Item) => Promise<void> } }).creative;
  if (creative?.setInventorySlot === undefined) { diagnostics.finalReason = "creative inventory API is unavailable"; return { ok: false, diagnostics }; }
  const usableSlots = (): number[] => Array.from({ length: 27 }, (_, i) => i + 9).concat(Array.from({ length: 9 }, (_, i) => i + 36));
  while (countItem(bot, itemName) < quantity) {
    const slot = usableSlots().find((index) => bot.inventory.slots[index] == null);
    if (slot === undefined) { diagnostics.finalReason = "inventory is full; no safe empty main-inventory or hotbar slot"; return { ok: false, diagnostics }; }
    diagnostics.selectedSlot = slot;
    const item = new (ItemConstructor(bot.registry))(definition.id, Math.min(64, quantity - countItem(bot, itemName)));
    let confirmed = false;
    for (let attempt = 0; attempt < RETRIES; attempt++) {
      diagnostics.retryCount = attempt;
      if (signal?.aborted) { diagnostics.finalReason = "cancelled"; return { ok: false, diagnostics }; }
      try {
        diagnostics.packet = "set_creative_slot";
        await creativeSetSlot(bot, slot, item, signal);
        await waitForAbort(signal, CONFIRM_TIMEOUT_MS);
        const observed = bot.inventory.slots[slot];
        if (matches(observed, itemName) && observed.count >= 1) {
          diagnostics.inventoryUpdateObserved = true;
          confirmed = true;
          break;
        }
        diagnostics.finalReason = "creative slot acknowledgement arrived without the expected inventory item";
      } catch (error) {
        diagnostics.packetError = error instanceof Error ? error.message : String(error);
        diagnostics.finalReason = diagnostics.packetError;
        if (signal?.aborted) { diagnostics.finalReason = "cancelled"; return { ok: false, diagnostics }; }
      }
    }
    if (!confirmed) return { ok: false, diagnostics };
  }
  const result = findItem(bot, itemName);
  if (result === null) { diagnostics.finalReason = "server update was observed but item could not be read from inventory"; return { ok: false, diagnostics }; }
  diagnostics.finalReason = "server inventory update confirmed";
  return { ok: true, item: result, diagnostics };
}

export function enableCreativeFlight(bot: Bot): boolean {
  if (!isCreativeMode(bot)) return false;
  const creative = (bot as Bot & { creative?: { startFlying?: () => void } }).creative;
  if (creative?.startFlying === undefined) return false;
  try { creative.startFlying(); return true; } catch { return false; }
}
