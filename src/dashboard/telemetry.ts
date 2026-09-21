import type { Bot } from "mineflayer";
import type { MinecraftConfig } from "../config/schema.js";
import type { AgentState } from "../agent/state.js";
import type { Scheduler } from "../agent/scheduler.js";
import type { BuildProjectManager } from "../agent/build-projects.js";
import type { WorldProjectManager } from "../agent/world-projects.js";
import type { GoalManager } from "../agent/goals.js";
import type { StockpileManager } from "../agent/maintenance.js";
import type { HostileTracker } from "../minecraft/entities.js";
import type { DecisionMaker } from "../llm/decider.js";
import type { LlamaClient } from "../llm/client.js";
import type { EventHistory } from "./event-history.js";
import { itemsSummary } from "../minecraft/inventory.js";
import { computeDangerScore } from "../tui/danger.js";
import { actionForTask } from "../tui/panels.js";
import {
  projectGoal,
  projectInventory,
  projectPosition,
  projectStockpiles,
  projectTask,
  projectBuildProject,
  projectWorldProject,
  projectLlmLastCall,
  projectLlmActivity,
} from "./projections.js";
import type { DashboardSnapshot } from "./types.js";
import type { ViewerTelemetry } from "./viewer.js";

/**
 * Read-only inputs for the process-lifetime dashboard collector. Session
 * services are functions because the bot, maintenance manager, and hostile
 * tracker are replaced on reconnect; process services remain stable.
 */
export interface DashboardTelemetrySource {
  config?: MinecraftConfig;
  startedAtMs: number;
  nowMs?: () => number;
  bot(): Bot | null;
  maintenance(): StockpileManager | null;
  hostile(): HostileTracker | null;
  state: AgentState;
  scheduler: Scheduler;
  buildProjects?: BuildProjectManager;
  worldProjects?: WorldProjectManager;
  goals(): GoalManager | null;
  decider?: DecisionMaker | null;
  client?: LlamaClient | null;
  eventHistory: EventHistory;
  viewer?: () => ViewerTelemetry;
}

/** A process-lifetime, side-effect-free projection of live agent telemetry. */
export class DashboardTelemetryCollector {
  private readonly source: DashboardTelemetrySource;

  constructor(source: DashboardTelemetrySource) {
    this.source = source;
  }

  snapshot(): DashboardSnapshot {
    const now = (this.source.nowMs ?? Date.now)();
    const bot = this.source.bot();
    const entity = bot?.entity;
    const connected = entity !== null && entity !== undefined;
    const self = this.source.state.self;
    const maintenance = this.source.maintenance();
    const hostile = this.source.hostile();
    const activeTask = this.source.scheduler.active;
    const activeGoal = this.source.goals()?.active() ?? null;
    const buildProject = this.source.buildProjects?.currentProject() ?? null;
    const worldProject = this.source.worldProjects?.currentWorldProject() ?? null;
    const nearestHostile = hostile?.nearest() ?? null;
    const lastCall = this.source.decider?.lastCall ?? null;
    const viewer = this.source.viewer?.() ?? { enabled: false, status: "stopped" as const, port: 0, distance: 0, failure: null };

    const inventory = connected && bot !== null
      ? projectInventory(itemsSummary(bot))
      : null;
    const danger = hostile === null
      ? null
      : {
          score: computeDangerScore({
            health: self.health,
            hunger: self.food,
            night: this.source.state.timePhase === "night",
            nearestHostileMeters: nearestHostile?.distance ?? null,
            expeditionTier: null,
          }),
          nearestHostile: nearestHostile === null ? null : { ...nearestHostile },
          hostileCount: hostile.count,
        };

    return {
      schema: 1,
      process: {
        startedAt: new Date(this.source.startedAtMs).toISOString(),
        uptimeSeconds: Math.max(0, (now - this.source.startedAtMs) / 1000),
      },
      connection: {
        connected,
        player: connected && bot !== null ? bot.username : null,
        server: this.source.config === undefined
          ? null
          : `${this.source.config.server.host}:${this.source.config.server.port}`,
      },
      viewer,
      self: {
        health: connected ? self.health : null,
        hunger: connected ? self.food : null,
        position: connected ? projectPosition(self.position) : null,
        dimension: connected ? self.dimension : null,
        timePhase: connected ? this.source.state.timePhase : null,
      },
      goal: projectGoal(activeGoal),
      task: projectTask(activeTask),
      buildProject: projectBuildProject(buildProject),
      worldProject: projectWorldProject(worldProject),
      action: { label: actionForTask(activeTask), taskId: activeTask?.id ?? null },
      background: {
        label: activeTask === null ? "Standing by" : actionForTask(activeTask),
        taskId: activeTask === null ? null : activeTask.id,
      },
      stockpiles: projectStockpiles(maintenance?.snapshot),
      inventory,
      danger,
      llmLastCall: projectLlmLastCall(lastCall),
      llmActivity: projectLlmActivity({
        activity: this.source.decider?.activity,
        call: lastCall,
        client: this.source.decider === undefined || this.source.decider === null ? null : this.source.client,
        working: activeTask !== null,
        nowMs: now,
      }),
      path: null,
      recentEvents: this.source.eventHistory.recentEvents().map((event) => ({ at: event.at, kind: event.category, message: event.message })),
      recentFailures: this.source.eventHistory.recentFailures().map((event) => ({ at: event.at, kind: event.category, message: event.message })),
      recentChat: this.source.eventHistory.recentChat().map((event) => ({ at: event.at, sender: event.category, message: event.message })),
    };
  }
}

export function createDashboardTelemetry(source: DashboardTelemetrySource): DashboardTelemetryCollector {
  return new DashboardTelemetryCollector(source);
}

export function buildDashboardSnapshot(source: DashboardTelemetrySource): DashboardSnapshot {
  return new DashboardTelemetryCollector(source).snapshot();
}
