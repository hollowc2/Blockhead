import type { Bot } from "mineflayer";
import type { Block } from "prismarine-block";
import type { Item } from "prismarine-item";
import { Vec3 } from "vec3";
import { digBlock, equipItem, equipToolForBlock, placeTerrainBlock } from "../minecraft/primitives.js";
import { throwIfAborted } from "../agent/world-actions.js";
import { classifyObservedBlock, type ObservedBlockState } from "./classification.js";
import { checkDigStraightDown } from "../policy/safety.js";
import type { SkillErrorCode, SkillResult } from "../skills/skill-library.js";

const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_POLL_ATTEMPTS = 8;
const DEFAULT_SETTLE_ATTEMPTS = 6;

export interface MutationObservation {
  position: { x: number; y: number; z: number };
  before: ObservedBlockState;
  after: ObservedBlockState;
  blockName: string | null;
  attempts: number;
  settled: boolean;
}

export interface ToolProvisioner {
  equipForBlock(block: Block, signal: AbortSignal): Promise<void>;
  hasDurabilityReserve(block: Block): boolean;
}

export class MineflayerToolProvisioner implements ToolProvisioner {
  constructor(private readonly bot: Bot, private readonly minimumRemainingUses = 1) {}

  async equipForBlock(block: Block, signal: AbortSignal): Promise<void> {
    await equipToolForBlock(this.bot, block, signal);
  }

  hasDurabilityReserve(block: Block): boolean {
    const held = this.bot.heldItem;
    if (held === null || held === undefined) return block.canHarvest(null);
    if (held.maxDurability <= 0) return true;
    return held.maxDurability - held.durabilityUsed >= this.minimumRemainingUses;
  }
}

export interface WaitForBlockOptions {
  maxAttempts?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
  predicate?: (block: Block | null) => boolean;
}

export interface BlockStateWaitResult {
  block: Block | null;
  state: ObservedBlockState;
  attempts: number;
}

function positionOf(position: { x: number; y: number; z: number }): Vec3 {
  return new Vec3(position.x, position.y, position.z);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasAdjacentLava(bot: Bot, position: { x: number; y: number; z: number }): boolean {
  const offsets = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const;
  return offsets.some(([dx, dy, dz]) => {
    const block = bot.blockAt(new Vec3(position.x + dx, position.y + dy, position.z + dz));
    return block !== null && (block.name === "lava" || block.name === "flowing_lava" || block.name === "minecraft:lava" || block.name === "minecraft:flowing_lava");
  });
}

/** Poll the bot's authoritative block view; null never counts as passable. */
export async function waitForAuthoritativeBlockState(
  bot: Bot,
  position: { x: number; y: number; z: number },
  options: WaitForBlockOptions = {},
): Promise<BlockStateWaitResult> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_POLL_ATTEMPTS;
  const interval = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    throwIfAborted(options.signal);
    const block = bot.blockAt(positionOf(position));
    if (block !== null && (options.predicate?.(block) ?? true)) {
      return { block, state: classifyObservedBlock(block), attempts: attempt };
    }
    if (attempt < maxAttempts) await sleep(interval);
  }
  const block = bot.blockAt(positionOf(position));
  return { block, state: classifyObservedBlock(block), attempts: maxAttempts };
}

export interface SettleOptions {
  maxAttempts?: number;
  pollIntervalMs?: number;
  maxColumnHeight?: number;
  signal?: AbortSignal;
}

export interface FallingSettleResult {
  stable: boolean;
  attempts: number;
  falling: number;
  unobserved: number;
}

