import type { Bot } from "mineflayer";
import type { Logger } from "pino";
import type { Item } from "prismarine-item";
import { Vec3 } from "vec3";
import { travelAndWait } from "../minecraft/movement.js";
import { classifyObservedBlock } from "../terrain/classification.js";
import { deterministicSerpentine, mineshaftSegment } from "../terrain/geometry.js";
import { TerrainMutationService } from "../terrain/mutation.js";
import type { BlockBounds, CardinalDirection, FrozenTerrainPlan, MineshaftSpec } from "../terrain/schema.js";
import type { TaskSignals } from "../agent/scheduler.js";
import type { SkillResult } from "./skill-library.js";

export interface TerrainCursor {
  nextIndex: number;
  removed: number;
  verified: number;
  skipped: number;
}

export interface AccessRampPlan {
  /** A reserved edge column is geometry, not a per-block progress record. */
  edge: "minX" | "maxX" | "minZ" | "maxZ";
  cells: readonly { x: number; y: number; z: number }[];
}

export interface SafeWorkPose {
  position: { x: number; y: number; z: number };
}

export interface TerrainRunnerOptions {
  mutation?: TerrainMutationService;
  maxBlocksPerSlice?: number;
  logger?: Logger;
  loadoutPolicy?: TerrainLoadoutPolicy;
}

/** Survival reserve checked before each terrain atomic operation. */
export interface TerrainLoadoutPolicy {
  minFreeSlots: number;
  minToolReserve: number;
}

export const DEFAULT_TERRAIN_LOADOUT_POLICY: TerrainLoadoutPolicy = {
  minFreeSlots: 1,
  minToolReserve: 1,
};

/** Inventory gate; required-tool selection and durability remain owned by mutation.ts. */
export function checkTerrainLoadout(bot: Bot, policy = DEFAULT_TERRAIN_LOADOUT_POLICY): SkillResult<void> {
  const inventory = bot.inventory;
  if (inventory !== undefined && inventory.emptySlotCount() < policy.minFreeSlots) {
    return { ok: false, status: "blocked", errorCode: "INVENTORY_FULL", message: "terrain work needs inventory headroom for drops", retryable: true };
  }
  return { ok: true, status: "completed" };
}

export interface ExcavationRunOptions {
  signals: TaskSignals;
  resumeState?: TerrainCursor;
}

export interface ExcavationSliceData extends TerrainCursor {
  complete: boolean;
  total: number;
  ramp: AccessRampPlan;
}

export interface SurfaceRunOptions {
  signals: TaskSignals;
  resumeState?: TerrainCursor;
  walkingY?: number;
}

export interface FlattenColumnPlan {
  x: number;
  z: number;
  walkingY: number;
  cut: readonly { x: number; y: number; z: number }[];
  fill: readonly { x: number; y: number; z: number }[];
}

export interface SurfaceSliceData extends TerrainCursor {
  complete: boolean;
  total: number;
  columns: readonly FlattenColumnPlan[];
}

export interface MineshaftResumeState {
  lastVerifiedSegment: number;
  lastSafeWaypoint: { x: number; y: number; z: number };
  routeStatus: "verified" | "lost";
}

export interface MineshaftRunOptions {
  signals: TaskSignals;
  resumeState?: MineshaftResumeState;
}

export interface MineshaftSliceData extends MineshaftResumeState {
  complete: boolean;
  totalSegments: number;
  direction: CardinalDirection;
  endpoint: { x: number; y: number; z: number };
}

export interface TerrainRunOptions extends TerrainRunnerOptions {
  signals: TaskSignals;
  resumeState?: TerrainCursor | MineshaftResumeState;
  walkingY?: number;
}

export const MAX_FLATTEN_CUT = 16;
export const MAX_FLATTEN_FILL = 16;
const FILL_PREFERENCE = ["dirt", "cobblestone", "stone", "netherrack"] as const;

function positionKey(position: { x: number; y: number; z: number }): string {
  return `${position.x},${position.y},${position.z}`;
}

function cells(bounds: BlockBounds): Array<{ x: number; y: number; z: number }> {
  return [...deterministicSerpentine(bounds)].map(({ x, y, z }) => ({ x, y, z }));
}

function blockError(name: string | undefined): "LAVA_HAZARD" | "WATER_HAZARD" {
  return name?.replace(/^minecraft:/, "").includes("lava") ? "LAVA_HAZARD" : "WATER_HAZARD";
}

/** A preserved sand/gravel ground column is stable when it reaches solid support. */
function hasStableFallingSupport(bot: Bot, x: number, y: number, z: number, maxDepth = 16): boolean {
  for (let depth = 1; depth <= maxDepth; depth += 1) {
    const state = classifyObservedBlock(bot.blockAt(new Vec3(x, y - depth, z)));
    if (state === "solid") return true;
    if (state !== "falling") return false;
  }
  return false;
}

function preflightSurface(bot: Bot, bounds: BlockBounds, walkingY: number): SkillResult<void> {
  if (!Number.isInteger(walkingY) || walkingY < bounds.minY || walkingY > bounds.maxY) return { ok: false, status: "blocked", errorCode: "UNSAFE_GEOMETRY", message: "walking plane is outside the authorized terrain bounds", retryable: false };
  return preflightCells(bot, bounds, bounds.minY - 1);
}

/**
 * Shared terrain preflight. Sand and gravel are ordinary terrain (the dig
 * primitive re-digs refills), water cells are skipped by the slice, and an
 * unloaded chunk is a retryable wait, not a verdict. Lava, fixtures, and
 * unbreakable blocks still stop the project.
 */
function preflightCells(bot: Bot, bounds: BlockBounds, fromY: number): SkillResult<void> {
  for (let y = fromY; y <= bounds.maxY; y += 1) for (let z = bounds.minZ; z <= bounds.maxZ; z += 1) for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
    const block = bot.blockAt(new Vec3(x, y, z));
    const state = classifyObservedBlock(block);
    if (state === "unobserved") return { ok: false, status: "blocked", errorCode: "WORLD_NOT_OBSERVED", message: `terrain cell (${x}, ${y}, ${z}) is not loaded yet`, retryable: true };
    if (state === "fluid" && blockError(block?.name) === "LAVA_HAZARD") return { ok: false, status: "blocked", errorCode: "LAVA_HAZARD", message: `terrain cell (${x}, ${y}, ${z}) contains lava`, retryable: false };
    if (state === "protectedFixture" && y >= bounds.minY) return { ok: false, status: "blocked", errorCode: "PROTECTED_FIXTURE", message: `protected fixture at (${x}, ${y}, ${z})`, retryable: false };
    if (state === "unbreakable" && y >= bounds.minY) return { ok: false, status: "blocked", errorCode: "UNBREAKABLE_BLOCK", message: `unbreakable block at (${x}, ${y}, ${z})`, retryable: false };
  }
  return { ok: true, status: "completed" };
}

