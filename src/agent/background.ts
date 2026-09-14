import type { Bot } from "mineflayer";
import type { Logger } from "pino";
import type { MinecraftConfig } from "../config/schema.js";
import type { EventBus } from "../events/bus.js";
import type { DecisionMaker } from "../llm/decider.js";
import type { NextTaskDecision } from "../llm/schemas.js";
import type { BootstrapRunner } from "../skills/bootstrap-survival.js";
import type { CollectResourceRunner } from "../skills/collect-resource.js";
import { resourceLabel } from "../skills/skill-library.js";
import type { ToolContext } from "../tools/types.js";
import type { StockpileKind, StockpileManager, StockpileSnapshot } from "./maintenance.js";
import type { OrganizeStorageRunner } from "../skills/organize-storage.js";
import type { Scheduler } from "./scheduler.js";
import { TaskPriority, type Task } from "./task.js";
import type { AgentState } from "./state.js";
import { BootstrapStage } from "./bootstrap.js";

/**
 * Phase 7/13: the background coordinator (spec section 4.3). This is
 * CobbleBob's idle loop. Survival floors are deterministic rails — a
 * stockpile below its floor is restored at MAINTENANCE priority, preempting
 * even foreground work, because starvation is not a decision. Above the
 * floors the LLM director chooses the next background task from the
 * dispatcher-capable vocabulary. The deterministic shortage-then-storage
 * ladder runs only when the model is disabled or unreachable, so a dead LLM
 * never stalls the bot. Mechanics always stay code.
 */

/** A one-shot deferred re-check, so the loop continues right after a task settles. */
const RE_CHECK_DELAY_MS = 1_000;

export interface BackgroundManagerOptions {
  bot: Bot;
  state: AgentState;
  config: MinecraftConfig;
  bus: EventBus;
  scheduler: Scheduler;
  maintenance: StockpileManager;
  collect: CollectResourceRunner;
  decider: DecisionMaker;
  bootstrap: BootstrapRunner;
  /** Phase 11: storage organization runner, probed every idle tick. */
  organizeStorage: OrganizeStorageRunner;
  logger: Logger;
  /** Injectable wall clock (tests advance it to exercise the restore cooldown). */
  now?: () => number;
  /**
   * Phase 10 death-loop brake: when true, the bot is respawning into a kill
   * zone and recovery has stood down. The loop may not enqueue any restore
   * or proposal work — the wandering trips (night hunts) are what feed the
   * loop. Set by the session owner from DeathRecoveryManager.inDeathLoop.
   */
  inDeathLoop?: () => boolean;
}

/**
 * Why a stockpile kind is standing down this tick. Logged once per state
 * entry; the loop stays silent while the block holds.
 */
interface RestoreBlock {
  code: "COOLDOWN";
  message: string;
}

export class BackgroundManager {
  private readonly opts: BackgroundManagerOptions;
  private readonly now: () => number;
  private ticking = false;
  private timer: NodeJS.Timeout | null = null;
  private settledListeners: Array<() => void> = [];
  /** Wall clock of the last LLM director call (decision-interval throttle). */
  private lastDecisionAt: number | null = null;

  /** Wall-clock of each kind's most recent failed restore attempt. */
  private readonly lastFailedAt = new Map<string, number>();
  /** Failure reason of the most recent failed restore attempt, per kind. */
  private readonly lastFailReason = new Map<string, string>();
  /** Last block code warn issued per kind; one notice per block state entry. */
  private readonly lastBlockNotice = new Map<StockpileKind, string>();

  constructor(options: BackgroundManagerOptions) {
    this.opts = options;
    this.now = options.now ?? Date.now;
  }

