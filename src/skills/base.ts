import type { Bot } from "mineflayer";
import type { Block } from "prismarine-block";
import type { Item } from "prismarine-item";
import prismarineItem from "prismarine-item";
import type { Logger } from "pino";
import { Vec3 } from "vec3";
import type { AgentState } from "../agent/state.js";
import type { TaskSignals } from "../agent/scheduler.js";
import type { MinecraftConfig } from "../config/schema.js";
import type { EventBus } from "../events/bus.js";
import type { SkillsRepository } from "../memory/skills.js";
import type { CollectResourceRunner } from "./collect-resource.js";
import type { HomeLocation } from "../minecraft/movement.js";
import { creativeFlyToAndWait, travelAndWait, travelHomeAndWait, type Location, type TravelWaitResult } from "../minecraft/movement.js";
import { craftItem, craftPlanks } from "../minecraft/crafting.js";
import { bareName, countLogs, countPlanks, isPlanksItemName, itemsSummary } from "../minecraft/inventory.js";
import {
  collectBlocks,
  findBlockNear,
  findBlocksNear,
  isAir,
  isRawLog,
  isSolid,
  placeItemAt,
  type PlacementSpot,
} from "../minecraft/world.js";
import { ChatThrottle, gameChatBudgetAllows, withTimeout, type SkillResult } from "./skill-library.js";
import { cancelCollection, collectBlockOperation, digBlock } from "../minecraft/primitives.js";
import { isCreativeMode } from "../minecraft/mode.js";
import type { BuildingDesign } from "../building/schema.js";
import { compileBuildingDesign, type Blueprint } from "../building/compiler.js";
import { DEFAULT_BUILDING_LIMITS } from "../building/validation.js";

/**
 * The centralized stockpile base (spec 4.3 "improve basic infrastructure"):
 * a deterministic shed anchored on the home column. Every stockpile object —
 * the chest row, the crafting table, the furnace — has a fixed slot inside,
 * so storage and stations stop piling up "in one spot" and instead build
 * one organized stockpile at the base. The structure itself is a two-high
 * plank shell with a flat roof and an oak door, built incrementally and
 * resumable across runs (a paused build continues, never restarts).
 *
 * Three layers, matching every other skill: deterministic layout code here,
 * executed by the `build_base` runner through the TaskDispatcher, probed
 * each idle tick by the background loop.
 */

// --- deterministic layout constants ---

/** Half-width of the interior pad: offsets -2..2 -> a 5x5 floor. */
export const BASE_INTERIOR_RADIUS = 2;
/** Wall ring cells sit one block outside the interior pad. */
const BASE_EXTENT = BASE_INTERIOR_RADIUS + 1;
/** Two-high plank walls — an oak door needs a 2-block gap. */
export const BASE_WALL_HEIGHT = 2;
/** One door consumes 6 planks (the 3x3 recipe). */
export const DOOR_PLANK_COST = 6;

/** Wall-clock budget for one trip home (mirrors the other home skills). */
const TRAVEL_TIMEOUT_MS = 120_000;
/** Wall-clock budget for one plank-log collection pass. */
const COLLECT_TIMEOUT_MS = 240_000;
/** Radius where the log search starts; doubles up to MAX_LOG_SEARCH_RADIUS. */
const LOG_SEARCH_RADIUS = 48;
/** Largest radius the base builder's log search reaches. */
const MAX_LOG_SEARCH_RADIUS = 256;
/** Candidate log positions considered per search radius. */
const CANDIDATES_PER_RADIUS = 24;
/** Scan radius for an already-placed home crafting table (door recipe). */
const TABLE_SCAN_RADIUS = 16;
/** Mineflayer cannot place a block from arbitrarily far away. */
// The server's creative interaction check is stricter than the target-cell
// distance used by the old movement guard. Leave a small margin around the
// reference face so a packet is not rejected at the edge of reach.
const SIMPLE_BUILD_PLACE_REACH = 4.0;
const SIMPLE_BUILD_APPROACH_RANGE = 2.5;
const CREATIVE_FLIGHT_TIMEOUT_MS = 8_000;

// --- pure layout (unit-tested) ---

/** Every stockpile position of the base, in absolute block coordinates. */
export interface BaseLayout {
  /** Ground level of the pad (the home column's Y). */
  floorY: number;
  /**
   * Plank wall cells to build, bottom layer first, then the top layer. The
   * door gap is excluded: the structure's entrance.
   */
  wallCells: Vec3[];
  /** The 2-high door gap cells on the front (+Z) face. */
  doorCells: Vec3[];
  /**
   * Flat roof cells over the pad, ordered so every roof cell already has a
   * placed neighbor when it is built: the outer ring first, then the
   * interior rows west-to-east and back-to-front.
   */
  roofCells: Vec3[];
  /**
   * Stockpile chest slots along the back (-Z) wall, center slot first. Each
   * slot is two cells from its neighbors, so placed chests can never merge
   * into a double chest (which one registry row cannot represent).
   */
  chestSlots: Vec3[];
  /** Fixed crafting-table slot (front-left inside, beside the door). */
  tableSlot: Vec3;
  /** Fixed furnace slot (front-right inside, beside the door). */
  furnaceSlot: Vec3;
}

/**
 * The complete blueprint for one base, anchored on the home column. Pure:
 * the only inputs are the home coordinate and the layout constants.
 */
export function baseLayoutFor(home: HomeLocation): BaseLayout {
  const cx = Math.floor(home.x);
  const cz = Math.floor(home.z);
  const floorY = Math.floor(home.y);

  // Walls: the ring at |dx| or |dz| == BASE_EXTENT, two layers high, minus
  // the door gap on the front face (+Z, at the home column's X).
  const doorCells = [new Vec3(cx, floorY, cz + BASE_EXTENT), new Vec3(cx, floorY + 1, cz + BASE_EXTENT)];
  const wallCells: Vec3[] = [];
  for (let layer = 0; layer < BASE_WALL_HEIGHT; layer++) {
    for (let dx = -BASE_EXTENT; dx <= BASE_EXTENT; dx++) {
      for (let dz = -BASE_EXTENT; dz <= BASE_EXTENT; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== BASE_EXTENT) continue;
        if (dx === 0 && dz === BASE_EXTENT) continue; // door gap
        wallCells.push(new Vec3(cx + dx, floorY + layer, cz + dz));
      }
    }
  }

  // Roof: the whole pad one block above the walls. Ring cells first (they
  // lean on the wall tops), then the inner rows west-to-east, back-to-front
  // (each inner cell leans on its already-placed western neighbor).
  const roofCells: Vec3[] = [];
  for (let dx = -BASE_EXTENT; dx <= BASE_EXTENT; dx++) {
    for (let dz = -BASE_EXTENT; dz <= BASE_EXTENT; dz++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) === BASE_EXTENT) {
        roofCells.push(new Vec3(cx + dx, floorY + BASE_WALL_HEIGHT, cz + dz));
      }
    }
  }
  for (let dz = -BASE_INTERIOR_RADIUS; dz <= BASE_INTERIOR_RADIUS; dz++) {
    for (let dx = -BASE_INTERIOR_RADIUS; dx <= BASE_INTERIOR_RADIUS; dx++) {
      roofCells.push(new Vec3(cx + dx, floorY + BASE_WALL_HEIGHT, cz + dz));
    }
  }

  // Stockpile: three chests in a row against the back wall, center first;
  // crafting table and furnace on the two front-inside floor slots.
  const chestSlots = [
    new Vec3(cx, floorY, cz - BASE_INTERIOR_RADIUS),
    new Vec3(cx - BASE_INTERIOR_RADIUS, floorY, cz - BASE_INTERIOR_RADIUS),
    new Vec3(cx + BASE_INTERIOR_RADIUS, floorY, cz - BASE_INTERIOR_RADIUS),
  ];
  const tableSlot = new Vec3(cx - 1, floorY, cz + 1);
  const furnaceSlot = new Vec3(cx + 1, floorY, cz + 1);

  return { floorY, wallCells, doorCells, roofCells, chestSlots, tableSlot, furnaceSlot };
}

