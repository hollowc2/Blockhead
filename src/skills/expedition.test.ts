import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bot } from "mineflayer";
import type { Logger } from "pino";
import type { MinecraftConfig } from "../config/schema.js";
import { EventBus } from "../events/bus.js";
import type { HomeLocation } from "../minecraft/movement.js";
import {
  checkExpeditionSupplies,
  DEFAULT_EXPEDITION_THRESHOLD,
  EXPEDITION_FOOD_RESERVE,
  hasAcceptableDurability,
  planReturn,
  tierForDistance,
  toolFamilyFor,
  ExpeditionTracker,
  expeditionThreshold,
  type ExpeditionSupplies,
} from "./expedition.js";

/** A config without a navigation section: the schema default applies. */
const config: MinecraftConfig = {
  server: { host: "eros", port: 25565, username: "CobbleBob", world_key: "test" },
  home: { dimension: "overworld", x: 0, y: 64, z: 0, protected_size_x: 100, protected_size_z: 100 },
};

const home: HomeLocation = { x: 0, y: 64, z: 0, dimension: "overworld" };

/** Supplies that satisfy every Phase 9 requirement. */
const goodSupplies: ExpeditionSupplies = {
  toolFamily: "pickaxe",
  hasUsableTool: true,
  food: EXPEDITION_FOOD_RESERVE,
  freeSlots: 8,
  health: 20,
  dimension: "overworld",
};

test("expedition threshold defaults to 256 when navigation is omitted", () => {
  assert.equal(expeditionThreshold(config), DEFAULT_EXPEDITION_THRESHOLD);
  assert.equal(expeditionThreshold({ ...config, navigation: { expedition_threshold: 512 } }), 512);
});

test("risk tier boundaries: near within, expedition beyond, deep past the multiplier", () => {
  assert.equal(tierForDistance(0, 256).name, "near");
  assert.equal(tierForDistance(256, 256).name, "near"); // threshold inclusive
  assert.equal(tierForDistance(257, 256).name, "expedition");
  assert.equal(tierForDistance(512, 256).name, "expedition");
  assert.equal(tierForDistance(513, 256).name, "deep"); // deep beyond threshold * 2
  assert.equal(tierForDistance(Number.POSITIVE_INFINITY, 256).name, "near"); // unknown distance
});

test("tiers are strictly more conservative the farther from home", () => {
  const near = tierForDistance(100, 256);
  const expedition = tierForDistance(300, 256);
  const deep = tierForDistance(700, 256);
  assert.ok(expedition.minHealth > near.minHealth);
  assert.ok(deep.minHealth > expedition.minHealth);
  assert.ok(expedition.minFreeSlots > near.minFreeSlots);
  assert.ok(deep.minFreeSlots > expedition.minFreeSlots);
});

test("tool family derivation covers logs, ores, and pickaxe-only stone", () => {
  assert.equal(toolFamilyFor("oak_log"), "axe");
  assert.equal(toolFamilyFor("iron_ore"), "pickaxe");
  assert.equal(toolFamilyFor("stone"), "pickaxe");
  assert.equal(toolFamilyFor("cobblestone"), "pickaxe");
  assert.equal(toolFamilyFor("dirt"), null);
});

test("durability: new and half-worn tools pass, worn-out tools fail, non-degradable passes", () => {
  assert.ok(hasAcceptableDurability(250, 0)); // new iron pickaxe
  assert.ok(hasAcceptableDurability(250, 125)); // exactly half used
  assert.ok(!hasAcceptableDurability(250, 126)); // just past half used
  assert.ok(hasAcceptableDurability(0, 0)); // item without a durability model
});

test("supply check passes when every requirement is met", () => {
  const report = checkExpeditionSupplies(goodSupplies, home, 256, 300.5);
  assert.equal(report.ok, true);
  assert.deepEqual(report.failures, []);
  assert.ok(report.plan !== null);
  assert.equal(report.tier.name, "expedition");
});

