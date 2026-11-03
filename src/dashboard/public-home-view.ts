import { deflateSync } from "node:zlib";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";

/**
 * The broadcast's picture-in-picture: a still, north-up, top-down picture
 * of the blocks around home, one pixel a block, refreshed every minute or
 * two. A second live 3D renderer would cost the stream about as much RAM as
 * the first; this costs one small PNG.
 *
 * What it may show is what the live 3D view already shows when CobbleBob is
 * at home: the colour of the topmost block in each column, shaded by its
 * height relative to its northern neighbour. It is built from two inputs
 * only, home and a block-name lookup, so entities (players, their names,
 * mobs), signs' text, containers' contents and every owner-map layer never
 * reach it. The PNG carries only IHDR, IDAT and IEND: no text, no
 * timestamps. Every pixel is measured from home's block, so the same
 * scene anywhere in the world (any x, y or z) encodes to the same bytes
 * (see the translation test), and it renders only when every column is
 * loaded, so chunk edges can't give away where the 16-block grid falls.
 */

/** Blocks from home to the image's edge: a 39×39 picture. */
export const HOME_VIEW_RADIUS = 19;
export const HOME_VIEW_SIZE = HOME_VIEW_RADIUS * 2 + 1;
/** The vertical band searched for each column's top block, relative to home. */
const ABOVE = 32;
const BELOW = 24;
/** A fresh picture at most this often, and only while someone asks for it. */
export const HOME_VIEW_REFRESH_MS = 90_000;
/** Without a picture yet (or after a failed attempt), try again this soon. */
export const HOME_VIEW_RETRY_MS = 15_000;

export interface HomeViewWorld {
  /** Whether the chunk holding block column (x, z) is loaded. */
  loaded(x: number, z: number): boolean;
  /** The block's bare name ("air" for air), or null when unknown. */
  block(x: number, y: number, z: number): string | null;
}
export interface HomeViewSource {
  home: { x: number; y: number; z: number } | null;
  world: HomeViewWorld | null;
}

type Rgb = readonly [number, number, number];