/** True when a block is a walk-through door (any wood, never a trapdoor). */
function isDoorBlock(block: Block | null): boolean {
  if (block === null) return false;
  const name = block.name.replace(/^minecraft:/, "");
  return name.endsWith("_door") && !name.endsWith("trapdoor");
}

/** The carried door item, or null when none is held. */
function findDoorItem(bot: Bot): Item | null {
  for (const item of bot.inventory.items()) {
    const name = item.name.replace(/^minecraft:/, "");
    if (name.endsWith("_door") && !name.endsWith("trapdoor")) return item;
  }
  return null;
}

/** The first carried plank stack ("oak_planks", "spruce_planks", ...). */
function findPlanksItem(bot: Bot): Item | null {
  const items = bot.inventory.items();
  for (const item of items) {
    if (isPlanksItemName(item.name)) return item;
  }
  return null;
}

/** Creative mode has a catalog; put requested items into usable inventory slots. */
async function ensureCreativeItem(bot: Bot, itemName: string, quantity: number, signal?: AbortSignal): Promise<Item | null> {
  const count = (): number => bot.inventory.items()
    .filter((item) => bareName(item.name) === itemName)
    .reduce((total, item) => total + item.count, 0);
  const first = (): Item | null => bot.inventory.items().find((item) => bareName(item.name) === itemName) ?? null;
  if (count() >= quantity) return first();
  const creative = bot.creative;
  const itemDefinition = bot.registry.itemsByName[itemName];
  if (creative === undefined || itemDefinition === undefined) return null;

  const ItemConstructor = prismarineItem as unknown as (registry: typeof bot.registry) => new (type: number, count: number) => Item;
  const CreativeItem = ItemConstructor(bot.registry);
  // Prefer an existing matching stack, then any usable player-inventory slot.
  // Creative bots often have a full hotbar but plenty of empty main-inventory
  // slots; restricting this to 36-44 made multi-material designs fail before
  // placing their first block. Slots 9-44 are the main inventory + hotbar.
  const usableSlots = Array.from({ length: 36 }, (_, index) => 9 + index);
  const emptySlots = usableSlots.filter((slot) => bot.inventory.slots[slot] === null);
  for (const slot of emptySlots) {
    if (signal?.aborted) return null;
    const missing = quantity - count();
    if (missing <= 0) return first();
    const item = new CreativeItem(itemDefinition.id, Math.min(64, missing));
    try {
      await creative.setInventorySlot(slot, item);
    } catch {
      return null;
    }
  }
  return count() >= quantity ? first() : null;
}

// --- measurement (structure completeness) ---

export interface StructureMeasurement {
  /** Wall cells that are still air (placeable). */
  missingWalls: number;
  /** Roof cells that are still air (placeable). */
  missingRoof: number;
  /** True when the door gap is empty and a door can be placed. */
  doorMissing: boolean;
  /**
   * Cells that are neither air nor a usable material — an unloaded chunk or
   * a foreign block. Never placeable without demolition; the builder counts
   * them so it does not mistake a blocked base for a complete one.
   */
  blocked: number;
  /** Planks the missing parts consume (walls + roof + door recipe). */
  planksNeeded: number;
  /** True when a build/repair run has something to do. */
  needsWork: boolean;
}

/** How much of the base shell still needs building. Pure over `blockAt`. */
export function measureStructure(bot: Bot, layout: BaseLayout): StructureMeasurement {
  let missingWalls = 0;
  let missingRoof = 0;
  let blocked = 0;

  for (const cell of layout.wallCells) {
    const block = bot.blockAt(cell);
    if (block === null) {
      blocked++;
      continue;
    }
    if (isAir(block)) missingWalls++;
    else if (!isPlanksItemName(block.name)) blocked++;
  }
  for (const cell of layout.roofCells) {
    const block = bot.blockAt(cell);
    if (block === null) {
      blocked++;
      continue;
    }
    if (isAir(block)) missingRoof++;
    else if (!isPlanksItemName(block.name)) blocked++;
  }

  const lower = bot.blockAt(layout.doorCells[0]!);
  const upper = bot.blockAt(layout.doorCells[1]!);
  let doorMissing = false;
  for (const doorBlock of [lower, upper]) {
    if (doorBlock === null) {
      blocked++;
      doorMissing = true;
    } else if (isAir(doorBlock)) {
      doorMissing = true;
    } else if (!isDoorBlock(doorBlock)) {
      // Something foreign occupies the gap; breaking it is out of scope.
      blocked++;
      doorMissing = true;
    }
  }

  const planksNeeded = missingWalls + missingRoof + (doorMissing ? DOOR_PLANK_COST : 0);
  return { missingWalls, missingRoof, doorMissing, blocked, planksNeeded, needsWork: planksNeeded > 0 || blocked > 0 };
}

// --- placement primitives ---

/** The six orthogonal neighbor directions. */
const ORTHOGONAL: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

function cellKey(cell: Vec3): string {
  return `${cell.x},${cell.y},${cell.z}`;
}

function blockName(block: Block | null): string {
  return block?.name?.replace(/^minecraft:/, "") ?? "null";
}

function targetHasExpectedBlock(block: Block | null, door: boolean): boolean {
  return door ? isDoorBlock(block) : block !== null && isPlanksItemName(block.name);
}

/**
 * A placement spot for `cell`: the solid block directly below when there is
 * one, else any solid (or this run's own placed) orthogonal neighbor, with
 * the face pointing from the reference toward the cell. Interior roof cells
 * have air below, so they lean on their neighbors; everything else stands
 * on the block below. Null when no reference is available this pass.
 */
function findReferenceFor(bot: Bot, cell: Vec3, placed: ReadonlySet<string>): Pick<PlacementSpot, "reference" | "face"> | null {
  const below = bot.blockAt(cell.offset(0, -1, 0));
  if (below !== null && isSolid(below)) {
    return { reference: below, face: new Vec3(0, 1, 0) };
  }
  for (const [dx, dy, dz] of ORTHOGONAL) {
    const neighbor = cell.offset(dx, dy, dz);
    const block = bot.blockAt(neighbor);
    if (block === null) continue;
    // Creative placement requires an authoritative solid reference. Preserve
    // the survival builder's existing placed-marker fallback for compatibility
    // with its delayed block-cache updates.
    if (!isSolid(block) && !(placed.has(cellKey(neighbor)) && !isCreativeMode(bot))) continue;
    return { reference: block, face: new Vec3(-dx, -dy, -dz) };
  }
  return null;
}

/** Conservative client-side reach check matching the block interaction ray. */
export function isPlacementWithinReach(bot: Bot, reference: Block, face: Vec3): boolean {
  const eye = bot.entity?.position.offset(0, 1.62, 0);
  return eye !== undefined && eye.distanceTo(reference.position.plus(face.scaled(0.5))) <= SIMPLE_BUILD_PLACE_REACH;
}

/**
 * Equip `item` and place it at `cell` against the best available reference.
 * Returns the block the server ended up with, or null when nothing could be
 * equipped or placed.
 */
interface PlacementLogContext {
  logger?: Logger;
  approachIndex?: number;
  destination?: Vec3;
  travelStatus?: string;
}

