import type { Bot } from "mineflayer";
import type { Logger } from "pino";
import type { AgentState } from "./state.js";
import type { MinecraftConfig } from "../config/schema.js";
import type { EventBus } from "../events/bus.js";
import type { Scheduler } from "./scheduler.js";
import type { TaskSignals } from "./scheduler.js";
import type { Task } from "./task.js";
import { TaskPriority, TaskStatus } from "./task.js";
import {
  travelAndWait,
  travelHomeAndWait,
  waitHere,
  walkToward,
  withoutPathfinderScaffolding,
} from "../minecraft/movement.js";
import { normalizeDimension } from "../minecraft/protection.js";
import { checkDimensionEntry, checkHealthRetreat, checkLavaEntry, lavaAvoidanceRadius } from "../policy/safety.js";
import type { CollectResourceRunner, CollectResumeState } from "../skills/collect-resource.js";
import type { DeathRecoveryParams, DeathRecoveryRunner } from "../skills/death-recovery.js";
import type { DefenseRunner } from "../skills/defense.js";
import type { DeliveryRunner } from "../skills/delivery.js";
import type { EnsureItemRunner } from "../skills/ensure-item.js";
import { runEquipmentUpgrade } from "../skills/ensure-item.js";
import type { EnsureTorchesRunner } from "../skills/ensure-torches.js";
import type { LightHomeRunner } from "../skills/light-home.js";
import type { DevelopLandRunner } from "../skills/develop-land.js";
import { expeditionThreshold } from "../skills/expedition.js";
import type { GatherFoodRunner, GatherFoodResumeState } from "../skills/gather-food.js";
import { patrolHeadingDeg, patrolWaypoint } from "../skills/gather-food.js";
import type { OrganizeResumeState, OrganizeStorageRunner } from "../skills/organize-storage.js";
import type { BaseBuilderRunner, BaseResumeState, SimpleStructureSpec } from "../skills/base.js";
import type { UtilityRunner } from "../skills/utility.js";
import type { NightShelterRunner } from "../skills/night-shelter.js";
import type { SkillResult } from "../skills/skill-library.js";
import { ActionWatchdog, actionFingerprint } from "./watchdog.js";
import { stopWorldPrimitives } from "./world-actions.js";
import type { WorldMutation } from "./world-actions.js";
import { revalidateAction } from "../policy/action-boundary.js";
import { heartbeat } from "./heartbeat.js";
import { STORAGE_CATEGORIES } from "../memory/storage.js";
import { deliverCarriedItems } from "../minecraft/containers.js";
import { itemsSummary } from "../minecraft/inventory.js";
import type { StockpileDeficit, StockpileKind, StockpileManager } from "./maintenance.js";
import type { StorageRepository } from "../memory/storage.js";
import type { WorldProjectManager } from "./world-projects.js";
import type { ProjectTaskSettlement, ProjectVerificationData } from "./build-projects.js";
import { DestructiveAuthorizationRegistry } from "../policy/destructive-authorization.js";
import type { TerrainProjectRunner } from "../skills/terrain-project.js";
import { waitForTerrainObserved } from "../skills/terrain-project.js";
import { verifyClearArea, verifyExcavationVolume, verifyFlattenArea, verifyMineshaft } from "../terrain/verification.js";

/** Wall-clock budget for one interrupt movement (come here / follow me). */
const INTERRUPT_MOVE_TIMEOUT_MS = 120_000;
/** "follow me" lasts until a new command, "stop", or this long. */
const FOLLOW_MAX_MS = 30 * 60_000;
/** Give up following after the player has been out of view this long. */
const FOLLOW_LOST_MS = 60_000;
/** Re-path once the player is farther than this. */
const FOLLOW_RANGE = 4;
/** Wall-clock budget for a "go home" trip. */
const GO_HOME_TIMEOUT_MS = 120_000;
/** Upper bound for any skill, including plugins that fail to settle. */
const SKILL_TIMEOUT_MS = 10 * 60_000;
/** Dusk to dawn is ~9 real minutes; a dug-in night must not hit the 10 min budget. */
const NIGHT_SHELTER_TIMEOUT_MS = 16 * 60_000;

function skillTimeoutMs(task: Task): number {
  return task.type === "night_shelter" ? NIGHT_SHELTER_TIMEOUT_MS : SKILL_TIMEOUT_MS;
}
/** A task may run longer than this, but must publish a checkpoint/progress. */
const PROGRESS_STALL_TIMEOUT_MS = 5 * 60_000;
const PROGRESS_POLL_MS = 5_000;
/** A repeatedly disconnected autonomous action must eventually yield/back off. */
const MAX_BACKGROUND_RESUME_ATTEMPTS = 3;

export interface TaskDispatcherOptions {
  bus: EventBus;
  scheduler: Scheduler;
  state: AgentState;
  bot: Bot;
  config: MinecraftConfig;
  maintenance: StockpileManager;
  storage: StorageRepository;
  collect: CollectResourceRunner;
  food: GatherFoodRunner;
  torches: EnsureTorchesRunner;
  lightHome?: LightHomeRunner;
  developLand?: DevelopLandRunner;
  deathRecovery: DeathRecoveryRunner;
  /** Phase 11: storage organization / creation (spec 14.4, 22). */
  organizeStorage: OrganizeStorageRunner;
  /** Central stockpile base: structure build/repair (`build_base`). */
  buildBase: BaseBuilderRunner;
  /** Phase 13: ensure_item / craft_item / smelt_item / upgrade_equipment. */
  ensureItem: EnsureItemRunner;
  /** Phase 13: defend_self / defend_player. */
  defense: DefenseRunner;
  /** Phase 13: sleep / eat / equip_best / replace_equipment. */
  utility: UtilityRunner;
  /** Night without a bed: dig in and wait for day (`night_shelter`). */
  nightShelter?: NightShelterRunner;
  /** Phase 13: give_item / store_items / retrieve_items. */
  delivery: DeliveryRunner;
  buildProjects?: WorldProjectManager;
  /** Bounded grants for terrain child tasks; absent until terrain projects are enabled. */
  destructiveAuthorizations?: DestructiveAuthorizationRegistry;
  terrainProjects?: TerrainProjectRunner;
  /**
   * Anti-loop watchdog: records every settled skill-run outcome per action
   * fingerprint, so a repeatedly-failing action is blocked (and the LLM is
   * told why) instead of being re-attempted forever.
   */
  watchdog: ActionWatchdog;
  logger: Logger;
}


