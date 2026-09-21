import { BuildProjectsRepository, type BuildProject } from "./build-projects.js";
import type { AppDatabase } from "./database.js";
import type { TerrainProjectKind, FrozenTerrainPlan } from "../terrain/schema.js";
import type { DestructiveAuthorization, DestructiveAuthorizationInput, DestructiveAuthorizationState } from "../policy/destructive-authorization.js";

export type WorldProjectKind = "build" | TerrainProjectKind;
export type WorldProjectStatus = "active" | "paused" | "blocked" | "verifying" | "completed" | "failed" | "cancelled";
export type WorldProjectPhaseStatus = "pending" | "active" | "blocked" | "completed" | "failed";

export interface BuildWorldProjectPayload { type: "build"; buildProject: BuildProject }
export interface TerrainWorldProjectPayload { type: "terrain"; plan: FrozenTerrainPlan }
export type WorldProjectPayload = BuildWorldProjectPayload | TerrainWorldProjectPayload;

export interface WorldProjectPhase {
  id: string; projectId: string; ordinal: number; label: string;
  status: WorldProjectPhaseStatus; progress: Record<string, unknown>;
  attempts: number; lastError?: string;
}

export interface WorldProject {
  id: string; kind: WorldProjectKind; userGoal: string; source: "user" | "goal";
  status: WorldProjectStatus; world: string; dimension: string; geometryHash: string;
  payload: WorldProjectPayload; currentPhaseId?: string;
  resumeState: Record<string, unknown>; verificationState: Record<string, unknown>;
  authorizationState?: Record<string, unknown>; createdAt: string; updatedAt: string;
  completedAt?: string; lastError?: string;
}

export interface WorldProjectEvent {
  id?: number; projectId: string; phaseId?: string; taskId?: string;
  kind: string; details: Record<string, unknown>; createdAt: string;
}

interface ProjectRow { id: string; kind: string; user_goal: string; source: string; status: string; world: string; dimension: string; geometry_hash: string; payload_json: string; current_phase_id: string | null; resume_state_json: string; verification_state_json: string; authorization_state_json: string | null; created_at: string; updated_at: string; completed_at: string | null; last_error: string | null }
interface PhaseRow { id: string; project_id: string; ordinal: number; label: string; status: string; progress_json: string; attempts: number; last_error: string | null }
interface EventRow { id: number; project_id: string; phase_id: string | null; task_id: string | null; kind: string; details_json: string; created_at: string }

const columns = "id, kind, user_goal, source, status, world, dimension, geometry_hash, payload_json, current_phase_id, resume_state_json, verification_state_json, authorization_state_json, created_at, updated_at, completed_at, last_error";

export class WorldProjectsRepository {
  readonly buildRepository: BuildProjectsRepository;
  constructor(private readonly db: AppDatabase) { this.buildRepository = new BuildProjectsRepository(db); }