async function placeAtCell(
  bot: Bot,
  item: Item,
  cell: Vec3,
  placed: ReadonlySet<string>,
  signal?: AbortSignal,
  context: PlacementLogContext = {},
  expected: (block: Block | null) => boolean = (block) => {
    const name = item.name.replace(/^minecraft:/, "");
    return name.endsWith("_door") ? isDoorBlock(block) : isPlanksItemName(block?.name ?? "");
  },
): Promise<Block | null> {
  const support = findReferenceFor(bot, cell, placed);
  const before = bot.blockAt(cell);
  const inventoryBefore = bot.inventory.items().filter((carried) => carried.name === item.name).reduce((sum, carried) => sum + carried.count, 0);
  const baseLog = {
    target: { x: cell.x, y: cell.y, z: cell.z },
    targetBefore: blockName(before),
    support: support === null ? null : { x: support.reference.position.x, y: support.reference.position.y, z: support.reference.position.z, block: blockName(support.reference) },
    face: support === null ? null : { x: support.face.x, y: support.face.y, z: support.face.z },
    botPosition: bot.entity === null ? null : { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z },
    approachIndex: context.approachIndex ?? null,
    destination: context.destination === undefined ? null : { x: context.destination.x, y: context.destination.y, z: context.destination.z },
    travelStatus: context.travelStatus ?? null,
    inventoryBefore,
  };
  if (support === null) {
    context.logger?.warn({ ...baseLog, finalReason: "no authoritative support block" }, "simple build placement failed");
    return null;
  }
  const referenceFaceDistance = bot.entity === null ? null : bot.entity.position.offset(0, 1.62, 0).distanceTo(support.reference.position.plus(support.face.scaled(0.5)));
  if (isCreativeMode(bot) && !isPlacementWithinReach(bot, support.reference, support.face)) {
    context.logger?.warn({ ...baseLog, referenceFaceDistance, finalReason: "reference face out of reach" }, "simple build placement failed");
    return null;
  }
  const spot: PlacementSpot = { position: cell, ...support };
  let placeAccepted = false;
  const observations: Array<{ attempt: number; block: string; inventoryCount: number }> = [];
  const placedBlock = await placeItemAt(bot, item, spot, signal, {
    onPlaceAccepted: () => { placeAccepted = true; },
    onPoll: (observation) => observations.push({ attempt: observation.attempt, block: blockName(observation.block), inventoryCount: observation.inventoryCount }),
  });
  if (placedBlock !== null && expected(placedBlock)) return placedBlock;
  const after = bot.blockAt(cell);
  const inventoryAfter = bot.inventory.items().filter((carried) => carried.name === item.name).reduce((sum, carried) => sum + carried.count, 0);
  context.logger?.warn({ ...baseLog, referenceFaceDistance, placeBlockReturned: placeAccepted, observations, targetAfter: blockName(after), inventoryAfter, finalReason: placedBlock === null ? "placement not observed after polling" : `wrong block observed: ${blockName(placedBlock)}` }, "simple build placement failed");
  return null;
}

/**
 * Creative flight does not need a scaffold, but one exact destination is
 * fragile around unloaded chunks and server collision corrections. These
 * points keep the placement reference inside the interaction radius while
 * approaching from several horizontal sides and from above.
 */
function creativePlacementApproaches(cell: Vec3): Vec3[] {
  return [
    // Below the target keeps the eye close to the top face of the support
    // block. This is the reliable pose for ground-level wall cells.
    new Vec3(cell.x, cell.y - 1, cell.z),
    // Level approaches keep a horizontal reference face inside the same
    // conservative server-side interaction radius.
    new Vec3(cell.x + 3, cell.y, cell.z),
    new Vec3(cell.x - 3, cell.y, cell.z),
    new Vec3(cell.x, cell.y, cell.z + 3),
    new Vec3(cell.x, cell.y, cell.z - 3),
  ];
}

/** A room/house gets a centered, two-block doorway on its front (+Z) wall. */
export function simpleStructureDoorCells(spec: SimpleStructureSpec): Vec3[] {
  if (spec.shape !== "room" || spec.width < 3 || spec.length < 1 || spec.height < 2) return [];
  const ox = Math.floor(spec.origin.x);
  const oy = Math.floor(spec.origin.y);
  const oz = Math.floor(spec.origin.z);
  const x = ox + Math.floor(spec.width / 2);
  const z = oz + spec.length - 1;
  return [new Vec3(x, oy, z), new Vec3(x, oy + 1, z)];
}

/**
 * The nearest free stockpile chest slot (air cell with a solid floor), or
 * null when every slot is occupied. Storage creation and the home-chest
 * restore route their chests here, so the stockpile grows at its
 * centralized location instead of a new scatter spot per chest.
 */
export function freeChestSlotSpot(bot: Bot, home: HomeLocation): PlacementSpot | null {
  const layout = baseLayoutFor(home);
  for (const slot of layout.chestSlots) {
    const cell = bot.blockAt(slot);
    if (cell !== null && !isAir(cell)) continue; // occupied (a chest or anything else)
    const below = bot.blockAt(slot.offset(0, -1, 0));
    if (below === null || !isSolid(below)) continue;
    return { position: slot, reference: below, face: new Vec3(0, 1, 0) };
  }
  return null;
}

/**
 * The fixed crafting-table or furnace slot, when its cell is air with a
 * solid floor. Stations land on their own slot instead of joining the chest
 * pile, so one table and one furnace serve the base.
 */
export function stationSlotSpot(bot: Bot, home: HomeLocation, kind: "crafting_table" | "furnace"): PlacementSpot | null {
  const layout = baseLayoutFor(home);
  const slot = kind === "crafting_table" ? layout.tableSlot : layout.furnaceSlot;
  // Mineflayer cannot place a block into the cell occupied by the player.
  // This matters after a restart when the bot may spawn directly on the
  // station slot; let callers use their nearby fallback instead.
  if (bot.entity?.position.floored().equals(slot)) return null;
  const cell = bot.blockAt(slot);
  if (cell !== null && !isAir(cell)) return null;
  const below = bot.blockAt(slot.offset(0, -1, 0));
  if (below === null || !isSolid(below)) return null;
  return { position: slot, reference: below, face: new Vec3(0, 1, 0) };
}

// --- the build_base runner ---

export interface BaseBuilderOptions {
  bot: Bot;
  state: AgentState;
  config: MinecraftConfig;
  bus: EventBus;
  /** Skill success records (spec 20.2). */
  skills: SkillsRepository;
  logger: Logger;
  /** Shared expedition gatherer used when the build needs raw logs. */
  collect: CollectResourceRunner;
}

export interface BaseBuildData {
  /** Planks the structure needed when the run began (0 when complete). */
  missingBefore: number;
  placedWalls: number;
  placedRoof: number;
  doorPlaced: boolean;
  /** Decorative room items placed during a house build. */
  decorated: number;
  /** Planks still missing after this run (partial builds resume later). */
  remaining: number;
  /** Exact blueprint coordinates still not verified in the world. */
  remainingCells?: Array<{ x: number; y: number; z: number }>;
  /** Times this task was cooperatively interrupted (Phase 8). */
  interruptions: number;
}

/** Progress persisted as the task's resume state (Phase 8). */
export interface BaseResumeState {
  interruptions: number;
  phase?: string;
  placed?: number;
  total?: number;
}

export type SimpleStructureShape = "room" | "wall" | "tower" | "pyramid";
export interface SimpleStructureSpec {
  shape: SimpleStructureShape;
  width: number;
  height: number;
  length: number;
  material: "planks";
  anchor: "owner" | "current" | "home";
  origin: HomeLocation;
}

export interface SimpleStructureDecoration {
  position: Vec3;
  itemNames: string[];
  /** Windows replace a wall plank; the other decorations occupy air. */
  replaceExisting?: boolean;
}

export const MAX_SIMPLE_STRUCTURE_BLOCKS = 1024;

