import type { Bot } from "mineflayer";
import type { Item } from "prismarine-item";
import type { ToolContext } from "../tools/types.js";
import { bareName, countLogs, countPlanks, countSticks } from "../minecraft/inventory.js";
import { FOOD_ITEM_NAMES } from "../skills/gather-food.js";
import { criterionLabel, type Goal } from "../agent/goal.js";
import type { StockpileDeficit, StockpileKind } from "../agent/maintenance.js";
import type { Task } from "../agent/task.js";

/** The chat that triggered a decision. */
export interface DecisionInput {
  from: string;
  instruction: string;
}

/**
 * The exact state object sent to the LLM (spec section 19). Kept tight and
 * high-signal; this same object is written verbatim to the debug log so bad
 * decisions can be reproduced (spec 32.2). Raw inventory dumps and event
 * logs never appear — only compact aggregates that answer decision-relevant
 * questions ("is food covered?", "am I equipped?", "how far from home?").
 */
export interface StateSnapshot {
  self: {
    position: { x: number; y: number; z: number } | null;
    dimension: string | null;
    health: number;
    hunger: number;
  };
  task: {
    active: string | null;
    /** Scalar facets of the task's resume state; arrays/objects are dropped. */
    progress: Record<string, string | number | boolean> | null;
    lastError: string | null;
  };
  nearby: {
    players: { name: string; distance: number }[];
  };
  /**
   * Carried inventory condensed to decision-relevant groups. Aggregates are
   * always present (stable schema); `materials` lists only nonzero counts of
   * common building materials and notable metals.
   */
  inventory: {
    food: number;
    torches: number;
    wood: { logs: number; planks: number; sticks: number };
    /** Coal and charcoal (smelting fuel) combined. */
    fuel: number;
    /** Iron ore, raw iron, and ingots combined. */
    iron: number;
    materials: Record<string, number>;
    freeSlots: number;
  };
  /** What the bot has in hand and on, with durability when the item has it. */
  equipment: {
    held: { name: string; durability?: { used: number; max: number } } | null;
    offhand: { name: string; durability?: { used: number; max: number } } | null;
    armor: { name: string; durability?: { used: number; max: number } }[];
  };
  /**
   * Home/base awareness: whether a home is known, straight-line distance to
   * it, how many storage chests are registered there (and their categories),
   * plus the last measured stockpile levels when the maintenance manager has
   * run. Nothing here triggers a measurement or a chest scan.
   */
  home: {
    known: boolean;
    distance: number | null;
    dimension: string | null;
    storage: { chests: number; categories: string[] } | null;
    stockpile: {
      levels: Record<StockpileKind, number>;
      targets: Record<StockpileKind, number>;
      deficits: StockpileDeficit[];
    } | null;
  };
  recentEvents: string[];
  /**
   * The last several settled high-level task outcomes (completed, failed,
   * cancelled, or currently blocked), newest first, deduplicated so a repeat
   * failure of the same action appears once. Each entry carries the outcome,
   * a concise reason, and scalar resume progress.
   */
  recentTasks: {
    type: string;
    status: string;
    reason: string | null;
    progress: Record<string, string | number | boolean> | null;
  }[];
  /**
   * High-level actions currently blocked by the anti-loop watchdog (same
   * task type + normalized arguments failed repeatedly). Each entry names
   * the action, why it was blocked, and when a retry is allowed; the model
   * should pick something else or wait instead of re-attempting one.
   */
  blockedActions: { action: string; reason: string; retryInSeconds: number }[];
  /**
   * The active autonomous goal, compacted for the model: objective, status,
   * current step, the evaluable success criteria, and the last few settled
   * action outcomes. Null when no goal is active.
   */
  activeGoal: {
    description: string;
    status: string;
    currentStep: string | null;
    criteria: string[];
    recentResults: { action: string; outcome: string; message: string | null }[];
  } | null;
  from: string;
  instruction: string;
}

/** Common materials and notable metals tracked beyond the aggregates above. */
const MATERIAL_ITEM_NAMES: readonly string[] = [
  "stone",
  "cobblestone",
  "dirt",
  "sand",
  "gravel",
  "andesite",
  "diorite",
  "granite",
  "flint",
  "gold_ore",
  "raw_gold",
  "gold_ingot",
  "copper_ore",
  "raw_copper",
  "copper_ingot",
  "diamond",
  "redstone",
];