/**
 * Wait until the chunks under a work area have arrived. Right after spawn or
 * a restart the server is still streaming chunks, and every cell reads as
 * unobserved; inspecting then turns a routine resume into a false block.
 */
export async function waitForTerrainObserved(bot: Bot, bounds: BlockBounds, signal?: AbortSignal, timeoutMs = 15_000): Promise<boolean> {
  const midX = Math.floor((bounds.minX + bounds.maxX) / 2);
  const midZ = Math.floor((bounds.minZ + bounds.maxZ) / 2);
  const probes = [
    { x: bounds.minX, z: bounds.minZ }, { x: bounds.maxX, z: bounds.minZ }, { x: bounds.minX, z: bounds.maxZ },
    { x: bounds.maxX, z: bounds.maxZ }, { x: midX, z: midZ },
  ].map((point) => new Vec3(point.x, bounds.minY, point.z));
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (probes.every((probe) => bot.blockAt(probe) !== null)) return true;
    if (Date.now() >= deadline || signal?.aborted === true) return false;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** Load chunks and give a player standing in the work area time to step out. */
async function prepareWorkArea(bot: Bot, bounds: BlockBounds, signal: AbortSignal): Promise<SkillResult<void>> {
  try {
    await Promise.race([bot.waitForChunksToLoad(), new Promise((resolve) => setTimeout(resolve, 10_000))]);
  } catch { /* best effort */ }
  if (!playerInWorkBuffer(bot, bounds)) return { ok: true, status: "completed" };
  try { bot.chat("Please step out of the work area."); } catch { /* chat is best effort */ }
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (signal.aborted) return { ok: false, status: "interrupted", message: "terrain work cancelled", retryable: true };
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    if (!playerInWorkBuffer(bot, bounds)) return { ok: true, status: "completed" };
  }
  return { ok: false, status: "blocked", errorCode: "UNSAFE_GEOMETRY", message: "a player is standing in the work area", retryable: true };
}

function flattenPlans(bot: Bot, bounds: BlockBounds, walkingY: number): SkillResult<FlattenColumnPlan[]> {
  const plans: FlattenColumnPlan[] = [];
  for (let z = bounds.minZ; z <= bounds.maxZ; z += 1) for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
    const cut: Array<{ x: number; y: number; z: number }> = [];
    for (let y = bounds.maxY; y >= walkingY; y -= 1) {
      const state = classifyObservedBlock(bot.blockAt(new Vec3(x, y, z)));
      if (state === "solid") cut.push({ x, y, z });
      else if (state !== "passable") return { ok: false, status: "blocked", errorCode: state === "fluid" ? blockError(bot.blockAt(new Vec3(x, y, z))?.name) : state === "falling" ? "FALLING_BLOCKS_UNSTABLE" : state === "unobserved" ? "WORLD_NOT_OBSERVED" : state === "protectedFixture" ? "PROTECTED_FIXTURE" : "UNBREAKABLE_BLOCK", message: `cannot cut column (${x}, ${z}) safely`, retryable: false };
    }
    const fill: Array<{ x: number; y: number; z: number }> = [];
    let foundSupport = false;
    for (let y = walkingY - 1; y >= bounds.minY - 1; y -= 1) {
      const block = bot.blockAt(new Vec3(x, y, z));
      const state = classifyObservedBlock(block);
      if (state === "solid") { foundSupport = true; break; }
      if (state !== "passable") return { ok: false, status: "blocked", errorCode: state === "fluid" ? blockError(block?.name) : state === "falling" ? "FALLING_BLOCKS_UNSTABLE" : state === "unobserved" ? "WORLD_NOT_OBSERVED" : state === "protectedFixture" ? "PROTECTED_FIXTURE" : "UNBREAKABLE_BLOCK", message: `cannot fill column (${x}, ${z}) safely`, retryable: false };
      if (y >= bounds.minY) fill.push({ x, y, z });
    }
    if (!foundSupport) return { ok: false, status: "blocked", errorCode: "UNSAFE_GEOMETRY", message: `column (${x}, ${z}) has no observed solid support`, retryable: false };
    if (cut.length > MAX_FLATTEN_CUT) return { ok: false, status: "blocked", errorCode: "UNSAFE_GEOMETRY", message: `column (${x}, ${z}) exceeds the maximum cut`, retryable: false };
    if (fill.length > MAX_FLATTEN_FILL) return { ok: false, status: "blocked", errorCode: "UNSAFE_GEOMETRY", message: `column (${x}, ${z}) exceeds the maximum fill`, retryable: false };
    plans.push({ x, z, walkingY, cut, fill: fill.reverse() });
  }
  return { ok: true, status: "completed", data: plans };
}

function fillItem(bot: Bot): Item | null {
  const items = bot.inventory?.items?.() ?? [];
  for (const name of FILL_PREFERENCE) {
    const found = items.find((item) => item.name.replace(/^minecraft:/, "") === name);
    if (found) return found;
  }
  return null;
}