/** Generate only bounded, deterministic cells; no model-provided coordinates. */
export function simpleStructureCells(spec: SimpleStructureSpec): Vec3[] {
  const { width, height, length } = spec;
  if (![width, height, length].every(Number.isInteger)
    || width < 1 || width > 15 || length < 1 || length > 15 || height < 1 || height > 12) {
    throw new Error("dimensions must be whole numbers: width/length 1-15 and height 1-12");
  }
  if (spec.material !== "planks") throw new Error("material must be the approved 'planks' family");
  if (spec.shape === "wall" && length !== 1) throw new Error("wall length must be 1; width controls its span");
  if (spec.shape === "pyramid") {
    if (width % 2 === 0 || length % 2 === 0) throw new Error("pyramid width and length must be odd");
    const maxHeight = Math.ceil(Math.min(width, length) / 2);
    if (height > maxHeight) throw new Error(`pyramid height ${height} exceeds ${maxHeight} for that footprint`);
  }

  const ox = Math.floor(spec.origin.x);
  const oy = Math.floor(spec.origin.y);
  const oz = Math.floor(spec.origin.z);
  const cells: Vec3[] = [];
  const addRing = (x0: number, z0: number, w: number, l: number, y: number): void => {
    for (let x = x0; x < x0 + w; x++) {
      for (let z = z0; z < z0 + l; z++) {
        if (x === x0 || x === x0 + w - 1 || z === z0 || z === z0 + l - 1) cells.push(new Vec3(x, y, z));
      }
    }
  };
  if (spec.shape === "wall") {
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) cells.push(new Vec3(ox + x, oy + y, oz));
  } else if (spec.shape === "pyramid") {
    for (let y = 0; y < height; y++) addRing(ox + y, oz + y, width - y * 2, length - y * 2, oy + y);
  } else {
    for (let y = 0; y < height; y++) addRing(ox, oz, width, length, oy + y);
    // Rooms and towers get a deterministic flat roof.
    for (let z = 0; z < length; z++) for (let x = 0; x < width; x++) cells.push(new Vec3(ox + x, oy + height, oz + z));
  }
  const doorKeys = new Set(simpleStructureDoorCells(spec).map(cellKey));
  const unique = [...new Map(cells.map((cell) => [cellKey(cell), cell])).entries()]
    .filter(([key]) => !doorKeys.has(key))
    .map(([, cell]) => cell);
  if (unique.length > MAX_SIMPLE_STRUCTURE_BLOCKS) throw new Error(`blueprint has ${unique.length} blocks; maximum is ${MAX_SIMPLE_STRUCTURE_BLOCKS}`);
  return unique;
}

/**
 * The little house personality pass.  It is deliberately deterministic so a
 * reconnect resumes the same room rather than inventing a new layout.  The
 * palette is bright and expressive without making assumptions about the
 * player's identity: magenta/cyan/blue/yellow accents, plants, books, and
 * practical furniture make the room feel lived in.
 */
export function simpleStructureDecorations(spec: SimpleStructureSpec): SimpleStructureDecoration[] {
  if (spec.shape !== "room" || spec.width < 5 || spec.length < 5 || spec.height < 3) return [];
  const ox = Math.floor(spec.origin.x);
  const oy = Math.floor(spec.origin.y);
  const oz = Math.floor(spec.origin.z);
  const decorations: SimpleStructureDecoration[] = [];
  const add = (x: number, y: number, z: number, itemNames: string[], replaceExisting = false): void => {
    decorations.push({ position: new Vec3(x, y, z), itemNames, replaceExisting });
  };

  // Four windows, high enough to preserve the wall's lower trim.
  add(ox, oy + 1, oz + 2, ["glass_pane", "glass"], true);
  add(ox + spec.width - 1, oy + 1, oz + 2, ["glass_pane", "glass"], true);
  add(ox + 1, oy + 1, oz + spec.length - 1, ["glass_pane", "glass"], true);
  add(ox + spec.width - 2, oy + 1, oz + spec.length - 1, ["glass_pane", "glass"], true);

  // A functional but styled interior: bed, storage, work corner, reading
  // nook, and a few bright floor accents that read well in any wood species.
  add(ox + 1, oy, oz + 1, ["red_bed", "blue_bed", "white_bed"]);
  add(ox + 1, oy, oz + spec.length - 2, ["chest"]);
  add(ox + 2, oy, oz + spec.length - 2, ["crafting_table"]);
  add(ox + spec.width - 2, oy, oz + spec.length - 2, ["furnace"]);
  add(ox + spec.width - 2, oy, oz + 1, ["bookshelf", "bookshelf_block"]);
  add(ox + 2, oy, oz + 2, ["magenta_carpet", "purple_carpet", "red_carpet"]);
  add(ox + spec.width - 3, oy, oz + 2, ["cyan_carpet", "blue_carpet", "yellow_carpet"]);
  add(ox + 2, oy, oz + spec.length - 3, ["flower_pot"]);

  // Torches sit on the floor in open corners, so they work without needing a
  // special wall-face placement primitive.
  add(ox + 3, oy, oz + 2, ["torch"]);
  add(ox + spec.width - 3, oy, oz + 2, ["torch"]);
  add(ox + 3, oy, oz + spec.length - 3, ["torch"]);
  add(ox + spec.width - 3, oy, oz + spec.length - 3, ["torch"]);
  return decorations;
}

export interface BaseRunOptions {
  /** Cooperative signals from the owning scheduler task; null for unbound runs. */
  signals?: TaskSignals;
  /** Resume state from a paused run of the same task. */
  resumeState?: BaseResumeState;
}

export interface DesignBuildData { operations: number; placed: number; remaining: number; estimate: Record<string, number>; interruptions: number; }

/**
 * Deterministic `build_base` skill: measure the shed, gather the missing
 * planks, place the walls, roof, and door in dependency order, and re-measure.
 * One run at a time; a paused build resumes from the same measurement.
 */
export class BaseBuilderRunner {
  private running = false;
  private signals: TaskSignals | null = null;
  private stopRequested = false;
  private interruptions = 0;

  /** Identical game-chat lines repeat at most once per window (spam-kick guard). */
  private readonly chatThrottle: ChatThrottle;

  constructor(private readonly opts: BaseBuilderOptions) {
    const throttleSeconds = opts.config.background?.announce_throttle_seconds ?? 30;
    this.chatThrottle = new ChatThrottle(throttleSeconds * 1000);
  }

  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Build (or repair) the base shell. Idempotent: existing walls, roof, and
   * door are measured and skipped, so a half-built shed is finished by the
   * next run instead of rebuilt.
   */
  async run(options: BaseRunOptions = {}): Promise<SkillResult<BaseBuildData>> {
    if (this.running) {
      return {
        ok: false,
        status: "blocked",
        errorCode: "ALREADY_RUNNING",
        message: "already building the base",
      };
    }
    this.running = true;
    this.signals = options.signals ?? null;
    this.interruptions = options.resumeState?.interruptions ?? 0;
    this.stopRequested = false;
    try {
      return await this.execute();
    } finally {
      this.running = false;
      this.signals = null;
    }
  }

