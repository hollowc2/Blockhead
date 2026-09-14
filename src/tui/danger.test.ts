import assert from "node:assert/strict";
import { test } from "node:test";
import { computeDangerScore, DANGER_HOSTILE_HORIZON } from "./danger.js";

const BASE = { health: 20, hunger: 20, night: false, nearestHostileMeters: null, expeditionTier: null };

test("a healthy bot in daylight with no threats scores zero", () => {
  assert.equal(computeDangerScore(BASE), 0);
});

test("night, hunger, and low health each add their flat terms", () => {
  const night = computeDangerScore({ ...BASE, night: true });
  assert.ok(night > 0.14 && night < 0.16);
  const hungry = computeDangerScore({ ...BASE, hunger: 4 });
  assert.ok(hungry > 0.14 && hungry < 0.16);
  // health 8/20: half of the 0.30 health margin term.
  const hurt = computeDangerScore({ ...BASE, health: 8 });
  assert.ok(hurt > 0.14 && hurt < 0.16);
});

test("a hostile at zero distance adds the full hostile term, tapering to the horizon", () => {
  const close = computeDangerScore({ ...BASE, nearestHostileMeters: 0 });
  const justOutside = computeDangerScore({ ...BASE, nearestHostileMeters: DANGER_HOSTILE_HORIZON });
  const far = computeDangerScore({ ...BASE, nearestHostileMeters: 200 });
  assert.ok(close > 0.39 && close < 0.41);
  assert.equal(justOutside, 0);
  assert.equal(far, 0);
});

test("expedition tiers add their band penalty, near adds nothing", () => {
  const expedition = computeDangerScore({ ...BASE, expeditionTier: "expedition" });
  const deep = computeDangerScore({ ...BASE, expeditionTier: "deep" });
  assert.ok(expedition > 0.09 && expedition < 0.11);
  assert.ok(deep > 0.19 && deep < 0.21);
  assert.equal(computeDangerScore({ ...BASE, expeditionTier: "near" }), 0);
});

test("the score clamps at 1 when the world stacks up", () => {
  const worst = computeDangerScore({
    ...BASE,
    health: 0,
    hunger: 0,
    night: true,
    nearestHostileMeters: 0,
    expeditionTier: "deep",
  });
  assert.equal(worst, 1);
});