/**
 * Shared skill-layer contract (spec sections 12.2, 27, 35).
 *
 * Every skill returns a structured `SkillResult`, and every search skill
 * (`collect_resource`, and later `hunt`, `search_for`, ...) expands through
 * the same radius sequence with the same status-message format, so behavior
 * stays uniform across skills.
 */

import type { Bot } from "mineflayer";

/** Structured result every skill returns (spec 35). */
export interface SkillResult<T = unknown> {
  ok: boolean;
  status: "completed" | "partial" | "blocked" | "failed" | "interrupted";
  data?: T;
  errorCode?: string;
  message?: string;
  retryable?: boolean;
}

/** Failure codes shared across skills (spec 35's examples, plus Phase 6). */
export type SkillErrorCode =
  | "RESOURCE_NOT_FOUND"
  | "PATH_UNREACHABLE"
  | "TOOL_REQUIRED"
  | "INVENTORY_FULL"
  | "DANGER_TOO_HIGH"
  | "PROTECTED_REGION"
  | "NOT_READY"
  | "ALREADY_RUNNING"
  | "INVALID_RESOURCE"
  | "STORAGE_NOT_FOUND"
  | "STORAGE_UNREACHABLE"
  | "WRONG_DIMENSION"
  /** Phase 13 (spec 14.3): a production chain ran out of materials. */
  | "INSUFFICIENT_MATERIALS"
  /** Phase 13 (spec 25): the combat policy refused a human target. */
  | "PVP_FORBIDDEN"
  /** Phase 13 (spec 34): an unapproved dimension entry was refused. */
  | "DIMENSION_FORBIDDEN"
  /** Phase 9: the pre-expedition supply check refused travel beyond the threshold. */
  | "EXPEDITION_BLOCKED"
  /** Phase 10: the death-recovery sweep ran out of wall-clock budget. */
  | "TIMEOUT"
  /** Phase 10: nothing of the dropped items was left to pick up. */
  | "ITEMS_DESPAWNED"
  /**
   * Hunt health gate: health is at/below the hunting minimum and hunger is
   * below the regen threshold, so the bot cannot recover by itself. External
   * state change (food in, healing) is required before retrying.
   */
  | "LOW_HEALTH"
  /** Hunt health gate: waited out natural regen and health never recovered. */
  | "REGEN_TIMEOUT";

/**
 * The consistent search-expansion sequence (spec 12.2). Searches start at the
 * first radius and expand one step at a time; every meaningful expansion is
 * announced with `expansionMessage`.
 */
export const SEARCH_RADIUS_SEQUENCE: readonly number[] = [32, 64, 128, 256, 512, 1024];

/** The largest radius a search will reach before giving up. */
export const MAX_SEARCH_RADIUS = SEARCH_RADIUS_SEQUENCE[SEARCH_RADIUS_SEQUENCE.length - 1] ?? 1024;

/** The next radius strictly greater than `current`, or null past the sequence end. */
export function nextSearchRadius(current: number): number | null {
  for (const radius of SEARCH_RADIUS_SEQUENCE) {
    if (radius > current) return radius;
  }
  return null;
}

/**
 * The fixed expansion status message (spec 12.2):
 * "No oak within 128 blocks. Expanding search."
 */
export function expansionMessage(resourceStem: string, radius: number): string {
  return `No ${resourceStem} within ${radius} blocks. Expanding search.`;
}

/** Suffix words that carry the noun in a Minecraft item name ("oak_log" -> "oak"). */
const STEM_SUFFIXES = [
  "log",
  "wood",
  "leaves",
  "ore",
  "block",
  "planks",
  "sapling",
  "wool",
  "ingot",
];

/** "oak_log" -> "oak", "iron_ore" -> "iron", "stone" -> "stone". */
export function resourceStem(name: string): string {
  const bare = name.replace(/^minecraft:/, "").replace(/_/g, " ");
  for (const suffix of STEM_SUFFIXES) {
    if (bare.endsWith(` ${suffix}`)) return bare.slice(0, bare.length - suffix.length - 1);
  }
  return bare;
}

/** Batched/item names that already read plural in mass form. */
const MASS_NOUNS: Record<string, true> = {
  stone: true,
  cobblestone: true,
  sand: true,
  gravel: true,
  dirt: true,
  coal: true,
};

/** "oak_log" -> "oak logs", "iron_ore" -> "iron ore", "stone" -> "stone". */
export function resourceLabel(name: string): string {
  const bare = name.replace(/^minecraft:/, "").replace(/_/g, " ");
  if (MASS_NOUNS[bare] === true || bare.endsWith("s")) return bare;
  return `${bare}s`;
}

/**
 * Throttle identical game-chat announcements so a stuck restore loop cannot
 * spam the server into a `disconnect.spam` kick. `logger.info` is never
 * throttled — only the in-game chat line is. Per runner instance, each
 * distinct message passes at most once per `throttleMs`: a stuck reason
 * goes quiet while a changed reason is still heard — and a message cannot
 * sneak its way back through by alternating with another (the window is
 * tracked per message, not per last line).
 */
export class ChatThrottle {
  /** Last allowed send per distinct message. */
  private readonly lastSentAt = new Map<string, number>();