async function runSurfaceSlice(bot: Bot, plan: FrozenTerrainPlan, options: SurfaceRunOptions & TerrainRunnerOptions, kind: "clear" | "flatten"): Promise<SkillResult<SurfaceSliceData>> {
  const bounds = plan.bounds;
  const walkingY = options.walkingY ?? bounds.maxY;
  const prepared = await prepareWorkArea(bot, bounds, options.signals.signal);
  if (!prepared.ok) {
    const { data: _unused, ...failure } = prepared;
    return failure;
  }
  const checked = preflightSurface(bot, bounds, walkingY);
  if (!checked.ok) {
    const { data: _unused, ...failure } = checked;
    return failure;
  }
  const flatten = kind === "flatten" ? flattenPlans(bot, bounds, walkingY) : null;
  if (flatten !== null && (!flatten.ok || flatten.data === undefined)) {
    const { data: _unused, ...failure } = flatten;
    return failure;
  }
  const columns = flatten?.data ?? [];
  const ordered = kind === "clear" ? cells(bounds) : columns.flatMap((column) => [...column.cut, ...column.fill]);
  const cursor = { ...(options.resumeState ?? { nextIndex: 0, removed: 0, verified: 0, skipped: 0 }) };
  const limit = Math.max(1, Math.floor(options.maxBlocksPerSlice ?? 32));
  const mutation = options.mutation ?? new TerrainMutationService(bot);
  const item = kind === "flatten" && columns.some((column) => column.fill.length > 0) ? fillItem(bot) : null;
  if (kind === "flatten" && columns.some((column) => column.fill.length > 0) && item === null) return { ok: false, status: "blocked", errorCode: "INSUFFICIENT_MATERIALS", message: "flatten requires an approved fill block", retryable: false };
  let worked = 0;
  for (; cursor.nextIndex < ordered.length && worked < limit; cursor.nextIndex += 1) {
    if (!options.signals.checkpoint({ phase: kind, nextIndex: cursor.nextIndex, removed: cursor.removed, verified: cursor.verified, skipped: cursor.skipped })) return { ok: false, status: "interrupted", message: `${kind} paused at a safe checkpoint`, retryable: true, data: { ...cursor, complete: false, total: ordered.length, columns } };
    const target = ordered[cursor.nextIndex];
    if (target === undefined) break;
    const loadout = checkTerrainLoadout(bot, options.loadoutPolicy);
    if (!loadout.ok) return { ...loadout, data: { ...cursor, complete: false, total: ordered.length, columns } };
    if (kind === "flatten" && columns.some((column) => column.fill.some((cell) => positionKey(cell) === positionKey(target)))) {
      const reference = bot.blockAt(new Vec3(target.x, target.y - 1, target.z));
      if (item === null || reference === null) return { ok: false, status: "blocked", errorCode: "UNSAFE_GEOMETRY", message: "flatten fill reference is unavailable", retryable: false };
      const placed = await mutation.placeSupport(item, reference, { x: 0, y: 1, z: 0 }, target, options.signals.signal);
      if (!placed.ok) return { ...placed, data: { ...cursor, complete: false, total: ordered.length, columns } };
    } else {
      const state = classifyObservedBlock(bot.blockAt(new Vec3(target.x, target.y, target.z)));
      if (state === "passable") { cursor.verified += 1; continue; }
      if (state === "fluid") { cursor.skipped += 1; continue; }
      const pose = await findSafeWorkPose(bot, target, bounds, options.signals.signal);
      if (!pose.ok) return { ...pose, data: { ...cursor, complete: false, total: ordered.length, columns } };
      const broken = await mutation.breakAndVerify(target, options.signals.signal);
      if (!broken.ok) return { ...broken, data: { ...cursor, complete: false, total: ordered.length, columns } };
      cursor.removed += 1;
    }
    cursor.verified += 1; worked += 1;
  }
  const complete = cursor.nextIndex >= ordered.length;
  return { ok: true, status: complete ? "completed" : "partial", data: { ...cursor, complete, total: ordered.length, columns }, message: complete ? `${kind} slice complete` : `${kind} slice checkpointed`, retryable: !complete };
}

/** Choose a stable one-block-wide edge route without expanding authorization. */
export function chooseAccessRamp(bounds: BlockBounds): AccessRampPlan | null {
  const width = bounds.maxX - bounds.minX + 1;
  const length = bounds.maxZ - bounds.minZ + 1;
  if (width < 2 && length < 2) return null;
  const edge: AccessRampPlan["edge"] = width >= length ? "minX" : "minZ";
  const ramp: Array<{ x: number; y: number; z: number }> = [];
  if (edge === "minX") {
    for (let y = bounds.maxY; y >= bounds.minY; y -= 1) ramp.push({ x: bounds.minX, y, z: bounds.minZ });
  } else {
    for (let y = bounds.maxY; y >= bounds.minY; y -= 1) ramp.push({ x: bounds.minX, y, z: bounds.minZ });
  }
  return { edge, cells: ramp };
}

function playerInWorkBuffer(bot: Bot, bounds: BlockBounds): boolean {
  return Object.values(bot.players ?? {}).some((player) => {
    if (player.username === bot.username) return false;
    const p = player.entity?.position;
    return p !== undefined && p.x >= bounds.minX - 1 && p.x <= bounds.maxX + 1 && p.y >= bounds.minY - 1 && p.y <= bounds.maxY + 2 && p.z >= bounds.minZ - 1 && p.z <= bounds.maxZ + 1;
  });
}

function pointInBounds(point: { x: number; y: number; z: number }, bounds: BlockBounds): boolean {
  return point.x >= bounds.minX && point.x <= bounds.maxX && point.y >= bounds.minY && point.y <= bounds.maxY && point.z >= bounds.minZ && point.z <= bounds.maxZ;
}

function directionFromFrozenGeometry(plan: FrozenTerrainPlan, spec: MineshaftSpec): CardinalDirection | null {
  if (spec.direction !== undefined) return spec.direction;
  const { anchor, bounds } = plan;
  if (anchor.z > bounds.maxZ) return "north";
  if (anchor.z < bounds.minZ) return "south";
  if (anchor.x > bounds.maxX) return "west";
  if (anchor.x < bounds.minX) return "east";
  return null;
}

function forwardOffset(direction: CardinalDirection): { x: number; z: number } {
  if (direction === "north") return { x: 0, z: -1 };
  if (direction === "south") return { x: 0, z: 1 };
  if (direction === "east") return { x: 1, z: 0 };
  return { x: -1, z: 0 };
}

function waypoint(anchor: { x: number; y: number; z: number }, direction: CardinalDirection, width: 1 | 2, segment: number): { x: number; y: number; z: number } {
  const cross = -Math.floor(width / 2);
  const offset = forwardOffset(direction);
  return { x: anchor.x + offset.x * segment + (direction === "north" || direction === "south" ? cross : 0), y: anchor.y - segment + 1, z: anchor.z + offset.z * segment + (direction === "east" || direction === "west" ? cross : 0) };
}

