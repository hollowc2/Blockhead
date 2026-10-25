import type { EventBus } from "../events/bus.js";
import type { AppDatabase } from "../memory/database.js";
import { TaskPriority, TaskStatus, type Task } from "../agent/task.js";
import { GoalStatus, type Goal } from "../agent/goal.js";
import type { ViewerChatResult } from "./viewer-chat.js";
import type { BuildProject } from "../memory/build-projects.js";
import { blockerHeadline, blockerNextSteps, projectName, type BlockerChoice, type OpenBlocker } from "../agent/blockers.js";

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
export interface CommandStep { kind: "task" | "goal"; id: string; title: string; status: string; projectId?: string }
export interface CommandView {
  id: number;
  text: string;
  at: string;
  status: CommandStatus;
  replies: readonly string[];
  steps: readonly CommandStep[];
  finishedAt: string | null;
}

/**
 * One owner request (or one piece of Bob's own work) and everything under
 * it: command -> goal -> build -> current step -> blocker -> next steps
 * ("Finish house" -> "Acquire glass" -> "Missing 18 sand" -> "Gather 18
 * sand"). Every node has a stable `ref` ("blocker:<id>", "task:<id>") the
 * viewer links to from anywhere a problem is shown.
 */
export type TrailNodeKind = "command" | "goal" | "build" | "task" | "blocker" | "step";
export interface TrailAction {
  kind: "task" | "goal" | "build" | "blocker";
  id: string;
  action: "pause" | "resume" | "cancel" | "proceed" | "change_plan" | "set_aside";
  label: string;
  tone: "" | "go" | "danger";
}
export interface TrailNode {
  ref: string;
  kind: TrailNodeKind;
  title: string;
  /** running / queued / paused / blocked / done / failed / cancelled / next (a proposed step) ... */
  status: string;
  detail: string | null;
  meta: readonly string[];
  progress: { done: number; total: number } | null;
  actions: readonly TrailAction[];
  children: TrailNode[];
}
export interface WorkTrail {
  ref: string;
  /** The owner asked for it (a command, an owner goal, the owner's own build or task). */
  owner: boolean;
  /** The most urgent state anywhere in the trail. */
  status: string;
  /** Finished commands are history, kept below the live work. */
  finished: boolean;
  at: string;
  root: TrailNode;
}

export interface JobsSummary {
  active: JobView | null;
  goals: readonly JobView[];
  tasks: readonly JobView[];
  commands: readonly CommandView[];
  trails: readonly WorkTrail[];
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
  /** Unfinished build projects. */
  projects?: () => readonly BuildProject[];
  /** Open owner-facing blocker offers. */
  blockers?: () => readonly OpenBlocker[];
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
  const active = scheduler.active === null ? null : projectTaskJob(scheduler.active, true, scheduler.pendingInterruptReason);
  const tasks = scheduler.queued.map((task) => projectTaskJob(task, false, null));
  const goalJobs = goals.map(projectGoalJob);
  const liveTasks = scheduler.active === null ? [...scheduler.queued] : [scheduler.active, ...scheduler.queued];
  return {
    active, goals: goalJobs, tasks, commands,
    trails: projectTrails({
      tasks: liveTasks.map((task, index) => ({ task, job: index === 0 && active !== null ? active : tasks[active === null ? index : index - 1]! })),
      goals: goals.map((goal, index) => ({ goal, job: goalJobs[index]! })),
      projects: source.projects?.() ?? [],
      blockers: source.blockers?.() ?? [],
      commands,
      activeProjectId: scheduler.active?.projectId ?? null,
    }),
  };
}

const SOURCE_WORDS: Readonly<Record<string, string>> = { user: "your task", goal: "goal step", owner: "your goal", background: "self-chosen", director: "self-chosen", maintenance: "upkeep", system: "system" };
const URGENCY = ["blocked", "running", "active", "verifying", "cancelling", "pausing", "paused", "queued", "waiting"];

function words(value: string): string {
  return value.replace(/^minecraft:/, "").replace(/_/g, " ");
}

function jobActions(job: JobView): TrailAction[] {
  const actions: TrailAction[] = [];
  if (job.controls.pause) actions.push({ kind: job.kind, id: job.id, action: "pause", label: "Pause", tone: "" });
  if (job.controls.resume) actions.push({ kind: job.kind, id: job.id, action: "resume", label: "Resume", tone: "go" });
  if (job.controls.cancel) actions.push({ kind: job.kind, id: job.id, action: "cancel", label: "Cancel", tone: "danger" });
  return actions;
}

