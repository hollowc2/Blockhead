import { randomUUID } from "node:crypto";
import type { EventBus } from "../events/bus.js";
import type { GoalsRepository } from "../memory/goals.js";
import type { Scheduler } from "./scheduler.js";
import type { Task } from "./task.js";
import { GoalStatus, type Goal, type GoalResult, type NewGoal } from "./goal.js";
import { logger } from "../logger.js";

/**
 * How many settled goal-task outcomes are kept in `recentResults` before
 * older ones drop (the LLM only needs the last few steps).
 */
const MAX_RECENT_RESULTS = 6;

export interface GoalManagerOptions {
  bus: EventBus;
  goals: GoalsRepository;
  /**
   * Task scheduler. When a goal is replaced, the manager cancels every
   * `source: "goal"` task tagged with the superseded goal's id (an active
   * run cooperatively, queued/paused/blocked steps outright) so no step
   * keeps executing work for an objective the owner already moved on from.
   */
  scheduler: Scheduler;
}

/**
 * Goal coordinator — process-lifetime and bus-driven (no bot), exactly like
 * the death-recovery manager, so the same instance answers owner commands,
 * task events, and the background driver across reconnect attempts.
 *
 * The GoalManager owns the *state machine*: one active goal, transitions to
 * completed/blocked/cancelled, the per-action result log, and the owner's
 * FIFO of queued goals ("finish the house, then gather iron, then stock the
 * chest"). When the active goal settles for any reason, the next queued goal
 * is promoted to active in the same call, so the background driver never
 * sees a gap it could fill with a canned background goal. It never runs a
 * skill itself — the background driver picks actions and the TaskDispatcher
 * executes them as `source: "goal"` tasks; the manager listens for those
 * tasks settling and records the outcome against the goal.
 *
 * Terminal transitions:
 *  - completed  — success criteria evaluated as met by the driver, or the
 *                 LLM chose "complete".
 *  - blocked    — a goal-level failure makes the goal unable to proceed.
 *                 Temporary watchdog blocks are recorded as retryable waits.
 *  - cancelled  — the owner stopped it (hard interrupt / cancel_goal), a new
 *                 goal superseded it, or the LLM chose "abandon".
 *
 * Every terminal transition advances the queue; only an owner "stop"
 * (`cancelAll`) or a replacing `start` clears it.
 */
export class GoalManager {
  private readonly opts: GoalManagerOptions;
  private goal: Goal | null = null;
  private readonly pending: Goal[] = [];
  private readonly unsubscribers: Array<() => void> = [];

  constructor(options: GoalManagerOptions) {
    this.opts = options;
    this.goal = options.goals.getActive();
    if (this.goal !== null) {
      logger.info({ goalId: this.goal.id, description: this.goal.description }, "goal rehydrated");
    }
    this.pending.push(...options.goals.listQueued());
    if (this.pending.length > 0) logger.info({ queued: this.pending.length }, "goal queue rehydrated");
    // A crash between settling a goal and promoting its successor leaves
    // queued rows with no active one; resume the queue rather than strand it.
    if (this.goal === null) this.promoteNext();
    this.subscribe();
  }

  /** Detach from the bus (process shutdown / rebuild). */
  dispose(): void {
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers.length = 0;
  }

  /** The single live goal, or null when none is active. */
  active(): Goal | null {
    return this.goal;
  }

  /** Goals waiting behind the active one, in the order they will run. */
  queued(): readonly Goal[] {
    return this.pending;
  }

  /**
   * Establish a goal now. A new goal replaces (cancels) the current active
   * goal and discards the queue behind it: a fresh instruction is a fresh
   * plan. Use `enqueue` to add to the plan instead.
   */
  start(input: NewGoal): Goal {
    this.clearQueue("replaced by a new goal");
    if (this.goal !== null) {
      const superseded = this.transition(GoalStatus.CANCELLED, "superseded by a new goal");
      // The owner moved the bot on to a new objective: nothing may keep
      // executing the old goal — cooperatively stop its active run and cancel
      // its queued/paused/blocked steps (scheduler.cancel does both forms).
      if (superseded !== null) this.cancelGoalTasks(superseded);
    }
    const goal = this.newGoal(input, GoalStatus.ACTIVE);
    this.goal = goal;
    this.opts.goals.create(goal);
    this.opts.bus.emit("goal.started", { goal });
    logger.info({ goalId: goal.id, source: goal.source, description: goal.description }, "goal started");
    return goal;
  }

