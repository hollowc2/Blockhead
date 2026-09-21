import type { HomeLocation, Location } from "../minecraft/movement.js";
import { normalizeDimension } from "../minecraft/protection.js";
import type { BlockBounds, CardinalDirection } from "./schema.js";

export interface VisibleOwner {
  position: HomeLocation;
  yaw: number;
}

function integer(value: number, name: string): number {
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}

export function resolveFootprintBounds(anchor: Location, width: number, length: number, minY = anchor.y, maxY = anchor.y): BlockBounds {
  integer(anchor.x, "anchor.x"); integer(anchor.y, "anchor.y"); integer(anchor.z, "anchor.z");
  integer(width, "width"); integer(length, "length"); integer(minY, "minY"); integer(maxY, "maxY");
  if (width < 1 || length < 1 || minY > maxY) throw new Error("invalid footprint dimensions");
  const minX = anchor.x - Math.ceil(width / 2);
  const minZ = anchor.z - Math.ceil(length / 2);
  return { minX, maxX: minX + width - 1, minY, maxY, minZ, maxZ: minZ + length - 1 };
}

export function resolveExcavationBounds(anchor: Location, width: number, length: number, depth: number): BlockBounds {
  integer(anchor.y, "anchor.y"); integer(depth, "depth");
  if (depth < 1) throw new Error("depth must be positive");
  return resolveFootprintBounds(anchor, width, length, anchor.y - depth, anchor.y - 1);
}

export function snapCardinalYaw(yaw: number): CardinalDirection {
  if (!Number.isFinite(yaw)) throw new Error("owner yaw must be finite");
  const quarterTurns = Math.round(yaw / (Math.PI / 2));
  switch (((quarterTurns % 4) + 4) % 4) {
    case 0: return "south";
    case 1: return "west";
    case 2: return "north";
    default: return "east";
  }
}

export function resolveOwnerFrontAnchor(owner: VisibleOwner): HomeLocation {
  const x = Math.floor(owner.position.x);
  const y = Math.floor(owner.position.y);
  const z = Math.floor(owner.position.z);
  const direction = snapCardinalYaw(owner.yaw);
  const offset = direction === "north" ? { x: 0, z: -2 } : direction === "south" ? { x: 0, z: 2 } : direction === "east" ? { x: 2, z: 0 } : { x: -2, z: 0 };
  return { x: x + offset.x, y, z: z + offset.z, dimension: normalizeDimension(owner.position.dimension) };
}

export function resolveOwnerFrontBounds(owner: VisibleOwner, width: number, length: number, minY: number, maxY: number): BlockBounds {
  const direction = snapCardinalYaw(owner.yaw);
  const x = Math.floor(owner.position.x);
  const y = Math.floor(owner.position.y);
  const z = Math.floor(owner.position.z);
  if (direction === "north") return { minX: x - Math.ceil(width / 2), maxX: x - Math.ceil(width / 2) + width - 1, minY, maxY, minZ: z - 2 - length + 1, maxZ: z - 2 };
  if (direction === "south") return { minX: x - Math.ceil(width / 2), maxX: x - Math.ceil(width / 2) + width - 1, minY, maxY, minZ: z + 2, maxZ: z + 2 + length - 1 };
  if (direction === "east") return { minX: x + 2, maxX: x + 2 + width - 1, minY, maxY, minZ: z - Math.ceil(length / 2), maxZ: z - Math.ceil(length / 2) + length - 1 };
  return { minX: x - 2 - width + 1, maxX: x - 2, minY, maxY, minZ: z - Math.ceil(length / 2), maxZ: z - Math.ceil(length / 2) + length - 1 };
}

export function mineshaftSegment(anchor: Location, direction: CardinalDirection, width: 1 | 2, height: 2 | 3, segment: number): BlockBounds {
  integer(segment, "segment");
  if (segment < 0) throw new Error("segment must not be negative");
  const floorY = anchor.y - segment;
  const crossStart = -Math.floor(width / 2);
  const crossEnd = crossStart + width - 1;
  if (direction === "north" || direction === "south") {
    const z = anchor.z + (direction === "south" ? segment : -segment);
    return { minX: anchor.x + crossStart, maxX: anchor.x + crossEnd, minY: floorY + 1, maxY: floorY + height, minZ: z, maxZ: z };
  }
  const x = anchor.x + (direction === "east" ? segment : -segment);
  return { minX: x, maxX: x, minY: floorY + 1, maxY: floorY + height, minZ: anchor.z + crossStart, maxZ: anchor.z + crossEnd };
}

export function* deterministicSerpentine(bounds: BlockBounds): Generator<Location> {
  for (let y = bounds.maxY; y >= bounds.minY; y -= 1) {
    let row = 0;
    for (let z = bounds.minZ; z <= bounds.maxZ; z += 1, row += 1) {
      const reverse = row % 2 === 1;
      if (reverse) for (let x = bounds.maxX; x >= bounds.minX; x -= 1) yield { x, y, z };
      else for (let x = bounds.minX; x <= bounds.maxX; x += 1) yield { x, y, z };
    }
  }
}

export function* deterministicFootprint(bounds: BlockBounds): Generator<Location> {
  yield* deterministicSerpentine({ ...bounds, minY: bounds.maxY, maxY: bounds.maxY });
}

export const iterateSerpentine = deterministicSerpentine;
