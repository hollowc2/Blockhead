import { randomUUID } from "node:crypto";
import { logger } from "../logger.js";
import { EventBus } from "../events/bus.js";
import { BUILDING_COMPILER_VERSION, compileBuildingDesign, type BlueprintPhase } from "../building/compiler.js";
import { BUILDING_SCHEMA_VERSION, BuildingDesignSchema, type BuildingDesign } from "../building/schema.js";
import type { HomeLocation } from "../minecraft/movement.js";
import type { BuildPhase, BuildProject, BuildProjectsRepository } from "../memory/build-projects.js";
import type { Scheduler } from "./scheduler.js";
import { TaskPriority, type Task } from "./task.js";
import type { SkillResult } from "../skills/skill-library.js";

export interface ProjectVerificationData {
  inspected: number;
  verified: number;
  mismatches: Array<{ operationId: string; expected: string; actual?: string }>;
}

export type ProjectTaskSettlement = "complete" | "requeue" | "block" | "fail" | "none";

interface SliceOutcomeData {
  operationStart?: number;
  operationEnd?: number;
  currentOperationIndex?: number;
  verified?: number;
  remaining?: number;
  firstUnresolvedOperationId?: string;
  shortages?: Array<{ material: string; required: number; available: number }>;
  mismatchSamples?: Array<{ operationId: string; expected: string; actual?: string }>;
}

export interface CreateBuildProjectInput {
  userGoal: string;
  structureType?: string;
  source: BuildProject["source"];
  design: BuildingDesign;
  origin: HomeLocation;
}

export interface CreateBuildProjectResult {
  project: BuildProject;
  task: Task;
  resumed: boolean;
}

/** Durable coordinator for creation, rehydration, and child-task identity. */
export class BuildProjectManager {
  constructor(
    private readonly projects: BuildProjectsRepository,
    private readonly scheduler: Scheduler,
    private readonly bus: EventBus,
  ) {
    // Cancellation is deliberately handled from the scheduler's terminal
    // event, so only an explicit owner cancellation (or supersession routed
    // through Scheduler.cancel) can cancel the parent project.
    this.bus.on("task.cancelled", ({ task }) => {
      if (task.projectId === undefined) return;
      const project = this.projects.get(task.projectId);
      if (project === null || project.status === "completed" || project.status === "cancelled") return;
      const now = new Date().toISOString();
      project.status = "cancelled";
      project.lastError = "project child task cancelled by owner";
      project.updatedAt = now;
      this.projects.update(project);
      this.projects.appendEvent({ projectId: project.id, phaseId: task.projectPhaseId, taskId: task.id, kind: "cancelled", details: { reason: "owner" }, createdAt: now });
    });
  }

  /** Rehydrate persisted projects before a bot session starts executing work. */
  rehydrate(): BuildProject[] {
    const restored: BuildProject[] = [];
    for (const project of this.projects.loadUnfinished()) {
      restored.push(project);
      const task = project.status === "active"
        ? this.scheduleNextWork(project.id)
        : project.status === "verifying"
          ? this.scheduleFinalVerification(project.id)
          : project.status === "blocked"
            ? this.scheduleDueAcquisition(project.id)
          : null;
      if (task !== null) {
        logger.info({ projectId: project.id, phaseId: task.projectPhaseId, taskId: task.id }, "build project rehydrated");
        this.bus.emit("build_project.rehydrated", { project, task });
      }
    }
    return restored;
  }