  /**
   * Add a goal to the end of the plan. It starts immediately when nothing is
   * active; otherwise it waits (persisted as QUEUED, so it survives a
   * restart) until every goal ahead of it settles. An owner goal never waits
   * behind a self-chosen background goal — that one is dropped, since the
   * owner's plan outranks the bot's own initiative.
   */
  enqueue(input: NewGoal): Goal {
    if (this.goal !== null && this.goal.source === "background" && input.source === "owner") {
      const superseded = this.goal;
      this.goal = null;
      this.settle(superseded, GoalStatus.CANCELLED, "superseded by the owner's goal");
      this.cancelGoalTasks(superseded);
    }
    if (this.goal === null && this.pending.length === 0) return this.start(input);
    const goal = this.newGoal(input, GoalStatus.QUEUED);
    this.pending.push(goal);
    this.opts.goals.create(goal);
    logger.info({ goalId: goal.id, position: this.pending.length, description: goal.description }, "goal queued");
    if (this.goal === null) this.promoteNext();
    return goal;
  }

  /**
   * Owner "stop": cancel the active goal and everything queued behind it.
   * Returns the cancelled active goal, or null when none was active.
   */
  cancelAll(reason: string): Goal | null {
    this.clearQueue(reason);
    return this.cancel(reason);
  }

  private newGoal(input: NewGoal, status: GoalStatus.ACTIVE | GoalStatus.QUEUED): Goal {
    return {
      ...input,
      id: randomUUID(),
      status,
      createdAt: new Date().toISOString(),
      currentStep: input.currentStep ?? null,
      recentResults: [],
    };
  }

  /** Cancel every queued goal (persisted) without touching the active one. */
  private clearQueue(reason: string): void {
    for (const goal of this.pending.splice(0)) {
      goal.status = GoalStatus.CANCELLED;
      goal.note = reason;
      goal.endedAt = new Date().toISOString();
      this.opts.goals.update(goal);
      logger.info({ goalId: goal.id, reason }, "queued goal dropped");
    }
  }

  /**
   * Activate the next queued goal. Its `createdAt` is reset to the moment it
   * becomes active: the driver measures deaths "during the goal" from
   * `createdAt`, and time spent waiting in the queue is not time working on it.
   */
  private promoteNext(): void {
    const next = this.pending.shift();
    if (next === undefined) return;
    next.status = GoalStatus.ACTIVE;
    next.createdAt = new Date().toISOString();
    this.goal = next;
    this.opts.goals.update(next);
    this.opts.bus.emit("goal.started", { goal: next });
    logger.info({ goalId: next.id, source: next.source, description: next.description, remaining: this.pending.length }, "queued goal started");
  }

  /** Mark the active goal completed (persisted; no-op when none is active). */
  complete(note?: string): Goal | null {
    return this.transition(GoalStatus.COMPLETED, note ?? "goal achieved");
  }

  /** Mark the active goal blocked — it cannot make progress (persisted). */
  block(reason: string): Goal | null {
    return this.transition(GoalStatus.BLOCKED, reason);
  }

  /**
   * Cancel the active goal (owner stop / abandonment) and stop its steps, so
   * the next queued goal does not start under a step still working for the
   * cancelled one.
   */
  cancel(reason?: string): Goal | null {
    const cancelled = this.transition(GoalStatus.CANCELLED, reason ?? "cancelled");
    if (cancelled !== null) this.cancelGoalTasks(cancelled);
    return cancelled;
  }

