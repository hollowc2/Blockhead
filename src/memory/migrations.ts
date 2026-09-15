/**
 * Sequential SQL migrations, one entry per version (spec section 21).
 * Applied in order under `PRAGMA user_version` bookkeeping.
 */
export const MIGRATIONS: readonly string[] = [
  // v1: core tables needed for Phase 3 state/persistence.
  `
  CREATE TABLE IF NOT EXISTS worlds (
      id INTEGER PRIMARY KEY,
      server_key TEXT NOT NULL,
      world_key TEXT NOT NULL,
      display_name TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(server_key, world_key)
  );

  CREATE TABLE IF NOT EXISTS locations (
      id INTEGER PRIMARY KEY,
      world_id INTEGER NOT NULL,
      dimension TEXT NOT NULL,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      x REAL NOT NULL,
      y REAL NOT NULL,
      z REAL NOT NULL,
      metadata_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(world_id) REFERENCES worlds(id)
  );

  -- Named memory locations (home, farms, ...) are upserted by world+dimension+name.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_locations_world_dimension_name
      ON locations(world_id, dimension, name);

  CREATE TABLE IF NOT EXISTS protected_regions (
      id INTEGER PRIMARY KEY,
      world_id INTEGER NOT NULL,
      dimension TEXT NOT NULL,
      name TEXT NOT NULL,
      min_x INTEGER NOT NULL,
      max_x INTEGER NOT NULL,
      min_y INTEGER,
      max_y INTEGER,
      min_z INTEGER NOT NULL,
      max_z INTEGER NOT NULL,
      policy_json TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(world_id) REFERENCES worlds(id)
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_protected_regions_world_name
      ON protected_regions(world_id, name);

  CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      priority INTEGER NOT NULL,
      source TEXT NOT NULL,
      objective TEXT NOT NULL,
      parameters_json TEXT NOT NULL,
      status TEXT NOT NULL,
      resume_state_json TEXT,
      parent_task_id TEXT,
      interrupted_task_id TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT
  );

  -- Skill success table exists now for schema stability; records are written
  -- by the skill system in a later phase.
  CREATE TABLE IF NOT EXISTS skill_successes (
      id TEXT PRIMARY KEY,
      skill_name TEXT NOT NULL,
      parameters_json TEXT NOT NULL,
      starting_conditions_json TEXT NOT NULL,
      outcome_json TEXT NOT NULL,
      description TEXT NOT NULL,
      created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_skill_successes_name ON skill_successes(skill_name);
  `,
  // v2: bootstrap resumability (spec 7.2). One row per world: the last
  // completed bootstrap stage; the runner resumes from the next stage.
  `
  CREATE TABLE IF NOT EXISTS bootstrap_state (
      world_id INTEGER PRIMARY KEY,
      stage TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(world_id) REFERENCES worlds(id)
  );
  `,
  // v3: storage containers (spec 21.4). The bootstrap STORAGE stage registers
  // the chest it crafts and places at home (spec 22), so later phases can
  // locate home storage without re-discovering it.
  `
  CREATE TABLE IF NOT EXISTS storage_locations (
      id INTEGER PRIMARY KEY,
      world_id INTEGER NOT NULL,
      dimension TEXT NOT NULL,
      category TEXT NOT NULL,
      label TEXT,
      x INTEGER NOT NULL,
      y INTEGER NOT NULL,
      z INTEGER NOT NULL,
      protected INTEGER NOT NULL DEFAULT 1,
      last_seen_at TEXT,
      metadata_json TEXT,
      FOREIGN KEY(world_id) REFERENCES worlds(id)
  );
  `,
  // v4: known resource sites (spec 21.8). `collect_resource` consults these
  // before searching fresh terrain (spec 27 stage 3), refreshes last_seen_at
  // on successful visits, and marks a site depleted once a visit gains
  // nothing. One row per (world, dimension, resource, position).
  `
  CREATE TABLE IF NOT EXISTS resource_sites (
      id INTEGER PRIMARY KEY,
      world_id INTEGER NOT NULL,
      dimension TEXT NOT NULL,
      resource TEXT NOT NULL,
      x REAL NOT NULL,
      y REAL NOT NULL,
      z REAL NOT NULL,
      confidence REAL NOT NULL DEFAULT 1.0,
      depleted INTEGER NOT NULL DEFAULT 0,
      last_seen_at TEXT,
      FOREIGN KEY(world_id) REFERENCES worlds(id)
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_resource_sites_world_dim_resource_pos
      ON resource_sites(world_id, dimension, resource, x, y, z);

  CREATE INDEX IF NOT EXISTS idx_resource_sites_world_resource
      ON resource_sites(world_id, resource);
  `,
  // v5: death events (spec 21.7 / section 26, Phase 10). One row per death:
  // where and when it happened, plus the recovery outcome and an explicit
  // failure reason (timeout, too dangerous, items despawned, path
  // unreachable, ...) so the LLM and future decisions can learn from it.
  `
  CREATE TABLE IF NOT EXISTS death_events (
      id INTEGER PRIMARY KEY,
      world_id INTEGER NOT NULL,
      dimension TEXT NOT NULL,
      x REAL NOT NULL,
      y REAL NOT NULL,
      z REAL NOT NULL,
      recovered INTEGER NOT NULL DEFAULT 0,
      recovery_failed_reason TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(world_id) REFERENCES worlds(id)
  );

  CREATE INDEX IF NOT EXISTS idx_death_events_world_created
      ON death_events(world_id, created_at);
  `,
  // v6: corpse contents and recovery verdict. `inventory_json` snapshots the
  // items carried at the moment of death (name -> count), so a death whose
  // drop is empty or junk-only can skip the recovery trip entirely.
  // `recovery_skipped_reason` records that decision (nothing_carried /
  // only_expendable_items) — a skipped death is not a failed recovery, it is
  // one that never needed a trip.
  `
  ALTER TABLE death_events ADD COLUMN inventory_json TEXT;
  ALTER TABLE death_events ADD COLUMN recovery_skipped_reason TEXT;
  `,
  // v7: the persistent goal layer. One row is the active autonomous goal at a
  // time (there is at most one ACTIVE row); the GoalManager rehydrates it on
  // boot so a restart resumes driving the objective instead of forgetting it.
  // `success_criteria_json` holds the evaluable readiness conditions and
  // `recent_results_json` the capped per-action outcome log.
  `
  CREATE TABLE IF NOT EXISTS goals (
      id TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      success_criteria_json TEXT NOT NULL DEFAULT '[]',
      current_step TEXT,
      recent_results_json TEXT NOT NULL DEFAULT '[]',
      note TEXT,
      created_at TEXT NOT NULL,
      ended_at TEXT
  );
  `,
];