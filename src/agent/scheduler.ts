import { randomUUID } from "node:crypto";
import { logger } from "../logger.js";
import type { EventBus } from "../events/bus.js";
import type { TasksRepository } from "../memory/tasks.js";
import { ActionWatchdog, actionFingerprint, type BlockView } from "./watchdog.js";
import { TaskStatus, type NewTask, type Task } from "./task.js";
import { WorldActionExecutor, type WorldActionLease } from "./world-actions.js";

export interface SchedulerOptions {
  bus: EventBus;
  tasks: TasksRepository;
  /**
   * Anti-loop watchdog (generic, above every skill). When present, a task
   * whose action fingerprint is blocked stands down into TaskStatus.BLOCKED
   * instead of running, until the block's cooldown expires.
   */
  watchdog?: ActionWatchdog;
}

/** Why the active task is being asked to stop (Phase 8, spec 6). */
export type InterruptReason = "pause" | "cancel";

/**
 * Cooperative run signals handed to the skill executing the active task
 * (Phase 8, spec 5.4). The executor calls `checkpoint` between work steps;
 * while no interrupt is pending it returns true and persists `state` as the
 * task's resume state (crash-safe progress). After a preemption or interrupt
 * was requested it returns false, and the persisted state is what a later
 * resume re-plans from.
 */
export interface TaskSignals {
  checkpoint(state?: object): boolean;
  /** Native cancellation signal for Mineflayer/plugin adapters. */
  readonly signal: AbortSignal;
  readonly cancelled: boolean;
}

/**
 * Task scheduler (spec section 5, Phase 8).
 *
 * Lifecycle + persistence: enqueue -> active -> complete/fail/cancel, with
 * every transition written to SQLite so unfinished tasks survive a restart.
 *
 * Arbitration (Phase 8): `claim()` is the single entry point for wanting a
 * queued task to run. It activates the highest-priority candidate when the
 * slot is free, and when the candidate outranks the active task it requests
 * a cooperative **pause** — the running skill observes it at its next
 * checkpoint and the executor settles via `settleInterrupted()`, which
 * pauses the old task (resume state intact) and activates the next one.
 * Hard interrupts (`stop`, `cancel that`) set a "cancel" request instead;
 * the same settle path cancels the task outright.
 *
 * Resume ordering: at equal priority a fresh QUEUED task beats paused work
 * (the latest user instruction wins), and paused tasks resume most-recently-
 * paused-first (Phase 8 acceptance: iron resumes before wood).
 */
export class Scheduler {
  private readonly bus: EventBus;
  private readonly tasks: TasksRepository;
  private readonly watchdog: ActionWatchdog | undefined;
  private readonly worldExecutor = new WorldActionExecutor();

  private readonly queue: Task[] = [];
  private activeTask: Task | null = null;

  /** Interrupt that the active task's executor must settle once its run returns. */
  private interrupt: InterruptReason | null = null;
  private activeController: AbortController | null = null;

  /** Stable birth order of every live task (newest first among ties). */
  private seq = 0;
  private readonly order = new Map<string, number>();

  /** Sequence number of the last paused task (most-recently-paused resumes first). */
  private pausedSeq = 0;
  private readonly pausedAt = new Map<string, number>();

  constructor(options: SchedulerOptions) {
    this.bus = options.bus;
    this.tasks = options.tasks;
    this.watchdog = options.watchdog;
  }

  /** Rehydrate live tasks from the database. Call once at startup. */
  loadFromPersistence(): void {
    for (const task of this.tasks.loadUnfinished()) {
      if (!Object.values(TaskStatus).includes(task.status)) {
        task.status = TaskStatus.FAILED;
        task.lastError = "quarantined malformed persisted task status";
        task.completedAt = new Date().toISOString();
        this.tasks.update(task);
        logger.error({ taskId: task.id }, "malformed persisted task quarantined");
        continue;
      }
      if (task.status === TaskStatus.ACTIVE) {
        // Crash recovery must retain one and only one owner. Any additional
        // ACTIVE row is parked for explicit resumption instead of being
        // silently orphaned by overwriting the active reference.
        if (this.activeTask === null) this.activeTask = task;
        else {
          task.status = TaskStatus.PAUSED;
          task.lastError = "duplicate active task quarantined during restart";
          this.tasks.update(task);
          this.queue.push(task);
          logger.error({ taskId: task.id, activeTaskId: this.activeTask.id }, "duplicate active task quarantined");
        }
      } else {
        this.queue.push(task);
        if (task.status === TaskStatus.PAUSED) {
          // Pause order is persisted, so restart preserves LIFO resumption.
          // Legacy rows without a sequence fall back to deterministic load
          // order and receive a sequence for future transitions.
          const sequence = task.pauseSequence ?? ++this.pausedSeq;
          this.pausedSeq = Math.max(this.pausedSeq, sequence);
          this.pausedAt.set(task.id, sequence);
        } else {
          this.order.set(task.id, ++this.seq);
        }
      }
    }
    logger.info(
      { queued: this.queue.length, active: this.activeTask?.id ?? null },
      "scheduler rehydrated from persistence",
    );
  }

