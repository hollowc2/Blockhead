import type { EventBus } from "../events/bus.js";
import type { AppDatabase } from "../memory/database.js";
import { TaskPriority, TaskStatus, type Task } from "../agent/task.js";
import { GoalStatus, type Goal } from "../agent/goal.js";
import type { ViewerChatResult } from "./viewer-chat.js";

/**
 * The private viewer's jobs panel: every live task and goal with the owner's
 * pause / resume / cancel controls, plus each command the owner sent from
 * the viewer tracked to the work it started and how that work ended.
 */

export type JobState = "active" | "queued" | "paused" | "blocked";
export interface JobControls { pause: boolean; resume: boolean; cancel: boolean }
export interface JobView {
  kind: "task" | "goal";
  id: string;
  title: string;
  type: string | null;
  source: string;
  state: JobState;
  /** The owner paused it; it will not resume on its own. */
  held: boolean;
  /** A pause or cancel was requested and the run has not checked in yet. */
  stopping: "pause" | "cancel" | null;
  detail: string | null;
  priority: number | null;
  createdAt: string;
  startedAt: string | null;
  /** The goal a goal step belongs to. */
  goalId: string | null;
  controls: JobControls;
}

export type CommandStatus = "waiting" | "answered" | "queued" | "running" | "paused" | "blocked" | "done" | "failed" | "cancelled";
export interface CommandStep { kind: "task" | "goal"; id: string; title: string; status: string }
export interface CommandView {
  id: number;
  text: string;
  at: string;
  status: CommandStatus;
  replies: readonly string[];
  steps: readonly CommandStep[];
  finishedAt: string | null;
}

export interface JobsSummary {
  active: JobView | null;
  goals: readonly JobView[];
  tasks: readonly JobView[];
  commands: readonly CommandView[];
}

/** Safety reflexes (fighting back, emergencies) are shown but never owner-controlled. */
const UNCONTROLLED_PRIORITY = TaskPriority.EMERGENCY;
const LINK_WINDOW_MS = 120_000;
const MAX_REPLIES = 3;
const MAX_COMMANDS = 12;

export interface JobsSource {
  scheduler: {
    active: Task | null;
    queued: readonly Task[];
    pendingInterruptReason: "pause" | "cancel" | null;
  };
  goals: { active(): Goal | null; queued(): readonly Goal[] } | null;
}

function taskState(task: Task): JobState {
  if (task.status === TaskStatus.ACTIVE) return "active";
  if (task.status === TaskStatus.BLOCKED) return "blocked";
  if (task.status === TaskStatus.PAUSED) return "paused";
  return "queued";
}

export function projectTaskJob(task: Task, active: boolean, interrupt: "pause" | "cancel" | null): JobView {
  const held = task.heldAt !== undefined;
  const controllable = task.priority < UNCONTROLLED_PRIORITY;
  const state = active ? "active" : taskState(task);
  const detail = task.status === TaskStatus.BLOCKED || state === "paused"
    ? task.lastError ?? (task.phase ? `Phase: ${task.phase}` : null)
    : task.phase ? `Phase: ${task.phase}${(task.attempts ?? 0) > 1 ? ` · attempt ${task.attempts}` : ""}` : task.lastError ?? null;
  return {
    kind: "task", id: task.id, title: task.objective, type: task.type, source: task.source, state, held,
    stopping: active ? interrupt : null, detail, priority: task.priority, createdAt: task.createdAt, startedAt: task.startedAt ?? null,
    goalId: typeof task.parameters.goalId === "string" ? task.parameters.goalId : null,
    controls: { pause: controllable && !held && !(active && interrupt !== null), resume: controllable && held, cancel: controllable && !(active && interrupt === "cancel") },
  };
}

export function projectGoalJob(goal: Goal): JobView {
  const held = goal.pausedAt !== undefined;
  return {
    kind: "goal", id: goal.id, title: goal.description, type: null, source: goal.source,
    state: goal.status === GoalStatus.ACTIVE ? held ? "paused" : "active" : held ? "paused" : "queued", held, stopping: null,
    detail: goal.currentStep ?? null, priority: null, createdAt: goal.createdAt, startedAt: null, goalId: null,
    controls: { pause: !held, resume: held, cancel: true },
  };
}

export function projectJobs(source: JobsSource, commands: readonly CommandView[] = []): JobsSummary {
  const { scheduler } = source;
  const goals = source.goals === null ? [] : [source.goals.active(), ...source.goals.queued()].filter((goal): goal is Goal => goal !== null);
  return {
    active: scheduler.active === null ? null : projectTaskJob(scheduler.active, true, scheduler.pendingInterruptReason),
    goals: goals.map(projectGoalJob),
    tasks: scheduler.queued.map((task) => projectTaskJob(task, false, null)),
    commands,
  };
}

