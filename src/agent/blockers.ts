import { randomUUID } from "node:crypto";
import type { EventBus } from "../events/bus.js";
import type { BuildProjectManager } from "./build-projects.js";
import type { BuildProject } from "../memory/build-projects.js";
import type { GoalManager } from "./goals.js";
import type { Scheduler } from "./scheduler.js";
import { TaskPriority, type Task } from "./task.js";

/**
 * Blocker explanations: instead of "waiting on materials", say what is
 * needed, what is missing, and what the bot can do about it ("Need 18
 * glass; missing 18 sand. I can gather it."), and let the owner choose to
 * proceed or change the plan.
 *
 * The explanation is pure data built from the ensure_item production plan
 * (`explainPlan`); the BlockerDesk turns owner-facing ones into a chat offer
 * and carries out the owner's answer.
 */

/** One raw input the production chain still lacks, and how the bot gets it. */
export interface MaterialGap {
  item: string;
  count: number;
  via: "gather" | "hunt" | "fuel";
}

export interface BlockerExplanation {
  /** What the blocked work needs ("18 glass"). */
  need: { item: string; count: number };
  /** Raw inputs not in stock (carried + stored) when the work stopped. */
  missing: MaterialGap[];
  /** True when every gap is something the bot can go and get itself. */
  canFix: boolean;
  /** Why the last attempt stopped ("no sand found nearby", "no recipe"). */
  reason?: string;
}

/** The plan step shapes `explainPlan` reads (structurally ensure-item's EnsureStep). */
type PlanStep =
  | { kind: "gather" | "hunt"; item: string; quantity: number }
  | { kind: "fuel"; quantity: number }
  | { kind: "craft" | "smelt"; item: string; quantity: number };

/**
 * The raw inputs a production plan still lacks. Gather/hunt/fuel steps carry
 * the *total* stock the chain needs of their drop, so the gap is that target
 * less what is carried + stored now (`have`). `dropOf` maps a gathered block
 * to the item it yields (iron_ore -> raw_iron).
 */
export function explainPlan(
  need: { item: string; count: number },
  steps: readonly PlanStep[],
  have: (item: string) => number,
  options: { dropOf?: (item: string) => string; reason?: string } = {},
): BlockerExplanation {
  const missing: MaterialGap[] = [];
  for (const step of steps) {
    if (step.kind === "fuel") {
      const gap = step.quantity - have("coal") - have("charcoal");
      if (gap > 0) missing.push({ item: "coal", count: gap, via: "fuel" });
    } else if (step.kind === "gather" || step.kind === "hunt") {
      const drop = options.dropOf?.(step.item) ?? step.item;
      const gap = step.quantity - have(drop);
      if (gap > 0) missing.push({ item: drop, count: gap, via: step.kind });
    }
  }
  return { need, missing, canFix: missing.length > 0, ...(options.reason === undefined ? {} : { reason: options.reason }) };
}

/** "raw_iron" -> "raw iron". */
function label(item: string): string {
  return item.replace(/^minecraft:/, "").replace(/_/g, " ");
}

/** Countable names that read wrong unpluralized ("6 log", "32 torch"). */
const PLURALS: Readonly<Record<string, string>> = { log: "logs", torch: "torches", plank: "planks" };

/** "6 logs", "32 torches", "18 sand". */
function amount(count: number, item: string): string {
  const name = label(item);
  if (count === 1) return `${count} ${name}`;
  const plural = PLURALS[name] ?? (/ log$/.test(name) ? `${name}s` : name);
  return `${count} ${plural}`;
}

function joinList(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * The owner-facing sentence: what is needed (for what), what is missing, and
 * the next step. "Need 18 glass for the house; missing 18 sand (no sand
 * found nearby). I can gather it."
 */
