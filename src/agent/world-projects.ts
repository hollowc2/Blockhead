import { randomUUID } from "node:crypto";
import { EventBus } from "../events/bus.js";
import type { FrozenTerrainPlan } from "../terrain/schema.js";
import { BuildProjectManager, type BuildProjectStatusView, type ProjectTaskSettlement } from "./build-projects.js";
import type { Scheduler } from "./scheduler.js";
import { TaskPriority, type Task } from "./task.js";
import type { SkillResult } from "../skills/skill-library.js";
import type { WorldProject, WorldProjectPhase, WorldProjectsRepository } from "../memory/world-projects.js";
import { DestructiveAuthorizationRegistry } from "../policy/destructive-authorization.js";
import type { DestructiveAction } from "../policy/destructive-authorization.js";

export interface CreateTerrainProjectInput {
  userGoal: string;
  source: "user" | "goal";
  plan: FrozenTerrainPlan;
}
export interface CreateTerrainProjectResult { project: WorldProject; task: Task; resumed: boolean }
export interface WorldProjectStatusView { project: WorldProject; phase: WorldProjectPhase | null }

/**
 * Generic project coordinator. BuildProjectManager remains the compatibility
 * implementation for blueprint execution; terrain envelopes are persisted in
 * the canonical world-project tables and deliberately do not schedule a
 * terrain runner through the same resumable child-task lifecycle as builds.
 */
export class WorldProjectManager extends BuildProjectManager {
  constructor(
    private readonly worldProjects: WorldProjectsRepository,
    private readonly worldScheduler: Scheduler,
    private readonly worldBus: EventBus,
    private readonly authorizations?: DestructiveAuthorizationRegistry,
    private readonly worldId?: () => string | number | null,
  ) {
    super(worldProjects.buildRepository, worldScheduler, worldBus);
    this.worldBus.on("task.cancelled", ({ task }) => {
      if (task.projectId === undefined) return;
      const project = this.worldProjects.get(task.projectId);
      if (project === null || project.status === "completed" || project.status === "cancelled") return;
      if (!task.type.startsWith("world_project_")) return;
      this.setAuthorizationState(task, "revoked");
      project.status = "cancelled";
      project.lastError = "project child task cancelled by owner";
      project.updatedAt = new Date().toISOString();
      this.worldProjects.update(project);
      this.worldProjects.appendEvent({ projectId: project.id, phaseId: task.projectPhaseId, taskId: task.id, kind: "cancelled", details: { reason: "owner" }, createdAt: project.updatedAt });
      this.worldBus.emit("world_project.cancelled", { project });
    });
    this.worldBus.on("task.paused", ({ task }) => this.setAuthorizationState(task, "dormant"));
    this.worldBus.on("task.requeued", ({ task }) => this.setAuthorizationState(task, "dormant"));
    this.worldBus.on("task.activated", ({ task }) => {
      if (task.projectId === undefined || task.type !== "world_project_slice") return;
      const project = this.worldProjects.get(task.projectId);
      if (project?.payload.type === "terrain") this.issueTerrainAuthorization(project, task);
    });
    this.worldBus.on("task.completed", ({ task }) => {
      if (task.type === "world_project_slice" || task.type === "world_project_verify") this.setAuthorizationState(task, "revoked");
    });
    this.worldBus.on("task.failed", ({ task }) => {
      if (task.type === "world_project_slice" || task.type === "world_project_verify") this.setAuthorizationState(task, "revoked");
    });
  }

  createTerrainProject(input: CreateTerrainProjectInput): CreateTerrainProjectResult {
    const existing = this.worldProjects.findLive(input.plan.specification.kind, input.plan.world, input.plan.dimension, input.plan.geometryHash);
    if (existing !== null) {
      const task = this.scheduleTerrainChild(existing);
      return { project: existing, task, resumed: true };
    }
    const now = new Date().toISOString();
    const id = randomUUID();
    const phase: WorldProjectPhase = { id: `${id}:0`, projectId: id, ordinal: 0, label: `${input.plan.specification.kind} pending`, status: "active", progress: {}, attempts: 1 };
    const project: WorldProject = {
      id, kind: input.plan.specification.kind, userGoal: input.userGoal, source: input.source,
      status: "active", world: input.plan.world, dimension: input.plan.dimension, geometryHash: input.plan.geometryHash,
      payload: { type: "terrain", plan: input.plan }, currentPhaseId: phase.id, resumeState: {}, verificationState: {},
      createdAt: now, updatedAt: now,
    };
    this.worldProjects.create(project, [phase]);
    // Stage 4 restores metadata but leaves execution dormant until a later
    // terrain runner can perform the required live rescan.
    const task = this.scheduleTerrainChild(project);
    this.worldBus.emit("world_project.created", { project, phase });
    return { project: this.worldProjects.get(id) ?? project, task, resumed: false };
  }

