import { createHash } from "node:crypto";
import { z } from "zod";
import type { HomeLocation } from "../minecraft/movement.js";
import { normalizeDimension } from "../minecraft/protection.js";

export type TerrainProjectKind = "clear" | "flatten" | "excavate" | "mineshaft";
export type TerrainAnchor = "owner" | "owner_front" | "current" | "home";
export type CardinalDirection = "north" | "south" | "east" | "west";

export interface BlockBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

const TerrainAnchorSchema = z.enum(["owner", "owner_front", "current", "home"]);

export const ClearAreaSpecSchema = z.object({
  kind: z.literal("clear"),
  anchor: TerrainAnchorSchema.default("owner"),
  width: z.number().int().min(1).max(32),
  length: z.number().int().min(1).max(32),
  height: z.number().int().min(1).max(16),
});

export const FlattenAreaSpecSchema = z.object({
  kind: z.literal("flatten"),
  anchor: TerrainAnchorSchema.default("owner"),
  width: z.number().int().min(1).max(32),
  length: z.number().int().min(1).max(32),
});

export const ExcavateVolumeSpecSchema = z.object({
  kind: z.literal("excavate"),
  anchor: TerrainAnchorSchema.default("owner"),
  width: z.number().int().min(1).max(32),
  length: z.number().int().min(1).max(32),
  depth: z.number().int().min(1).max(32),
}).refine((value) => value.width * value.length * value.depth <= 8192, {
  message: "excavation volume must not exceed 8192 blocks",
  path: ["depth"],
});

export const MineshaftSpecSchema = z.object({
  kind: z.literal("mineshaft"),
  anchor: TerrainAnchorSchema.default("owner_front"),
  width: z.union([z.literal(1), z.literal(2)]),
  height: z.union([z.literal(2), z.literal(3)]),
  targetY: z.number().int().optional(),
  depth: z.number().int().min(1).optional(),
  direction: z.enum(["north", "south", "east", "west"]).optional(),
}).superRefine((value, context) => {
  if ((value.targetY === undefined) === (value.depth === undefined)) {
    context.addIssue({ code: "custom", message: "mineshaft requires exactly one of targetY or depth", path: ["targetY"] });
  }
});

// A plain union is intentional: excavation and mineshaft use cross-field
// refinements, which Zod represents as ZodEffects and therefore cannot be
// members of z.discriminatedUnion in Zod 3.
export const TerrainSpecSchema = z.union([
  ClearAreaSpecSchema,
  FlattenAreaSpecSchema,
  ExcavateVolumeSpecSchema,
  MineshaftSpecSchema,
]);

export type ClearAreaSpec = z.infer<typeof ClearAreaSpecSchema>;
export type FlattenAreaSpec = z.infer<typeof FlattenAreaSpecSchema>;
export type ExcavateVolumeSpec = z.infer<typeof ExcavateVolumeSpecSchema>;
export type MineshaftSpec = z.infer<typeof MineshaftSpecSchema>;
export type TerrainSpec = z.infer<typeof TerrainSpecSchema>;

export interface FrozenTerrainPlan {
  planVersion: 1;
  world: string;
  dimension: string;
  anchor: HomeLocation;
  bounds: BlockBounds;
  specification: TerrainSpec;
  geometryHash: string;
}

export interface TerrainPlanInput {
  world: string;
  dimension: string;
  anchor: HomeLocation;
  bounds: BlockBounds;
  specification: TerrainSpec;
}

function assertInteger(value: number, name: string): void {
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`);
}

export function assertBlockBounds(bounds: BlockBounds): BlockBounds {
  for (const [name, value] of Object.entries(bounds)) assertInteger(value, `bounds.${name}`);
  if (bounds.minX > bounds.maxX || bounds.minY > bounds.maxY || bounds.minZ > bounds.maxZ) {
    throw new Error("block bounds must have min values no greater than max values");
  }
  return { ...bounds };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonicalize(entry)]));
  }
  return value;
}

export function canonicalTerrainPlanInput(input: TerrainPlanInput): string {
  if (input.world.trim() === "") throw new Error("world must be non-empty");
  if (input.dimension.trim() === "") throw new Error("dimension must be non-empty");
  if (normalizeDimension(input.anchor.dimension) !== normalizeDimension(input.dimension)) {
    throw new Error("anchor dimension must match plan dimension");
  }
  const normalized = {
    planVersion: 1,
    world: input.world,
    dimension: normalizeDimension(input.dimension),
    anchor: { x: input.anchor.x, y: input.anchor.y, z: input.anchor.z, dimension: normalizeDimension(input.anchor.dimension) },
    bounds: assertBlockBounds(input.bounds),
    specification: TerrainSpecSchema.parse(input.specification),
  };
  return JSON.stringify(canonicalize(normalized));
}

export function terrainGeometryHash(input: TerrainPlanInput): string {
  return createHash("sha256").update(canonicalTerrainPlanInput(input), "utf8").digest("hex");
}

export function createFrozenTerrainPlan(input: TerrainPlanInput): FrozenTerrainPlan {
  const specification = TerrainSpecSchema.parse(input.specification);
  const dimension = normalizeDimension(input.dimension);
  const anchor: HomeLocation = { x: input.anchor.x, y: input.anchor.y, z: input.anchor.z, dimension: normalizeDimension(input.anchor.dimension) };
  const normalizedInput = { ...input, dimension, anchor, specification, bounds: assertBlockBounds(input.bounds) };
  return { ...normalizedInput, planVersion: 1, geometryHash: terrainGeometryHash(normalizedInput) };
}