export interface JobControlOptions {
  scheduler: { active: Task | null; queued: readonly Task[]; hold(id: string): Task | null; release(id: string): Task | null; cancel(id: string): Task | null };
  goals: { pause(id: string): Goal | null; resume(id: string): Goal | null; cancelGoal(id: string, reason?: string): Goal | null } | null;
}

/** `POST /api/job` on the private viewer: `{ kind, id, action }`. */
export function createJobControl(options: JobControlOptions): (raw: unknown) => Promise<ViewerChatResult> {
  return async (raw) => {
    const body = raw !== null && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const { kind, id, action } = body;
    if ((kind !== "task" && kind !== "goal") || typeof id !== "string" || id.length === 0 || id.length > 64
      || (action !== "pause" && action !== "resume" && action !== "cancel")) {
      return { ok: false, status: 400, error: "Choose a job and pause, resume or cancel." };
    }
    if (kind === "task") {
      const { scheduler } = options;
      const task = scheduler.active?.id === id ? scheduler.active : scheduler.queued.find((candidate) => candidate.id === id) ?? null;
      if (task === null) return { ok: false, status: 400, error: "That job already finished." };
      if (task.priority >= UNCONTROLLED_PRIORITY) return { ok: false, status: 400, error: "Safety reflexes can't be paused or cancelled." };
      const done = action === "pause" ? scheduler.hold(id) : action === "resume" ? scheduler.release(id) : scheduler.cancel(id);
      if (done === null) return { ok: false, status: 400, error: action === "resume" ? "That job isn't paused." : "That job can't be changed now." };
      const active = scheduler.active?.id === id;
      return { ok: true, answer: action === "pause" ? active ? "Pausing at the next safe point." : "Paused." : action === "resume" ? "Resumed." : active ? "Cancelling at the next safe point." : "Cancelled." };
    }
    if (options.goals === null) return { ok: false, status: 503, error: "Goals are unavailable." };
    const goal = action === "pause" ? options.goals.pause(id) : action === "resume" ? options.goals.resume(id) : options.goals.cancelGoal(id, "cancelled by the owner from the viewer");
    if (goal === null) return { ok: false, status: 400, error: action === "resume" ? "That goal isn't paused." : "That goal already finished." };
    return { ok: true, answer: action === "pause" ? "Goal paused." : action === "resume" ? "Goal resumed." : "Goal cancelled." };
  };
}

interface TrackedCommand {
  id: number;
  text: string;
  at: number;
  tasks: string[];
  goals: string[];
  replies: string[];
}

export interface CommandTrackerOptions {
  bus: EventBus;
  db?: AppDatabase;
  scheduler: { active: Task | null; queued: readonly Task[] };
  /** Settled task rows (the scheduler forgets them). */
  task(id: string): Task | null;
  goals: () => { active(): Goal | null; queued(): readonly Goal[] } | null;
  goal(id: string): Goal | null;
  now?: () => number;
}

/**
 * Follows each command the owner sends from the viewer to completion: owner
 * tasks created and owner goals started within a short window after it are
 * its work, Bob's chat replies in that window are its answer, and its status
 * is derived from that work's live or persisted state.
 */
export class CommandTracker {
  private readonly commands: TrackedCommand[] = [];
  private readonly unsubscribers: Array<() => void> = [];
  private readonly now: () => number;
  private nextId = 1;

  constructor(private readonly opts: CommandTrackerOptions) {
    this.now = opts.now ?? Date.now;
    this.load();
    const bus = opts.bus;
    this.unsubscribers.push(
      bus.on("task.created", ({ task }) => { if (task.source === "user") this.link("tasks", task.id); }),
      bus.on("build_project.scheduled", ({ project, task }) => { if (project.source === "user" && task !== undefined) this.link("tasks", task.id); }),
      bus.on("goal.started", ({ goal }) => { if (goal.source === "owner") this.link("goals", goal.id); }),
      bus.on("chat.reply", ({ message }) => this.reply(message)),
    );
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers.length = 0;
  }

  /** Record a command just delivered; returns its id. */
  begin(text: string): number {
    const command: TrackedCommand = { id: this.nextId++, text, at: this.now(), tasks: [], goals: [], replies: [] };
    try {
      const result = this.opts.db?.sql.prepare("INSERT INTO owner_commands (text, created_at) VALUES (?, ?)").run(text, new Date(command.at).toISOString());
      if (result !== undefined) { command.id = Number(result.lastInsertRowid); this.nextId = command.id + 1; }
    } catch { /* tracking is best effort */ }
    this.commands.push(command);
    if (this.commands.length > MAX_COMMANDS) this.commands.splice(0, this.commands.length - MAX_COMMANDS);
    return command.id;
  }

  /** Forget a command that never reached CobbleBob (delivery failed). */
  discard(id: number): void {
    const index = this.commands.findIndex((command) => command.id === id);
    if (index >= 0) this.commands.splice(index, 1);
    try { this.opts.db?.sql.prepare("DELETE FROM owner_commands WHERE id = ?").run(id); } catch { /* best effort */ }
  }