  /** Build a validated simple blueprint persisted in a build_structure task. */
  async runSimple(spec: SimpleStructureSpec, options: BaseRunOptions = {}): Promise<SkillResult<BaseBuildData>> {
    if (this.running) return { ok: false, status: "blocked", errorCode: "ALREADY_RUNNING", message: "another build is already running" };
    this.running = true;
    this.signals = options.signals ?? null;
    this.interruptions = options.resumeState?.interruptions ?? 0;
    this.stopRequested = false;
    const data: BaseBuildData = { missingBefore: 0, placedWalls: 0, placedRoof: 0, doorPlaced: false, decorated: 0, remaining: 0, interruptions: this.interruptions };
    try {
      // A `current` anchor is intentionally resolved when the task starts,
      // not when chat enqueues it. A foreground request may wait behind an
      // interrupt or a world-action cleanup, so the position captured by the
      // chat handler can already be stale by the time this runner owns the
      // bot. Staying at the task-start position also avoids an unnecessary
      // path back through terrain that may have changed meanwhile.
      const effectiveSpec: SimpleStructureSpec = spec.anchor === "current" && this.opts.bot.entity !== null
        ? {
          ...spec,
          origin: {
            x: this.opts.bot.entity.position.x,
            y: this.opts.bot.entity.position.y,
            z: this.opts.bot.entity.position.z,
            dimension: String(this.opts.bot.game.dimension ?? spec.origin.dimension).replace(/^minecraft:/, ""),
          },
        }
        : spec;
      let cells: Vec3[];
      try { cells = simpleStructureCells(effectiveSpec); }
      catch (err) { return this.fail(data, "NOT_READY", String(err instanceof Error ? err.message : err)); }
      const doorCells = simpleStructureDoorCells(effectiveSpec);
      const decorations = simpleStructureDecorations(effectiveSpec);
      const targetCells = [...cells, ...doorCells];
      const doorKeySet = new Set(doorCells.map(cellKey));
      if (this.opts.bot.entity === null) return this.fail(data, "NOT_READY", "bot is not spawned");
      const currentDimension = String(this.opts.bot.game.dimension ?? "").replace(/^minecraft:/, "");
      if (currentDimension !== effectiveSpec.origin.dimension.replace(/^minecraft:/, "")) {
        return this.fail(data, "PATH_UNREACHABLE", `structure is anchored in dimension '${effectiveSpec.origin.dimension}'`);
      }
      this.signals?.checkpoint({ interruptions: this.interruptions, phase: "traveling", placed: options.resumeState?.placed ?? 0, total: cells.length });
      if (effectiveSpec.anchor !== "current") {
        const approach: Location = { x: effectiveSpec.origin.x - 2, y: effectiveSpec.origin.y, z: effectiveSpec.origin.z - 2 };
        const travel = await this.travelToSimpleAnchor(approach, effectiveSpec.origin.dimension);
        if (this.stopRequested) return this.interrupted(data);
        if (travel.status !== "arrived" && travel.status !== "already_there") {
          return this.fail(data, "PATH_UNREACHABLE", `could not reach structure anchor: ${travel.status}`);
        }
      }

      const blockedTarget = (cell: Vec3): boolean => {
        const block = this.opts.bot.blockAt(cell);
        if (block === null) return true;
        if (doorKeySet.has(cellKey(cell))) return !isAir(block) && !isDoorBlock(block);
        return !isAir(block) && !isPlanksItemName(block.name);
      };
      let blocked = targetCells.filter(blockedTarget);
      // A requested creative build owns its blueprint cells. Clear trees,
      // dirt, stone, or remnants of a previous structure in those cells so
      // one obstruction cannot abort the entire build. Unloaded cells remain
      // blocked because destroying an unknown block is unsafe.
      if (isCreativeMode(this.opts.bot)) {
        for (const cell of blocked) {
          const obstruction = this.opts.bot.blockAt(cell);
          if (obstruction === null || isAir(obstruction)) continue;
          await digBlock(this.opts.bot, obstruction, this.signals?.signal);
        }
        blocked = targetCells.filter(blockedTarget);
      }
      if (blocked.length > 0) {
        const first = blocked[0]!;
        return this.fail(data, "NOT_READY", `${blocked.length} blueprint cells are unloaded or occupied; first blocked cell is ${first.x},${first.y},${first.z}`);
      }
      let missing = targetCells.filter((cell) => !targetHasExpectedBlock(this.opts.bot.blockAt(cell), doorKeySet.has(cellKey(cell))));
      const missingPlanks = (): Vec3[] => cells.filter((cell) => !targetHasExpectedBlock(this.opts.bot.blockAt(cell), false));
      const missingDoors = (): Vec3[] => doorCells.filter((cell) => !targetHasExpectedBlock(this.opts.bot.blockAt(cell), true));
      data.missingBefore = missing.length;
      if (missing.length === 0 && missingDoors().length === 0) {
        const decorated = await this.decorateSimpleRoom(effectiveSpec, decorations, data);
        const message = decorated > 0
          ? `${spec.shape} is complete and decorated with ${decorated} house details.`
          : `${spec.shape} is already complete (${targetCells.length} blocks).`;
        this.announce(message);
        return { ok: true, status: "completed", data, message };
      }
      if (isCreativeMode(this.opts.bot)) {
        const supplied = await ensureCreativeItem(this.opts.bot, "oak_planks", missingPlanks().length, this.signals?.signal);
        if (supplied === null) {
          return this.fail(data, "INSUFFICIENT_MATERIALS", "creative mode did not provide enough oak planks");
        }
        if (missingDoors().length > 0 && await ensureCreativeItem(this.opts.bot, "oak_door", 1, this.signals?.signal) === null) {
          return this.fail(data, "INSUFFICIENT_MATERIALS", "creative mode did not provide an oak door");
        }
      } else if (missingPlanks().length > countPlanks(this.opts.bot)) {
        const shortfall = missingPlanks().length - countPlanks(this.opts.bot);
        const logsNeeded = Math.max(0, Math.ceil(shortfall / 4) - countLogs(this.opts.bot));
        if (logsNeeded > 0) {
          const gathered = await this.gatherLogs(logsNeeded);
          if (this.stopRequested) return this.interrupted(data);
          if (!gathered.ok) return this.fail(data, "RESOURCE_NOT_FOUND", gathered.reason);
        }
        const crafted = await craftPlanks(this.opts.bot, missingPlanks().length, this.signals?.signal);
        if (!crafted.ok) return this.fail(data, "INSUFFICIENT_MATERIALS", crafted.reason);
      }

      const placed = new Set<string>();
      let completed = targetCells.length - missing.length;
      let placedThisPass = 0;
      // A placement can be accepted by the server while its block update is
      // still in flight. Re-measure and retry each cell independently for a
      // bounded number of passes; every retry gets a fresh target and support
      // lookup rather than reusing stale block-cache state.
      for (let pass = 0; pass < 3; pass++) {
        let progressThisPass = 0;
        for (const cell of cells) {
          this.checkInterrupt({ phase: "placing", placed: completed, total: targetCells.length });
          if (this.stopRequested) return this.interrupted(data);
          if (targetHasExpectedBlock(this.opts.bot.blockAt(cell), false)) continue;
          const plank = isCreativeMode(this.opts.bot)
            ? await ensureCreativeItem(this.opts.bot, "oak_planks", 1, this.signals?.signal)
            : findPlanksItem(this.opts.bot);
          if (plank === null) break;
          if (await this.placeSimpleTarget(cell, plank, false, placed)) {
            placed.add(cellKey(cell));
            data.placedWalls += 1;
            placedThisPass += 1;
            progressThisPass += 1;
            completed += 1;
            this.signals?.checkpoint({ interruptions: this.interruptions, phase: "placing", placed: completed, total: targetCells.length });
          }
        }
        const doorItem = this.opts.bot.inventory.items().find((item) => bareName(item.name) === "oak_door") ?? null;
        if (doorItem !== null) {
          for (const cell of doorCells) {
            if (targetHasExpectedBlock(this.opts.bot.blockAt(cell), true)) continue;
            if (await this.placeSimpleTarget(cell, doorItem, true, placed)) {
              data.doorPlaced = true;
              placedThisPass += 1;
              progressThisPass += 1;
              completed += 1;
            }
          }
        }
        missing = targetCells.filter((cell) => !targetHasExpectedBlock(this.opts.bot.blockAt(cell), doorKeySet.has(cellKey(cell))));
        if (missing.length === 0 || progressThisPass === 0) break;
      }
      data.remaining = missing.length;
      data.remainingCells = missing.map((cell) => ({ x: cell.x, y: cell.y, z: cell.z }));
      if (placedThisPass === 0 && missing.length > 0) {
        this.opts.logger.warn({ remaining: data.remainingCells }, "simple build stopped with unverified blueprint cells");
        return this.fail(data, "NOT_READY", `could not place any of the ${missing.length} remaining ${spec.shape} blocks from the current area`);
      }
      const decorated = await this.decorateSimpleRoom(effectiveSpec, decorations, data);
      const message = missing.length === 0
        ? `Finished ${spec.shape}: ${cells.length} blocks plus ${decorated} windows, lights, and interior details.`
        : `${spec.shape} partially built: placed ${data.placedWalls}; ${missing.length}/${targetCells.length} blocks remain.`;
      this.announce(message);
      return { ok: true, status: missing.length === 0 ? "completed" : "partial", data, message };
    } finally {
      this.running = false;
      this.signals = null;
    }
  }

