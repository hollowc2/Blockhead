import type { Bot } from "mineflayer";
import { loadConfig } from "./config/load.js";
import { createCobbleBob } from "./minecraft/bot.js";
import { registerEvents } from "./minecraft/events.js";
import { logger, setLogEcho, closeLogs } from "./logger.js";
import { HostileTracker } from "./minecraft/entities.js";
import { TuiApp, shouldEnableTui, detectStdoutIsTty } from "./tui/app.js";
import { EventBus } from "./events/bus.js";
import { AppDatabase } from "./memory/database.js";
import { ActionsRepository } from "./memory/actions.js";
import { MIGRATIONS } from "./memory/migrations.js";
import { LocationsRepository } from "./memory/locations.js";
import { BootstrapRepository } from "./memory/bootstrap.js";
import { SkillsRepository } from "./memory/skills.js";
import { StorageRepository } from "./memory/storage.js";
import { TasksRepository } from "./memory/tasks.js";
import { WorldProjectsRepository } from "./memory/world-projects.js";
import { BackgroundFailuresRepository } from "./memory/background-failures.js";
import { GoalsRepository } from "./memory/goals.js";
import { ResourceSitesRepository } from "./memory/resource-sites.js";
import { DeathEventsRepository } from "./memory/deaths.js";
import { AgentState } from "./agent/state.js";
import { Scheduler } from "./agent/scheduler.js";
import { WorldProjectManager } from "./agent/world-projects.js";
import { ActionWatchdog } from "./agent/watchdog.js";
import { TaskDispatcher } from "./agent/task-dispatcher.js";
import { DeathRecoveryManager } from "./agent/death-recovery.js";
import { BackgroundManager } from "./agent/background.js";
import { GoalManager } from "./agent/goals.js";
import { registerGoalTools } from "./tools/goals.js";
import { BootstrapRunner } from "./skills/bootstrap-survival.js";
import { CollectResourceRunner } from "./skills/collect-resource.js";
import { DeathRecoveryRunner } from "./skills/death-recovery.js";
import { GatherFoodRunner } from "./skills/gather-food.js";
import { EnsureTorchesRunner } from "./skills/ensure-torches.js";
import { EnsureItemRunner } from "./skills/ensure-item.js";
import { DefenseRunner } from "./skills/defense.js";
import { SelfDefenseReflex } from "./agent/self-defense.js";
import { UtilityRunner } from "./skills/utility.js";
import { DeliveryRunner } from "./skills/delivery.js";
import { OrganizeStorageRunner } from "./skills/organize-storage.js";
import { BaseBuilderRunner } from "./skills/base.js";
import { StockpileManager } from "./agent/maintenance.js";
import { LlamaClient } from "./llm/client.js";
import { DecisionMaker } from "./llm/decider.js";
import { DebugLog } from "./llm/debug-log.js";
import { ToolRegistry } from "./tools/registry.js";
import { registerMovementTools } from "./tools/movement.js";
import { registerBootstrapTools } from "./tools/bootstrap.js";
import { registerResourceTools } from "./tools/resources.js";
import { registerStorageTools } from "./tools/storage.js";
import { registerBaseTools } from "./tools/base.js";
import { registerBuildDesignTool } from "./tools/build-design.js";
import { registerAcquisitionTools } from "./tools/acquire.js";
import { registerFoodTools } from "./tools/food.js";
import { registerCombatTools } from "./tools/combat.js";
import { registerNavigationTools } from "./tools/navigation.js";
import { registerDeliveryTools } from "./tools/delivery.js";
import { registerUtilityTools } from "./tools/utility.js";
import { registerMemoryTools } from "./tools/memory.js";
import { registerTerrainTools } from "./tools/terrain.js";
import { TaskOutcomeTracker } from "./status/outcomes.js";
import { buildStatusSnapshot } from "./status/snapshot.js";
import { StatusServer } from "./status/server.js";
import { ConnectionStateMachine } from "./agent/connection-state.js";
import { stopWorldPrimitives } from "./agent/world-actions.js";
import { EventHistory } from "./dashboard/event-history.js";
import { DashboardTelemetryCollector } from "./dashboard/telemetry.js";
import { startDashboard } from "./dashboard/lifecycle.js";
import { ViewerManager } from "./dashboard/viewer.js";
import { createPrismarineViewerAdapter } from "./dashboard/prismarine-adapter.js";
import { cachedPublicState } from "./dashboard/public-state.js";
import type { DashboardSnapshot } from "./dashboard/types.js";
import { enableCreativeFlight } from "./minecraft/mode.js";
import { DestructiveAuthorizationRegistry } from "./policy/destructive-authorization.js";
import { mineshaftExitRoute, TerrainProjectRunner } from "./skills/terrain-project.js";
import { setEscapeRouteProvider } from "./minecraft/movement.js";
import { normalizeDimension } from "./minecraft/protection.js";
import { SurvivalInterruptCoordinator } from "./agent/survival-interrupts.js";
import { ShutdownCoordinator, withTimeout } from "./agent/shutdown.js";

