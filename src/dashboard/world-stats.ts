import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Lifetime stats and milestones for the viewer pages. Read-only: the
 * Minecraft server's own per-player stats file plus counts the bot already
 * keeps in SQLite. Nothing here can write either source.
 */

/** The server's `stats/<uuid>.json` shape: category → item/entity → count. */
type ServerStats = Record<string, Record<string, number>>;

export interface DbCounts { buildsCompleted: number; deaths: number }

export interface Milestone {
  id: string;
  title: string;
  description: string;
  unlocked: boolean;
  /** 0..1 toward the target; 1 when unlocked. */
  progress: number;
}

export interface WorldStatsSummary {
  day: number | null;
  blocksMined: number;
  itemsCrafted: number;
  mobsKilled: number;
  deaths: number;
  distanceKm: number;
  buildsCompleted: number;
  /** The mob that has killed CobbleBob most often. */
  nemesis: string | null;
  milestones: readonly Milestone[];
}

interface Metrics {
  day: number;
  logs: number;
  stone: number;
  wheat: number;
  bread: number;
  torches: number;
  ironPickaxes: number;
  diamonds: number;
  hostileKills: number;
  builds: number;
  distanceKm: number;
  deaths: number;
}

const HOSTILES = new Set(["zombie", "husk", "drowned", "zombie_villager", "skeleton", "stray", "creeper", "spider", "cave_spider", "witch", "enderman", "slime", "phantom", "pillager", "vindicator", "silverfish", "blaze", "ghast", "magma_cube", "wither_skeleton", "piglin_brute", "hoglin", "zoglin", "guardian", "evoker", "ravager", "vex", "bogged", "breeze"]);
const STONE = new Set(["stone", "cobblestone", "deepslate", "cobbled_deepslate", "andesite", "diorite", "granite", "tuff", "calcite", "sandstone", "netherrack", "blackstone", "basalt"]);
const DISTANCE_KEYS = ["walk_one_cm", "sprint_one_cm", "crouch_one_cm", "swim_one_cm", "walk_on_water_one_cm", "walk_under_water_one_cm", "climb_one_cm", "fly_one_cm", "boat_one_cm", "horse_one_cm", "minecart_one_cm"];

interface MilestoneDef { id: string; title: string; description: string; metric: keyof Metrics; target: number }

export const MILESTONES: readonly MilestoneDef[] = [
  { id: "day-1", title: "First Night", description: "Survive the first night", metric: "day", target: 1 },
  { id: "day-7", title: "One Week In", description: "Reach day 7", metric: "day", target: 7 },
  { id: "day-30", title: "Old Timer", description: "Reach day 30", metric: "day", target: 30 },
  { id: "day-100", title: "Centurion", description: "Reach day 100", metric: "day", target: 100 },
  { id: "day-365", title: "Year One", description: "Reach day 365", metric: "day", target: 365 },
  { id: "day-1000", title: "Millennium", description: "Reach day 1,000", metric: "day", target: 1000 },
  { id: "logs-100", title: "Lumberjack", description: "Chop 100 logs", metric: "logs", target: 100 },
  { id: "logs-1000", title: "Deforester", description: "Chop 1,000 logs", metric: "logs", target: 1000 },
  { id: "logs-10000", title: "Timber Baron", description: "Chop 10,000 logs", metric: "logs", target: 10000 },
  { id: "stone-1000", title: "Quarryman", description: "Mine 1,000 stone", metric: "stone", target: 1000 },
  { id: "stone-10000", title: "Mountain Mover", description: "Mine 10,000 stone", metric: "stone", target: 10000 },
  { id: "stone-50000", title: "Hollow Earth", description: "Mine 50,000 stone", metric: "stone", target: 50000 },
  { id: "iron-pickaxe", title: "Iron Age", description: "Craft an iron pickaxe", metric: "ironPickaxes", target: 1 },
  { id: "diamond", title: "Diamonds!", description: "Mine a diamond ore", metric: "diamonds", target: 1 },
  { id: "wheat-1000", title: "Farmer", description: "Harvest 1,000 wheat", metric: "wheat", target: 1000 },
  { id: "wheat-50000", title: "Breadbasket", description: "Harvest 50,000 wheat", metric: "wheat", target: 50000 },
  { id: "bread-1000", title: "Master Baker", description: "Bake 1,000 bread", metric: "bread", target: 1000 },
  { id: "bread-10000", title: "Bakery Empire", description: "Bake 10,000 bread", metric: "bread", target: 10000 },
  { id: "torches-100", title: "Torchbearer", description: "Craft 100 torches", metric: "torches", target: 100 },
  { id: "torches-1000", title: "Lighthouse Keeper", description: "Craft 1,000 torches", metric: "torches", target: 1000 },
  { id: "kills-10", title: "Monster Hunter", description: "Defeat 10 hostile mobs", metric: "hostileKills", target: 10 },
  { id: "kills-100", title: "Slayer", description: "Defeat 100 hostile mobs", metric: "hostileKills", target: 100 },
  { id: "kills-500", title: "Legend of the Night", description: "Defeat 500 hostile mobs", metric: "hostileKills", target: 500 },
  { id: "kills-2000", title: "Mob Nightmare", description: "Defeat 2,000 hostile mobs", metric: "hostileKills", target: 2000 },
  { id: "builds-1", title: "Architect", description: "Finish a building", metric: "builds", target: 1 },
  { id: "builds-10", title: "Village Founder", description: "Finish 10 buildings", metric: "builds", target: 10 },
  { id: "builds-50", title: "Town Planner", description: "Finish 50 buildings", metric: "builds", target: 50 },
  { id: "builds-100", title: "City Builder", description: "Finish 100 buildings", metric: "builds", target: 100 },
  { id: "km-10", title: "Wanderer", description: "Travel 10 km", metric: "distanceKm", target: 10 },
  { id: "km-100", title: "Explorer", description: "Travel 100 km", metric: "distanceKm", target: 100 },
  { id: "km-1000", title: "Globetrotter", description: "Travel 1,000 km", metric: "distanceKm", target: 1000 },
  { id: "deaths-9", title: "Nine Lives", description: "Die nine times and keep going", metric: "deaths", target: 9 },
  { id: "deaths-100", title: "Unkillable Spirit", description: "Die 100 times and keep going", metric: "deaths", target: 100 },
];

