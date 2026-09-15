import type { EventBus } from "../events/bus.js";
import type { Task } from "../agent/task.js";

export interface TaskOutcome {
  id: string;
  type: string;
  source: Task["source"];
  objective: string;
  status: "completed" | "failed" | "blocked" | "cancelled";
  lastError: string | null;
  at: string;
}

export class TaskOutcomeTracker {
  private readonly now: () => number;
  private readonly maxRecent: number;
  private readonly unsubscribers: Array<() => void> = [];
  private readonly results: TaskOutcome[] = [];
  private _last: TaskOutcome | null = null;
  private _consecutiveFailures = 0;

  constructor(options: { bus: EventBus; now?: () => number; maxRecent?: number }) {
    this.now = options.now ?? Date.now;
    this.maxRecent = options.maxRecent ?? 20;
    this.unsubscribers.push(
      options.bus.on("task.completed", ({ task }) => this.record(task, "completed")),
      options.bus.on("task.failed", ({ task }) => this.record(task, "failed")),
      options.bus.on("task.blocked", ({ task }) => this.record(task, "blocked")),
      options.bus.on("task.cancelled", ({ task }) => this.record(task, "cancelled")),
    );
  }

  get last(): TaskOutcome | null { return this._last; }
  get consecutiveFailures(): number { return this._consecutiveFailures; }
  recent(): readonly TaskOutcome[] { return this.results; }

  dispose(): void {
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers.length = 0;
  }

  private record(task: Task, status: TaskOutcome["status"]): void {
    const result: TaskOutcome = {
      id: task.id,
      type: task.type,
      source: task.source,
      objective: task.objective,
      status,
      lastError: task.lastError ?? null,
      at: task.completedAt ?? new Date(this.now()).toISOString(),
    };
    this._last = result;
    this.results.unshift(result);
    if (this.results.length > this.maxRecent) this.results.pop();
    if (status === "completed") this._consecutiveFailures = 0;
    else if (status === "failed" || status === "blocked") this._consecutiveFailures += 1;
  }
}