  /** Label the high-level action currently being executed for the goal. */
  setCurrentStep(step: string): void {
    const goal = this.goal;
    if (goal === null) return;
    goal.currentStep = step;
    this.opts.goals.update(goal);
  }

  /** Record the LLM "wait" hold (no action ran; the goal stands by). */
  recordStandingBy(action: string): void {
    const goal = this.goal;
    if (goal === null) return;
    const results: GoalResult[] = [
      ...goal.recentResults,
      { action, outcome: "standing_by", at: new Date().toISOString() },
    ];
    goal.recentResults = results.slice(-MAX_RECENT_RESULTS);
    this.opts.goals.update(goal);
  }

  /** Move the active goal to a terminal status, persisting the transition. */
  private transition(status: GoalStatus.COMPLETED | GoalStatus.BLOCKED | GoalStatus.CANCELLED, note: string): Goal | null {
    const goal = this.goal;
    if (goal === null) return null;
    this.goal = null;
    this.settle(goal, status, note);
    // The plan moves on: whatever ended this goal, the next queued one starts.
    this.promoteNext();
    return goal;
  }

  private settle(goal: Goal, status: GoalStatus.COMPLETED | GoalStatus.BLOCKED | GoalStatus.CANCELLED, note: string): void {
    goal.status = status;
    goal.note = note;
    goal.endedAt = new Date().toISOString();
    this.opts.goals.update(goal);
    this.opts.bus.emit(`goal.${status}`, { goal });
    logger.info({ goalId: goal.id, status, note }, "goal settled");
  }

  /**
   * Cancel every scheduler task that belongs to a goal. Cooperative by design
   * (`Scheduler.cancel`): an active run is asked to stop and its executor
   * settles the cancellation once the skill checks in at its next checkpoint;
   * queued, paused, and watchdog-blocked steps are cancelled immediately. Only
   * `source: "goal"` tasks tagged with the goal's id are touched, so a
   * superseded goal never stops unrelated user, maintenance, or rescue work.
   * Iterates a snapshot of the queue because cancelling splices it.
   */
  private cancelGoalTasks(goal: Goal): void {
    const scheduler = this.opts.scheduler;
    const active = scheduler.active;
    if (active !== null && active.source === "goal" && active.parameters.goalId === goal.id) {
      scheduler.cancel(active.id);
    }
    for (const task of [...scheduler.queued]) {
      if (task.source === "goal" && task.parameters.goalId === goal.id) {
        scheduler.cancel(task.id);
      }
    }
  }

  /**
   * Record the outcome of one goal task against the live goal. Only tasks
   * this goal actually enqueued (source "goal" with a matching goalId) count;
   * an unrelated settled task never touches the goal.
   */
  private recordResult(task: Task, outcome: GoalResult["outcome"], message?: string): void {
    const goal = this.goal;
    if (goal === null) return;
    if (task.source !== "goal" || task.parameters.goalId !== goal.id) return;
    const results: GoalResult[] = [
      ...goal.recentResults,
      { action: task.type, outcome, message, at: new Date().toISOString() },
    ];
    goal.recentResults = results.slice(-MAX_RECENT_RESULTS);
    this.opts.goals.update(goal);
  }

  private subscribe(): void {
    const bus = this.opts.bus;
    this.unsubscribers.push(
      bus.on("task.completed", ({ task }) =>
        this.recordResult(task, "completed", task.objective),
      ),
      bus.on("task.failed", ({ task }) =>
        this.recordResult(task, "failed", task.lastError ?? "skill failed"),
      ),
      bus.on("task.blocked", ({ task }) => {
        if (task.source !== "goal" || this.goal === null || task.parameters.goalId !== this.goal.id) return;
        // Watchdog blocks are temporary action-level cooldowns. Keep the goal
        // active so the background driver can re-plan after the scheduler
        // requeues the task; only goal-level failures should be terminal.
        this.recordResult(task, "blocked", task.lastError ?? "action blocked; waiting for retry");
      }),
      bus.on("task.cancelled", ({ task }) =>
        this.recordResult(task, "cancelled", "interrupted"),
      ),
    );
  }
}