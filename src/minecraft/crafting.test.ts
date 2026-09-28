import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { createRequire } from "node:module";
import { test } from "node:test";
import type { Bot } from "mineflayer";
import type { Block } from "prismarine-block";
import type { Item as PItem } from "prismarine-item";
import type { Recipe as PRecipe } from "prismarine-recipe";
import { withWorldActionLease } from "../agent/world-actions.js";
import { craftItem, craftMorePlanks, craftPlanks, craftSticks } from "./crafting.js";
import { countItem, itemsSummary } from "./inventory.js";

const require = createRequire(import.meta.url);
const registry = require("prismarine-registry")("1.21.4");
const Item = require("prismarine-item")(registry);
const windows = require("prismarine-windows")(registry);
const { Recipe } = require("prismarine-recipe")(registry);

const GRID = [1, 2, 3, 4];
const INVENTORY_START = 9;
const INVENTORY_END = 45;
/** How late the second full-state answer to a resync lands (vanilla 1.21.4). */
const STALE_FULL_STATE_MS = 5;
/** One network round trip / server tick in the fake. */
const TICK_MS = 1;

/** prismarine-windows types omit the null an empty slot holds. */
const EMPTY = null as unknown as PItem;
const orEmpty = (item: PItem | null): PItem => item ?? EMPTY;
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, TICK_MS));
const clone = (item: PItem | null): PItem | null => (item === null ? null : new Item(item.type, item.count, item.metadata));
const itemNamed = (name: string, count: number): PItem => new Item(registry.itemsByName[name].id, count);

/**
 * Authoritative server-side inventory plus a mineflayer-shaped bot whose
 * `inventory` is only a prediction. The fake reproduces what broke CobbleBob's
 * bootstrap on 1.21.4: `_syncWindow` is answered by a full-state packet and a
 * second, delayed one captured before the next click is processed. If that
 * stale snapshot lands mid-craft it rolls the predicted cursor back, the craft
 * never puts the ingredient stack away (it stays on the server cursor, one log
 * in the 2x2 grid) and the result is never taken, while the prediction shows
 * the output anyway. Clicks the client never reported (mineflayer clearing the
 * grid locally) are never corrected by the server.
 */
class FakeServer {
  readonly slots: (PItem | null)[] = Array.from({ length: 46 }, () => null);
  cursor: PItem | null = null;
  readonly client = new EventEmitter();
  readonly bot: Bot;

  constructor(stock: Record<string, number>) {
    let slot = INVENTORY_START;
    for (const [name, count] of Object.entries(stock)) this.slots[slot++] = itemNamed(name, count);
    const inventory = windows.createWindow(0, "minecraft:inventory", "Inventory");
    const bot = Object.assign(new EventEmitter(), {
      registry,
      inventory,
      currentWindow: null,
      _client: this.client,
      _syncWindow: async () => {
        const synced = once(bot, "setWindowItems:0");
        const snapshot = this.snapshot();
        setImmediate(() => this.fullState(snapshot));
        setTimeout(() => this.fullState(snapshot), STALE_FULL_STATE_MS);
        await synced;
      },
      recipesAll: (id: number, metadata: number | null, table: boolean) =>
        (Recipe.find(id, metadata) as PRecipe[]).filter((recipe) => !recipe.requiresTable || table),
      craft: async (recipe: PRecipe, count: number) => {
        for (let n = 0; n < count; n += 1) await this.craftOnce(recipe);
      },
      clickWindow: async (slot: number, _button: number, mode: number) => {
        assert.equal(mode, 1, "cleanup only shift-clicks grid slots");
        this.moveIntoInventory(this.slots[slot] ?? null);
        this.slots[slot] = null;
        inventory.updateSlot(slot, EMPTY);
        this.correct();
      },
      putSelectedItemRange: async () => {
        this.moveIntoInventory(this.cursor);
        this.cursor = null;
        inventory.selectedItem = null;
        this.correct();
      },
    });
    this.bot = bot as unknown as Bot;
    this.fullState(this.snapshot());
  }

  get model(): Bot["inventory"] { return this.bot.inventory; }

  snapshot(): { slots: (PItem | null)[]; cursor: PItem | null } {
    return { slots: this.slots.map(clone), cursor: clone(this.cursor) };
  }

  /** mineflayer's window_items handler: overwrite the whole model. */
  fullState(snapshot: { slots: (PItem | null)[]; cursor: PItem | null }): void {
    snapshot.slots.forEach((item, slot) => this.model.updateSlot(slot, orEmpty(clone(item))));
    this.model.selectedItem = clone(snapshot.cursor);
    this.client.emit("window_items");
    (this.bot as unknown as EventEmitter).emit("setWindowItems:0");
  }

