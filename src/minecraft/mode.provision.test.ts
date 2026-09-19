import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { Bot } from "mineflayer";
import type { Item } from "prismarine-item";
import prismarineItem from "prismarine-item";
import { provideCreativeItem } from "./mode.js";

function fakeBot(options: { mode?: number | string; protocol?: number; hotbarFull?: boolean; mainFull?: boolean; reject?: boolean; delay?: number } = {}): Bot {
  const registry = {
    type: "pc",
    version: { version: options.protocol ?? 769 },
    items: [] as Array<{ name: string; displayName: string; stackSize: number }>,
    itemsByName: {} as Record<string, { id: number }>,
    supportFeature: (feature: string) => feature === "itemsWithComponents",
  };
  const names = ["stone_bricks", "smooth_stone", "dark_oak_planks", "glass", "torch", "bookshelf", "oak_planks"];
  names.forEach((name, id) => { registry.items[id] = { name, displayName: name, stackSize: 64 }; registry.itemsByName[name] = { id }; });
  const inventory = new EventEmitter() as EventEmitter & { slots: Array<Item | null | undefined>; items: () => Item[] };
  inventory.slots = Array.from({ length: 45 }, () => null);
  if (options.hotbarFull) for (let i = 36; i <= 44; i++) inventory.slots[i] = { name: "dirt", count: 1 } as Item;
  if (options.mainFull) for (let i = 9; i <= 35; i++) inventory.slots[i] = { name: "dirt", count: 1 } as Item;
  inventory.items = () => inventory.slots.filter((item): item is Item => item !== null && item !== undefined);
  const put = (slot: number, item: Item): void => { inventory.slots[slot] = item; inventory.emit(`updateSlot:${slot}`, null, item); };
  const bot = {
    game: { gameMode: options.mode ?? 1 }, registry, inventory,
    creative: { setInventorySlot: async (slot: number, item: Item) => {
      if (options.reject) throw new Error("server rejected set_creative_slot");
      if (options.delay !== undefined) await new Promise((resolve) => setTimeout(resolve, options.delay));
      put(slot, item);
    } },
  } as unknown as Bot;
  return bot;
}

test("reuses an existing stack without sending a packet", async () => {
  const bot = fakeBot();
  const existing = { name: "stone_bricks", count: 12 } as Item;
  bot.inventory.slots[9] = existing;
  const result = await provideCreativeItem(bot, "stone_bricks", 4);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.item, existing);
  assert.equal(result.diagnostics.finalReason, "existing inventory stack reused");
});

test("uses empty main inventory when the hotbar is full and accepts null/undefined empties", async () => {
  const bot = fakeBot({ hotbarFull: true });
  (bot.inventory.slots as Array<Item | null | undefined>)[10] = undefined;
  const result = await provideCreativeItem(bot, "smooth_stone", 1);
  assert.equal(result.ok, true);
  assert.equal(result.diagnostics.selectedSlot, 9);
  assert.equal(bot.inventory.slots[9]?.name, "smooth_stone");
});

test("requires creative mode, known registry items, and approved materials", async () => {
  assert.equal((await provideCreativeItem(fakeBot({ mode: 0 }), "stone_bricks", 1)).ok, false);
  assert.match((await provideCreativeItem(fakeBot(), "lantern", 1)).diagnostics.finalReason, /registry/);
  assert.match((await provideCreativeItem(fakeBot(), "dirt", 1)).diagnostics.finalReason, /approved/);
});

test("does not return until the authoritative update is visible, including delayed updates", async () => {
  const bot = fakeBot({ delay: 40 });
  const result = await provideCreativeItem(bot, "glass", 1);
  assert.equal(result.ok, true);
  assert.equal(result.diagnostics.inventoryUpdateObserved, true);
  assert.equal(bot.inventory.items()[0]?.name, "glass");
});

test("server rejection is structured and never returns a local Item", async () => {
  const result = await provideCreativeItem(fakeBot({ reject: true }), "torch", 1);
  assert.equal(result.ok, false);
  assert.match(result.diagnostics.finalReason, /rejected/);
  assert.equal(result.diagnostics.packet, "set_creative_slot");
});

test("cancellation is respected", async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await provideCreativeItem(fakeBot(), "bookshelf", 1, controller.signal);
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics.finalReason, "cancelled");
});

test("concurrent requests are serialized and large quantities use multiple safe stacks", async () => {
  const bot = fakeBot();
  const [one, two] = await Promise.all([
    provideCreativeItem(bot, "oak_planks", 64),
    provideCreativeItem(bot, "dark_oak_planks", 64),
  ]);
  assert.equal(one.ok, true);
  assert.equal(two.ok, true);
  assert.equal(bot.inventory.slots[9]?.name, "oak_planks");
  assert.equal(bot.inventory.slots[10]?.name, "dark_oak_planks");
});

test("full inventory fails without overwriting protected items", async () => {
  const bot = fakeBot({ hotbarFull: true, mainFull: true });
  const protectedItem = bot.inventory.slots[9];
  const result = await provideCreativeItem(bot, "stone_bricks", 1);
  assert.equal(result.ok, false);
  assert.match(result.diagnostics.finalReason, /full/);
  assert.equal(bot.inventory.slots[9], protectedItem);
});

test("the 1.21.5 adapter sends UntrustedSlot and waits for server update", async () => {
  const bot = fakeBot({ protocol: 770 });
  let packet: unknown;
  (bot as unknown as { _client: { write: (name: string, payload: unknown) => void } })._client = {
    write: (_name, payload) => {
      packet = payload;
      const value = payload as { slot: number; item: { itemId: number; itemCount: number } };
      const ItemClass = (prismarineItem as unknown as (registry: typeof bot.registry) => unknown)(bot.registry) as new (type: number, count: number) => Item;
      const item = new ItemClass(value.item.itemId, value.item.itemCount);
      bot.inventory.slots[value.slot] = item;
      (bot.inventory as unknown as EventEmitter).emit(`updateSlot:${value.slot}`, null, item);
    },
  };
  const result = await provideCreativeItem(bot, "stone_bricks", 1);
  assert.equal(result.ok, true);
  assert.equal((packet as { item: { present: boolean } }).item.present, true);
});
