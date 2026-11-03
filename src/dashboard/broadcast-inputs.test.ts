import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BroadcastTracker, readServerPlayerNames } from "./broadcast-inputs.js";

const MINUTE = 60_000;

test("the vitals ring keeps one sample a minute for the last hour, oldest first", () => {
  const tracker = new BroadcastTracker();
  for (let minute = 0; minute < 90; minute++) tracker.sampleVitals(minute * MINUTE, minute % 20, Number.NaN);
  const now = 89 * MINUTE;
  const vitals = tracker.vitals(now);
  assert.equal(vitals.length, 60);
  assert.deepEqual(vitals[0], { at: new Date(30 * MINUTE).toISOString(), health: 10, hunger: null });
  assert.deepEqual(vitals.at(-1), { at: new Date(89 * MINUTE).toISOString(), health: 9, hunger: null });
  // A stalled sampler leaves no stale history behind.
  assert.equal(tracker.vitals(now + 30 * MINUTE).length, 30);
  assert.equal(tracker.vitals(now + 61 * MINUTE).length, 0);
});

test("disconnected minutes are recorded as gaps", () => {
  const tracker = new BroadcastTracker();
  tracker.sampleVitals(0, 20, 18);
  tracker.sampleVitals(MINUTE, null, null);
  assert.deepEqual(tracker.vitals(MINUTE).map(({ health, hunger }) => [health, hunger]), [[20, 18], [null, null]]);
});

test("seen names are deduplicated case-insensitively and survive the player leaving", () => {
  const tracker = new BroadcastTracker();
  tracker.noteNames(["Barnabyisbig", " Steve ", "", 42, null, "x".repeat(65)]);
  tracker.noteNames(["barnabyisbig", "Alex"]);
  assert.deepEqual(tracker.names().sort(), ["Alex", "Steve", "barnabyisbig"]);
});

test("server player lists are read by name; missing and malformed files are skipped", () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-names-"));
  writeFileSync(join(dir, "whitelist.json"), JSON.stringify([{ uuid: "u1", name: "Barnabyisbig" }, { uuid: "u2" }]));
  writeFileSync(join(dir, "ops.json"), "{not json");
  writeFileSync(join(dir, "usercache.json"), JSON.stringify([{ name: "Visitor", uuid: "u3", expiresOn: "2026-12-01" }, null, "bare"]));
  assert.deepEqual(readServerPlayerNames(dir), ["Barnabyisbig", "Visitor"]);
  assert.deepEqual(readServerPlayerNames(join(dir, "missing")), []);
  assert.deepEqual(readServerPlayerNames(null), []);
});
