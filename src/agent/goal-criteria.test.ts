import assert from "node:assert/strict";
import { test } from "node:test";
import { Vec3 } from "vec3";
import { resolveCriterion } from "./goal-criteria.js";
import { boundsKey, chestKey, criterionProgress, evaluateSuccessCriteria, type SuccessCriterion } from "./goal.js";
import type { ToolContext } from "../tools/types.js";

const chest = { x: 10, y: 64, z: -3, dimension: "overworld" };
const bounds = { minX: 0, maxX: 1, minY: 64, maxY: 65, minZ: 0, maxZ: 1 };

function check(criterion: SuccessCriterion, facts: Parameters<typeof evaluateSuccessCriteria>[1]): boolean {
  return evaluateSuccessCriteria({ successCriteria: [criterion] }, facts).satisfied;
}

test("building_verified: the base needs a measured-complete shed; a project needs final verification", () => {
  assert.equal(check({ kind: "building_verified", target: "base" }, {}), false, "unmeasured is unmet");
  assert.equal(check({ kind: "building_verified", target: "base" }, { baseVerified: false }), false);
  assert.equal(check({ kind: "building_verified", target: "base" }, { baseVerified: true }), true);

  const unbound: SuccessCriterion = { kind: "building_verified", target: "project", match: "house" };
  assert.equal(check(unbound, { projects: { p1: "completed" } }), false, "an unbound project is never done");
  assert.match(criterionProgress(unbound, {}), /no build project matching "house"/);
  const bound: SuccessCriterion = { kind: "building_verified", target: "project", projectId: "p1", projectName: "cottage" };
  assert.equal(check(bound, { projects: { p1: "verifying" } }), false, "verifying is not verified");
  assert.equal(check(bound, { projects: { p1: "completed" } }), true);
});

test("chest_contains reads the frozen chest; an unread chest is unknown, not empty or full", () => {
  const criterion: SuccessCriterion = { kind: "chest_contains", item: "iron_ingot", min: 32, chest };
  assert.equal(check(criterion, {}), false);
  assert.match(criterionProgress(criterion, {}), /not read yet/);
  assert.equal(check(criterion, { chests: { [chestKey(chest)]: { iron_ingot: 12 } } }), false);
  assert.match(criterionProgress(criterion, { chests: { [chestKey(chest)]: { iron_ingot: 12 } } }), /holds 12\/32 iron_ingot/);
  assert.equal(check(criterion, { chests: { [chestKey(chest)]: { iron_ingot: 40 } } }), true);
  assert.equal(check(criterion, { chests: { [chestKey({ ...chest, x: 11 })]: { iron_ingot: 40 } } }), false, "another chest does not count");
});

test("area_cleared needs every inspected cell clear", () => {
  const criterion: SuccessCriterion = { kind: "area_cleared", dimension: "overworld", bounds, anchor: { x: 0, y: 64, z: 0 }, anchorKind: "home", width: 2, length: 2, height: 2 };
  const key = boundsKey("overworld", bounds);
  assert.equal(check(criterion, {}), false, "unobserved is unmet");
  assert.equal(check(criterion, { areas: { [key]: { inspected: 8, verified: 7 } } }), false);
  assert.equal(check(criterion, { areas: { [key]: { inspected: 8, verified: 8 } } }), true);
});

function ctxWith(blocks: Record<string, string>, extra: Partial<ToolContext> = {}): ToolContext {
  return {
    bot: {
      game: { dimension: "overworld" },
      entity: { position: new Vec3(0.5, 64, 0.5) },
      players: { Corey: { entity: { position: new Vec3(20.5, 64, 20.5), yaw: 0 } } },
      blockAt: (at: Vec3) => {
        const name = blocks[`${at.x},${at.y},${at.z}`];
        return name === undefined ? { name: "air", position: at } : { name, position: at };
      },
    },
    state: { worldId: 1, home: { x: 0, y: 64, z: 0, dimension: "overworld" } },
    config: { agent: { owner: "Corey" }, server: { world_key: "test" } },
    ...extra,
  } as unknown as ToolContext;
}

test("chest 'owner' freezes the chest nearest the owner; no chest nearby is refused", () => {
  const ctx = ctxWith({ "22,64,21": "chest", "25,64,20": "chest" });
  const resolved = resolveCriterion({ kind: "chest_contains", item: "minecraft:iron_ingot", min: 32, chest: "owner" }, ctx);
  assert.deepEqual(resolved, { kind: "chest_contains", item: "iron_ingot", min: 32, chest: { x: 22, y: 64, z: 21, dimension: "overworld" } });
  const none = resolveCriterion({ kind: "chest_contains", item: "iron_ingot", min: 1, chest: "owner" }, ctxWith({}));
  assert.match(String(none), /no chest within 5 blocks of Corey/);
});

test("area_cleared freezes the clear_area box from its anchor", () => {
  const resolved = resolveCriterion({ kind: "area_cleared", width: 4, length: 4, height: 3, anchor: "home" }, ctxWith({}));
  assert.ok(typeof resolved !== "string" && resolved.kind === "area_cleared");
  assert.equal(resolved.dimension, "overworld");
  assert.equal(resolved.bounds.maxX - resolved.bounds.minX + 1, 4);
  assert.equal(resolved.bounds.maxY - resolved.bounds.minY + 1, 3);
  assert.equal(resolved.bounds.minY, 64, "the box starts at the anchor's feet level, keeping the ground");
});
