import { publicStatus, type PublicStatus } from "./public-status.js";
import { isPublicSafeText, publicThought } from "./public-thinking.js";
import { humanize, type StoryEntry } from "./story.js";
import type { DashboardSnapshot, GoalCriterionSummary } from "./types.js";
import { EQUIPMENT_SLOTS, type EquipmentSummary, type InventorySummary } from "./types.js";
import type { WorldStatsSummary } from "./world-stats.js";
import type { PublicAvailability } from "./public-interactions.js";

/** What he is working on, from templates and registry names only. */
export interface PublicNow {
  /** "Collect iron ingot · 3/10", "Build a cottage · 42%", or a fixed status sentence. */
  label: string;
  /** A fixed phrase for the current task type ("Gathering materials"), or null. */
  step: string | null;
  progress: { done: number; total: number } | null;
}
/** The build underway; present only while a build project is active or verifying. */
export interface PublicBuild {
  /** Humanized structure type ("cottage"), or "structure" when it isn't a plain name. */
  structure: string;
  /** 0-100, whole numbers. */
  percent: number;
  blocksPlaced: number;
}
export interface PublicBrain {
  /** A model call is in flight. */
  thinking: boolean;
  decisionsLastHour: number;
  /** Latency of the latest successful decision, whole milliseconds. */
  lastLatencyMs: number | null;
  /** Fixed display name from config ("Qwen3.5 9B"); never the endpoint. */
  model: string | null;
}
/** The latest decision's rationale after the reject-on-doubt filter (public-thinking.ts). */
export interface PublicThinking {
  /** At most 120 characters: the whole rationale, or a fixed phrase. Never a partial scrub. */
  text: string;
  /** When the decision was made; changes on every new decision. */
  at: string;
}
/** One minute of vitals, whole numbers; null while he was disconnected. */
export interface PublicVitalsSample { at: string; health: number | null; hunger: number | null }

/**
 * Everything the public viewer page may learn about the bot. Built by
 * allowlist, never by deleting fields, so new snapshot fields stay private.
 * No coordinates, player names, chat, goal or task text, or raw LLM output.
 * Inventory and gear expose only registry item names and counts, never item metadata.
 * The story feed and lifetime stats are built coordinate-free at the source.
 * The broadcast fields (now … uptimeSeconds) are optional so a page tolerates
 * an older bot; this projection always fills them.
 */
export interface PublicViewerState {
  public: true;
  /** Fresh server-derived flags may be attached by the public listener. */
  interactions?: PublicAvailability;
  connection: { connected: boolean };
  /** Coarse spectator status; see public-status.ts. */
  status: PublicStatus;
  self: { health: number | null; hunger: number | null; dimension: string | null; timePhase: "day" | "night" | null };
  viewer: { status: DashboardSnapshot["viewer"]["status"] };
  story: readonly StoryEntry[];
  world: WorldStatsSummary | null;
  inventory: InventorySummary | null;
  equipment: EquipmentSummary | null;
  /** Null while disconnected. */
  now?: PublicNow | null;
  build?: PublicBuild | null;
  brain?: PublicBrain;
  /** Null until the first successful decision of this process. */
  thinking?: PublicThinking | null;
  /** Up to the last 60 minutes, oldest first, one sample a minute. */
  vitals?: readonly PublicVitalsSample[];
  /** Bot process uptime in whole seconds. */
  uptimeSeconds?: number;
}

/** Fixed phrases per task type; task objectives and errors never cross. */
const STEP: Record<string, string> = {
  collect_resource: "Gathering materials", stockpile_maintenance: "Restocking supplies", ensure_item: "Getting what he needs",
  gather_food: "Finding food", hunt: "Hunting", farm: "Tending the farm", eat: "Eating",
  craft_item: "Crafting", smelt_item: "Smelting", upgrade_equipment: "Upgrading his gear", replace_equipment: "Replacing worn gear", equip_best: "Putting on his best gear",
  travel_to: "Travelling", go_home: "Heading home", explore: "Exploring", expedition: "On an expedition",
  build_base: "Building", build_design: "Building", build_structure: "Building", build_project_slice: "Placing blocks",
  build_project_acquire: "Gathering building materials", build_project_verify: "Checking the build",
  world_project_slice: "Working on a project", world_project_acquire: "Gathering project materials", world_project_verify: "Checking the work",
  world_project_return: "Heading back to the project", world_project_deposit: "Dropping off supplies", world_project_replace_tool: "Fetching a fresh tool",
  light_home: "Lighting up with torches", create_storage: "Setting up storage", organize_storage: "Sorting storage",
  store_items: "Storing items", retrieve_items: "Fetching supplies", develop_land: "Shaping the land", clear_area: "Clearing an area",
  sleep: "Sleeping", night_shelter: "Sheltering for the night", wait: "Waiting",
  death_recovery: "Recovering lost items", recover_death_items: "Recovering lost items", defend_self: "Defending himself", defend_player: "Defending a friend",
  deliver_items: "Delivering items", give_item: "Handing over items",
};
const STOCKPILE_LABEL: Record<string, string> = { wood: "Stock up wood", food: "Stock up food", fuel: "Stock up fuel", torches: "Stock up torches" };
/** Registry-shaped names only: lowercase words joined by underscores, no digits or namespaces beyond `minecraft:`. */
const REGISTRY_NAME = /^(?:minecraft:)?[a-z]+(?:_[a-z]+){0,5}$/;
/** A humanized name is a few lowercase words. */
const PLAIN_NAME = /^[a-z]+(?: [a-z]+){0,5}$/;
const MODEL_LABEL = /^[A-Za-z0-9][A-Za-z0-9 .-]{0,31}$/;

