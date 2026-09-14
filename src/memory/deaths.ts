import type { AppDatabase } from "./database.js";

/**
 * Persistence for death events (spec 21.7 / section 26, Phase 10). One row
 * per death: the site (world, dimension, position) and time, plus the
 * recovery outcome. `recovery_failed_reason` carries the explicit reason
 * (timeout, too_dangerous, items_despawned, path_unreachable, ...) so later
 * decisions can learn from it.
 */

export interface DeathEventRecord {
  id: number;
  worldId: number;
  dimension: string;
  x: number;
  y: number;
  z: number;
  recovered: boolean;
  recoveryFailedReason: string | null;
  /** Name -> count carried at death (the corpse contents); {} when unknown (pre-v6 rows). */
  inventory: Record<string, number>;
  /** Set when recovery was skipped without a trip (nothing worth carrying). */
  recoverySkippedReason: string | null;
  createdAt: string;
}

export interface RecordDeathInput {
  dimension: string;
  x: number;
  y: number;
  z: number;
  /** Items carried at death; omitted when none (or unknown). */
  inventory?: Record<string, number>;
}

interface DeathEventRow {
  id: number;
  world_id: number;
  dimension: string;
  x: number;
  y: number;
  z: number;
  recovered: number;
  recovery_failed_reason: string | null;
  inventory_json: string | null;
  recovery_skipped_reason: string | null;
  created_at: string;
}

const SELECT_COLUMNS = `
  SELECT id, world_id, dimension, x, y, z, recovered, recovery_failed_reason, inventory_json, recovery_skipped_reason, created_at
  FROM death_events`;

export class DeathEventsRepository {
  constructor(private readonly db: AppDatabase) {}

  /** Insert a death event; the row id and timestamp are generated here. */
  record(worldId: number, input: RecordDeathInput): DeathEventRecord {
    const createdAt = new Date().toISOString();
    const result = this.db.sql
      .prepare(
        `INSERT INTO death_events (world_id, dimension, x, y, z, inventory_json, recovered, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
      )
      .run(
        worldId,
        input.dimension,
        input.x,
        input.y,
        input.z,
        input.inventory === undefined ? null : JSON.stringify(input.inventory),
        createdAt,
      );
    const row = this.db.sql
      .prepare(`${SELECT_COLUMNS} WHERE id = ?`)
      .get(result.lastInsertRowid) as DeathEventRow;
    return this.toRecord(row);
  }

  get(id: number): DeathEventRecord | null {
    const row = this.db.sql
      .prepare(`${SELECT_COLUMNS} WHERE id = ?`)
      .get(id) as DeathEventRow | undefined;
    return row !== undefined ? this.toRecord(row) : null;
  }

  /** The most recent death for a world, or null when none is recorded. */
  latest(worldId: number): DeathEventRecord | null {
    const row = this.db.sql
      .prepare(`${SELECT_COLUMNS} WHERE world_id = ? ORDER BY id DESC LIMIT 1`)
      .get(worldId) as DeathEventRow | undefined;
    return row !== undefined ? this.toRecord(row) : null;
  }

  /** Most recent deaths for a world, newest first. */
  list(worldId: number, limit = 10): DeathEventRecord[] {
    const rows = this.db.sql
      .prepare(`${SELECT_COLUMNS} WHERE world_id = ? ORDER BY id DESC LIMIT ?`)
      .all(worldId, limit) as DeathEventRow[];
    return rows.map((row) => this.toRecord(row));
  }

  /** Mark the death's items as recovered. */
  markRecovered(id: number): void {
    this.db.sql
      .prepare("UPDATE death_events SET recovered = 1, recovery_failed_reason = NULL WHERE id = ?")
      .run(id);
  }

  /**
   * Mark recovery failed with the explicit reason. Never overwrites a
   * successful recovery (a later call cannot un-succeed an earlier one).
   */
  markFailed(id: number, reason: string): void {
    this.db.sql
      .prepare(
        "UPDATE death_events SET recovery_failed_reason = ? WHERE id = ? AND recovered = 0",
      )
      .run(reason, id);
  }

  /**
   * Mark recovery skipped without a trip (nothing worth carrying dropped).
   * First write wins, like markFailed: a stale supersede or stray mark can
   * never overwrite an earlier decision.
   */
  markSkipped(id: number, reason: string): void {
    this.db.sql
      .prepare(
        "UPDATE death_events SET recovery_skipped_reason = ? WHERE id = ? AND recovered = 0 AND recovery_skipped_reason IS NULL",
      )
      .run(reason, id);
  }

  private toRecord(row: DeathEventRow): DeathEventRecord {
    return {
      id: row.id,
      worldId: row.world_id,
      dimension: row.dimension,
      x: row.x,
      y: row.y,
      z: row.z,
      recovered: row.recovered === 1,
      recoveryFailedReason: row.recovery_failed_reason,
      inventory: parseInventoryJson(row.inventory_json),
      recoverySkippedReason: row.recovery_skipped_reason,
      createdAt: row.created_at,
    };
  }
}

/** Nominal inventory JSON; corrupt or absent payloads read as empty. */
function parseInventoryJson(raw: string | null): Record<string, number> {
  if (raw === null || raw === "") return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Record<string, number>;
  } catch {
    return {};
  }
}