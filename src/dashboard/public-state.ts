import type { DashboardSnapshot } from "./types.js";

/**
 * Everything the public viewer page may learn about the bot. Built by
 * allowlist, never by deleting fields, so new snapshot fields stay private.
 * No coordinates, names, chat, goals, tasks, inventory or LLM activity.
 */
export interface PublicViewerState {
  public: true;
  connection: { connected: boolean };
  self: { health: number | null; hunger: number | null; dimension: string | null; timePhase: "day" | "night" | null };
  viewer: { status: DashboardSnapshot["viewer"]["status"] };
}

export function toPublicViewerState(snapshot: DashboardSnapshot): PublicViewerState {
  const round = (value: number | null): number | null => value === null ? null : Math.round(value);
  return {
    public: true,
    connection: { connected: snapshot.connection.connected === true },
    self: {
      health: round(snapshot.self.health),
      hunger: round(snapshot.self.hunger),
      dimension: snapshot.self.dimension,
      timePhase: snapshot.self.timePhase,
    },
    viewer: { status: snapshot.viewer.status },
  };
}

/** Caches the redacted state so public polling never drives snapshot cost. */
export function cachedPublicState(
  snapshot: () => DashboardSnapshot | Promise<DashboardSnapshot>,
  ttlMs = 1000,
  now: () => number = Date.now,
): () => Promise<PublicViewerState> {
  let cached: { at: number; value: Promise<PublicViewerState> } | null = null;
  return () => {
    if (cached !== null && now() - cached.at < ttlMs) return cached.value;
    const value = Promise.resolve().then(snapshot).then(toPublicViewerState);
    cached = { at: now(), value };
    value.catch(() => { if (cached?.value === value) cached = null; });
    return value;
  };
}