  /** broadcastChanges: resend reported inventory slots that differ, one tick later. */
  correct(): void {
    setTimeout(() => {
      for (let slot = INVENTORY_START; slot < INVENTORY_END; slot += 1) {
        const real = this.slots[slot] ?? null;
        const seen = this.model.slots[slot];
        if (real?.type === seen?.type && real?.count === seen?.count) continue;
        this.model.updateSlot(slot, orEmpty(clone(real)));
        this.client.emit("set_slot");
      }
    }, TICK_MS);
  }

  moveIntoInventory(stack: PItem | null): void {
    if (stack === null) return;
    let left = stack.count;
    for (let slot = INVENTORY_START; slot < INVENTORY_END && left > 0; slot += 1) {
      const item = this.slots[slot] ?? null;
      if (item === null) { this.slots[slot] = new Item(stack.type, left); left = 0; }
      else if (item.type === stack.type && item.count < item.stackSize) {
        const moved = Math.min(left, item.stackSize - item.count);
        item.count += moved;
        left -= moved;
      }
    }
    assert.equal(left, 0, "fake inventory overflow");
  }

  /** Grid-derived result, as the server recomputes it. */
  result(recipe: PRecipe): boolean {
    for (const delta of recipe.delta.filter((d) => d.count < 0)) {
      const inGrid = GRID.reduce((sum, slot) => sum + (this.slots[slot]?.type === delta.id ? this.slots[slot]!.count : 0), 0);
      if (inGrid < -delta.count) return false;
    }
    return true;
  }

  /** mineflayer's click sequence for one recipe run, clicking on its prediction. */
  async craftOnce(recipe: PRecipe): Promise<void> {
    const model = this.model;
    if (recipe.requiresTable) return this.craftAtTable(recipe);
    const cells = [...GRID];
    for (const delta of recipe.delta.filter((d) => d.count < 0)) {
      const source = model.findInventoryItem(delta.id, null, false);
      if (!source) throw new Error("missing ingredient");
      const slot = source.slot;
      // Pick the stack up.
      model.selectedItem = clone(source);
      model.updateSlot(slot, EMPTY);
      this.cursor = this.slots[slot] ?? null;
      this.slots[slot] = null;
      await tick();
      // Place one item per recipe cell.
      for (let placed = 0; placed < -delta.count; placed += 1) {
        const cell = cells.shift()!;
        if (model.selectedItem !== null) {
          model.selectedItem.count -= 1;
          model.updateSlot(cell, new Item(delta.id, 1));
          if (model.selectedItem.count === 0) model.selectedItem = null;
        }
        if (this.cursor !== null && this.cursor.type === delta.id) {
          this.slots[cell] = new Item(delta.id, (this.slots[cell]?.count ?? 0) + 1);
          this.cursor.count -= 1;
          if (this.cursor.count === 0) this.cursor = null;
        }
        await tick();
      }
      // Put the rest back; a rolled-back prediction thinks the cursor is empty.
      if (model.selectedItem !== null) {
        model.updateSlot(slot, model.selectedItem);
        model.selectedItem = null;
        this.slots[slot] = this.cursor;
        this.cursor = null;
      }
      await tick();
    }
    // Take the result: predicted into the inventory, real only if the server grid holds the recipe.
    const output = new Item(recipe.result.id, recipe.result.count);
    const predicted = model.findItemRange(INVENTORY_START, INVENTORY_END, output.type, null, true, null);
    if (predicted) predicted.count += output.count;
    else model.updateSlot(model.firstEmptySlotRange(INVENTORY_START, INVENTORY_END)!, output);
    if (this.cursor === null && this.result(recipe)) {
      for (const delta of recipe.delta.filter((d) => d.count < 0)) {
        let left = -delta.count;
        for (const slot of GRID) {
          const item = this.slots[slot] ?? null;
          if (left === 0 || item === null || item.type !== delta.id) continue;
          const used = Math.min(left, item.count);
          item.count -= used;
          left -= used;
          if (item.count === 0) this.slots[slot] = null;
        }
      }
      this.moveIntoInventory(output);
    }
    // mineflayer clears the grid locally without telling the server.
    for (const slot of GRID) model.updateSlot(slot, EMPTY);
    this.correct();
    await tick();
  }

