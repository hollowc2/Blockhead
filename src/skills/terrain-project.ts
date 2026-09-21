import type { Bot } from "mineflayer";
import type { Logger } from "pino";
import type { Item } from "prismarine-item";
import { Vec3 } from "vec3";
import { travelAndWait } from "../minecraft/movement.js";
import { classifyObservedBlock } from "../terrain/classification.js";
import { deterministicSerpentine } from "../terrain/geometry.js";
import { TerrainMutationService } from "../terrain/mutation.js";
import type { BlockBounds, FrozenTerrainPlan } from "../terrain/schema.js";
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

export function runClearAreaSlice(bot: Bot, plan: FrozenTerrainPlan, options: SurfaceRunOptions & TerrainRunnerOptions): Promise<SkillResult<SurfaceSliceData>> {
  return runSurfaceSlice(bot, plan, options, "clear");
}

export function runFlattenAreaSlice(bot: Bot, plan: FrozenTerrainPlan, options: SurfaceRunOptions & TerrainRunnerOptions): Promise<SkillResult<SurfaceSliceData>> {
  return runSurfaceSlice(bot, plan, options, "flatten");
}

export class TerrainProjectRunner {
  constructor(private readonly bot: Bot, private readonly options: TerrainRunnerOptions = {}) {}

  async run(projectPlan: FrozenTerrainPlan, options: ExcavationRunOptions | SurfaceRunOptions): Promise<SkillResult> {
    if (projectPlan.specification.kind === "excavate") return runExcavationSlice(this.bot, projectPlan, { ...this.options, ...options } as ExcavationRunOptions & TerrainRunnerOptions);
    if (projectPlan.specification.kind === "clear") return runClearAreaSlice(this.bot, projectPlan, { ...this.options, ...options } as SurfaceRunOptions & TerrainRunnerOptions);
    if (projectPlan.specification.kind === "flatten") return runFlattenAreaSlice(this.bot, projectPlan, { ...this.options, ...options } as SurfaceRunOptions & TerrainRunnerOptions);
    return { ok: false, status: "failed", errorCode: "INVALID_RESOURCE", message: "mineshaft execution is reserved for a later stage", retryable: false };
  }
}
