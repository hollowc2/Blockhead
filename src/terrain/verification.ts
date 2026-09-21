import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { classifyObservedBlock, type ObservedBlockState } from "./classification.js";
import type { BlockBounds } from "./schema.js";
import type { SkillErrorCode, SkillResult } from "../skills/skill-library.js";

export interface VerificationMismatch {
  position: { x: number; y: number; z: number };
  state: ObservedBlockState;
  blockName: string | null;
  errorCode: Extract<SkillErrorCode, "WORLD_NOT_OBSERVED" | "LAVA_HAZARD" | "WATER_HAZARD" | "FALLING_BLOCKS_UNSTABLE" | "UNBREAKABLE_BLOCK" | "PROTECTED_FIXTURE">;
}

export interface ExcavationVerification {
  bounds: BlockBounds;
  inspected: number;
  verified: number;
  mismatches: VerificationMismatch[];
}

export interface ClearAreaVerification {
  bounds: BlockBounds;
  inspected: number;
  verified: number;
  mismatches: VerificationMismatch[];
}

export interface FlattenColumnVerification {
  x: number;
  z: number;
  walkingY: number;
  supportState: ObservedBlockState;
  walkingState: ObservedBlockState;
  headState: ObservedBlockState;
}

export interface FlattenAreaVerification {
  bounds: BlockBounds;
  walkingY: number;
  columns: FlattenColumnVerification[];
  inspected: number;
  verified: number;
  mismatches: VerificationMismatch[];
}

function errorCodeFor(state: ObservedBlockState, blockName: string | null): VerificationMismatch["errorCode"] {
  switch (state) {
    case "unobserved": return "WORLD_NOT_OBSERVED";
    case "fluid": return blockName?.replace(/^minecraft:/, "").includes("lava") ? "LAVA_HAZARD" : "WATER_HAZARD";
    case "falling": return "FALLING_BLOCKS_UNSTABLE";
    case "unbreakable": return "UNBREAKABLE_BLOCK";
    case "protectedFixture": return "PROTECTED_FIXTURE";
    default: return "UNBREAKABLE_BLOCK";
  }
}

/** Independently inspect every cell in an excavation AABB. */
export function verifyExcavationVolume(bot: Bot, bounds: BlockBounds, maxMismatches = 64): SkillResult<ExcavationVerification> {
  const mismatches: VerificationMismatch[] = [];
  let inspected = 0;
  let verified = 0;
  for (let y = bounds.minY; y <= bounds.maxY; y += 1) {
    for (let z = bounds.minZ; z <= bounds.maxZ; z += 1) {
      for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
        inspected += 1;
        const block = bot.blockAt(new Vec3(x, y, z));
        const state = classifyObservedBlock(block);
        if (state === "passable") {
          verified += 1;
        } else if (mismatches.length < maxMismatches) {
          mismatches.push({ position: { x, y, z }, state, blockName: block?.name ?? null, errorCode: errorCodeFor(state, block?.name ?? null) });
        }
      }
    }
  }
  const data = { bounds, inspected, verified, mismatches };
  if (mismatches.length > 0) {
    const first = mismatches[0];
    return { ok: false, status: "blocked", errorCode: first?.errorCode ?? "WORLD_NOT_OBSERVED", message: `excavation verification found ${mismatches.length} mismatched cell(s)`, data, retryable: false };
  }
  return { ok: true, status: "completed", data, message: "excavation volume verified" };
}

function mismatch(bot: Bot, x: number, y: number, z: number, allowSolid = false): VerificationMismatch | null {
  const block = bot.blockAt(new Vec3(x, y, z));
  const state = classifyObservedBlock(block);
  if (state === "passable" || (allowSolid && state === "solid")) return null;
  return { position: { x, y, z }, state, blockName: block?.name ?? null, errorCode: errorCodeFor(state, block?.name ?? null) };
}

/** Verify that a clear operation removed only the requested prism contents. */
export function verifyClearArea(bot: Bot, bounds: BlockBounds, maxMismatches = 64): SkillResult<ClearAreaVerification> {
  const mismatches: VerificationMismatch[] = [];
  let inspected = 0;
  let verified = 0;
  for (let y = bounds.minY; y <= bounds.maxY; y += 1) {
    for (let z = bounds.minZ; z <= bounds.maxZ; z += 1) {
      for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
        inspected += 1;
        const found = mismatch(bot, x, y, z);
        if (found === null) verified += 1;
        else if (mismatches.length < maxMismatches) mismatches.push(found);
      }
    }
  }
  const data = { bounds, inspected, verified, mismatches };
  if (mismatches.length > 0) return { ok: false, status: "blocked", errorCode: mismatches[0]?.errorCode, message: `clear verification found ${mismatches.length} mismatched cell(s)`, data, retryable: false };
  return { ok: true, status: "completed", data, message: "clear area verified" };
}

/** Verify support, walking space, and two-block headroom for every flatten column. */
export function verifyFlattenArea(bot: Bot, bounds: BlockBounds, walkingY = bounds.maxY, maxMismatches = 64): SkillResult<FlattenAreaVerification> {
  if (!Number.isInteger(walkingY) || walkingY < bounds.minY || walkingY > bounds.maxY) return { ok: false, status: "blocked", errorCode: "UNSAFE_GEOMETRY", message: "flatten walking plane is outside the authorized bounds", retryable: false };
  const mismatches: VerificationMismatch[] = [];
  const columns: FlattenColumnVerification[] = [];
  let inspected = 0;
  let verified = 0;
  const addMismatch = (x: number, y: number, z: number): void => {
    const found = mismatch(bot, x, y, z, false);
    if (found !== null && mismatches.length < maxMismatches) mismatches.push(found);
  };
  for (let z = bounds.minZ; z <= bounds.maxZ; z += 1) {
    for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
      const support = bot.blockAt(new Vec3(x, walkingY - 1, z));
      const walking = bot.blockAt(new Vec3(x, walkingY, z));
      const head = bot.blockAt(new Vec3(x, walkingY + 1, z));
      const secondHead = bot.blockAt(new Vec3(x, walkingY + 2, z));
      inspected += 4;
      columns.push({ x, z, walkingY, supportState: classifyObservedBlock(support), walkingState: classifyObservedBlock(walking), headState: classifyObservedBlock(head) });
      if (classifyObservedBlock(support) === "solid" && classifyObservedBlock(walking) === "passable" && classifyObservedBlock(head) === "passable" && classifyObservedBlock(secondHead) === "passable") verified += 1;
      else {
        addMismatch(x, walkingY - 1, z);
        addMismatch(x, walkingY, z);
        addMismatch(x, walkingY + 1, z);
        addMismatch(x, walkingY + 2, z);
      }
    }
  }
  const data = { bounds, walkingY, columns, inspected, verified, mismatches };
  if (mismatches.length > 0) return { ok: false, status: "blocked", errorCode: mismatches[0]?.errorCode ?? "UNSAFE_GEOMETRY", message: `flatten verification found ${mismatches.length} mismatched cell(s)`, data, retryable: false };
  return { ok: true, status: "completed", data, message: "flatten area verified" };
}