test("supply check lists every unmet requirement", () => {
  const report = checkExpeditionSupplies(
    {
      toolFamily: "pickaxe",
      hasUsableTool: false,
      food: 2,
      freeSlots: 1,
      health: 5,
      dimension: "overworld",
    },
    home,
    256,
    300,
  );
  assert.equal(report.ok, false);
  assert.equal(report.failures.length, 4);
  assert.ok(report.failures.some((f) => f.includes(`only 2/${EXPEDITION_FOOD_RESERVE} food`)));
  assert.ok(report.failures.some((f) => f.includes("no pickaxe with 50% durability left")));
  assert.ok(report.failures.some((f) => f.includes("only 1/6 free inventory slots")));
  assert.ok(report.failures.some((f) => f.includes("health 5/20 is below the 12 expedition floor")));
});

test("no return plan when home is unknown", () => {
  const report = checkExpeditionSupplies(goodSupplies, null, 256, 300);
  assert.equal(report.ok, false);
  assert.ok(report.failures.some((f) => f === "no home coordinate configured"));
  assert.equal(planReturn(null, goodSupplies, 300), null);
});

test("no return plan when home sits in another dimension", () => {
  const supplies = { ...goodSupplies, dimension: "the_nether" };
  const report = checkExpeditionSupplies(supplies, home, 256, 300);
  assert.equal(report.ok, false);
  assert.ok(report.failures.some((f) => f === "home is in another dimension, too far to walk back"));
  assert.equal(planReturn(home, supplies, 300), null);
});

test("a pre-spawn snapshot (unknown dimension) does not refuse the return plan", () => {
  const report = checkExpeditionSupplies({ ...goodSupplies, dimension: null }, home, 256, 300);
  assert.ok(report.plan !== null);
  assert.equal(report.ok, true);
});

// --- tracker transitions ---

interface FakeItem {
  name: string;
  count: number;
  maxDurability: number;
  durabilityUsed: number;
}

interface FakeBotShape {
  health?: number;
  freeSlots?: number;
  position?: { x: number; y: number; z: number } | null;
  dimension?: string;
  items?: FakeItem[];
  chatLog: string[];
}

/** A minimal Bot that satisfies everything the expedition policy reads. */
function fakeBot(shape: FakeBotShape): Bot {
  const items = shape.items ?? [];
  return {
    health: shape.health ?? 20,
    food: 20,
    inventory: {
      emptySlotCount: () => shape.freeSlots ?? 8,
      items: () => items,
    },
    entity: shape.position === undefined || shape.position === null ? null : { position: shape.position },
    game: { dimension: shape.dimension ?? "overworld" },
    chat: (message: string) => void shape.chatLog.push(message),
  } as unknown as Bot;
}

function noopLogger(): Logger {
  return { info: () => {}, warn: () => {}, error: () => {} } as unknown as Logger;
}

const tooledItems: FakeItem[] = [
  { name: "iron_pickaxe", count: 1, maxDurability: 250, durabilityUsed: 50 },
  { name: "cooked_beef", count: EXPEDITION_FOOD_RESERVE, maxDurability: 0, durabilityUsed: 0 },
];

test("tracker enters expedition mode when the supply check passes", () => {
  const bus = new EventBus();
  const events: string[] = [];
  bus.on("expedition.entered", () => void events.push("entered"));
  const chatLog: string[] = [];
  const bot = fakeBot({
    position: { x: 300, y: 64, z: 10 }, // ~300 blocks from home
    freeSlots: 8,
    items: tooledItems,
    chatLog,
  });
  const tracker = new ExpeditionTracker(bus, noopLogger());

  const result = tracker.enter({ bot, home, threshold: 256, toolFamily: "pickaxe" });
  assert.equal(result.ok, true);
  assert.equal(tracker.isActive, true);
  assert.deepEqual(events, ["entered"]);
  assert.ok(chatLog.some((m) => m.includes("Entering expedition mode")));
  assert.ok(chatLog.some((m) => m.includes("300 blocks from home")));
});

