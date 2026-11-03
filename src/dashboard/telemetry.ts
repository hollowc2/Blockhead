import { hostname } from "node:os";
import type { Bot } from "mineflayer";
import type { MinecraftConfig } from "../config/schema.js";
import type { AgentState } from "../agent/state.js";
import type { Scheduler } from "../agent/scheduler.js";
import type { BuildProjectManager } from "../agent/build-projects.js";
import type { WorldProjectManager } from "../agent/world-projects.js";
import type { GoalManager } from "../agent/goals.js";
import type { BlockerDesk } from "../agent/blockers.js";
import type { StockpileManager } from "../agent/maintenance.js";
import type { HostileTracker } from "../minecraft/entities.js";
import type { DecisionMaker } from "../llm/decider.js";
import type { LlamaClient } from "../llm/client.js";
import type { EventHistory } from "./event-history.js";
import type { StoryFeed } from "./story.js";
import type { WorldStatsSummary } from "./world-stats.js";
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
import type { BroadcastInputs, DashboardSnapshot, VitalsSample } from "./types.js";
import { EQUIPMENT_SLOTS, type EquipmentSummary } from "./types.js";
import type { ViewerTelemetry } from "./viewer.js";
import type { JobsSummary } from "./jobs.js";
import { jobReadiness, upcomingJob, type GearDetail } from "./gear.js";

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
  blockers?: BlockerDesk;
  decider?: DecisionMaker | null;
  client?: LlamaClient | null;
  eventHistory: EventHistory;
  story?: StoryFeed;
  worldStats?: () => WorldStatsSummary | null;
  viewer?: () => ViewerTelemetry;
  /** Live jobs plus tracked owner commands (private). */
  jobs?: () => JobsSummary;
  /** Gear condition and supply readiness (private). */
  gear?: () => GearDetail | null;
  /** Vitals history and every player name seen, for the broadcast fields (see broadcast-inputs.ts). */
  broadcast?: { vitals(nowMs: number): readonly VitalsSample[]; names(): readonly string[] };
}

const HOUR_MS = 3_600_000;
const DAY_TICKS = 24_000;

/** mineflayer's timeOfDay as whole ticks in 0-23999, or null before the first time packet. */
function worldTicks(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? ((Math.floor(value) % DAY_TICKS) + DAY_TICKS) % DAY_TICKS : null;
}

/** A process-lifetime, side-effect-free projection of live agent telemetry. */
export class DashboardTelemetryCollector {
  private readonly source: DashboardTelemetrySource;
  /** Config and host names never change while the process runs. */
  private readonly fixedTerms: readonly string[];

