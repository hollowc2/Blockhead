import type { BotState } from "../minecraft/bot.js";
import type { HomeLocation } from "../minecraft/movement.js";
import {
  createProtectedRegion,
  normalizeDimension,
  DEFAULT_HOME_REGION_NAME,
  type ProtectedRegion,
} from "../minecraft/protection.js";
import type { MinecraftConfig } from "../config/schema.js";
import type { EventBus } from "../events/bus.js";
import type { LocationsRepository } from "../memory/locations.js";

/** Hunger below this triggers the `hunger.low` event (edge-triggered). */
const HUNGER_LOW_THRESHOLD = 8;

/** Size of the recent-events ring buffer (spec 19: "last 5-8 significant events"). */
const MAX_RECENT_EVENTS = 8;

/** Current snapshot of the bot's self state. */
export interface SelfState {
  position: { x: number; y: number; z: number } | null;
  health: number;
  food: number;
  dimension: string | null;
}

export interface AgentStateOptions {
  bus: EventBus;
  locations: LocationsRepository;
  config: MinecraftConfig;
}

/**
 * Central in-memory agent state (spec sections 18-19).
 *
 * Boot resolves and caches world identity, home, and the protected region from
 * persistence (seeding from config on first run), so a restart reloads the
 * same home and region. Mineflayer observations are folded in via
 * `updateSelf`, which diffs and emits the relevant bus events.
 */
export class AgentState {
  private readonly bus: EventBus;
  private readonly locations: LocationsRepository;
  private readonly config: MinecraftConfig;

  private _self: SelfState = { position: null, health: 20, food: 20, dimension: null };
  private _timePhase: "day" | "night" | null = null;
  private _worldId: number | null = null;
  private _home: HomeLocation | null = null;
  private _homeRegion: ProtectedRegion | null = null;
  private _recentEvents: string[] = [];
  private _hungerLowActive = false;

  constructor(options: AgentStateOptions) {
    this.bus = options.bus;
    this.locations = options.locations;
    this.config = options.config;
  }

  // --- boot / persistence ---

  /**
   * Load persisted state (world identity, home, protected region), seeding
   * from config when nothing is stored yet. Idempotent; call once at startup.
   */
  boot(): void {
    const worldKey = this.config.server.world_key;
    const world = this.locations.getOrCreateWorld(this.serverKey, worldKey);
    this._worldId = world.id;

    const persistedHome = this.locations.getHome(world.id);
    const home =
      persistedHome ??
      ({
        dimension: normalizeDimension(this.config.home.dimension),
        x: this.config.home.x,
        y: this.config.home.y,
        z: this.config.home.z,
      } satisfies HomeLocation);
    if (!persistedHome) {
      this.locations.saveHome(world.id, home);
    }
    this._home = home;

    const persistedRegion = this.locations.getProtectedRegion(world.id, DEFAULT_HOME_REGION_NAME);
    const region =
      persistedRegion ??
      createProtectedRegion({
        name: DEFAULT_HOME_REGION_NAME,
        dimension: home.dimension,
        center: { x: home.x, z: home.z },
        sizeX: this.config.home.protected_size_x,
        sizeZ: this.config.home.protected_size_z,
      });
    if (!persistedRegion) {
      this.locations.saveProtectedRegion(world.id, region);
    }
    this._homeRegion = region;

    this.addEvent("booted at home");
  }

  /** `host:port`, part of the world identity key. */
  get serverKey(): string {
    return `${this.config.server.host}:${this.config.server.port}`;
  }

  get self(): SelfState {
    return this._self;
  }

  /** Current world-clock phase (null before the first day/night edge fires). */
  get timePhase(): "day" | "night" | null {
    return this._timePhase;
  }

  /**
   * Record the world-clock phase. Called from the mineflayer `time` handler,
   * which already edges day/night; the state keeps the phase so dashboards
   * and future day/night policy (spec 9) can read it without a bot.
   */
  setTimePhase(phase: "day" | "night"): void {
    this._timePhase = phase;
  }

  /** Stable world identity row id, or null before `boot()`. */
  get worldId(): number | null {
    return this._worldId;
  }

  get home(): HomeLocation | null {
    return this._home;
  }

  get protectedRegion(): ProtectedRegion | null {
    return this._homeRegion;
  }

  get recentEvents(): readonly string[] {
    return this._recentEvents;
  }

  // --- observation ---

  /** Fold a mineflayer state snapshot in; emits `health.changed` / `hunger.low` / `damage.received`. */
  updateSelf(snapshot: BotState): void {
    const previous = this._self;
    const healthChanged = snapshot.health !== previous.health;
    const foodChanged = snapshot.food !== previous.food;

    if (healthChanged && snapshot.health < previous.health) {
      this.bus.emit("damage.received", {
        damage: previous.health - snapshot.health,
        health: snapshot.health,
      });
    }
    if (healthChanged || foodChanged) {
      this.bus.emit("health.changed", { health: snapshot.health, food: snapshot.food });
    }

    this._self = {
      position: snapshot.position,
      health: snapshot.health,
      food: snapshot.food,
      dimension: snapshot.dimension ? normalizeDimension(snapshot.dimension) : null,
    };

    const low = snapshot.food <= HUNGER_LOW_THRESHOLD;
    if (low && !this._hungerLowActive) {
      this._hungerLowActive = true;
      this.bus.emit("hunger.low", { food: snapshot.food });
    }
    this._hungerLowActive = low;
  }

  /** (Re)set home: persists and keeps the protected region in sync with it. */
  setHome(home: HomeLocation): void {
    const worldId = this.requireWorldId();
    const normalized: HomeLocation = { ...home, dimension: normalizeDimension(home.dimension) };
    this.locations.saveHome(worldId, normalized);
    this._home = normalized;

    const region = createProtectedRegion({
      name: DEFAULT_HOME_REGION_NAME,
      dimension: normalized.dimension,
      center: { x: normalized.x, z: normalized.z },
      sizeX: this.config.home.protected_size_x,
      sizeZ: this.config.home.protected_size_z,
    });
    this.locations.saveProtectedRegion(worldId, region);
    this._homeRegion = region;

    this.addEvent(`home moved to (${normalized.x}, ${normalized.y}, ${normalized.z})`);
    this.bus.emit("home.changed", { home: normalized });
    this.bus.emit("protected_region.changed", { region });
  }

  /** Append a human-readable line to the recent-events ring buffer. */
  addEvent(message: string): void {
    this._recentEvents.push(message);
    if (this._recentEvents.length > MAX_RECENT_EVENTS) {
      this._recentEvents.shift();
    }
  }

  private requireWorldId(): number {
    if (this._worldId === null) {
      throw new Error("AgentState.boot() must run before persisting state");
    }
    return this._worldId;
  }
}
