import type { AppDatabase } from "./database.js";

/**
 * Persistence for known resource sites (spec 21.8 / section 27 stage 3).
 *
 * `collect_resource` consults non-depleted sites for the requested resource
 * before searching fresh terrain, refreshes `last_seen_at` whenever a site
 * yields progress, and marks a site depleted when a visit gains nothing.
 * The LLM never sees or edits these rows; the skill writes them.
 */
export interface ResourceSite {
  id: number;
  worldId: number;
  dimension: string;
  resource: string;
  x: number;
  y: number;
  z: number;
  confidence: number;
  depleted: number;
  lastSeenAt: string | null;
}

export interface RegisterSiteInput {
  dimension: string;
  resource: string;
  x: number;
  y: number;
  z: number;
  /** Confidence the site is real (0..1); kept at 1.0 by the Phase 6 skill. */
  confidence?: number;
}

interface SiteRow {
  id: number;
  world_id: number;
  dimension: string;
  resource: string;
  x: number;
  y: number;
  z: number;
  confidence: number;
  depleted: number;
  last_seen_at: string | null;
}

export class ResourceSitesRepository {
  constructor(private readonly db: AppDatabase) {}

  /**
   * Non-depleted sites for one (world, dimension, resource), most recently
   * seen first. The skill tries these before expanding a fresh search.
   */
  listByResource(worldId: number, dimension: string, resource: string): ResourceSite[] {
    const rows = this.db.sql
      .prepare(
        `SELECT * FROM resource_sites
         WHERE world_id = ? AND dimension = ? AND resource = ? AND depleted = 0
         ORDER BY last_seen_at DESC, id DESC`,
      )
      .all(worldId, dimension, resource) as SiteRow[];
    return rows.map((row) => this.toSite(row));
  }

  /**
   * Insert a site, or refresh the row already standing at the same
   * (world, dimension, resource, position): re-seen sites clear `depleted`
   * and bump their timestamp, so a later visit retries them.
   */
  register(worldId: number, input: RegisterSiteInput): ResourceSite {
    const timestamp = new Date().toISOString();
    const confidence = input.confidence ?? 1.0;
    this.db.sql
      .prepare(
        `INSERT INTO resource_sites (world_id, dimension, resource, x, y, z, confidence, depleted, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
         ON CONFLICT(world_id, dimension, resource, x, y, z) DO UPDATE SET
           confidence = excluded.confidence,
           depleted = 0,
           last_seen_at = excluded.last_seen_at`,
      )
      .run(
        worldId,
        input.dimension,
        input.resource,
        input.x,
        input.y,
        input.z,
        confidence,
        timestamp,
      );

    const row = this.db.sql
      .prepare(
        `SELECT * FROM resource_sites
         WHERE world_id = ? AND dimension = ? AND resource = ? AND x = ? AND y = ? AND z = ?`,
      )
      .get(worldId, input.dimension, input.resource, input.x, input.y, input.z) as SiteRow;
    return this.toSite(row);
  }

  /** Mark a site depleted: visiting it gained nothing, so stop retrying it. */
  markDepleted(worldId: number, id: number): void {
    this.db.sql
      .prepare("UPDATE resource_sites SET depleted = 1, last_seen_at = ? WHERE world_id = ? AND id = ?")
      .run(new Date().toISOString(), worldId, id);
  }

  private toSite(row: SiteRow): ResourceSite {
    return {
      id: row.id,
      worldId: row.world_id,
      dimension: row.dimension,
      resource: row.resource,
      x: row.x,
      y: row.y,
      z: row.z,
      confidence: row.confidence,
      depleted: row.depleted,
      lastSeenAt: row.last_seen_at,
    };
  }
}