/**
 * Phase 8: binds scheduler tasks to deterministic skill execution. The
 * dispatcher is the single executor — every skill run belongs to exactly one
 * active task, gets that task's cooperative signals, and is settled
 * (complete / fail / pause / cancel) from its result. Reacts to
 * `task.activated` so preemption cascades start the next task immediately;
 * `execute` is also called at boot for a rehydrated ACTIVE task.
 */
export class TaskDispatcher {
  private readonly opts: TaskDispatcherOptions;
  private readonly unsubscribe: () => void;
  private readonly executions = new Set<Promise<void>>();
  /** Task ids with an execution in flight; a second start is ignored. */
  private readonly running = new Set<string>();

  constructor(options: TaskDispatcherOptions) {
    this.opts = options;
    this.unsubscribe = options.bus.on("task.activated", ({ task }) => this.onActivated(task));
  }

  /**
   * Detach from the bus. A session's dispatcher is rebuilt on reconnect, so
   * the old one must release its listener or it accumulates per attempt.
   */
  dispose(): void {
    this.unsubscribe();
  }

  private onActivated(task: Task): void {
    if (task.status !== TaskStatus.ACTIVE) return;
    this.track(this.execute(task));
  }

  /** Start a rehydrated task while keeping disconnect teardown observable. */
  executeTracked(task: Task): void {
    this.track(this.execute(task));
  }

  /** Wait until every session-scoped execution has fully settled and cleaned up. */
  async waitForIdle(): Promise<void> {
    while (this.executions.size > 0) await Promise.all([...this.executions]);
  }

  private track(run: Promise<void>): void {
    this.executions.add(run);
    void run.then(
      () => this.executions.delete(run),
      () => this.executions.delete(run),
    );
  }

  /** Run the skill for an ACTIVE task and settle it. Boot entry point too. */
  async execute(task: Task): Promise<void> {
    if (task.status !== TaskStatus.ACTIVE) return;
    // A watch that claims during login activates (and so starts) the task;
    // the spawn handler then "resumes" the same active task. Run it once.
    if (this.running.has(task.id)) {
      this.opts.logger.debug({ taskId: task.id }, "task already executing; duplicate start ignored");
      return;
    }
    this.running.add(task.id);
    try {
      await this.executeOnce(task);
    } finally {
      this.running.delete(task.id);
    }
  }

