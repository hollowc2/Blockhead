import type { EventBus } from "../events/bus.js";
import type { Scheduler } from "./scheduler.js";
import { TaskPriority, type Task } from "./task.js";
import type { WorldProjectManager } from "./world-projects.js";

/** Deterministic maintenance work requested while a terrain slice is active. */
export type TerrainMaintenanceKind = "inventory" | "tool" | "survival";

export interface SurvivalInterruptCoordinatorOptions {
  bus: EventBus;
  scheduler: Scheduler;
  projects: WorldProjectManager;
}

/**
 * Converts survival signals into a cooperative project checkpoint followed by
 * one bounded, project-linked maintenance child. It never chooses terrain
 * geometry or performs a block mutation.
 */
export class SurvivalInterruptCoordinator {
  private readonly unsubscribe: Array<() => void> = [];
  private pending = new Set<string>();

  constructor(private readonly options: SurvivalInterruptCoordinatorOptions) {
    const { bus } = options;
    this.unsubscribe.push(
      bus.on("inventory.full", () => this.request("inventory")),
      bus.on("tool.low_durability", ({ item }) => this.request("tool", item)),
      bus.on("tool.broken", ({ item }) => this.request("tool", item)),
      bus.on("hunger.low", () => this.request("survival", "hunger")),
      bus.on("damage.received", ({ health }) => {
        if (health <= 8) this.request("survival", "health");
      }),
      bus.on("hostile.detected", ({ distance }) => {
        if (distance === null || distance <= 12) this.request("survival", "hostile");
      }),
      bus.on("death", () => this.options.scheduler.requestPause()),
      bus.on("task.completed", ({ task }) => this.clearForProject(task)),
      bus.on("task.failed", ({ task }) => this.clearForProject(task)),
      bus.on("task.cancelled", ({ task }) => this.clearForProject(task)),
    );
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribe) unsubscribe();
    this.unsubscribe.length = 0;
    this.pending.clear();
  }

  private request(kind: TerrainMaintenanceKind, detail = ""): void {
    const active = this.options.scheduler.active;
    if (active === null || active.type !== "world_project_slice" || active.projectId === undefined) return;
    const project = this.options.projects.getWorldProject(active.projectId);
    if (project === null || project.status !== "active") return;
    const key = `${project.id}:${kind}:${detail}`;
    if (this.pending.has(key)) return;
    this.pending.add(key);
    this.options.scheduler.requestPause();
    this.options.scheduler.enqueue({
      type: kind === "inventory" ? "world_project_deposit" : kind === "tool" ? "world_project_replace_tool" : "world_project_return",
      priority: kind === "survival" ? TaskPriority.EMERGENCY : TaskPriority.MAINTENANCE,
      source: "maintenance",
      objective: kind === "inventory" ? `Deposit terrain project inventory for ${project.id}.` : kind === "tool" ? `Replace terrain project tool for ${project.id}.` : `Return safely before resuming terrain project ${project.id}.`,
      parameters: { projectId: project.id, phaseId: active.projectPhaseId, reason: detail, ...(kind === "tool" ? { item: detail } : {}) },
      projectId: project.id,
      projectPhaseId: active.projectPhaseId,
      executionPolicy: "resumable",
      workKey: `world-project-maintenance:${project.id}:${kind}:${detail}`,
    });
    // A queued maintenance child is allowed to preempt only after the active
    // terrain runner reaches its cooperative checkpoint.
    this.options.scheduler.claim();
  }

  private clearForProject(task: Task): void {
    if (task.projectId === undefined || !task.type.startsWith("world_project_")) return;
    for (const key of this.pending) if (key.startsWith(`${task.projectId}:`)) this.pending.delete(key);
  }
}