  /**
   * Start the periodic idle loop plus event-driven re-checks. The interval
   * re-measures stockpiles; task/bootstrap events trigger an earlier check
   * so the loop continues as soon as work settles instead of waiting out the
   * whole interval.
   */
  start(): void {
    if (this.timer !== null) return;
    const seconds = this.opts.config.background?.check_interval_seconds ?? 30;
    this.timer = setInterval(() => void this.tick(), Math.max(10, seconds) * 1000);
    this.timer.unref?.();

    const settled = (): void => {
      setTimeout(() => void this.tick(), RE_CHECK_DELAY_MS).unref?.();
    };
    const onFailed = ({ task }: { task: Task }): void => {
      this.recordFailure(task);
      setTimeout(() => void this.tick(), RE_CHECK_DELAY_MS).unref?.();
    };
    // One-shot re-checks, retained so stop() detaches them: a session's
    // manager is rebuilt on reconnect and must not keep firing on a dead bot.
    this.settledListeners = [
      this.opts.bus.on("task.completed", settled),
      this.opts.bus.on("task.failed", onFailed),
      this.opts.bus.on("bootstrap.complete", settled),
    ];
  }

  /** Stop the periodic loop and release its bus listeners (process/session shutdown). */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const unsubscribe of this.settledListeners) unsubscribe();
    this.settledListeners = [];
  }

  /** One idle-loop pass. Re-entrancy-safe: concurrent calls collapse. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.runOnce();
    } catch (err) {
      this.opts.logger.warn({ err: String(err) }, "background tick failed");
    } finally {
      this.ticking = false;
    }
  }

  private async runOnce(): Promise<void> {
    const { bot, bootstrap, scheduler, logger } = this.opts;

    // --- deterministic gates: only act from spawned, post-bootstrap idle. ---
    if (bot.entity === null) return;
    if (bootstrap.completedStage !== BootstrapStage.NORMAL_OPERATION) return;
    if (this.opts.maintenance.isBusy() || this.opts.organizeStorage.isRunning) return;

    // Stale background/idle tasks (e.g. a PAUSED maintenance task rehydrated
    // from a restart, or one interrupted by user work) are regenerated on
    // demand; the plan below is fresh. User tasks are never touched.
    for (const task of [...scheduler.queued]) {
      if (task.source === "background" || task.source === "director") {
        scheduler.cancel(task.id);
      }
    }

    // Phase 10 death-loop brake: the bot is dying at the same kill zone on
    // every respawn. Restoring stockpiles would only send it wandering back
    // into the hazard, so the loop measures nothing and enqueues nothing
    // while the brake holds. The death manager surfaced the loop once; the
    // user relocates the bot or the spawn.
    if (this.opts.inDeathLoop?.() === true) return;

    const snapshot = await this.opts.maintenance.check();

    // Phase 8 (spec 5.4): a stockpile below its survival floor is a crisis —
    // escalate to MAINTENANCE priority and preempt whatever is running, even
    // a foreground user task. Food falls first, so hunger is restored before
    // the interrupted user work resumes.
    const crisis = this.opts.maintenance.crisisDeficit(snapshot);
    if (crisis !== null) {
      // A restore that just failed stands down (see restoreBlock) instead of
      // re-enqueuing on every settled tick — the 1s retry loop that got
      // CobbleBob kicked for chat spam. Actionable crises still preempt
      // immediately.
      if (this.kindBlocked(crisis.kind)) return;
      logger.info(
        { kind: crisis.kind, current: crisis.current, deficit: crisis.deficit },
        "stockpile below survival floor; preempting",
      );
      this.opts.maintenance.runMaintenance(crisis, { preempt: true });
      return; // the task-settled hook re-checks when the run ends.
    }

    // Phase 13: the LLM director decides what to do next. Foreground user
    // work always owns the floor, and a running task is left alone — the
    // task-settled hook re-checks the moment a run ends.
    if (scheduler.active !== null) return;
    if (scheduler.queued.some((task) => task.priority >= TaskPriority.FOREGROUND)) return;

    if (!(this.opts.config.background?.llm_decisions ?? true)) {
      await this.deterministicFallback(snapshot);
      return;
    }

    // At most one decision per interval; within the window the bot stands
    // by, honoring the model's "wait" for the whole interval. The
    // deterministic ladder runs only when the model itself fails.
    const intervalMs = (this.opts.config.background?.llm_decision_interval_seconds ?? 60) * 1000;
    const now = this.now();
    if (this.lastDecisionAt !== null && now - this.lastDecisionAt < intervalMs) return;

    try {
      const decision = await this.opts.decider.decideNextTask(
        { from: "system", instruction: "Choose the next background task." },
        this.toolContext(),
        this.buildSituation(snapshot),
      );
      this.lastDecisionAt = now;
      this.applyDirectedDecision(decision, snapshot);
    } catch (err) {
      // Model down or invalid output: the deterministic ladder keeps the bot
      // working, and the interval is honored before the next attempt.
      logger.warn({ err: String(err) }, "director decision failed; falling back to deterministic ladder");
      this.lastDecisionAt = now;
      await this.deterministicFallback(snapshot);
    }
  }

  /**
   * Record a failed background restore so the per-kind cooldown knows where
   * to start counting. Deterministic bookkeeping keyed by the restore task:
   * `stockpile_maintenance` -> the stockpile kind, `collect_resource` -> the
   * resource. Only background-sourced tasks count; user work that fails is
   * never the loop's to re-run.
   */
  private recordFailure(task: Task): void {
    if (task.source !== "background") return;
    let key: string | null = null;
    if (task.type === "stockpile_maintenance") {
      const kind = String(task.parameters.kind ?? "");
      if (kind !== "") key = kind;
    } else if (task.type === "collect_resource") {
      const resource = String(task.parameters.resource ?? "");
      if (resource !== "") key = `resource:${resource}`;
    }
    if (key === null) return;
    this.lastFailedAt.set(key, this.now());
    this.lastFailReason.set(key, task.lastError ?? "skill failed");
  }

  /**
   * Deterministic "may this kind's restore run now" gate. The single
   * read-only blocker is a restore that failed within the cooldown window.
   * There is deliberately no bot-state block for food: `gather_food`
   * reordered its hunt so a *nearby* animal is killed even at low health
   * (passives cannot fight back; auto-eat turns the meat into regen), and
   * the skill itself reports LOW_HEALTH when nothing is huntable. Re-running
   * after cooldown is how the bot notices the world changed. Nothing here
   * consults the LLM.
   */
  private restoreBlock(kind: StockpileKind): RestoreBlock | null {
    const failedAt = this.lastFailedAt.get(kind);
    if (failedAt === undefined) return null;
    const cooldownMs = (this.opts.config.background?.restore_cooldown_seconds ?? 60) * 1000;
    const remainingMs = failedAt + cooldownMs - this.now();
    if (remainingMs <= 0) return null;
    return {
      code: "COOLDOWN",
      message: `restore failed (${this.lastFailReason.get(kind) ?? "previous restore failed"}); retry in ${Math.ceil(remainingMs / 1000)}s`,
    };
  }

  /**
   * True when the kind must stand down this tick. Logs exactly ONE warn per
   * block state entry, so a 60s cooldown does not spam the log every second
   * — the tick returns silently while the block holds, and stops game chat
   * entirely (the skills throttle their own announcements as a second layer).
   */
  private kindBlocked(kind: StockpileKind): boolean {
    const block = this.restoreBlock(kind);
    if (block === null) return false;
    if (this.lastBlockNotice.get(kind) !== block.code) {
      this.lastBlockNotice.set(kind, block.code);
      this.opts.logger.warn({ kind, block: block.message }, "background restore standing by");
    }
    return true;
  }

  /**
   * Phase 7 door-stop ladder: restore the prioritized shortage, then
   * storage, then stand by. Only used when the LLM director is disabled or
   * the model call failed — the bot keeps working while the LLM is down.
   */
  private async deterministicFallback(snapshot: StockpileSnapshot): Promise<void> {
    const deficit = this.opts.maintenance.prioritize(snapshot);
    if (deficit !== null) {
      // Ordinary restores stay at BACKGROUND priority: they only run when no
      // foreground work owns the floor. Same cooldown gate as the crisis path.
      if (this.kindBlocked(deficit.kind)) return;
      this.opts.logger.info({ kind: deficit.kind, deficit: deficit.deficit }, "stockpile shortage; starting maintenance");
      this.opts.maintenance.runMaintenance(deficit);
      return; // the task-settled hook re-checks when the run ends.
    }

    // Phase 11: home storage is the next background need (spec 22).
    const storageCheck = await this.opts.organizeStorage.needsAttention();
    if (storageCheck.needsWork) {
      this.opts.logger.info({ reason: storageCheck.reason }, "storage needs organization; starting storage pass");
      this.opts.scheduler.enqueue({
        type: "organize_storage",
        priority: TaskPriority.BACKGROUND,
        source: "background",
        objective: "Organize home storage by category, expanding when full.",
        parameters: {},
      });
      this.opts.scheduler.claim();
      return;
    }

    this.opts.logger.info({ levels: snapshot.levels }, "stockpiles healthy; standing by");
  }

  /**
   * The curated situation digest handed to the director (spec 19: concise,
   * high-signal — never raw world dumps): measured stockpiles and shortages,
   * time of day, and every recent failed restore so the model can weigh
   * retries with facts instead of guessing.
   */
  private buildSituation(snapshot: StockpileSnapshot): string {
    const lines: string[] = [];
    if (snapshot.deficits.length === 0) {
      lines.push("Stockpiles: all at or above target.");
    } else {
      const shortages = snapshot.deficits
        .map((d) => `${d.kind} ${d.current}/${d.target} (${d.deficit} short)`)
        .join("; ");
      lines.push(`Stockpiles: ${shortages}.`);
    }
    lines.push(`Time of day: ${this.opts.state.timePhase ?? "unknown"}.`);

    const failures: string[] = [];
    const now = this.now();
    for (const [key, at] of this.lastFailedAt) {
      const ageMin = Math.max(0, Math.round((now - at) / 60_000));
      failures.push(`${key} restore failed (${this.lastFailReason.get(key) ?? "no reason recorded"}) ${ageMin}m ago`);
    }
    if (failures.length > 0) lines.push(`Recent failures: ${failures.join("; ")}.`);

    return lines.join("\n");
  }

  /**
   * Execute one validated director decision: map it onto a scheduler task the
   * TaskDispatcher can run. Deterministic vetoes still apply — a directed
   * stockpile restore for a kind cooling down after a failure (or with no
   * real deficit) is skipped, and the model's "wait" stands for the
   * interval. The chosen task is claimed immediately so it becomes ACTIVE
   * and the dispatcher runs it.
   */
  private applyDirectedDecision(decision: NextTaskDecision, snapshot: StockpileSnapshot): void {
    const { scheduler, maintenance, bus, logger } = this.opts;
    const task = decision.task;
    bus.emit("director.decided", { task: task.type, rationale: decision.rationale ?? null });

    switch (task.type) {
      case "wait":
        logger.info({}, "director standing by");
        return;
      case "collect_resource": {
        const quantity = task.quantity;
        scheduler.enqueue({
          type: "collect_resource",
          priority: TaskPriority.BACKGROUND,
          source: "director",
          objective: `Gather ${quantity} ${resourceLabel(task.resource)}.`,
          parameters: { resource: task.resource, quantity },
        });
        scheduler.claim();
        return;
      }
      case "stockpile_maintenance": {
        const deficit = snapshot.deficits.find((d) => d.kind === task.kind);
        if (deficit === undefined) {
          logger.info({ kind: task.kind }, "directed maintenance for a full stockpile; skipping");
          return;
        }
        // kindBlocked logs the standing-by notice itself.
        if (this.kindBlocked(task.kind)) return;
        maintenance.runMaintenance(deficit);
        return;
      }
      case "organize_storage":
        scheduler.enqueue({
          type: "organize_storage",
          priority: TaskPriority.BACKGROUND,
          source: "director",
          objective: "Organize home storage by category, expanding when full.",
          parameters: {},
        });
        scheduler.claim();
        return;
      case "go_home":
        scheduler.enqueue({
          type: "go_home",
          priority: TaskPriority.BACKGROUND,
          source: "director",
          objective: "Return home.",
          parameters: {},
        });
        scheduler.claim();
        return;
    }
  }

  /** The same deterministic environment the chat tools act on. */
  private toolContext(): ToolContext {
    return {
      bot: this.opts.bot,
      state: this.opts.state,
      config: this.opts.config,
      bus: this.opts.bus,
      scheduler: this.opts.scheduler,
      bootstrap: this.opts.bootstrap,
    };
  }
}