export function describeBlocker(explanation: BlockerExplanation, subject?: string): string {
  const { need, missing, reason } = explanation;
  const head = `Need ${amount(need.count, need.item)}${subject === undefined ? "" : ` for ${subject}`}`;
  const why = reason === undefined ? "" : ` (${reason})`;
  if (missing.length === 0) {
    return `${head}; I can't work out how to make it${why}.`;
  }
  const gaps = joinList(missing.map((gap) => (gap.via === "fuel" ? `${gap.count} coal or charcoal` : amount(gap.count, gap.item))));
  if (!explanation.canFix) return `${head}; missing ${gaps}${why}. I can't get that myself.`;
  const verbs = new Set(missing.map((gap) => gap.via));
  const verb = verbs.size === 1 && verbs.has("gather") ? "gather" : verbs.size === 1 && verbs.has("hunt") ? "hunt for" : "get";
  return `${head}; missing ${gaps}${why}. I can ${verb} ${missing.length === 1 ? "it" : "them"}.`;
}

/** The short line for a work trail: "Missing 18 sand", "Can't make 18 glass". */
export function blockerHeadline(explanation: BlockerExplanation): string {
  const { need, missing } = explanation;
  if (missing.length === 0) return need.count > 0 ? `Short of ${amount(need.count, need.item)}` : `Can't make ${label(need.item)}`;
  return `Missing ${joinList(missing.map((gap) => (gap.via === "fuel" ? `${gap.count} coal or charcoal` : amount(gap.count, gap.item))))}`;
}

/** What "go ahead" would do, one line per gap: "Gather 18 sand", "Get 4 coal or charcoal for fuel". */
export function blockerNextSteps(explanation: BlockerExplanation): string[] {
  if (explanation.missing.length === 0) {
    return explanation.canFix ? [`Get ${explanation.need.count > 0 ? amount(explanation.need.count, explanation.need.item) : `the ${label(explanation.need.item)}`}`] : [];
  }
  if (!explanation.canFix) return [`Stock ${joinList(explanation.missing.map((gap) => amount(gap.count, gap.item)))} yourself, then try again`];
  return explanation.missing.map((gap) => gap.via === "fuel" ? `Get ${gap.count} coal or charcoal for fuel`
    : `${gap.via === "hunt" ? "Hunt for" : "Gather"} ${amount(gap.count, gap.item)}`);
}

/** Read a blocker explanation out of a skill result's `data`, if it carries one. */
export function blockerOf(data: unknown): BlockerExplanation | null {
  if (typeof data !== "object" || data === null || !("blocker" in data)) return null;
  const blocker = (data as { blocker?: unknown }).blocker;
  if (typeof blocker !== "object" || blocker === null) return null;
  const candidate = blocker as Partial<BlockerExplanation>;
  if (typeof candidate.need?.item !== "string" || !Array.isArray(candidate.missing)) return null;
  return candidate as BlockerExplanation;
}

export type BlockerSubject =
  | { kind: "build"; projectId: string; name: string }
  | { kind: "task"; item: string; quantity: number }
  /** An owner task with no single item to ask for (the shed, a stockpile restore): rerun it as it was. */
  | { kind: "rerun"; type: string; parameters: Record<string, unknown>; objective: string };

/** Item tasks whose "proceed" becomes a full ensure_item (which may mine and hunt). */
const ITEM_TASKS: ReadonlySet<string> = new Set(["ensure_item", "craft_item", "smelt_item"]);

/** An owner-facing blocker waiting for "go ahead" or "change the plan". */
export interface OpenBlocker {
  id: string;
  subject: BlockerSubject;
  explanation: BlockerExplanation;
  /** The explanation sentence ("Need 18 glass for the house; missing 18 sand. I can gather it."). */
  summary: string;
  /** The summary plus the offer, as said in chat. */
  message: string;
  openedAt: number;
  /** The task that stopped (absent for offers re-adopted after a restart). */
  taskId?: string;
}

export type BlockerChoice = "proceed" | "change_plan";