/** Wait for a bounded vertical falling-block column to become observable/stable. */
export async function settleFallingColumn(
  bot: Bot,
  position: { x: number; y: number; z: number },
  options: SettleOptions = {},
): Promise<FallingSettleResult> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_SETTLE_ATTEMPTS;
  const height = options.maxColumnHeight ?? 8;
  let lastFalling = 0;
  let lastUnobserved = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    throwIfAborted(options.signal);
    let falling = 0;
    let unobserved = 0;
    for (let y = position.y; y < position.y + height; y += 1) {
      const state = classifyObservedBlock(bot.blockAt(new Vec3(position.x, y, position.z)));
      if (state === "falling") falling += 1;
      if (state === "unobserved") unobserved += 1;
    }
    lastFalling = falling;
    lastUnobserved = unobserved;
    if (falling === 0 && unobserved === 0) return { stable: true, attempts: attempt, falling, unobserved };
    if (attempt < maxAttempts) await sleep(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  }
  return { stable: false, attempts: maxAttempts, falling: lastFalling, unobserved: lastUnobserved };
}

function failure<T>(errorCode: SkillErrorCode, message: string): SkillResult<T> {
  return { ok: false, status: "blocked", errorCode, message, retryable: false };
}

export interface TerrainMutationServiceOptions {
  toolProvisioner?: ToolProvisioner;
  pollAttempts?: number;
  pollIntervalMs?: number;
  settleAttempts?: number;
}

export class TerrainMutationService {
  private readonly provisioner: ToolProvisioner;
  private readonly pollAttempts: number;
  private readonly pollIntervalMs: number;
  private readonly settleAttempts: number;

  constructor(private readonly bot: Bot, options: TerrainMutationServiceOptions = {}) {
    this.provisioner = options.toolProvisioner ?? new MineflayerToolProvisioner(bot);
    this.pollAttempts = options.pollAttempts ?? DEFAULT_POLL_ATTEMPTS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.settleAttempts = options.settleAttempts ?? DEFAULT_SETTLE_ATTEMPTS;
  }

  async breakAndVerify(position: { x: number; y: number; z: number }, signal?: AbortSignal): Promise<SkillResult<MutationObservation>> {
    throwIfAborted(signal);
    const target = this.bot.blockAt(positionOf(position));
    const before = classifyObservedBlock(target);
    if (target === null) return failure("WORLD_NOT_OBSERVED", "target block is not observed");
    if (before === "fluid") return failure(target.name.includes("lava") ? "LAVA_HAZARD" : "WATER_HAZARD", `refusing to dig ${target.name}`);
    if (hasAdjacentLava(this.bot, position)) return failure("LAVA_HAZARD", "refusing to dig beside observed lava");
    if (before === "protectedFixture") return failure("PROTECTED_FIXTURE", `refusing to dig protected fixture ${target.name}`);
    if (before === "unbreakable") return failure("UNBREAKABLE_BLOCK", `refusing to dig unbreakable block ${target.name}`);
    if (before === "passable") return failure("UNREACHABLE_BLOCK", "target is already passable");
    if (before === "falling") return failure("FALLING_BLOCKS_UNSTABLE", "falling block must settle before digging");
    if (this.bot.entity === null) return failure("UNREACHABLE_BLOCK", "bot is not spawned");
    const straightDown = checkDigStraightDown(position, this.bot.entity.position);
    if (!straightDown.allowed) return failure("UNSAFE_GEOMETRY", straightDown.violation?.reason ?? "straight-down digging is unsafe");

    try {
      await this.provisioner.equipForBlock(target, signal ?? new AbortController().signal);
    } catch (error) {
      return failure("TOOL_REQUIRED", error instanceof Error ? error.message : "no harvestable tool available");
    }
    if (!target.canHarvest(this.bot.heldItem?.type ?? null)) return failure("TOOL_REQUIRED", `held tool cannot harvest ${target.name}`);
    if (!this.provisioner.hasDurabilityReserve(target)) return failure("TOOL_REQUIRED", "tool has no durability reserve for this atomic operation");

    try {
      await digBlock(this.bot, target, signal);
      const verified = await waitForAuthoritativeBlockState(this.bot, position, {
        maxAttempts: this.pollAttempts,
        pollIntervalMs: this.pollIntervalMs,
        signal,
        predicate: (block) => classifyObservedBlock(block) === "passable",
      });
      const settled = await settleFallingColumn(this.bot, position, { maxAttempts: this.settleAttempts, pollIntervalMs: this.pollIntervalMs, signal });
      const after = classifyObservedBlock(verified.block);
      if (!settled.stable) return failure("FALLING_BLOCKS_UNSTABLE", "falling-block column did not settle within the bounded limit");
      if (after !== "passable") return failure(after === "unobserved" ? "WORLD_NOT_OBSERVED" : "UNREACHABLE_BLOCK", "dig was not confirmed by an observed passable block");
      return { ok: true, status: "completed", data: { position, before, after, blockName: verified.block?.name ?? null, attempts: verified.attempts, settled: true } };
    } catch (error) {
      if (signal?.aborted) return { ok: false, status: "interrupted", errorCode: "TIMEOUT", message: "terrain mutation was cancelled", retryable: true };
      return failure("UNREACHABLE_BLOCK", error instanceof Error ? error.message : "terrain mutation failed");
    }
  }