  /** Create a frozen project, or resume the live project with the same blueprint. */
  createOrResume(input: CreateBuildProjectInput): CreateBuildProjectResult {
    const frozenDesign = BuildingDesignSchema.parse(input.design);
    const blueprint = compileBuildingDesign(frozenDesign, input.origin);
    const existing = this.projects.findLiveByBlueprintHash(blueprint.hash ?? "");
    if (existing !== null) {
      const task = this.scheduleNextWork(existing.id);
      if (task === null) throw new Error(`build project ${existing.id} has no schedulable phase`);
      return { project: existing, task, resumed: true };
    }

    if ((blueprint.phases ?? []).length === 0) throw new Error("compiled design produced no operations");
    const projectId = randomUUID();
    const now = new Date().toISOString();
    const phases = (blueprint.phases ?? []).map((phase, ordinal) => toBuildPhase(projectId, phase, blueprint.operations.length, ordinal));
    const project: BuildProject = {
      id: projectId,
      userGoal: input.userGoal,
      structureType: input.structureType ?? frozenDesign.name,
      source: input.source,
      status: "active",
      design: frozenDesign,
      origin: input.origin,
      compilerVersion: blueprint.compilerVersion ?? BUILDING_COMPILER_VERSION,
      schemaVersion: blueprint.schemaVersion ?? BUILDING_SCHEMA_VERSION,
      blueprintHash: blueprint.hash ?? "",
      blueprint,
      currentPhaseId: phases[0]?.id,
      requiredResources: { ...blueprint.estimates.materials },
      shortages: [],
      resumeState: { currentOperationIndex: 0, completedRanges: [], interruptedCount: 0 },
      verificationState: { verifiedOperations: 0, totalOperations: blueprint.operations.length, finalVerificationPassed: false },
      createdAt: now,
      updatedAt: now,
    };
    this.projects.create(project, phases);
    this.bus.emit("build_project.created", { project, phase: phases[0]! });

    const task = this.scheduleNextWork(project.id);
    if (task === null) throw new Error(`build project ${project.id} has no schedulable phase`);
    return { project: this.projects.get(project.id) ?? project, task, resumed: false };
  }

  /** Ensure exactly one live slice task exists for the project's next phase. */
  scheduleNextWork(projectId: string): Task | null {
    const project = this.projects.get(projectId);
    if (project === null || project.status !== "active") return null;
    const phase = this.projects.getPhases(project.id).find((item) => item.status === "active" || item.status === "pending");
    if (phase === undefined) return null;

    if (project.currentPhaseId !== phase.id) {
      project.currentPhaseId = phase.id;
      project.updatedAt = new Date().toISOString();
      this.projects.update(project);
    }
    if (phase.status === "pending") {
      phase.status = "active";
      phase.attempts += 1;
      this.projects.updatePhase(phase);
    }

    const workKey = `build-project:${project.id}:${phase.id}`;
    const task = this.scheduler.enqueue({
      type: "build_project_slice",
      priority: TaskPriority.FOREGROUND,
      source: project.source,
      objective: `Build ${project.structureType} phase ${phase.label}.`,
      parameters: { projectId: project.id, phaseId: phase.id, operationStart: phase.operationStart, operationEnd: phase.operationEnd, blueprintHash: project.blueprintHash },
      projectId: project.id,
      projectPhaseId: phase.id,
      executionPolicy: "resumable",
      workKey,
    });
    this.projects.appendEvent({ projectId: project.id, phaseId: phase.id, taskId: task.id, kind: "slice_scheduled", details: { operationStart: phase.operationStart, operationEnd: phase.operationEnd, workKey }, createdAt: new Date().toISOString() });
    this.bus.emit("build_project.scheduled", { project, phase, task });
    return task;
  }

  getProject(projectId: string): BuildProject | null {
    return this.projects.get(projectId);
  }

