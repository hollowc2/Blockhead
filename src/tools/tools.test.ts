import assert from "node:assert/strict";
import { test } from "node:test";
import { EventBus } from "../events/bus.js";
import { AppDatabase } from "../memory/database.js";
import { MIGRATIONS } from "../memory/migrations.js";
import { TasksRepository } from "../memory/tasks.js";
import { LocationsRepository } from "../memory/locations.js";
import { StorageRepository } from "../memory/storage.js";
import { DeathEventsRepository } from "../memory/deaths.js";
import { Scheduler } from "../agent/scheduler.js";
import { ToolRegistry } from "./registry.js";
import { registerMovementTools } from "./movement.js";
import { registerBootstrapTools } from "./bootstrap.js";
import { registerResourceTools } from "./resources.js";
import { registerStorageTools } from "./storage.js";
import { registerBaseTools } from "./base.js";
import { registerAcquisitionTools } from "./acquire.js";
import { registerFoodTools } from "./food.js";
import { registerCombatTools } from "./combat.js";
import { registerNavigationTools } from "./navigation.js";
import { registerDeliveryTools } from "./delivery.js";
import { registerUtilityTools } from "./utility.js";
import { registerMemoryTools } from "./memory.js";

interface Harness {
  registry: ToolRegistry;
  scheduler: Scheduler;
}

function newHarness(): Harness {
  const db = new AppDatabase(":memory:");
  db.runMigrations(MIGRATIONS);
  const bus = new EventBus();
  const tasks = new TasksRepository(db);
  const scheduler = new Scheduler({ bus, tasks });
  const locations = new LocationsRepository(db);
  const storage = new StorageRepository(db);
  const deaths = new DeathEventsRepository(db);
  const registry = new ToolRegistry();
  registerMovementTools(registry);
  registerBootstrapTools(registry);
  registerResourceTools(registry, scheduler);
  registerStorageTools(registry, scheduler, storage, locations);
  registerBaseTools(registry, scheduler);
  registerAcquisitionTools(registry, scheduler);
  registerFoodTools(registry, scheduler);
  registerCombatTools(registry, scheduler);
  registerNavigationTools(registry, scheduler, locations);
  registerDeliveryTools(registry, scheduler);
  registerUtilityTools(registry, scheduler, deaths);
  registerMemoryTools(registry, locations);
  return { registry, scheduler };
}

/** The Phase 13 tool set the definition of done names explicitly. */
const REQUIRED_TOOLS = [
  "ensure_item",
  "craft_item",
  "smelt_item",
  "upgrade_equipment",
  "gather_food",
  "hunt",
  "hunt_target",
  "travel_to",
  "explore",
  "give_item",
  "store_items",
  "retrieve_items",
  "defend_self",
  "defend_player",
  "sleep",
  "eat",
  "equip_best",
  "replace_equipment",
  "recover_death_items",
  "remember_location",
  "forget_location",
  "find_location",
  "inspect_area",
  "register_storage",
  "build_base",
  "collect_resource",
  "come_to_player",
  "follow_player",
  "go_home",
  "stop",
];

test("every required high-level tool is registered and described", () => {
  const { registry } = newHarness();
  for (const name of REQUIRED_TOOLS) {
    assert.equal(registry.has(name), true, name);
  }
  const describe = registry.describe();
  for (const name of REQUIRED_TOOLS) {
    assert.ok(describe.includes(`"name": "${name}"`), `describe() mentions ${name}`);
  }
});

test("none of the new tools accepts free-form arguments or a human player target", () => {
  const { registry } = newHarness();
  // hunt_target's enum can never contain "player".
  assert.throws(() => registry.validateArgs("hunt_target", { entity_type: "player" }));
  assert.throws(() => registry.validateArgs("hunt_target", { entity_type: "Corey" }));
  // Valid hostile/animal targets still pass.
  const parsed = registry.validateArgs("hunt_target", { entity_type: "zombie" });
  assert.equal(parsed.entity_type, "zombie");
  assert.equal(registry.validateArgs("hunt", { entity_type: "cow", quantity: 6 }).entity_type, "cow");
  assert.throws(() => registry.validateArgs("hunt", { entity_type: "zombie", quantity: 6 }));
});

test("tool schemas reject malformed arguments with Zod", () => {
  const { registry } = newHarness();
  const cases: [string, unknown][] = [
    ["ensure_item", { item: "", quantity: 1 }],
    ["ensure_item", { item: "oak_log", quantity: 0 }],
    ["ensure_item", { item: "oak_log" }],
    ["craft_item", { item: "stick", quantity: "lots" }],
    ["smelt_item", { quantity: 1 }],
    ["travel_to", { location: "" }],
    ["travel_to", { location: { x: "a", y: 1, z: 2 } }],
    ["explore", { direction: 400 }],
    ["give_item", { player: "Corey", item: "iron_ingot", quantity: -1 }],
    ["retrieve_items", { items: [] }],
    ["retrieve_items", { items: [{ item: 42 }] }],
    ["store_items", { filter: 123 }],
    ["defend_player", {}],
    ["remember_location", {}],
    ["forget_location", { name: "" }],
    ["register_storage", { category: "nonsense" }],
  ];
  for (const [tool, args] of cases) {
    assert.throws(() => registry.validateArgs(tool, args), `${tool} should reject ${JSON.stringify(args)}`);
  }
});

test("tool schemas accept their documented shapes", () => {
  const { registry } = newHarness();
  const cases: [string, Record<string, unknown>, string][] = [
    ["ensure_item", { item: "iron_pickaxe", quantity: 1 }, "iron_pickaxe"],
    ["craft_item", { item: "stick", quantity: 12 }, "stick"],
    ["smelt_item", { item: "cooked_beef", quantity: 2 }, "cooked_beef"],
    ["travel_to", { location: { x: 10, y: 40, z: -20 } }, "location"],
    ["explore", { direction: 90, distance: 128 }, "direction"],
    ["explore", {}, "distance"],
    ["give_item", { player: "Corey", item: "iron_ingot", quantity: 4 }, "player"],
    ["store_items", { filter: "wood", location: "home" }, "filter"],
    ["retrieve_items", { items: [{ item: "iron_ingot", quantity: 4 }] }, "items"],
    ["defend_self", {}, "defend_self"],
    ["defend_player", { player: "Corey" }, "player"],
    ["hunt", { entity_type: "sheep", quantity: 3 }, "sheep"],
    ["hunt_target", { entity_type: "skeleton" }, "skeleton"],
    ["gather_food", { quantity: 8 }, "8"],
    ["remember_location", { name: "mine" }, "mine"],
    ["find_location", { name: "mine" }, "mine"],
    ["sleep", {}, "sleep"],
    ["eat", {}, "eat"],
    ["equip_best", {}, "equip_best"],
    ["replace_equipment", {}, "replace_equipment"],
    ["register_storage", { category: "general", location: { x: 1, y: 2, z: 3 } }, "general"],
  ];
  for (const [tool, args] of cases) {
    const parsed = registry.validateArgs(tool, args);
    assert.ok(parsed !== undefined, `${tool} accepts ${JSON.stringify(args)}`);
  }
});

test("unknown tool names are rejected by the registry", () => {
  const { registry } = newHarness();
  assert.equal(registry.has("delete_all_furniture"), false);
  assert.equal(registry.has("run_js"), false);
  assert.throws(() => registry.validateArgs("run_js", {}));
});