// Minecraft's own map colours, by family.
const GRASS: Rgb = [127, 178, 56], PLANT: Rgb = [0, 124, 0], SAND: Rgb = [247, 233, 163], WOOL: Rgb = [199, 199, 199];
const LAVA: Rgb = [230, 92, 20], ICE: Rgb = [160, 160, 255], METAL: Rgb = [167, 167, 167], SNOW: Rgb = [255, 255, 255];
const CLAY: Rgb = [164, 168, 184], DIRT: Rgb = [151, 109, 77], STONE: Rgb = [112, 112, 112], WATER: Rgb = [64, 64, 255];
const WOOD: Rgb = [143, 119, 72], QUARTZ: Rgb = [255, 252, 245], PODZOL: Rgb = [129, 86, 49], NETHER: Rgb = [112, 2, 0];
const DEEPSLATE: Rgb = [100, 100, 100], GRAVEL: Rgb = [136, 136, 136], BLACK: Rgb = [25, 25, 25];
const DYES: ReadonlyArray<[string, Rgb]> = [
  ["light_blue", [102, 153, 216]], ["light_gray", [153, 153, 153]], ["white", [255, 255, 255]], ["orange", [216, 127, 51]],
  ["magenta", [178, 76, 216]], ["yellow", [229, 229, 51]], ["lime", [127, 204, 25]], ["pink", [242, 127, 165]],
  ["gray", [76, 76, 76]], ["cyan", [76, 127, 153]], ["purple", [127, 63, 178]], ["blue", [51, 76, 178]],
  ["brown", [102, 76, 51]], ["green", [102, 127, 51]], ["red", [153, 51, 51]], ["black", [25, 25, 25]],
];
const WOODS: ReadonlyArray<[string, Rgb]> = [
  ["dark_oak", [102, 76, 51]], ["pale_oak", [238, 232, 222]], ["oak", WOOD], ["spruce", PODZOL], ["birch", SAND], ["jungle", DIRT],
  ["acacia", [216, 127, 51]], ["mangrove", [153, 51, 51]], ["cherry", [209, 177, 161]], ["bamboo", [229, 229, 51]],
  ["crimson", [148, 63, 97]], ["warped", [58, 142, 140]],
];
const EXACT: Readonly<Record<string, Rgb>> = {
  grass_block: GRASS, water: WATER, bubble_column: WATER, lava: LAVA, sand: SAND, red_sand: [216, 127, 51], gravel: GRAVEL,
  snow: SNOW, snow_block: SNOW, powder_snow: SNOW, ice: ICE, packed_ice: ICE, blue_ice: ICE, frosted_ice: ICE,
  dirt: DIRT, coarse_dirt: DIRT, rooted_dirt: DIRT, farmland: DIRT, dirt_path: DIRT, podzol: PODZOL, mud: [87, 92, 92],
  mycelium: [127, 63, 178], clay: CLAY, diorite: QUARTZ, granite: DIRT, calcite: SNOW, obsidian: BLACK, crying_obsidian: BLACK,
  netherrack: NETHER, bedrock: STONE, end_stone: SAND, glowstone: SAND, crafting_table: WOOD, chest: WOOD, trapped_chest: WOOD,
  barrel: WOOD, bookshelf: WOOD, composter: WOOD, iron_block: METAL, anvil: METAL, cauldron: METAL, hopper: METAL,
  gold_block: [250, 238, 77], diamond_block: [92, 219, 213], emerald_block: [0, 217, 58], lapis_block: [74, 128, 255],
  redstone_block: [255, 0, 0], coal_block: BLACK, hay_block: [229, 229, 51], pumpkin: [216, 127, 51], melon: [127, 204, 25],
  cactus: PLANT, moss_block: PLANT, moss_carpet: PLANT, tuff: [57, 41, 35], bricks: [153, 51, 51], tnt: [255, 0, 0],
};
// Not drawn: the block below shows through (as on a map, where grass tufts don't speckle a meadow).
const SEE_THROUGH = /^(?:air|cave_air|void_air|light|barrier|structure_void|glass|glass_pane|tinted_glass|[a-z_]+_stained_glass(?:_pane)?|(?:soul_|redstone_)?(?:wall_)?torch|tripwire|string|[a-z_]*rail|lever|[a-z_]+_button|ladder|scaffolding|cobweb|short_grass|tall_grass|fern|large_fern|seagrass|tall_seagrass|dead_bush)$/;
const PLANTS = /(?:leaves|sapling|^bush$|vine|lily_pad|kelp|seagrass|sugar_cane|bamboo$|wheat|carrots|potatoes|beetroots|azalea|dripleaf|_roots$|sweet_berry_bush|tulip|poppy|dandelion|orchid|allium|bluet|daisy|cornflower|lily_of_the_valley|rose|peony|lilac|sunflower|pitcher|torchflower)/;

const colours = new Map<string, Rgb | null>();
/** A block's map colour, or null when it is see-through. */
export function blockColour(name: string): Rgb | null {
  const cached = colours.get(name);
  if (cached !== undefined) return cached;
  const colour = SEE_THROUGH.test(name) ? null
    : EXACT[name]
    ?? (PLANTS.test(name) ? PLANT : undefined)
    ?? DYES.find(([dye]) => name.startsWith(`${dye}_`))?.[1]
    ?? WOODS.find(([wood]) => name.startsWith(`${wood}_`))?.[1]
    ?? (/deepslate/.test(name) ? DEEPSLATE : undefined)
    ?? (/copper/.test(name) ? [216, 127, 51] as Rgb : undefined)
    ?? (/sandstone/.test(name) ? SAND : undefined)
    ?? (/quartz/.test(name) ? QUARTZ : undefined)
    ?? (/nether|blackstone|basalt/.test(name) ? NETHER : undefined)
    ?? (/snow/.test(name) ? SNOW : undefined)
    ?? (/wool|carpet|bed$/.test(name) ? WOOL : undefined)
    ?? STONE;
  if (colours.size < 2048) colours.set(name, colour);
  return colour;
}