  /**
   * Apply a child outcome to the durable project state before the dispatcher
   * settles the child task. Returning the settlement keeps task state and
   * project state in one deterministic transition.
   */
  settleChildTask(task: Task, result: SkillResult): ProjectTaskSettlement {
    if (!task.projectId) return "none";
    const project = this.projects.get(task.projectId);
    if (project === null) return "none";
    const now = new Date().toISOString();
    const phase = task.projectPhaseId === undefined
      ? undefined
      : this.projects.getPhases(project.id).find((candidate) => candidate.id === task.projectPhaseId);
    const data = asRecord(result.data);

    if (task.type === "build_project_verify") {
      if (result.status === "completed") {
        const verification = data as ProjectVerificationData | undefined;
        const passed = verification !== undefined
          && verification.verified === verification.inspected
          && verification.inspected === project.blueprint.operations.length
          && verification.mismatches.length === 0;
        project.verificationState = {
          lastVerifiedAt: now,
          verifiedOperations: verification?.verified ?? 0,
          totalOperations: project.blueprint.operations.length,
          mismatchedOperationIds: verification?.mismatches.slice(0, 32).map((item) => item.operationId),
          finalVerificationPassed: passed,
        };
        project.updatedAt = now;
        if (passed) {
          project.status = "completed";
          project.completedAt = now;
          project.lastError = undefined;
          this.projects.update(project);
          this.projects.appendEvent({ projectId: project.id, taskId: task.id, kind: "verified", details: { verified: verification.verified, total: verification.inspected }, createdAt: now });
          this.bus.emit("build_project.verified", { project });
          return "complete";
        }
        // A mismatch is repairable world drift, not a terminal project
        // failure. Reopen the phase containing the first mismatch and let the
        // normal slice executor repair it before another final scan.
        const firstMismatch = verification?.mismatches[0]?.operationId;
        const repairIndex = firstMismatch === undefined
          ? -1
          : project.blueprint.operations.findIndex((operation) => operation.id === firstMismatch);
        const repairPhase = repairIndex < 0
          ? undefined
          : this.projects.getPhases(project.id).find((candidate) => repairIndex >= candidate.operationStart && repairIndex < candidate.operationEnd);
        if (repairPhase !== undefined) {
          repairPhase.status = "active";
          repairPhase.lastError = "final verification found a mismatched blueprint operation";
          this.projects.updatePhase(repairPhase);
          project.status = "active";
          project.currentPhaseId = repairPhase.id;
          project.lastError = repairPhase.lastError;
          project.updatedAt = now;
          this.projects.update(project);
          this.projects.appendEvent({ projectId: project.id, phaseId: repairPhase.id, taskId: task.id, kind: "verification_failed", details: { mismatches: project.verificationState.mismatchedOperationIds ?? [], repairIndex }, createdAt: now });
          this.scheduleNextWork(project.id);
          return "complete";
        }
        project.status = "failed";
        project.lastError = "final verification could not map a mismatched operation to a phase";
        this.projects.update(project);
        this.projects.appendEvent({ projectId: project.id, taskId: task.id, kind: "verification_failed", details: { mismatches: project.verificationState.mismatchedOperationIds ?? [] }, createdAt: now });
        return "fail";
      }
      if (result.status === "blocked") {
        project.status = "blocked";
        project.lastError = result.message ?? result.errorCode ?? "final verification blocked";
        project.updatedAt = now;
        this.projects.update(project);
        return "block";
      }
      return result.status === "failed" && result.retryable !== true ? "fail" : "requeue";
    }

    if (task.type === "build_project_acquire") {
      return this.settleAcquisition(project, task, result, now);
    }

    if (phase === undefined) return "none";
    if (result.status === "completed") {
      const complete = isCompleteSlice(data, phase);
      if (!complete) {
        this.recordSliceProgress(project, phase, data, now, task.id);
        return "requeue";
      }
      phase.status = "completed";
      phase.verifiedOperations = phase.totalOperations;
      phase.lastError = undefined;
      this.projects.updatePhase(phase);
      this.recordSliceProgress(project, phase, data, now, task.id);
      const next = this.projects.getPhases(project.id).find((candidate) => candidate.status === "pending" || candidate.status === "active");
      if (next !== undefined) {
        project.currentPhaseId = next.id;
        project.updatedAt = now;
        this.projects.update(project);
        this.projects.appendEvent({ projectId: project.id, phaseId: phase.id, taskId: task.id, kind: "phase_completed", details: { nextPhaseId: next.id }, createdAt: now });
        this.scheduleNextWork(project.id);
        return "complete";
      }
      project.status = "verifying";
      project.currentPhaseId = undefined;
      project.updatedAt = now;
      this.projects.update(project);
      this.projects.appendEvent({ projectId: project.id, phaseId: phase.id, taskId: task.id, kind: "verification_scheduled", details: {}, createdAt: now });
      this.scheduleFinalVerification(project.id);
      return "complete";
    }

    if (result.status === "blocked") {
      phase.status = "blocked";
      phase.lastError = result.message ?? result.errorCode ?? "project phase blocked";
      this.projects.updatePhase(phase);
      project.status = "blocked";
      project.shortages = this.phaseShortages(project, phase, data?.shortages ?? []);
      project.lastError = phase.lastError;
      project.updatedAt = now;
      this.projects.update(project);
      this.projects.appendEvent({ projectId: project.id, phaseId: phase.id, taskId: task.id, kind: "blocked", details: { shortages: project.shortages, error: phase.lastError }, createdAt: now });
      this.bus.emit("build_project.blocked", { project, phase });
      this.scheduleAcquisition(project, phase, task.id, now);
      return "block";
    }

    if (result.status === "partial" || result.status === "interrupted" || (result.status === "failed" && result.retryable === true)) {
      this.recordSliceProgress(project, phase, data, now, task.id);
      return "requeue";
    }

    phase.status = "failed";
    phase.lastError = result.message ?? result.errorCode ?? "project phase failed";
    this.projects.updatePhase(phase);
    project.status = "failed";
    project.lastError = phase.lastError;
    project.updatedAt = now;
    this.projects.update(project);
    this.projects.appendEvent({ projectId: project.id, phaseId: phase.id, taskId: task.id, kind: "failed", details: { error: phase.lastError }, createdAt: now });
    return "fail";
  }