function stateFailure(state: ReturnType<typeof classifyObservedBlock>, name: string | null): SkillResult<never> {
  if (state === "fluid") return { ok: false, status: "blocked", errorCode: name?.replace(/^minecraft:/, "").includes("lava") ? "LAVA_HAZARD" : "WATER_HAZARD", message: "mineshaft intersects a fluid", retryable: false };
  if (state === "falling") return { ok: false, status: "blocked", errorCode: "FALLING_BLOCKS_UNSTABLE", message: "mineshaft contains unsettled falling material", retryable: false };
  if (state === "unobserved") return { ok: false, status: "blocked", errorCode: "WORLD_NOT_OBSERVED", message: "mineshaft route is not loaded yet", retryable: true };
  if (state === "protectedFixture") return { ok: false, status: "blocked", errorCode: "PROTECTED_FIXTURE", message: "mineshaft intersects a protected fixture", retryable: false };
  return { ok: false, status: "blocked", errorCode: "UNBREAKABLE_BLOCK", message: "mineshaft intersects an unbreakable block", retryable: false };
}

function inspectMineshaftSegment(bot: Bot, plan: FrozenTerrainPlan, direction: CardinalDirection, segment: number): SkillResult<{ bounds: BlockBounds; floor: Array<{ x: number; y: number; z: number }>; cells: Array<{ x: number; y: number; z: number }>; missingFloor: Array<{ x: number; y: number; z: number }> }> {
  const spec = plan.specification;
  if (spec.kind !== "mineshaft") return { ok: false, status: "failed", errorCode: "INVALID_RESOURCE", message: "not a mineshaft plan", retryable: false };
  const bounds = mineshaftSegment(plan.anchor, direction, spec.width, spec.height, segment);
  const cells: Array<{ x: number; y: number; z: number }> = [];
  const floor: Array<{ x: number; y: number; z: number }> = [];
  for (let y = bounds.maxY; y >= bounds.minY; y -= 1) for (let z = bounds.minZ; z <= bounds.maxZ; z += 1) for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
    if (!pointInBounds({ x, y, z }, plan.bounds)) return { ok: false, status: "blocked", errorCode: "UNSAFE_GEOMETRY", message: "mineshaft segment exceeds frozen authorization geometry", retryable: false };
    const block = bot.blockAt(new Vec3(x, y, z));
    const state = classifyObservedBlock(block);
    // Sand/gravel is dug like stone (refills are re-dug); water is only a
    // nuisance. Lava, fixtures, and unloaded cells still stop the shaft.
    const tolerable = state === "passable" || state === "solid" || state === "falling"
      || (state === "fluid" && !String(block?.name ?? "").includes("lava"));
    if (!tolerable) return stateFailure(state, block?.name ?? null);
    cells.push({ x, y, z });
  }
  const missingFloor: Array<{ x: number; y: number; z: number }> = [];
  for (let z = bounds.minZ; z <= bounds.maxZ; z += 1) for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
    const position = { x, y: bounds.minY - 1, z };
    if (!pointInBounds(position, plan.bounds)) return { ok: false, status: "blocked", errorCode: "UNSAFE_GEOMETRY", message: "mineshaft floor exceeds frozen authorization geometry", retryable: false };
    const block = bot.blockAt(new Vec3(position.x, position.y, position.z));
    const state = classifyObservedBlock(block);
    if (state === "solid" || state === "falling") { floor.push(position); continue; }
    // A cave under the stairway: the shaft bridges it with a placed floor.
    if (state === "passable" || (state === "fluid" && !String(block?.name ?? "").includes("lava"))) { missingFloor.push(position); floor.push(position); continue; }
    return stateFailure(state, block?.name ?? null);
  }
  return { ok: true, status: "completed", data: { bounds, floor, cells, missingFloor } };
}

function checkExposedFaces(bot: Bot, bounds: BlockBounds, direction: CardinalDirection): SkillResult<void> {
  const side = direction === "north" || direction === "south" ? [{ x: bounds.minX - 1, z: bounds.minZ }, { x: bounds.maxX + 1, z: bounds.minZ }] : [{ x: bounds.minX, z: bounds.minZ - 1 }, { x: bounds.minX, z: bounds.maxZ + 1 }];
  for (const face of side) for (let y = bounds.minY; y <= bounds.maxY; y += 1) {
    const block = bot.blockAt(new Vec3(face.x, y, face.z));
    const state = classifyObservedBlock(block);
    // Caves beside a stairway are normal underground; only lava is a
    // reason to stop (it would flow into the corridor).
    if (state === "fluid" && String(block?.name ?? "").includes("lava")) return stateFailure(state, block?.name ?? null);
    if (state === "unobserved") return stateFailure(state, block?.name ?? null);
  }
  return { ok: true, status: "completed" };
}

/** Return a bounded, observed standing position beside a target. */
const EYE_HEIGHT = 1.62;
/** Vanilla block interaction range, measured to the block's nearest point. */
const BLOCK_REACH = 4.5;

/** Distance from `eye` to the nearest point of the unit block at `block`. */
export function reachToBlock(eye: { x: number; y: number; z: number }, block: { x: number; y: number; z: number }): number {
  const gap = (value: number, min: number): number => Math.max(min - value, 0, value - (min + 1));
  return Math.hypot(gap(eye.x, block.x), gap(eye.y, block.y), gap(eye.z, block.z));
}