const config = loadConfig("config/minecraft.yaml");
const connectionState = new ConnectionStateMachine();

// Process-lifetime services. Only the bot session (below) is rebuilt per
// connection attempt; the DB, scheduler, and memory are opened once so a long
// server outage does not reopen SQLite and re-run migrations on every retry.
const bus = new EventBus();
const eventHistory = new EventHistory({ bus });
const db = new AppDatabase(config.storage?.db_path ?? "data/blockhead.db");
db.runMigrations(MIGRATIONS);
const locations = new LocationsRepository(db);
const taskStore = new TasksRepository(db);
const buildProjects = new WorldProjectsRepository(db);
const actions = new ActionsRepository(db);
const backgroundFailures = new BackgroundFailuresRepository(db);
// Bound historical task growth before rehydrating the scheduler, so an old
// blocked task cannot be loaded into memory immediately before being pruned.
const taskRetentionCutoff = new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString();
taskStore.pruneSettled(taskRetentionCutoff, 32);
// Goal layer: process-lifetime coordinator (bus-driven, no bot) over the
// persisted goals table, so an active autonomous goal survives a restart.
// It is wired to the scheduler so replacing a goal cancels the superseded
// goal's tasks (active step cooperatively, queued steps outright).
const goalsRepo = new GoalsRepository(db);
const state = new AgentState({ bus, locations, config });
state.boot();
// Anti-loop watchdog (generic, above every skill): fingerprints each action
// (task type + normalized arguments), blocks an action that failed too many
// times for a cooldown window, and feeds the block reasons to the LLM.
const watchdog = new ActionWatchdog({
  maxFailures: config.watchdog?.max_failures,
  cooldownMs: (config.watchdog?.cooldown_seconds ?? 600) * 1000,
  persistence: actions,
});
watchdog.rehydrate();
const scheduler = new Scheduler({
  bus,
  tasks: taskStore,
  watchdog,
  worldActionTimeoutMs: config.world_actions?.timeout_ms,
});
scheduler.loadFromPersistence();
const destructiveAuthorizations = new DestructiveAuthorizationRegistry();
const buildProjectManager = new WorldProjectManager(buildProjects, scheduler, bus, destructiveAuthorizations, () => state.worldId);
// Any trip that starts deep in a shaft the bot dug climbs out by its steps.
setEscapeRouteProvider((position, dimension) => {
  for (const project of buildProjects.loadMineshafts(config.server.world_key, normalizeDimension(dimension))) {
    if (project.payload.type !== "terrain") continue;
    const route = mineshaftExitRoute(project.payload.plan, position);
    if (route !== null) return route;
  }
  return null;
});
buildProjectManager.rehydrateAll();
const survivalInterrupts = new SurvivalInterruptCoordinator({ bus, scheduler, projects: buildProjectManager });
const goals = new GoalManager({ bus, goals: goalsRepo, scheduler });

// Phase 4: the LLM only selects registered high-level tools; deterministic
// code (the movement tools) performs the mechanics.
const registry = new ToolRegistry();
registerMovementTools(registry);

const llm = config.llm ?? {
  base_url: "http://127.0.0.1:8080",
  request_timeout_ms: 30000,
  http_retries: 1,
  schema_retries: 1,
};
const debugLog = new DebugLog();
const client = new LlamaClient({
  baseUrl: llm.base_url,
  timeoutMs: llm.request_timeout_ms,
  maxRetries: llm.http_retries,
  onFailure: (failure) => debugLog.write({ event: `llm_${failure.kind}`, ...failure }),
});
const bootstrapStages = new BootstrapRepository(db);
const skills = new SkillsRepository(db);
// Phase 13 (spec 20.2 / 42): recent skill-library runs seed the decision
// few-shots when available (static prompts/decision.md examples fill the rest).
const decider = new DecisionMaker({ client, registry, debugLog, maxRetries: llm.schema_retries, skills });