  constructor(source: DashboardTelemetrySource) {
    this.source = source;
    this.fixedTerms = fixedPrivateTerms(source.config);
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
        timeOfDay: connected ? worldTicks(bot?.time?.timeOfDay) : null,
      },
      goal: projectGoal(activeGoal),
      task: projectTask(activeTask),
      buildProject: projectBuildProject(buildProject, buildProject === null ? null : this.source.blockers?.forProject(buildProject.project.id)?.summary),
      worldProject: projectWorldProject(worldProject),
      action: { label: actionForTask(activeTask), taskId: activeTask?.id ?? null },
      background: {
        label: activeTask === null ? "Standing by" : actionForTask(activeTask),
        taskId: activeTask === null ? null : activeTask.id,
      },
      stockpiles: projectStockpiles(maintenance?.snapshot),
      inventory,
      equipment: connected && bot !== null ? projectEquipment(bot) : null,
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
      story: this.source.story?.recent() ?? [],
      world: this.source.worldStats?.() ?? null,
      broadcast: this.broadcastInputs(bot, connected, now),
      ...(this.source.jobs === undefined ? {} : { jobs: this.source.jobs() }),
      ...(this.source.gear === undefined ? {} : { gear: connected ? safely(() => this.gearForJob(this.source.gear!(), activeTask, buildProject !== null)) : null }),
    };
  }

  private broadcastInputs(bot: Bot | null, connected: boolean, now: number): BroadcastInputs {
    const decider = this.source.decider ?? null;
    const decision = decider?.lastDecision ?? null;
    const online = connected && bot !== null ? [bot.username, ...Object.keys(bot.players ?? {})] : [];
    return {
      vitals: this.source.broadcast?.vitals(now) ?? [],
      decisionsLastHour: decider?.decisionsSince?.(now - HOUR_MS) ?? 0,
      lastDecision: decision === null ? null : { at: new Date(decision.at).toISOString(), latencyMs: decision.latencyMs, tool: decision.tool, callType: decision.callType, rationale: decision.rationale, spectator: decision.spectator ?? null },
      privateTerms: dedupeTerms([...this.fixedTerms, ...online, ...(this.source.broadcast?.names() ?? [])]),
      modelLabel: this.source.config?.dashboard?.public_viewer.model_label ?? null,
    };
  }

  /** Judge readiness for the job Bob is on or about to start, when there is one. */
  private gearForJob(gear: GearDetail | null, active: Parameters<typeof upcomingJob>[0], building: boolean): GearDetail | null {
    if (gear === null) return null;
    const job = upcomingJob(active, this.source.scheduler.queued ?? [], building);
    return { ...gear, jobReadiness: job === null ? null : jobReadiness(job.job, gear.readiness, job.subject) };
  }
}

/**
 * Names and hosts from config and this machine. Host names also go in by
 * label ("maia" from maia.example.ts.net); short labels like "ts" or "net"
 * would reject ordinary words, so only labels of four or more letters count.
 */
function fixedPrivateTerms(config: MinecraftConfig | undefined): string[] {
  const hosts: string[] = [safely(() => hostname()) ?? ""];
  const urlHost = (value: string | undefined): string => { try { return value === undefined ? "" : new URL(value).hostname; } catch { return ""; } };
  if (config !== undefined) {
    const interactions = config.dashboard?.public_viewer.interactions;
    hosts.push(config.server.host, urlHost(config.llm?.base_url), urlHost(interactions?.model_questions.base_url), urlHost(interactions?.allowed_origin));
  }
  const labels = hosts.flatMap((host) => host.split(".")).filter((label) => label.length >= 4 && /[a-z]/i.test(label));
  // The owner default mirrors the tools that read config.agent.owner.
  const identity = config === undefined ? [] : [config.agent?.owner ?? "Corey", config.agent?.name ?? "CobbleBob", config.server.username];
  return [...identity, ...hosts, ...labels].filter((term) => term !== "");
}

function dedupeTerms(terms: readonly string[]): string[] {
  const seen = new Map<string, string>();
  for (const term of terms) if (typeof term === "string" && term.trim() !== "") seen.set(term.trim().toLowerCase(), term.trim());
  return [...seen.values()];
}

/** A failing optional projection must not take the whole snapshot down. */
function safely<T>(read: () => T | null): T | null {
  try { return read(); } catch { return null; }
}

/** Read actual equipped slots, rather than inferring equipment from owned items. */
export function projectEquipment(bot: Bot): EquipmentSummary {
  return Object.fromEntries(EQUIPMENT_SLOTS.map((slot) => {
    const item = slot === "off-hand" && bot.supportFeature?.("doesntHaveOffHandSlot") ? null
      : slot === "hand" ? bot.heldItem
      : bot.inventory.slots?.[bot.getEquipmentDestSlot?.(slot)];
    return [slot, item ? { name: item.name, count: item.count } : null];
  })) as EquipmentSummary;
}

export function createDashboardTelemetry(source: DashboardTelemetrySource): DashboardTelemetryCollector {
  return new DashboardTelemetryCollector(source);
}

export function buildDashboardSnapshot(source: DashboardTelemetrySource): DashboardSnapshot {
  return new DashboardTelemetryCollector(source).snapshot();
}
