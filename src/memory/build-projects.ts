import type { Blueprint } from "../building/compiler.js";
import type { BuildingDesign } from "../building/schema.js";
import type { HomeLocation } from "../minecraft/movement.js";
import type { AppDatabase } from "./database.js";

export type BuildProjectStatus =
  | "active"
  | "paused"
  | "blocked"
  | "verifying"
  | "completed"
  | "failed"
  | "cancelled";

export type BuildPhaseStatus = "pending" | "active" | "blocked" | "completed" | "failed";

export interface BuildMaterialShortage {
  material: string;
  required: number;
  available: number;
}

export interface BuildProjectResumeState {
  currentOperationIndex: number;
  lastVerifiedOperationId?: string;
  completedRanges: Array<{ start: number; end: number }>;
  interruptedCount: number;
  retryAfter?: string;
}

export interface BuildVerificationState {
  lastVerifiedAt?: string;
  verifiedOperations: number;
  totalOperations: number;
  mismatchedOperationIds?: string[];
  finalVerificationPassed: boolean;
}

export interface BuildProject {
  id: string;
  userGoal: string;
  structureType: string;
  source: "user" | "goal";
  status: BuildProjectStatus;
  design: BuildingDesign;
  origin: HomeLocation;
  compilerVersion: string;
  schemaVersion: string;
  blueprintHash: string;
  blueprint: Blueprint;
  currentPhaseId?: string;
  requiredResources: Record<string, number>;
  shortages: BuildMaterialShortage[];
  resumeState: BuildProjectResumeState;
  verificationState: BuildVerificationState;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  lastError?: string;
}

export interface BuildPhase {
  id: string;
  projectId: string;
  ordinal: number;
  label: string;
  operationStart: number;
  operationEnd: number;
  status: BuildPhaseStatus;
  attempts: number;
  verifiedOperations: number;
  totalOperations: number;
  lastError?: string;
}

export interface BuildProjectEvent {
  id?: number;
  projectId: string;
  phaseId?: string;
  taskId?: string;
  kind: string;
  details: Record<string, unknown>;
  createdAt: string;
}

interface BuildProjectRow {
  id: string;
  user_goal: string;
  structure_type: string;
  source: string;
  status: string;
  design_json: string;
  origin_json: string;
  compiler_version: string;
  schema_version: string;
  blueprint_hash: string;
  blueprint_json: string;
  current_phase_id: string | null;
  required_resources_json: string;
  shortages_json: string;
  resume_state_json: string;
  verification_state_json: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  last_error: string | null;
}

interface BuildPhaseRow {
  id: string;
  project_id: string;
  ordinal: number;
  label: string;
  operation_start: number;
  operation_end: number;
  status: string;
  attempts: number;
  verified_operations: number;
  total_operations: number;
  last_error: string | null;
}

interface BuildProjectEventRow {
  id: number;
  project_id: string;
  phase_id: string | null;
  task_id: string | null;
  kind: string;
  details_json: string;
  created_at: string;
}

const PROJECT_COLUMNS = `
  id, user_goal, structure_type, source, status, design_json, origin_json,
  compiler_version, schema_version, blueprint_hash, blueprint_json,
  current_phase_id, required_resources_json, shortages_json,
  resume_state_json, verification_state_json, created_at, updated_at,
  completed_at, last_error`;

/** Durable storage for immutable project snapshots and their phase history. */
export class BuildProjectsRepository {
  constructor(private readonly db: AppDatabase) {}