const sum = (values: Record<string, number> | undefined, keep: (key: string) => boolean = () => true): number =>
  Object.entries(values ?? {}).reduce((total, [key, count]) => total + (keep(key.replace(/^minecraft:/, "")) && Number.isFinite(count) ? count : 0), 0);
const get = (values: Record<string, number> | undefined, key: string): number => values?.[`minecraft:${key}`] ?? 0;

export function summarizeWorldStats(raw: ServerStats | null, db: DbCounts): WorldStatsSummary {
  const stats = raw ?? {};
  const mined = stats["minecraft:mined"], crafted = stats["minecraft:crafted"], killed = stats["minecraft:killed"];
  const killedBy = stats["minecraft:killed_by"], custom = stats["minecraft:custom"];
  const worldTicks = get(custom, "total_world_time") || get(custom, "play_time");
  const deaths = Math.max(get(custom, "deaths"), db.deaths);
  const distanceKm = DISTANCE_KEYS.reduce((total, key) => total + get(custom, key), 0) / 100_000;
  const metrics: Metrics = {
    day: raw ? Math.floor(worldTicks / 24000) : 0,
    logs: sum(mined, (key) => key.endsWith("_log") || key.endsWith("_stem")),
    stone: sum(mined, (key) => STONE.has(key)),
    wheat: get(mined, "wheat"),
    bread: get(crafted, "bread"),
    torches: get(crafted, "torch"),
    ironPickaxes: get(crafted, "iron_pickaxe"),
    diamonds: get(mined, "diamond_ore") + get(mined, "deepslate_diamond_ore"),
    hostileKills: sum(killed, (key) => HOSTILES.has(key)),
    builds: db.buildsCompleted,
    distanceKm,
    deaths,
  };
  const nemesis = Object.entries(killedBy ?? {}).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return {
    day: raw ? metrics.day : null,
    blocksMined: sum(mined),
    itemsCrafted: sum(crafted),
    mobsKilled: sum(killed),
    deaths,
    distanceKm: Math.round(distanceKm * 10) / 10,
    buildsCompleted: db.buildsCompleted,
    nemesis: nemesis === null ? null : nemesis.replace(/^minecraft:/, "").replace(/_/g, " "),
    milestones: MILESTONES.map((m) => {
      const value = metrics[m.metric];
      return { id: m.id, title: m.title, description: m.description, unlocked: value >= m.target, progress: Math.min(1, Math.max(0, value / m.target)) };
    }),
  };
}

/** `<serverDir>/<level-name>/stats/<uuid>.json` for `username`, via server.properties and usercache.json. */
export async function resolveServerStatsFile(serverDir: string, username: string): Promise<string | null> {
  const properties = await readFile(join(serverDir, "server.properties"), "utf8");
  const level = /^level-name=(.+)$/m.exec(properties)?.[1]?.trim();
  if (!level || level.includes("/") || level.includes("..")) return null;
  const cache = JSON.parse(await readFile(join(serverDir, "usercache.json"), "utf8")) as Array<{ name?: unknown; uuid?: unknown }>;
  const uuid = cache.find((entry) => typeof entry.name === "string" && entry.name.toLowerCase() === username.toLowerCase())?.uuid;
  if (typeof uuid !== "string" || !/^[0-9a-f-]{36}$/i.test(uuid)) return null;
  return join(serverDir, level, "stats", `${uuid}.json`);
}

export interface WorldStatsReaderOptions {
  /** Minecraft server directory; null means DB counts only. */
  serverDir: string | null;
  username: string;
  dbCounts: () => DbCounts;
  ttlMs?: number;
  now?: () => number;
  onError?: (error: unknown) => void;
}

/**
 * Synchronous, cached view for the snapshot: `current()` returns the last
 * summary immediately and refreshes in the background once it is stale. The
 * server only flushes stats on autosave, so a slow refresh loses nothing.
 */
export function createWorldStatsReader(options: WorldStatsReaderOptions): { current(): WorldStatsSummary | null } {
  const ttlMs = options.ttlMs ?? 30_000;
  const now = options.now ?? Date.now;
  let value: WorldStatsSummary | null = null;
  let refreshedAt = -Infinity;
  let refreshing = false;

  async function refresh(): Promise<void> {
    let raw: ServerStats | null = null;
    if (options.serverDir !== null) {
      try {
        const file = await resolveServerStatsFile(options.serverDir, options.username);
        if (file !== null) raw = (JSON.parse(await readFile(file, "utf8")) as { stats?: ServerStats }).stats ?? null;
      } catch (error) {
        options.onError?.(error);
      }
    }
    value = summarizeWorldStats(raw, options.dbCounts());
  }

  return {
    current() {
      if (!refreshing && now() - refreshedAt >= ttlMs) {
        refreshing = true;
        refreshedAt = now();
        void refresh().catch((error: unknown) => options.onError?.(error)).finally(() => { refreshing = false; });
      }
      return value;
    },
  };
}