  getWorldProject(projectId: string): WorldProject | null { return this.worldProjects.get(projectId); }

  currentWorldProject(): WorldProjectStatusView | null {
    const project = this.worldProjects.loadUnfinished().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (project === undefined) return null;
    const phase = project.currentPhaseId === undefined ? null : this.worldProjects.getPhases(project.id).find((candidate) => candidate.id === project.currentPhaseId) ?? null;
    return { project, phase };
  }

  currentProjectForBackground(): BuildProjectStatusView | WorldProjectStatusView | null {
    const terrain = this.currentWorldProject();
    return terrain ?? this.currentProject();
  }

  /** Rehydrate both compatibility build projects and dormant terrain metadata. */
  rehydrateAll(): { builds: ReturnType<BuildProjectManager["rehydrate"]>; terrain: WorldProject[] } {
    return { builds: this.rehydrate(), terrain: this.worldProjects.loadUnfinished().filter((project) => project.payload.type === "terrain") };
  }

  /** Schedule one bounded terrain slice. */
  private scheduleTerrainChild(project: WorldProject): Task {
    const task = this.worldScheduler.enqueue({
      type: "world_project_slice", priority: TaskPriority.FOREGROUND, source: project.source,
      objective: `Prepare ${project.kind} terrain project ${project.id}.`,
      parameters: { projectId: project.id, phaseId: project.currentPhaseId, kind: project.kind, geometryHash: project.geometryHash },
      projectId: project.id, projectPhaseId: project.currentPhaseId, executionPolicy: "resumable",
      workKey: `world-project:${project.id}:${project.currentPhaseId ?? "root"}`,
    });
    if (project.payload.type === "terrain") this.issueTerrainAuthorization(project, task);
    this.worldProjects.appendEvent({ projectId: project.id, phaseId: project.currentPhaseId, taskId: task.id, kind: "slice_scheduled", details: { geometryHash: project.geometryHash }, createdAt: new Date().toISOString() });
    this.worldBus.emit("world_project.scheduled", { project, phase: project.currentPhaseId === undefined ? undefined : this.worldProjects.getPhases(project.id).find((item) => item.id === project.currentPhaseId), task });
    return task;
  }

