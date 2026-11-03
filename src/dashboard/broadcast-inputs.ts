import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { VitalsSample } from "./types.js";

/**
 * Process-lifetime memory behind the broadcast fields: a one-hour vitals
 * ring for the sparkline and every player name seen, so the public filters
 * keep rejecting a name after that player logs off. In memory only, never
 * SQLite: losing it on restart costs an hour of sparkline, nothing more.
 */

/** The sampler runs once a minute; the ring holds one hour. */
export const VITALS_INTERVAL_MS = 60_000;
const VITALS_WINDOW_MS = 3_600_000;
const VITALS_CAPACITY = 60;
/** Bounds memory if a server's usercache is huge; oldest names drop first. */
const MAX_NAMES = 5_000;
/** Server files that list players: allowed, operators, banned, and everyone who ever joined. */
const PLAYER_FILES = ["whitelist.json", "ops.json", "banned-players.json", "usercache.json"];

export class BroadcastTracker {
  private readonly samples: Array<VitalsSample & { atMs: number }> = [];
  private readonly seen = new Map<string, string>();

  /** Record one minute's vitals; null values mark time spent disconnected. */
  sampleVitals(nowMs: number, health: number | null, hunger: number | null): void {
    const finite = (value: number | null): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
    this.samples.push({ atMs: nowMs, at: new Date(nowMs).toISOString(), health: finite(health), hunger: finite(hunger) });
    if (this.samples.length > VITALS_CAPACITY) this.samples.splice(0, this.samples.length - VITALS_CAPACITY);
  }

  /** Samples from the last hour, oldest first. */
  vitals(nowMs: number): VitalsSample[] {
    return this.samples.filter((sample) => sample.atMs > nowMs - VITALS_WINDOW_MS).map(({ at, health, hunger }) => ({ at, health, hunger }));
  }

  noteNames(names: Iterable<unknown>): void {
    for (const name of names) {
      if (typeof name !== "string") continue;
      const trimmed = name.trim();
      if (trimmed === "" || trimmed.length > 64) continue;
      const key = trimmed.toLowerCase();
      this.seen.delete(key);
      this.seen.set(key, trimmed);
    }
    while (this.seen.size > MAX_NAMES) this.seen.delete(this.seen.keys().next().value!);
  }

  names(): string[] { return [...this.seen.values()]; }
}

/** Player names from the server's own lists. Missing or malformed files are skipped. */
export function readServerPlayerNames(serverDir: string | null | undefined): string[] {
  if (!serverDir) return [];
  const names: string[] = [];
  for (const file of PLAYER_FILES) {
    try {
      const entries: unknown = JSON.parse(readFileSync(join(serverDir, file), "utf8"));
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        const name = (entry as { name?: unknown } | null)?.name;
        if (typeof name === "string") names.push(name);
      }
    } catch { /* not there or unreadable: other sources still apply */ }
  }
  return names;
}