  /** Newest first. */
  view(): CommandView[] {
    this.linkQueuedGoals();
    return this.commands.slice().reverse().map((command) => this.project(command));
  }

  private open(): TrackedCommand | null {
    const latest = this.commands.at(-1);
    return latest !== undefined && this.now() - latest.at <= LINK_WINDOW_MS ? latest : null;
  }

  private link(kind: "tasks" | "goals", id: string): void {
    const command = this.open();
    if (command === null || command[kind].includes(id)) return;
    command[kind].push(id);
    this.persist(command);
  }

  /** Goals queued behind another emit nothing until they start; claim them by time. */
  private linkQueuedGoals(): void {
    const command = this.open();
    const goals = this.opts.goals();
    if (command === null || goals === null) return;
    for (const goal of goals.queued()) {
      if (goal.source === "owner" && Date.parse(goal.createdAt) >= command.at - 1000 && !this.commands.some((c) => c.goals.includes(goal.id))) this.link("goals", goal.id);
    }
  }

  private reply(message: string): void {
    const command = this.open();
    if (command === null || command.replies.length >= MAX_REPLIES) return;
    command.replies.push(message);
    this.persist(command);
  }

  private persist(command: TrackedCommand): void {
    try {
      this.opts.db?.sql.prepare("UPDATE owner_commands SET links_json = ?, replies_json = ? WHERE id = ?")
        .run(JSON.stringify({ tasks: command.tasks, goals: command.goals, projects: [] }), JSON.stringify(command.replies), command.id);
    } catch { /* best effort */ }
  }

  private load(): void {
    try {
      const rows = this.opts.db?.sql.prepare("SELECT id, text, created_at, links_json, replies_json FROM owner_commands ORDER BY id DESC LIMIT ?")
        .all(MAX_COMMANDS) as { id: number; text: string; created_at: string; links_json: string; replies_json: string }[] | undefined;
      for (const row of (rows ?? []).reverse()) {
        const links = JSON.parse(row.links_json) as { tasks?: string[]; goals?: string[] };
        const replies = JSON.parse(row.replies_json) as string[];
        this.commands.push({ id: row.id, text: row.text, at: Date.parse(row.created_at), tasks: links.tasks ?? [], goals: links.goals ?? [], replies: Array.isArray(replies) ? replies : [] });
        this.nextId = row.id + 1;
      }
    } catch { /* no history */ }
  }

  private project(command: TrackedCommand): CommandView {
    const { scheduler } = this.opts;
    const steps: CommandStep[] = [];
    const finished: string[] = [];
    for (const id of command.tasks) {
      const live = scheduler.active?.id === id ? scheduler.active : scheduler.queued.find((task) => task.id === id) ?? null;
      const task = live ?? this.opts.task(id);
      if (task === null) continue;
      const status = task.heldAt !== undefined && task.status !== TaskStatus.COMPLETED && task.status !== TaskStatus.FAILED && task.status !== TaskStatus.CANCELLED ? "paused" : task.status;
      steps.push({ kind: "task", id, title: task.objective, status });
      if (task.completedAt) finished.push(task.completedAt);
    }
    const goals = this.opts.goals();
    for (const id of command.goals) {
      const live = goals?.active()?.id === id ? goals.active() : goals?.queued().find((goal) => goal.id === id) ?? null;
      const goal = live ?? this.opts.goal(id);
      if (goal === null || goal === undefined) continue;
      steps.push({ kind: "goal", id, title: goal.description, status: goal.pausedAt !== undefined && (goal.status === GoalStatus.ACTIVE || goal.status === GoalStatus.QUEUED) ? "paused" : goal.status });
      if (goal.endedAt) finished.push(goal.endedAt);
    }
    const status = commandStatus(steps.map((step) => step.status), command.replies.length > 0, this.now() - command.at <= LINK_WINDOW_MS);
    const terminal = status === "done" || status === "failed" || status === "cancelled";
    return {
      id: command.id, text: command.text, at: new Date(command.at).toISOString(), status, replies: command.replies, steps,
      finishedAt: terminal && finished.length > 0 ? finished.sort().at(-1)! : null,
    };
  }
}

/** Fold step statuses into one command status, most urgent first. */
export function commandStatus(statuses: readonly string[], replied: boolean, fresh: boolean): CommandStatus {
  if (statuses.length === 0) return fresh && !replied ? "waiting" : "answered";
  const has = (...values: string[]): boolean => statuses.some((status) => values.includes(status));
  if (has("active")) return "running";
  if (has("blocked")) return "blocked";
  if (has("paused")) return "paused";
  if (has("queued")) return "queued";
  if (has("failed")) return "failed";
  if (statuses.every((status) => status === "cancelled")) return "cancelled";
  return "done";
}
