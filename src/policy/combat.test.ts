import assert from "node:assert/strict";
import { test } from "node:test";
import { MinecraftConfigSchema, type MinecraftConfig } from "../config/schema.js";
import { ANIMAL_MOB_NAMES, attackTargetAllowed, HOSTILE_MOB_NAMES, isHumanTarget, PVP_ERROR_CODE, targetNameIsHuman } from "./combat.js";

function config(allowPvp = false): MinecraftConfig {
  return MinecraftConfigSchema.parse({
    server: { host: "h", port: 25565, username: "CobbleBob" },
    home: { x: 0, y: 0, z: 0 },
    behavior: { allow_pvp: allowPvp },
  });
}

test("spec 25: attacks on human players are rejected with PVP_FORBIDDEN", () => {
  const denied = attackTargetAllowed("player", config());
  assert.equal(denied.allowed, false);
  assert.equal(denied.code, PVP_ERROR_CODE);
  assert.equal(isHumanTarget("player"), true);
  assert.equal(isHumanTarget("mob"), false);
  assert.equal(targetNameIsHuman("player"), true);
  assert.equal(targetNameIsHuman("Corey"), false);
});

test("spec 25: mob targets are always legal to the combat policy", () => {
  for (const name of [...ANIMAL_MOB_NAMES, ...HOSTILE_MOB_NAMES]) {
    assert.equal(attackTargetAllowed("mob", config()).allowed, true, name);
  }
});

test("spec 25: allow_pvp: true lifts the human veto (explicit PvP environments)", () => {
  assert.equal(attackTargetAllowed("player", config(true)).allowed, true);
});

test("spec 25: the hunt schema can never contain a human target", () => {
  // The tool enums are built from the animal/hostile sets only.
  assert.equal(ANIMAL_MOB_NAMES.has("player"), false);
  assert.equal(HOSTILE_MOB_NAMES.has("player"), false);
  const union = new Set([...ANIMAL_MOB_NAMES, ...HOSTILE_MOB_NAMES]);
  assert.equal(union.has("player"), false);
});