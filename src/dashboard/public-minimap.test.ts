import assert from "node:assert/strict";
import test from "node:test";
import type { MapPoint, OwnerMapView } from "./owner-map.js";
import { cachedPublicMinimap, MINIMAP_BEARINGS, MINIMAP_CELL_BLOCKS, MINIMAP_RADIUS, publicMinimap, type PublicMinimap } from "./public-minimap.js";
import { minimapShapes } from "./public/broadcast-minimap.mjs";

const BOB = { x: 123457.3, y: 71.0, z: -98765.8 };
const SECRET_LABEL = "Barnabyisbig's diamond stash at play.example.net";

/** A full private map far from the origin, every private layer populated with hostile labels. */
function farView(dx = 0, dz = 0, overrides: Partial<OwnerMapView> = {}): OwnerMapView {
  const x = BOB.x + dx, z = BOB.z + dz;
  const marker = (ox: number, oz: number, label = SECRET_LABEL) => ({ x: x + ox, y: 64, z: z + oz, label, detail: "x=123457 z=-98765", at: "2026-11-02T00:00:00.000Z" });
  // A walk that starts far outside the rim, comes in from the west and ends beside Bob.
  const trail: MapPoint[] = [];
  for (let step = 0; step <= 80; step++) trail.push([x - 200 + step * 2.5 + (step % 3) * 0.7 + 0.13, z + 13.3 - step * 0.17]);
  return {
    dimension: "overworld",
    bob: { ...BOB, x, z, yaw: Math.PI / 2 },
    home: marker(17.6, -9.1, "Home"),
    locations: [marker(5, 5), marker(-30001, 7)],
    resources: [{ ...marker(3, -3), depleted: false, exposure: "surface" }],
    chests: [marker(1, 1)],
    deaths: [{ ...marker(-2, 9), recovered: false }],
    build: marker(8, 8),
    destination: marker(40, -40),
    path: [[x + 1, z + 1], [x + 40, z - 40]],
    trail,
    ...overrides,
  };
}

const ALLOWED_KEYS = new Set(["dimension", "radius", "heading", "trail", "home", "at", "bearing"]);
/** Every number is a small integer, every key allowlisted, every string a known dimension. */
function assertCoarse(minimap: PublicMinimap | null): void {
  assert.notEqual(minimap, null);
  const json = JSON.stringify(minimap);
  // No absolute coordinate, or any piece of one, in the text at all.
  assert.doesNotMatch(json, /\d{3,}|\./, json);
  for (const piece of ["123", "457", "987", "765", "30001", "Barnaby", "example", "stash", "Home", "Death", "chest"]) assert.equal(json.includes(piece), false, piece);
  const walk = (value: unknown, key: string): void => {
    if (typeof value === "number") {
      assert(Number.isInteger(value), `${key}=${value} is not an integer`);
      assert(Math.abs(value) <= Math.max(MINIMAP_RADIUS, MINIMAP_BEARINGS - 1), `${key}=${value} is too large`);
    } else if (typeof value === "string") {
      assert(["overworld", "nether", "end"].includes(value), `${key}=${value}`);
    } else if (Array.isArray(value)) {
      value.forEach((item) => walk(item, key));
    } else if (value !== null && typeof value === "object") {
      for (const [name, item] of Object.entries(value)) { assert(ALLOWED_KEYS.has(name), `key ${name}`); walk(item, name); }
    } else {
      assert(value === null, `${key} has type ${typeof value}`);
    }
  };
  walk(JSON.parse(json), "root");
  const parsed = minimap!;
  for (const [dx, dz] of [...parsed.trail, ...(parsed.home !== null && "at" in parsed.home ? [parsed.home.at] : [])]) {
    assert(dx * dx + dz * dz <= MINIMAP_RADIUS * MINIMAP_RADIUS, `[${dx}, ${dz}] is outside the rim`);
  }
}

test("the minimap far from the origin holds only small relative integers on allowlisted keys", () => {
  const minimap = publicMinimap(farView());
  assertCoarse(minimap);
  // Home 17.6 E / 9.1 N of Bob: cells of four blocks, measured from Bob.
  assert.deepEqual(minimap?.home, { at: [4, -2] });
  // Yaw π/2 faces west: compass point 12.
  assert.equal(minimap?.heading, 12);
  assert.equal(minimap?.dimension, "overworld");
  assert.equal(minimap?.radius, MINIMAP_RADIUS);
  // The trail is the newest stretch inside the rim, oldest first, ending at Bob, without repeats.
  assert.deepEqual(minimap?.trail.at(-1), [0, 0]);
  assert(minimap!.trail.length > 3 && minimap!.trail.length <= 64);
  minimap!.trail.slice(1).forEach(([x, z], index) => assert.notDeepEqual([x, z], minimap!.trail[index]));
});

test("the same scene anywhere in the world gives the same minimap, so cell phase reveals nothing", () => {
  const reference = JSON.stringify(publicMinimap(farView()));
  // Odd, negative and fractional shifts, including ones that cross a world-aligned 4-block cell boundary.
  for (const [dx, dz] of [[1, 0], [0, -1], [2, 3], [-3, -2], [0.5, -0.25], [-123457.3, 98765.8], [4_000_001.7, -2_999_999.1], [-1, 1.9]] as const) {
    assert.equal(JSON.stringify(publicMinimap(farView(dx, dz))), reference, `shift ${dx}, ${dz}`);
  }
});

