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
  // v8: action-level anti-loop watchdog state, shared by task instances.
  `
  CREATE TABLE IF NOT EXISTS action_states (
      action TEXT PRIMARY KEY,
      failures INTEGER NOT NULL DEFAULT 0,
      blocked_at INTEGER,
      retry_at INTEGER,
      last_reason TEXT,
      updated_at INTEGER NOT NULL
  );
  `,
  // v9: indexes for live-task restoration and recent outcome/retention scans.
  `
  CREATE INDEX IF NOT EXISTS idx_tasks_status_created ON tasks(status, created_at);
  CREATE INDEX IF NOT EXISTS idx_tasks_settled_time ON tasks(status, completed_at, created_at);
  `,
  // v10: durable cooldowns for deterministic background restore retries.
  `
  CREATE TABLE IF NOT EXISTS background_failures (
      action TEXT PRIMARY KEY,
      failed_at INTEGER NOT NULL,
      retry_at INTEGER NOT NULL,
      reason TEXT NOT NULL
  );
  `,
  // v11: durable pause ordering and targeted task indexes.
  `
  ALTER TABLE tasks ADD COLUMN pause_sequence INTEGER;

  CREATE INDEX IF NOT EXISTS idx_tasks_unfinished
      ON tasks(created_at)
      WHERE status IN ('queued', 'active', 'paused', 'blocked');

  CREATE INDEX IF NOT EXISTS idx_tasks_recent_settled
      ON tasks(COALESCE(completed_at, created_at) DESC)
      WHERE status IN ('completed', 'failed', 'blocked', 'cancelled');
  `,
  // v12: durable logical work identity and generic progress metadata.
  `
  ALTER TABLE tasks ADD COLUMN work_key TEXT;
  ALTER TABLE tasks ADD COLUMN phase TEXT;
  ALTER TABLE tasks ADD COLUMN progress_fingerprint TEXT;
  ALTER TABLE tasks ADD COLUMN last_progress_at TEXT;
  ALTER TABLE tasks ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_live_work_key
    ON tasks(work_key) WHERE work_key IS NOT NULL AND status IN ('queued','active','paused','blocked');
  `,
  // v13: crash-cut-point metadata for bootstrap and death reconciliation.
  `
  ALTER TABLE bootstrap_state ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE bootstrap_state ADD COLUMN last_failure_code TEXT;
  ALTER TABLE bootstrap_state ADD COLUMN retry_at INTEGER;
  ALTER TABLE death_events ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'recorded';
  ALTER TABLE death_events ADD COLUMN respawned_at TEXT;
  ALTER TABLE death_events ADD COLUMN recovery_task_id TEXT;
  CREATE INDEX IF NOT EXISTS idx_death_events_lifecycle ON death_events(world_id, lifecycle, id);
  `,
  // v14: structured startup quarantine diagnostics. Corrupt or duplicate live
  // rows are retained for audit while their runtime representation is made safe.
  `
  CREATE TABLE IF NOT EXISTS quarantine_diagnostics (
      id INTEGER PRIMARY KEY,
      table_name TEXT NOT NULL,
      row_id TEXT NOT NULL,
      field TEXT NOT NULL,
      error TEXT NOT NULL,
      recovery_action TEXT NOT NULL,
      created_at TEXT NOT NULL
  );
  `,
  // v15: core survival infrastructure must not wait for the optional bed.
  // Older worlds that stopped at wool/bed need to replay the core stages in
  // the new order; those stages are idempotent and repair missing structures.
  `
  UPDATE bootstrap_state
     SET stage = 'food', attempts = 0, last_failure_code = NULL, retry_at = NULL
   WHERE stage IN ('wool', 'bed');
  `,
  // v16: durable construction projects. Projects freeze the design and
  // compiled blueprint independently from their scheduler child tasks. The
  // task columns are nullable so all pre-project tasks remain valid.
  `
  CREATE TABLE IF NOT EXISTS build_projects (
      id TEXT PRIMARY KEY,
      user_goal TEXT NOT NULL,
      structure_type TEXT NOT NULL,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      design_json TEXT NOT NULL,
      origin_json TEXT NOT NULL,
      compiler_version TEXT NOT NULL,
      schema_version TEXT NOT NULL,
      blueprint_hash TEXT NOT NULL,
      blueprint_json TEXT NOT NULL,
      current_phase_id TEXT,
      required_resources_json TEXT NOT NULL,
      shortages_json TEXT NOT NULL,
      resume_state_json TEXT NOT NULL,
      verification_state_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      last_error TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_build_projects_status_updated
      ON build_projects(status, updated_at);

  CREATE TABLE IF NOT EXISTS build_project_phases (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      label TEXT NOT NULL,
      operation_start INTEGER NOT NULL,
      operation_end INTEGER NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      verified_operations INTEGER NOT NULL DEFAULT 0,
      total_operations INTEGER NOT NULL,
      last_error TEXT,
      FOREIGN KEY(project_id) REFERENCES build_projects(id) ON DELETE CASCADE,
      UNIQUE(project_id, ordinal),
      UNIQUE(project_id, label)
  );

  CREATE INDEX IF NOT EXISTS idx_build_project_phases_project_ordinal
      ON build_project_phases(project_id, ordinal);

  CREATE TABLE IF NOT EXISTS build_project_events (
      id INTEGER PRIMARY KEY,
      project_id TEXT NOT NULL,
      phase_id TEXT,
      task_id TEXT,
      kind TEXT NOT NULL,
      details_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES build_projects(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_build_project_events_project_created
      ON build_project_events(project_id, created_at, id);

  ALTER TABLE tasks ADD COLUMN project_id TEXT;
  ALTER TABLE tasks ADD COLUMN project_phase_id TEXT;
  CREATE INDEX IF NOT EXISTS idx_tasks_project_live
      ON tasks(project_id, project_phase_id)
      WHERE project_id IS NOT NULL AND status IN ('queued','active','paused','blocked');
  `,
  // v17: preserve resumable execution policy for project-linked tasks across
  // restart. Older task rows remain terminal-policy agnostic and valid.
  `
  ALTER TABLE tasks ADD COLUMN execution_policy TEXT;
  `,
  // v18: generalized durable world projects. Build rows remain intact for
  // compatibility; the envelope preserves their frozen payload verbatim and
  // gives terrain projects one canonical lifecycle store.
  `
  CREATE TABLE IF NOT EXISTS world_projects (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      user_goal TEXT NOT NULL,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      world TEXT NOT NULL,
      dimension TEXT NOT NULL,
      geometry_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      current_phase_id TEXT,
      resume_state_json TEXT NOT NULL,
      verification_state_json TEXT NOT NULL,
      authorization_state_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      last_error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_world_projects_status_updated
      ON world_projects(status, updated_at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_world_projects_live_geometry
      ON world_projects(kind, world, dimension, geometry_hash)
      WHERE status IN ('active','paused','blocked','verifying');

  CREATE TABLE IF NOT EXISTS world_project_phases (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      label TEXT NOT NULL,
      status TEXT NOT NULL,
      progress_json TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      FOREIGN KEY(project_id) REFERENCES world_projects(id) ON DELETE CASCADE,
      UNIQUE(project_id, ordinal)
  );
  CREATE INDEX IF NOT EXISTS idx_world_project_phases_project_ordinal
      ON world_project_phases(project_id, ordinal);

  CREATE TABLE IF NOT EXISTS world_project_events (
      id INTEGER PRIMARY KEY,
      project_id TEXT NOT NULL,
      phase_id TEXT,
      task_id TEXT,
      kind TEXT NOT NULL,
      details_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES world_projects(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_world_project_events_project_created
      ON world_project_events(project_id, created_at, id);

  CREATE TABLE IF NOT EXISTS destructive_authorizations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      world TEXT NOT NULL,
      dimension TEXT NOT NULL,
      geometry_hash TEXT NOT NULL,
      geometry_json TEXT NOT NULL,
      allowed_actions_json TEXT NOT NULL,
      state TEXT NOT NULL,
      issued_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES world_projects(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_destructive_authorizations_live
      ON destructive_authorizations(project_id, task_id, state, expires_at);

  INSERT OR IGNORE INTO world_projects
    (id, kind, user_goal, source, status, world, dimension, geometry_hash,
     payload_json, current_phase_id, resume_state_json, verification_state_json,
     created_at, updated_at, completed_at, last_error)
  SELECT id, 'build', user_goal, source, status, '', json_extract(origin_json, '$.dimension'),
     blueprint_hash, json_object('type','build','buildProject',json(printf('%s',
       json_object('id',id,'userGoal',user_goal,'structureType',structure_type,'source',source,
       'status',status,'design',json(design_json),'origin',json(origin_json),
       'compilerVersion',compiler_version,'schemaVersion',schema_version,
       'blueprintHash',blueprint_hash,'blueprint',json(blueprint_json),
       'currentPhaseId',current_phase_id,'requiredResources',json(required_resources_json),
       'shortages',json(shortages_json),'resumeState',json(resume_state_json),
       'verificationState',json(verification_state_json),'createdAt',created_at,
       'updatedAt',updated_at,'completedAt',completed_at,'lastError',last_error)))),
     current_phase_id, resume_state_json, verification_state_json,
     created_at, updated_at, completed_at, last_error
  FROM build_projects;

  INSERT OR IGNORE INTO world_project_phases
    (id, project_id, ordinal, label, status, progress_json, attempts, last_error)
  SELECT id, project_id, ordinal, label, status,
     json_object('operationStart',operation_start,'operationEnd',operation_end,
       'verifiedOperations',verified_operations,'totalOperations',total_operations),
     attempts, last_error
  FROM build_project_phases;

  INSERT OR IGNORE INTO world_project_events
    (project_id, phase_id, task_id, kind, details_json, created_at)
  SELECT project_id, phase_id, task_id, kind, details_json, created_at
  FROM build_project_events;
  `,
  // v19: keep bootstrap lifecycle separate from the last completed stage and
  // persist stage-local progress. Older `blocked` rows lost the resume point;
  // stone-tools failures are known to have completed CRAFTING, so migrate
  // those back to that durable checkpoint and let the new bounded search run.
  `
  ALTER TABLE bootstrap_state ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
  ALTER TABLE bootstrap_state ADD COLUMN progress_json TEXT NOT NULL DEFAULT '{}';
  UPDATE bootstrap_state
     SET stage = 'crafting', status = 'active', attempts = 0, retry_at = NULL
   WHERE stage = 'blocked' AND last_failure_code LIKE 'stone_tools:%';
  UPDATE bootstrap_state
     SET status = 'blocked'
   WHERE stage = 'blocked';
  `,
];
