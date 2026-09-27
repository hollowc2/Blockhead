import type { Task } from "../agent/task.js";
import type { Goal } from "../agent/goal.js";
import type { BootstrapStage } from "../agent/bootstrap.js";
import type { StockpileDeficit, StockpileKind } from "../agent/maintenance.js";
import type { HomeLocation } from "../minecraft/movement.js";
import type { ProtectedRegion } from "../minecraft/protection.js";
import type { BuildPhase, BuildProject } from "../memory/build-projects.js";
import type { WorldProject, WorldProjectPhase } from "../memory/world-projects.js";

/**
 * Internal event payloads. Payloads are plain data so listeners never depend
 * on live mineflayer objects; derived values are computed at emit time.
 *
 * Events come from the spec's event-driven architecture (section 18):
 * mineflayer events feed the bus, and the state manager / scheduler consume it.
 */

export interface ChatCommandEvent {
  from: string;
  command: string;
}

export interface HealthChangedEvent {
  health: number;
  food: number;
}

export interface HungerLowEvent {
  food: number;
}

export interface DamageReceivedEvent {
  damage: number;
  health: number;
}

export interface HostileDetectedEvent {
  type: string;
  /** Blocks to the spawn site; null when the bot had no position yet. */
  distance: number | null;
}

export interface InventoryChangedEvent {
  freeSlots: number;
}

export interface InventoryFullEvent {
  freeSlots: number;
}

export interface ToolDurabilityEvent {
  item: string;
  durability: number;
}

/** Lifecycle events carry the persisted task so listeners can introspect it. */
export interface TaskEvent {
  task: Task;
}

/** Goal lifecycle events carry the persisted goal (see the goal layer, spec goals). */
export interface GoalEvent {
  goal: Goal;
}

export interface BuildProjectEvent {
  project: BuildProject;
  phase?: BuildPhase;
  task?: Task;
}

export interface WorldProjectEvent {
  project: WorldProject;
  phase?: WorldProjectPhase;
  task?: Task;
}

export interface DeathEvent {
  dimension: string | null;
  /** Death site; null only when the bot had no known position at the moment of death. */
  position: { x: number; y: number; z: number } | null;
  /**
   * The entity that dealt the fatal blows, when mineflayer saw it (mob or
   * player; `entityHurt` source within the window before death), with its
   * last known position. Null when the death was not mob-caused or unseen.
   */
  killer: { name: string; x: number; y: number; z: number } | null;
  /** Name -> count carried at the moment of death (what the corpse will drop). */
  inventory: Record<string, number>;
}

/** A death was persisted (Phase 10); recovery may follow or be skipped. */
export interface DeathRecordedEvent {
  deathId: number;
  /** Name -> count carried at death — the corpse contents. */
  inventory: Record<string, number>;
  /**
   * True when the corpse holds something a recovery trip should sweep.
   * False means the trip was skipped at death time (nothing worth carrying).
   */
  worthRecovering: boolean;
  /** Why recovery was skipped without a trip (null when it will run). */
  skipReason: "nothing_carried" | "only_expendable_items" | null;
}

/** Phase 10: a death-recovery attempt finished, recovered or failed. */
export interface DeathRecoveryCompletedEvent {
  deathId: number;
  recovered: boolean;
  failureReason: string | null;
  pickedUp: Record<string, number>;
  dropsFound: number;
  durationMs: number;
}

/**
 * Phase 10 death-loop brake: repeated same-site deaths put the bot into a
 * respawn kill zone; recovery stands down until the site changes or the
 * brake window expires.
 */
export interface DeathLoopDetectedEvent {
  deathId: number;
  /** Site whose rapid deaths triggered the brake. */
  x: number;
  y: number;
  z: number;
  /** Consecutive rapid deaths observed at that site. */
  consecutiveDeaths: number;
  /** What killed the bot, when known (e.g. "zombie"). */
  killer: string | null;
}

export interface TimeEvent {
  time: "day" | "night";
}

export interface HomeChangedEvent {
  home: HomeLocation;
}

export interface ProtectedRegionChangedEvent {
  region: ProtectedRegion;
}

/** One stage of the bootstrap state machine completed. */
export interface BootstrapStageEvent {
  stage: BootstrapStage;
  note: string;
}

/** The implemented bootstrap scope finished (Phase 5.6: through IRON_TOOLS). */
export interface BootstrapCompleteEvent {
  completedStages: BootstrapStage[];
}

/** A bootstrap stage exhausted its retries; the run stops, resumable later. */
export interface BootstrapFailedEvent {
  stage: BootstrapStage;
  reason: string;
}

/** A `collect_resource` run started (Phase 6). */
export interface ResourceGatherStartedEvent {
  resource: string;
  quantity: number;
}

/** A `collect_resource` run ended with a terminal status. */
export interface ResourceGatherCompleteEvent {
  resource: string;
  quantity: number;
  gathered: number;
  delivered: number;
  status: "completed" | "partial" | "blocked" | "failed" | "interrupted";
}