  get queued(): readonly Task[] {
    return this.queue;
  }

  get active(): Task | null {
    return this.activeTask;
  }

  get worldActionOwner(): string | null { return this.worldExecutor.activeOwner; }

  runWorldAction<T>(owner: string, signal: AbortSignal, action: (lease: WorldActionLease) => Promise<T>): Promise<T> {
    return this.worldExecutor.run(owner, signal, action);
  }

  assertWorldActionAvailable(): void { this.worldExecutor.assertAvailable(); }

  /** True while the active task has been asked to stop but not yet settled. */
  get interruptPending(): boolean {
    return this.interrupt !== null;
  }

  /** The pending interrupt's reason ("pause" / "cancel"), or null when idle. */
  get pendingInterruptReason(): InterruptReason | null {
    return this.interrupt;
  }

  /** Create and persist a new queued task. */
  enqueue(input: NewTask): Task {
    const workKey = input.workKey ?? (input.source === "background" || input.source === "director" || input.source === "maintenance" || input.source === "goal"
      ? `${input.source}:${input.source === "goal" ? String(input.parameters?.goalId ?? "") + ":" : ""}${actionFingerprint(input.type, input.parameters ?? {})}` : undefined);
    if (workKey !== undefined) {
      const existing = this.queue.find((task) => task.workKey === workKey && task.status !== TaskStatus.COMPLETED && task.status !== TaskStatus.FAILED && task.status !== TaskStatus.CANCELLED)
        ?? (this.activeTask?.workKey === workKey ? this.activeTask : null)
        ?? this.tasks.findLiveByWorkKey(workKey);
      if (existing !== null) return existing;
    }
    const task: Task = {
      ...input,
      id: randomUUID(),
      status: TaskStatus.QUEUED,
      createdAt: new Date().toISOString(),
      parameters: input.parameters ?? {},
      workKey,
      attempts: 0,
      lastProgressAt: new Date().toISOString(),
    };
    this.order.set(task.id, ++this.seq);
    this.tasks.create(task);
    this.queue.push(task);
    this.bus.emit("task.created", { task });
    logger.info({ taskId: task.id, type: task.type, priority: task.priority }, "task enqueued");
    return task;
  }

  /**
   * Phase 8 arbitration entry point: make the best queued/paused candidate
   * run. When a higher-priority (or newer same-priority user) task arrives
   * while another is active, the active task is asked to pause; it activates
   * the candidate only after the current run settles (`settleInterrupted`).
   * Returns the activated task, or null when the task must wait.
   */
  claim(): Task | null {
    for (;;) {
      const candidate = this.nextCandidate();
      if (!candidate) return null;
      const active = this.activeTask;
      if (active === null) {
        // Slot free: activate unless the anti-loop watchdog stands the
        // action down — then consider the next candidate, so one blocked
        // task never starves the queue behind it.
        const activated = this.activate(candidate.id);
        if (activated !== null) return activated;
        continue;
      }
      if (this.outranks(candidate, active)) {
        this.requestPause();
      }
      return null;
    }
  }

  /** True when `candidate` may displace the active task. */
  private outranks(candidate: Task, active: Task): boolean {
    if (candidate.priority > active.priority) return true;
    if (candidate.priority === active.priority && candidate.source === "user" && active.source === "user") {
      // The latest user instruction wins over paused/queued user work at the
      // same priority (Phase 8 acceptance: "get iron" pauses "gather wood").
      const candidateOrder = this.order.get(candidate.id) ?? Number.NEGATIVE_INFINITY;
      const activeOrder = this.order.get(active.id) ?? Number.NEGATIVE_INFINITY;
      if (candidateOrder > activeOrder) return true;
      return candidate.createdAt > active.createdAt;
    }
    return false;
  }

  /** Activate the highest-priority candidate if the slot is free (cascade/boot). */
  activateNext(): Task | null {
    return this.claimNext(null);
  }

  /** Like activateNext, but never re-activates `excludedId` (used by settleInterrupted). */
  private claimNext(excludedId: string | null): Task | null {
    if (this.activeTask) return this.activeTask;
    const candidate = this.nextCandidate(excludedId);
    if (!candidate) return null;
    return this.activate(candidate.id);
  }