  override settleChildTask(task: Task, result: SkillResult): ProjectTaskSettlement {
    if (task.type !== "world_project_slice" && task.type !== "world_project_acquire" && task.type !== "world_project_verify" && task.type !== "world_project_deposit" && task.type !== "world_project_replace_tool" && task.type !== "world_project_return") {
      return super.settleChildTask(task, result);
    }
    const project = task.projectId === undefined ? null : this.worldProjects.get(task.projectId);
    if (project === null) return "none";
    const phase = project.currentPhaseId === undefined ? null : this.worldProjects.getPhases(project.id).find((item) => item.id === project.currentPhaseId) ?? null;
    const now = new Date().toISOString();
    if (task.type === "world_project_deposit" || task.type === "world_project_replace_tool" || task.type === "world_project_return") {
      if (result.status === "completed") {
        project.status = "active";
        project.lastError = undefined;
        project.updatedAt = now;
        this.worldProjects.update(project);
        this.scheduleTerrainChild(project);
        return "complete";
      }
      if (result.status === "interrupted" || result.status === "partial" || result.retryable === true) return "requeue";
      if (result.status === "blocked") {
        project.status = "blocked";
        project.lastError = result.message ?? result.errorCode ?? "project maintenance blocked";
        project.updatedAt = now;
        this.worldProjects.update(project);
        return "block";
      }
      project.status = "failed";
      project.lastError = result.message ?? result.errorCode ?? "project maintenance failed";
      project.updatedAt = now;
      this.worldProjects.update(project);
      return "fail";
    }
    if (task.type === "world_project_verify") {
      if (result.status === "completed") {
        const verification = result.data as { inspected?: unknown; verified?: unknown; mismatches?: unknown[] } | undefined;
        const passed = verification !== undefined && verification.verified === verification.inspected && (verification.mismatches?.length ?? 1) === 0;
        project.verificationState = { lastVerifiedAt: now, inspected: verification?.inspected ?? 0, verified: verification?.verified ?? 0, mismatches: verification?.mismatches ?? [] };
        project.updatedAt = now;
        if (passed) {
          project.status = "completed";
          project.completedAt = now;
          project.lastError = undefined;
          this.worldProjects.update(project);
          if (phase) { phase.status = "completed"; this.worldProjects.updatePhase(phase); }
          this.worldProjects.appendEvent({ projectId: project.id, phaseId: task.projectPhaseId, taskId: task.id, kind: "verified", details: { inspected: verification.inspected, verified: verification.verified }, createdAt: now });
          this.worldBus.emit("world_project.completed", { project });
          return "complete";
        }
        project.status = "active";
        project.lastError = "excavation verification found mismatched cells; reopening the earliest incomplete work";
        if (phase) {
          phase.status = "active";
          phase.lastError = project.lastError;
          this.worldProjects.updatePhase(phase);
        }
        this.worldProjects.update(project);
        this.scheduleTerrainChild(project);
        return "complete";
      }
      if (result.status === "blocked") { project.status = "blocked"; project.lastError = result.message ?? result.errorCode ?? "world project verification blocked"; project.updatedAt = now; this.worldProjects.update(project); return "block"; }
      return result.retryable === true || result.status === "partial" || result.status === "interrupted" ? "requeue" : "fail";
    }
    if (result.status === "completed") {
      project.status = "verifying";
      project.updatedAt = now;
      this.worldProjects.update(project);
      if (phase) { phase.status = "completed"; this.worldProjects.updatePhase(phase); }
      const verifyTask = this.worldScheduler.enqueue({
        type: "world_project_verify", priority: TaskPriority.FOREGROUND, source: project.source,
        objective: `Verify ${project.kind} terrain project ${project.id}.`,
        parameters: { projectId: project.id, phaseId: project.currentPhaseId, geometryHash: project.geometryHash },
        projectId: project.id, projectPhaseId: project.currentPhaseId, executionPolicy: "resumable",
        workKey: `world-project-verify:${project.id}:${project.currentPhaseId ?? "root"}`,
      });
      this.worldProjects.appendEvent({ projectId: project.id, phaseId: project.currentPhaseId, taskId: verifyTask.id, kind: "verification_scheduled", details: {}, createdAt: now });
    }
    else if (result.status === "blocked") { project.status = "blocked"; project.lastError = result.message ?? result.errorCode ?? "world project blocked"; project.updatedAt = now; this.worldProjects.update(project); }
    else if (result.status === "interrupted" || result.status === "partial" || result.retryable === true) return "requeue" as const;
    else { project.status = "failed"; project.lastError = result.message ?? result.errorCode ?? "world project failed"; project.updatedAt = now; this.worldProjects.update(project); }
    return result.status === "completed" ? "complete" as const : project.status === "blocked" ? "block" as const : "fail" as const;
  }

  private setAuthorizationState(task: Task, state: "dormant" | "revoked"): void {
    if (task.type !== "world_project_slice") return;
    this.authorizations?.setState(task.id, state);
    if (task.projectId === undefined) return;
    const project = this.worldProjects.get(task.projectId);
    if (project === null) return;
    project.authorizationState = { taskId: task.id, state, updatedAt: new Date().toISOString() };
    project.updatedAt = new Date().toISOString();
    this.worldProjects.update(project);
  }

  private issueTerrainAuthorization(project: WorldProject, task: Task): void {
    if (this.authorizations === undefined || project.payload.type !== "terrain") return;
    const worldId = this.worldId?.();
    if (worldId === null || worldId === undefined) return;
    const actions: readonly DestructiveAction[] = ["dig", "place_support", "place_light"];
    const issuedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    const authorization = this.authorizations.issue({
      projectId: project.id,
      taskId: task.id,
      worldId,
      dimension: project.dimension,
      geometryHash: project.geometryHash,
      geometry: { bounds: project.payload.plan.bounds },
      allowedActions: actions,
      issuedAt,
      expiresAt,
    });
    this.worldProjects.saveAuthorization(authorization);
    project.authorizationState = { taskId: task.id, state: "active", issuedAt, expiresAt };
    project.updatedAt = issuedAt;
    this.worldProjects.update(project);
  }
}

export { BuildProjectManager };
export type { BuildProjectStatusView };