  private async executeOnce(task: Task): Promise<void> {
    const signals = this.opts.scheduler.signalsFor(task);
    const dimension = normalizeDimension(this.opts.bot.game.dimension ?? this.opts.state.self.dimension ?? "");
    const authorization = task.projectId === undefined || this.opts.destructiveAuthorizations === undefined || this.opts.state.worldId === null
      ? null
      : this.opts.destructiveAuthorizations.contextFor(task.id, task.projectId, this.opts.state.worldId, dimension);
    const run = typeof this.opts.scheduler.runWorldAction === "function"
      ? this.opts.scheduler.runWorldAction(task.id, signals.signal, () => this.runSkill(task), {
        authorization: authorization ?? undefined,
        beforeMutation: (mutation: WorldMutation) => {
          const point = mutation.point ?? this.opts.bot.entity?.position;
          if (!point) throw new Error("mutation policy revalidation requires a live bot position");
          const verdict = revalidateAction(this.opts.bot, mutation.action as Parameters<typeof revalidateAction>[1], point, this.opts.config, this.opts.state.protectedRegion, {
            blockName: mutation.blockName,
            ownBuildReplacement: mutation.ownBuildReplacement === true && (task.type === "build_project_slice" || task.type === "build_structure" || task.type === "build_design"),
            authorization: authorization ?? undefined,
            taskId: task.id,
            projectId: task.projectId,
            worldId: this.opts.state.worldId ?? undefined,
            dimension,
          });
          if (!verdict.allowed) throw new Error(verdict.violation?.reason ?? "mutation rejected by policy");
        },
        // Cleanup belongs to the lease, not to the dispatcher finally block:
        // otherwise a rejected plugin can release ownership and let the next
        // task start while the old primitive is still active.
        onCancel: () => stopWorldPrimitives(this.opts.bot),
        onRecovery: () => stopWorldPrimitives(this.opts.bot),
      })
      : this.runSkill(task);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const progressTimer = setInterval(() => {
      heartbeat(this.opts.logger, this.opts.bot, {
        task,
        primitive: task.phase ?? task.type,
        leaseOwner: task.id,
        connectionState: this.opts.bot.entity === null ? "DISCONNECTED" : "READY",
        pathfinderState: this.opts.bot.pathfinder?.goal ? "active" : "idle",
      });
      const last = task.lastProgressAt === undefined ? Date.now() : Date.parse(task.lastProgressAt);
      if (Date.now() - last > PROGRESS_STALL_TIMEOUT_MS) {
        const resumable = this.isResumable(task);
        this.opts.logger.warn({ taskId: task.id, phase: task.phase ?? null, progressFingerprint: task.progressFingerprint ?? null, resumable }, resumable ? "task progress watchdog requested pause" : "task progress watchdog requested cancellation");
        if (resumable) this.opts.scheduler.requestPause();
        else this.opts.scheduler.requestCancel();
      }
    }, PROGRESS_POLL_MS);
    progressTimer.unref?.();
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          // Resumable construction yields at its checkpoint instead of being
          // cancelled, so its persisted progress can be resumed later.
          if (this.isResumable(task)) this.opts.scheduler.requestPause();
          else this.opts.scheduler.requestCancel();
          reject(new Error(`skill execution timed out after ${skillTimeoutMs(task)}ms`));
        }, skillTimeoutMs(task));
      });
      let result: SkillResult;
      try {
        result = await Promise.race([run, timeout]);
        // Complete session-scoped primitive cleanup before settling the task.
        // Scheduler settlement may synchronously activate the next task; doing
        // this only in finally allowed that task to start during cleanup.
        await stopWorldPrimitives(this.opts.bot);
      } catch (err) {
        // Never release the active task's ownership while the skill is still
        // in flight. Await its acknowledgement before settling/replacing.
        if (String(err).includes("timed out")) {
          await run.catch(() => undefined);
        }
        throw err;
      }
      const scheduler = this.opts.scheduler;
      if (scheduler.active?.id !== task.id) return;
      if (scheduler.interruptPending) {
        // The interrupt arrived after the skill's last checkpoint; settle it
        // here so a missed checkpoint never wedges the queue. A run that
        // completed before the interrupt is still a real outcome; a failure
        // is the interruption itself and does not count toward the watchdog.
        if (result.status === "completed" || result.status === "partial") this.recordOutcome(task, result);
        this.settleProject(task, result);
        scheduler.settleInterrupted();
        return;
      }
      this.recordOutcome(task, result);
      this.settleResult(task, result);
    } catch (err) {
      const message = String(err).includes("operation timed out")
        ? `skill execution timed out after ${skillTimeoutMs(task)}ms`
        : `execution threw: ${String(err)}`;
      this.opts.logger.error({ err: String(err), taskId: task.id }, "task execution threw");
      if (timer !== undefined) clearTimeout(timer);
      const scheduler = this.opts.scheduler;
      if (scheduler.active?.id === task.id) {
        await stopWorldPrimitives(this.opts.bot);
        if (scheduler.interruptPending) scheduler.settleInterrupted();
        else if (isAbortError(err) && this.isResumable(task)) {
          // A stray abort (restart, reconnect, a torn-down primitive) is not
          // the work failing: keep the resumable progress and try again.
          scheduler.requeueActive(message);
        } else {
          const fingerprint = actionFingerprint(task.type, task.parameters);
          this.opts.watchdog.record(fingerprint, "failure", task.source === "user", message);
          scheduler.failActive(message);
        }
      }
    } finally {
      // Both settle paths above already stopped primitives before settling.
      // Settlement can synchronously start the next task (or resume
      // bootstrap); stopping again here would kill *its* pathfinder goal
      // mid-trip (the "GoalChanged" failures). Only clean up when nothing
      // else has taken over.
      const activeId = this.opts.scheduler.active?.id ?? null;
      const leaseOwner = this.opts.scheduler.worldActionOwner;
      if ((activeId === null || activeId === task.id) && (leaseOwner === null || leaseOwner === task.id)) {
        await stopWorldPrimitives(this.opts.bot);
      }
      // The dispatcher must never hand control back to arbitration while a
      // Mineflayer primitive still owns the serialized world lease.
      // A task-settled listener or periodic background tick may legitimately
      // acquire the lease before this finally block runs. Only this task's
      // own surviving lease is stale; do not misdiagnose a new background
      // probe that started after settlement.
      if (this.opts.scheduler.worldActionOwner === task.id) {
        try { this.opts.scheduler.assertWorldActionAvailable(); }
        catch (err) { this.opts.logger.error({ taskId: task.id, err: String(err) }, "stale world primitive after task cleanup"); }
      }
      if (timer !== undefined) clearTimeout(timer);
      clearInterval(progressTimer);
    }
  }

  /**
   * Feed one settled skill-run outcome to the anti-loop watchdog. The action
   * fingerprint is task type + normalized goal arguments, so a block tracks
   * the high-level action ("gather 32 coal"), not the individual task
   * instance. Owner commands reset the action's failure state first — an
   * explicit request never accumulates toward a permanent block. An
   * interrupted run (pause/cancel preemption) is not the action failing and
   * is not recorded.
   */
  private recordOutcome(task: Task, result: SkillResult): void {
    if (result.status === "interrupted") return;
    const fingerprint = actionFingerprint(task.type, task.parameters);
    const reason = result.message ?? result.errorCode ?? "";
    if (result.status === "completed") {
      this.opts.watchdog.record(fingerprint, "success", task.source === "user", reason);
    } else if (result.status === "partial") {
      this.opts.watchdog.record(fingerprint, "partial", task.source === "user", reason);
    } else {
      this.opts.watchdog.record(fingerprint, "failure", task.source === "user", reason);
    }
  }

  /** Settle from the lifecycle status; `ok` remains compatibility data only. */
  private settleResult(task: Task, result: SkillResult): void {
    const scheduler = this.opts.scheduler;
    const projectSettlement = this.settleProject(task, result);
    if (projectSettlement !== "none") {
      switch (projectSettlement) {
        case "complete": scheduler.completeActive(); return;
        case "requeue": scheduler.requeueActive(result.message ?? result.errorCode); return;
        case "block": scheduler.blockActive(result.message ?? result.errorCode ?? "project blocked"); return;
        case "fail": scheduler.failActive(result.message ?? result.errorCode ?? "project failed"); return;
      }
    }
    const message = result.message ?? result.errorCode ?? "skill failed";
    switch (result.status) {
      case "completed":
        scheduler.completeActive();
        return;
      case "partial":
        if (this.isResumable(task)) scheduler.requeueActive(message);
        else scheduler.failActive(message);
        return;
      case "blocked":
        scheduler.blockActive(message);
        return;
      case "interrupted":
        // Adapters can observe an interruption without a scheduler checkpoint.
        // Pause defensively so resumable work is never completed or cancelled.
        if (!scheduler.interruptPending) scheduler.requestPause();
        scheduler.settleInterrupted();
        return;
      case "failed":
        if (result.retryable === true && this.isResumable(task)) scheduler.requeueActive(message);
        else scheduler.failActive(message);
        return;
    }
  }

  private settleProject(task: Task, result: SkillResult): ProjectTaskSettlement {
    return task.projectId === undefined || this.opts.buildProjects === undefined
      ? "none"
      : this.opts.buildProjects.settleChildTask(task, result);
  }

  private isResumable(task: Task): boolean {
    // build_design predates executionPolicy and remains resumable during this
    // compatibility stage. New callers can opt in explicitly.
    return task.executionPolicy === "resumable" || task.type === "build_design";
  }

  private async runSkill(task: Task): Promise<SkillResult> {
    const signals: TaskSignals = this.opts.scheduler.signalsFor(task);
    // Survival work (a food crisis, death recovery, defense) is preempted by
    // design, by the defense reflex or a service restart, and must not be
    // abandoned for having been paused.
    // A build project's slice resumes once per material it fetches (blocked,
    // acquire, resumed): the windmill slice was abandoned at its fourth
    // material hop and parked by the watchdog for good (16:55, 2026-10-05).
    // Projects carry their own retry and blocking state.
    // Land development re-plans from scratch on every run; buildings and
    // storms preempt it all the time (abandoned at 17:54, 2026-10-05).
    if (task.source !== "user" && task.projectId === undefined && task.type !== "develop_land" && task.priority < TaskPriority.MAINTENANCE && (task.attempts ?? 0) > MAX_BACKGROUND_RESUME_ATTEMPTS) {
      return {
        ok: false,
        status: "failed",
        errorCode: "NOT_READY",
        message: `autonomous action abandoned after ${task.attempts} interrupted attempts; waiting for cooldown or owner direction`,
        retryable: true,
      };
    }
    switch (task.type) {
      case "collect_resource": {
        const resource = String(task.parameters.resource ?? "");
        const quantity = Number(task.parameters.quantity ?? 0);
        if (resource === "" || !Number.isFinite(quantity) || quantity <= 0) {
          return {
            ok: false,
            status: "failed",
            errorCode: "INVALID_RESOURCE",
            message: "invalid collect_resource task parameters",
            retryable: false,
          };
        }
        return this.opts.collect.run(resource, quantity, {
          signals,
          resumeState: task.resumeState as CollectResumeState | undefined,
          // Spec 8.2: an explicit owner request lifts the "no structural
          // blocks in the protected region" default (restricted by default).
          userRequested: task.source === "user",
        });
      }
      case "ensure_item":
      case "craft_item":
      case "smelt_item": {
        const item = String(task.parameters.item ?? "");
        const quantity = Number(task.parameters.quantity ?? 0);
        if (item === "" || !Number.isFinite(quantity) || quantity <= 0) {
          return {
            ok: false,
            status: "failed",
            errorCode: "INVALID_RESOURCE",
            message: "invalid ensure_item task parameters",
            retryable: false,
          };
        }
        const mode = task.type === "ensure_item" ? "ensure" : task.type === "craft_item" ? "craft" : "smelt";
        return this.opts.ensureItem.run(item, quantity, {
          mode,
          signals,
          resumeState: task.resumeState as { interruptions?: number } | undefined,
        });
      }
      case "upgrade_equipment":
        return runEquipmentUpgrade(this.opts.bot, this.opts.ensureItem, { signals });
      case "gather_food": {
        const quantity = Number(task.parameters.quantity ?? 0);
        if (!Number.isFinite(quantity) || quantity <= 0) {
          return {
            ok: false,
            status: "failed",
            errorCode: "INVALID_RESOURCE",
            message: "invalid gather_food task parameters",
            retryable: false,
          };
        }
        return this.opts.food.run(quantity, {
          signals,
          resumeState: task.resumeState as GatherFoodResumeState | undefined,
        });
      }
      case "hunt": {
        const entity = String(task.parameters.entity_type ?? "");
        const quantity = Number(task.parameters.quantity ?? 0);
        if (entity === "" || !Number.isFinite(quantity) || quantity <= 0) {
          return {
            ok: false,
            status: "failed",
            errorCode: "INVALID_RESOURCE",
            message: "invalid hunt task parameters",
            retryable: false,
          };
        }
        return this.opts.food.run(quantity, {
          signals,
          resumeState: task.resumeState as GatherFoodResumeState | undefined,
          targetMob: entity,
        });
      }
      case "travel_to":
        return this.runTravelTo(task, signals);
      case "explore":
        return this.runExplore(task, signals);
      case "give_item": {
        const params = task.parameters as Partial<{ player: string; item: string; quantity: number }>;
        if (typeof params.player !== "string" || params.player === "" || typeof params.item !== "string" || params.item === "" || !Number.isFinite(params.quantity) || (params.quantity ?? 0) <= 0) {
          return this.invalidParams("give_item");
        }
        return this.opts.delivery.give(params.player, params.item, Number(params.quantity), {
          signals,
          resumeState: task.resumeState as { interruptions?: number } | undefined,
        });
      }
      case "store_items": {
        const params = task.parameters as Partial<{ filter: string; location: string }>;
        return this.opts.delivery.store(
          typeof params.filter === "string" && params.filter !== "" ? params.filter : null,
          typeof params.location === "string" ? params.location : null,
          { signals, resumeState: task.resumeState as { interruptions?: number } | undefined },
        );
      }
      case "retrieve_items": {
        const params = task.parameters as Partial<{ items: { item: string; quantity?: number }[]; location: string }>;
        const items = Array.isArray(params.items) ? params.items : [];
        if (items.length === 0 || items.some((entry) => typeof entry.item !== "string" || entry.item === "")) {
          return this.invalidParams("retrieve_items");
        }
        return this.opts.delivery.retrieve(
          items.map((entry) => ({ item: entry.item, quantity: Math.max(1, Math.floor(Number(entry.quantity) || 1)) })),
          typeof params.location === "string" ? params.location : null,
          { signals, resumeState: task.resumeState as { interruptions?: number } | undefined },
        );
      }
      case "defend_self":
        return this.opts.defense.defendSelf({
          signals,
          resumeState: task.resumeState as { interruptions?: number } | undefined,
          ...(typeof task.parameters.radius === "number" ? { radius: task.parameters.radius } : {}),
          reflex: task.parameters.reflex === true,
        });
      case "defend_player": {
        const player = String(task.parameters.player ?? "");
        if (player === "") return this.invalidParams("defend_player");
        return this.opts.defense.defendPlayer(player, { signals, resumeState: task.resumeState as { interruptions?: number } | undefined });
      }
      case "sleep":
        return this.opts.utility.sleep({ signals });
      case "night_shelter":
        if (this.opts.nightShelter === undefined) return this.invalidParams("night_shelter");
        return this.opts.nightShelter.run({ signals, resumeState: task.resumeState as { interruptions?: number } | undefined });
      case "eat":
        return this.opts.utility.eat({ signals });
      case "equip_best":
        return this.opts.utility.equipBest({ signals });
      case "replace_equipment":
        return this.opts.utility.replaceEquipment({ signals });
      case "recover_death_items": {
        const params = task.parameters as Partial<DeathRecoveryParams>;
        if (
          !Number.isFinite(params.deathId) ||
          typeof params.dimension !== "string" ||
          !Number.isFinite(params.x) ||
          !Number.isFinite(params.y) ||
          !Number.isFinite(params.z)
        ) {
          return this.invalidParams("recover_death_items");
        }
        return this.opts.deathRecovery.run(
          { deathId: params.deathId as number, dimension: params.dimension, x: params.x as number, y: params.y as number, z: params.z as number },
          signals,
        );
      }
      case "stockpile_maintenance": {
        const kind = String(task.parameters.kind ?? "") as StockpileKind;
        const deficit: StockpileDeficit = {
          kind,
          target: Number(task.parameters.target ?? 0),
          current: Number(task.parameters.current ?? 0),
          deficit: Number(task.parameters.deficit ?? 0),
          crisis: task.parameters.crisis === true,
          attempts: task.attempts ?? 1,
        };
        return this.opts.maintenance.restore(deficit, signals);
      }
      case "death_recovery": {
        const params = task.parameters as Partial<DeathRecoveryParams> | undefined;
        if (
          params === undefined ||
          !Number.isFinite(params.deathId) ||
          typeof params.dimension !== "string" ||
          !Number.isFinite(params.x) ||
          !Number.isFinite(params.y) ||
          !Number.isFinite(params.z)
        ) {
          return {
            ok: false,
            status: "failed",
            errorCode: "INVALID_RESOURCE",
            message: "invalid death_recovery task parameters",
            retryable: false,
          };
        }
        return this.opts.deathRecovery.run(
          { deathId: params.deathId as number, dimension: params.dimension, x: params.x as number, y: params.y as number, z: params.z as number },
          signals,
        );
      }
      case "interrupt":
        return this.runInterrupt(task, signals);
      case "go_home":
        return this.runGoHome(task, signals);
      case "light_home":
        if (this.opts.lightHome === undefined) {
          return { ok: false, status: "failed", errorCode: "NOT_READY", message: "home lighting is not wired", retryable: false };
        }
        return this.opts.lightHome.run({ signals });
      case "develop_land":
        if (this.opts.developLand === undefined) {
          return { ok: false, status: "failed", errorCode: "NOT_READY", message: "land development is not wired", retryable: false };
        }
        return this.opts.developLand.run({ signals });
      case "organize_storage":
        return this.opts.organizeStorage.run({
          signals,
          resumeState: task.resumeState as OrganizeResumeState | undefined,
        });
      case "build_base":
        return this.opts.buildBase.run({
          signals,
          resumeState: task.resumeState as BaseResumeState | undefined,
        });
      case "build_structure": {
        const params = task.parameters as unknown as SimpleStructureSpec;
        return this.opts.buildBase.runSimple(params, {
          signals,
          resumeState: task.resumeState as BaseResumeState | undefined,
        });
      }
      case "build_design": {
        const params = task.parameters as { design?: unknown; origin?: { x: number; y: number; z: number; dimension: string } };
        if (!params.design || !params.origin) return { ok: false, status: "failed", errorCode: "INVALID_DESIGN", message: "design task is missing its frozen design or origin" };
        return this.opts.buildBase.runDesign(params.design as Parameters<BaseBuilderRunner["runDesign"]>[0], params.origin, { signals, resumeState: task.resumeState as BaseResumeState | undefined });
      }
      case "build_project_slice": {
        const manager = this.opts.buildProjects;
        const projectId = String(task.projectId ?? task.parameters.projectId ?? "");
        const project = manager?.getProject(projectId);
        if (project === null || project === undefined || task.projectPhaseId === undefined) {
          return { ok: false, status: "failed", errorCode: "NOT_READY", message: "project slice is missing its frozen project or phase" };
        }
        const operationStart = Number(task.parameters.operationStart ?? 0);
        const operationEnd = Number(task.parameters.operationEnd ?? project.blueprint.operations.length);
        return this.opts.buildBase.runDesignSlice(project.blueprint, {
          // The bot's own buildings go up in forest it chose: fell trunks in the way.
          clearTrees: project.source === "goal" && project.structureType?.startsWith("village:") === true,
          projectId,
          phaseId: task.projectPhaseId,
          operationStart,
          operationEnd,
          signals,
          resumeState: task.resumeState as Parameters<BaseBuilderRunner["runDesignSlice"]>[1]["resumeState"],
        });
      }
      case "build_project_acquire": {
        const item = String(task.parameters.item ?? "");
        const quantity = Number(task.parameters.quantity ?? 0);
        if (item === "" || !Number.isFinite(quantity) || quantity <= 0) {
          return { ok: false, status: "failed", errorCode: "INVALID_RESOURCE", message: "project acquisition is missing a valid item or quantity", retryable: false };
        }
        return this.opts.ensureItem.run(item, quantity, {
          mode: "ensure",
          signals,
          resumeState: task.resumeState as { interruptions?: number } | undefined,
          // Build materials are placed from the inventory, not the chest.
          keepCarried: true,
        });
      }
      case "build_project_verify": {
        const manager = this.opts.buildProjects;
        const project = manager?.getProject(String(task.projectId ?? task.parameters.projectId ?? ""));
        if (project === null || project === undefined) {
          return { ok: false, status: "failed", errorCode: "NOT_READY", message: "project verification is missing its frozen project" };
        }
        const verification = this.opts.buildBase.verifyDesignOperations(project.blueprint);
        const data: ProjectVerificationData = {
          inspected: verification.inspected,
          verified: verification.verified,
          mismatches: verification.mismatches,
        };
        return { ok: verification.mismatches.length === 0, status: "completed", data, message: "project final verification completed" };
      }
      case "world_project_slice": {
        const runner = this.opts.terrainProjects;
        const manager = this.opts.buildProjects;
        const projectId = String(task.projectId ?? task.parameters.projectId ?? "");
        const project = manager?.getWorldProject(projectId);
        if (runner === undefined || project === null || project === undefined || project.payload.type !== "terrain") {
          return { ok: false, status: "failed", errorCode: "NOT_READY", message: "terrain slice is missing its frozen project or runner", retryable: false };
        }
        const plan = project.payload.plan;
        const run = () => runner.run(plan, { signals, resumeState: task.resumeState as Parameters<TerrainProjectRunner["run"]>[1]["resumeState"] | undefined });
        // A shaft's corridor must stay open behind the bot; a clear may need
        // the pathfinder to tower up to a canopy (verification catches any
        // stray block and reopens the dig).
        return project.kind === "mineshaft" ? withoutPathfinderScaffolding(this.opts.bot, run) : run();
      }
      case "world_project_deposit": {
        const names = Object.keys(itemsSummary(this.opts.bot));
        const delivered = await deliverCarriedItems(this.opts.bot, this.opts.state, this.opts.storage, names, this.opts.logger, signals.signal);
        return delivered.delivered > 0 || names.length === 0
          ? { ok: true, status: "completed", data: delivered, message: `deposited ${delivered.delivered} carried items` }
          : { ok: false, status: "blocked", errorCode: "STORAGE_UNREACHABLE", message: "terrain project inventory could not be deposited", retryable: true, data: delivered };
      }
      case "world_project_replace_tool": {
        const item = String(task.parameters.item ?? "");
        if (item === "") return { ok: false, status: "failed", errorCode: "TOOL_REQUIRED", message: "terrain tool replacement is missing the required item", retryable: false };
        // A spare pickaxe halves the trips out of a deep shaft.
        const quantity = /_pickaxe$/.test(item) ? 2 : 1;
        return this.opts.ensureItem.run(item, quantity, { mode: "ensure", signals, resumeState: task.resumeState as { interruptions?: number } | undefined });
      }
      case "world_project_acquire": {
        const item = String(task.parameters.item ?? "");
        const quantity = Math.max(1, Math.floor(Number(task.parameters.quantity ?? 1)));
        if (item === "") return { ok: false, status: "failed", errorCode: "INSUFFICIENT_MATERIALS", message: "terrain material fetch is missing the item", retryable: false };
        return this.opts.ensureItem.run(item, quantity, { mode: "ensure", keepCarried: true, signals, resumeState: task.resumeState as { interruptions?: number } | undefined });
      }
      case "world_project_return": {
        const home = this.opts.state.home;
        if (home === null) return { ok: false, status: "blocked", errorCode: "RETURN_ROUTE_LOST", message: "terrain maintenance has no known home return route", retryable: false };
        const returned = await travelHomeAndWait(this.opts.bot, home, { dimension: home.dimension, timeoutMs: GO_HOME_TIMEOUT_MS, signal: signals.signal });
        if (returned.status !== "arrived" && returned.status !== "already_there") return { ok: false, status: "blocked", errorCode: "RETURN_ROUTE_LOST", message: `terrain maintenance could not return home: ${returned.status}`, retryable: true };
        if (task.parameters.reason === "hunger") return this.opts.utility.eat({ signals });
        return { ok: true, status: "completed", message: "returned to a safe home waypoint" };
      }
      case "world_project_verify": {
        const manager = this.opts.buildProjects;
        const project = manager?.getWorldProject(String(task.projectId ?? task.parameters.projectId ?? ""));
        if (project === null || project === undefined || project.payload.type !== "terrain") return { ok: false, status: "failed", errorCode: "NOT_READY", message: "terrain verification is missing its frozen project", retryable: false };
        await waitForTerrainObserved(this.opts.bot, project.payload.plan.bounds, signals.signal);
        if (project.kind === "excavate") return verifyExcavationVolume(this.opts.bot, project.payload.plan.bounds);
        if (project.kind === "clear") return verifyClearArea(this.opts.bot, project.payload.plan.bounds);
        if (project.kind === "flatten") return verifyFlattenArea(this.opts.bot, project.payload.plan.bounds, project.payload.plan.bounds.maxY);
        return verifyMineshaft(this.opts.bot, project.payload.plan);
      }
      case "create_storage": {
        const category = String(task.parameters.category ?? "general");
        if (!STORAGE_CATEGORIES.includes(category as (typeof STORAGE_CATEGORIES)[number])) {
          return {
            ok: false,
            status: "failed",
            errorCode: "INVALID_RESOURCE",
            message: `unknown storage category '${category}'`,
            retryable: false,
          };
        }
        return this.opts.organizeStorage.run({
          category: category as (typeof STORAGE_CATEGORIES)[number],
          signals,
          resumeState: task.resumeState as OrganizeResumeState | undefined,
        });
      }
      default:
        return {
          ok: false,
          status: "failed",
          errorCode: "NOT_READY",
          message: `no executor for task type '${task.type}'`,
          retryable: false,
        };
    }
  }

  /** Soft interrupts (spec 6.1): the movement action, then the paused work resumes. */
  private async runInterrupt(task: Task, signals: TaskSignals): Promise<SkillResult> {
    const tool = String(task.parameters.tool ?? "");
    const player = String(task.parameters.player ?? "");
    const bot = this.opts.bot;
    const shouldAbort = (): boolean => !signals.checkpoint();

    if (tool === "wait_here") {
      waitHere(bot);
      return { ok: true, status: "completed", message: "staying put" };
    }
    if (tool === "follow_player") return this.runFollow(player, signals);
    if (tool === "come_to_player") {
      const entity = bot.players[player]?.entity ?? null;
      if (entity === null) {
        return { ok: false, status: "failed", message: "could not see the player", retryable: true };
      }
      // Bounded: walk within follow range and stop. Sustained follow-tracking
      // is Phase 9 companion behavior; as an interrupt the move completes and
      // the paused task resumes.
      const travel = await travelAndWait(bot, entity.position, {
        timeoutMs: INTERRUPT_MOVE_TIMEOUT_MS,
        range: 3,
        shouldAbort,
        signal: signals.signal,
      });
      if (travel.status === "aborted") {
        return { ok: false, status: "interrupted", message: "interrupted before arrival" };
      }
      if (travel.status !== "arrived" && travel.status !== "already_there") {
        // Pathfinder failed. Fall back to dumb-walk toward the player
        // so a "come here" is never a complete dead end.
        this.opts.logger.warn({ travel: travel.status, player }, "pathfinder failed for interrupt; falling back to walkToward");
        const fallback = await walkToward(bot, entity.position, {
          range: 5, // slightly more tolerant since we are walking blind
          timeoutMs: INTERRUPT_MOVE_TIMEOUT_MS,
          signal: signals.signal,
        });
        if (fallback.arrived) {
          return { ok: true, status: "completed", message: "arrived (fallback)" };
        }
        return { ok: false, status: "failed", message: `could not reach the player: ${fallback.distance > 0 ? `${fallback.distance.toFixed(1)} blocks away after fallback` : travel.status}`, retryable: true };
      }
      return { ok: true, status: "completed", message: "arrived" };
    }
    return { ok: false, status: "failed", message: `unknown interrupt '${tool}'`, retryable: false };
  }

  /**
   * Companion follow: keep within a few blocks of the player until told to
   * stop or given any other command (a newly queued user task ends the
   * follow so it can run), bounded by FOLLOW_MAX_MS.
   */
  private async runFollow(player: string, signals: TaskSignals): Promise<SkillResult> {
    const bot = this.opts.bot;
    const deadline = Date.now() + FOLLOW_MAX_MS;
    const newCommand = (): boolean => this.opts.scheduler.queued.some((task) => task.source === "user");
    let tick = 0;
    let unseenSince: number | null = null;
    while (Date.now() < deadline) {
      tick += 1;
      if (!signals.checkpoint({ phase: "follow", tick })) return { ok: false, status: "interrupted", message: "follow interrupted" };
      if (newCommand()) return { ok: true, status: "completed", message: "stopped following for a new command" };
      const entity = bot.players[player]?.entity ?? null;
      const self = bot.entity;
      if (entity === null || self === null) {
        unseenSince ??= Date.now();
        if (Date.now() - unseenSince > FOLLOW_LOST_MS) return { ok: false, status: "failed", message: "lost sight of the player", retryable: false };
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        continue;
      }
      unseenSince = null;
      if (self.position.distanceTo(entity.position) > FOLLOW_RANGE) {
        await travelAndWait(bot, entity.position.clone(), {
          timeoutMs: 15_000,
          range: FOLLOW_RANGE - 1,
          shouldAbort: () => !signals.checkpoint({ phase: "follow", tick }) || newCommand(),
          signal: signals.signal,
        });
      } else {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    return { ok: true, status: "completed", message: "follow time limit reached" };
  }

  /** "go home": travel to the home column, then let the next task claim the slot. */
  private async runGoHome(task: Task, signals: TaskSignals): Promise<SkillResult> {
    const home = this.opts.state.home;
    if (home === null) {
      return { ok: false, status: "failed", message: "no home coordinate configured", retryable: false };
    }
    const shouldAbort = (): boolean => !signals.checkpoint();
    const travel = await travelHomeAndWait(this.opts.bot, home, {
      dimension: home.dimension,
      timeoutMs: GO_HOME_TIMEOUT_MS,
      shouldAbort,
      signal: signals.signal,
    });
    if (travel.status === "aborted") {
      return { ok: false, status: "interrupted", message: "interrupted en route home" };
    }
    if (travel.status !== "arrived" && travel.status !== "already_there") {
      return { ok: false, status: "failed", message: `could not reach home: ${travel.status}`, retryable: true };
    }
    return { ok: true, status: "completed", message: "home" };
  }

  /**
   * "travel_to": walk to an explicit location (destination dimension must match
   * the bot's current dimension; the policy layer refuses unauthorized
   * dimensions and lava destinations).
   */
  private async runTravelTo(task: Task, signals: TaskSignals): Promise<SkillResult> {
    const x = Number(task.parameters.x ?? Number.NaN);
    const y = Number(task.parameters.y ?? Number.NaN);
    const z = Number(task.parameters.z ?? Number.NaN);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      return this.invalidParams("travel_to");
    }
    const destination = { x, y, z };
    const dimension = String(task.parameters.dimension ?? this.opts.state.self.dimension ?? "overworld");

    const dimensionPolicy = checkDimensionEntry(dimension, this.opts.config);
    if (!dimensionPolicy.allowed) {
      return { ok: false, status: "failed", errorCode: "DIMENSION_FORBIDDEN", message: dimensionPolicy.violation.reason, retryable: false };
    }
    const currentDimension = normalizeDimension(this.opts.bot.game.dimension ?? "");
    if (currentDimension !== normalizeDimension(dimension)) {
      return { ok: false, status: "failed", errorCode: "WRONG_DIMENSION", message: `destination is in ${dimension}, the bot is in ${currentDimension}`, retryable: false };
    }
    const lava = checkLavaEntry(this.opts.bot, destination, lavaAvoidanceRadius(this.opts.config));
    if (!lava.allowed) {
      return { ok: false, status: "failed", errorCode: "DANGER_TOO_HIGH", message: lava.violation.reason, retryable: false };
    }

    const shouldAbort = (): boolean => !signals.checkpoint();
    const travel = await travelAndWait(this.opts.bot, destination, {
      timeoutMs: GO_HOME_TIMEOUT_MS,
      shouldAbort,
      signal: signals.signal,
    });
    if (travel.status === "aborted") {
      return { ok: false, status: "interrupted", message: "interrupted en route" };
    }
    if (travel.status !== "arrived" && travel.status !== "already_there") {
      return { ok: false, status: "failed", message: `could not reach the location: ${travel.status}`, retryable: true };
    }
    return { ok: true, status: "completed", message: "arrived" };
  }

  /**
   * "explore": walk out along a compass heading to a bounded distance (never
   * beyond the expedition threshold) and walk home again. Direction and
   * distance are optional; a default heading rotates with the clock so
   * repeated explores fan out around home.
   */
  private async runExplore(task: Task, signals: TaskSignals): Promise<SkillResult> {
    const home = this.opts.state.home;
    if (home === null) {
      return { ok: false, status: "failed", message: "no home coordinate configured", retryable: false };
    }
    // Dangerous-work health gate (spec 34): exploring requires walking out and
    // back; at/below the retreat threshold the bot stays put and heals.
    if (!checkHealthRetreat(this.opts.bot.health).allowed) {
      return { ok: false, status: "failed", errorCode: "DANGER_TOO_HIGH", message: `health ${this.opts.bot.health} is at/below the retreat threshold; not exploring`, retryable: false };
    }
    const threshold = expeditionThreshold(this.opts.config);
    const rawDistance = Number(task.parameters.distance ?? 128);
    const distance = Math.min(Math.max(Math.floor(rawDistance), 8), Math.max(8, threshold - 1));
    const rawHeading = Number(task.parameters.heading ?? -1);
    const heading = rawHeading >= 0 ? ((rawHeading % 360) + 360) % 360 : patrolHeadingDeg(Math.floor(Date.now() / 60_000));
    const waypoint = patrolWaypoint(home.x, home.z, distance, heading);

    const shouldAbort = (): boolean => !signals.checkpoint();
    const standingY = Math.floor(this.opts.bot.entity?.position.y ?? home.y);
    const outbound = await travelAndWait(this.opts.bot, { x: waypoint.x, y: standingY, z: waypoint.z }, {
      timeoutMs: GO_HOME_TIMEOUT_MS,
      shouldAbort,
      signal: signals.signal,
    });
    if (outbound.status === "aborted") {
      return { ok: false, status: "interrupted", message: "interrupted exploring" };
    }
    if (outbound.status !== "arrived" && outbound.status !== "already_there") {
      return { ok: false, status: "failed", message: `could not explore: ${outbound.status}`, retryable: true };
    }
    if (signals.checkpoint()) {
      const inbound = await travelHomeAndWait(this.opts.bot, home, {
        dimension: home.dimension,
        timeoutMs: GO_HOME_TIMEOUT_MS,
        shouldAbort,
        signal: signals.signal,
      });
      if (inbound.status === "aborted") {
        return { ok: false, status: "interrupted", message: "interrupted returning from explore" };
      }
    }
    return { ok: true, status: "completed", message: "exploration done" };
  }

  /** Uniform structured rejection for malformed task parameters. */
  private invalidParams(taskType: string): SkillResult {
    return {
      ok: false,
      status: "failed",
      errorCode: "INVALID_RESOURCE",
      message: `invalid ${taskType} task parameters`,
      retryable: false,
    };
  }
}

function isAbortError(err: unknown): boolean {
  return (err instanceof Error && err.name === "AbortError") || /AbortError|operation was aborted/.test(String(err));
}