  /** Move a queued task into ACTIVE state, emitting `task.activated`. */
  activate(id: string): Task | null {
    const task = this.findQueued(id);
    if (!task) return null;
    // Anti-loop gate: a blocked action stands down into BLOCKED status
    // instead of running. Owner commands bypass the gate — an explicit
    // request always executes, and the watchdog reset its failure state
    // when the owner's run settled.
    const block = this.blockFor(task);
    if (block !== null) {
      task.status = TaskStatus.BLOCKED;
      task.lastError = block.reason;
      this.tasks.update(task);
      this.bus.emit("task.blocked", { task });
      logger.warn(
        { taskId: task.id, type: task.type, action: block.action },
        "task held by anti-loop watchdog",
      );
      return null;
    }
    this.removeQueued(task);
    this.activeTask = task;
    this.activeController = new AbortController();
    task.status = TaskStatus.ACTIVE;
    task.startedAt = new Date().toISOString();
    task.attempts = (task.attempts ?? 0) + 1;
    task.lastProgressAt = new Date().toISOString();
    this.tasks.update(task);
    this.bus.emit("task.activated", { task });
    logger.info({ taskId: task.id, type: task.type }, "task activated");
    return task;
  }

  /**
   * Ask the active task's executor to stop and keep the task resumable.
   * The run observes it at its next checkpoint; `settleInterrupted` performs
   * the PAUSED transition. No-op when nothing is active.
   */
  requestPause(): void {
    if (this.activeTask === null) return;
    if (this.interrupt === null) this.interrupt = "pause";
    this.activeController?.abort(new Error("task paused"));
    logger.info({ taskId: this.activeTask.id }, "pause requested for active task");
  }

  /**
   * Ask the active task's executor to stop and cancel the task outright
   * (hard interrupt: "stop", "cancel that"). Overrides a pending pause.
   */
  requestCancel(): void {
    if (this.activeTask === null) return;
    this.interrupt = "cancel";
    this.activeController?.abort(new Error("task cancelled"));
    logger.info({ taskId: this.activeTask.id }, "cancel requested for active task");
  }

  /**
   * Signals for the skill currently executing `task`. Stale-safe: if the
   * scheduler has already moved on to another task the checkpoint is a no-op
   * returning true, so an overrunning run can never corrupt the new task.
   */
  signalsFor(task: Task): TaskSignals {
    return {
      checkpoint: (state): boolean => {
        if (this.activeTask !== task) return false;
        task.lastProgressAt = new Date().toISOString();
        if (state && typeof state === "object") {
          const record = state as Record<string, unknown>;
          task.phase = typeof record.phase === "string" ? record.phase : task.phase;
          task.progressFingerprint = JSON.stringify(state);
        }
        this.checkpoint(state);
        return this.interrupt === null;
      },
      signal: this.activeController?.signal ?? AbortSignal.abort(),
      get cancelled() { return this.signal.aborted; },
    };
  }

  /**
   * Core checkpoint: persist the run's progress as the task's resume state
   * and report whether the run must stop. Persists unconditionally so a
   * crash mid-run resumes with real progress.
   */
  checkpoint(state?: object): boolean {
    const task = this.activeTask;
    if (task !== null && state !== undefined) {
      task.resumeState = state;
      this.tasks.update(task);
    }
    return this.interrupt === null;
  }

  /**
   * The executor calls this after its run returned (or threw) with an
   * interrupt pending: settle the active task per the requested reason, then
   * claim the next task. Returns the newly activated task, if any.
   */
  settleInterrupted(): Task | null {
    const task = this.activeTask;
    const reason = this.interrupt;
    this.interrupt = null;
    if (task === null) return null;

    if (reason === "cancel") {
      this.activeTask = null;
      this.activeController = null;
      task.status = TaskStatus.CANCELLED;
      task.completedAt = new Date().toISOString();
      this.tasks.update(task);
      this.bus.emit("task.cancelled", { task });
      logger.info({ taskId: task.id }, "task cancelled by interrupt");
      return this.activateNext();
    } else {
      this.activeTask = null;
      this.activeController = null;
      task.status = TaskStatus.PAUSED;
      task.pauseSequence = ++this.pausedSeq;
      this.pausedAt.set(task.id, task.pauseSequence);
      this.queue.push(task);
      this.tasks.update(task);
      this.bus.emit("task.paused", { task });
      logger.info({ taskId: task.id }, "task paused by preemption");
      // Never reactivate the task that was just paused: a pause settles with
      // the task parked until a later claim resumes it.
      return this.claimNext(task.id);
    }
  }

  /** Mark the active task complete, then claim the next task. */
  completeActive(): Task | null {
    const task = this.activeTask;
    if (!task) return null;
    this.activeTask = null;
    this.activeController?.abort(new Error("task completed"));
    this.activeController = null;
    task.status = TaskStatus.COMPLETED;
    task.completedAt = new Date().toISOString();
    this.tasks.update(task);
    this.bus.emit("task.completed", { task });
    logger.info({ taskId: task.id }, "task completed");
    return this.activateNext();
  }