  constructor(
    private readonly throttleMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** True when `message` may be sent to game chat now. */
  allow(message: string): boolean {
    const now = this.now();
    const last = this.lastSentAt.get(message);
    if (last !== undefined && now - last < this.throttleMs) return false;
    this.lastSentAt.set(message, now);
    // The per-skill message set is small and closed; keep the map bounded
    // anyway so a pathological caller cannot grow it without limit.
    if (this.lastSentAt.size > 32) {
      for (const [msg, at] of this.lastSentAt) {
        if (now - at >= this.throttleMs) this.lastSentAt.delete(msg);
      }
    }
    return true;
  }
}

/**
 * Minimum wall-clock gap between ANY two game-chat announcements, process-
 * wide. Per-message throttling (above) stops identical repeats, but different
 * skills can still emit different lines back-to-back — a stuck food hunt and
 * a torches expansion arrive as one burst, and a server's spam filter counts
 * the burst regardless of content. 15s keeps statuses audible while staying
 * far under vanilla Minecraft's sustained ~1-msg/4s threshold.
 */
export const GLOBAL_CHAT_INTERVAL_MS = 15_000;

/** Internal key: the budget throttle is a pure rate limiter, one slot. */
const GLOBAL_CHAT_BUDGET_KEY = "__chat_budget__";

/**
 * Process-lifetime budget shared by every skill runner: at most one
 * announcement reaches game chat per `GLOBAL_CHAT_INTERVAL_MS`, no matter
 * which runner or how distinct its messages are. Module state survives
 * session reconnects, so a kicked session cannot reconnect and start with a
 * fresh flood — the burst that likely caused the kick stays throttled.
 */
const globalChatBudget = new ChatThrottle(GLOBAL_CHAT_INTERVAL_MS);

/** True when the process-wide budget allows one more game-chat announcement. */
export function gameChatBudgetAllows(): boolean {
  return globalChatBudget.allow(GLOBAL_CHAT_BUDGET_KEY);
}

/** Wait `ms` milliseconds without busy-looping. */
export function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/**
 * Race `promise` against a wall-clock timeout. On timeout the optional hook
 * runs first (e.g. to cancel an in-flight plugin task) and an Error is thrown.
 */
export async function withTimeout<T>(timeoutMs: number, promise: Promise<T>, onTimeout?: () => void | Promise<void>, signal?: AbortSignal): Promise<T> {
  const awaited = promise.then(
    (value) => ({ ok: true, value } as const),
    (error) => ({ ok: false, error: String(error) } as const),
  );
  const { promise: timer, resolve: resolveTimer } = Promise.withResolvers<{ timedOut: true }>();
  const timeoutHandle = setTimeout(() => resolveTimer({ timedOut: true }), timeoutMs);
  const abortHandler = (): void => resolveTimer({ timedOut: true });
  signal?.addEventListener("abort", abortHandler, { once: true });

  const winner = await Promise.race([awaited, timer]);
  if (winner && typeof winner === "object" && "timedOut" in winner) {
    clearTimeout(timeoutHandle);
    signal?.removeEventListener("abort", abortHandler);
    if (onTimeout) await onTimeout();
    throw signal?.aborted ? new DOMException("operation aborted", "AbortError") : new Error(`operation timed out after ${timeoutMs}ms`);
  }
  clearTimeout(timeoutHandle);
  signal?.removeEventListener("abort", abortHandler);
  if (winner.ok) {
    if (signal?.aborted) throw new DOMException("operation aborted", "AbortError");
    return winner.value;
  }
  if (signal?.aborted) throw new DOMException("operation aborted", "AbortError");
  throw new Error(winner.error);
}

/**
 * Health at or below which the hunt skills (`bootstrap` FOOD/WOOL and the
 * `gather_food` runner) break off rather than fight.
 */
export const HUNT_MIN_HEALTH = 8;

/**
 * Vanilla Minecraft regenerates health only while the hunger bar sits above
 * ~17.5/20, so below this threshold there is no natural self-recovery.
 */
export const REGEN_HUNGER_THRESHOLD = 18;

/** How long `recoverLowHealth` waits out natural regen before giving back. */
const HEALTH_RECOVERY_WAIT_MS = 3 * 60_000;

/** Poll cadence while waiting out regen (regen ticks every half second). */
const HEALTH_RECOVERY_POLL_MS = 2_000;

const healthText = (value: number): string => (Math.round(value * 10) / 10).toString();

/**
 * Recovery for the hunt health gate: when health is at or below
 * `HUNT_MIN_HEALTH` and the game permits healing, wait it out instead of
 * failing the stage — callers enable auto-eat before hunting, so carried
 * food heals, and a full enough stomach heals by itself. When neither
 * recovery exists (empty stomach, no food) there is nothing to wait for, so
 * fail immediately with an actionable reason instead of letting the stage
 * retry loop repeat a deadlock.
 */
export async function recoverLowHealth(
  bot: Bot,
): Promise<{ ok: true } | { ok: false; reason: string; code: "LOW_HEALTH" | "REGEN_TIMEOUT" }> {
  const health = Number.isFinite(bot.health) ? bot.health : 0;
  if (health > HUNT_MIN_HEALTH) return { ok: true };
  const hunger = Number.isFinite(bot.food) ? bot.food : 0;
  if (hunger < REGEN_HUNGER_THRESHOLD) {
    return {
      ok: false,
      code: "LOW_HEALTH",
      reason: `health too low (${healthText(health)}/20) to hunt and hunger ${healthText(hunger)}/20 cannot regenerate — feed CobbleBob or let it die to respawn`,
    };
  }
  const deadline = Date.now() + HEALTH_RECOVERY_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(HEALTH_RECOVERY_POLL_MS);
    if (bot.health > HUNT_MIN_HEALTH) return { ok: true };
  }
  return {
    ok: false,
    code: "REGEN_TIMEOUT",
    reason: `health still ${healthText(Number.isFinite(bot.health) ? bot.health : 0)}/20 after ${HEALTH_RECOVERY_WAIT_MS / 1000}s waiting for regeneration`,
  };
}
