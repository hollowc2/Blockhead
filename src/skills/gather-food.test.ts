import assert from "node:assert/strict";
import { test } from "node:test";
import { patrolHeadingDeg, patrolWaypoint } from "./gather-food.js";

/**
 * Patrol sweep geometry (Phase 7.2): an empty hunt radius walks the bot to
 * the ring edge on a rotating heading so the doubled next radius scans new
 * ground, and repeated hunts fan out around home instead of re-scanning the
 * same wedge. Pure helpers only — no bot, no network.
 */

test("patrolHeadingDeg rotates through 8 headings and wraps both ways", () => {
  assert.deepEqual([0, 1, 7, 8, 16, -1].map(patrolHeadingDeg), [0, 45, 315, 0, 0, 315]);
});

test("patrolWaypoint places ring-edge points from home on each heading", () => {
  // Heading 0: straight +z.
  assert.deepEqual(patrolWaypoint(0, 0, 96, 0), { x: 0, z: 96 });
  // Heading 90: straight +x.
  assert.deepEqual(patrolWaypoint(0, 0, 96, 90), { x: 96, z: 0 });
  // Heading 270: straight -x.
  assert.deepEqual(patrolWaypoint(10, -5, 48, 270), { x: -38, z: -5 });
  // Heading 45: both legs round from 96 * sin(45deg) ~= 67.88.
  assert.deepEqual(patrolWaypoint(0, 0, 96, 45), { x: 68, z: 68 });
});