test("tracker refuses entry and stays inactive when supplies fail", () => {
  const bus = new EventBus();
  const denied: Array<{ failures: string[] }> = [];
  bus.on("expedition.denied", (p) => void denied.push(p));
  const chatLog: string[] = [];
  const bot = fakeBot({
    position: { x: 300, y: 64, z: 0 },
    freeSlots: 1, // below the 6-slot floor
    items: tooledItems,
    chatLog,
  });
  const tracker = new ExpeditionTracker(bus, noopLogger());

  const result = tracker.enter({ bot, home, threshold: 256, toolFamily: "pickaxe" });
  assert.equal(result.ok, false);
  assert.equal(tracker.isActive, false);
  assert.equal(denied.length, 1);
  assert.ok(denied[0]?.failures.some((f) => f.includes("only 1/6 free inventory slots")));
  assert.ok(!chatLog.some((m) => m.includes("Not traveling beyond")));
});

test("a worn required tool blocks entry", () => {
  const bot = fakeBot({
    position: { x: 300, y: 64, z: 0 },
    freeSlots: 8,
    items: [{ name: "iron_pickaxe", count: 1, maxDurability: 250, durabilityUsed: 200 }], // 20% left
    chatLog: [],
  });
  const tracker = new ExpeditionTracker(new EventBus(), noopLogger());
  const result = tracker.enter({ bot, home, threshold: 256, toolFamily: "pickaxe" });
  if (result.ok) assert.fail("expected the worn pickaxe to block entry");
  assert.ok(result.failures.some((f) => f.includes("no pickaxe with 50% durability left")));
});

test("tracker leaves expedition mode once back within the threshold", () => {
  const bus = new EventBus();
  const events: string[] = [];
  bus.on("expedition.left", () => void events.push("left"));
  const chatLog: string[] = [];
  const shape: FakeBotShape = {
    position: { x: 300, y: 64, z: 0 },
    freeSlots: 8,
    items: tooledItems,
    chatLog,
  };
  const bot = fakeBot(shape);
  const tracker = new ExpeditionTracker(bus, noopLogger());
  tracker.enter({ bot, home, threshold: 256, toolFamily: "pickaxe" });
  assert.equal(tracker.isActive, true);

  // Walk home: a fresh bot over the same shape records the new position; the
  // exit fires once the bot is within the threshold.
  const homeBot = fakeBot({ ...shape, position: { x: 10, y: 64, z: 5 } });
  tracker.leave(homeBot, home, 256);
  assert.equal(tracker.isActive, false);
  assert.deepEqual(events, ["left"]);
  assert.ok(chatLog.some((m) => m.includes("Leaving expedition mode")));
});

test("tracker stays in expedition mode while still far from home", () => {
  const chatLog: string[] = [];
  const bot = fakeBot({
    position: { x: 300, y: 64, z: 0 },
    freeSlots: 8,
    items: tooledItems,
    chatLog,
  });
  const tracker = new ExpeditionTracker(new EventBus(), noopLogger());
  tracker.enter({ bot, home, threshold: 256, toolFamily: "pickaxe" });

  // Still 300 blocks out: the risk tiers must keep applying, so no exit.
  tracker.leave(bot, home, 256);
  assert.equal(tracker.isActive, true);
  assert.ok(!chatLog.some((m) => m.includes("Leaving expedition mode")));
});

test("enter is idempotent within a run and reset clears it", () => {
  const chatLog: string[] = [];
  const bot = fakeBot({
    position: { x: 300, y: 64, z: 0 },
    freeSlots: 8,
    items: tooledItems,
    chatLog,
  });
  const tracker = new ExpeditionTracker(new EventBus(), noopLogger());
  assert.equal(tracker.enter({ bot, home, threshold: 256, toolFamily: "pickaxe" }).ok, true);
  // A later radius in the same run must not re-announce.
  assert.equal(tracker.enter({ bot, home, threshold: 256, toolFamily: "pickaxe" }).ok, true);
  assert.equal(chatLog.filter((m) => m.includes("Entering expedition mode")).length, 1);

  tracker.reset();
  assert.equal(tracker.isActive, false);
});