  /** Create the project and its ordered phases atomically. */
  create(project: BuildProject, phases: readonly BuildPhase[] = []): void {
    const insert = this.db.sql.transaction(() => {
      this.db.sql.prepare(`INSERT INTO build_projects (${PROJECT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        project.id, project.userGoal, project.structureType, project.source, project.status,
        JSON.stringify(project.design), JSON.stringify(project.origin), project.compilerVersion,
        project.schemaVersion, project.blueprintHash, JSON.stringify(project.blueprint),
        project.currentPhaseId ?? null, JSON.stringify(project.requiredResources),
        JSON.stringify(project.shortages), JSON.stringify(project.resumeState),
        JSON.stringify(project.verificationState), project.createdAt, project.updatedAt,
        project.completedAt ?? null, project.lastError ?? null,
      );
      for (const phase of phases) this.insertPhase(phase);
    });
    insert();
  }

  update(project: BuildProject): void {
    this.db.sql.prepare(`UPDATE build_projects SET
      user_goal = ?, structure_type = ?, source = ?, status = ?, design_json = ?,
      origin_json = ?, compiler_version = ?, schema_version = ?, blueprint_hash = ?,
      blueprint_json = ?, current_phase_id = ?, required_resources_json = ?,
      shortages_json = ?, resume_state_json = ?, verification_state_json = ?,
      updated_at = ?, completed_at = ?, last_error = ? WHERE id = ?`).run(
      project.userGoal, project.structureType, project.source, project.status,
      JSON.stringify(project.design), JSON.stringify(project.origin), project.compilerVersion,
      project.schemaVersion, project.blueprintHash, JSON.stringify(project.blueprint),
      project.currentPhaseId ?? null, JSON.stringify(project.requiredResources),
      JSON.stringify(project.shortages), JSON.stringify(project.resumeState),
      JSON.stringify(project.verificationState), project.updatedAt, project.completedAt ?? null,
      project.lastError ?? null, project.id,
    );
  }

  get(id: string): BuildProject | null {
    const row = this.db.sql.prepare(`SELECT ${PROJECT_COLUMNS} FROM build_projects WHERE id = ?`).get(id) as BuildProjectRow | undefined;
    return row ? toProject(row) : null;
  }

  /** Active, paused, blocked, and verifying projects survive a restart. */
  loadUnfinished(): BuildProject[] {
    const rows = this.db.sql.prepare(`SELECT ${PROJECT_COLUMNS} FROM build_projects WHERE status IN ('active', 'paused', 'blocked', 'verifying') ORDER BY created_at`).all() as BuildProjectRow[];
    return rows.map(toProject);
  }

  getPhases(projectId: string): BuildPhase[] {
    const rows = this.db.sql.prepare("SELECT * FROM build_project_phases WHERE project_id = ? ORDER BY ordinal").all(projectId) as BuildPhaseRow[];
    return rows.map(toPhase);
  }

  updatePhase(phase: BuildPhase): void {
    this.db.sql.prepare(`UPDATE build_project_phases SET
      label = ?, operation_start = ?, operation_end = ?, status = ?, attempts = ?,
      verified_operations = ?, total_operations = ?, last_error = ?
      WHERE id = ? AND project_id = ?`).run(
      phase.label, phase.operationStart, phase.operationEnd, phase.status, phase.attempts,
      phase.verifiedOperations, phase.totalOperations, phase.lastError ?? null,
      phase.id, phase.projectId,
    );
  }

  appendEvent(event: BuildProjectEvent): number {
    const result = this.db.sql.prepare(`INSERT INTO build_project_events
      (project_id, phase_id, task_id, kind, details_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(
      event.projectId, event.phaseId ?? null, event.taskId ?? null, event.kind,
      JSON.stringify(event.details), event.createdAt,
    );
    return Number(result.lastInsertRowid);
  }

  listEvents(projectId: string, limit = 100): BuildProjectEvent[] {
    const bounded = Math.max(1, Math.min(limit, 1_000));
    const rows = this.db.sql.prepare(`SELECT * FROM build_project_events
      WHERE project_id = ? ORDER BY id DESC LIMIT ?`).all(projectId, bounded) as BuildProjectEventRow[];
    return rows.reverse().map((row) => ({
      id: row.id, projectId: row.project_id, phaseId: row.phase_id ?? undefined,
      taskId: row.task_id ?? undefined, kind: row.kind, details: parseJson<Record<string, unknown>>(row.details_json),
      createdAt: row.created_at,
    }));
  }

  private insertPhase(phase: BuildPhase): void {
    this.db.sql.prepare(`INSERT INTO build_project_phases
      (id, project_id, ordinal, label, operation_start, operation_end, status,
       attempts, verified_operations, total_operations, last_error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      phase.id, phase.projectId, phase.ordinal, phase.label, phase.operationStart,
      phase.operationEnd, phase.status, phase.attempts, phase.verifiedOperations,
      phase.totalOperations, phase.lastError ?? null,
    );
  }
}

function toProject(row: BuildProjectRow): BuildProject {
  return {
    id: row.id, userGoal: row.user_goal, structureType: row.structure_type,
    source: row.source as BuildProject["source"], status: row.status as BuildProjectStatus,
    design: parseJson<BuildingDesign>(row.design_json), origin: parseJson<HomeLocation>(row.origin_json),
    compilerVersion: row.compiler_version, schemaVersion: row.schema_version,
    blueprintHash: row.blueprint_hash, blueprint: parseJson<Blueprint>(row.blueprint_json),
    currentPhaseId: row.current_phase_id ?? undefined,
    requiredResources: parseJson<Record<string, number>>(row.required_resources_json),
    shortages: parseJson<BuildMaterialShortage[]>(row.shortages_json),
    resumeState: parseJson<BuildProjectResumeState>(row.resume_state_json),
    verificationState: parseJson<BuildVerificationState>(row.verification_state_json),
    createdAt: row.created_at, updatedAt: row.updated_at, completedAt: row.completed_at ?? undefined,
    lastError: row.last_error ?? undefined,
  };
}

function toPhase(row: BuildPhaseRow): BuildPhase {
  return {
    id: row.id, projectId: row.project_id, ordinal: row.ordinal, label: row.label,
    operationStart: row.operation_start, operationEnd: row.operation_end,
    status: row.status as BuildPhaseStatus, attempts: row.attempts,
    verifiedOperations: row.verified_operations, totalOperations: row.total_operations,
    lastError: row.last_error ?? undefined,
  };
}

function parseJson<T>(raw: string): T {
  return JSON.parse(raw) as T;
}
