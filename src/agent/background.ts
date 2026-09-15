import type { Bot } from "mineflayer";
import type { Logger } from "pino";
import type { MinecraftConfig } from "../config/schema.js";
import type { EventBus } from "../events/bus.js";
import type { DecisionMaker } from "../llm/decider.js";
import type { NextGoalActionDecision, NextTaskDecision } from "../llm/schemas.js";
import type { BootstrapRunner } from "../skills/bootstrap-survival.js";
import type { CollectResourceRunner } from "../skills/collect-resource.js";
import { resourceLabel } from "../skills/skill-library.js";
import type { ToolContext } from "../tools/types.js";
import { STOCKPILE_PRIORITY_ORDER, type StockpileManager, type StockpileSnapshot } from "./maintenance.js";
import type { OrganizeStorageRunner } from "../skills/organize-storage.js";
import type { BaseBuilderRunner } from "../skills/base.js";
import type { Scheduler } from "./scheduler.js";
import { TaskPriority, type Task } from "./task.js";
import type { AgentState } from "./state.js";
import { BootstrapStage } from "./bootstrap.js";
import type { GoalManager } from "./goals.js";
import { criterionLabel, evaluateSuccessCriteria, type Goal, type SuccessCriterion } from "./goal.js";
import type { StorageRepository } from "../memory/storage.js";
import type { TasksRepository } from "../memory/tasks.js";
import { findHomeChest } from "../minecraft/containers.js";
import { bareName } from "../minecraft/inventory.js";

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

/**
 * Event-driven re-evaluation delay: a settle event schedules one deferred
 * pass so the loop continues right after a task settles — and the delay is
 * the anti-thrash pace between a task ending and the next LLM decision, so
 * repeated settles never spin decisions faster than once per second.
 */
const RE_CHECK_DELAY_MS = 1_000;