  async placeSupport(
    item: Item,
    reference: Block,
    face: { x: number; y: number; z: number },
    targetPosition: { x: number; y: number; z: number },
    signal?: AbortSignal,
  ): Promise<SkillResult<MutationObservation>> {
    return this.placeVerified(item, reference, face, targetPosition, signal);
  }

  async placeLight(
    item: Item,
    reference: Block,
    face: { x: number; y: number; z: number },
    targetPosition: { x: number; y: number; z: number },
    signal?: AbortSignal,
  ): Promise<SkillResult<MutationObservation>> {
    return this.placeVerified(item, reference, face, targetPosition, signal);
  }

  private async placeVerified(item: Item, reference: Block, face: { x: number; y: number; z: number }, targetPosition: { x: number; y: number; z: number }, signal?: AbortSignal): Promise<SkillResult<MutationObservation>> {
    throwIfAborted(signal);
    const target = this.bot.blockAt(positionOf(targetPosition));
    const before = classifyObservedBlock(target);
    if (target === null) return failure("WORLD_NOT_OBSERVED", "placement target is not observed");
    if (before === "fluid") return failure(target.name.includes("lava") ? "LAVA_HAZARD" : "WATER_HAZARD", "refusing placement into a fluid");
    if (before !== "passable") return failure(before === "protectedFixture" ? "PROTECTED_FIXTURE" : "UNSAFE_GEOMETRY", "placement target is not safely passable");
    if (classifyObservedBlock(reference) !== "solid") return failure("UNSAFE_GEOMETRY", "placement reference is not a solid observed block");
    try {
      if (this.bot.heldItem?.name !== item.name) await equipItem(this.bot, item, signal);
      await placeTerrainBlock(this.bot, reference, new Vec3(face.x, face.y, face.z), targetPosition, item.name, signal);
      const verified = await waitForAuthoritativeBlockState(this.bot, targetPosition, { maxAttempts: this.pollAttempts, pollIntervalMs: this.pollIntervalMs, signal, predicate: (block) => block !== null && block.name !== "air" });
      if (verified.block === null || verified.block.name === "air") return failure("WORLD_NOT_OBSERVED", "placement was not confirmed by an observed block");
      return { ok: true, status: "completed", data: { position: targetPosition, before, after: classifyObservedBlock(verified.block), blockName: verified.block.name, attempts: verified.attempts, settled: true } };
    } catch (error) {
      if (signal?.aborted) return { ok: false, status: "interrupted", errorCode: "TIMEOUT", message: "terrain placement was cancelled", retryable: true };
      return failure("UNREACHABLE_BLOCK", error instanceof Error ? error.message : "terrain placement failed");
    }
  }
}

export const breakAndVerify = (service: TerrainMutationService, position: { x: number; y: number; z: number }, signal?: AbortSignal): Promise<SkillResult<MutationObservation>> => service.breakAndVerify(position, signal);