export async function findSafeWorkPose(bot: Bot, target: { x: number; y: number; z: number }, bounds: BlockBounds, signal: AbortSignal): Promise<SkillResult<SafeWorkPose>> {
  // Mineflayer digs from eye height, so a bot standing on the walking plane
  // can safely reach several blocks above its feet. Restricting candidates
  // to the target's Y (or higher) made ordinary four-block-tall vegetation
  // impossible to clear because there is naturally no floating floor beside
  // its top block. Include bounded lower stances and try the nearest first.
  // Stances may sit below the prism: a clear anchored on a rise spans air
  // over lower ground, and a tree's canopy is reached from that ground.
  const lowestY = target.y - 6;
  const heights = Array.from({ length: target.y - lowestY + 2 }, (_, index) => lowestY + index);
  const self = bot.entity?.position;
  const candidates = heights.flatMap((y) => [
    { x: target.x - 1, y, z: target.z },
    { x: target.x + 1, y, z: target.z },
    { x: target.x, y, z: target.z - 1 },
    { x: target.x, y, z: target.z + 1 },
  ]).sort((a, b) => self === undefined ? a.y - b.y : Math.hypot(self.x - a.x, self.y - a.y, self.z - a.z) - Math.hypot(self.x - b.x, self.y - b.y, self.z - b.z));
  for (const candidate of candidates) {
    const feet = classifyObservedBlock(bot.blockAt(new Vec3(candidate.x, candidate.y, candidate.z)));
    const head = classifyObservedBlock(bot.blockAt(new Vec3(candidate.x, candidate.y + 1, candidate.z)));
    const floor = classifyObservedBlock(bot.blockAt(new Vec3(candidate.x, candidate.y - 1, candidate.z)));
    if (feet !== "passable" || head !== "passable" || floor !== "solid") continue;
    if (reachToBlock({ x: candidate.x + 0.5, y: candidate.y + EYE_HEIGHT, z: candidate.z + 0.5 }, target) > BLOCK_REACH) continue;
    if (self && Math.hypot(self.x - candidate.x, self.y - candidate.y, self.z - candidate.z) <= 3) return { ok: true, status: "completed", data: { position: candidate } };
    const travel = await travelAndWait(bot, candidate, { range: 1.5, timeoutMs: 30_000, signal });
    if (travel.status === "arrived" || travel.status === "already_there") return { ok: true, status: "completed", data: { position: candidate } };
  }
  // No tidy standing cell beside the target: let the pathfinder get within
  // arm's reach any way it can (it only digs natural terrain), then dig from
  // wherever it stopped.
  const inReach = (): boolean => {
    const eye = bot.entity?.position.offset(0, EYE_HEIGHT, 0);
    return eye !== undefined && reachToBlock(eye, target) <= BLOCK_REACH;
  };
  if (!inReach()) await travelAndWait(bot, target, { range: 3, timeoutMs: 45_000, signal });
  if (inReach()) {
    const feet = bot.entity!.position.floored();
    return { ok: true, status: "completed", data: { position: { x: feet.x, y: feet.y, z: feet.z } } };
  }
  return { ok: false, status: "blocked", errorCode: "UNREACHABLE_BLOCK", message: `no safe work pose for (${target.x}, ${target.y}, ${target.z})`, retryable: true };
}

function preflight(bot: Bot, bounds: BlockBounds): SkillResult<{ ramp: AccessRampPlan }> {
  const ramp = chooseAccessRamp(bounds);
  if (ramp === null) return { ok: false, status: "blocked", errorCode: "UNSAFE_GEOMETRY", message: "excavation needs at least a two-block access edge; use a mineshaft for a narrow site", retryable: false };
  const cellsOk = preflightCells(bot, bounds, bounds.minY);
  if (!cellsOk.ok) {
    const { data: _unused, ...failure } = cellsOk;
    return failure;
  }
  return { ok: true, status: "completed", data: { ramp } };
}

export async function runExcavationSlice(bot: Bot, plan: FrozenTerrainPlan, options: ExcavationRunOptions & TerrainRunnerOptions): Promise<SkillResult<ExcavationSliceData>> {
  const bounds = plan.bounds;
  const prepared = await prepareWorkArea(bot, bounds, options.signals.signal);
  if (!prepared.ok) {
    const { data: _unused, ...failure } = prepared;
    return failure;
  }
  const checked = preflight(bot, bounds);
  if (!checked.ok || checked.data === undefined) {
    const { data: _unused, ...failure } = checked;
    return failure;
  }
  const ordered = cells(bounds);
  const initial: TerrainCursor = options.resumeState ?? { nextIndex: 0, removed: 0, verified: 0, skipped: 0 };
  const cursor: TerrainCursor = { ...initial };
  const limit = Math.max(1, Math.floor(options.maxBlocksPerSlice ?? 32));
  const mutation = options.mutation ?? new TerrainMutationService(bot);
  let worked = 0;
  for (; cursor.nextIndex < ordered.length && worked < limit; cursor.nextIndex += 1) {
    if (!options.signals.checkpoint({ phase: "excavate", nextIndex: cursor.nextIndex, removed: cursor.removed, verified: cursor.verified, skipped: cursor.skipped })) {
      return { ok: false, status: "interrupted", message: "excavation paused at a safe checkpoint", retryable: true, data: { ...cursor, complete: false, total: ordered.length, ramp: checked.data.ramp } };
    }
    const target = ordered[cursor.nextIndex];
    if (target === undefined) break;
    const loadout = checkTerrainLoadout(bot, options.loadoutPolicy);
    if (!loadout.ok) return { ...loadout, data: { ...cursor, complete: false, total: ordered.length, ramp: checked.data.ramp } };
    const state = classifyObservedBlock(bot.blockAt(new Vec3(target.x, target.y, target.z)));
    if (state === "passable") { cursor.verified += 1; continue; }
    if (state === "fluid") { cursor.skipped += 1; continue; }
    const pose = await findSafeWorkPose(bot, target, bounds, options.signals.signal);
    if (!pose.ok) return { ...pose, data: { ...cursor, complete: false, total: ordered.length, ramp: checked.data.ramp } };
    const result = await mutation.breakAndVerify(target, options.signals.signal);
    if (!result.ok) return { ...result, data: { ...cursor, complete: false, total: ordered.length, ramp: checked.data.ramp } };
    cursor.removed += 1; cursor.verified += 1; worked += 1;
  }
  const complete = cursor.nextIndex >= ordered.length;
  const data = { ...cursor, complete, total: ordered.length, ramp: checked.data.ramp };
  return { ok: true, status: complete ? "completed" : "partial", data, message: complete ? "excavation slice complete" : "excavation slice checkpointed", retryable: !complete };
}

