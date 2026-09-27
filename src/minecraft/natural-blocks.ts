/**
 * Natural terrain: blocks that world generation places and a player rarely
 * builds with. Pathfinding may tunnel through these and the protected home
 * region lets them be gathered; anything else (planks, glass, bricks, logs,
 * doors, beds, ...) may be part of something a player built.
 */
const NATURAL_BLOCK = /^(?:stone|deepslate|tuff|calcite|andesite|diorite|granite|dripstone_block|pointed_dripstone|dirt|coarse_dirt|rooted_dirt|grass_block|podzol|mycelium|mud|clay|sand|red_sand|gravel|sandstone|red_sandstone|terracotta|[a-z_]+_terracotta|snow|snow_block|powder_snow|ice|packed_ice|netherrack|soul_sand|soul_soil|basalt|blackstone|end_stone|moss_block|moss_carpet|smooth_basalt|amethyst_block|budding_amethyst|[a-z_]*_ore|[a-z_]+_leaves|short_grass|grass|tall_grass|fern|large_fern|dead_bush|vine|glow_lichen|sweet_berry_bush|[a-z_]+_mushroom|dandelion|poppy|azure_bluet|oxeye_daisy|cornflower|allium|blue_orchid|[a-z_]+_tulip|lily_of_the_valley|sunflower|lilac|rose_bush|peony|seagrass|tall_seagrass|kelp|kelp_plant|sugar_cane|cactus|pumpkin|melon|infested_[a-z_]+)$/;

export function isNaturalBlock(name: string): boolean {
  return NATURAL_BLOCK.test(name.replace(/^minecraft:/, ""));
}
