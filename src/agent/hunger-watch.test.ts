import assert from "node:assert/strict";
import { test } from "node:test";
import { hungerEmergency, HungerWatch } from "./hunger-watch.js";

test("an empty stomach with nothing to eat triggers a food run; food in hand or a live run does not", () => {
  const base = { alive: true, hunger: 6, foodCarried: 0, foodRunLive: false, cooldownActive: false };
  assert.equal(hungerEmergency(base), true);
  assert.equal(hungerEmergency({ ...base, hunger: 15 }), false, "not hungry yet");
  assert.equal(hungerEmergency({ ...base, foodCarried: 2 }), false, "auto-eat covers it");
  assert.equal(hungerEmergency({ ...base, foodRunLive: true }), false);
  assert.equal(hungerEmergency({ ...base, cooldownActive: true }), false);
  assert.equal(hungerEmergency({ ...base, alive: false }), false);
});

test("a queued cooldown-blocked food run does not produce duplicate requests or warnings", () => {
  let issued = 0;
  let warned = 0;
  const queued: object[] = [{ workKey: "hunger-emergency", status: "blocked" }];
  const watch = new HungerWatch({
    bot: { entity: {}, health: 1, food: 0, inventory: { items: () => [] } },
    scheduler: { active: null, queued, enqueue: () => { issued += 1; }, claim: () => {} },
    logger: { warn: () => { warned += 1; } },
  } as never);
  watch.check(); watch.check();
  assert.equal(issued, 0);
  assert.equal(warned, 0);
  queued.length = 0;
  watch.check();
  assert.equal(issued, 1);
  assert.equal(warned, 1);
});

test("carried food cancels active and blocked emergency hunts instead of retrying them", () => {
  const cancelled: string[] = [];
  const watch = new HungerWatch({
    bot: { entity: {}, health: 16, food: 16, inventory: { items: () => [{ name: "bread", count: 5 }] } },
    scheduler: {
      active: { id: "active", workKey: "hunger-emergency" },
      queued: [{ id: "blocked", workKey: "hunger-emergency" }, { id: "owner", workKey: "build" }],
      cancel: (id: string) => cancelled.push(id),
      enqueue: () => assert.fail("emergency already resolved"),
    },
  } as never);
  watch.check();
  assert.deepEqual(cancelled, ["blocked", "active"]);
});
