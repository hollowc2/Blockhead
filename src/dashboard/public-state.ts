import type { StoryEntry } from "./story.js";
import type { DashboardSnapshot } from "./types.js";
import type { WorldStatsSummary } from "./world-stats.js";

/**
 * Everything the public viewer page may learn about the bot. Built by
 * allowlist, never by deleting fields, so new snapshot fields stay private.
 * No coordinates, names, chat, goals, tasks, inventory or LLM activity.
 * The story feed and lifetime stats are built coordinate-free at the source.
 */
export interface PublicViewerState {
  public: true;
  /** Fresh server-derived flags may be attached by the public listener. */
  interactions?: { questions: boolean; actions: boolean };
  connection: { connected: boolean };
  self: { health: number | null; hunger: number | null; dimension: string | null; timePhase: "day" | "night" | null };
  viewer: { status: DashboardSnapshot["viewer"]["status"] };
  story: readonly StoryEntry[];
  world: WorldStatsSummary | null;
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
    story: (snapshot.story ?? []).map(({ id, at, icon, text, highlight }) => ({ id, at, icon, text, highlight })),
    world: snapshot.world ?? null,
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