  create(project: WorldProject, phases: readonly WorldProjectPhase[] = []): void {
    const tx = this.db.sql.transaction(() => {
      this.db.sql.prepare(`INSERT INTO world_projects (${columns}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        project.id, project.kind, project.userGoal, project.source, project.status, project.world, project.dimension,
        project.geometryHash, JSON.stringify(project.payload), project.currentPhaseId ?? null,
        JSON.stringify(project.resumeState), JSON.stringify(project.verificationState), project.authorizationState ? JSON.stringify(project.authorizationState) : null,
        project.createdAt, project.updatedAt, project.completedAt ?? null, project.lastError ?? null,
      );
      for (const phase of phases) this.createPhase(phase);
    });
    tx();
  }

  get(id: string): WorldProject | null {
    const row = this.db.sql.prepare(`SELECT ${columns} FROM world_projects WHERE id = ?`).get(id) as ProjectRow | undefined;
    return row ? toProject(row) : null;
  }

  findLive(kind: WorldProjectKind, world: string, dimension: string, geometryHash: string): WorldProject | null {
    const row = this.db.sql.prepare(`SELECT ${columns} FROM world_projects WHERE kind = ? AND world = ? AND dimension = ? AND geometry_hash = ? AND status IN ('active','paused','blocked','verifying') ORDER BY updated_at DESC LIMIT 1`).get(kind, world, dimension, geometryHash) as ProjectRow | undefined;
    return row ? toProject(row) : null;
  }

  loadUnfinished(): WorldProject[] {
    return (this.db.sql.prepare(`SELECT ${columns} FROM world_projects WHERE status IN ('active','paused','blocked','verifying') ORDER BY created_at`).all() as ProjectRow[]).map(toProject);
  }

  update(project: WorldProject): void {
    this.db.sql.prepare(`UPDATE world_projects SET kind=?, user_goal=?, source=?, status=?, world=?, dimension=?, geometry_hash=?, payload_json=?, current_phase_id=?, resume_state_json=?, verification_state_json=?, authorization_state_json=?, updated_at=?, completed_at=?, last_error=? WHERE id=?`).run(
      project.kind, project.userGoal, project.source, project.status, project.world, project.dimension, project.geometryHash,
      JSON.stringify(project.payload), project.currentPhaseId ?? null, JSON.stringify(project.resumeState), JSON.stringify(project.verificationState), project.authorizationState ? JSON.stringify(project.authorizationState) : null,
      project.updatedAt, project.completedAt ?? null, project.lastError ?? null, project.id,
    );
  }

  getPhases(projectId: string): WorldProjectPhase[] {
    return (this.db.sql.prepare("SELECT * FROM world_project_phases WHERE project_id = ? ORDER BY ordinal").all(projectId) as PhaseRow[]).map(toPhase);
  }

  updatePhase(phase: WorldProjectPhase): void {
    this.db.sql.prepare("UPDATE world_project_phases SET label=?, status=?, progress_json=?, attempts=?, last_error=? WHERE id=? AND project_id=?").run(phase.label, phase.status, JSON.stringify(phase.progress), phase.attempts, phase.lastError ?? null, phase.id, phase.projectId);
  }

  appendEvent(event: WorldProjectEvent): number {
    const result = this.db.sql.prepare("INSERT INTO world_project_events (project_id, phase_id, task_id, kind, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(event.projectId, event.phaseId ?? null, event.taskId ?? null, event.kind, JSON.stringify(event.details), event.createdAt);
    return Number(result.lastInsertRowid);
  }

  listEvents(projectId: string, limit = 100): WorldProjectEvent[] {
    const bounded = Math.max(1, Math.min(limit, 1_000));
    const rows = this.db.sql.prepare("SELECT * FROM world_project_events WHERE project_id = ? ORDER BY id DESC LIMIT ?").all(projectId, bounded) as EventRow[];
    return rows.reverse().map((row) => ({ id: row.id, projectId: row.project_id, phaseId: row.phase_id ?? undefined, taskId: row.task_id ?? undefined, kind: row.kind, details: parseJson<Record<string, unknown>>(row.details_json, {}), createdAt: row.created_at }));
  }

  saveAuthorization(input: DestructiveAuthorizationInput): DestructiveAuthorization {
    const authorization: DestructiveAuthorization = {
      ...input,
      worldId: String(input.worldId),
      dimension: input.dimension,
      allowedActions: [...new Set(input.allowedActions)],
      state: "active",
      issuedAt: input.issuedAt ?? new Date().toISOString(),
    };
    this.db.sql.prepare(`INSERT OR REPLACE INTO destructive_authorizations
      (id, project_id, task_id, world, dimension, geometry_hash, geometry_json,
       allowed_actions_json, state, issued_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      `${authorization.projectId}:${authorization.taskId}`, authorization.projectId, authorization.taskId,
      String(authorization.worldId), authorization.dimension, authorization.geometryHash,
      JSON.stringify(authorization.geometry), JSON.stringify(authorization.allowedActions), authorization.state,
      authorization.issuedAt, authorization.expiresAt,
    );
    return authorization;
  }

  getAuthorization(projectId: string, taskId: string): DestructiveAuthorization | null {
    const row = this.db.sql.prepare("SELECT * FROM destructive_authorizations WHERE project_id = ? AND task_id = ?").get(projectId, taskId) as AuthorizationRow | undefined;
    if (row === undefined) return null;
    return { projectId: row.project_id, taskId: row.task_id, worldId: row.world, dimension: row.dimension, geometryHash: row.geometry_hash, geometry: parseJson(row.geometry_json, { bounds: { minX: 0, maxX: -1, minY: 0, maxY: -1, minZ: 0, maxZ: -1 } }), allowedActions: parseJson(row.allowed_actions_json, []), state: row.state as DestructiveAuthorizationState, issuedAt: row.issued_at, expiresAt: row.expires_at };
  }

  setAuthorizationState(projectId: string, taskId: string, state: DestructiveAuthorizationState): boolean {
    return this.db.sql.prepare("UPDATE destructive_authorizations SET state = ? WHERE project_id = ? AND task_id = ?").run(state, projectId, taskId).changes > 0;
  }

  private createPhase(phase: WorldProjectPhase): void {
    this.db.sql.prepare("INSERT INTO world_project_phases (id, project_id, ordinal, label, status, progress_json, attempts, last_error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(phase.id, phase.projectId, phase.ordinal, phase.label, phase.status, JSON.stringify(phase.progress), phase.attempts, phase.lastError ?? null);
  }
}

interface AuthorizationRow { project_id: string; task_id: string; world: string; dimension: string; geometry_hash: string; geometry_json: string; allowed_actions_json: string; state: string; issued_at: string; expires_at: string }

function toProject(row: ProjectRow): WorldProject {
  return {
    id: row.id, kind: row.kind as WorldProjectKind, userGoal: row.user_goal, source: row.source as WorldProject["source"], status: row.status as WorldProjectStatus,
    world: row.world, dimension: row.dimension, geometryHash: row.geometry_hash, payload: parseJson<WorldProjectPayload>(row.payload_json, { type: "terrain", plan: {} as FrozenTerrainPlan }),
    resumeState: parseJson<Record<string, unknown>>(row.resume_state_json, {}), verificationState: parseJson<Record<string, unknown>>(row.verification_state_json, {}),
    createdAt: row.created_at, updatedAt: row.updated_at,
    ...(row.current_phase_id === null ? {} : { currentPhaseId: row.current_phase_id }),
    ...(row.authorization_state_json === null ? {} : { authorizationState: parseJson<Record<string, unknown>>(row.authorization_state_json, {}) }),
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    ...(row.last_error === null ? {} : { lastError: row.last_error }),
  };
}
function toPhase(row: PhaseRow): WorldProjectPhase { return { id: row.id, projectId: row.project_id, ordinal: row.ordinal, label: row.label, status: row.status as WorldProjectPhaseStatus, progress: parseJson<Record<string, unknown>>(row.progress_json, {}), attempts: row.attempts, lastError: row.last_error ?? undefined }; }
function parseJson<T>(raw: string, fallback: T): T { try { return JSON.parse(raw) as T; } catch { return fallback; } }