/** A `collect_resource` run stopped before gathering anything. */
export interface ResourceGatherFailedEvent {
  resource: string;
  quantity: number;
  reason: string;
}

/** A periodic background stockpile measurement (spec 32.2 target status). */
export interface StockpileCheckedEvent {
  levels: Record<StockpileKind, number>;
  targets: Record<StockpileKind, number>;
  deficits: StockpileDeficit[];
}

/** A periodic home-storage measurement (Phase 11: capacity + organization state). */
export interface StorageCheckedEvent {
  chests: number;
  slotsUsed: number;
  slotsTotal: number;
  /** True when the background loop should run an organize/expand pass. */
  needsWork: boolean;
}

/** A periodic base-structure measurement (the `build_base` probe). */
export interface StructureCheckedEvent {
  /** Wall cells still air (placeable). */
  missingWalls: number;
  /** Roof cells still air (placeable). */
  missingRoof: number;
  /** True when the door gap is empty and a door can be placed. */
  doorMissing: boolean;
  /** True when the background loop should run a build/repair pass. */
  needsWork: boolean;
}

/** The background director chose a next task (spec 4.3). */
export interface DirectorDecidedEvent {
  task: string;
  rationale: string | null;
}

/** CobbleBob crossed the expedition threshold with supplies verified (Phase 9). */
export interface ExpeditionEnteredEvent {
  /** Straight-line distance from home when the expedition started. */
  distanceFromHome: number;
  /** Risk band the starting distance falls into. */
  tier: "near" | "expedition" | "deep";
}

/** Expedition entry was refused: a supply check did not pass (Phase 9). */
export interface ExpeditionDeniedEvent {
  distanceFromHome: number;
  /** One failure per unmet supply requirement. */
  failures: string[];
}

/** The bot is back within the expedition threshold; expedition policy ends (Phase 9). */
export interface ExpeditionLeftEvent {
  distanceFromHome: number;
}

export interface EventMap {
  "chat.command": ChatCommandEvent;
  "health.changed": HealthChangedEvent;
  "hunger.low": HungerLowEvent;
  "damage.received": DamageReceivedEvent;
  "hostile.detected": HostileDetectedEvent;
  "inventory.changed": InventoryChangedEvent;
  "inventory.full": InventoryFullEvent;
  "tool.low_durability": ToolDurabilityEvent;
  "tool.broken": ToolDurabilityEvent;
  "task.created": TaskEvent;
  "task.activated": TaskEvent;
  "task.blocked": TaskEvent;
  "task.completed": TaskEvent;
  "task.failed": TaskEvent;
  "task.cancelled": TaskEvent;
  "task.paused": TaskEvent;
  "task.requeued": TaskEvent;
  "goal.started": GoalEvent;
  "goal.completed": GoalEvent;
  "goal.blocked": GoalEvent;
  "goal.cancelled": GoalEvent;
  "build_project.created": BuildProjectEvent;
  "build_project.rehydrated": BuildProjectEvent;
  "build_project.scheduled": BuildProjectEvent;
  "build_project.phase_changed": BuildProjectEvent;
  "build_project.slice_checkpointed": BuildProjectEvent;
  "build_project.blocked": BuildProjectEvent;
  "build_project.verified": BuildProjectEvent;
  "world_project.created": WorldProjectEvent;
  "world_project.rehydrated": WorldProjectEvent;
  "world_project.scheduled": WorldProjectEvent;
  "world_project.phase_changed": WorldProjectEvent;
  "world_project.blocked": WorldProjectEvent;
  "world_project.completed": WorldProjectEvent;
  "world_project.cancelled": WorldProjectEvent;
  death: DeathEvent;
  respawn: Record<string, never>;
  "death.recorded": DeathRecordedEvent;
  "death.recovery.completed": DeathRecoveryCompletedEvent;
  "death.loop_detected": DeathLoopDetectedEvent;
  "time.night": TimeEvent;
  "time.day": TimeEvent;
  "home.changed": HomeChangedEvent;
  "protected_region.changed": ProtectedRegionChangedEvent;
  "bootstrap.stage": BootstrapStageEvent;
  "bootstrap.complete": BootstrapCompleteEvent;
  "bootstrap.failed": BootstrapFailedEvent;
  "resource.gather.started": ResourceGatherStartedEvent;
  "resource.gather.complete": ResourceGatherCompleteEvent;
  "resource.gather.failed": ResourceGatherFailedEvent;
  "stockpile.checked": StockpileCheckedEvent;
  "storage.checked": StorageCheckedEvent;
  "structure.checked": StructureCheckedEvent;
  "director.decided": DirectorDecidedEvent;
  "expedition.entered": ExpeditionEnteredEvent;
  "expedition.denied": ExpeditionDeniedEvent;
  "expedition.left": ExpeditionLeftEvent;
}

export type EventName = keyof EventMap;

export type EventPayload<K extends EventName> = EventMap[K];
