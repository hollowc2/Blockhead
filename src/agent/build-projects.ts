import { randomUUID } from "node:crypto";
import { logger } from "../logger.js";
import { EventBus } from "../events/bus.js";
import { BUILDING_COMPILER_VERSION, compileBuildingDesign, type BlueprintPhase } from "../building/compiler.js";
import { BUILDING_SCHEMA_VERSION, BuildingDesignSchema, type BuildingDesign } from "../building/schema.js";
import type { HomeLocation } from "../minecraft/movement.js";
import type { BuildPhase, BuildProject, BuildProjectsRepository } from "../memory/build-projects.js";
import type { Scheduler } from "./scheduler.js";
import { TaskPriority, type Task } from "./task.js";

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
  ) {}

  /** Rehydrate persisted projects before a bot session starts executing work. */
  rehydrate(): BuildProject[] {
    const restored: BuildProject[] = [];
    for (const project of this.projects.loadUnfinished()) {
      restored.push(project);
      if (project.status !== "active") continue;
      const task = this.scheduleNextWork(project.id);
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
