import type { Bot } from "mineflayer";
import type { AppDatabase } from "../memory/database.js";
import { normalizeDimension } from "../minecraft/protection.js";

/**
 * The private viewer's map: everything CobbleBob remembers about the place
 * he is in (home, named spots, resource sites, chests, deaths) plus where he
 * is, where he is headed, the route the pathfinder planned and the trail he
 * actually walked. Private only: every value here is a world coordinate.
 */

export type MapPoint = [x: number, z: number];
export interface MapMarker { x: number; y: number; z: number; label: string; detail?: string | null; at?: string | null }

export interface OwnerMapView {
  dimension: string | null;
  bob: { x: number; y: number; z: number; yaw: number } | null;
  home: MapMarker | null;
  locations: readonly MapMarker[];
  resources: readonly (MapMarker & { depleted: boolean })[];
  chests: readonly MapMarker[];
  deaths: readonly (MapMarker & { recovered: boolean })[];
  build: MapMarker | null;
  destination: MapMarker | null;
  /** The pathfinder's current plan, Bob → destination. */
  path: readonly MapPoint[];
  /** Where Bob actually walked recently, oldest first. */
  trail: readonly MapPoint[];
}

const TRAIL_POINTS = 600;
const TRAIL_STEP = 1.5;
const PATH_POINTS = 400;

interface PathNode { x: number; y: number; z: number }

/** Session-scoped: records the walked trail and the planned path of one bot. */
export class RouteTracker {
  private readonly trail: MapPoint[] = [];
  private path: MapPoint[] = [];
  private readonly detach: Array<() => void> = [];

  constructor(private readonly bot: Bot) {
    const on = (event: string, handler: (...args: never[]) => void): void => {
      (bot.on as (event: string, handler: (...args: never[]) => void) => void)(event, handler);
      this.detach.push(() => (bot.removeListener as (event: string, handler: (...args: never[]) => void) => void)(event, handler));
    };
    on("move", () => this.sample());
    on("path_update", (result: { path?: PathNode[]; status?: string }) => {
      const nodes = Array.isArray(result?.path) ? result.path : [];
      const stride = Math.max(1, Math.ceil(nodes.length / PATH_POINTS));
      this.path = nodes.filter((_, index) => index % stride === 0 || index === nodes.length - 1).map((node) => [round(node.x), round(node.z)]);
    });
    for (const event of ["goal_reached", "path_reset", "path_stop"]) on(event, () => { this.path = []; });
    on("respawn", () => { this.trail.length = 0; this.path = []; });
  }

  dispose(): void {
    for (const off of this.detach.splice(0)) off();
  }

  view(): { trail: readonly MapPoint[]; path: readonly MapPoint[] } {
    return { trail: this.trail.slice(), path: this.path.slice() };
  }

  private sample(): void {
    const position = this.bot.entity?.position;
    if (position === undefined) return;
    const last = this.trail.at(-1);
    if (last !== undefined && Math.hypot(position.x - last[0], position.z - last[1]) < TRAIL_STEP) return;
    // A jump of hundreds of blocks is a respawn or teleport, not a walk.
    if (last !== undefined && Math.hypot(position.x - last[0], position.z - last[1]) > 64) this.trail.length = 0;
    this.trail.push([round(position.x), round(position.z)]);
    if (this.trail.length > TRAIL_POINTS) this.trail.splice(0, this.trail.length - TRAIL_POINTS);
  }
}

const round = (value: number): number => Math.round(value * 10) / 10;

/** The pathfinder goal's target, for the goal shapes mineflayer-pathfinder ships. */
export function pathfinderDestination(bot: Bot): MapMarker | null {
  const goal = (bot as unknown as { pathfinder?: { goal?: Record<string, unknown> | null; isMoving?: () => boolean } }).pathfinder?.goal;
  if (goal === null || goal === undefined || typeof goal !== "object") return null;
  const label = typeof goal.constructor?.name === "string" ? goal.constructor.name.replace(/^Goal/, "") : "goal";
  const entity = goal.entity as { position?: { x: number; y: number; z: number }; username?: string; name?: string } | undefined;
  if (entity?.position !== undefined) return { x: entity.position.x, y: entity.position.y, z: entity.position.z, label: `Following ${entity.username ?? entity.name ?? "entity"}` };
  const x = goal.x, y = goal.y, z = goal.z;
  if (typeof x === "number" && typeof z === "number") return { x, y: typeof y === "number" ? y : bot.entity?.position.y ?? 64, z, label: label === "XZ" ? "Heading (x, z)" : label };
  return null;
}

