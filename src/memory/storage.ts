import type { AppDatabase } from "./database.js";

/**
 * Persistence for storage containers (spec 21.4 / section 22). The bootstrap
 * STORAGE stage registers the chest it crafts and places at home, so later
 * phases (storage organization, delivery) can locate home storage without the
 * LLM re-discovering it.
 */
export interface StorageLocation {
  id: number;
  worldId: number;
  dimension: string;
  category: string;
  label: string | null;
  x: number;
  y: number;
  z: number;
  protected: number;
  lastSeenAt: string | null;
  /** Contents when the chest was last opened (survives restarts). */
  lastContents?: Record<string, number>;
}

export interface RegisterStorageInput {
  dimension: string;
  category: string;
  label?: string;
  x: number;
  y: number;
  z: number;
}

interface StorageRow {
  id: number;
  world_id: number;
  dimension: string;
  category: string;
  label: string | null;
  x: number;
  y: number;
  z: number;
  protected: number;
  last_seen_at: string | null;
  metadata_json?: string | null;
}

/** Home chests start as protected infrastructure (spec 21.4 `protected`). */
const STORAGE_PROTECTED = 1;

/**
 * Initial storage categories (spec 22). A single general chest is sufficient
 * at bootstrap; `organize_storage` creates per-category chests as capacity
 * and organization demand (Phase 11).
 */
export const STORAGE_CATEGORIES = [
  "general",
  "food",
  "wood",
  "stone",
  "ores",
  "valuables",
  "equipment",
  "mob_drops",
  "misc",
] as const;

/** A registered container category (spec 22's initial set). */
export type StorageCategory = (typeof STORAGE_CATEGORIES)[number];

export class StorageRepository {
  constructor(private readonly db: AppDatabase) {}

  /**
   * Insert a storage container, or refresh the row already standing at the
   * same (world, dimension, position) — idempotent re-runs of the STORAGE
   * stage must not duplicate the registration.
   */
  register(worldId: number, input: RegisterStorageInput): StorageLocation {
    const existing = this.db.sql
      .prepare(
        "SELECT id FROM storage_locations WHERE world_id = ? AND dimension = ? AND x = ? AND y = ? AND z = ?",
      )
      .get(worldId, input.dimension, input.x, input.y, input.z) as { id: number } | undefined;

    const timestamp = new Date().toISOString();
    if (existing) {
      this.db.sql
        .prepare(
          "UPDATE storage_locations SET category = ?, label = ?, last_seen_at = ? WHERE id = ?",
        )
        .run(input.category, input.label ?? null, timestamp, existing.id);
    } else {
      this.db.sql
        .prepare(
          `INSERT INTO storage_locations
             (world_id, dimension, category, label, x, y, z, protected, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          worldId,
          input.dimension,
          input.category,
          input.label ?? null,
          input.x,
          input.y,
          input.z,
          STORAGE_PROTECTED,
          timestamp,
        );
    }

    const row = this.db.sql
      .prepare(
        "SELECT * FROM storage_locations WHERE world_id = ? AND dimension = ? AND x = ? AND y = ? AND z = ?",
      )
      .get(worldId, input.dimension, input.x, input.y, input.z) as StorageRow;
    return this.toLocation(row);
  }

  /** Every registered container for a world, newest first. */
  list(worldId: number): StorageLocation[] {
    const rows = this.db.sql
      .prepare(
        "SELECT * FROM storage_locations WHERE world_id = ? ORDER BY id DESC",
      )
      .all(worldId) as StorageRow[];
    return rows.map((row) => this.toLocation(row));
  }

  /** Registered containers of one category for a world, newest first. */
  listByCategory(worldId: number, category: string): StorageLocation[] {
    const rows = this.db.sql
      .prepare(
        "SELECT * FROM storage_locations WHERE world_id = ? AND category = ? ORDER BY id DESC",
      )
      .all(worldId, category) as StorageRow[];
    return rows.map((row) => this.toLocation(row));
  }

  /**
   * Delete a registered container row — used by the home-chest restore path
   * to drop rows whose block no longer stands (destroyed or rolled back).
   * Measurement never mutates; only the restore reconciles the registry.
   */
  remove(worldId: number, id: number): void {
    this.db.sql
      .prepare("DELETE FROM storage_locations WHERE id = ? AND world_id = ?")
      .run(id, worldId);
  }

  /**
   * Record what a chest held when it was last opened. Kept in the row so a
   * restart away from home does not read the stock as empty: after a deploy
   * at 21:10 the bot, 100 blocks out, saw fuel 4 with 66 in the chest and
   * set off on a 60-coal run.
   */
  rememberContents(worldId: number, id: number, contents: Record<string, number>): void {
    this.db.sql
      .prepare("UPDATE storage_locations SET metadata_json = ?, last_seen_at = ? WHERE id = ? AND world_id = ?")
      .run(JSON.stringify({ contents }), new Date().toISOString(), id, worldId);
  }

  private toLocation(row: StorageRow): StorageLocation {
    return {
      id: row.id,
      worldId: row.world_id,
      dimension: row.dimension,
      category: row.category,
      label: row.label,
      x: row.x,
      y: row.y,
      z: row.z,
      protected: row.protected,
      lastSeenAt: row.last_seen_at,
      ...parseContents(row.metadata_json),
    };
  }
}

function parseContents(json: string | null | undefined): { lastContents?: Record<string, number> } {
  if (json === null || json === undefined || json === "") return {};
  try {
    const parsed = JSON.parse(json) as { contents?: Record<string, number> };
    return parsed.contents !== undefined && typeof parsed.contents === "object" ? { lastContents: parsed.contents } : {};
  } catch {
    return {};
  }
}