/** Horizontal standoff from home at which the bot counts as "home". */
const AUTO_SLEEP_HOME_RADIUS = 12;

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
  /** Central stockpile base: the structure builder, probed every idle tick. */
  buildBase: BaseBuilderRunner;
  /** Home storage registration; the idle loop re-establishes a missing home chest. */
  storage: StorageRepository;
  /** Task store feeding the director's compact recent-outcome digest. */
  tasks: TasksRepository;
  /**
   * Goal coordinator (optional: the goal layer is a bolt-on — harnesses and
   * configs without one run the director exactly as before).
   */
  goals?: GoalManager;
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
  /** One pending event-driven re-evaluation (coalesced: burst events collapse). */
  private kickTimer: NodeJS.Timeout | null = null;
  /** A kick that arrived while a pass was in flight; re-run once after it finishes. */
  private recheckPending = false;
  /** Wall-clock of the last LLM director call (decision-interval throttle). */
  private lastDecisionAt: number | null = null;

  /** Wall-clock of the last home-chest restore attempt (repair cooldown). */
  private lastHomeChestRepairAt: number | null = null;

  /** Wall-clock of the last background goal establishment (re-arm cooldown). */
  private lastBackgroundGoalAt: number | null = null;

  /** Wall-clock of each kind's most recent failed restore attempt. */
  private readonly lastFailedAt = new Map<string, number>();
  /** Failure reason of the most recent failed restore attempt, per kind. */
  private readonly lastFailReason = new Map<string, string>();
  /** Last block code warn issued per key; one notice per block state entry. */
  private readonly lastBlockNotice = new Map<string, string>();

  constructor(options: BackgroundManagerOptions) {
    this.opts = options;
    this.now = options.now ?? Date.now;
  }

  /**
   * Start the periodic idle loop plus event-driven re-checks. The interval
   * re-measures stockpiles; settle events (task completed/failed/cancelled,
   * bootstrap complete) schedule a director kick so a fresh high-level LLM
   * decision happens shortly after work settles — for an idle/wait state
   * the periodic interval remains the fallback.
   */
  start(): void {
    if (this.timer !== null) return;
    const seconds = this.opts.config.background?.check_interval_seconds ?? 30;
    this.timer = setInterval(() => void this.tick(), Math.max(10, seconds) * 1000);
    this.timer.unref?.();

    const onSettled = (): void => this.scheduleKick();
    const onFailed = ({ task }: { task: Task }): void => {
      this.recordFailure(task);
      this.scheduleKick();
    };
    // One-shot re-checks, retained so stop() detaches them: a session's
    // manager is rebuilt on reconnect and must not keep firing on a dead bot.
    // A goal settling (started/completed/blocked/cancelled) and a watchdog-
    // blocked task both need a fresh pass too.
    this.settledListeners = [
      this.opts.bus.on("task.completed", onSettled),
      this.opts.bus.on("task.failed", onFailed),
      this.opts.bus.on("task.cancelled", onSettled),
      this.opts.bus.on("task.blocked", onSettled),
      this.opts.bus.on("bootstrap.complete", onSettled),
      this.opts.bus.on("goal.started", onSettled),
      this.opts.bus.on("goal.completed", onSettled),
      this.opts.bus.on("goal.blocked", onSettled),
      this.opts.bus.on("goal.cancelled", onSettled),
    ];
  }

  /** Stop the periodic loop and release its bus listeners (process/session shutdown). */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.kickTimer !== null) {
      clearTimeout(this.kickTimer);
      this.kickTimer = null;
    }
    for (const unsubscribe of this.settledListeners) unsubscribe();
    this.settledListeners = [];
  }

  /**
   * Schedule one event-driven re-evaluation shortly after a task settles.
   * Burst events coalesce into a single pending kick, so repeated settle
   * events can never stack a queue of decisions; the delayed pass runs
   * `tick` in decision-eligible mode, which allows a fresh LLM decision
   * even inside the decision-interval window (the delay is the anti-thrash
   * pace). A kick never schedules another kick — only settle events and the
   * periodic timer do — so the loop cannot recurse.
   */
  private scheduleKick(): void {
    if (this.kickTimer !== null) return;
    this.kickTimer = setTimeout(() => {
      this.kickTimer = null;
      void this.tick(true);
    }, RE_CHECK_DELAY_MS);
    this.kickTimer.unref?.();
  }

  /**
   * One idle-loop pass. Re-entrancy-safe: concurrent calls collapse, so LLM
   * decisions are single-flight. A decision-eligible kick arriving while a
   * pass is in flight is retained and re-run exactly once after it finishes
   * — never concurrently — so a settle event is never lost to a running
   * decision.
   */
  async tick(decisionEligible = false): Promise<void> {
    if (this.ticking) {
      if (decisionEligible) this.recheckPending = true;
      return;
    }
    this.ticking = true;
    try {
      await this.runOnce(decisionEligible);
    } catch (err) {
      this.opts.logger.warn({ err: String(err) }, "background tick failed");
    } finally {
      this.ticking = false;
      if (this.recheckPending) {
        this.recheckPending = false;
        void this.tick(true);
      }
    }
  }

  private async runOnce(decisionEligible = false): Promise<void> {
    const { bot, bootstrap, scheduler, logger } = this.opts;

    // Expired watchdog blocks must be requeued even when no candidate was
    // previously selectable; candidate selection alone is intentionally lazy.
    const maintainExpiredBlocks = (scheduler as Scheduler & { maintainExpiredBlocks?: () => number }).maintainExpiredBlocks;
    maintainExpiredBlocks?.call(scheduler);

    // --- deterministic gates: only act from spawned, post-bootstrap idle. ---
    if (bot.entity === null) return;
    if (bootstrap.completedStage !== BootstrapStage.NORMAL_OPERATION) return;
    if (this.opts.maintenance.isBusy() || this.opts.organizeStorage.isRunning || this.opts.buildBase.isRunning) return;

    // Stale background/idle tasks (e.g. a PAUSED maintenance task rehydrated
    // from a restart, or one interrupted by user work) are regenerated on
    // demand; the plan below is fresh. Goal tasks are the same: a watchdog-
    // BLOCKED goal task (or one left queued from an earlier plan) is pruned
    // here and the next goal decision re-plans. User tasks are never touched.
    for (const task of [...scheduler.queued]) {
      if (task.source === "background" || task.source === "director" || task.source === "goal") {
        scheduler.cancel(task.id);
      }
    }

    // Phase 10 death-loop brake: the bot is dying at the same kill zone on
    // every respawn. Restoring stockpiles would only send it wandering back
    // into the hazard, so the loop measures nothing and enqueues nothing
    // while the brake holds. The death manager surfaced the loop once; the
    // user relocates the bot or the spawn.
    if (this.opts.inDeathLoop?.() === true) return;

    // Phase 8: home storage is load-bearing for every deposit/stockpile
    // path — a missing chest makes restores deliver nothing and retry
    // forever ("hunted the food but could not deposit it"). Bootstrap runs
    // the STORAGE stage once and persists NORMAL_OPERATION, so it never
    // re-runs; normal operation re-establishes the chest here instead.
    // Runs before the measurement so a crisis never acts on a chestless
    // home. Only user-bound work blocks it (an active user task or a
    // pending interrupt owns the bot); background restores are exactly what
    // the repair exists to unblock, and a failed repair still falls through
    // to the regular check below — the cooldown paces retries instead of
    // starving crises.
    const userBound =
      (scheduler.active !== null && scheduler.active.source === "user") ||
      scheduler.queued.some((task) => task.source === "user") ||
      scheduler.interruptPending;
    const repairCooldownMs = (this.opts.config.background?.restore_cooldown_seconds ?? 60) * 1000;
    const tickNow = this.now();
    if (
      !userBound &&
      (this.lastHomeChestRepairAt === null || tickNow - this.lastHomeChestRepairAt >= repairCooldownMs)
    ) {
      if (findHomeChest(bot, this.opts.state, this.opts.storage) === null) {
        this.lastHomeChestRepairAt = tickNow;
        logger.warn("home chest missing; restoring home storage");
        const restored = await this.opts.bootstrap.restoreHomeChest();
        if (!restored.ok) {
          logger.warn({ reason: restored.reason }, "home chest restore failed; retrying after cooldown");
        }
      }
    }

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

    // Phase 13 (spec 9): automatic night sleep is code-owned. When the bot is
    // idle, home, and it is night, it sleeps instead of starting new work.
    if (this.opts.config.behavior?.auto_sleep !== false && this.opts.state.timePhase === "night") {
      const home = this.opts.state.home;
      const self = this.opts.bot.entity?.position;
      if (home !== null && self !== null && Math.hypot(self.x - home.x, self.z - home.z) <= AUTO_SLEEP_HOME_RADIUS) {
        scheduler.enqueue({
          type: "sleep",
          priority: TaskPriority.BACKGROUND,
          source: "background",
          objective: "Sleep until morning.",
          parameters: {},
        });
        scheduler.claim();
        return;
      }
    }

    // The goal layer (when wired): an active autonomous goal owns the idle
    // floor. The step either resolves the goal (criteria met / blocked /
    // cancelled), enqueues one goal task, or stands by; when it handles the
    // tick it returns and the director does not also decide.
    if (this.opts.config.background?.llm_decisions ?? true) {
      if (await this.runGoalStep(snapshot, decisionEligible)) return;
    }

    if (!(this.opts.config.background?.llm_decisions ?? true)) {
      await this.deterministicFallback(snapshot);
      return;
    }

    // At most one decision per interval on the periodic/fallback path;
    // within the window the bot stands by, honoring the model's "wait" for
    // the whole interval. A decision-eligible pass (a task just settled)
    // decides right away — the 1s kick delay already paced the re-check.
    // The deterministic ladder runs only when the model itself fails.
    const intervalMs = (this.opts.config.background?.llm_decision_interval_seconds ?? 60) * 1000;
    const now = this.now();
    if (!decisionEligible && this.lastDecisionAt !== null && now - this.lastDecisionAt < intervalMs) return;

    try {
      const buildCheck = await this.opts.buildBase.needsAttention();
      const decision = await this.opts.decider.decideNextTask(
        { from: "system", instruction: "Choose the next background task." },
        this.toolContext(),
        this.buildSituation(snapshot, buildCheck),
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
   * Record a failed restore so the per-kind cooldown knows where to start
   * counting. Deterministic bookkeeping keyed by the restore task:
   * `stockpile_maintenance` -> the stockpile kind, `collect_resource` -> the
   * resource. Both loop-owned sources count toward the anti-loop cooldown —
   * the deterministic background rails and LLM-director picks — while user
   * work that fails is never the loop's to re-run.
   */
  private recordFailure(task: Task): void {
    if (task.source !== "background" && task.source !== "director") return;
    let key: string | null = null;
    if (task.type === "stockpile_maintenance") {
      const kind = String(task.parameters.kind ?? "");
      if (kind !== "") key = kind;
    } else if (task.type === "collect_resource") {
      const resource = String(task.parameters.resource ?? "");
      if (resource !== "") key = `resource:${resource}`;
    } else if (task.type === "upgrade_equipment") {
      key = "upgrade";
    } else if (task.type === "build_base") {
      key = "build";
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
  private restoreBlock(key: string): RestoreBlock | null {
    const failedAt = this.lastFailedAt.get(key);
    if (failedAt === undefined) return null;
    const cooldownMs = (this.opts.config.background?.restore_cooldown_seconds ?? 60) * 1000;
    const remainingMs = failedAt + cooldownMs - this.now();
    if (remainingMs <= 0) return null;
    return {
      code: "COOLDOWN",
      message: `restore failed (${this.lastFailReason.get(key) ?? "previous restore failed"}); retry in ${Math.ceil(remainingMs / 1000)}s`,
    };
  }

  /**
   * True when the kind must stand down this tick. Logs exactly ONE warn per
   * block state entry, so a 60s cooldown does not spam the log every second
   * — the tick returns silently while the block holds, and stops game chat
   * entirely (the skills throttle their own announcements as a second layer).
   */
  private kindBlocked(key: string): boolean {
    const block = this.restoreBlock(key);
    if (block === null) return false;
    if (this.lastBlockNotice.get(key) !== block.code) {
      this.lastBlockNotice.set(key, block.code);
      this.opts.logger.warn({ kind: key, block: block.message }, "background restore standing by");
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

    // The centralized stockpile shed comes before storage expansion: chests,
    // the table, and the furnace land on blueprint slots inside it, so the
    // structure is the first infrastructure a healthy bot builds.
    if (this.kindBlocked("build")) return;
    const buildCheck = await this.opts.buildBase.needsAttention();
    if (buildCheck.needsWork) {
      this.opts.logger.info({ reason: buildCheck.reason }, "base structure incomplete; starting build");
      this.opts.scheduler.enqueue({
        type: "build_base",
        priority: TaskPriority.BACKGROUND,
        source: "background",
        objective: "Build the base structure at home.",
        parameters: {},
      });
      this.opts.scheduler.claim();
      return;
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

    // Phase 13 (spec 10.2): opportunistic tool upgrades run only when
    // nothing else needs the floor (and not on a failure cooldown).
    if (this.opts.config.behavior?.auto_upgrade_tools !== false) {
      if (this.kindBlocked("upgrade")) return;
      this.opts.logger.info({}, "stockpiles healthy; checking for tool upgrades");
      this.opts.scheduler.enqueue({
        type: "upgrade_equipment",
        priority: TaskPriority.BACKGROUND,
        source: "background",
        objective: "Upgrade tools when resources allow.",
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
  private buildSituation(
    snapshot: StockpileSnapshot,
    buildCheck: { needsWork: boolean; reason: string | null },
  ): string {
    const lines: string[] = [];
    if (snapshot.deficits.length === 0) {
      lines.push("Stockpiles: all at or above target.");
    } else {
      const shortages = snapshot.deficits
        .map((d) => `${d.kind} ${d.current}/${d.target} (${d.deficit} short)`)
        .join("; ");
      lines.push(`Stockpiles: ${shortages}.`);
    }
    lines.push(
      `Base structure: ${buildCheck.needsWork ? `incomplete (${buildCheck.reason ?? "needs work"})` : "complete"}.`,
    );
    lines.push(`Time of day: ${this.opts.state.timePhase ?? "unknown"}.`);

    const failures: string[] = [];
    const now = this.now();
    for (const [key, at] of this.lastFailedAt) {
      const ageMin = Math.max(0, Math.round((now - at) / 60_000));
      failures.push(`${key} restore failed (${this.lastFailReason.get(key) ?? "no reason recorded"}) ${ageMin}m ago`);
    }
    if (failures.length > 0) lines.push(`Recent failures: ${failures.join("; ")}.`);

    // Anti-loop watchdog blocks: the scheduler gate already holds these
    // actions, and the director must not keep proposing them.
    const blocks = this.opts.scheduler.blockedActions();
    if (blocks.length > 0) {
      lines.push(
        `Blocked actions (do not retry until the cooldown expires): ${blocks
          .map((b) => `${b.action} (${b.reason}; retry in ${b.retryInSeconds}s)`)
          .join("; ")}.`,
      );
    }

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
      case "build_base":
        // A failed build stands down into the same per-kind cooldown.
        if (this.kindBlocked("build")) return;
        scheduler.enqueue({
          type: "build_base",
          priority: TaskPriority.BACKGROUND,
          source: "director",
          objective: "Build the base structure at home.",
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
      maintenance: this.opts.maintenance,
      storage: this.opts.storage,
      tasks: this.opts.tasks,
      goals: this.opts.goals,
    };
  }

  /**
   * Goal layer (bolt-on): one active autonomous goal owns the idle floor.
   * Returns true when this tick was handled by the goal machinery, false to
   * fall through to the normal director/ladder path.
   *
   * Order of business:
   *  1. If the success criteria are all satisfied right now, the goal is
   *     complete — deterministically, no LLM call.
   *  2. If no goal is active, try the one canned background recipe (healthy
   *     stockpiles, no pickaxe, cooldown elapsed).
   *  3. Otherwise choose ONE next action for the goal, throttled exactly like
   *     the director's decisions.
   */
  private async runGoalStep(
    snapshot: StockpileSnapshot,
    decisionEligible: boolean,
  ): Promise<boolean> {
    const goals = this.opts.goals;
    if (goals === undefined) return false;

    const goal = goals.active();
    if (goal === null) return this.maybeEstablishGoal(snapshot);

    const facts = this.goalFacts(goal.successCriteria, snapshot);
    const check = evaluateSuccessCriteria(goal, facts);
    if (check.satisfied && goal.successCriteria.length > 0) {
      goals.complete("success criteria met");
      this.opts.logger.info({ goalId: goal.id }, "goal completed by criteria");
      return true;
    }

    // Same decision throttle as the director: at most one LLM decision per
    // interval, bypassed only when a settle-kick made this pass eligible.
    const intervalMs = (this.opts.config.background?.llm_decision_interval_seconds ?? 60) * 1000;
    const now = this.now();
    if (!decisionEligible && this.lastDecisionAt !== null && now - this.lastDecisionAt < intervalMs) return true;

    this.lastDecisionAt = now;
    return this.decideGoalStep(goal.id);
  }

  /**
   * Facts to evaluate goal criteria against: stockpile levels (carried +
   * stored) and carried + equipped item counts. Equipment lives on the
   * entity, not `bot.inventory`, so a count must look in both places — an
   * equipped pickaxe is still a carried pickaxe for readiness.
   */
  private goalFacts(
    criteria: readonly SuccessCriterion[],
    snapshot: StockpileSnapshot,
  ) {
    const needsInventory = criteria.some((c) => c.kind === "inventory");
    const inventory: Record<string, number> = {};
    if (needsInventory) {
      for (const item of this.opts.bot.inventory.items()) {
        const name = bareName(item.name);
        inventory[name] = (inventory[name] ?? 0) + item.count;
      }
      const equipment = this.opts.bot.entity?.equipment ?? [];
      for (const equipped of equipment) {
        if (equipped === null) continue;
        const name = bareName(equipped.name);
        inventory[name] = (inventory[name] ?? 0) + 1;
      }
      for (const c of criteria) {
        if (c.kind === "inventory") inventory[c.item] ??= 0;
      }
    }
    return { stockpile: snapshot.levels, inventory };
  }

  /**
   * The one canned background goal: with every stockpile at/above target and
   * no usable pickaxe anywhere, establish "prepare for a mining expedition"
   * with the readiness criteria the user described. Gated by a cooldown so a
   * completed goal is not instantly re-armed on the next healthy tick.
   */
  private maybeEstablishGoal(snapshot: StockpileSnapshot): boolean {
    const goals = this.opts.goals;
    if (goals === undefined || goals.active() !== null) return false;

    const targets = snapshot.targets;
    for (const kind of STOCKPILE_PRIORITY_ORDER) {
      if (snapshot.levels[kind] < targets[kind]) return false;
    }

    const criteria: SuccessCriterion[] = [
      { kind: "stockpile", stockpile: "food", min: 32 },
      { kind: "stockpile", stockpile: "torches", min: 64 },
      { kind: "inventory", item: "iron_pickaxe", min: 1 },
    ];
    const facts = this.goalFacts(criteria, snapshot);
    if ((facts.inventory?.["iron_pickaxe"] ?? 0) > 0) return false;

    const cooldownMs = (this.opts.config.background?.goal_cooldown_seconds ?? 900) * 1000;
    const now = this.now();
    if (this.lastBackgroundGoalAt !== null && now - this.lastBackgroundGoalAt < cooldownMs) return false;

    this.lastBackgroundGoalAt = now;
    goals.start({ description: "Prepare for a mining expedition.", source: "background", successCriteria: criteria });
    return true;
  }

  /**
   * One validated goal decision: map the LLM's single next action onto a
   * goal-sourced scheduler task (with the goal's id so results can be traced
   * back), set the goal's current step, and claim the slot — or settle the
   * goal terminal states (`complete` / `abandon`). Model failures stand the
   * tick down; the periodic interval re-checks.
   */
  private async decideGoalStep(goalId: string): Promise<boolean> {
    const goals = this.opts.goals!;
    const goal = goals.active();
    if (goal === null || goal.id !== goalId) return false;

    const situation = this.buildGoalSituation(goal);
    let decision: NextGoalActionDecision;
    try {
      decision = await this.opts.decider.decideGoalAction(
        { from: "system", instruction: "Choose the next action toward the goal." },
        this.toolContext(),
        situation,
      );
    } catch (err) {
      // Model down or invalid output: keep the goal, stand down this tick.
      this.opts.logger.warn({ err: String(err), goalId }, "goal decision failed; standing by");
      return true;
    }

    const action = decision.action;
    this.opts.bus.emit("director.decided", { task: action.type, rationale: decision.rationale ?? null });

    if (action.type === "wait") {
      goals.recordStandingBy(action.type);
      this.opts.logger.info({ goalId }, "goal standing by");
      return true;
    }
    if (action.type === "complete") {
      goals.complete(decision.rationale ?? "goal achieved");
      return true;
    }
    if (action.type === "abandon") {
      goals.cancel(decision.rationale ?? "gave up on the goal");
      return true;
    }

    const args = actionArguments(action);
    const parameters = { ...args, goalId };
    const stepLabel = goalStepLabel(action.type, args);
    goals.setCurrentStep(stepLabel);
    this.opts.scheduler.enqueue({
      type: action.type,
      priority: TaskPriority.BACKGROUND,
      source: "goal",
      objective: `[goal] ${stepLabel}`,
      parameters,
    });
    this.opts.scheduler.claim();
    this.opts.logger.info({ goalId, type: action.type }, "goal step dispatched");
    return true;
  }

  /**
   * The goal context digest handed to the LLM: the objective, its criteria,
   * where it is now, and what the last few actions accomplished — plus the
   * same high-signal situation lines the director sees.
   */
  private buildGoalSituation(goal: Goal): string {
    const lines: string[] = [
      `Objective: ${goal.description}`,
      `Source: ${goal.source}`,
    ];
    if (goal.successCriteria.length > 0) {
      lines.push(`Success criteria (complete when all are met): ${goal.successCriteria.map(criterionLabel).join("; ")}.`);
    }
    if (goal.currentStep !== null) lines.push(`Current step: ${goal.currentStep}.`);
    if (goal.recentResults.length > 0) {
      const outcomes = goal.recentResults
        .map((r) => `${r.action} ${r.outcome}${r.message ? ` (${r.message})` : ""}`)
        .join("; ");
      lines.push(`Recent results: ${outcomes}.`);
    }
    lines.push(`Time of day: ${this.opts.state.timePhase ?? "unknown"}.`);
    const blocks = this.opts.scheduler.blockedActions();
    if (blocks.length > 0) {
      lines.push(
        `Blocked actions (do not retry until the cooldown expires): ${blocks
          .map((b) => `${b.action} (${b.reason}; retry in ${b.retryInSeconds}s)`)
          .join("; ")}.`,
      );
    }
    return lines.join("\n");
  }
}

/**
 * The action's concrete parameters (the goal id is added by the caller).
 * Discriminated-union narrowing: each branch contributes its own fields.
 */
function actionArguments(
  action: {
    type: string;
  } & Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(action)) {
    if (key !== "type" && value !== undefined) out[key] = value;
  }
  return out;
}

/** Short step label for a goal action ("collect 16 food" / "craft an iron pickaxe"). */
function goalStepLabel(type: string, args: Record<string, unknown>): string {
  switch (type) {
    case "collect_resource":
      return `collect ${String(args.quantity ?? "?")} ${String(args.resource ?? "?")}`;
    case "ensure_item":
      return `ensure ${String(args.quantity ?? "?")} ${String(args.item ?? "?")}`;
    case "stockpile_maintenance":
      return `restore ${String(args.kind ?? "?")} stockpile`;
    case "organize_storage":
      return "organize storage";
    case "build_base":
      return "build the base";
    case "go_home":
      return "go home";
    case "upgrade_equipment":
      return "upgrade equipment";
    default:
      return type;
  }
}