/** Verify that a corridor can be traversed in either direction without digging. */
export function verifyNoDigRoute(bot: Bot, plan: FrozenTerrainPlan, direction: CardinalDirection, lastSegment: number): SkillResult<{ segments: number; endpoint: { x: number; y: number; z: number } }> {
  const spec = plan.specification;
  if (spec.kind !== "mineshaft") return { ok: false, status: "failed", errorCode: "INVALID_RESOURCE", message: "not a mineshaft plan", retryable: false };
  for (let segment = 0; segment <= lastSegment; segment += 1) {
    const inspected = inspectMineshaftSegment(bot, plan, direction, segment);
    if (!inspected.ok || inspected.data === undefined) return { ok: false, status: inspected.status, errorCode: inspected.errorCode, message: inspected.message, retryable: inspected.retryable };
    for (const cell of inspected.data.cells) {
      if (classifyObservedBlock(bot.blockAt(new Vec3(cell.x, cell.y, cell.z))) !== "passable") return { ok: false, status: "blocked", errorCode: "RETURN_ROUTE_LOST", message: `mineshaft route is blocked at segment ${segment}`, retryable: false };
    }
  }
  const endpoint = waypoint(plan.anchor, direction, spec.width, lastSegment);
  return { ok: true, status: "completed", data: { segments: lastSegment + 1, endpoint }, message: "mineshaft route verified in both directions" };
}

function lightItem(bot: Bot): Item | null {
  return (bot.inventory?.items?.() ?? []).find((item) => item.name.replace(/^minecraft:/, "") === "torch") ?? null;
}

async function placePlannedLight(bot: Bot, mutation: TerrainMutationService, plan: FrozenTerrainPlan, direction: CardinalDirection, segment: number, signal: AbortSignal): Promise<SkillResult<void>> {
  if (segment === 0 || segment % 8 !== 0) return { ok: true, status: "completed" };
  const spec = plan.specification;
  if (spec.kind !== "mineshaft") return { ok: false, status: "failed", errorCode: "INVALID_RESOURCE", message: "not a mineshaft plan", retryable: false };
  const item = lightItem(bot);
  if (item === null) return { ok: true, status: "completed", message: "no torch available for this planned light interval" };
  const segmentBounds = mineshaftSegment(plan.anchor, direction, spec.width, spec.height, segment);
  const wall = direction === "north" || direction === "south" ? { x: segmentBounds.minX, y: segmentBounds.minY, z: segmentBounds.minZ } : { x: segmentBounds.minX, y: segmentBounds.minY, z: segmentBounds.minZ };
  const referencePosition = direction === "north" || direction === "south" ? { x: wall.x - 1, y: wall.y, z: wall.z } : { x: wall.x, y: wall.y, z: wall.z - 1 };
  const reference = bot.blockAt(new Vec3(referencePosition.x, referencePosition.y, referencePosition.z));
  if (reference === null || classifyObservedBlock(reference) !== "solid") return { ok: false, status: "blocked", errorCode: "CAVE_OPENING", message: "planned light has no safe wall reference", retryable: false };
  const placed = await mutation.placeLight(item, reference, direction === "north" || direction === "south" ? { x: 1, y: 0, z: 0 } : { x: 0, y: 0, z: 1 }, wall, signal);
  if (!placed.ok) return { ...placed, data: undefined };
  return { ok: true, status: "completed" };
}

async function findMineshaftWorkPose(bot: Bot, plan: FrozenTerrainPlan, direction: CardinalDirection, width: 1 | 2, segment: number, target: { x: number; y: number; z: number }, signal: AbortSignal): Promise<SkillResult<SafeWorkPose>> {
  const previous = waypoint(plan.anchor, direction, width, Math.max(0, segment - 1));
  const offset = forwardOffset(direction);
  const pose = segment === 0 ? { x: previous.x - offset.x, y: plan.anchor.y + 1, z: previous.z - offset.z } : previous;
  const feet = classifyObservedBlock(bot.blockAt(new Vec3(pose.x, pose.y, pose.z)));
  const floor = classifyObservedBlock(bot.blockAt(new Vec3(pose.x, pose.y - 1, pose.z)));
  // Settled gravel or sand is a fine floor to stand on.
  const standable = floor === "solid" || floor === "falling";
  if (feet !== "passable" || !standable || (pose.x === target.x && pose.y === target.y && pose.z === target.z)) return { ok: false, status: "blocked", errorCode: "RETURN_ROUTE_LOST", message: "mineshaft lost its last safe standing waypoint", retryable: false };
  const self = bot.entity?.position;
  // Close enough only counts when the bot is not standing on the very cell
  // it is about to remove (it can wander onto the terrain over the shaft).
  const standingOnTarget = self !== undefined && Math.floor(self.x) === target.x && Math.floor(self.z) === target.z && Math.floor(self.y) - 1 === target.y;
  if (self && !standingOnTarget && Math.hypot(self.x - pose.x, self.y - pose.y, self.z - pose.z) <= 3) return { ok: true, status: "completed", data: { position: pose } };
  // Far from the face (back from a tool or deposit run): walk in through the
  // shaft's own entrance and down its dug steps. A direct pathfinder search
  // from the surface to a face 50 steps down does not finish, and the
  // straight-line fallback ends up on the surface right above the target.
  const distance = self === undefined ? 0 : Math.hypot(self.x - pose.x, self.y - pose.y, self.z - pose.z);
  if (segment > SHAFT_HOP && distance > SHAFT_HOP) {
    const walked = await walkDownShaft(bot, plan, direction, width, segment - 1, signal);
    if (!walked.ok) return walked;
  }
  const travel = await travelAndWait(bot, pose, { range: standingOnTarget ? 0.5 : 1.5, timeoutMs: 30_000, signal });
  if (travel.status === "arrived" || travel.status === "already_there") return { ok: true, status: "completed", data: { position: pose } };
  return { ok: false, status: "blocked", errorCode: "UNREACHABLE_BLOCK", message: `cannot reach mineshaft waypoint (${pose.x}, ${pose.y}, ${pose.z})`, retryable: false };
}

/**
 * Waypoints up and out of a mineshaft when `position` is standing in it:
 * every few steps from the bot's current segment back to the entrance.
 * Null when the bot is not in this shaft.
 */
export function mineshaftExitRoute(plan: FrozenTerrainPlan, position: { x: number; y: number; z: number }): Array<{ x: number; y: number; z: number }> | null {
  const spec = plan.specification;
  if (spec.kind !== "mineshaft") return null;
  const direction = directionFromFrozenGeometry(plan, spec);
  if (direction === null) return null;
  const distance = spec.targetY !== undefined ? plan.anchor.y - spec.targetY : spec.depth ?? 0;
  let here = -1;
  let nearest = 2.5;
  for (let segment = 0; segment <= distance; segment += 1) {
    const point = waypoint(plan.anchor, direction, spec.width, segment);
    const gap = Math.hypot(position.x - (point.x + 0.5), position.y - point.y, position.z - (point.z + 0.5));
    if (gap <= nearest) { here = segment; nearest = gap; }
  }
  if (here <= 0) return null;
  const route: Array<{ x: number; y: number; z: number }> = [];
  for (let segment = here - SHAFT_HOP; segment > 0; segment -= SHAFT_HOP) route.push(waypoint(plan.anchor, direction, spec.width, segment));
  route.push(waypoint(plan.anchor, direction, spec.width, 0));
  return route;
}