test("a far home becomes a compass point on the rim, never a distance", () => {
  for (const [hx, hz, bearing] of [[0, -5000, 0], [5000, 0, 4], [0, 5000, 8], [-5000, 0, 12], [300, -300, 2], [-61, 47, 10]] as const) {
    const minimap = publicMinimap(farView(0, 0, { home: { x: BOB.x + hx, y: 64, z: BOB.z + hz, label: "Home" } }));
    assertCoarse(minimap);
    assert.deepEqual(minimap?.home, { bearing }, `${hx}, ${hz}`);
  }
  // Just past the rim is already a bearing; just inside is a cell.
  const edge = MINIMAP_RADIUS * MINIMAP_CELL_BLOCKS;
  assert.deepEqual(publicMinimap(farView(0, 0, { home: { x: BOB.x + edge + 3, y: 64, z: BOB.z, label: "Home" } }))?.home, { bearing: 4 });
  assert.deepEqual(publicMinimap(farView(0, 0, { home: { x: BOB.x + edge - 1, y: 64, z: BOB.z, label: "Home" } }))?.home, { at: [12, 0] });
  assert.equal(publicMinimap(farView(0, 0, { home: null }))?.home, null);
});

test("headings cover the compass from mineflayer yaw", () => {
  for (const [yaw, heading] of [[0, 0], [Math.PI / 2, 12], [Math.PI, 8], [-Math.PI / 2, 4], [3 * Math.PI / 2, 4], [Math.PI / 8, 15], [Number.NaN, 0], [40 * Math.PI, 0]] as const) {
    assert.equal(publicMinimap(farView(0, 0, { bob: { ...BOB, yaw } }))?.heading, heading, `yaw ${yaw}`);
  }
});

test("dimension is overworld, nether, end or null; Bob offline is null", () => {
  for (const [dimension, expected] of [["overworld", "overworld"], ["minecraft:the_nether", "nether"], ["the_nether", "nether"], ["the_end", "end"], ["custom:secret_123457", null], ["play.example.net", null], ["constructor", null], ["__proto__", null], [null, null]] as const) {
    const minimap = publicMinimap(farView(0, 0, { dimension }));
    assertCoarse(minimap);
    assert.equal(minimap?.dimension, expected, String(dimension));
  }
  assert.equal(publicMinimap(farView(0, 0, { bob: null })), null);
  assert.equal(publicMinimap(farView(0, 0, { bob: { x: Number.NaN, y: 0, z: 0, yaw: 0 } })), null);
});

test("a trail that wandered off and back, or holds junk, keeps only the newest stretch inside the rim", () => {
  const near: MapPoint[] = [[BOB.x - 8, BOB.z], [BOB.x - 4, BOB.z], [BOB.x, BOB.z]];
  const wandered = publicMinimap(farView(0, 0, { trail: [[BOB.x + 2, BOB.z + 2], [BOB.x + 9000, BOB.z], ...near] }));
  assertCoarse(wandered);
  assert.deepEqual(wandered?.trail, [[-2, 0], [-1, 0], [0, 0]]);
  const junk = publicMinimap(farView(0, 0, { trail: [[BOB.x - 40, BOB.z], [Number.NaN, 5], ...near] }));
  assert.deepEqual(junk?.trail, [[-2, 0], [-1, 0], [0, 0]]);
  assert.deepEqual(publicMinimap(farView(0, 0, { trail: [] }))?.trail, [[0, 0]]);
  // A long walk inside the rim is capped.
  const loops: MapPoint[] = Array.from({ length: 600 }, (_, index) => [BOB.x + 30 * Math.cos(index / 5), BOB.z + 30 * Math.sin(index / 5)]);
  const capped = publicMinimap(farView(0, 0, { trail: loops }));
  assertCoarse(capped);
  assert.equal(capped?.trail.length, 64);
});

test("the cached minimap shares one projection per window and retries after a failure", async () => {
  let clock = 0, reads = 0, fail = false;
  const cached = cachedPublicMinimap(() => { reads++; if (fail) throw new Error("db"); return farView(); }, 2000, () => clock);
  await cached(); await cached();
  clock = 1999; await cached();
  assert.equal(reads, 1);
  clock = 2000; fail = true;
  await assert.rejects(cached());
  fail = false;
  assertCoarse(await cached());
  assert.equal(reads, 3);
});

test("the broadcast client clamps what it draws and rejects malformed answers", () => {
  const shapes = minimapShapes(publicMinimap(farView()));
  assert.equal(shapes?.heading, 270);
  assert.deepEqual(shapes?.home, { x: 4, y: -2 });
  assert.match(shapes?.trail ?? "", /^(-?\d+,-?\d+ )+0,0$/);
  assert.deepEqual(minimapShapes({ radius: 12, heading: 4, trail: [[0, 0]], home: { bearing: 6 } }), { radius: 12, heading: 90, trail: null, home: { rim: 135 } });
  // Out-of-rim, fractional or huge values are dropped, never drawn.
  assert.deepEqual(minimapShapes({ radius: 12, heading: 0, trail: [[123457, -98765], [1.5, 0], [12, 1], [3, 4], [0, 0]], home: { at: [99, 0] } }), { radius: 12, heading: 0, trail: "3,4 0,0", home: null });
  for (const bad of [null, "x", {}, { radius: 12, heading: 16, trail: [] }, { radius: 400, heading: 0, trail: [] }, { radius: 12, heading: 0, trail: "0,0" }]) assert.equal(minimapShapes(bad), null, JSON.stringify(bad));
});