  /** Create one deterministic acquisition task per current shortage. */
  private scheduleAcquisition(project: BuildProject, phase: BuildPhase, blockedTaskId: string, now: string): Task[] {
    const tasks: Task[] = [];
    for (const shortage of project.shortages) {
      const quantity = Math.max(0, Math.ceil(shortage.required - shortage.available));
      if (quantity <= 0) continue;
      const workKey = `build-project:${project.id}:${phase.id}:acquire:${shortage.material}`;
      const task = this.scheduler.enqueue({
        type: "build_project_acquire",
        priority: TaskPriority.FOREGROUND,
        source: project.source,
        objective: `Acquire ${quantity} ${shortage.material} for ${project.structureType}.`,
        parameters: { projectId: project.id, phaseId: phase.id, item: shortage.material, quantity, blueprintHash: project.blueprintHash },
        projectId: project.id,
        projectPhaseId: phase.id,
        executionPolicy: "resumable",
        workKey,
      });
      tasks.push(task);
      this.projects.appendEvent({ projectId: project.id, phaseId: phase.id, taskId: task.id, kind: "acquisition_scheduled", details: { material: shortage.material, quantity, blockedTaskId, workKey }, createdAt: now });
    }
    return tasks;
  }

  /** Recreate due acquisition work after a restart without planner involvement. */
  private scheduleDueAcquisition(projectId: string): Task | null {
    const project = this.projects.get(projectId);
    if (project === null || project.status !== "blocked") return null;
    if (project.resumeState.retryAfter !== undefined && Date.parse(project.resumeState.retryAfter) > Date.now()) return null;
    const phase = project.currentPhaseId === undefined ? undefined : this.projects.getPhases(project.id).find((item) => item.id === project.currentPhaseId);
    if (phase === undefined) return null;
    return this.scheduleAcquisition(project, phase, "rehydrate", new Date().toISOString())[0] ?? null;
  }

  private settleAcquisition(project: BuildProject, task: Task, result: SkillResult, now: string): ProjectTaskSettlement {
    const material = String(task.parameters.item ?? "");
    const phase = task.projectPhaseId === undefined
      ? undefined
      : this.projects.getPhases(project.id).find((candidate) => candidate.id === task.projectPhaseId);
    if (phase === undefined || material === "") return "fail";

    if (result.status === "completed") {
      project.shortages = project.shortages.filter((shortage) => shortage.material !== material);
      project.resumeState = { ...project.resumeState, retryAfter: undefined };
      project.updatedAt = now;
      this.projects.appendEvent({ projectId: project.id, phaseId: phase.id, taskId: task.id, kind: "acquisition_completed", details: { material, quantity: task.parameters.quantity }, createdAt: now });
      if (project.shortages.length === 0) {
        phase.status = "active";
        phase.lastError = undefined;
        project.status = "active";
        project.lastError = undefined;
        this.projects.updatePhase(phase);
        this.projects.update(project);
        this.scheduleNextWork(project.id);
      } else {
        // Keep the parent blocked until every known material bill is
        // satisfied; this prevents a resumed slice from racing another
        // acquisition task when a phase has multiple shortages.
        this.projects.update(project);
        this.scheduleAcquisition(project, phase, task.id, now);
      }
      return "complete";
    }

    if (result.status === "failed" && result.retryable === true) {
      const attempts = task.attempts ?? 1;
      const delayMs = Math.min(60 * 60_000, 30_000 * 2 ** Math.max(0, attempts - 1));
      project.status = "blocked";
      project.resumeState = { ...project.resumeState, retryAfter: new Date(Date.now() + delayMs).toISOString() };
      project.lastError = result.message ?? result.errorCode ?? `acquisition retry scheduled for ${material}`;
      project.updatedAt = now;
      this.projects.update(project);
      this.projects.appendEvent({ projectId: project.id, phaseId: phase.id, taskId: task.id, kind: "acquisition_backoff", details: { material, retryAfter: project.resumeState.retryAfter, attempts }, createdAt: now });
      return "block";
    }

    if (result.status === "partial" || result.status === "interrupted") return "requeue";

    project.status = "blocked";
    project.lastError = result.message ?? result.errorCode ?? `acquisition failed for ${material}`;
    project.updatedAt = now;
    this.projects.update(project);
    this.projects.appendEvent({ projectId: project.id, phaseId: phase.id, taskId: task.id, kind: "acquisition_failed", details: { material, retryable: false, error: project.lastError }, createdAt: now });
    return "block";
  }

