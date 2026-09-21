import type { Block } from "prismarine-block";

export type ObservedBlockState = "passable" | "solid" | "fluid" | "falling" | "unobserved" | "protectedFixture" | "unbreakable";

const FLUIDS = new Set(["water", "flowing_water", "lava", "flowing_lava"]);
const UNBREAKABLE = new Set(["bedrock", "barrier", "end_portal", "end_gateway", "command_block", "chain_command_block", "repeating_command_block", "structure_block", "structure_void", "jigsaw"]);
const FIXTURES = new Set([
  "chest", "trapped_chest", "barrel", "ender_chest", "shulker_box", "furnace", "smoker", "blast_furnace", "crafting_table", "enchanting_table", "brewing_stand", "smithing_table", "stonecutter", "loom", "cartography_table", "bed", "hopper", "dropper", "dispenser", "beacon", "anvil", "chipped_anvil", "damaged_anvil", "spawner", "decorated_pot",
]);

function bareName(block: Block): string {
  return block.name.replace(/^minecraft:/, "");
}

export function isFallingBlockName(name: string): boolean {
  const bare = name.replace(/^minecraft:/, "");
  return bare === "sand" || bare === "red_sand" || bare === "gravel" || bare.endsWith("_concrete_powder") || bare === "anvil" || bare.endsWith("_anvil");
}

export function isProtectedFixtureName(name: string): boolean {
  const bare = name.replace(/^minecraft:/, "");
  return FIXTURES.has(bare) || bare.endsWith("_sign") || bare.endsWith("_hanging_sign") || bare.endsWith("_bed");
}

export function classifyObservedBlock(block: Block | null): ObservedBlockState {
  if (block === null) return "unobserved";
  const name = bareName(block);
  if (isProtectedFixtureName(name)) return "protectedFixture";
  if (UNBREAKABLE.has(name)) return "unbreakable";
  if (FLUIDS.has(name)) return "fluid";
  if (isFallingBlockName(name)) return "falling";
  if (block.diggable === false) return "unbreakable";
  if (name === "air" || block.boundingBox !== "block") return "passable";
  return "solid";
}

export const classifyBlockState = classifyObservedBlock;
