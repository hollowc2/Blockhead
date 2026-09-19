import type { BuildingDesign } from "./schema.js";
import { BuildingDesignSchema } from "./schema.js";
export interface BuildingLimits { maxWidth: number; maxDepth: number; maxHeight: number; maxOperations: number; maxComponents: number; maxNestingDepth: number; maxAnchorDistance: number; allowedMaterials: readonly string[]; allowDemolition: boolean; }
export const DEFAULT_BUILDING_LIMITS: BuildingLimits = { maxWidth: 64, maxDepth: 64, maxHeight: 64, maxOperations: 12000, maxComponents: 64, maxNestingDepth: 4, maxAnchorDistance: 128, allowedMaterials: ["cobblestone","stone_bricks","smooth_stone","dark_oak_planks","oak_planks","glass","glass_pane","iron_bars","stone","torch","lantern","bookshelf","chest","crafting_table","furnace","oak_door","cyan_concrete","magenta_concrete","yellow_concrete","red_carpet","blue_carpet"], allowDemolition: false };
export function validateBuildingDesign(input: unknown, limits: BuildingLimits = DEFAULT_BUILDING_LIMITS): BuildingDesign {
  const design = BuildingDesignSchema.parse(input);
  if (design.components.length > limits.maxComponents) throw new Error(`design has too many components (maximum ${limits.maxComponents})`);
  for (const material of Object.values(design.palette)) {
    if (!limits.allowedMaterials.includes(material.replace(/^minecraft:/, ""))) throw new Error(`palette material '${material}' is not approved`);
  }
  for (const component of design.components) {
    const material = component.material;
    if (material && !limits.allowedMaterials.includes(material.replace(/^minecraft:/, ""))) throw new Error(`material '${material}' is not approved`);
  }
  return design;
}