  /** Mark the active task failed with a reason, then claim the next task. */
  failActive(lastError: string): Task | null {
    const task = this.activeTask;
    if (!task) return null;
    this.activeTask = null;
    this.activeController?.abort(new Error("task failed"));
    this.activeController = null;
    task.status = TaskStatus.FAILED;
    task.lastError = lastError;
    task.completedAt = new Date().toISOString();
    this.tasks.update(task);
    this.bus.emit("task.failed", { task });
    logger.warn({ taskId: task.id, lastError }, "task failed");
    return this.activateNext();
  }

  /** Cancel a queued task immediately, or request cooperative cancellation of an active run. */
  cancel(id: string): Task | null {
    const task = this.findQueued(id) ?? (this.activeTask?.id === id ? this.activeTask : null);
    if (!task) return null;
    if (this.activeTask === task) {
      this.requestCancel();
      return task;
    }
    this.removeQueued(task);
    task.status = TaskStatus.CANCELLED;
    task.completedAt = new Date().toISOString();
    this.tasks.update(task);
    this.bus.emit("task.cancelled", { task });
    logger.info({ taskId: task.id }, "task cancelled");
    return task;
  }

  /** Requeue blocked tasks whose watchdog cooldown has expired, even when idle. */
  maintainExpiredBlocks(): number {
    const before = this.queue.filter((task) => task.status === TaskStatus.QUEUED).length;
    this.requeueExpiredBlocks();
    return this.queue.filter((task) => task.status === TaskStatus.QUEUED).length - before;
  }

  /**
   * The best candidate to activate next. Order: highest priority first; at a
   * tie, fresh QUEUED work before PAUSED work (latest instruction wins, and
   * a resumed task must not preempt freshly-requested equal-priority work);
   * among QUEUED the *newest* first; among PAUSED the most recently paused
   * first (Phase 8 acceptance: iron resumes before wood).
   */
  private nextCandidate(excludedId: string | null = null): Task | null {
    this.requeueExpiredBlocks();
    let best: Task | null = null;
    for (const task of this.queue) {
      if (task.id === excludedId) continue;
      if (task.status !== TaskStatus.QUEUED && task.status !== TaskStatus.PAUSED) continue;
      if (best === null || this.candidateKey(task) > this.candidateKey(best)) best = task;
    }
    return best;
  }

  /**
   * Requeue BLOCKED tasks whose anti-loop cooldown has expired: an expired
   * block allows exactly one fresh attempt (the gate re-blocks it if that
   * attempt fails again). Runs lazily inside candidate selection, so no
   * timer is needed and a retry is never scheduled before its time.
   */
  private requeueExpiredBlocks(): void {
    if (this.watchdog === undefined) return;
    for (const task of this.queue) {
      if (task.status !== TaskStatus.BLOCKED) continue;
      if (this.watchdog.blockFor(actionFingerprint(task.type, task.parameters)) !== null) continue;
      task.status = TaskStatus.QUEUED;
      this.tasks.update(task);
      logger.info({ taskId: task.id }, "anti-loop block expired; task requeued");
    }
  }

  /** The active watchdog block for a task, or null when it may run. */
  private blockFor(task: Task): { action: string; reason: string } | null {
    if (this.watchdog === undefined) return null;
    if (task.source === "user") return null;
    const fingerprint = actionFingerprint(task.type, task.parameters);
    const block = this.watchdog.blockFor(fingerprint);
    if (block === null) return null;
    const reason = block.lastReason === "" ? "previous attempts failed" : block.lastReason;
    return { action: fingerprint, reason: `${block.failures} failed attempts: ${reason}` };
  }

  /**
   * Every active anti-loop block, formatted for the LLM context (chat state
   * snapshot and the background director's situation digest). Empty when the
   * watchdog is not wired or nothing is blocked right now.
   */
  blockedActions(): readonly BlockView[] {
    return this.watchdog?.activeBlocks() ?? [];
  }

  private candidateKey(task: Task): number {
    const queueBeforePaused = task.status === TaskStatus.QUEUED ? 1 : 0;
    const order =
      task.status === TaskStatus.PAUSED
        ? (this.pausedAt.get(task.id) ?? 0)
        : (this.order.get(task.id) ?? 0);
    return task.priority * 1_000_000 + queueBeforePaused * 100_000 + order;
  }

  private findQueued(id: string): Task | null {
    return this.queue.find((task) => task.id === id) ?? null;
  }

  private removeQueued(task: Task): void {
    const index = this.queue.indexOf(task);
    if (index >= 0) this.queue.splice(index, 1);
  }
}
