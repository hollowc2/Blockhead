import type { Task } from "../agent/task.js";
import { TaskStatus } from "../agent/task.js";
import { isRawLogItemName } from "../minecraft/inventory.js";
import { FOOD_ITEM_NAMES } from "../skills/gather-food.js";
import { isEquipmentName } from "../policy/item-policy.js";
import { age, dimensionLabel, duration, field, position, round1, timePhaseLabel, titleCase } from "./format.js";

/**
 * Pure panel renderers for the Phase 12 dashboard (spec 33). `DashboardSnapshot`
 * is the plain value `app.ts` assembles every tick; each renderer maps it to
 * lines. No I/O, no ANSI, no bot access — the panels are data -> text.
 */

export interface StockpileLine {
  kind: string;
  level: number | null;
  target: number | null;
}

export interface LlmPanel {
  model: string;
  endpoint: string;
  /** Ms since the last successful LLM call; null before the first call. */
  lastCallAgeMs: number | null;
  latencyMs: number | null;
  tool: string | null;
  rationale: string | null;
}

export interface DashboardSnapshot {
  botName: string;
  /** Bot entity alive and positioned in a world. */
  connected: boolean;
  health: number;
  hunger: number;
  position: { x: number; y: number; z: number } | null;
  dimension: string | null;
  timePhase: "day" | "night" | null;
  danger: number;
  activeTask: Task | null;
  /** Queued paused tasks (interrupted work waiting to resume). */
  pausedTasks: readonly Task[];
  /** Queued tasks with a user source waiting for the slot. */
  waitingUserTasks: readonly Task[];
  /** Pending cooperative interrupt on the active task ("pause" / "cancel"). */
  pendingInterrupt: "pause" | "cancel" | null;
  backgroundActivity: string;
  stockpiles: readonly StockpileLine[] | null;
  /** Summarized carried inventory lines ("Iron Pickaxe", "Bread x12"). */
  inventory: readonly string[];
  llm: LlmPanel | null;
  /** Most recent significant events, oldest first. */
  events: readonly string[];
}

export interface Panel {
  title: string;
  lines: readonly string[];
}

const EMPTY = "—";

const STATUS_LABELS: Record<TaskStatus, string> = {
  [TaskStatus.QUEUED]: "Queued",
  [TaskStatus.ACTIVE]: "Running",
  [TaskStatus.PAUSED]: "Paused",
  [TaskStatus.BLOCKED]: "Blocked",
  [TaskStatus.COMPLETED]: "Complete",
  [TaskStatus.FAILED]: "Failed",
  [TaskStatus.CANCELLED]: "Cancelled",
};

/** "oak_log" -> "oak log" for user-facing action lines. */
function materialLabel(name: string): string {
  return name.replace(/_/g, " ").trim();
}

/** The deterministic skill label for an active task (spec 33 ACTION panel). */
export function actionForTask(task: Task | null): string {
  if (task === null) return "Idle";
  const p = task.parameters;
  switch (task.type) {
    case "collect_resource":
      return `Gathering ${materialLabel(String(p.resource ?? ""))} (${Number(p.quantity ?? 0)})`;
    case "stockpile_maintenance":
      return `Restoring ${String(p.kind ?? "")} stockpile`;
    case "death_recovery":
      return `Death recovery at (${Number(p.x ?? 0)}, ${Number(p.y ?? 0)}, ${Number(p.z ?? 0)})`;
    case "organize_storage":
      return "Organizing home storage";
    case "create_storage":
      return `Creating ${String(p.category ?? "general")} chest`;
    case "interrupt":
      return `Movement: ${materialLabel(String(p.tool ?? ""))}`;
    case "go_home":
      return "Traveling home";
    default:
      return titleCase(task.type);
  }
}

/** Stockpile-line renderer (shared shape: "Wood 64/64" or "Wood --/--"). */
function stockpileField(line: StockpileLine): string {
  const level = line.level === null ? "--" : `${line.level}`;
  const target = line.target === null ? "--" : `${line.target}`;
  return `${line.kind.charAt(0).toUpperCase()}${line.kind.slice(1)}  ${level}/${target}`;
}

export function renderStatePanel(s: DashboardSnapshot): Panel {
  const health = `${Math.round(s.health * 10) / 10}/20`;
  const hunger = `${Math.round(s.hunger * 10) / 10}/20`;
  return {
    title: "STATE",
    lines: [
      field("Health", health),
      field("Hunger", hunger),
      field("Position", position(s.position)),
      field("Dimension", dimensionLabel(s.dimension)),
      field("Time", timePhaseLabel(s.timePhase)),
      field("Danger", round1(s.danger)),
    ],
  };
}

export function renderTaskPanel(s: DashboardSnapshot): Panel {
  const active = s.activeTask;
  const lines: string[] = [
    field("Foreground", active?.objective ?? EMPTY),
    field("Status", active !== null ? (STATUS_LABELS[active.status] ?? active.status) : EMPTY),
  ];
  if (s.pendingInterrupt !== null) {
    lines.push(field("Interrupt", s.pendingInterrupt === "pause" ? "Pause requested" : "Cancel requested"));
  }
  for (const task of s.waitingUserTasks.slice(0, 2)) {
    lines.push(field("Waiting", task.objective));
  }
  const paused = s.pausedTasks.slice(0, 3);
  for (const task of paused) {
    lines.push(field("Paused", task.objective));
  }
  if (s.pausedTasks.length > paused.length) {
    lines.push(field("", `+${s.pausedTasks.length - paused.length} more paused`));
  }
  return { title: "TASK", lines };
}