const storage = new StorageRepository(db);
const sites = new ResourceSitesRepository(db);
const deaths = new DeathEventsRepository(db);

// Tool registration is process-lifetime: the registry rejects duplicates and
// both registration functions resolve their per-session runners through the
// tool context at call time, so reconnect builds no stale registrations.
registerBootstrapTools(registry);
registerResourceTools(registry, scheduler);
// Phase 11: storage tools (spec 14.4). Like the others, registered once; the
// repository and scheduler are process-lifetime singletons.
registerStorageTools(registry, scheduler, storage, locations);
// Central stockpile base: the shed the chests, table, and furnace stockpile in.
registerBaseTools(registry, scheduler, buildProjectManager);
registerBuildDesignTool(registry, scheduler, buildProjectManager);
// Phase 13 (spec 14): the expanded tool set. Handlers enqueue FOREGROUND
// scheduler tasks exactly like the resource tools; every mechanic stays in
// deterministic skills. The memory/location tools act on the repository.
registerAcquisitionTools(registry, scheduler);
registerFoodTools(registry, scheduler);
registerCombatTools(registry, scheduler);
registerNavigationTools(registry, scheduler, locations);
registerDeliveryTools(registry, scheduler);
registerUtilityTools(registry, scheduler, deaths);
registerMemoryTools(registry, locations);
registerTerrainTools(registry, scheduler, buildProjectManager);
// Goal layer: start_goal / cancel_goal turn owner objectives into the one
// persistent autonomous goal the background driver pursues.
registerGoalTools(registry, goals);

// Phase 10: death coordination is bus-only (no bot), so one instance outlives
// connection attempts and recovery tracking survives a reconnect.
const deathManager = new DeathRecoveryManager({ bus, scheduler, state, deaths, config, logger });
const taskOutcomes = new TaskOutcomeTracker({ bus });

// Long projects run across many slices; tell the owner when one finishes or
// stalls instead of leaving them to guess from silence.
function announceProject(message: string): void {
  try { session?.bot.chat(message); } catch { /* chat is best effort */ }
}
bus.on("world_project.completed", ({ project }) => {
  if (project.source !== "user") return;
  const checked = typeof project.verificationState.verified === "number" ? ` (${project.verificationState.verified} cells checked)` : "";
  announceProject(`Finished the ${project.kind}${checked}.`);
});
bus.on("world_project.blocked", ({ project }) => {
  if (project.source !== "user") return;
  announceProject(`The ${project.kind} is stuck: ${project.lastError ?? "unknown problem"}. Tell me to try again once it's sorted.`);
});
bus.on("build_project.verified", ({ project }) => {
  if (project.source !== "user") return;
  announceProject(`The ${project.structureType.replace(/_/g, " ")} is finished and checked.`);
});
const processStartedAt = Date.now();
let statusServer: StatusServer | null = null;
let dashboardServer: ReturnType<typeof startDashboard> = null;
const viewerManager = new ViewerManager({
  enabled: config.dashboard?.viewer_enabled ?? false,
  port: config.dashboard?.viewer_port ?? 3001,
  distance: config.dashboard?.viewer_distance ?? 6,
  dashboardPort: config.dashboard?.port ?? 3000,
  adapter: createPrismarineViewerAdapter({
    host: config.dashboard?.viewer_host ?? "127.0.0.1",
    publicViewer: config.dashboard?.public_viewer?.enabled === true
      ? { port: config.dashboard.public_viewer.port, maxConnections: config.dashboard.public_viewer.max_connections }
      : null,
    // Redacted allowlist of the dashboard snapshot; see dashboard/public-state.ts.
    publicState: cachedPublicState((): DashboardSnapshot | Promise<DashboardSnapshot> => dashboardTelemetry.snapshot()),
    logger,
  }),
  logger,
});

