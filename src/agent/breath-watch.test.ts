import assert from "node:assert/strict";
import { test } from "node:test";
import { LOW_OXYGEN, shouldSurface } from "./breath-watch.js";

const base = { alive: true, oxygen: 20, headUnderwater: true, pathfinderMoving: false, surfacing: false };

test("an idle bot low on air with its head underwater swims up until the bar refills", () => {
  // 2026-10-04 19:00: idle between tasks, it sank from y=59 to y=49 and drowned.
  assert.equal(shouldSurface(base), false, "full air: no need yet");
  assert.equal(shouldSurface({ ...base, oxygen: LOW_OXYGEN }), true);
  assert.equal(shouldSurface({ ...base, oxygen: 17, surfacing: true }), true, "keeps going until recovered");
  assert.equal(shouldSurface({ ...base, oxygen: 19, surfacing: true }), false);
});

test("the breath watch leaves the controls alone while moving, on land or dead", () => {
  assert.equal(shouldSurface({ ...base, oxygen: 5, pathfinderMoving: true }), false);
  assert.equal(shouldSurface({ ...base, oxygen: 5, headUnderwater: false }), false);
  assert.equal(shouldSurface({ ...base, oxygen: 5, alive: false }), false);
});
