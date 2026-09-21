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

function preflightSurface(bot: Bot, bounds: BlockBounds, walkingY: number): SkillResult<void> {
  if (!Number.isInteger(walkingY) || walkingY < bounds.minY || walkingY > bounds.maxY) return { ok: false, status: "blocked", errorCode: "UNSAFE_GEOMETRY", message: "walking plane is outside the authorized terrain bounds", retryable: false };
  if (playerInWorkBuffer(bot, bounds)) return { ok: false, status: "blocked", errorCode: "UNSAFE_GEOMETRY", message: "a player is inside the terrain work buffer", retryable: false };
  for (let y = bounds.minY - 1; y <= bounds.maxY; y += 1) for (let z = bounds.minZ; z <= bounds.maxZ; z += 1) for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
    const block = bot.blockAt(new Vec3(x, y, z));
    const state = classifyObservedBlock(block);
    if (state === "unobserved") return { ok: false, status: "blocked", errorCode: "WORLD_NOT_OBSERVED", message: `terrain cell (${x}, ${y}, ${z}) is not observed`, retryable: false };
    if (state === "fluid") return { ok: false, status: "blocked", errorCode: blockError(block?.name), message: `terrain cell (${x}, ${y}, ${z}) contains ${block?.name}`, retryable: false };
    if (state === "falling") return { ok: false, status: "blocked", errorCode: "FALLING_BLOCKS_UNSTABLE", message: `falling block at (${x}, ${y}, ${z}) must settle before surface work`, retryable: false };
    if (state === "protectedFixture") return { ok: false, status: "blocked", errorCode: "PROTECTED_FIXTURE", message: `protected fixture at (${x}, ${y}, ${z})`, retryable: false };
    if (state === "unbreakable") return { ok: false, status: "blocked", errorCode: "UNBREAKABLE_BLOCK", message: `unbreakable block at (${x}, ${y}, ${z})`, retryable: false };
  }
  return { ok: true, status: "completed" };
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
    if (kind === "flatten" && columns.some((column) => column.fill.some((cell) => positionKey(cell) === positionKey(target)))) {
      const reference = bot.blockAt(new Vec3(target.x, target.y - 1, target.z));
      if (item === null || reference === null) return { ok: false, status: "blocked", errorCode: "UNSAFE_GEOMETRY", message: "flatten fill reference is unavailable", retryable: false };
      const placed = await mutation.placeSupport(item, reference, { x: 0, y: 1, z: 0 }, target, options.signals.signal);
      if (!placed.ok) return { ...placed, data: { ...cursor, complete: false, total: ordered.length, columns } };
    } else {
      const state = classifyObservedBlock(bot.blockAt(new Vec3(target.x, target.y, target.z)));
      if (state === "passable") { cursor.verified += 1; continue; }
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
  if (state === "unobserved") return { ok: false, status: "blocked", errorCode: "WORLD_NOT_OBSERVED", message: "mineshaft requires an unobserved block", retryable: false };
  if (state === "protectedFixture") return { ok: false, status: "blocked", errorCode: "PROTECTED_FIXTURE", message: "mineshaft intersects a protected fixture", retryable: false };
  return { ok: false, status: "blocked", errorCode: "UNBREAKABLE_BLOCK", message: "mineshaft intersects an unbreakable block", retryable: false };
}

function inspectMineshaftSegment(bot: Bot, plan: FrozenTerrainPlan, direction: CardinalDirection, segment: number): SkillResult<{ bounds: BlockBounds; floor: Array<{ x: number; y: number; z: number }>; cells: Array<{ x: number; y: number; z: number }> }> {
  const spec = plan.specification;
  if (spec.kind !== "mineshaft") return { ok: false, status: "failed", errorCode: "INVALID_RESOURCE", message: "not a mineshaft plan", retryable: false };
  const bounds = mineshaftSegment(plan.anchor, direction, spec.width, spec.height, segment);
  const cells: Array<{ x: number; y: number; z: number }> = [];
  const floor: Array<{ x: number; y: number; z: number }> = [];
  for (let y = bounds.maxY; y >= bounds.minY; y -= 1) for (let z = bounds.minZ; z <= bounds.maxZ; z += 1) for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
    if (!pointInBounds({ x, y, z }, plan.bounds)) return { ok: false, status: "blocked", errorCode: "UNSAFE_GEOMETRY", message: "mineshaft segment exceeds frozen authorization geometry", retryable: false };
    const block = bot.blockAt(new Vec3(x, y, z));
    const state = classifyObservedBlock(block);
    if (state !== "passable" && state !== "solid") return stateFailure(state, block?.name ?? null);
    cells.push({ x, y, z });
  }
  for (let z = bounds.minZ; z <= bounds.maxZ; z += 1) for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
    const position = { x, y: bounds.minY - 1, z };
    if (!pointInBounds(position, plan.bounds)) return { ok: false, status: "blocked", errorCode: "UNSAFE_GEOMETRY", message: "mineshaft floor exceeds frozen authorization geometry", retryable: false };
    const block = bot.blockAt(new Vec3(position.x, position.y, position.z));
    const state = classifyObservedBlock(block);
    if (state !== "solid") {
      if (state === "passable") return { ok: false, status: "blocked", errorCode: "CAVE_OPENING", message: "mineshaft has no solid floor", retryable: false };
      return stateFailure(state, block?.name ?? null);
    }
    floor.push(position);
  }
  return { ok: true, status: "completed", data: { bounds, floor, cells } };
}