  /** A crafting-table window run: its own 3x3 grid, synced on close. */
  async craftAtTable(recipe: PRecipe): Promise<void> {
    for (const delta of recipe.delta) {
      if (delta.count >= 0) continue;
      let left = -delta.count;
      for (let slot = INVENTORY_START; slot < INVENTORY_END && left > 0; slot += 1) {
        const item = this.slots[slot] ?? null;
        if (item === null || item.type !== delta.id) continue;
        const used = Math.min(left, item.count);
        item.count -= used;
        left -= used;
        if (item.count === 0) this.slots[slot] = null;
      }
      if (left > 0) throw new Error("missing ingredient");
    }
    this.moveIntoInventory(new Item(recipe.result.id, recipe.result.count));
    await tick();
    this.fullState(this.snapshot());
  }

  /** What `data get entity` would show: the carried inventory only. */
  serverCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (let slot = INVENTORY_START; slot < INVENTORY_END; slot += 1) {
      const item = this.slots[slot] ?? null;
      if (item) counts[item.name] = (counts[item.name] ?? 0) + item.count;
    }
    return counts;
  }

  assertConsistent(): void {
    assert.deepEqual(itemsSummary(this.bot), this.serverCounts(), "model matches the server inventory");
    assert.equal(this.cursor, null, "nothing stranded on the server cursor");
    assert.deepEqual(GRID.map((slot) => this.slots[slot]), [null, null, null, null], "nothing stranded in the 2x2 grid");
  }
}

function leased<T>(action: () => Promise<T>): Promise<T> {
  const controller = new AbortController();
  return withWorldActionLease({ owner: "crafting-test", signal: controller.signal, acknowledged: Promise.resolve() }, action);
}

test("one bootstrap crafting pass turns 9 logs into planks, sticks, table and wooden tools despite stale resync snapshots", async () => {
  const server = new FakeServer({ acacia_log: 9 });
  const bot = server.bot;
  const table = { name: "crafting_table", position: { x: 0, y: 0, z: 0 } } as unknown as Block;
  await leased(async () => {
    // Previously: "not enough logs to craft 12 planks (8 held)" with a log
    // stranded on the cursor and one in the grid.
    const planks = await craftPlanks(bot, 12);
    assert.deepEqual(planks, { ok: true, name: "planks", crafted: 12 });
    server.assertConsistent();
    assert.equal(countItem(bot, "acacia_log"), 6);

    assert.deepEqual(await craftSticks(bot, 4), { ok: true, name: "stick", crafted: 4 });
    assert.deepEqual(await craftItem(bot, "crafting_table"), { ok: true, name: "crafting_table", crafted: 1 });
    assert.deepEqual(await craftItem(bot, "wooden_pickaxe", { craftingTable: table }), { ok: true, name: "wooden_pickaxe", crafted: 1 });
    assert.deepEqual(await craftItem(bot, "wooden_axe", { craftingTable: table }), { ok: true, name: "wooden_axe", crafted: 1 });
  });
  server.assertConsistent();
  assert.deepEqual(server.serverCounts(), { acacia_log: 6, crafting_table: 1, wooden_pickaxe: 1, wooden_axe: 1 });
});

test("crafting recovers ingredients an earlier desynced craft stranded on the cursor and in the grid", async () => {
  const server = new FakeServer({ acacia_log: 2 });
  // The server holds 4 logs on the cursor and 1 in the grid; the model has lost track of them.
  server.cursor = itemNamed("acacia_log", 4);
  server.slots[4] = itemNamed("acacia_log", 1);
  assert.equal(countItem(server.bot, "acacia_log"), 2);

  const planks = await leased(() => craftPlanks(server.bot, 28));
  assert.deepEqual(planks, { ok: true, name: "planks", crafted: 28 });
  server.assertConsistent();
  assert.deepEqual(server.serverCounts(), { acacia_planks: 28 });
});

test("craftMorePlanks counts from the settled inventory, not a stale model", async () => {
  const server = new FakeServer({ acacia_planks: 4, acacia_log: 2 });
  server.model.updateSlot(INVENTORY_START, EMPTY); // the model has lost the carried planks
  assert.equal(countItem(server.bot, "acacia_planks"), 0);

  // `craftPlanks(bot, countPlanks(bot) + 4)` asked for 4 total here and found it already satisfied.
  const planks = await leased(() => craftMorePlanks(server.bot, 4));
  assert.deepEqual(planks, { ok: true, name: "planks", crafted: 4 });
  server.assertConsistent();
  assert.deepEqual(server.serverCounts(), { acacia_planks: 8, acacia_log: 1 });
});
