import assert from "node:assert/strict";
import { test } from "node:test";
import {
  belowHealthRetreat,
  checkDimensionEntry,
  checkDigStraightDown,
  checkHealthRetreat,
  DEFAULT_ALLOWED_DIMENSIONS,
  HEALTH_RETREAT_THRESHOLD,
  isStraightDownTarget,
} from "./safety.js";
import { MinecraftConfigSchema, type MinecraftConfig } from "../config/schema.js";

function configWith(policy: Record<string, unknown>): MinecraftConfig {
  return MinecraftConfigSchema.parse({
    server: { host: "h", port: 25565, username: "CobbleBob", world_key: "test-world" },
    home: { x: 0, y: 0, z: 0 },
    policy,
  });
}

/** Minimal valid config used by the dimension tests. */
function rawConfig(): MinecraftConfig {
  return MinecraftConfigSchema.parse({
    server: { host: "h", port: 25565, username: "CobbleBob", world_key: "test-world" },
    home: { x: 0, y: 0, z: 0 },
  });
}

test("isStraightDownTarget detects the block directly beneath the feet", () => {
  const self = { x: 10.2, y: 64.2, z: -8.9 };
  assert.equal(isStraightDownTarget({ x: 10, y: 63, z: -9 }, self), true);
  // One column off horizontally is not straight down.
  assert.equal(isStraightDownTarget({ x: 11, y: 63, z: -9 }, self), false);
  // Two blocks down is no longer the underfoot block.
  assert.equal(isStraightDownTarget({ x: 10, y: 62, z: -9 }, self), false);
});

test("spec 34: never dig straight down blindly", () => {
  const self = { x: 0, y: 64, z: 0 };
  const denied = checkDigStraightDown({ x: 0, y: 63, z: 0 }, self);
  assert.equal(denied.allowed, false);
  assert.equal(denied.violation.code, "DIG_STRAIGHT_DOWN");
  const allowed = checkDigStraightDown({ x: 1, y: 63, z: 0 }, self);
  assert.equal(allowed.allowed, true);
});

test("spec 34: dangerous work retreats below the health floor", () => {
  assert.equal(belowHealthRetreat(8, HEALTH_RETREAT_THRESHOLD), true);
  assert.equal(belowHealthRetreat(7.5, HEALTH_RETREAT_THRESHOLD), true);
  assert.equal(belowHealthRetreat(9, HEALTH_RETREAT_THRESHOLD), false);
  const denied = checkHealthRetreat(5);
  assert.equal(denied.allowed, false);
  assert.equal(denied.violation.code, "DANGER_TOO_HIGH");
  assert.equal(checkHealthRetreat(12).allowed, true);
});

test("spec 34: unlisted dimensions are refused unless explicitly allowed", () => {
  const config = configWith({});
  assert.deepEqual(config.policy?.allowed_dimensions ?? [], DEFAULT_ALLOWED_DIMENSIONS);
  assert.equal(checkDimensionEntry("overworld", config).allowed, true);
  assert.equal(checkDimensionEntry("minecraft:overworld", config).allowed, true);
  const denied = checkDimensionEntry("nether", config);
  assert.equal(denied.allowed, false);
  assert.equal(denied.violation.code, "DIMENSION_FORBIDDEN");
});

test("spec 34: explicit dimension policy permits listed dimensions", () => {
  const config = configWith({ allowed_dimensions: ["overworld", "nether"] });
  assert.equal(checkDimensionEntry("nether", config).allowed, true);
  assert.equal(checkDimensionEntry("end", config).allowed, false);
});

test("lavaAvoidanceRadius falls back to the default without config", () => {
  const config = configWith({});
  assert.equal(config.policy?.lava_avoidance_radius, 4);
});