function checkExposedFaces(bot: Bot, bounds: BlockBounds, direction: CardinalDirection): SkillResult<void> {
  const side = direction === "north" || direction === "south" ? [{ x: bounds.minX - 1, z: bounds.minZ }, { x: bounds.maxX + 1, z: bounds.minZ }] : [{ x: bounds.minX, z: bounds.minZ - 1 }, { x: bounds.minX, z: bounds.maxZ + 1 }];
  for (const face of side) for (let y = bounds.minY; y <= bounds.maxY; y += 1) {
    const block = bot.blockAt(new Vec3(face.x, y, face.z));
    const state = classifyObservedBlock(block);
    if (state === "passable") return { ok: false, status: "blocked", errorCode: "CAVE_OPENING", message: "mineshaft opens into an unverified cavity", retryable: false };
    if (state !== "solid") return stateFailure(state, block?.name ?? null);
  }
  return { ok: true, status: "completed" };
}

/** Return a bounded, observed standing position beside a target. */
export async function findSafeWorkPose(bot: Bot, target: { x: number; y: number; z: number }, bounds: BlockBounds, signal: AbortSignal): Promise<SkillResult<SafeWorkPose>> {
  const candidates = [target.y, target.y + 1].flatMap((y) => [
    { x: target.x - 1, y, z: target.z },
    { x: target.x + 1, y, z: target.z },
    { x: target.x, y, z: target.z - 1 },
    { x: target.x, y, z: target.z + 1 },
  ]);
  const self = bot.entity?.position;
  for (const candidate of candidates) {
    const feet = classifyObservedBlock(bot.blockAt(new Vec3(candidate.x, candidate.y, candidate.z)));
    const head = classifyObservedBlock(bot.blockAt(new Vec3(candidate.x, candidate.y + 1, candidate.z)));
    const floor = classifyObservedBlock(bot.blockAt(new Vec3(candidate.x, candidate.y - 1, candidate.z)));
    if (feet !== "passable" || head !== "passable" || floor !== "solid") continue;
    if (self && Math.hypot(self.x - candidate.x, self.y - candidate.y, self.z - candidate.z) <= 3) return { ok: true, status: "completed", data: { position: candidate } };
    const travel = await travelAndWait(bot, candidate, { range: 1.5, timeoutMs: 30_000, signal });
    if (travel.status === "arrived" || travel.status === "already_there") return { ok: true, status: "completed", data: { position: candidate } };
  }
  return { ok: false, status: "blocked", errorCode: "UNREACHABLE_BLOCK", message: `no safe work pose for (${target.x}, ${target.y}, ${target.z})`, retryable: false };
}

function preflight(bot: Bot, bounds: BlockBounds): SkillResult<{ ramp: AccessRampPlan }> {
  if (playerInWorkBuffer(bot, bounds)) return { ok: false, status: "blocked", errorCode: "UNSAFE_GEOMETRY", message: "a player is inside the excavation work buffer", retryable: false };
  const ramp = chooseAccessRamp(bounds);
  if (ramp === null) return { ok: false, status: "blocked", errorCode: "UNSAFE_GEOMETRY", message: "excavation needs at least a two-block access edge; use a mineshaft for a narrow site", retryable: false };
  for (let y = bounds.minY; y <= bounds.maxY; y += 1) for (let z = bounds.minZ; z <= bounds.maxZ; z += 1) for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
    const block = bot.blockAt(new Vec3(x, y, z));
    const state = classifyObservedBlock(block);
    if (state === "unobserved") return { ok: false, status: "blocked", errorCode: "WORLD_NOT_OBSERVED", message: `excavation cell (${x}, ${y}, ${z}) is not observed`, retryable: false };
    if (state === "fluid") return { ok: false, status: "blocked", errorCode: block?.name.includes("lava") ? "LAVA_HAZARD" : "WATER_HAZARD", message: `excavation cell (${x}, ${y}, ${z}) contains ${block?.name}`, retryable: false };
    if (state === "protectedFixture") return { ok: false, status: "blocked", errorCode: "PROTECTED_FIXTURE", message: `protected fixture at (${x}, ${y}, ${z})`, retryable: false };
    if (state === "unbreakable") return { ok: false, status: "blocked", errorCode: "UNBREAKABLE_BLOCK", message: `unbreakable block at (${x}, ${y}, ${z})`, retryable: false };
  }
  return { ok: true, status: "completed", data: { ramp } };
}

