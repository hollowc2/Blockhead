import assert from "node:assert/strict";
import test from "node:test";
import { ago, armorMaterial, compact, DAY_SECONDS, dayDial, gainedItems, iconRow, itemLabel, NIGHT_SECONDS, progression } from "./public/broadcast-panels.mjs";

const reached = (state: unknown): string[] => progression(state).tiers.filter((tier) => tier.reached).map((tier) => tier.id);

test("progression lights tiers from milestones, carried or worn items, and the Nether", () => {
  assert.deepEqual(progression(null), { tiers: progression({}).tiers, current: null });
  assert.deepEqual(reached({}), []);
  assert.deepEqual(reached({ inventory: { items: [{ name: "oak_log", count: 3 }] } }), ["wood"]);
  assert.deepEqual(reached({ inventory: { items: [{ name: "minecraft:cobblestone", count: 30 }] } }), ["wood", "stone"]);
  // Worn gear counts, and a higher tool tier implies the ones below it.
  assert.deepEqual(reached({ equipment: { hand: { name: "diamond_pickaxe", count: 1 }, head: null } }), ["wood", "stone", "iron", "diamond"]);
  // Lifetime milestones survive a death that empties the inventory.
  const milestones = [{ id: "iron-pickaxe", unlocked: true }, { id: "diamond", unlocked: false }];
  assert.deepEqual(reached({ world: { milestones }, inventory: { items: [] } }), ["wood", "stone", "iron"]);
  assert.equal(progression({ world: { milestones } }).current, "iron");
  // Being in the Nether, or carrying something from it, implies at least iron (a portal needs a bucket).
  assert.deepEqual(reached({ self: { dimension: "minecraft:the_nether" } }), ["wood", "stone", "iron", "nether"]);
  assert.deepEqual(reached({ inventory: { items: [{ name: "quartz", count: 2 }] } }), ["wood", "stone", "iron", "nether"]);
  assert.equal(progression({ self: { dimension: "the_nether" } }).current, "nether");
  // Look-alikes are not tiers: stone bricks, iron-coloured dyes, a diamond horse armor is still diamond.
  assert.deepEqual(reached({ inventory: { items: [{ name: "stone_bricks", count: 1 }, { name: "light_gray_dye", count: 1 }] } }), []);
  assert.deepEqual(reached({ inventory: { items: [{ name: "diamond_horse_armor", count: 1 }] } }), ["wood", "stone", "iron", "diamond"]);
});

test("only items whose count rose since the previous poll are new; no baseline means nothing is", () => {
  const items = [{ name: "dirt", count: 5 }, { name: "torch", count: 8 }, { name: "raw_iron", count: 1 }];
  assert.deepEqual([...gainedItems(null, items)], []);
  assert.deepEqual([...gainedItems(new Map([["dirt", 5], ["torch", 9]]), items)], ["raw_iron"]);
  assert.deepEqual([...gainedItems(new Map([["dirt", 4], ["torch", 8], ["raw_iron", 1]]), items)], ["dirt"]);
});

test("day dial anchors on the latest sunrise or sunset it can believe", () => {
  const now = Date.parse("2026-11-02T12:00:00Z");
  const at = (secondsAgo: number) => new Date(now - secondsAgo * 1000).toISOString();
  // Four minutes into the day: night in about 7 minutes, hand left of noon.
  const day = dayDial({ phase: "day", story: [{ icon: "night", at: at(900) }, { icon: "day", at: at(240) }], now });
  assert.equal(day.remaining, DAY_SECONDS - 240);
  assert.equal(day.label, "Night in ~7 min");
  assert(day.angle < 0 && day.angle > -97.5);
  // Mid-day is noon at the top; mid-night is the bottom.
  assert.equal(dayDial({ phase: "day", observedFlipAt: now - (DAY_SECONDS / 2) * 1000, now }).angle, 0);
  assert.equal(dayDial({ phase: "night", observedFlipAt: now - (NIGHT_SECONDS / 2) * 1000, now }).angle, 180);
  // The page's own observation beats an older story entry.
  assert.equal(dayDial({ phase: "night", story: [{ icon: "night", at: at(500) }], observedFlipAt: now - 30_000, now }).label, "Dawn in ~9 min");
  assert.equal(dayDial({ phase: "night", observedFlipAt: now - 520_000, now }).label, "Dawn soon");
  // No anchor, a stale one (frozen clock, restart) or one from the future: no countdown, hand mid-phase.
  for (const story of [[], [{ icon: "day", at: at(DAY_SECONDS + 120) }], [{ icon: "day", at: at(-30) }], [{ icon: "day", at: "not a date" }]]) {
    const dial = dayDial({ phase: "day", story, now });
    assert.deepEqual([dial.remaining, dial.label, dial.angle], [null, "Daytime", 0], JSON.stringify(story));
  }
  assert.deepEqual(dayDial({ phase: null, now }), { phase: null, angle: 0, remaining: null, label: "" });
});

test("formatting helpers stay short and never print raw junk", () => {
  assert.deepEqual([compact(7), compact(1234), compact(18342), compact(2_500_000), compact(null), compact(Number.NaN)], ["7", "1.2k", "18k", "2.5M", "—", "—"]);
  assert.equal(itemLabel("minecraft:iron_pickaxe"), "Iron Pickaxe");
  const now = Date.parse("2026-11-02T12:00:00Z");
  assert.deepEqual(["2026-11-02T11:59:30Z", "2026-11-02T11:45:00Z", "2026-11-02T09:00:00Z", "2026-10-30T12:00:00Z", "bad"].map((iso) => ago(iso, now)), ["now", "15m", "3h", "3d", ""]);
  assert.deepEqual(iconRow(13), ["full", "full", "full", "full", "full", "full", "half", "empty", "empty", "empty"]);
  assert.deepEqual(iconRow(null), Array(10).fill("empty"));
  assert.deepEqual(iconRow(99), Array(10).fill("full"));
  assert.deepEqual(["iron_helmet", "golden_boots", "turtle_helmet", "elytra", null].map(armorMaterial), ["iron", "gold", "turtle", "other", null]);
});
