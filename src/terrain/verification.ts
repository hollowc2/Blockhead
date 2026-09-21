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