function jobStatus(job: JobView): string {
  if (job.stopping === "cancel") return "cancelling";
  if (job.stopping === "pause") return "pausing";
  return job.held ? "paused" : job.state === "active" ? "running" : job.state;
}

function node(fields: Partial<TrailNode> & Pick<TrailNode, "ref" | "kind" | "title" | "status">): TrailNode {
  return { detail: null, meta: [], progress: null, actions: [], children: [], ...fields };
}

function offerNode(offer: OpenBlocker): TrailNode {
  const steps = blockerNextSteps(offer.explanation);
  const fixable = offer.explanation.canFix;
  return node({
    ref: `blocker:${offer.id}`, kind: "blocker", title: blockerHeadline(offer.explanation), status: "blocked",
    detail: offer.summary,
    actions: [
      { kind: "blocker", id: offer.id, action: "proceed", label: fixable ? "Go ahead" : "Try again", tone: "go" },
      { kind: "blocker", id: offer.id, action: "change_plan", label: "Change the plan", tone: "danger" },
    ],
    children: steps.map((title, index) => node({ ref: `blocker:${offer.id}:step:${index}`, kind: "step", title, status: fixable ? "next" : "needs you" })),
  });
}

/** A stop with no owner offer (a goal step, Bob's own work, a build stuck on something besides materials). */
function stuckNode(ref: string, reason: string, actions: TrailAction[] = []): TrailNode {
  const [head, ...rest] = reason.split(/(?<=[.;])\s+/);
  return node({ ref, kind: "blocker", title: head!.replace(/[.;]$/, ""), status: "blocked", detail: rest.length > 0 ? reason : null, actions });
}

export interface TrailInput {
  tasks: readonly { task: Task; job: JobView }[];
  goals: readonly { goal: Goal; job: JobView }[];
  projects: readonly BuildProject[];
  blockers: readonly OpenBlocker[];
  /** Newest first. */
  commands: readonly CommandView[];
  activeProjectId: string | null;
}

/**
 * Fold live tasks, goals, builds, blocker offers and the owner's commands
 * into trails. Tasks nest under the build they serve or the goal they are a
 * step of; builds under the goal that measures them; goals, builds and
 * tasks under the command that started them (the newest command wins).
 * Whatever is left over is its own trail: owner work started from game chat,
 * or Bob's own.
 */