/** How many recent outcome rows to fetch before dedupe (result cap is smaller). */
const RECENT_TASKS_FETCH = 24;
/** How many distinct recent outcomes go into the context. */
const RECENT_TASKS_CAP = 5;
/** Progress string values longer than this are dropped as noise. */
const MAX_PROGRESS_STRING = 80;

/** Compact list of visible players sorted by distance, excluding the bot. */
function nearbyPlayers(bot: Bot): { name: string; distance: number }[] {
  const selfPos = bot.entity?.position;
  if (!selfPos) return [];
  const players: { name: string; distance: number }[] = [];
  for (const [name, player] of Object.entries(bot.players)) {
    if (name === bot.username) continue;
    const pos = player.entity?.position;
    if (!pos) continue;
    const distance = Math.hypot(selfPos.x - pos.x, selfPos.y - pos.y, selfPos.z - pos.z);
    players.push({ name, distance: Math.round(distance) });
  }
  players.sort((a, b) => a.distance - b.distance);
  return players;
}

/**
 * Carried inventory condensed into decision-relevant groups. Only nonzero
 * `materials` entries are kept; the aggregates (food, torches, wood, fuel,
 * iron) always appear so the schema is stable for the model.
 */
function inventorySummary(bot: Bot): StateSnapshot["inventory"] {
  let food = 0;
  let torches = 0;
  let fuel = 0;
  let iron = 0;
  const materials: Record<string, number> = {};
  for (const item of bot.inventory.items()) {
    const name = bareName(item.name);
    if (FOOD_ITEM_NAMES[name] === true) food += item.count;
    else if (name === "torch") torches += item.count;
    else if (name === "coal" || name === "charcoal") fuel += item.count;
    else if (name === "iron_ore" || name === "raw_iron" || name === "iron_ingot") iron += item.count;
    else if (MATERIAL_ITEM_NAMES.includes(name)) materials[name] = (materials[name] ?? 0) + item.count;
  }
  return {
    food,
    torches,
    wood: { logs: countLogs(bot), planks: countPlanks(bot), sticks: countSticks(bot) },
    fuel,
    iron,
    materials,
    freeSlots: bot.inventory.emptySlotCount(),
  };
}

/** One equipped item: name plus durability when the item carries it. */
function equipItem(item: Item | null | undefined): StateSnapshot["equipment"]["held"] {
  if (item === null || item === undefined) return null;
  if (item.maxDurability === undefined || item.maxDurability <= 0) {
    return { name: item.name };
  }
  return {
    name: item.name,
    durability: { used: item.durabilityUsed ?? 0, max: item.maxDurability },
  };
}

/**
 * What the bot has in hand and wearing, from mineflayer's equipment array
 * ([held, offhand, feet, legs, chest, head] on modern versions; the
 * pre-offhand 5-slot layout has no `offhand`). Durability is included
 * whenever the item reports a max durability.
 */
function equipmentSummary(bot: Bot): StateSnapshot["equipment"] {
  const equipment = bot.entity?.equipment;
  if (equipment === undefined || equipment.length === 0) {
    return { held: null, offhand: null, armor: [] };
  }
  const hasOffhand = equipment.length >= 6;
  const armorStart = hasOffhand ? 2 : 1;
  const armor: StateSnapshot["equipment"]["armor"] = [];
  for (let i = armorStart; i < equipment.length; i++) {
    const piece = equipItem(equipment[i]);
    if (piece !== null) armor.push(piece);
  }
  return {
    held: equipItem(equipment[0]),
    offhand: hasOffhand ? equipItem(equipment[1]) : null,
    armor,
  };
}