// The live bot session. `shutdown` and the bootstrap-resume hooks act on the
// session currently being attempted; between attempts this is null.
interface Session {
  bot: Bot;
  background: BackgroundManager;
  /** Phase 12: session-scoped hostile sensor feeding the dashboard. */
  hostile: HostileTracker;
  /** Phase 12: session-scoped stockpile manager (dashboard readout). */
  maintenance: StockpileManager;
  dispatcher: TaskDispatcher;
  /** Fights back when a hostile attacks or closes in. */
  selfDefense: SelfDefenseReflex;
}
let session: Session | null = null;
let currentBootstrap: BootstrapRunner | null = null;

// Phase 1 dashboard telemetry is process-lifetime and read-only. It is
// constructed now so future dashboard transports can consume the same
// reconnect-safe snapshot without owning or mutating agent services.
const dashboardTelemetry = new DashboardTelemetryCollector({
  config,
  startedAtMs: processStartedAt,
  bot: () => session?.bot ?? null,
  maintenance: () => session?.maintenance ?? null,
  hostile: () => session?.hostile ?? null,
  state,
  scheduler,
  buildProjects: buildProjectManager,
  worldProjects: buildProjectManager,
  goals: () => goals,
  decider,
  client,
  eventHistory,
  viewer: () => viewerManager.telemetry(),
});

// Phase 12 (spec 33): the development dashboard runs for the whole process,
// across connect attempts, and reads session state through getters. It owns
// the terminal only when stdout is a TTY and the config allows it.
const tui = new TuiApp({
  bus,
  state,
  scheduler,
  decider,
  client,
  config,
  bot: () => session?.bot ?? null,
  maintenance: () => session?.maintenance ?? null,
  hostile: () => session?.hostile ?? null,
  goals: () => goals,
});
if (shouldEnableTui(config, detectStdoutIsTty())) {
  setLogEcho(false);
  tui.start();
}

statusServer = new StatusServer({
  host: config.status?.host ?? "127.0.0.1",
  port: config.status?.port ?? 8155,
  logger,
  status: () => buildStatusSnapshot({
    startedAtMs: processStartedAt,
    player: session?.bot.username ?? null,
    connected: session?.bot.entity !== null && session?.bot.entity !== undefined,
    state: { self: state.self, timePhase: state.timePhase },
    scheduler,
    goal: goals.active(),
    decider,
    client: { endpoint: client.endpoint, modelName: client.modelName, healthState: client.healthState, reachable: client.healthState === "unknown" ? null : client.healthState === "ok", lastSuccessAt: client.lastSuccessAt, consecutiveFailures: client.consecutiveFailures, lastFailure: client.lastFailure },
    inDeathLoop: deathManager.inDeathLoop,
    outcomes: taskOutcomes,
    buildProjects: buildProjectManager,
  }),
  operator: {
    // Local operator channel: identical to the owner typing in chat, so the
    // whole deterministic + LLM command path is exercised.
    command: (text) => {
      const bot = session?.bot;
      if (bot === undefined || bot.entity === null || bot.entity === undefined) throw new Error("bot not connected");
      if (text.length === 0) throw new Error("empty command");
      (bot.emit as (event: string, ...args: unknown[]) => boolean)("chat", config.agent?.owner ?? "Corey", text, null, null, null);
      return `delivered as ${config.agent?.owner ?? "Corey"}: ${text}`;
    },
  },
});
if (config.status?.enabled ?? true) statusServer.start();

dashboardServer = startDashboard({
  enabled: config.dashboard?.enabled ?? true,
  host: config.dashboard?.host ?? "127.0.0.1",
  port: config.dashboard?.port ?? 3000,
  logger,
  snapshot: () => dashboardTelemetry.snapshot(),
});

process.on("exit", () => {
  taskOutcomes.dispose();
  eventHistory.dispose();
});

// Phase 8: bootstrap yielded to user work resumes when that work settles —
// the runner is idempotent and resumes from the persisted stage boundary.
const resumeBootstrapIfPending = (): void => {
  if (shuttingDown()) return;
  if (currentBootstrap !== null && currentBootstrap.currentStage !== null) {
    void currentBootstrap.run().catch((err: unknown) => {
      if (String(err).includes("yielded to owner work")) logger.info("bootstrap paused for owner work");
      else logger.error({ err: String(err) }, "supervised bootstrap resume failed");
    });
  }
};
// Owner work never waits behind a multi-minute bootstrap stage.
bus.on("task.created", ({ task }) => {
  if (task.source === "user" && currentBootstrap?.isRunning === true) currentBootstrap.yieldNow();
});
bus.on("task.completed", resumeBootstrapIfPending);
bus.on("task.failed", resumeBootstrapIfPending);
bus.on("task.cancelled", resumeBootstrapIfPending);

