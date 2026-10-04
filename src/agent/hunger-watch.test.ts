import assert from "node:assert/strict";
import { test } from "node:test";
import { hungerEmergency } from "./hunger-watch.js";

test("an empty stomach with nothing to eat triggers a food run; food in hand or a live run does not", () => {
  const base = { alive: true, hunger: 6, foodCarried: 0, foodRunLive: false, cooldownActive: false };
  assert.equal(hungerEmergency(base), true);
  assert.equal(hungerEmergency({ ...base, hunger: 15 }), false, "not hungry yet");
  assert.equal(hungerEmergency({ ...base, foodCarried: 2 }), false, "auto-eat covers it");
  assert.equal(hungerEmergency({ ...base, foodRunLive: true }), false);
  assert.equal(hungerEmergency({ ...base, cooldownActive: true }), false);
  assert.equal(hungerEmergency({ ...base, alive: false }), false);
});
