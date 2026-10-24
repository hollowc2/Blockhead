import type { AppDatabase } from "./database.js";

/**
 * Persistence for the viewer story feed. Rows are the same coordinate-free
 * lines the feed shows, plus structured facts ("gathered 12 oak log") that
 * the private viewer's "since your last visit" summary counts.
 */
export interface StoredStoryEntry {
  id: number;
  at: string;
  icon: string;
  text: string;
  highlight: boolean;
  facts?: StoryFacts;
}

/** Structured facts behind a story line; never shown to the public viewer. */
export interface StoryFacts {
  kind: "gathered" | "build_finished" | "build_started" | "death" | "goal_completed" | "goal_started" | "recovered" | "tool_broken";
  resource?: string;
  count?: number;
  structure?: string;
  killer?: string | null;
  item?: string;
}

interface StoryRow { id: number; at: string; icon: string; text: string; highlight: number; facts_json: string | null }

/** Rows older than this many entries are pruned so the table stays bounded. */
const MAX_ROWS = 5000;

export class StoryRepository {
  private inserts = 0;

  constructor(private readonly db: AppDatabase) {}

  append(entry: Omit<StoredStoryEntry, "id">): number {
    const result = this.db.sql
      .prepare("INSERT INTO story_entries (at, icon, text, highlight, facts_json) VALUES (?, ?, ?, ?, ?)")
      .run(entry.at, entry.icon, entry.text, entry.highlight ? 1 : 0, entry.facts === undefined ? null : JSON.stringify(entry.facts));
    if (++this.inserts % 100 === 0) {
      this.db.sql.prepare("DELETE FROM story_entries WHERE id <= (SELECT MAX(id) FROM story_entries) - ?").run(MAX_ROWS);
    }
    return Number(result.lastInsertRowid);
  }

  /** The newest `limit` entries, oldest first. */
  recent(limit: number): StoredStoryEntry[] {
    const rows = this.db.sql
      .prepare("SELECT id, at, icon, text, highlight, facts_json FROM story_entries ORDER BY id DESC LIMIT ?")
      .all(Math.max(1, limit)) as StoryRow[];
    return rows.reverse().map(toEntry);
  }

  /** Entries strictly after `since` (ISO time), oldest first, newest `limit` kept. */
  since(since: string, limit: number): StoredStoryEntry[] {
    const rows = this.db.sql
      .prepare("SELECT id, at, icon, text, highlight, facts_json FROM story_entries WHERE at > ? ORDER BY id DESC LIMIT ?")
      .all(since, Math.max(1, limit)) as StoryRow[];
    return rows.reverse().map(toEntry);
  }

  /** Every fact row after `since`, for summaries (facts only, bounded). */
  factsSince(since: string): StoryFacts[] {
    const rows = this.db.sql
      .prepare("SELECT facts_json FROM story_entries WHERE at > ? AND facts_json IS NOT NULL ORDER BY id DESC LIMIT ?")
      .all(since, MAX_ROWS) as { facts_json: string }[];
    return rows.flatMap((row) => {
      try { return [JSON.parse(row.facts_json) as StoryFacts]; } catch { return []; }
    });
  }
}

function toEntry(row: StoryRow): StoredStoryEntry {
  let facts: StoryFacts | undefined;
  if (row.facts_json !== null) {
    try { facts = JSON.parse(row.facts_json) as StoryFacts; } catch { facts = undefined; }
  }
  return { id: row.id, at: row.at, icon: row.icon, text: row.text, highlight: row.highlight === 1, ...(facts === undefined ? {} : { facts }) };
}