  /** Execute a frozen, validated declarative blueprint using the same lease,
   * movement, cancellation and authoritative placement path as simple builds. */
  async runDesign(design: BuildingDesign, origin: HomeLocation, options: BaseRunOptions = {}): Promise<SkillResult<DesignBuildData>> {
    if (this.running) return { ok: false, status: "blocked", errorCode: "ALREADY_RUNNING", message: "another build is already running" };
    this.running = true; this.signals = options.signals ?? null; this.stopRequested = false; this.interruptions = options.resumeState?.interruptions ?? 0;
    const data: DesignBuildData = { operations: 0, placed: 0, remaining: 0, estimate: {}, interruptions: this.interruptions };
    try {
      const limits = { ...DEFAULT_BUILDING_LIMITS, maxWidth: this.opts.config.building?.max_width ?? DEFAULT_BUILDING_LIMITS.maxWidth, maxDepth: this.opts.config.building?.max_depth ?? DEFAULT_BUILDING_LIMITS.maxDepth, maxHeight: this.opts.config.building?.max_height ?? DEFAULT_BUILDING_LIMITS.maxHeight, maxOperations: this.opts.config.building?.max_operations ?? DEFAULT_BUILDING_LIMITS.maxOperations, maxComponents: this.opts.config.building?.max_components ?? DEFAULT_BUILDING_LIMITS.maxComponents, allowedMaterials: this.opts.config.building?.allowed_materials ?? DEFAULT_BUILDING_LIMITS.allowedMaterials, allowDemolition: this.opts.config.building?.allow_demolition ?? false };
      const home = this.opts.state.home;
      if (home !== null && origin.dimension.replace(/^minecraft:/, "") === home.dimension.replace(/^minecraft:/, "") && Math.hypot(origin.x - home.x, origin.z - home.z) > (this.opts.config.building?.max_anchor_distance ?? DEFAULT_BUILDING_LIMITS.maxAnchorDistance)) return { ok: false, status: "blocked", errorCode: "ANCHOR_TOO_FAR", message: "design anchor is outside the configured build distance", data };
      let blueprint: Blueprint; try { blueprint = compileBuildingDesign(design, origin, limits); } catch (err) { return { ok: false, status: "failed", errorCode: "INVALID_DESIGN", message: String(err instanceof Error ? err.message : err), data }; }
      data.operations = blueprint.operations.length; data.estimate = blueprint.estimates.materials;
      if (this.opts.bot.entity === null) return { ok: false, status: "failed", errorCode: "NOT_READY", message: "bot is not spawned", data };
      const approach = new Vec3(origin.x - 2, origin.y, origin.z - 2);
      const travel = await this.travelToSimpleAnchor(approach, origin.dimension); if (travel.status !== "arrived" && travel.status !== "already_there") return { ok: false, status: "blocked", errorCode: "PATH_UNREACHABLE", message: `could not reach design anchor: ${travel.status}`, data };
      const done = Number((options.resumeState as { placed?: number } | undefined)?.placed ?? 0);
      for (let i = 0; i < blueprint.operations.length; i++) {
        const op = blueprint.operations[i]!; const cell = new Vec3(origin.x + op.x, origin.y + op.y, origin.z + op.z);
        this.checkInterrupt({ phase: op.phase, placed: i, total: blueprint.operations.length }); if (this.stopRequested) return { ok: true, status: "interrupted", message: "design build paused", data };
        const block = this.opts.bot.blockAt(cell); if (block !== null && block.name.replace(/^minecraft:/, "") === op.material) { data.placed++; continue; }
        if (block !== null && !isAir(block)) { if (!isCreativeMode(this.opts.bot) || !limits.allowDemolition) { data.remaining = blueprint.operations.length - data.placed; return { ok: false, status: "blocked", errorCode: "OBSTRUCTION", message: `design blocked at ${cell.x},${cell.y},${cell.z} by ${block.name}`, data }; } await digBlock(this.opts.bot, block, this.signals?.signal); }
        let item = this.opts.bot.inventory.items().find((candidate) => bareName(candidate.name) === op.material) ?? null;
        if (item === null && isCreativeMode(this.opts.bot)) item = await ensureCreativeItem(this.opts.bot, op.material, 1, this.signals?.signal);
        if (item === null) { data.remaining = blueprint.operations.length - data.placed; return { ok: false, status: "partial", errorCode: "INSUFFICIENT_MATERIALS", message: `missing approved material ${op.material} at operation ${op.id}`, data }; }
        if (await this.placeSimpleTarget(cell, item, op.material.endsWith("door"), new Set<string>(), (candidate) => candidate?.name.replace(/^minecraft:/, "") === op.material)) data.placed++;
        else { data.remaining = blueprint.operations.length - data.placed; return { ok: false, status: "partial", errorCode: "PLACEMENT_FAILED", message: `could not place ${op.material} at ${cell.x},${cell.y},${cell.z}`, data }; }
        if (!this.signals?.checkpoint({ interruptions: this.interruptions, phase: op.phase, placed: i + 1, total: blueprint.operations.length })) return { ok: true, status: "interrupted", message: "design build paused", data };
      }
      data.remaining = 0; return { ok: true, status: "completed", message: `${design.name} complete (${data.placed} verified blocks)`, data };
    } finally { this.running = false; this.signals = null; }
  }

  private async decorateSimpleRoom(
    spec: SimpleStructureSpec,
    decorations: SimpleStructureDecoration[],
    data: BaseBuildData,
  ): Promise<number> {
    if (spec.shape !== "room") return 0;
    const placed = new Set<string>();
    let count = 0;
    for (const decoration of decorations) {
      this.checkInterrupt({ phase: "decorating", placed: count, total: decorations.length });
      if (this.stopRequested) return count;
      const target = this.opts.bot.blockAt(decoration.position);
      let item: Item | null = null;
      for (const name of decoration.itemNames) {
        item = this.opts.bot.inventory.items().find((candidate) => bareName(candidate.name) === name) ?? null;
        if (item === null && isCreativeMode(this.opts.bot)) {
          item = await ensureCreativeItem(this.opts.bot, name, 1, this.signals?.signal);
        }
        if (item !== null) break;
      }
      if (item === null) continue;
      const expectedName = bareName(item.name);
      if (target !== null && bareName(target.name) === expectedName) {
        count += 1;
        continue;
      }
      if (target !== null && !isAir(target)) {
        if (!decoration.replaceExisting) continue;
        await digBlock(this.opts.bot, target, this.signals?.signal);
      }
      const block = await this.placeSimpleTarget(
        decoration.position,
        item,
        false,
        placed,
        (candidate) => candidate !== null && bareName(candidate.name) === expectedName,
      );
      if (block !== null) {
        placed.add(cellKey(decoration.position));
        count += 1;
        data.decorated += 1;
      }
    }
    return count;
  }

