import assert from "node:assert/strict";
import { test } from "node:test";
import { DestructiveAuthorizationRegistry } from "./destructive-authorization.js";
import { revalidateAction } from "./action-boundary.js";
import { createProtectedRegion } from "../minecraft/protection.js";
import { MinecraftConfigSchema } from "../config/schema.js";

const now = new Date("2026-01-01T00:00:00.000Z");
const config = MinecraftConfigSchema.parse({ server: { host: "h", port: 25565, username: "bot", world_key: "world" }, home: { x: 0, y: 64, z: 0 } });
const region = createProtectedRegion({ name: "home", dimension: "overworld", center: { x: 0, z: 0 }, sizeX: 20, sizeZ: 20 });
const botShape = { entity: { position: { x: 0, y: 64, z: 0 } }, health: 20, findBlocks: () => [] };
const bot = botShape as never;

function grant(state?: "active" | "dormant" | "revoked") {
  const registry = new DestructiveAuthorizationRegistry();
  registry.issue({ projectId: "project-1", taskId: "task-1", worldId: 7, dimension: "minecraft:overworld", geometryHash: "hash", geometry: { bounds: { minX: -2, maxX: 2, minY: 60, maxY: 64, minZ: -2, maxZ: 2 } }, allowedActions: ["dig"], issuedAt: "2025-12-31T23:00:00.000Z", expiresAt: "2026-01-01T01:00:00.000Z" });
  if (state !== undefined) registry.setState("task-1", state);
  return { registry, context: registry.contextFor("task-1", "project-1", 7, "overworld", now) };
}

test("bounded active authorization permits an in-geometry protected dig", () => {
  const { context } = grant();
  assert.ok(context);
  const result = revalidateAction(bot, "dig", { x: 0, y: 64, z: 0 }, config, region, { blockName: "stone", authorization: context, taskId: "task-1", projectId: "project-1", worldId: 7, dimension: "overworld", now });
  assert.equal(result.allowed, true);
});

test("a protected dig one block outside authorized geometry is refused", () => {
  const { context } = grant();
  assert.ok(context);
  const result = revalidateAction(bot, "dig", { x: 3, y: 64, z: 0 }, config, region, { blockName: "stone", authorization: context, taskId: "task-1", projectId: "project-1", worldId: 7, dimension: "overworld", now });
  assert.equal(result.allowed, false);
});

test("wrong task, project, world, dimension, dormant, revoked, and expired grants fail", () => {
  const cases = [
    { taskId: "other", projectId: "project-1", worldId: 7, dimension: "overworld" },
    { taskId: "task-1", projectId: "other", worldId: 7, dimension: "overworld" },
    { taskId: "task-1", projectId: "project-1", worldId: 8, dimension: "overworld" },
    { taskId: "task-1", projectId: "project-1", worldId: 7, dimension: "nether" },
  ];
  for (const entry of cases) {
    const { context } = grant();
    const result = revalidateAction(bot, "dig", { x: 0, y: 64, z: 0 }, config, region, { blockName: "stone", authorization: context ?? undefined, ...entry, now });
    assert.equal(result.allowed, false);
  }
  for (const state of ["dormant", "revoked"] as const) {
    const { context } = grant(state);
    assert.equal(context, null);
  }
  const { registry, context } = grant();
  assert.ok(context);
  const expired = revalidateAction(bot, "dig", { x: 0, y: 64, z: 0 }, config, region, { blockName: "stone", authorization: context, taskId: "task-1", projectId: "project-1", worldId: 7, dimension: "overworld", now: new Date("2026-01-01T02:00:00.000Z") });
  assert.equal(expired.allowed, false);
  assert.equal(registry.revoke("task-1"), true);
});

test("fixtures remain protected even with a valid grant and safety vetoes win", () => {
  const { context } = grant();
  assert.ok(context);
  const chest = revalidateAction(bot, "dig", { x: 0, y: 64, z: 0 }, config, region, { blockName: "chest", authorization: context, taskId: "task-1", projectId: "project-1", worldId: 7, dimension: "overworld", now });
  assert.equal(chest.allowed, false);
  const unhealthyBot = { ...botShape, health: 4 } as never;
  const unsafe = revalidateAction(unhealthyBot, "dig", { x: 0, y: 64, z: 0 }, config, region, { blockName: "stone", authorization: context, taskId: "task-1", projectId: "project-1", worldId: 7, dimension: "overworld", now });
  assert.equal(unsafe.allowed, false);
});