/** Segments per hop when walking down a finished stretch of shaft. */
const SHAFT_HOP = 6;

/** Walk from wherever the bot is, in at the entrance and down to `lastSegment`. */
async function walkDownShaft(bot: Bot, plan: FrozenTerrainPlan, direction: CardinalDirection, width: 1 | 2, lastSegment: number, signal: AbortSignal): Promise<SkillResult<SafeWorkPose>> {
  const self = bot.entity?.position;
  if (self === undefined) return { ok: false, status: "blocked", errorCode: "NOT_READY", message: "bot is not spawned", retryable: true };
  // Start from the shaft waypoint the bot is already standing near, if any.
  let start = -1;
  for (let segment = 0; segment <= lastSegment; segment += 1) {
    const point = waypoint(plan.anchor, direction, width, segment);
    if (Math.hypot(self.x - (point.x + 0.5), self.y - point.y, self.z - (point.z + 0.5)) <= 2.5) start = segment;
  }
  if (start < 0) {
    const entrance = waypoint(plan.anchor, direction, width, 0);
    const reached = await travelAndWait(bot, entrance, { range: 1.5, timeoutMs: 180_000, signal });
    if (reached.status !== "arrived" && reached.status !== "already_there") return { ok: false, status: "blocked", errorCode: "UNREACHABLE_BLOCK", message: `cannot reach the mineshaft entrance (${entrance.x}, ${entrance.y}, ${entrance.z})`, retryable: true };
    start = 0;
  }
  for (let segment = Math.min(lastSegment, start + SHAFT_HOP); ; segment = Math.min(lastSegment, segment + SHAFT_HOP)) {
    const point = waypoint(plan.anchor, direction, width, segment);
    const hop = await travelAndWait(bot, point, { range: 1.5, timeoutMs: 45_000, signal });
    if (hop.status !== "arrived" && hop.status !== "already_there") return { ok: false, status: "blocked", errorCode: "UNREACHABLE_BLOCK", message: `cannot walk down the mineshaft past (${point.x}, ${point.y}, ${point.z})`, retryable: true };
    if (segment >= lastSegment) break;
  }
  return { ok: true, status: "completed", data: { position: waypoint(plan.anchor, direction, width, lastSegment) } };
}

function isOpenOrWater(bot: Bot, cell: { x: number; y: number; z: number }): boolean {
  const block = bot.blockAt(new Vec3(cell.x, cell.y, cell.z));
  const state = classifyObservedBlock(block);
  return state === "passable" || (state === "fluid" && !String(block?.name ?? "").includes("lava"));
}

/** How far down a floor bridge may stack support to reach solid ground. */
const MAX_BRIDGE_PILLAR = 6;

/**
 * Bridge a missing stairway floor cell with a throwaway block. A cell with no
 * solid neighbour at all (the shaft entrance opening over a pit) is reached
 * by first stacking support up from the ground below it.
 */
async function placeFloorBlock(bot: Bot, mutation: TerrainMutationService, cell: { x: number; y: number; z: number }, signal: AbortSignal, depth = 0): Promise<SkillResult<void>> {
  if (fillItem(bot) === null) return { ok: false, status: "blocked", errorCode: "INSUFFICIENT_MATERIALS", message: "the shaft crosses a cave and needs cobblestone or dirt to bridge the floor", retryable: true };
  const faces = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]] as const;
  const solidFaces = (): Array<readonly [number, number, number]> => faces.filter(([dx, dy, dz]) => {
    const reference = bot.blockAt(new Vec3(cell.x + dx, cell.y + dy, cell.z + dz));
    return reference !== null && classifyObservedBlock(reference) === "solid";
  });
  if (solidFaces().length === 0 && depth < MAX_BRIDGE_PILLAR) {
    const below = await placeFloorBlock(bot, mutation, { x: cell.x, y: cell.y - 1, z: cell.z }, signal, depth + 1);
    if (!below.ok) return below;
  }
  for (const [dx, dy, dz] of solidFaces()) {
    const item = fillItem(bot);
    if (item === null) return { ok: false, status: "blocked", errorCode: "INSUFFICIENT_MATERIALS", message: "the shaft crosses a cave and needs cobblestone or dirt to bridge the floor", retryable: true };
    const reference = bot.blockAt(new Vec3(cell.x + dx, cell.y + dy, cell.z + dz));
    if (reference === null) continue;
    const center = new Vec3(cell.x + 0.5, cell.y + 0.5, cell.z + 0.5);
    const eye = bot.entity?.position.offset(0, 1.62, 0);
    if (eye === undefined || eye.distanceTo(center) > 4.5) await travelAndWait(bot, { x: cell.x, y: cell.y + 1, z: cell.z }, { range: 3, timeoutMs: 30_000, signal });
    const placed = await mutation.placeSupport(item, reference, { x: -dx, y: -dy, z: -dz }, cell, signal);
    if (placed.ok) return { ok: true, status: "completed" };
  }
  return { ok: false, status: "blocked", errorCode: "CAVE_OPENING", message: `could not bridge the shaft floor at (${cell.x}, ${cell.y}, ${cell.z})`, retryable: true };
}

