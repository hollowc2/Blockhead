import type { Bot } from "mineflayer";
import type { Logger } from "pino";
import type { AgentState } from "./state.js";
import type { EventBus } from "../events/bus.js";
import type { Scheduler } from "./scheduler.js";
import type { TaskSignals } from "./scheduler.js";
import type { Task } from "./task.js";
import { TaskStatus } from "./task.js";
import {
  travelAndWait,
  travelHomeAndWait,
  waitHere,
} from "../minecraft/movement.js";
import type { CollectResourceRunner, CollectResumeState } from "../skills/collect-resource.js";
import type { DeathRecoveryParams, DeathRecoveryRunner } from "../skills/death-recovery.js";
import type { EnsureTorchesRunner } from "../skills/ensure-torches.js";
import type { GatherFoodRunner } from "../skills/gather-food.js";
import type { OrganizeResumeState, OrganizeStorageRunner } from "../skills/organize-storage.js";
import type { SkillResult } from "../skills/skill-library.js";
import { STORAGE_CATEGORIES } from "../memory/storage.js";
import type { StockpileDeficit, StockpileKind, StockpileManager } from "./maintenance.js";

/** Wall-clock budget for one interrupt movement (come here / follow me). */
const INTERRUPT_MOVE_TIMEOUT_MS = 120_000;
/** Wall-clock budget for a "go home" trip. */
const GO_HOME_TIMEOUT_MS = 120_000;

export interface TaskDispatcherOptions {
  bus: EventBus;
  scheduler: Scheduler;
  state: AgentState;
  bot: Bot;
  maintenance: StockpileManager;
  collect: CollectResourceRunner;
  food: GatherFoodRunner;
  torches: EnsureTorchesRunner;
  deathRecovery: DeathRecoveryRunner;
  /** Phase 11: storage organization / creation (spec 14.4, 22). */
  organizeStorage: OrganizeStorageRunner;
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
    void this.execute(task);
  }

  /** Run the skill for an ACTIVE task and settle it. Boot entry point too. */
  async execute(task: Task): Promise<void> {
    if (task.status !== TaskStatus.ACTIVE) return;
    try {
      const result = await this.runSkill(task);
      const scheduler = this.opts.scheduler;
      if (scheduler.active?.id !== task.id) return;
      if (scheduler.interruptPending) {
        // The interrupt arrived after the skill's last checkpoint; settle it
        // here so a missed checkpoint never wedges the queue.
        scheduler.settleInterrupted();
        return;
      }
      if (result.ok) scheduler.completeActive();
      else scheduler.failActive(result.message ?? "skill failed");
    } catch (err) {
      this.opts.logger.error({ err: String(err), taskId: task.id }, "task execution threw");
      const scheduler = this.opts.scheduler;
      if (scheduler.active?.id === task.id) {
        if (scheduler.interruptPending) scheduler.settleInterrupted();
        else scheduler.failActive(`execution threw: ${String(err)}`);
      }
    }
  }

  private async runSkill(task: Task): Promise<SkillResult> {
    const signals: TaskSignals = this.opts.scheduler.signalsFor(task);
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
        });
      }
      case "stockpile_maintenance": {
        const kind = String(task.parameters.kind ?? "") as StockpileKind;
        const deficit: StockpileDeficit = {
          kind,
          target: Number(task.parameters.target ?? 0),
          current: Number(task.parameters.current ?? 0),
          deficit: Number(task.parameters.deficit ?? 0),
          crisis: task.parameters.crisis === true,
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
      case "organize_storage":
        return this.opts.organizeStorage.run({
          signals,
          resumeState: task.resumeState as OrganizeResumeState | undefined,
        });
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
    if (tool === "come_to_player" || tool === "follow_player") {
      const entity = bot.players[player]?.entity ?? null;
      if (entity === null) {
        return { ok: true, status: "completed", message: "could not see the player" };
      }
      // Bounded: walk within follow range and stop. Sustained follow-tracking
      // is Phase 9 companion behavior; as an interrupt the move completes and
      // the paused task resumes.
      const travel = await travelAndWait(bot, entity.position, {
        timeoutMs: INTERRUPT_MOVE_TIMEOUT_MS,
        range: 3,
        shouldAbort,
      });
      if (travel.status === "aborted") {
        return { ok: false, status: "interrupted", message: "interrupted before arrival" };
      }
      if (travel.status !== "arrived" && travel.status !== "already_there") {
        return { ok: false, status: "failed", message: `could not reach the player: ${travel.status}`, retryable: true };
      }
      return { ok: true, status: "completed", message: "arrived" };
    }
    return { ok: false, status: "failed", message: `unknown interrupt '${tool}'`, retryable: false };
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
    });
    if (travel.status === "aborted") {
      return { ok: false, status: "interrupted", message: "interrupted en route home" };
    }
    if (travel.status !== "arrived" && travel.status !== "already_there") {
      return { ok: false, status: "failed", message: `could not reach home: ${travel.status}`, retryable: true };
    }
    return { ok: true, status: "completed", message: "home" };
  }
}