/** An offer is only answered by a bare "yes"/"no" this soon after it was made. */
const SHORT_ANSWER_WINDOW_MS = 15 * 60_000;

const PROCEED_ANSWERS: ReadonlySet<string> = new Set([
  "go ahead", "go for it", "proceed", "do it", "yes", "yes please", "yep", "yeah", "sure", "ok", "okay",
  "gather it", "get it", "gather them", "get them", "go get it", "go get them", "please do", "try again",
]);
const CHANGE_ANSWERS: ReadonlySet<string> = new Set([
  "change the plan", "change plan", "no", "nope", "no thanks", "skip it", "skip that", "don't", "dont",
  "leave it", "set it aside", "something else",
]);

/** Map a normalized chat line onto an answer to the open offer, or null. */
export function parseBlockerAnswer(instruction: string): BlockerChoice | null {
  if (PROCEED_ANSWERS.has(instruction)) return "proceed";
  if (CHANGE_ANSWERS.has(instruction)) return "change_plan";
  return null;
}

/** Build/terrain names read better without their internal prefixes ("simple_house" -> "the house"). */
export function projectName(project: { structureType: string; userGoal: string }): string {
  return `the ${project.structureType.replace(/^simple_/, "").replace(/_/g, " ")}`;
}

export interface BlockerDeskOptions {
  bus: EventBus;
  scheduler: Scheduler;
  buildProjects?: BuildProjectManager;
  goals?: GoalManager;
  /** Best-effort game chat. */
  announce: (message: string) => void;
  now?: () => number;
}

/**
 * Process-lifetime (bus-driven, no bot) owner of blocker offers. It listens
 * for `task.blocker` (a settled skill that could not get its materials),
 * keeps one open offer per subject, says it in chat once, clears it when the
 * work moves again, and carries out the owner's "proceed" / "change the
 * plan". Only owner-facing work gets an offer: the owner's own item tasks
 * and builds. Goal and background steps only say the explanation (the goal
 * driver reads it from the result and picks the next step), and the bot's
 * own development builds retry by themselves.
 */
export class BlockerDesk {
  private readonly opts: BlockerDeskOptions;
  private readonly now: () => number;
  private readonly open = new Map<string, OpenBlocker>();
  private readonly unsubscribers: Array<() => void> = [];
  /** The last offer-less explanation said, so a retry loop does not repeat it. */
  private lastPassive: string | null = null;

  constructor(options: BlockerDeskOptions) {
    this.opts = options;
    this.now = options.now ?? Date.now;
    const bus = options.bus;
    this.unsubscribers.push(
      bus.on("task.blocker", ({ task, blocker }) => this.onBlocker(task, blocker)),
      // Work moving again closes the offer: a resumed slice, a finished build,
      // or the owner's item arriving some other way.
      bus.on("build_project.scheduled", ({ project }) => this.close(`build:${project.id}`)),
      bus.on("build_project.verified", ({ project }) => this.close(`build:${project.id}`)),
      // A slice resumed from its blocked task emits no "scheduled", so any of
      // the project's work completing (an acquisition landing) closes it too.
      bus.on("task.completed", ({ task }) => {
        if (task.projectId !== undefined) this.close(`build:${task.projectId}`);
        else if (task.source === "user" && ITEM_TASKS.has(task.type) && typeof task.parameters.item === "string") this.close(`task:${task.parameters.item.replace(/^minecraft:/, "")}`);
        else if (task.source === "user") this.close(`rerun:${task.type}`);
      }),
      // An owner "stop" abandons the work, so a later "yes" must not
      // restart it.
      bus.on("chat.command", ({ command }) => {
        if (command === "stop") this.open.clear();
      }),
      bus.on("goal.blocked", ({ goal }) => {
        if (goal.source !== "owner") return;
        // The queue has already moved on (or emptied) by the time this fires.
        const next = this.opts.goals?.active() ?? this.opts.goals?.queued()[0] ?? null;
        const step = next === null ? "What should I do instead?" : `Moving on to: ${next.description}`;
        this.opts.announce(`Can't finish "${goal.description}": ${goal.note ?? "no way forward"}. ${step}`);
      }),
    );
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers.length = 0;
  }

