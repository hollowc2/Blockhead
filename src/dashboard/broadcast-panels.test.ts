import assert from "node:assert/strict";
import test from "node:test";
import { ago, armorMaterial, compact, DAY_SECONDS, dayDial, fraction, gainedItems, iconRow, itemLabel, latency, nearestTurn, NIGHT_SECONDS, progression, sparkline, uptime } from "./public/broadcast-panels.mjs";

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

test("with the public clock the dial is exact, and a frozen clock gives no countdown", () => {
  const now = Date.parse("2026-11-02T12:00:00Z");
  // 8200 ticks: 4800 to dusk at 20 ticks/s is exactly 4 minutes.
  assert.deepEqual(dayDial({ phase: "day", timeOfDay: 8200, now }), { phase: "day", angle: 25.5, remaining: 240, label: "Night in 4 min" });
  assert.equal(dayDial({ phase: "day", timeOfDay: 12_000, now }).label, "Night soon");
  // Midnight-ish: 6000 ticks to sunrise is 5 minutes; dawn wraps at 24000.
  assert.equal(dayDial({ phase: "night", timeOfDay: 18_000, now }).label, "Dawn in 5 min");
  assert.equal(dayDial({ phase: "night", timeOfDay: 23_900, now }).label, "Dawn soon");
  // The clock decides the phase when the edge-triggered phase lags a packet.
  assert.equal(dayDial({ phase: "day", timeOfDay: 13_100, now }).phase, "night");
  // The day arc is centred at the top: sunrise at -97.5°, dusk at +97.5°, as the story-anchored dial.
  assert.equal(dayDial({ phase: "day", timeOfDay: 0, now }).angle, -97.5);
  assert.equal(dayDial({ phase: "night", timeOfDay: 13_000, now }).angle, 97.5);
  assert.equal(dayDial({ phase: "day", timeOfDay: 6500, now }).angle, dayDial({ phase: "day", observedFlipAt: now - (DAY_SECONDS / 2) * 1000, now }).angle);
  // A stopped daylight cycle keeps the hand but drops the countdown.
  assert.deepEqual(dayDial({ phase: "day", timeOfDay: 8200, frozen: true, now }), { phase: "day", angle: 25.5, remaining: null, label: "Daytime" });
  // No phase (the Nether, offline) hides the dial whatever the clock says; junk clocks fall back to the story anchor.
  assert.equal(dayDial({ phase: null, timeOfDay: 6000, now }).phase, null);
  assert.equal(dayDial({ phase: "day", timeOfDay: Number.NaN, now }).label, "Daytime");
});

test("the dial hand turns forward through dawn instead of spinning back", () => {
  assert.equal(nearestTurn(null, 262), 262);
  assert.equal(nearestTurn(262, -97.5), 262.5);
  assert.equal(nearestTurn(262.5 + 360, 0), 720);
  assert.equal(nearestTurn(10, 12), 12);
});

test("now and build progress, latency and uptime stay short and bounded", () => {
  assert.deepEqual([fraction({ done: 4, total: 10 }), fraction({ done: 12, total: 10 }), fraction({ done: -1, total: 10 }), fraction({ done: 0, total: 0 }), fraction(null), fraction({ done: "x", total: 3 })], [0.4, 1, 0, null, null, null]);
  assert.deepEqual([latency(812.4), latency(2430), latency(38_400), latency(null), latency(-5), latency(Number.NaN)], ["812 ms", "2.4 s", "38 s", "—", "—", "—"]);
  assert.deepEqual([uptime(0), uptime(45.9), uptime(720), uptime(11_520), uptime(9_999_999), uptime(null), uptime(-3)], ["0s", "45s", "12m", "3h 12m", "115d 17h", "0s", "0s"]);
});

test("the vitals sparkline puts the newest minute at the right edge and breaks on gaps", () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();
  // A full hour spans the width; 0 is the bottom (inset), 20 the top.
  const full = sparkline(Array.from({ length: 60 }, (_, i) => ({ at: at(i), health: 20, hunger: 0 })), { width: 118, height: 24, inset: 2 });
  assert.match(full.health, /^M0 2L2 2/);
  assert.match(full.health, /L118 2$/);
  assert.match(full.hunger, /^M0 22/);
  // A short history hugs the right edge; a null minute splits the line into two runs.
  const short = sparkline([{ at: at(0), health: 10, hunger: 10 }, { at: at(1), health: null, hunger: null }, { at: at(2), health: 20, hunger: 20 }, { at: at(3), health: 20, hunger: 20 }], { width: 118, height: 24, inset: 2 });
  assert.equal(short.health.split("M").length - 1, 2);
  assert.match(short.health, /L118 2$/);
  // A lone point becomes a short dash so it still shows.
  assert.match(short.health, /^M111 12L113 12/);
  // Out-of-range values are clamped; nothing at all draws nothing.
  assert.match(sparkline([{ health: 99, hunger: -4 }, { health: 99, hunger: -4 }], { width: 118, height: 24 }).health, / 2L118 2$/);
  assert.deepEqual(sparkline([], { width: 118, height: 24 }), { health: "", hunger: "" });
  assert.deepEqual(sparkline(null, { width: 118, height: 24 }), { health: "", hunger: "" });
  // More than an hour keeps only the newest 60 minutes.
  assert.equal(sparkline(Array.from({ length: 90 }, (_, i) => ({ health: i < 30 ? null : 10, hunger: 10 })), { width: 118, height: 24 }).health.split("M").length - 1, 1);
});
