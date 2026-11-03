import type { OwnerMapView } from "./owner-map.js";

/**
 * The broadcast's minimap: a coarse, Bob-centred projection of the private
 * map (owner-map.ts) that a stream viewer may see. Built by allowlist from
 * four inputs only (dimension, Bob, home, trail); chests, deaths, resources,
 * named spots, the build site, the destination and every label stay private.
 *
 * North-up, with Bob's heading as an arrow. Heading-up would spin the whole
 * map every time he turns his head while mining or fighting, which on a
 * 5-second poll reads as random jumps; north-up keeps the trail and home
 * still between polls, and the 3D view already shows where he faces.
 *
 * Every value is a small relative integer. Offsets are measured from Bob's
 * exact position first and only then divided into cells, so the grid is
 * anchored on Bob, not on world-aligned cells: crossing a world cell
 * boundary changes nothing, and the output is identical wherever in the
 * world the same scene happens (see the translation test). No scale is
 * published; a viewer learns only "a few cells that way".
 */

/** Blocks per cell. The grid must stay coarse (at least 4). */
export const MINIMAP_CELL_BLOCKS = 4;
/** Cells from Bob to the rim: 48 blocks. */
export const MINIMAP_RADIUS = 12;
/** 16 compass points, 0 = north, clockwise (4 = east, 8 = south, 12 = west). */
export const MINIMAP_BEARINGS = 16;
const TRAIL_CELLS = 64;

/** Cell offset from Bob: +x is east, +z is south (screen down on a north-up map). */
export type MinimapCell = [dx: number, dz: number];
export interface PublicMinimap {
  dimension: "overworld" | "nether" | "end" | null;
  /** Cells from the centre to the rim; a constant. */
  radius: number;
  /** Where Bob faces, as a compass point (0-15). */
  heading: number;
  /** Recently walked cells, oldest first, ending at Bob ([0, 0]); only the newest stretch inside the rim. */
  trail: readonly MinimapCell[];
  /** Home inside the rim as a cell, beyond it as a compass point on the rim, or null (none in this dimension). */
  home: { at: MinimapCell } | { bearing: number } | null;
}

export type MinimapSource = Pick<OwnerMapView, "dimension" | "bob" | "home" | "trail">;

const DIMENSIONS = new Map<string, PublicMinimap["dimension"]>([
  ["overworld", "overworld"], ["the_nether", "nether"], ["nether", "nether"], ["the_end", "end"], ["end", "end"],
]);

const finite = (...values: unknown[]): boolean => values.every((value) => typeof value === "number" && Number.isFinite(value));
// `|| 0` turns -0 into 0 so the JSON never says "-0".
const toCell = (blocks: number): number => Math.round(blocks / MINIMAP_CELL_BLOCKS) || 0;
const inside = ([dx, dz]: MinimapCell): boolean => dx * dx + dz * dz <= MINIMAP_RADIUS * MINIMAP_RADIUS;
/** Compass point of a direction given as east and south components. */
const compass = (east: number, south: number): number => {
  const turns = Math.atan2(east, -south) / (2 * Math.PI);
  return (Math.round(turns * MINIMAP_BEARINGS) % MINIMAP_BEARINGS + MINIMAP_BEARINGS) % MINIMAP_BEARINGS;
};

/** The public minimap, or null while Bob isn't in the world. */
export function publicMinimap(view: MinimapSource): PublicMinimap | null {
  const bob = view.bob;
  if (bob === null || !finite(bob.x, bob.z)) return null;
  const relative = (x: number, z: number): MinimapCell => [toCell(x - bob.x), toCell(z - bob.z)];

  // Newest first until the trail leaves the rim; older wanderings are dropped
  // rather than drawn as a line jumping back in from outside.
  const trail: MinimapCell[] = [[0, 0]];
  for (let index = view.trail.length - 1; index >= 0 && trail.length < TRAIL_CELLS; index--) {
    const point = view.trail[index];
    if (point === undefined || !finite(point[0], point[1])) break;
    const cell = relative(point[0], point[1]);
    if (!inside(cell)) break;
    const last = trail[trail.length - 1]!;
    if (cell[0] !== last[0] || cell[1] !== last[1]) trail.push(cell);
  }
  trail.reverse();

  let home: PublicMinimap["home"] = null;
  if (view.home !== null && finite(view.home.x, view.home.z)) {
    const cell = relative(view.home.x, view.home.z);
    home = inside(cell) ? { at: cell } : { bearing: compass(view.home.x - bob.x, view.home.z - bob.z) };
  }

  // Mineflayer yaw 0 faces north (-z) and grows toward the west: facing is (-sin, -cos).
  const heading = finite(bob.yaw) ? compass(-Math.sin(bob.yaw), -Math.cos(bob.yaw)) : 0;
  const dimension = view.dimension === null ? null : DIMENSIONS.get(view.dimension.replace(/^minecraft:/, "")) ?? null;
  return { dimension, radius: MINIMAP_RADIUS, heading, trail, home };
}

/**
 * Shares one projection between all viewers for `ttlMs`, so polling can't
 * drive the cost of reading the map. A null (Bob offline) is cached too; a
 * failure is not.
 */
export function cachedPublicMinimap(
  source: () => MinimapSource | Promise<MinimapSource>,
  ttlMs = 2000,
  now: () => number = Date.now,
): () => Promise<PublicMinimap | null> {
  let cached: { at: number; value: Promise<PublicMinimap | null> } | null = null;
  return () => {
    if (cached !== null && now() - cached.at < ttlMs) return cached.value;
    const value = Promise.resolve().then(source).then(publicMinimap);
    cached = { at: now(), value };
    value.catch(() => { if (cached?.value === value) cached = null; });
    return value;
  };
}