const article = (noun: string): string => /^[aeiou]/.test(noun) ? `an ${noun}` : `a ${noun}`;
const wholeNumber = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : null;

/** A registry item name as words, or null if it isn't plainly one (LLM-chosen goal items may be anything). */
function itemWords(name: string | null, privateTerms: readonly string[]): string | null {
  if (name === null || !REGISTRY_NAME.test(name)) return null;
  const words = humanize(name);
  return PLAIN_NAME.test(words) && isPublicSafeText(words, privateTerms) ? words : null;
}

function structureWords(snapshot: DashboardSnapshot, privateTerms: readonly string[]): string {
  const words = humanize(snapshot.buildProject?.structureType, "structure").toLowerCase();
  return words.length <= 32 && PLAIN_NAME.test(words) && isPublicSafeText(words, privateTerms) ? words : "structure";
}

function publicBuild(snapshot: DashboardSnapshot, privateTerms: readonly string[]): PublicBuild | null {
  const project = snapshot.buildProject ?? null;
  if (project === null || (project.status !== "active" && project.status !== "verifying")) return null;
  const total = wholeNumber(project.totalOperations) ?? 0;
  const placed = Math.min(wholeNumber(project.verifiedOperations) ?? 0, total);
  return { structure: structureWords(snapshot, privateTerms), percent: total === 0 ? 0 : Math.floor((placed / total) * 100), blocksPlaced: placed };
}

/** One goal criterion as a template, with progress where public counts can measure it. */
function criterionNow(criterion: GoalCriterionSummary, snapshot: DashboardSnapshot, build: PublicBuild | null, privateTerms: readonly string[]): { label: string; progress: PublicNow["progress"] } | null {
  const total = wholeNumber(criterion.min);
  switch (criterion.kind) {
    case "inventory": {
      const item = itemWords(criterion.item, privateTerms);
      if (item === null || total === null || total === 0) return null;
      const held = snapshot.inventory?.items.filter((entry) => entry.name === criterion.item?.replace(/^minecraft:/, "")).reduce((sum, entry) => sum + entry.count, 0) ?? 0;
      const done = Math.min(held, total);
      return { label: `Collect ${item} · ${done}/${total}`, progress: { done, total } };
    }
    case "stockpile": {
      const label = criterion.stockpile === null ? undefined : STOCKPILE_LABEL[criterion.stockpile];
      if (label === undefined || total === null || total === 0) return null;
      const level = wholeNumber(snapshot.stockpiles?.levels[criterion.stockpile!]);
      if (level === null) return { label, progress: null };
      const done = Math.min(level, total);
      return { label: `${label} · ${done}/${total}`, progress: { done, total } };
    }
    case "chest_contains": {
      const item = itemWords(criterion.item, privateTerms);
      return item === null ? null : { label: `Store ${item}`, progress: null };
    }
    case "building_verified":
      return build === null ? { label: "Finish a build", progress: null } : buildNow(build);
    case "area_cleared":
      return { label: "Clear an area", progress: null };
  }
}

function buildNow(build: PublicBuild): { label: string; progress: PublicNow["progress"] } {
  return { label: `Build ${article(build.structure)} · ${build.percent}%`, progress: { done: build.percent, total: 100 } };
}