// Process shutdown (SIGTERM from `systemctl --user stop`, Ctrl-C in a
// terminal). Every step is time-bounded and a hard timer backs the whole
// sequence: a skill that ignores its abort signal must not hold the process
// until systemd's stop timeout SIGKILLs it (2026-09-27 on maia). The maia
// unit's TimeoutStopSec is 10s; the step bounds below sum to ~7s.
const SHUTDOWN_HARD_TIMEOUT_MS = 8_000;
const shutdownCoordinator = new ShutdownCoordinator({
  logger,
  hardTimeoutMs: SHUTDOWN_HARD_TIMEOUT_MS,
  steps: () => {
    const active = session;
    const bootstrapRunner = currentBootstrap;
    return [
      {
        name: "stop background work",
        run: () => {
          // No new task may start while the active one drains: settling it
          // would otherwise claim the next queued task.
          scheduler.halt();
          viewerManager.stop();
          if (active !== null) {
            viewerManager.stopFor(active.bot);
            active.background.stop();
            active.hostile.detach();
            active.selfDefense.detach();
          }
          goals.dispose();
          survivalInterrupts.dispose();
        },
      },
      {
        name: "abort active task",
        timeoutMs: 3000,
        run: async () => {
          // A service restart is operational, not an owner cancellation:
          // pause (abort the run's signal) so the task stays resumable. A
          // task that never settles is still ACTIVE in SQLite, which the next
          // process rehydrates and resumes like a crash.
          scheduler.requestPause();
          await Promise.all([
            bootstrapRunner?.stop(),
            active?.dispatcher.waitForIdle(),
          ]);
        },
      },
      {
        name: "stop world primitives",
        timeoutMs: 1000,
        run: async () => { if (active !== null) await stopWorldPrimitives(active.bot); },
      },
      {
        name: "disconnect bot",
        timeoutMs: 2000,
        run: async () => {
          if (active === null) return;
          const bot = active.bot;
          const ended = new Promise<void>((resolve) => { bot.once("end", () => resolve()); });
          try { bot.quit("shutting down"); } catch { /* socket may already be gone */ }
          if (await withTimeout(ended, 1500) === "timeout") {
            // The server never acknowledged: drop the TCP connection.
            bot._client.socket?.destroy();
          }
        },
      },
      {
        name: "close servers",
        run: () => {
          statusServer?.stop();
          dashboardServer?.stop();
          tui.stop();
          taskOutcomes.dispose();
        },
      },
      {
        name: "close database",
        run: () => {
          const checkpoint = db.checkpoint();
          db.close();
          logger.info({ checkpoint }, "database checkpointed and closed");
        },
      },
      {
        name: "close logs",
        timeoutMs: 1000,
        run: async () => {
          logger.info("shutdown complete; exiting");
          await Promise.all([debugLog.close(), closeLogs()]);
        },
      },
    ];
  },
});
function shuttingDown(): boolean { return shutdownCoordinator.inProgress; }

process.on("SIGINT", () => shutdownCoordinator.handleSignal("SIGINT"));
process.on("SIGTERM", () => shutdownCoordinator.handleSignal("SIGTERM"));

/**
 * Build one full bot session (bot + its skill graph) and run it until the
 * connection ends. Returns whether CobbleBob ever reached spawn.
 */
