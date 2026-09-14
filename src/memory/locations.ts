import type { HomeLocation } from "../minecraft/movement.js";
import { DEFAULT_HOME_POLICY, type ProtectedRegion } from "../minecraft/protection.js";
import type { AppDatabase } from "./database.js";

/** World identity row (spec 21.1). Identity is server + world; dimension scopes rows below. */
export interface WorldRow {
  id: number;
  serverKey: string;
  worldKey: string;
}

export interface StoredProtectedRegion extends ProtectedRegion {
  id: number;
  worldId: number;
  createdAt: string;
}

interface LocationRow {
  id: number;
  world_id: number;
  dimension: string;
  name: string;
  category: string;
  x: number;
  y: number;
  z: number;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
}

interface ProtectedRegionRow {
  id: number;
  world_id: number;
  dimension: string;
  name: string;
  min_x: number;
  max_x: number;
  min_y: number | null;
  max_y: number | null;
  min_z: number;
  max_z: number;
  policy_json: string | null;
  created_at: string;
}

const HOME_LOCATION_NAME = "home";

/**
 * Persistence for world identity, named locations, and protected regions
 * (spec sections 20-21).
 */
export class LocationsRepository {
  constructor(private readonly db: AppDatabase) {}

  // --- worlds ---

  /** Look up the world row for (server, world), inserting it on first sight. */
  getOrCreateWorld(serverKey: string, worldKey: string): WorldRow {
    const existing = this.db.sql
      .prepare("SELECT id, server_key AS serverKey, world_key AS worldKey FROM worlds WHERE server_key = ? AND world_key = ?")
      .get(serverKey, worldKey) as WorldRow | undefined;
    if (existing) return existing;

    const result = this.db.sql
      .prepare("INSERT INTO worlds (server_key, world_key, created_at) VALUES (?, ?, ?)")
      .run(serverKey, worldKey, now());
    return { id: Number(result.lastInsertRowid), serverKey, worldKey };
  }

  // --- locations (home) ---

  /** The persisted home for a world, or null before the first seed. */
  getHome(worldId: number): HomeLocation | null {
    const row = this.db.sql
      .prepare(
        "SELECT x, y, z, dimension FROM locations WHERE world_id = ? AND name = ? ORDER BY id DESC LIMIT 1",
      )
      .get(worldId, HOME_LOCATION_NAME) as Pick<LocationRow, "x" | "y" | "z" | "dimension"> | undefined;
    return row ? { x: row.x, y: row.y, z: row.z, dimension: row.dimension } : null;
  }

  /** Insert or update the home location for (world, dimension). */
  saveHome(worldId: number, home: HomeLocation): void {
    const timestamp = now();
    this.db.sql
      .prepare(
        `INSERT INTO locations (world_id, dimension, name, category, x, y, z, created_at, updated_at)
         VALUES (?, ?, ?, 'home', ?, ?, ?, ?, ?)
         ON CONFLICT(world_id, dimension, name) DO UPDATE SET
           x = excluded.x, y = excluded.y, z = excluded.z, updated_at = excluded.updated_at`,
      )
      .run(worldId, home.dimension, HOME_LOCATION_NAME, home.x, home.y, home.z, timestamp, timestamp);
  }

  // --- named memory locations (spec 14.5: remember/find/forget) ---

  /**
   * A named waypoint, resolved by (world, name) regardless of dimension. The
   * "home" name is owned by the home row; waypoints use any other name.
   */
  getNamedLocation(worldId: number, name: string): { dimension: string; name: string; x: number; y: number; z: number } | null {
    const row = this.db.sql
      .prepare(
        "SELECT dimension, name, x, y, z FROM locations WHERE world_id = ? AND name = ? ORDER BY id DESC LIMIT 1",
      )
      .get(worldId, name) as { dimension: string; name: string; x: number; y: number; z: number } | undefined;
    return row ?? null;
  }

  /** Insert or update a named waypoint (world + name, latest dimension wins). */
  saveNamedLocation(
    worldId: number,
    input: { dimension: string; name: string; x: number; y: number; z: number },
  ): void {
    const timestamp = now();
    const existing = this.db.sql
      .prepare(
        "SELECT id FROM locations WHERE world_id = ? AND name = ? AND category = 'waypoint' ORDER BY id DESC LIMIT 1",
      )
      .get(worldId, input.name) as { id: number } | undefined;
    if (existing) {
      this.db.sql
        .prepare(
          "UPDATE locations SET dimension = ?, x = ?, y = ?, z = ?, updated_at = ? WHERE id = ?",
        )
        .run(input.dimension, input.x, input.y, input.z, timestamp, existing.id);
    } else {
      this.db.sql
        .prepare(
          `INSERT INTO locations (world_id, dimension, name, category, x, y, z, created_at, updated_at)
           VALUES (?, ?, ?, 'waypoint', ?, ?, ?, ?, ?)`,
        )
        .run(worldId, input.dimension, input.name, input.x, input.y, input.z, timestamp, timestamp);
    }
  }

  /** Remove every waypoint row with the name (across dimensions). */
  deleteNamedLocation(worldId: number, name: string): boolean {
    const result = this.db.sql
      .prepare("DELETE FROM locations WHERE world_id = ? AND name = ? AND category = 'waypoint'")
      .run(worldId, name);
    return result.changes > 0;
  }

  // --- protected regions ---
  getProtectedRegion(worldId: number, name: string): StoredProtectedRegion | null {
    const row = this.db.sql
      .prepare(
        "SELECT * FROM protected_regions WHERE world_id = ? AND name = ? ORDER BY id DESC LIMIT 1",
      )
      .get(worldId, name) as ProtectedRegionRow | undefined;
    if (!row) return null;
    return {
      id: row.id,
      worldId: row.world_id,
      name: row.name,
      dimension: row.dimension,
      bounds: {
        minX: row.min_x,
        maxX: row.max_x,
        minY: row.min_y ?? undefined,
        maxY: row.max_y ?? undefined,
        minZ: row.min_z,
        maxZ: row.max_z,
      },
      policy: parsePolicy(row.policy_json),
      createdAt: row.created_at,
    };
  }

  /** Insert or update a protected region by (world, name). */
  saveProtectedRegion(worldId: number, region: ProtectedRegion): void {
    this.db.sql
      .prepare(
        `INSERT INTO protected_regions
           (world_id, dimension, name, min_x, max_x, min_y, max_y, min_z, max_z, policy_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(world_id, name) DO UPDATE SET
           dimension = excluded.dimension,
           min_x = excluded.min_x, max_x = excluded.max_x,
           min_y = excluded.min_y, max_y = excluded.max_y,
           min_z = excluded.min_z, max_z = excluded.max_z,
           policy_json = excluded.policy_json`,
      )
      .run(
        worldId,
        region.dimension,
        region.name,
        region.bounds.minX,
        region.bounds.maxX,
        region.bounds.minY ?? null,
        region.bounds.maxY ?? null,
        region.bounds.minZ,
        region.bounds.maxZ,
        JSON.stringify(region.policy),
        now(),
      );
  }
}

function now(): string {
  return new Date().toISOString();
}

function parsePolicy(json: string | null): ProtectedRegion["policy"] {
  if (!json) return DEFAULT_HOME_POLICY;
  try {
    const parsed = JSON.parse(json) as ProtectedRegion["policy"];
    return typeof parsed === "object" && parsed !== null ? parsed : DEFAULT_HOME_POLICY;
  } catch {
    return DEFAULT_HOME_POLICY;
  }
}