  /**
   * Re-open (silently) the offers for owner builds that were stuck on
   * materials before a restart: their explained error survives as the
   * project's lastError, so "go ahead" keeps working after a deploy.
   */
  adopt(projects: readonly BuildProject[]): void {
    for (const project of projects) {
      if (project.status !== "blocked" || project.structureType.startsWith("village:")) continue;
      const summary = project.lastError;
      if (summary === undefined || !summary.startsWith("Need ")) continue;
      const shortage = project.shortages[0];
      const explanation: BlockerExplanation = { need: { item: shortage?.material ?? "materials", count: shortage === undefined ? 0 : shortage.required - shortage.available }, missing: [], canFix: true };
      const subject: BlockerSubject = { kind: "build", projectId: project.id, name: projectName(project) };
      this.open.set(keyOf(subject), { id: randomUUID(), subject, explanation, summary, message: `${summary} Say "go ahead", or "change the plan".`, openedAt: this.now() });
    }
  }

  /** The newest open offer, or null. */
  latest(): OpenBlocker | null {
    let newest: OpenBlocker | null = null;
    for (const blocker of this.open.values()) if (newest === null || blocker.openedAt >= newest.openedAt) newest = blocker;
    return newest;
  }

  /** Every open offer, newest first. */
  openBlockers(): OpenBlocker[] {
    return [...this.open.values()].sort((a, b) => b.openedAt - a.openedAt);
  }

  /** The open offer for one build project, if any. */
  forProject(projectId: string): OpenBlocker | null {
    return this.open.get(`build:${projectId}`) ?? null;
  }

  /** One open offer by id, or null once it was answered or the work moved on. */
  byId(id: string): OpenBlocker | null {
    for (const blocker of this.open.values()) if (blocker.id === id) return blocker;
    return null;
  }

  /** True when a bare "yes"/"go ahead" right now would answer an offer. */
  awaitingAnswer(): boolean {
    const latest = this.latest();
    return latest !== null && this.now() - latest.openedAt < SHORT_ANSWER_WINDOW_MS;
  }

  private onBlocker(task: Task, explanation: BlockerExplanation): void {
    let subject: BlockerSubject;
    if (task.projectId !== undefined) {
      const project = this.opts.buildProjects?.getProject(task.projectId);
      // The bot's own development builds reopen themselves on a timer.
      if (project === null || project === undefined || project.structureType.startsWith("village:")) return;
      subject = { kind: "build", projectId: project.id, name: projectName(project) };
    } else if (task.source === "user" && !ITEM_TASKS.has(task.type)) {
      subject = { kind: "rerun", type: task.type, parameters: { ...task.parameters }, objective: task.objective };
    } else if (task.source === "user") {
      // The owner's original request: ensure_item counts stock toward its
      // quantity, so "proceed" re-asks for the same total, not the gap.
      const item = String(task.parameters.item ?? explanation.need.item).replace(/^minecraft:/, "");
      const quantity = Number(task.parameters.quantity ?? explanation.need.count);
      subject = { kind: "task", item, quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : explanation.need.count };
    } else {
      // Goal and background steps: say the explanation (it replaces the
      // skill's own "Stuck:" line) but offer nothing — their driver picks the
      // next step itself.
      const summary = describeBlocker(explanation);
      if (summary !== this.lastPassive) this.opts.announce(summary);
      this.lastPassive = summary;
      return;
    }
    const summary = describeBlocker(explanation, subject.kind === "build" ? subject.name : undefined);
    const offer = explanation.canFix ? 'Say "go ahead", or "change the plan".' : 'Say "change the plan", or stock it and say "try again".';
    const blocker: OpenBlocker = { id: randomUUID(), subject, explanation, summary, message: `${summary} ${offer}`, openedAt: this.now(), taskId: task.id };
    const key = keyOf(subject);
    const previous = this.open.get(key);
    this.open.set(key, blocker);
    // One chat line per distinct explanation: a retry that stalls the same
    // way refreshes the offer without repeating it.
    if (previous?.summary !== summary) this.opts.announce(blocker.message);
  }