export function projectTrails(input: TrailInput): WorkTrail[] {
  const parent = new Map<string, string>();
  const nodes = new Map<string, TrailNode>();
  const offers = [...input.blockers];
  const takeOffer = (match: (offer: OpenBlocker) => boolean): OpenBlocker | null => {
    const index = offers.findIndex(match);
    return index < 0 ? null : offers.splice(index, 1)[0]!;
  };
  const projectIds = new Set(input.projects.map((project) => project.id));
  const goalIds = new Set(input.goals.map(({ goal }) => goal.id));
  const owners = new Map<string, boolean>();

  for (const project of input.projects) {
    const ref = `build:${project.id}`;
    const running = input.activeProjectId === project.id;
    const status = project.status === "active" ? running ? "running" : "queued" : project.status;
    const total = project.verificationState.totalOperations || project.blueprint.operations.length;
    const offer = takeOffer((candidate) => candidate.subject.kind === "build" && candidate.subject.projectId === project.id);
    const actions: TrailAction[] = [];
    if (offer === null && (project.status === "blocked" || project.status === "paused")) actions.push({ kind: "build", id: project.id, action: "resume", label: "Resume build", tone: "go" });
    if (offer === null && project.status === "blocked") actions.push({ kind: "build", id: project.id, action: "set_aside", label: "Set aside", tone: "danger" });
    const title = projectName(project).replace(/^the /, "");
    const built = node({
      ref, kind: "build", title: `Build ${title}`, status,
      detail: project.status === "paused" ? project.lastError ?? "Set aside; resume it to pick it back up." : null,
      meta: [project.source === "user" ? "your build" : project.structureType.startsWith("village:") ? "self-chosen" : "goal build", `at ${project.origin.x}, ${project.origin.y}, ${project.origin.z}`],
      progress: total > 0 ? { done: project.verificationState.verifiedOperations, total } : null, actions,
    });
    nodes.set(ref, built);
    owners.set(ref, project.source === "user");
    if (offer !== null) {
      // The offer belongs under the blocked step when it is still queued.
      const blocked = input.tasks.find(({ task }) => task.projectId === project.id && (task.id === offer.taskId || task.status === TaskStatus.BLOCKED));
      if (blocked === undefined) built.children.push(offerNode(offer));
      else nodes.set(`offer-for:task:${blocked.task.id}`, offerNode(offer));
    } else if (project.status === "blocked" && !input.tasks.some(({ task }) => task.projectId === project.id && task.status === TaskStatus.BLOCKED)) {
      built.children.push(stuckNode(`stuck:${ref}`, project.lastError ?? "Blocked", actions));
      built.actions = [];
    }
  }

  for (const { goal, job } of input.goals) {
    const ref = `goal:${goal.id}`;
    const built = node({ ref, kind: "goal", title: goal.description, status: jobStatus(job), detail: goal.currentStep ? `Now: ${goal.currentStep}` : null, meta: ["goal", SOURCE_WORDS[goal.source] ?? goal.source], actions: jobActions(job) });
    nodes.set(ref, built);
    owners.set(ref, goal.source === "owner");
    for (const criterion of goal.successCriteria) {
      if (criterion.kind === "building_verified" && criterion.target === "project" && criterion.projectId !== undefined && projectIds.has(criterion.projectId)) {
        if (!parent.has(`build:${criterion.projectId}`)) parent.set(`build:${criterion.projectId}`, ref);
      }
    }
    const last = goal.recentResults.at(-1);
    const liveStep = input.tasks.some(({ task }) => task.parameters.goalId === goal.id);
    if (!liveStep && last !== undefined && (last.outcome === "blocked" || last.outcome === "failed") && last.message) {
      built.children.push(stuckNode(`stuck:${ref}`, `Last step (${words(last.action)}) ${last.outcome}: ${last.message}`));
    }
  }

  for (const { task, job } of input.tasks) {
    const ref = `task:${task.id}`;
    const built = node({
      ref, kind: "task", title: task.objective, status: jobStatus(job), detail: task.status === TaskStatus.BLOCKED ? null : job.detail,
      meta: [words(task.type), SOURCE_WORDS[task.source] ?? task.source, ...(job.priority !== null && job.priority >= UNCONTROLLED_PRIORITY ? ["safety reflex"] : [])],
      actions: jobActions(job),
    });
    nodes.set(ref, built);
    owners.set(ref, task.source === "user");
    const offer = nodes.get(`offer-for:${ref}`) ?? (() => { const found = takeOffer((candidate) => candidate.taskId === task.id); return found === null ? null : offerNode(found); })();
    nodes.delete(`offer-for:${ref}`);
    if (offer !== null) built.children.push(offer);
    else if (task.status === TaskStatus.BLOCKED) built.children.push(stuckNode(`stuck:${ref}`, task.lastError ?? "Blocked", jobActions(job).filter((action) => action.action === "cancel")));
    if (task.projectId !== undefined && projectIds.has(task.projectId)) parent.set(ref, `build:${task.projectId}`);
    else if (typeof task.parameters.goalId === "string" && goalIds.has(task.parameters.goalId)) parent.set(ref, `goal:${task.parameters.goalId}`);
  }

  const rootOf = (ref: string): string => { let at = ref; for (let hop = 0; hop < 8 && parent.has(at); hop++) at = parent.get(at)!; return at; };
  const trails: WorkTrail[] = [];
  const claimed = new Set<string>();
  for (const command of input.commands) {
    const ref = `command:${command.id}`;
    const root = node({
      ref, kind: "command", title: `“${command.text}”`, status: command.status,
      detail: command.replies.at(-1) ?? (command.status === "waiting" ? "Waiting for CobbleBob to pick it up…" : null), meta: ["your command"],
    });
    for (const step of command.steps) {
      const direct = `${step.kind}:${step.id}`;
      const live = nodes.has(direct) ? direct : step.projectId !== undefined && nodes.has(`build:${step.projectId}`) ? `build:${step.projectId}` : null;
      if (live !== null) {
        const top = rootOf(live);
        if (!claimed.has(top)) { claimed.add(top); parent.set(top, ref); }
        continue;
      }
      if (step.projectId !== undefined && root.children.some((child) => child.ref === `build:${step.projectId}`)) continue;
      // Settled work stays as a line of history under its command.
      const settled = node({ ref: direct, kind: step.kind, title: step.title, status: step.status === "completed" ? "done" : step.status });
      const offer = takeOffer((candidate) => candidate.taskId === step.id);
      if (offer !== null) settled.children.push(offerNode(offer));
      root.children.push(settled);
    }
    nodes.set(ref, root);
    owners.set(ref, true);
  }
  for (const offer of offers) {
    const ref = `blocker:${offer.id}`;
    nodes.set(ref, offerNode(offer));
    owners.set(ref, true);
  }

  // Attach children in input order, then emit the roots.
  for (const [child, of] of parent) nodes.get(of)?.children.push(nodes.get(child)!);
  const at = (root: TrailNode): string => {
    const command = input.commands.find((candidate) => `command:${candidate.id}` === root.ref);
    if (command !== undefined) return command.at;
    const task = input.tasks.find(({ task: candidate }) => `task:${candidate.id}` === root.ref)?.task;
    const goal = input.goals.find(({ goal: candidate }) => `goal:${candidate.id}` === root.ref)?.goal;
    const project = input.projects.find((candidate) => `build:${candidate.id}` === root.ref);
    const offer = input.blockers.find((candidate) => `blocker:${candidate.id}` === root.ref);
    return task?.createdAt ?? goal?.createdAt ?? project?.createdAt ?? (offer === undefined ? new Date(0).toISOString() : new Date(offer.openedAt).toISOString());
  };
  for (const [ref, root] of nodes) {
    if (ref.startsWith("offer-for:") || parent.has(ref)) continue;
    const status = trailStatus(root);
    const finished = root.kind === "command" && !URGENCY.includes(status);
    // A request reads as blocked when anything under it is, not "running".
    if (root.kind === "command" && status === "blocked") root.status = status;
    trails.push({ ref, owner: owners.get(ref) === true, status, finished, at: at(root), root });
  }
  return trails.sort((a, b) => Number(a.finished) - Number(b.finished) || Number(b.owner) - Number(a.owner)
    || rank(a.status) - rank(b.status) || b.at.localeCompare(a.at));
}