export function renderBackgroundPanel(s: DashboardSnapshot): Panel {
  const lines = [field("Activity", s.backgroundActivity)];
  if (s.stockpiles !== null) {
    for (const line of s.stockpiles) {
      lines.push(stockpileField(line));
    }
  } else {
    for (const kind of ["wood", "food", "fuel", "torches"]) {
      lines.push(`${kind.charAt(0).toUpperCase()}${kind.slice(1)}  --/--`);
    }
  }
  return { title: "BACKGROUND", lines };
}

export function renderActionPanel(s: DashboardSnapshot): Panel {
  return { title: "ACTION", lines: [field("Active", actionForTask(s.activeTask))] };
}

export function renderInventoryPanel(s: DashboardSnapshot, maxLines = INVENTORY_LIMIT): Panel {
  return { title: "INVENTORY", lines: s.inventory.slice(0, maxLines) };
}

export function renderLlmPanel(s: DashboardSnapshot): Panel {
  const llm = s.llm;
  if (llm === null) {
    return { title: "LLM", lines: [field("Model", EMPTY), field("Last call", "never")] };
  }
  const lastCall = llm.lastCallAgeMs === null ? "never" : age(llm.lastCallAgeMs);
  const latency = llm.latencyMs === null ? "" : ` · ${duration(llm.latencyMs)}`;
  const lines: string[] = [
    field("Model", `${llm.model} · ${llm.endpoint}`),
    field("Last call", `${lastCall}${latency}`),
    field("Last tool", llm.tool ?? EMPTY),
  ];
  const rationale = llm.rationale ?? EMPTY;
  // Rationale is the one line that can exceed the label column; keep it whole
  // and let the dashboard fit to width.
  lines.push(`${"Rationale".padEnd(10)}${rationale}`);
  return { title: "LLM", lines };
}

export function renderEventPanel(s: DashboardSnapshot, maxLines = 6): Panel {
  return { title: "EVENT", lines: [...s.events].reverse().slice(0, maxLines) };
}

/** All panels in the spec 33 display order (LLM ahead of INVENTORY so the last-LLM-decision readout survives a small screen). */
export function renderPanels(s: DashboardSnapshot, caps: { eventMax?: number; inventoryMax?: number } = {}): Panel[] {
  return [
    renderStatePanel(s),
    renderTaskPanel(s),
    renderBackgroundPanel(s),
    renderActionPanel(s),
    renderLlmPanel(s),
    renderInventoryPanel(s, caps.inventoryMax),
    renderEventPanel(s, caps.eventMax),
  ];
}

/** Food names beyond the gather-food meat set that a dev cares about in the summary. */
const FOOD_DISPLAY_NAMES: ReadonlySet<string> = new Set([
  "bread",
  "apple",
  "carrot",
  "potato",
  "baked_potato",
  "pumpkin_pie",
  "cookie",
  "melon_slice",
]);

function isFoodItemName(name: string): boolean {
  return FOOD_ITEM_NAMES[name] === true || FOOD_DISPLAY_NAMES.has(name);
}

/**
 * Deterministic inventory summary (spec 33 INVENTORY panel): tools and armor
 * first, then food, torches, and the key resources a dev wants to see.
 * Capped at INVENTORY_LIMIT lines with a "+N more" tail.
 */
export const INVENTORY_LIMIT = 9;

export function summarizeInventory(items: Record<string, number>): string[] {
  const equipment: string[] = [];
  const food: string[] = [];
  const resources: string[] = [];
  let torchCount = 0;

  for (const rawName of Object.keys(items)) {
    const name = rawName.replace(/^minecraft:/, "");
    const count = items[rawName]!;
    if (name === "torch") {
      torchCount += count;
    } else if (isEquipmentName(name)) {
      equipment.push(count > 1 ? `${titleCase(name)} x${count}` : titleCase(name));
    } else if (isFoodItemName(name)) {
      food.push(`${titleCase(name)} x${count}`);
    } else if (isRawLogItemName(name)) {
      resources.push(`${titleCase(name)} x${count}`);
    } else if (name === "coal" || name === "charcoal") {
      resources.push(`${titleCase(name)} x${count}`);
    } else if (name === "iron_ore" || name === "raw_iron" || name === "iron_ingot") {
      resources.push(`${titleCase(name)} x${count}`);
    } else if (name === "cobblestone" || name === "stone") {
      resources.push(`${titleCase(name)} x${count}`);
    } else if (name === "stick") {
      resources.push(`${titleCase(name)} x${count}`);
    }
  }

  const lines = [...equipment, ...food, ...resources];
  if (torchCount > 0) lines.push(`Torch x${torchCount}`);

  // Keep the biggest counts visible when the panel is full: sort the resource
  // tail by amount so "+N more" is not hiding the important stock.
  const sortByCount = (list: string[]): string[] =>
    list.sort((a, b) => {
      const an = Number(/\dx(\d+)$/.exec(a)?.[1] ?? 1);
      const bn = Number(/\dx(\d+)$/.exec(b)?.[1] ?? 1);
      return bn - an;
    });
  if (lines.length > INVENTORY_LIMIT) {
    const kept = [
      ...equipment,
      ...food,
      ...sortByCount(resources),
      ...(torchCount > 0 ? [`Torch x${torchCount}`] : []),
    ].slice(0, INVENTORY_LIMIT);
    kept.push(`+${lines.length - INVENTORY_LIMIT} more`);
    return kept;
  }
  return lines;
}