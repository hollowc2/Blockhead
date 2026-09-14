/**
 * Protected regions and the home protection policy (spec section 8).
 *
 * Deterministic geometry + policy checks. Enforcement happens in skills/tools;
 * this module only answers "where is a region" and "is this action allowed".
 */

/** Axis-aligned block bounds. A null min/max Y means vertically unbounded. */
export interface RegionBounds {
  minX: number;
  maxX: number;
  minY?: number;
  maxY?: number;
  minZ: number;
  maxZ: number;
}

export interface ProtectedRegion {
  name: string;
  dimension: string;
  bounds: RegionBounds;
  policy: ProtectionPolicy;
}

/** Point to test against a region. `y` is optional for 2D (X/Z) checks. */
export interface RegionPoint {
  x: number;
  y?: number;
  z: number;
}

/**
 * Declarative policy flags (JSON-serializable for `policy_json`).
 * `true` allows the action inside the region; outside a region everything is free.
 */
export interface ProtectionPolicy {
  /** Breaking structural / build blocks. */
  breakStructure: boolean;
  /** Destructive mining (ores, terrain). */
  mine: boolean;
  /** Placing blocks in general (permitted infrastructure, lighting, paths). */
  place: boolean;
  /** Placing new storage containers. */
  placeStorage: boolean;
  /** Fire placement (torches, campfires). */
  fire: boolean;
  /** Lava placement. */
  lava: boolean;
  /** Unrequested demolition / rebuilding player structures. */
  demolish: boolean;
  /** Opening containers (chests, barrels, shulker boxes). */
  useContainers: boolean;
  /** Doors, trapdoors, gates. */
  useDoors: boolean;
  /** Beds. */
  useBeds: boolean;
  /** Crafting tables. */
  useCraftingTables: boolean;
  /** Furnaces, smokers, blast furnaces. */
  useFurnaces: boolean;
}

/** Default home protection policy (spec 8.2). */
export const DEFAULT_HOME_POLICY: ProtectionPolicy = {
  breakStructure: false,
  mine: false,
  place: true,
  placeStorage: true,
  fire: false,
  lava: false,
  demolish: false,
  useContainers: true,
  useDoors: true,
  useBeds: true,
  useCraftingTables: true,
  useFurnaces: true,
};

/** The default 100 x 100 region name, matching the protected home zone. */
export const DEFAULT_HOME_REGION_NAME = "home";

export interface RegionOptions {
  name: string;
  dimension: string;
  center: { x: number; z: number };
  /** Full region width along X, in blocks. */
  sizeX: number;
  /** Full region depth along Z, in blocks. */
  sizeZ: number;
  minY?: number;
  maxY?: number;
  policy?: ProtectionPolicy;
}

/**
 * Build a region centered on `center` (block coordinates) so the region covers
 * exactly `sizeX` x `sizeZ` blocks, e.g. 100 x 100 centered on home.
 */
export function createProtectedRegion(options: RegionOptions): ProtectedRegion {
  if (!Number.isInteger(options.sizeX) || options.sizeX <= 0 || !Number.isInteger(options.sizeZ) || options.sizeZ <= 0) {
    throw new Error(`region size must be positive integers, got ${options.sizeX}x${options.sizeZ}`);
  }
  const halfX = Math.floor(options.sizeX / 2);
  const halfZ = Math.floor(options.sizeZ / 2);
  return {
    name: options.name,
    dimension: options.dimension,
    bounds: {
      minX: options.center.x - halfX,
      maxX: options.center.x - halfX + options.sizeX - 1,
      minY: options.minY,
      maxY: options.maxY,
      minZ: options.center.z - halfZ,
      maxZ: options.center.z - halfZ + options.sizeZ - 1,
    },
    policy: options.policy ?? DEFAULT_HOME_POLICY,
  };
}

/** True when `point` (optionally vertical) falls inside the region's bounds. */
export function regionContains(region: ProtectedRegion, point: RegionPoint): boolean {
  const { bounds } = region;
  if (point.x < bounds.minX || point.x > bounds.maxX || point.z < bounds.minZ || point.z > bounds.maxZ) {
    return false;
  }
  if (
    point.y !== undefined &&
    bounds.minY !== undefined &&
    bounds.maxY !== undefined &&
    (point.y < bounds.minY || point.y > bounds.maxY)
  ) {
    return false;
  }
  return true;
}

/**
 * Whether an action may be performed at `point`. Outside any protected region
 * everything is allowed (spec 8.2); inside, the region policy decides.
 */
export function canPerform(
  action: keyof ProtectionPolicy,
  region: ProtectedRegion | null,
  point: RegionPoint,
): boolean {
  if (!region || !regionContains(region, point)) return true;
  return region.policy[action];
}

/** Strip the "minecraft:" namespace from dimension ids for comparisons/storage. */
export function normalizeDimension(dimension: string): string {
  return dimension.replace(/^minecraft:/, "");
}