  private async placeSimpleTarget(
    cell: Vec3,
    item: Item,
    door: boolean,
    placed: ReadonlySet<string>,
    expected: (block: Block | null) => boolean = (block) => targetHasExpectedBlock(block, door),
  ): Promise<boolean> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const before = this.opts.bot.blockAt(cell);
      if (expected(before)) return true;
      const travel = await this.moveWithinSimpleBuildReach(cell, attempt);
      if (!travel.ok) {
        this.opts.logger.warn({ target: { x: cell.x, y: cell.y, z: cell.z }, targetBefore: blockName(before), approachIndex: attempt, destination: travel.destination, travelStatus: travel.status, finalReason: "travel failed" }, "simple build placement failed");
        continue;
      }
      if (this.stopRequested) return false;
      const placedBlock = await placeAtCell(this.opts.bot, item, cell, placed, this.signals?.signal, {
        logger: this.opts.logger,
        approachIndex: attempt,
        destination: travel.destination ?? undefined,
        travelStatus: travel.status,
      }, expected);
      if (placedBlock !== null && expected(this.opts.bot.blockAt(cell))) return true;
    }
    return false;
  }

  /** Creative players can fly directly; pathfinder is unreliable in void/sky builds. */
  private async travelToSimpleAnchor(approach: Location, dimension: string): Promise<TravelWaitResult> {
    const bot = this.opts.bot;
    if (isCreativeMode(bot) && bot.creative !== undefined) {
      if (this.signals?.signal.aborted) return { status: "aborted" };
      return creativeFlyToAndWait(bot, approach, { timeoutMs: TRAVEL_TIMEOUT_MS, signal: this.signals?.signal });
    }
    return travelAndWait(bot, approach, {
      dimension,
      timeoutMs: TRAVEL_TIMEOUT_MS,
      range: 3,
      shouldAbort: this.travelAbort,
      signal: this.signals?.signal,
    });
  }

  /** Move close enough to a simple-build target for a placement packet. */
  private async moveWithinSimpleBuildReach(cell: Vec3, approachIndex = 0): Promise<{ ok: boolean; status: string; destination: Vec3 | null }> {
    const bot = this.opts.bot;
    const self = bot.entity;
    if (self === null) return { ok: false, status: "no_entity", destination: null };
    const distance = Math.hypot(self.position.x - cell.x, self.position.y - cell.y, self.position.z - cell.z);
    const currentSupport = isCreativeMode(bot) ? findReferenceFor(bot, cell, new Set<string>()) : null;
    const currentReferenceInReach = currentSupport === null || isPlacementWithinReach(bot, currentSupport.reference, currentSupport.face);
    if (distance <= SIMPLE_BUILD_PLACE_REACH && currentReferenceInReach) return { ok: true, status: "already_there", destination: null };

    // Ground-level approaches work for the first wall layer, but leave a
    // creative builder too far below the upper walls and roof. Fly to the
    // block's elevation (one block below the target) before placing it.
    if (isCreativeMode(bot) && bot.creative !== undefined) {
      const approaches = creativePlacementApproaches(cell);
      const destination = approaches[approachIndex % approaches.length]!;
      if (this.signals?.signal.aborted || this.stopRequested) return { ok: false, status: "aborted", destination };
      const travel = await creativeFlyToAndWait(bot, destination, { timeoutMs: CREATIVE_FLIGHT_TIMEOUT_MS, signal: this.signals?.signal });
      if (travel.status === "aborted" || this.stopRequested) return { ok: false, status: travel.status, destination };
      const arrived = bot.entity !== null && bot.entity.position.distanceTo(destination) <= SIMPLE_BUILD_PLACE_REACH;
      if (arrived && (travel.status === "arrived" || travel.status === "already_there")) {
        return { ok: true, status: travel.status, destination };
      }
      this.opts.logger.warn({ cell, destination, status: travel.status, distance: bot.entity?.position.distanceTo(destination), approachIndex }, "creative build approach failed; trying another side");
      return { ok: false, status: travel.status, destination };
    }

    const approach: Location = {
      x: cell.x,
      // Build bottom-up: the block below the target is either terrain or an
      // already-placed lower layer, giving pathfinder a climbable standing
      // position for upper walls and the roof without creative flight.
      y: cell.y - 1,
      z: cell.z,
    };
    const travel = await travelAndWait(bot, approach, {
      dimension: String(bot.game.dimension ?? "overworld").replace(/^minecraft:/, ""),
      timeoutMs: TRAVEL_TIMEOUT_MS,
      range: SIMPLE_BUILD_APPROACH_RANGE,
      shouldAbort: this.travelAbort,
      signal: this.signals?.signal,
    });
    if (this.stopRequested) return { ok: false, status: "stopped", destination: new Vec3(approach.x, approach.y, approach.z) };
    if (travel.status !== "arrived" && travel.status !== "already_there") {
      this.opts.logger.warn({ cell, status: travel.status }, "simple build could not reach placement area");
    }
    // Preserve the survival builder's existing placement fallback; creative
    // flight is the path that requires an explicit arrival guarantee.
    return { ok: true, status: travel.status, destination: new Vec3(approach.x, approach.y, approach.z) };
  }

  /** Lightweight background probe: is the stockpile shed incomplete? */
  async needsAttention(): Promise<{ needsWork: boolean; reason: string | null }> {
    const home = this.opts.state.home;
    if (home === null) return { needsWork: false, reason: "no home configured" };
    const measurement = measureStructure(this.opts.bot, baseLayoutFor(home));
    this.opts.bus.emit("structure.checked", {
      missingWalls: measurement.missingWalls,
      missingRoof: measurement.missingRoof,
      doorMissing: measurement.doorMissing,
      needsWork: measurement.needsWork,
    });
    return {
      needsWork: measurement.needsWork,
      reason: measurement.needsWork
        ? `${measurement.missingWalls} wall, ${measurement.missingRoof} roof blocks, door ${measurement.doorMissing ? "missing" : "ok"}`
        : null,
    };
  }

  private async execute(): Promise<SkillResult<BaseBuildData>> {
    const bot = this.opts.bot;
    const startedAt = Date.now();
    const baseline = itemsSummary(bot);
    const data: BaseBuildData = {
      missingBefore: 0,
      placedWalls: 0,
      placedRoof: 0,
      doorPlaced: false,
      decorated: 0,
      remaining: 0,
      interruptions: this.interruptions,
    };

    if (bot.entity === null) {
      return this.fail(data, "NOT_READY", "bot is not spawned");
    }
    const home = this.opts.state.home;
    if (home === null) {
      return this.fail(data, "NOT_READY", "no home coordinate configured");
    }
    const travel = await travelHomeAndWait(bot, home, {
      dimension: home.dimension,
      timeoutMs: TRAVEL_TIMEOUT_MS,
      shouldAbort: this.travelAbort,
      signal: this.signals?.signal,
    });
    if (this.stopRequested) return this.interrupted(data);
    if (travel.status !== "arrived" && travel.status !== "already_there") {
      return this.fail(data, "PATH_UNREACHABLE", `could not reach home: ${travel.status}`);
    }

    const layout = baseLayoutFor(home);
    const before = measureStructure(bot, layout);
    data.missingBefore = before.planksNeeded;
    if (!before.needsWork) {
      const complete = "The base structure is complete.";
      this.announce(complete);
      this.recordSuccess(data, startedAt, baseline, complete);
      return { ok: true, status: "completed", data, message: complete };
    }

    // 1. Planks for every missing wall, roof cell, and the door recipe.
    if (isCreativeMode(bot)) {
      const supplied = await ensureCreativeItem(bot, "oak_planks", before.planksNeeded, this.signals?.signal);
      if (supplied === null) {
        return this.fail(data, "INSUFFICIENT_MATERIALS", "creative mode did not provide enough oak planks");
      }
    } else if (before.planksNeeded > countPlanks(bot)) {
      const shortfall = before.planksNeeded - countPlanks(bot);
      const logsNeeded = Math.max(0, Math.ceil(shortfall / 4) - countLogs(bot));
      if (logsNeeded > 0) {
        const gathered = await this.gatherLogs(logsNeeded);
        if (this.stopRequested) return this.interrupted(data);
        if (!gathered.ok) return this.fail(data, "RESOURCE_NOT_FOUND", gathered.reason);
      }
      const planks = await craftPlanks(bot, before.planksNeeded, this.signals?.signal);
      if (this.stopRequested) return this.interrupted(data);
      if (!planks.ok) return this.fail(data, "INSUFFICIENT_MATERIALS", planks.reason);
    }

    // 2. A door item, when the gap is empty. The door recipe needs the home
    // crafting table; without one the door waits for the next run (bootstrap
    // re-establishes the table, and the probe keeps reporting the gap).
    if (before.doorMissing && findDoorItem(bot) === null) {
      if (isCreativeMode(bot)) await ensureCreativeItem(bot, "oak_door", 1, this.signals?.signal);
      const table = findBlockNear(bot, "crafting_table", TABLE_SCAN_RADIUS);
      if (findDoorItem(bot) !== null) {
        // Creative mode supplied the door directly.
      } else if (table !== null) {
        const door = await craftItem(bot, "oak_door", { craftingTable: table, signal: this.signals?.signal });
        if (!door.ok) {
          this.opts.logger.warn({ reason: door.reason }, "build_base: could not craft a door; leaving the gap");
        }
      } else {
        this.opts.logger.warn({}, "build_base: no crafting table at home; leaving the door gap");
      }
    }

    // 3. Place: bottom wall layer, top wall layer, roof (ring then inner),
    // then the door — the last block, so the shed encloses the build.
    const placedCells = new Set<string>();
    for (const cell of layout.wallCells) {
      this.checkInterrupt();
      if (this.stopRequested) break;
      if (!isAir(bot.blockAt(cell))) continue;
      const plank = findPlanksItem(bot);
      if (plank === null) break;
      const block = await placeAtCell(bot, plank, cell, placedCells, this.signals?.signal);
      if (block !== null) {
        placedCells.add(cellKey(cell));
        data.placedWalls += 1;
      }
    }
    if (!this.stopRequested) {
      for (const cell of layout.roofCells) {
        this.checkInterrupt();
        if (this.stopRequested) break;
        if (!isAir(bot.blockAt(cell))) continue;
        const plank = isCreativeMode(bot)
          ? await ensureCreativeItem(bot, "oak_planks", 1, this.signals?.signal)
          : findPlanksItem(bot);
        if (plank === null) break;
        const block = await placeAtCell(bot, plank, cell, placedCells, this.signals?.signal);
        if (block !== null) {
          placedCells.add(cellKey(cell));
          data.placedRoof += 1;
        }
      }
    }
    if (this.stopRequested) return this.interrupted(data);

    if (before.doorMissing) {
      const doorItem = findDoorItem(bot);
      if (doorItem !== null) {
        const lower = layout.doorCells[0]!;
        if (isAir(bot.blockAt(lower))) {
          const block = await placeAtCell(bot, doorItem, lower, placedCells, this.signals?.signal);
          if (block !== null && isDoorBlock(block)) {
            data.doorPlaced = true;
            placedCells.add(cellKey(lower));
          }
        }
      }
    }
    if (this.stopRequested) return this.interrupted(data);

    // 4. Re-measure: a partial pass returns partial and resumes later.
    const after = measureStructure(bot, layout);
    data.remaining = after.planksNeeded;
    const message =
      data.remaining === 0
        ? "Base structure built: walls, roof, and door at home."
        : `Base partially built: ${after.missingWalls} wall, ${after.missingRoof} roof, door ${after.doorMissing ? "missing" : "ok"} still to go.`;
    this.announce(message);
    this.recordSuccess(data, startedAt, baseline, message);
    return {
      ok: true,
      status: data.remaining === 0 ? "completed" : "partial",
      data,
      message,
    };
  }

  /**
   * Gather raw logs until at least `targetTotal` are carried. Same search-
   * and-collect mechanics as the bootstrap WOOD stage and organize-storage;
   * a hard collection error aborts the search.
   */
  private async gatherLogs(targetTotal: number): Promise<{ ok: true; have: number } | { ok: false; reason: string }> {
    const bot = this.opts.bot;
    this.checkInterrupt();
    if (this.stopRequested) return { ok: false, reason: "interrupted" };
    // Structures accept the whole approved plank family. Do not force the
    // resource runner to search for oak when another wood species is already
    // available nearby (or is the only tree type in the area).
    const carriedPlank = bot.inventory.items().find((item) => isPlanksItemName(item.name));
    const carriedWood = carriedPlank === undefined
      ? null
      : `${bareName(carriedPlank.name).replace(/_planks$/, "")}_log`;
    const nearbyLog = findBlocksNear(bot, isRawLog, MAX_LOG_SEARCH_RADIUS, 1)
      .map((position) => bot.blockAt(position))
      .find((block): block is Block => block !== null);
    const logType = carriedWood ?? nearbyLog?.name ?? "oak_log";
    const gathered = await this.opts.collect.run(logType, targetTotal, {
      signals: this.signals ?? undefined,
      userRequested: true,
      deliver: false,
    });
    if (this.stopRequested) return { ok: false, reason: "interrupted" };
    const have = countLogs(bot);
    if (have >= targetTotal) return { ok: true, have };
    return { ok: false, reason: gathered.message ?? `only ${have}/${targetTotal} logs gathered` };
  }

  // --- Phase 8 cooperative interrupt plumbing (mirrors organize-storage) ---

  private checkInterrupt(progress: Partial<BaseResumeState> = {}): void {
    if (this.stopRequested || this.signals === null) return;
    const payload: BaseResumeState = { interruptions: this.interruptions + 1, ...progress };
    if (!this.signals.checkpoint(payload)) {
      this.stopRequested = true;
      this.interruptions += 1;
    }
  }

  /** Abort probe for travel waits: polls the signals while the bot walks. */
  private travelAbort = (): boolean => {
    this.checkInterrupt();
    return this.stopRequested;
  };

  /** Terminal result for a paused/cancelled run. */
  private interrupted(data: BaseBuildData): SkillResult<BaseBuildData> {
    data.interruptions = this.interruptions;
    this.opts.logger.info(
      { walls: data.placedWalls, roof: data.placedRoof, door: data.doorPlaced },
      "build_base interrupted",
    );
    return { ok: false, status: "interrupted", retryable: true, data, message: "interrupted" };
  }

  private fail(
    data: BaseBuildData,
    errorCode: "NOT_READY" | "PATH_UNREACHABLE" | "RESOURCE_NOT_FOUND" | "INSUFFICIENT_MATERIALS",
    reason: string,
  ): SkillResult<BaseBuildData> {
    this.announce(`Stuck: ${reason}.`);
    return { ok: false, status: "failed", errorCode, message: reason, retryable: true, data };
  }

  private announce(message: string): void {
    this.opts.logger.info({ message }, "build_base status");
    if (this.opts.bot.entity === null) return;
    if (!this.chatThrottle.allow(message)) return;
    if (!gameChatBudgetAllows()) return;
    try {
      this.opts.bot.chat(message);
    } catch (err) {
      this.opts.logger.warn({ err: String(err) }, "build_base chat failed");
    }
  }

  /** Persist one SkillSuccess for a completed build run (spec 20.2). */
  private recordSuccess(
    data: BaseBuildData,
    startedAt: number,
    baseline: Record<string, number>,
    description: string,
  ): void {
    const worldId = this.opts.state.worldId;
    if (worldId === null) return;
    const home = this.opts.state.home;
    const self = this.opts.bot.entity;
    const summary = itemsSummary(this.opts.bot);
    const delta: Record<string, number> = {};
    for (const [name, count] of Object.entries(summary)) {
      const before = baseline[name] ?? 0;
      if (count !== before) delta[name] = count - before;
    }
    const distance =
      self !== null && home !== null
        ? Math.round(Math.hypot(self.position.x - home.x, self.position.y - home.y, self.position.z - home.z))
        : -1;
    this.opts.skills.record({
      skillName: "build_base",
      parameters: {
        wallsPlaced: data.placedWalls,
        roofPlaced: data.placedRoof,
        doorPlaced: data.doorPlaced,
        remaining: data.remaining,
      },
      startingConditions: {
        inventorySummary: baseline,
        homeDistance: distance,
        timeOfDay: this.opts.bot.time && this.opts.bot.time.isDay ? "day" : "night",
      },
      outcome: {
        durationMs: Math.max(0, Date.now() - startedAt),
        interruptions: data.interruptions,
        finalInventoryDelta: delta,
      },
      description,
    });
  }
}