  private close(key: string): void {
    this.open.delete(key);
  }

  /**
   * Carry out the owner's answer to the newest offer. Returns the reply.
   *  - proceed: a build is reopened (its slice re-measures the shortage and
   *    schedules the acquisition); an item task runs again as a full
   *    ensure_item, which may mine, hunt, and smelt; any other owner task
   *    (the shed, a stockpile restore) runs again as it was.
   *  - change_plan: a build is set aside (paused, resumable with "continue
   *    the house") and the owner goal waiting on it is cancelled so the
   *    queue moves on; an item task is simply dropped.
   * `id` answers one specific offer (the viewer's work trail) instead.
   */
  resolve(choice: BlockerChoice, id?: string): string {
    const blocker = id === undefined ? this.latest() : this.byId(id);
    if (blocker === null) return id === undefined ? "Nothing is blocked right now." : "That blocker already cleared.";
    this.close(keyOf(blocker.subject));
    const subject = blocker.subject;
    if (choice === "proceed") {
      if (subject.kind === "build") {
        const task = this.opts.buildProjects?.resumeProject(subject.projectId) ?? null;
        if (task === null) return `There's nothing left to schedule for ${subject.name}.`;
        this.opts.scheduler.claim();
        return `On it: back to ${subject.name}, getting ${gapsLabel(blocker.explanation)} first.`;
      }
      if (subject.kind === "rerun") {
        this.opts.scheduler.enqueue({ type: subject.type, priority: TaskPriority.FOREGROUND, source: "user", objective: subject.objective, parameters: subject.parameters });
        this.opts.scheduler.claim();
        return `On it: getting ${gapsLabel(blocker.explanation)} and trying again.`;
      }
      this.opts.scheduler.enqueue({
        type: "ensure_item",
        priority: TaskPriority.FOREGROUND,
        source: "user",
        objective: `Ensure ${subject.quantity} ${label(subject.item)}.`,
        parameters: { item: subject.item, quantity: subject.quantity },
      });
      this.opts.scheduler.claim();
      return `On it: getting ${gapsLabel(blocker.explanation)} to make ${subject.quantity} ${label(subject.item)}.`;
    }
    if (subject.kind === "build") {
      this.opts.buildProjects?.setAside(subject.projectId, "set aside by the owner");
      const goal = this.opts.goals?.active() ?? null;
      const tracking = goal?.successCriteria.some((c) => c.kind === "building_verified" && c.target === "project" && c.projectId === subject.projectId) === true;
      if (tracking) this.opts.goals?.cancel("plan changed by the owner");
      const next = this.opts.goals?.active() ?? null;
      const then = next === null ? "What should I do instead?" : `Next: ${next.description}`;
      return `OK, ${subject.name} is set aside (say "continue the build" to pick it back up). ${then}`;
    }
    if (subject.kind === "rerun") return "OK, dropping that. What should I do instead?";
    return `OK, dropping the ${subject.quantity} ${label(subject.item)}. What should I do instead?`;
  }
}

function keyOf(subject: BlockerSubject): string {
  if (subject.kind === "build") return `build:${subject.projectId}`;
  return subject.kind === "rerun" ? `rerun:${subject.type}` : `task:${subject.item}`;
}

function gapsLabel(explanation: BlockerExplanation): string {
  if (explanation.missing.length === 0) return `the ${label(explanation.need.item)}`;
  return joinList(explanation.missing.map((gap) => (gap.via === "fuel" ? "fuel" : PLURALS[label(gap.item)] ?? label(gap.item))));
}