export async function runExcavationSlice(bot: Bot, plan: FrozenTerrainPlan, options: ExcavationRunOptions & TerrainRunnerOptions): Promise<SkillResult<ExcavationSliceData>> {
  const bounds = plan.bounds;
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
    const state = classifyObservedBlock(bot.blockAt(new Vec3(target.x, target.y, target.z)));
    if (state === "passable") { cursor.verified += 1; continue; }
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
  if (feet !== "passable" || floor !== "solid" || (pose.x === target.x && pose.y === target.y && pose.z === target.z)) return { ok: false, status: "blocked", errorCode: "RETURN_ROUTE_LOST", message: "mineshaft lost its last safe standing waypoint", retryable: false };
  const self = bot.entity?.position;
  if (self && Math.hypot(self.x - pose.x, self.y - pose.y, self.z - pose.z) <= 3) return { ok: true, status: "completed", data: { position: pose } };
  const travel = await travelAndWait(bot, pose, { range: 1.5, timeoutMs: 30_000, signal });
  if (travel.status === "arrived" || travel.status === "already_there") return { ok: true, status: "completed", data: { position: pose } };
  return { ok: false, status: "blocked", errorCode: "UNREACHABLE_BLOCK", message: `cannot reach mineshaft waypoint (${pose.x}, ${pose.y}, ${pose.z})`, retryable: false };
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

  // A resume cursor is only a hint. Rescan the route from the entrance and
  // choose the first incomplete segment after every interruption.
  let firstIncomplete = 0;
  for (let segment = 0; segment <= distance; segment += 1) {
    const inspected = inspectMineshaftSegment(bot, plan, direction, segment);
    if (!inspected.ok || inspected.data === undefined) return { ...inspected, data: { ...resume, complete: false, totalSegments: distance + 1, direction, endpoint } };
    const complete = inspected.data.cells.every((cell) => classifyObservedBlock(bot.blockAt(new Vec3(cell.x, cell.y, cell.z))) === "passable");
    if (!complete) { firstIncomplete = segment; break; }
    firstIncomplete = segment + 1;
  }

  for (let segment = firstIncomplete; segment <= distance && worked < limit; segment += 1) {
    if (!options.signals.checkpoint({ phase: "mineshaft", segment, lastVerifiedSegment: resume.lastVerifiedSegment, routeStatus: resume.routeStatus })) return { ok: false, status: "interrupted", message: "mineshaft paused at a safe waypoint", retryable: true, data: { ...resume, complete: false, totalSegments: distance + 1, direction, endpoint } };
    const inspected = inspectMineshaftSegment(bot, plan, direction, segment);
    if (!inspected.ok || inspected.data === undefined) return { ...inspected, data: { ...resume, complete: false, totalSegments: distance + 1, direction, endpoint } };
    const exposed = checkExposedFaces(bot, inspected.data.bounds, direction);
    if (!exposed.ok) return { ...exposed, data: { ...resume, routeStatus: "lost", complete: false, totalSegments: distance + 1, direction, endpoint } };
    // Remove ceiling/head blocks first, never the segment floor.
    for (const target of inspected.data.cells) {
      if (classifyObservedBlock(bot.blockAt(new Vec3(target.x, target.y, target.z))) === "passable") continue;
      const pose = await findMineshaftWorkPose(bot, plan, direction, spec.width, segment, target, options.signals.signal);
      if (!pose.ok) return { ...pose, data: { ...resume, complete: false, totalSegments: distance + 1, direction, endpoint } };
      const broken = await mutation.breakAndVerify(target, options.signals.signal);
      if (!broken.ok) return { ...broken, data: { ...resume, complete: false, totalSegments: distance + 1, direction, endpoint } };
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