interface Row { name?: string; category?: string; label?: string | null; resource?: string; x: number; y: number; z: number; dimension: string; depleted?: number; last_seen_at?: string | null; created_at?: string; recovered?: number; recovery_failed_reason?: string | null }

export interface OwnerMapInput {
  db: AppDatabase;
  worldId: number | null;
  bot: Bot | null;
  routes: RouteTracker | null;
  build: { x: number; y: number; z: number; dimension?: string; label: string } | null;
}

/** SELECT-only read of the remembered places for Bob's current dimension. */
export function readOwnerMap(input: OwnerMapInput): OwnerMapView {
  const bot = input.bot;
  const entity = bot?.entity;
  const dimension = bot?.game?.dimension === undefined ? null : normalizeDimension(String(bot.game.dimension));
  const empty: OwnerMapView = { dimension, bob: null, home: null, locations: [], resources: [], chests: [], deaths: [], build: null, destination: null, path: [], trail: [] };
  const here = (row: { dimension?: string }): boolean => dimension === null || row.dimension === undefined || normalizeDimension(row.dimension) === dimension;
  const bob = entity === null || entity === undefined ? null : { x: round(entity.position.x), y: round(entity.position.y), z: round(entity.position.z), yaw: entity.yaw };
  if (input.worldId === null) return { ...empty, bob };
  const sql = input.db.sql;
  const select = (query: string, ...params: unknown[]): Row[] => {
    try { return (sql.prepare(query).all(...params) as Row[]).filter(here); } catch { return []; }
  };
  const places = select("SELECT name, category, x, y, z, dimension FROM locations WHERE world_id = ? ORDER BY id DESC LIMIT 200", input.worldId);
  const homeRow = places.find((row) => row.category === "home");
  const resources = select("SELECT resource, x, y, z, dimension, depleted, last_seen_at FROM resource_sites WHERE world_id = ? ORDER BY COALESCE(last_seen_at, '') DESC, id DESC LIMIT 300", input.worldId);
  const chests = select("SELECT category, label, x, y, z, dimension, last_seen_at FROM storage_locations WHERE world_id = ? ORDER BY id LIMIT 100", input.worldId);
  const deaths = select("SELECT x, y, z, dimension, created_at, recovered, recovery_failed_reason FROM death_events WHERE world_id = ? ORDER BY id DESC LIMIT 25", input.worldId);
  const routes = input.routes?.view() ?? { trail: [], path: [] };
  return {
    dimension,
    bob,
    home: homeRow === undefined ? null : { x: homeRow.x, y: homeRow.y, z: homeRow.z, label: "Home" },
    locations: places.filter((row) => row.category !== "home").map((row) => ({ x: row.x, y: row.y, z: row.z, label: row.name ?? "spot", detail: row.category ?? null })),
    resources: resources.map((row) => ({ x: row.x, y: row.y, z: row.z, label: (row.resource ?? "resource").replace(/_/g, " "), at: row.last_seen_at ?? null, depleted: row.depleted === 1 })),
    chests: chests.map((row) => ({ x: row.x, y: row.y, z: row.z, label: row.label ?? `${row.category ?? "storage"} chest`, at: row.last_seen_at ?? null })),
    deaths: deaths.map((row) => ({ x: row.x, y: row.y, z: row.z, label: "Death", at: row.created_at ?? null, detail: row.recovered === 1 ? "items recovered" : row.recovery_failed_reason ?? null, recovered: row.recovered === 1 })),
    build: input.build !== null && here(input.build) ? { x: input.build.x, y: input.build.y, z: input.build.z, label: input.build.label } : null,
    destination: bot === null ? null : pathfinderDestination(bot),
    path: routes.path,
    trail: routes.trail,
  };
}