/** Home awareness, registered storage, and last measured stockpile levels. */
function homeSummary(ctx: ToolContext): StateSnapshot["home"] {
  const home = ctx.state.home;
  let distance: number | null = null;
  if (home !== null) {
    const selfPos = ctx.state.self.position;
    if (selfPos !== null) {
      const homeDim = home.dimension.replace(/^minecraft:/, "");
      const selfDim = ctx.state.self.dimension;
      if (selfDim !== null && selfDim === homeDim) {
        distance = Math.round(Math.hypot(selfPos.x - home.x, selfPos.y - home.y, selfPos.z - home.z));
      }
    }
  }

  let storage: StateSnapshot["home"]["storage"] = null;
  const worldId = ctx.state.worldId;
  if (ctx.storage !== undefined && worldId !== null) {
    const locations = ctx.storage.list(worldId);
    storage = {
      chests: locations.length,
      categories: [...new Set(locations.map((location) => location.category))].sort(),
    };
  }

  const snapshot = ctx.maintenance?.snapshot;
  return {
    known: home !== null,
    distance,
    dimension: home?.dimension ?? null,
    storage,
    stockpile:
      snapshot === undefined || snapshot === null
        ? null
        : { levels: snapshot.levels, targets: snapshot.targets, deficits: snapshot.deficits },
  };
}

/**
 * Scalar facets of a resume-state object, formatted for the model. Arrays
 * (e.g. `attemptedSites`) and nested objects are dropped — they are raw logs,
 * not decision signals; strings are length-capped. Null when the state has
 * no scalar facets.
 */
function compactProgress(
  resumeState: object | undefined,
): Record<string, string | number | boolean> | null {
  if (resumeState === undefined || resumeState === null) return null;
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(resumeState)) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed !== "" && trimmed.length <= MAX_PROGRESS_STRING) out[key] = trimmed;
    } else if (typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    }
  }
  return Object.keys(out).length === 0 ? null : out;
}

/** One recent task outcome: outcome, concise reason, scalar progress. */
function toRecentTaskOutcome(task: Task): StateSnapshot["recentTasks"][number] {
  return {
    type: task.type,
    status: String(task.status),
    reason: task.lastError !== undefined && task.lastError !== "" ? task.lastError : null,
    progress: compactProgress(task.resumeState),
  };
}

/**
 * The last several settled outcomes, deduplicated by (type, status, reason)
 * so a failure loop of the same action appears once instead of flooding the
 * context five identical rows. Falls back to an empty list when the task
 * store is not wired.
 */
function recentTaskOutcomes(ctx: ToolContext): StateSnapshot["recentTasks"] {
  const tasks = ctx.tasks?.recentSettled(RECENT_TASKS_FETCH);
  if (tasks === undefined || tasks.length === 0) return [];
  const out: StateSnapshot["recentTasks"] = [];
  const seen = new Set<string>();
  for (const task of tasks) {
    const outcome = toRecentTaskOutcome(task);
    const key = `${outcome.type}|${outcome.status}|${outcome.reason ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(outcome);
    if (out.length >= RECENT_TASKS_CAP) break;
  }
  return out;
}

/**
 * The active goal compacted to decision-relevant lines. Kept short: the LLM
 * only needs the objective, where it is, and what has happened on the last
 * few steps — not the raw goal row.
 */
function activeGoalSummary(goal: Goal): StateSnapshot["activeGoal"] {
  return {
    description: goal.description,
    status: goal.status,
    currentStep: goal.currentStep,
    criteria: goal.successCriteria.map(criterionLabel),
    recentResults: goal.recentResults.slice(-3).map((result) => ({
      action: result.action,
      outcome: result.outcome,
      message: result.message ?? null,
    })),
  };
}

/** Build the exact state snapshot handed to the LLM. */
export function buildStateSnapshot(ctx: ToolContext, input: DecisionInput): StateSnapshot {
  const self = ctx.state.self;
  const active = ctx.scheduler.active;
  return {
    self: {
      position: self.position,
      dimension: self.dimension,
      health: self.health,
      hunger: self.food,
    },
    task: {
      active: active?.objective ?? null,
      progress: compactProgress(active?.resumeState),
      lastError: active?.lastError ?? null,
    },
    nearby: {
      players: nearbyPlayers(ctx.bot),
    },
    inventory: inventorySummary(ctx.bot),
    equipment: equipmentSummary(ctx.bot),
    home: homeSummary(ctx),
    recentEvents: [...ctx.state.recentEvents],
    recentTasks: recentTaskOutcomes(ctx),
    blockedActions: [...ctx.scheduler.blockedActions()],
    activeGoal: ctx.goals?.active() ? activeGoalSummary(ctx.goals.active()!) : null,
    from: input.from,
    instruction: input.instruction,
  };
}