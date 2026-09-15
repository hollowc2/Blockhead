import type { Bot } from "mineflayer";
import type { ToolContext } from "../tools/types.js";

/** The chat that triggered a decision. */
export interface DecisionInput {
  from: string;
  instruction: string;
}

/**
 * The exact state object sent to the LLM (spec section 19). Kept tight and
 * high-signal; this same object is written verbatim to the debug log so bad
 * decisions can be reproduced (spec 32.2).
 */
export interface StateSnapshot {
  self: {
    position: { x: number; y: number; z: number } | null;
    dimension: string | null;
    health: number;
    hunger: number;
  };
  task: {
    active: string | null;
    progress: string | null;
    lastError: string | null;
  };
  nearby: {
    players: { name: string; distance: number }[];
  };
  recentEvents: string[];
  /**
   * High-level actions currently blocked by the anti-loop watchdog (same
   * task type + normalized arguments failed repeatedly). Each entry names
   * the action, why it was blocked, and when a retry is allowed; the model
   * should pick something else or wait instead of re-attempting one.
   */
  blockedActions: { action: string; reason: string; retryInSeconds: number }[];
  from: string;
  instruction: string;
}

/** Compact list of visible players sorted by distance, excluding the bot. */
function nearbyPlayers(bot: Bot): { name: string; distance: number }[] {
  const selfPos = bot.entity?.position;
  if (!selfPos) return [];
  const players: { name: string; distance: number }[] = [];
  for (const [name, player] of Object.entries(bot.players)) {
    if (name === bot.username) continue;
    const pos = player.entity?.position;
    if (!pos) continue;
    const distance = Math.hypot(selfPos.x - pos.x, selfPos.y - pos.y, selfPos.z - pos.z);
    players.push({ name, distance: Math.round(distance) });
  }
  players.sort((a, b) => a.distance - b.distance);
  return players;
}

/** Build the exact state snapshot handed to the LLM. */
export function buildStateSnapshot(ctx: ToolContext, input: DecisionInput): StateSnapshot {
  const self = ctx.state.self;
  const active = ctx.scheduler.active;
  return {
    self: {
      position: self.position,
      dimension: self.dimension,
      health: self.health,
      hunger: self.food,
    },
    task: {
      active: active?.objective ?? null,
      progress: active?.resumeState ? JSON.stringify(active.resumeState) : null,
      lastError: active?.lastError ?? null,
    },
    nearby: {
      players: nearbyPlayers(ctx.bot),
    },
    recentEvents: [...ctx.state.recentEvents],
    blockedActions: [...ctx.scheduler.blockedActions()],
    from: input.from,
    instruction: input.instruction,
  };
}
