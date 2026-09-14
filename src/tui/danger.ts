/**
 * Deterministic danger model (Phase 12, spec 33's State panel).
 *
 * The score is a single 0..1 figure built from hard, observable facts so a
 * developer can tell at a glance whether CobbleBob is in a risky spot:
 *
 * - night adds a flat 0.15 (mob spawns).
 * - low hunger adds 0.15 (no combat regen while starving).
 * - health below 16 scales to +0.30 at 0 (breaking work off is the skill
 *   layer's job; the score just measures margin).
 * - a hostile within 48 blocks adds up to 0.40, linear to distance 0.
 * - an active expedition risk band adds 0.10 (expedition) / 0.20 (deep).
 *
 * The result is clamped to [0, 1]. All inputs are ordinary numbers, so the
 * model stays independent of the LLM — it is measurement, not judgment.
 */

export interface DangerInput {
  /** Current health, 0..20. */
  health: number;
  /** Current hunger, 0..20. */
  hunger: number;
  /** True while the world clock is in the night phase. */
  night: boolean;
  /** Distance to the nearest hostile mob in blocks; null when none. */
  nearestHostileMeters: number | null;
  /** Active expedition risk band; null when within the home threshold. */
  expeditionTier: "near" | "expedition" | "deep" | null;
}

/** Hostiles farther than this contribute nothing (they are not a threat yet). */
export const DANGER_HOSTILE_HORIZON = 48;

const NIGHT_PENALTY = 0.15;
const HUNGER_PENALTY = 0.15;
const HEALTH_MAX_PENALTY = 0.3;
const HEALTH_FULL_MARGIN = 16;
const HOSTILE_MAX_PENALTY = 0.4;
const EXPEDITION_PENALTY: Record<"expedition" | "deep", number> = { expedition: 0.1, deep: 0.2 };

export function computeDangerScore(input: DangerInput): number {
  let score = 0.0;
  if (input.night) score += NIGHT_PENALTY;
  if (input.hunger < 8) score += HUNGER_PENALTY;
  if (input.health < HEALTH_FULL_MARGIN) {
    score += HEALTH_MAX_PENALTY * (1 - input.health / HEALTH_FULL_MARGIN);
  }
  const distance = input.nearestHostileMeters;
  if (distance !== null && Number.isFinite(distance) && distance < DANGER_HOSTILE_HORIZON) {
    score += HOSTILE_MAX_PENALTY * (1 - distance / DANGER_HOSTILE_HORIZON);
  }
  if (input.expeditionTier !== null && input.expeditionTier !== "near") {
    score += EXPEDITION_PENALTY[input.expeditionTier];
  }
  if (score < 0) score = 0;
  if (score > 1) score = 1;
  return score;
}