function rank(status: string): number {
  const index = URGENCY.indexOf(status);
  return index < 0 ? URGENCY.length : index;
}

/** The most urgent state anywhere under a node; a settled command keeps its own. */
export function trailStatus(root: TrailNode): string {
  let best = root.status;
  const visit = (at: TrailNode): void => {
    if (at.kind !== "step" && rank(at.status) < rank(best)) best = at.status;
    at.children.forEach(visit);
  };
  visit(root);
  return best === "active" || best === "verifying" ? "running" : best;
}

export interface JobControlOptions {
  scheduler: { active: Task | null; queued: readonly Task[]; hold(id: string): Task | null; release(id: string): Task | null; cancel(id: string): Task | null; claim?(): unknown };
  goals: { pause(id: string): Goal | null; resume(id: string): Goal | null; cancelGoal(id: string, reason?: string): Goal | null } | null;
  /** Answers one open blocker offer ("go ahead" / "change the plan"). */
  blockers?: { byId(id: string): OpenBlocker | null; resolve(choice: BlockerChoice, id?: string): string };
  builds?: { resumeProject(id: string): Task | null; setAside(id: string, reason: string): boolean };
}

/** `POST /api/job` on the private viewer: `{ kind, id, action }`. */
export function createJobControl(options: JobControlOptions): (raw: unknown) => Promise<ViewerChatResult> {
  return async (raw) => {
    const body = raw !== null && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const { kind, id, action } = body;
    if (typeof id === "string" && id.length > 0 && id.length <= 64 && kind === "blocker" && (action === "proceed" || action === "change_plan")) {
      if (options.blockers === undefined) return { ok: false, status: 503, error: "Blockers are unavailable." };
      if (options.blockers.byId(id) === null) return { ok: false, status: 400, error: "That blocker already cleared." };
      return { ok: true, answer: options.blockers.resolve(action, id) };
    }
    if (typeof id === "string" && id.length > 0 && id.length <= 64 && kind === "build" && (action === "resume" || action === "set_aside")) {
      if (options.builds === undefined) return { ok: false, status: 503, error: "Builds are unavailable." };
      if (action === "set_aside") {
        return options.builds.setAside(id, "set aside by the owner") ? { ok: true, answer: "Build set aside." } : { ok: false, status: 400, error: "That build isn't stuck." };
      }
      const task = options.builds.resumeProject(id);
      if (task === null) return { ok: false, status: 400, error: "There's nothing left to schedule for that build." };
      options.scheduler.claim?.();
      return { ok: true, answer: "Back to the build." };
    }
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
      steps.push({ kind: "task", id, title: task.objective, status, ...(task.projectId === undefined ? {} : { projectId: task.projectId }) });
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