function publicNow(snapshot: DashboardSnapshot, status: PublicStatus, build: PublicBuild | null, privateTerms: readonly string[]): PublicNow | null {
  if (snapshot.connection.connected !== true) return null;
  const task = snapshot.task && ["active", "blocked"].includes(snapshot.task.status) ? snapshot.task : null;
  const step = task !== null && Object.hasOwn(STEP, task.type) ? STEP[task.type]! : null;
  const criteria = snapshot.goal?.successCriteria ?? [];
  const measured = criteria.map((criterion) => criterionNow(criterion, snapshot, build, privateTerms)).filter((entry) => entry !== null);
  // The first criterion still open, else the first one (the goal is about to complete).
  const pick = measured.find((entry) => entry.progress === null || entry.progress.done < entry.progress.total) ?? measured[0];
  if (pick !== undefined) return { ...pick, step };
  if (build !== null) return { ...buildNow(build), step };
  return { label: status.detail, step, progress: null };
}

/** Every term public text must not contain, including the bot and the names on the connection. */
function privateTermsOf(snapshot: DashboardSnapshot): string[] {
  const terms = [...(snapshot.broadcast?.privateTerms ?? [])];
  if (snapshot.connection.player) terms.push(snapshot.connection.player);
  return terms;
}

function publicThinking(snapshot: DashboardSnapshot, privateTerms: readonly string[]): PublicThinking | null {
  const decision = snapshot.broadcast?.lastDecision ?? null;
  if (decision === null || Number.isNaN(Date.parse(decision.at))) return null;
  return {
    text: publicThought({ rationale: decision.rationale, tool: decision.tool, callType: decision.callType, privateTerms }),
    at: new Date(Date.parse(decision.at)).toISOString(),
  };
}

function publicBrain(snapshot: DashboardSnapshot): PublicBrain {
  const label = snapshot.broadcast?.modelLabel;
  return {
    thinking: snapshot.llmActivity?.thinking === true,
    decisionsLastHour: wholeNumber(snapshot.broadcast?.decisionsLastHour) ?? 0,
    lastLatencyMs: wholeNumber(snapshot.broadcast?.lastDecision?.latencyMs),
    model: typeof label === "string" && MODEL_LABEL.test(label) ? label : null,
  };
}

function publicVitals(snapshot: DashboardSnapshot): PublicVitalsSample[] {
  return (snapshot.broadcast?.vitals ?? []).slice(-60).flatMap((sample) => {
    const at = Date.parse(sample.at);
    return Number.isNaN(at) ? [] : [{ at: new Date(at).toISOString(), health: wholeNumber(sample.health), hunger: wholeNumber(sample.hunger) }];
  });
}

export function toPublicViewerState(snapshot: DashboardSnapshot): PublicViewerState {
  const round = (value: number | null): number | null => value === null ? null : Math.round(value);
  const status = publicStatus(snapshot);
  const privateTerms = privateTermsOf(snapshot);
  const build = publicBuild(snapshot, privateTerms);
  return {
    public: true,
    connection: { connected: snapshot.connection.connected === true },
    status,
    self: {
      health: round(snapshot.self.health),
      hunger: round(snapshot.self.hunger),
      dimension: snapshot.self.dimension,
      timePhase: snapshot.self.timePhase,
    },
    viewer: { status: snapshot.viewer.status },
    story: (snapshot.story ?? []).map(({ id, at, icon, text, highlight }) => ({ id, at, icon, text, highlight })),
    world: snapshot.world ?? null,
    inventory: snapshot.connection.connected && snapshot.inventory ? {
      items: snapshot.inventory.items.map(({ name, count }) => ({ name, count })),
      totalItems: snapshot.inventory.totalItems,
    } : null,
    equipment: snapshot.connection.connected && snapshot.equipment ? Object.fromEntries(EQUIPMENT_SLOTS.map((slot) => {
      const item = snapshot.equipment?.[slot];
      return [slot, item ? { name: item.name, count: item.count } : null];
    })) as EquipmentSummary : null,
    now: publicNow(snapshot, status, build, privateTerms),
    build: snapshot.connection.connected === true ? build : null,
    brain: publicBrain(snapshot),
    thinking: publicThinking(snapshot, privateTerms),
    vitals: publicVitals(snapshot),
    uptimeSeconds: wholeNumber(Math.floor(snapshot.process?.uptimeSeconds ?? 0)) ?? 0,
  };
}

/** Caches the redacted state so public polling never drives snapshot cost. */
export function cachedPublicState(
  snapshot: () => DashboardSnapshot | Promise<DashboardSnapshot>,
  ttlMs = 1000,
  now: () => number = Date.now,
): () => Promise<PublicViewerState> {
  let cached: { at: number; value: Promise<PublicViewerState> } | null = null;
  return () => {
    if (cached !== null && now() - cached.at < ttlMs) return cached.value;
    const value = Promise.resolve().then(snapshot).then(toPublicViewerState);
    cached = { at: now(), value };
    value.catch(() => { if (cached?.value === value) cached = null; });
    return value;
  };
}