/** The top block in each column around home as a PNG, or null when any column it needs isn't loaded. */
export function renderHomeView(world: HomeViewWorld, home: { x: number; y: number; z: number }): Buffer | null {
  const hx = Math.floor(home.x), hy = Math.floor(home.y), hz = Math.floor(home.z);
  if (![hx, hy, hz].every(Number.isFinite)) return null;
  const size = HOME_VIEW_SIZE, r = HOME_VIEW_RADIUS;
  // One extra row to the north, for the first row's shading.
  for (let dz = -r - 1; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) if (!world.loaded(hx + dx, hz + dz)) return null;

  const tops: Array<{ height: number; colour: Rgb | null; depth: number }> = [];
  for (let dz = -r - 1; dz <= r; dz++) {
    for (let dx = -r; dx <= r; dx++) {
      let top = { height: -BELOW - 1, colour: null as Rgb | null, depth: 0 };
      for (let dy = ABOVE; dy >= -BELOW; dy--) {
        const name = world.block(hx + dx, hy + dy, hz + dz);
        const colour = name === null ? null : blockColour(name);
        if (colour === null) continue;
        let depth = 0;
        if (colour === WATER) while (depth < 10 && world.block(hx + dx, hy + dy - depth - 1, hz + dz) === "water") depth++;
        top = { height: dy, colour, depth };
        break;
      }
      tops.push(top);
    }
  }

  const pixels = Buffer.alloc(size * size * 3);
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const here = tops[(row + 1) * size + col]!, north = tops[row * size + col]!;
      // Water darkens with depth; land is lit from the north, as on a map.
      const shade = here.colour === null ? 0
        : here.colour === WATER ? (here.depth < 2 ? 1 : here.depth < 5 ? 0.86 : 0.71)
          : here.height > north.height ? 1 : here.height < north.height ? 0.71 : 0.86;
      const [red, green, blue] = here.colour ?? [18, 24, 29];
      const at = (row * size + col) * 3;
      pixels[at] = Math.round(red * (here.colour === null ? 1 : shade));
      pixels[at + 1] = Math.round(green * (here.colour === null ? 1 : shade));
      pixels[at + 2] = Math.round(blue * (here.colour === null ? 1 : shade));
    }
  }
  return encodePng(size, size, pixels);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4), crc = Buffer.alloc(4), body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  length.writeUInt32BE(data.length);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
/** An 8-bit RGB PNG with only the chunks it needs. */
export function encodePng(width: number, height: number, rgb: Buffer): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y++) rgb.copy(rows, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

/**
 * The picture to serve, never rendered in the request: asking only starts a
 * background refresh when the last one is old enough, so however often it
 * is asked for it renders at most once per HOME_VIEW_REFRESH_MS, and not at
 * all while nobody watches. The last picture stays while home can't be seen
 * (CobbleBob far away or in another dimension); a different home drops it.
 */
export function cachedHomeView(
  source: () => HomeViewSource | Promise<HomeViewSource>,
  options: { refreshMs?: number; retryMs?: number; now?: () => number; onError?: (error: unknown) => void } = {},
): () => Buffer | null {
  const refreshMs = options.refreshMs ?? HOME_VIEW_REFRESH_MS, retryMs = options.retryMs ?? HOME_VIEW_RETRY_MS, now = options.now ?? Date.now;
  let image: Buffer | null = null, homeKey: string | null = null, attemptAt = -Infinity, busy = false;
  const refresh = async (): Promise<void> => {
    const { home, world } = await source();
    if (home === null) return;
    const key = [home.x, home.y, home.z].map(Math.floor).join(",");
    if (key !== homeKey) { image = null; homeKey = key; }
    const rendered = world === null ? null : renderHomeView(world, home);
    if (rendered !== null) image = rendered;
  };
  return () => {
    const at = now();
    if (!busy && at - attemptAt >= (image === null ? retryMs : refreshMs)) {
      attemptAt = at;
      busy = true;
      setImmediate(() => { refresh().catch((error: unknown) => options.onError?.(error)).finally(() => { busy = false; }); });
    }
    return image;
  };
}

/** Block names from the bot's loaded world; nothing else about the world is reachable through it. */
export function botHomeViewWorld(bot: Pick<Bot, "world" | "registry">): HomeViewWorld {
  const at = new Vec3(0, 0, 0);
  return {
    loaded: (x, z) => Boolean(bot.world.getColumnAt(at.set(x, 0, z))),
    block: (x, y, z) => {
      try {
        const id = bot.world.getBlockStateId(at.set(x, y, z));
        return typeof id === "number" ? bot.registry.blocksByStateId[id]?.name ?? null : null;
      } catch {
        return null;
      }
    },
  };
}
