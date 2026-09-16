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
import { BackgroundFailuresRepository } from "./memory/background-failures.js";
import { GoalsRepository } from "./memory/goals.js";
import { ResourceSitesRepository } from "./memory/resource-sites.js";
import { DeathEventsRepository } from "./memory/deaths.js";
import { AgentState } from "./agent/state.js";
import { Scheduler } from "./agent/scheduler.js";
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
import { registerAcquisitionTools } from "./tools/acquire.js";
import { registerFoodTools } from "./tools/food.js";
import { registerCombatTools } from "./tools/combat.js";
import { registerNavigationTools } from "./tools/navigation.js";
import { registerDeliveryTools } from "./tools/delivery.js";
import { registerUtilityTools } from "./tools/utility.js";
import { registerMemoryTools } from "./tools/memory.js";
import { TaskOutcomeTracker } from "./status/outcomes.js";
import { buildStatusSnapshot } from "./status/snapshot.js";
import { StatusServer } from "./status/server.js";

const config = loadConfig("config/minecraft.yaml");

// Process-lifetime services. Only the bot session (below) is rebuilt per
// connection attempt; the DB, scheduler, and memory are opened once so a long
// server outage does not reopen SQLite and re-run migrations on every retry.
const bus = new EventBus();
const db = new AppDatabase(config.storage?.db_path ?? "data/blockhead.db");
db.runMigrations(MIGRATIONS);
const locations = new LocationsRepository(db);
const taskStore = new TasksRepository(db);
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
const scheduler = new Scheduler({ bus, tasks: taskStore, watchdog });
scheduler.loadFromPersistence();
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
registerBaseTools(registry, scheduler);
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
// Goal layer: start_goal / cancel_goal turn owner objectives into the one
// persistent autonomous goal the background driver pursues.
registerGoalTools(registry, goals);

// Phase 10: death coordination is bus-only (no bot), so one instance outlives
// connection attempts and recovery tracking survives a reconnect.
const deathManager = new DeathRecoveryManager({ bus, scheduler, state, deaths, config, logger });
const taskOutcomes = new TaskOutcomeTracker({ bus });
const processStartedAt = Date.now();
let statusServer: StatusServer | null = null;

// The live bot session. `shutdown` and the bootstrap-resume hooks act on the
// session currently being attempted; between attempts this is null.
interface Session {
  bot: Bot;
  background: BackgroundManager;
  /** Phase 12: session-scoped hostile sensor feeding the dashboard. */
  hostile: HostileTracker;
  /** Phase 12: session-scoped stockpile manager (dashboard readout). */
  maintenance: StockpileManager;
}
let session: Session | null = null;
let currentBootstrap: BootstrapRunner | null = null;

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
  }),
});
if (config.status?.enabled ?? true) statusServer.start();

process.on("exit", () => taskOutcomes.dispose());

// Phase 8: bootstrap yielded to user work resumes when that work settles —
// the runner is idempotent and resumes from the persisted stage boundary.
const resumeBootstrapIfPending = (): void => {
  if (currentBootstrap !== null && currentBootstrap.currentStage !== null) {
    void currentBootstrap.run().catch((err: unknown) => {
      logger.error({ err: String(err) }, "supervised bootstrap resume failed");
    });
  }
};
bus.on("task.completed", resumeBootstrapIfPending);
bus.on("task.failed", resumeBootstrapIfPending);
bus.on("task.cancelled", resumeBootstrapIfPending);

let shuttingDown = false;
function shutdown(code: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  const active = session;
  if (active !== null) {
    active.background.stop();
    active.hostile.detach();
    active.bot.quit();
  }
  goals.dispose();
  taskOutcomes.dispose();
  statusServer?.stop();
  tui.stop();
  db.close();
  debugLog.close();
  closeLogs();
  if (active !== null) {
    active.bot.once("end", () => process.exit(code));
    setTimeout(() => process.exit(code), 2000).unref();
  } else {
    process.exit(code);
  }
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

/**
 * Build one full bot session (bot + its skill graph) and run it until the
 * connection ends. Returns whether CobbleBob ever reached spawn.
 */
async function runSession(): Promise<"spawned" | "never-connected"> {
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
  const buildBase = new BaseBuilderRunner({ bot, state, config, bus, skills, logger });

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
  const defense = new DefenseRunner({ bot, state, config, bus, skills, logger });
  const utility = new UtilityRunner({ bot, state, config, storage, logger });
  const delivery = new DeliveryRunner({ bot, state, config, storage, logger });

  // Phase 8: the single executor binding scheduler tasks to skills. Subscribes
  // to `task.activated`, so the preemption cascade starts the next task the
  // moment the previous one settles.
  const dispatcher = new TaskDispatcher({ bus, scheduler, state, bot, config, maintenance, collect, food, torches, deathRecovery, organizeStorage, buildBase, ensureItem, defense, utility, delivery, watchdog, logger });

  const background = new BackgroundManager({ bot, state, config, bus, scheduler, maintenance, collect, decider, bootstrap, organizeStorage, buildBase, storage, tasks: taskStore, backgroundFailures, goals, logger, inDeathLoop: () => deathManager.inDeathLoop });
  background.start();

  // Phase 12: the session's hostile sensor emits `hostile.detected` (spec 33
  // EVENT example) and feeds the dashboard's danger score. Session-scoped like
  // the rest of the bot wiring; detached when the connection ends.
  const hostile = new HostileTracker(bot, bus);
  hostile.attach();
  session = { bot, background, hostile, maintenance };
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
  });

  // Bootstrap runs on first spawn; the runner is resumable and idempotent, so a
  // tool call or a later restart simply continues from the persisted stage.
  bot.once("spawn", () => {
    spawned = true;
    void bootstrap.run().catch((err: unknown) => {
      logger.error({ err: String(err) }, "supervised bootstrap run failed");
    });
    // Phase 8: with the world available, resume a rehydrated ACTIVE task
    // (crashed mid-skill) from its persisted resume state, then reclaim the
    // queue so paused user work continues.
    if (scheduler.active !== null) {
      void dispatcher.execute(scheduler.active);
    }
    scheduler.activateNext();
  });

  await onEnded;

  // Request cancellation before session resources are torn down. The active
  // task remains leased until its dispatcher promise settles.
  scheduler.requestCancel();

  // Connection is over (never connected, or the game dropped us): tear down
  // the session-bound wiring so the next attempt starts clean. A graceful
  // shutdown already stopped the background manager and detached the hostile
  // sensor via `shutdown`.
  background.stop();
  hostile.detach();
  dispatcher.dispose();
  session = null;
  currentBootstrap = null;
  return spawned ? "spawned" : "never-connected";
}

/** Backoff between connect attempts, capped at one probe per minute. */
const RETRY_DELAY_MS: readonly number[] = [5_000, 10_000, 20_000, 40_000, 60_000];
function retryDelayMs(attempt: number): number {
  // The clamp keeps the index inside the array, so the element is always set.
  return RETRY_DELAY_MS[Math.min(attempt - 1, RETRY_DELAY_MS.length - 1)]!;
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
while (!shuttingDown) {
  attempt += 1;
  const outcome = await runSession();
  if (shuttingDown) break;
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
