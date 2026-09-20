import { z } from "zod";

export const BuildingAnchorSchema = z.union([
  z.enum(["owner", "current", "home"]),
  z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int(), dimension: z.string().min(1) }),
]);
export const PaletteSchema = z.object({
  foundation: z.string().default("cobblestone"), primary: z.string().default("stone_bricks"),
  secondary: z.string().default("smooth_stone"), frame: z.string().default("dark_oak_planks"),
  glass: z.string().default("glass"), roof: z.string().default("stone_bricks"), floor: z.string().default("oak_planks"),
  accent: z.string().default("cyan_concrete"), lighting: z.string().default("torch"), furniture: z.string().default("bookshelf"),
});
const PointSchema = z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int() });
const TransformSchema = z.object({ offset: PointSchema.optional(), rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).optional(), repeat: z.number().int().min(1).max(8).optional(), mirror: z.boolean().optional(), verticalStack: z.number().int().min(1).max(8).optional() });
const MaterialSchema = z.string().min(1).max(48).optional();
const Common = { id: z.string().min(1).max(64).optional(), transform: TransformSchema.optional(), material: MaterialSchema };
const Footprint = z.object({ shape: z.enum(["rectangular", "polygon"]), width: z.number().int().min(1).max(96).optional(), depth: z.number().int().min(1).max(96).optional(), sides: z.number().int().min(3).max(12).optional(), radius: z.number().int().min(2).max(48).optional() });
export const BuildingComponentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("cuboid"), ...Common, width: z.number().int().min(1).max(96), depth: z.number().int().min(1).max(96), height: z.number().int().min(1).max(128), mode: z.enum(["solid", "hollow"]).default("solid") }),
  z.object({ type: z.literal("polygon_prism"), ...Common, sides: z.number().int().min(3).max(12), radius: z.number().int().min(2).max(48), height: z.number().int().min(1).max(128), mode: z.enum(["solid", "hollow", "ring"]).default("ring") }),
  z.object({ type: z.literal("tower"), ...Common, footprint: Footprint, height: z.number().int().min(1).max(128), taper: z.number().int().min(0).max(8).optional() }),
  z.object({ type: z.literal("bundled_towers"), ...Common, layout: z.enum(["grid", "explicit"]), offsets: z.array(PointSchema).max(16).optional(), heights: z.array(z.number().int().min(1).max(128)).min(1).max(16), width: z.number().int().min(3).max(32), depth: z.number().int().min(3).max(32) }),
  z.object({ type: z.literal("wall"), ...Common, start: PointSchema, end: PointSchema, height: z.number().int().min(1).max(64), thickness: z.number().int().min(1).max(8) }),
  z.object({ type: z.literal("floor"), ...Common, width: z.number().int().min(1).max(96), depth: z.number().int().min(1).max(96), y: z.number().int().min(0).max(128) }),
  z.object({ type: z.literal("roof"), ...Common, width: z.number().int().min(1).max(96), depth: z.number().int().min(1).max(96), height: z.number().int().min(1).max(32), style: z.enum(["flat", "peaked", "stepped", "dome", "spire"]) }),
  z.object({ type: z.literal("window_pattern"), ...Common, rows: z.number().int().min(1).max(16), columns: z.number().int().min(1).max(32), spacing: z.number().int().min(1).max(8), margins: z.number().int().min(0).max(16).default(1) }),
  z.object({ type: z.literal("door"), ...Common, width: z.number().int().min(1).max(3).default(1), height: z.number().int().min(2).max(4).default(2) }),
  z.object({ type: z.literal("arch"), ...Common, width: z.number().int().min(3).max(32), height: z.number().int().min(3).max(32) }),
  z.object({ type: z.literal("column"), ...Common, height: z.number().int().min(1).max(128) }),
  z.object({ type: z.literal("stair_step"), ...Common, steps: z.number().int().min(1).max(64), width: z.number().int().min(1).max(8) }),
  z.object({ type: z.literal("interior_zone"), ...Common, kind: z.enum(["bedroom", "workshop", "storage", "lobby", "library", "dining", "decorative"]), width: z.number().int().min(2).max(64), depth: z.number().int().min(2).max(64), height: z.number().int().min(2).max(16) }),
  z.object({ type: z.literal("decoration"), ...Common, kind: z.enum(["lighting", "carpets", "bookshelves", "plants", "furniture", "accent"]), count: z.number().int().min(1).max(128) }),
]);
export type BuildingComponent = z.infer<typeof BuildingComponentSchema>;
export const BuildingDesignSchema = z.object({
  name: z.string().min(1).max(120), description: z.string().min(1).max(500), anchor: BuildingAnchorSchema,
  orientation: z.enum(["north", "south", "east", "west"]).default("north"), scale: z.enum(["small", "medium", "large"]).default("medium"),
  palette: PaletteSchema, components: z.array(BuildingComponentSchema).min(1).max(64),
  decoration: z.object({ interior: z.boolean().default(true), colorful: z.boolean().default(false), lighting: z.boolean().default(true) }).optional(),
}).transform((design) => ({
  ...design,
  // Component IDs were not part of the original design format. Generate
  // deterministic IDs for legacy/LLM designs so compiler provenance does not
  // depend on object identity or a random UUID.
  components: design.components.map((component, index) => ({
    ...component,
    id: component.id ?? `component-${String(index + 1).padStart(3, "0")}`,
  })),
}));
export type BuildingDesign = z.output<typeof BuildingDesignSchema>;

export const BUILDING_SCHEMA_VERSION = "1.0.0";