export async function runMineshaftSlice(bot: Bot, plan: FrozenTerrainPlan, options: MineshaftRunOptions & TerrainRunnerOptions): Promise<SkillResult<MineshaftSliceData>> {
  const spec = plan.specification;
  if (spec.kind !== "mineshaft") return { ok: false, status: "failed", errorCode: "INVALID_RESOURCE", message: "not a mineshaft plan", retryable: false };
  const direction = directionFromFrozenGeometry(plan, spec);
  if (direction === null) return { ok: false, status: "blocked", errorCode: "UNSAFE_GEOMETRY", message: "mineshaft direction is not frozen", retryable: false };
  const distance = spec.targetY !== undefined ? plan.anchor.y - spec.targetY : spec.depth ?? 0;
  if (!Number.isInteger(distance) || distance < 1) return { ok: false, status: "blocked", errorCode: "UNSAFE_GEOMETRY", message: "mineshaft endpoint must descend below the entrance", retryable: false };
  const endpoint = waypoint(plan.anchor, direction, spec.width, distance);
  const base = { lastVerifiedSegment: -1, lastSafeWaypoint: waypoint(plan.anchor, direction, spec.width, 0), routeStatus: "verified" as const };
  const resume = options.resumeState === undefined ? base : { ...base, ...options.resumeState };
  const mutation = options.mutation ?? new TerrainMutationService(bot);
  const limit = Math.max(1, Math.floor(options.maxBlocksPerSlice ?? 4));
  let worked = 0;

  await waitForTerrainObserved(bot, plan.bounds, options.signals.signal);
  // A resume cursor is only a hint. Rescan the route from the entrance and
  // choose the first incomplete segment after every interruption.
  let firstIncomplete = 0;
  for (let segment = 0; segment <= distance; segment += 1) {
    const inspected = inspectMineshaftSegment(bot, plan, direction, segment);
    if (!inspected.ok || inspected.data === undefined) return { ...inspected, data: { ...resume, complete: false, totalSegments: distance + 1, direction, endpoint } };
    const complete = inspected.data.cells.every((cell) => isOpenOrWater(bot, cell)) && inspected.data.missingFloor.length === 0;
    if (!complete) { firstIncomplete = segment; break; }
    firstIncomplete = segment + 1;
  }
  // Segments already dug (by an earlier slice or task) count as verified;
  // otherwise a fresh cursor on a finished shaft never reports completion.
  if (firstIncomplete - 1 > resume.lastVerifiedSegment) {
    resume.lastVerifiedSegment = firstIncomplete - 1;
    resume.lastSafeWaypoint = waypoint(plan.anchor, direction, spec.width, Math.max(0, firstIncomplete - 1));
  }

  for (let segment = firstIncomplete; segment <= distance && worked < limit; segment += 1) {
    if (!options.signals.checkpoint({ phase: "mineshaft", segment, lastVerifiedSegment: resume.lastVerifiedSegment, routeStatus: resume.routeStatus })) return { ok: false, status: "interrupted", message: "mineshaft paused at a safe waypoint", retryable: true, data: { ...resume, complete: false, totalSegments: distance + 1, direction, endpoint } };
    const inspected = inspectMineshaftSegment(bot, plan, direction, segment);
    if (!inspected.ok || inspected.data === undefined) return { ...inspected, data: { ...resume, complete: false, totalSegments: distance + 1, direction, endpoint } };
    const exposed = checkExposedFaces(bot, inspected.data.bounds, direction);
    if (!exposed.ok) return { ...exposed, data: { ...resume, routeStatus: "lost", complete: false, totalSegments: distance + 1, direction, endpoint } };
    // Remove ceiling/head blocks first, never the segment floor.
    for (const target of inspected.data.cells) {
      if (isOpenOrWater(bot, target)) continue;
      const pose = await findMineshaftWorkPose(bot, plan, direction, spec.width, segment, target, options.signals.signal);
      if (!pose.ok) return { ...pose, data: { ...resume, complete: false, totalSegments: distance + 1, direction, endpoint } };
      const broken = await mutation.breakAndVerify(target, options.signals.signal);
      if (!broken.ok) return { ...broken, data: { ...resume, complete: false, totalSegments: distance + 1, direction, endpoint } };
    }
    for (const cell of inspected.data.missingFloor) {
      const placed = await placeFloorBlock(bot, mutation, cell, options.signals.signal);
      if (!placed.ok) return { ...placed, data: { ...resume, complete: false, totalSegments: distance + 1, direction, endpoint } };
    }
    const route = verifyNoDigRoute(bot, plan, direction, segment);
    if (!route.ok) return { ...route, data: { ...resume, routeStatus: "lost", complete: false, totalSegments: distance + 1, direction, endpoint } };
    const light = await placePlannedLight(bot, mutation, plan, direction, segment, options.signals.signal);
    if (!light.ok) return { ...light, data: { ...resume, complete: false, totalSegments: distance + 1, direction, endpoint } };
    resume.lastVerifiedSegment = segment;
    resume.lastSafeWaypoint = waypoint(plan.anchor, direction, spec.width, segment);
    resume.routeStatus = "verified";
    worked += 1;
  }
  const complete = resume.lastVerifiedSegment >= distance;
  const data = { ...resume, complete, totalSegments: distance + 1, direction, endpoint };
  return { ok: true, status: complete ? "completed" : "partial", data, message: complete ? "mineshaft slice complete" : "mineshaft slice checkpointed", retryable: !complete };
}

export function runClearAreaSlice(bot: Bot, plan: FrozenTerrainPlan, options: SurfaceRunOptions & TerrainRunnerOptions): Promise<SkillResult<SurfaceSliceData>> {
  return runSurfaceSlice(bot, plan, options, "clear");
}

export function runFlattenAreaSlice(bot: Bot, plan: FrozenTerrainPlan, options: SurfaceRunOptions & TerrainRunnerOptions): Promise<SkillResult<SurfaceSliceData>> {
  return runSurfaceSlice(bot, plan, options, "flatten");
}

export class TerrainProjectRunner {
  constructor(private readonly bot: Bot, private readonly options: TerrainRunnerOptions = {}) {}

  async run(projectPlan: FrozenTerrainPlan, options: TerrainRunOptions): Promise<SkillResult> {
    if (projectPlan.specification.kind === "excavate") return runExcavationSlice(this.bot, projectPlan, { ...this.options, ...options } as ExcavationRunOptions & TerrainRunnerOptions);
    if (projectPlan.specification.kind === "clear") return runClearAreaSlice(this.bot, projectPlan, { ...this.options, ...options } as SurfaceRunOptions & TerrainRunnerOptions);
    if (projectPlan.specification.kind === "flatten") return runFlattenAreaSlice(this.bot, projectPlan, { ...this.options, ...options } as SurfaceRunOptions & TerrainRunnerOptions);
    return runMineshaftSlice(this.bot, projectPlan, { ...this.options, ...options } as MineshaftRunOptions & TerrainRunnerOptions);
  }
}