  private phaseShortages(project: BuildProject, phase: BuildPhase, reported: Array<{ material: string; required: number; available: number }>): BuildProject["shortages"] {
    const bill: Record<string, number> = {};
    for (let index = phase.operationStart; index < phase.operationEnd; index += 1) {
      const material = project.blueprint.operations[index]?.material;
      if (material !== undefined) bill[material] = (bill[material] ?? 0) + 1;
    }
    return Object.entries(bill).flatMap(([material, required]) => {
      const observed = reported.find((shortage) => shortage.material === material);
      return observed === undefined ? [] : [{ material, required: Math.min(required, observed.required), available: observed.available }];
    });
  }

  /** Queue final reconciliation after all deterministic phase tasks finish. */
  scheduleFinalVerification(projectId: string): Task | null {
    const project = this.projects.get(projectId);
    if (project === null || project.status !== "verifying") return null;
    const task = this.scheduler.enqueue({
      type: "build_project_verify",
      priority: TaskPriority.FOREGROUND,
      source: project.source,
      objective: `Verify completed ${project.structureType}.`,
      parameters: { projectId: project.id, blueprintHash: project.blueprintHash },
      projectId: project.id,
      executionPolicy: "resumable",
      workKey: `build-project:${project.id}:final-verification`,
    });
    this.projects.appendEvent({ projectId: project.id, taskId: task.id, kind: "verification_task_scheduled", details: {}, createdAt: new Date().toISOString() });
    return task;
  }

  private recordSliceProgress(project: BuildProject, phase: BuildPhase, data: SliceOutcomeData | undefined, now: string, taskId: string): void {
    const cursor = data?.currentOperationIndex ?? project.resumeState.currentOperationIndex;
    const lastVerifiedOperationId = cursor > 0 ? project.blueprint.operations[cursor - 1]?.id : project.resumeState.lastVerifiedOperationId;
    project.resumeState = {
      ...project.resumeState,
      currentOperationIndex: cursor,
      lastVerifiedOperationId,
    };
    if (data?.verified !== undefined) phase.verifiedOperations = Math.min(phase.totalOperations, data.verified);
    project.verificationState = { ...project.verificationState, verifiedOperations: this.projects.getPhases(project.id).reduce((sum, item) => sum + item.verifiedOperations, 0) };
    project.updatedAt = now;
    this.projects.updatePhase(phase);
    this.projects.update(project);
    this.projects.appendEvent({ projectId: project.id, phaseId: phase.id, taskId, kind: "slice_checkpointed", details: { currentOperationIndex: cursor, verified: data?.verified ?? 0, remaining: data?.remaining ?? null }, createdAt: now });
  }
}

function asRecord(value: unknown): SliceOutcomeData | undefined {
  return value !== null && typeof value === "object" ? value as SliceOutcomeData : undefined;
}

function isCompleteSlice(data: SliceOutcomeData | undefined, phase: BuildPhase): boolean {
  return data?.remaining === 0 && (data.verified ?? 0) >= phase.totalOperations;
}

function toBuildPhase(projectId: string, phase: BlueprintPhase, totalOperations: number, ordinal: number): BuildPhase {
  return {
    id: phase.id,
    projectId,
    ordinal,
    label: phase.label,
    operationStart: phase.operationStart,
    operationEnd: phase.operationEnd,
    status: "pending",
    attempts: 0,
    verifiedOperations: 0,
    totalOperations: Math.min(phase.operationEnd, totalOperations) - phase.operationStart,
  };
}