async function runSession(): Promise<"spawned" | "never-connected"> {
  connectionState.transition("CONNECTING");
  const bot = createCobbleBob(config);
  let spawned = false;
  const onEnded = new Promise<void>((resolve) => {
    bot.once("end", () => resolve());
  });

  // Phase 5.6: the bootstrap state machine. The runner persists each completed
  // stage (spec 7.2), so a restart resumes from exactly where bootstrap stopped.
  // Completing the last stage persists NORMAL_OPERATION, the "bootstrap done"
  // signal Phase 7 stockpile maintenance hooks into.
  const bootstrap = new BootstrapRunner({
    bot,
    state,
    config,
    bus,
    scheduler,
    stages: bootstrapStages,
    storage,
    skills,
    logger,
    // Phase 8: yield between stages when any task is active (including a
    // rehydrated task resumed at spawn) or an interrupt is pending; the
    // persisted stage boundary makes a later resume safe.
    shouldYield: () => scheduler.active !== null || scheduler.interruptPending,
  });

  // Phase 6: resource gathering. The runner searches with the uniform radius
  // contract, gathers deterministically, returns home, deposits into the home
  // chest (spec 23), and records SkillSuccess entries (spec 20.2).
  const collect = new CollectResourceRunner({
    bot,
    state,
    config,
    bus,
    storage,
    sites,
    skills,
    logger,
  });

  // Phase 7: background stockpile maintenance + idle proposal (spec 4.3, 29).
  // The runners are deterministic skills; the manager measures carried + home-
  // chest stock and restores deficits at BACKGROUND priority, and the
  // coordinator runs the gated idle loop, including the restricted Section
  // 4.3.1 proposal when fully healthy.
  const food = new GatherFoodRunner({ bot, state, config, bus, storage, skills, logger });
  const torches = new EnsureTorchesRunner({ bot, state, config, bus, storage, skills, logger });
  const maintenance = new StockpileManager({ bot, state, config, bus, storage, scheduler, collect, food, torches, logger });

  // Phase 11: storage organization (spec 14.4, 22). The runner measures every
  // registered home chest, creates new chests when storage is full or a
  // category is disorganized, and moves items into the chest of their
  // category. The LLM only picks the tools; every craft, placement, and move
  // is deterministic code.
  const organizeStorage = new OrganizeStorageRunner({ bot, state, config, bus, storage, skills, logger });

  // Central stockpile base (spec 4.3 "improve basic infrastructure"): the
  // builder measures the shed (plank walls, roof, door), gathers planks, and
  // places the missing cells. Chests, the table, and the furnace land on its
  // blueprint slots, so the stockpile grows at one centralized location
  // instead of a scatter pile at the home column.
  const buildBase = new BaseBuilderRunner({ bot, state, config, bus, skills, logger, collect });

  // Phase 10: death recovery (spec 26). A death is recorded (site, dimension,
  // time) and ordinary work pauses; on respawn an EMERGENCY-priority task runs
  // the deterministic value-ordered recovery sweep, records the outcome, and
  // re-equips before the scheduler resumes the paused work.
  const deathRecovery = new DeathRecoveryRunner({ bot, state, config, bus, storage, deaths, skills, logger });

  // Phase 13 (spec 14): the expanded skill set. `ensure_item` composes the
  // gather/hunt runners plus crafting and smelting; defense, utility, and
  // delivery runners cover the remaining tools. Every one is deterministic
  // and one-at-a-time; the LLM only picks the registered tool name.
  const ensureItem = new EnsureItemRunner({ bot, state, config, bus, storage, sites, skills, collect, food, logger });
  maintenance.setCharcoalProducer((quantity, signals) => ensureItem.run("charcoal", quantity, { mode: "ensure", signals }));
  const defense = new DefenseRunner({ bot, state, config, bus, skills, logger });
  const utility = new UtilityRunner({ bot, state, config, storage, logger });
  const delivery = new DeliveryRunner({ bot, state, config, storage, logger });

  // Phase 8: the single executor binding scheduler tasks to skills. Subscribes
  // to `task.activated`, so the preemption cascade starts the next task the
  // moment the previous one settles.
  const terrainProjects = new TerrainProjectRunner(bot, { logger });
  const dispatcher = new TaskDispatcher({ bus, scheduler, state, bot, config, maintenance, storage, collect, food, torches, deathRecovery, organizeStorage, buildBase, ensureItem, defense, utility, delivery, buildProjects: buildProjectManager, terrainProjects, destructiveAuthorizations, watchdog, logger });

  const background = new BackgroundManager({ bot, state, config, bus, scheduler, maintenance, collect, decider, bootstrap, organizeStorage, buildBase, storage, tasks: taskStore, backgroundFailures, goals, buildProjects: buildProjectManager, logger, inDeathLoop: () => deathManager.inDeathLoop });
  background.start();

  // Phase 12: the session's hostile sensor emits `hostile.detected` (spec 33
  // EVENT example) and feeds the dashboard's danger score. Session-scoped like
  // the rest of the bot wiring; detached when the connection ends.
  const hostile = new HostileTracker(bot, bus);
  hostile.attach();
  const selfDefense = new SelfDefenseReflex({ bot, bus, scheduler, logger });
  selfDefense.attach();
  session = { bot, background, hostile, maintenance, dispatcher, selfDefense };
  currentBootstrap = bootstrap;

  registerEvents(bot, config, logger, {
    bus,
    state,
    scheduler,
    registry,
    decider,
    owner: config.agent?.owner ?? "Corey",
    bootstrap,
    tasks: taskStore,
    storage,
    maintenance,
    goals,
    worldProjects: buildProjectManager,
  });

  // Bootstrap runs on first spawn; the runner is resumable and idempotent, so a
  // tool call or a later restart simply continues from the persisted stage.
  bot.once("spawn", () => {
    spawned = true;
    // A connect that completes mid-shutdown must not start any work.
    if (shuttingDown()) return;
    if (enableCreativeFlight(bot)) logger.info("creative mode detected; flight enabled");
    void viewerManager.startFor(bot);
    connectionState.transition("SPAWNED");
    void bootstrap.run().catch((err: unknown) => {
      if (String(err).includes("yielded to owner work")) logger.info("bootstrap paused for owner work");
      else logger.error({ err: String(err) }, "supervised bootstrap run failed");
    });
    // Phase 8: with the world available, resume a rehydrated ACTIVE task
    // (crashed mid-skill) from its persisted resume state, then reclaim the
    // queue so paused user work continues.
    if (scheduler.active !== null) {
      dispatcher.executeTracked(scheduler.active);
    }
    scheduler.activateNext();
    connectionState.transition("READY");
    connectionState.markStable();
  });

  await onEnded;

  // Bootstrap is session-scoped but the scheduler/world lease is process-
  // scoped. Release the old session's bootstrap lease before reconnecting;
  // otherwise every queued task on the new bot can wait behind bootstrap:1.
  await bootstrap.stop();

  // Request cancellation before session resources are torn down. The active
  // task remains leased until its dispatcher promise settles.
  // A network disconnect is not an owner cancellation. Park the active task
  // with its persisted resume state so the next session can continue it.
  // Process shutdown has its own explicit cancellation path.
  scheduler.requestPause();
  await dispatcher.waitForIdle();
  // The end event requests cleanup concurrently; await the same serialized
  // adapter here so reconnect cannot detach the session before windows and
  // movement/combat/collection plugins have actually stopped.
  await stopWorldPrimitives(bot);
  if (connectionState.state === "READY" || connectionState.state === "SPAWNED") connectionState.transition("INTERRUPTING");

  // Connection is over (never connected, or the game dropped us): tear down
  // the session-bound wiring so the next attempt starts clean. A graceful
  // shutdown already stopped the background manager and detached the hostile
  // sensor via the shutdown coordinator.
  background.stop();
  hostile.detach();
  selfDefense.detach();
  dispatcher.dispose();
  session = null;
  currentBootstrap = null;
  if (connectionState.state === "INTERRUPTING") connectionState.transition("REINITIALIZING");
  if (connectionState.state !== "DISCONNECTED") connectionState.transition("DISCONNECTED");
  return spawned ? "spawned" : "never-connected";
}

/** Backoff between connect attempts, capped at one probe per minute. */
function retryDelayMs(attempt: number): number {
  return connectionState.failureDelayMs();
}

const sleep = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  // Not unref'd: between attempts this timer is the only thing keeping the
  // process alive, and an idle exit would abort the retry loop.
  setTimeout(resolve, ms);
  return promise;
};

// Connect loop. Initial failures and post-login disconnects share one
// supervised backoff loop; process-lifetime state survives server restarts.
let attempt = 0;
while (!shuttingDown()) {
  attempt += 1;
  const outcome = await runSession();
  if (shuttingDown()) break;
  if (outcome === "spawned") {
    logger.warn({ attempt }, "Minecraft connection ended; reconnecting with backoff");
  }
  const delayMs = retryDelayMs(attempt);
  logger.warn(
    {
      attempt,
      retryInSeconds: delayMs / 1000,
      server: `${config.server.host}:${config.server.port}`,
    },
    "could not connect to server; retrying",
  );
  await sleep(delayMs);
}
