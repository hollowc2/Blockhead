import { BuildingDesignSchema, type BuildingDesign } from "./schema.js";

/**
 * Buildings the bot puts up on its own while developing the land (owner
 * request, 2026-10-05: "more houses, storage facilities, barns, windmills,
 * get creative"). Each fits a 7x7 development site (offsets 0..6 from the
 * site's corner) and uses only what the bot can make itself: planks,
 * cobblestone, logs, fences and doors. Roofs are stepped, not peaked: a
 * peaked roof's upper rings have nothing under them and cannot be placed
 * in survival, while each stepped layer rests on the one below.
 */

export type VillageBuilding = "cottage" | "storage_shed" | "barn" | "windmill" | "watchtower";

/** The order buildings go up in, repeating. */
export const VILLAGE_ORDER: readonly VillageBuilding[] = ["cottage", "storage_shed", "windmill", "barn", "cottage", "watchtower"];

/** Site size every village design fits in. */
export const VILLAGE_SITE = 7;

const palette = (primary: string, roof: string, extra: Partial<Record<"foundation" | "secondary" | "frame" | "glass" | "floor" | "accent", string>> = {}) => ({
  foundation: "cobblestone",
  primary,
  secondary: "cobblestone",
  frame: "oak_log",
  glass: "oak_fence",
  roof,
  floor: "oak_planks",
  accent: "oak_planks",
  lighting: "torch",
  furniture: "chest",
  ...extra,
});

function design(name: string, description: string, palettePicked: ReturnType<typeof palette>, components: unknown[]): BuildingDesign {
  return BuildingDesignSchema.parse({ name, description, anchor: "home", orientation: "north", scale: "small", palette: palettePicked, components, decoration: { interior: false, colorful: false, lighting: false } });
}

export function villageDesign(kind: VillageBuilding): BuildingDesign {
  switch (kind) {
    case "cottage":
      // Plank walls, a birch stepped roof, fence windows either side of the door.
      return design("Cottage", "Small plank cottage with a stepped birch roof and fence windows", palette("oak_planks", "birch_planks"), [
        { id: "cottage-walls", type: "cuboid", width: 7, depth: 7, height: 4, mode: "hollow" },
        { id: "cottage-roof", type: "roof", width: 7, depth: 7, height: 3, style: "stepped", transform: { offset: { x: 0, y: 4, z: 0 } } },
        { id: "cottage-door", type: "door", width: 1, height: 2, transform: { offset: { x: 3, y: 0, z: 0 } } },
        { id: "cottage-windows", type: "window_pattern", rows: 1, columns: 2, spacing: 4, margins: 1 },
      ]);
    case "storage_shed":
      // A low cobblestone store with a flat plank roof.
      return design("Storage shed", "Low cobblestone storage shed with a flat plank roof", palette("cobblestone", "oak_planks"), [
        { id: "shed-walls", type: "cuboid", width: 5, depth: 7, height: 3, mode: "hollow", transform: { offset: { x: 1, y: 0, z: 0 } } },
        { id: "shed-roof", type: "roof", width: 5, depth: 7, height: 1, style: "flat", transform: { offset: { x: 1, y: 3, z: 0 } } },
        { id: "shed-door", type: "door", width: 1, height: 2, transform: { offset: { x: 3, y: 0, z: 0 } } },
      ]);
    case "barn":
      // Tall birch walls, a wide double door and a big stepped roof.
      return design("Barn", "Tall birch barn with a double door and a stepped plank roof", palette("birch_planks", "oak_planks"), [
        { id: "barn-walls", type: "cuboid", width: 7, depth: 7, height: 5, mode: "hollow" },
        { id: "barn-roof", type: "roof", width: 7, depth: 7, height: 4, style: "stepped", transform: { offset: { x: 0, y: 5, z: 0 } } },
        { id: "barn-door", type: "door", width: 2, height: 2, transform: { offset: { x: 2, y: 0, z: 0 } } },
      ]);
    case "windmill":
      // A cobblestone tower, a plank cap, and sails on the front: a mast
      // from the ground and an arm out to one side (each sail block rests on
      // the one before it).
      return design("Windmill", "Cobblestone windmill tower with plank sails", palette("cobblestone", "oak_planks"), [
        { id: "mill-tower", type: "tower", footprint: { shape: "rectangular", width: 5, depth: 5 }, height: 8, transform: { offset: { x: 1, y: 0, z: 1 } } },
        { id: "mill-cap", type: "roof", width: 5, depth: 5, height: 3, style: "stepped", transform: { offset: { x: 1, y: 8, z: 1 } } },
        { id: "mill-mast", type: "column", height: 11, material: "oak_log", transform: { offset: { x: 3, y: 0, z: 0 } } },
        { id: "mill-sail", type: "wall", start: { x: 4, y: 0, z: 0 }, end: { x: 6, y: 0, z: 0 }, height: 1, thickness: 1, material: "oak_planks", transform: { offset: { x: 0, y: 7, z: 0 } } },
        { id: "mill-door", type: "door", width: 1, height: 2, transform: { offset: { x: 3, y: 0, z: 5 } } },
      ]);
    case "watchtower":
      // A slim plank lookout with a cobblestone cap (a cap wider than the
      // tower would overhang with nothing under it).
      return design("Watchtower", "Slim plank watchtower with a cobblestone cap", palette("oak_planks", "cobblestone"), [
        { id: "tower-shell", type: "tower", footprint: { shape: "rectangular", width: 3, depth: 3 }, height: 9, transform: { offset: { x: 2, y: 0, z: 2 } } },
        { id: "tower-cap", type: "roof", width: 3, depth: 3, height: 2, style: "stepped", transform: { offset: { x: 2, y: 9, z: 2 } } },
        { id: "tower-door", type: "door", width: 1, height: 2, transform: { offset: { x: 3, y: 0, z: 2 } } },
      ]);
  }
}
