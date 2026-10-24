import type { EventBus } from "../events/bus.js";
import type { EventName, EventPayload } from "../events/types.js";
import type { StoryFacts, StoryRepository } from "../memory/story.js";

/**
 * Viewer-facing story feed: what CobbleBob did, in plain language. Entries
 * are rendered from structured event fields, never from free text that may
 * carry coordinates, so the feed is safe for the public viewer.
 */

export type StoryIcon = "day" | "night" | "goal" | "build" | "death" | "respawn" | "gather" | "tool" | "hostile" | "explore" | "home" | "fight";

export interface StoryEntry {
  id: number;
  at: string;
  icon: StoryIcon;
  text: string;
  /** Big moments the page announces with a toast. */
  highlight: boolean;
  /** Structured facts for private summaries; the public viewer never receives them. */
  facts?: StoryFacts;
}

export interface StoryFeedOptions {
  bus: EventBus;
  maxEntries?: number;
  now?: () => number;
  /** Persists every line so history survives restarts; ids then come from the store. */
  store?: StoryRepository;
}

const DEFAULT_MAX_ENTRIES = 40;
/** The same line within this window is a repeat, not news. */
const REPEAT_WINDOW_MS = 120_000;
/** Hostile sightings are frequent; one per mob type per window. */
const HOSTILE_WINDOW_MS = 300_000;
/** Mobs farther than this are loaded-chunk background, not a sighting. */
const HOSTILE_SIGHTING_RANGE = 16;

/** Task types worth a story line when they finish; the rest is routine. */
const TASK_STORIES: Partial<Record<string, { icon: StoryIcon; text: string }>> = {
  night_shelter: { icon: "home", text: "Made it to shelter for the night" },
  light_home: { icon: "home", text: "Lit up home with torches" },
  gather_food: { icon: "gather", text: "Gathered food" },
  upgrade_equipment: { icon: "tool", text: "Upgraded equipment" },
  build_base: { icon: "build", text: "Worked on the base" },
  defend_self: { icon: "fight", text: "Fought off an attack" },
};

/** "minecraft:iron_ore" / "village:cottage" → "iron ore" / "cottage". */
export function humanize(value: unknown, fallback = "something"): string {
  if (typeof value !== "string" || value.trim() === "") return fallback;
  return value.trim().replace(/^[a-z_]+:/, "").replace(/_/g, " ");
}

/** Removes coordinate-like number runs from free text (goal descriptions are LLM-written). */
export function stripCoordinates(value: string): string {
  return value
    .replace(/\(?\s*-?\d+(?:\.\d+)?\s*[, ]\s*-?\d+(?:\.\d+)?(?:\s*[, ]\s*-?\d+(?:\.\d+)?)?\s*\)?/g, "")
    .replace(/\s+(at|near|to|around)\s*([.,;]|$)/gi, "$2")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function article(noun: string): string {
  return /^[aeiou]/i.test(noun) ? `an ${noun}` : `a ${noun}`;
}

export class StoryFeed {
  private readonly entries: StoryEntry[] = [];
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly unsubscribers: Array<() => void> = [];
  private readonly lastHostileAt = new Map<string, number>();
  private nextId = 1;
  private phase: "day" | "night" | null = null;
  private readonly store: StoryRepository | undefined;

  constructor(options: StoryFeedOptions) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.now = options.now ?? Date.now;
    this.store = options.store;
    if (this.store !== undefined) {
      try {
        for (const entry of this.store.recent(this.maxEntries)) this.entries.push({ ...entry, icon: entry.icon as StoryIcon });
      } catch { /* history unavailable: start fresh */ }
    }
    const on = <K extends EventName>(name: K, handler: (payload: EventPayload<K>) => void): void => {
      this.unsubscribers.push(options.bus.on(name, handler));
    };

    on("time.day", () => this.time("day"));
    on("time.night", () => this.time("night"));
    on("goal.started", (p) => this.add("goal", p.goal.source === "owner" ? "Took on a request from the owner" : `New goal: ${this.describe(p.goal.description)}`, false, { kind: "goal_started" }));
    on("goal.completed", (p) => this.add("goal", p.goal.source === "owner" ? "Finished the owner's request" : `Goal complete: ${this.describe(p.goal.description)}`, true, { kind: "goal_completed" }));
    on("build_project.created", (p) => {
      const structure = humanize(p.project.structureType ?? p.project.userGoal, "structure");
      this.add("build", `Started building ${article(structure)}`, false, { kind: "build_started", structure });
    });
    on("build_project.verified", (p) => {
      const structure = humanize(p.project.structureType ?? p.project.userGoal, "structure");
      this.add("build", `Finished building ${article(structure)}!`, true, { kind: "build_finished", structure });
    });
    on("death", (p) => this.add("death", p.killer ? `Was killed by ${article(humanize(p.killer.name, "mob"))}` : "Died", true, { kind: "death", killer: p.killer ? humanize(p.killer.name, "mob") : null }));
    on("respawn", () => this.add("respawn", "Respawned and back on his feet"));
    on("death.recovery.completed", (p) => { if (p.recovered) this.add("respawn", "Recovered his dropped items", false, { kind: "recovered" }); });
    on("resource.gather.complete", (p) => {
      if (p.status === "completed" && typeof p.gathered === "number" && p.gathered > 0) {
        const resource = humanize(p.resource, "items");
        this.add("gather", `Gathered ${p.gathered} ${resource}`, false, { kind: "gathered", resource, count: p.gathered });
      }
    });
    on("tool.broken", (p) => this.add("tool", `His ${humanize(p.item, "tool")} broke`, false, { kind: "tool_broken", item: humanize(p.item, "tool") }));
    on("hostile.detected", (p) => {
      if (p.distance === null || p.distance > HOSTILE_SIGHTING_RANGE) return;
      const type = humanize(p.type, "monster");
      const last = this.lastHostileAt.get(type);
      if (last !== undefined && this.now() - last < HOSTILE_WINDOW_MS) return;
      this.lastHostileAt.set(type, this.now());
      this.add("hostile", `Spotted ${article(type)}`);
    });
    on("expedition.entered", () => this.add("explore", "Set out on an expedition"));
    on("expedition.left", () => this.add("explore", "Back home from an expedition"));
    on("task.completed", (p) => {
      const story = TASK_STORIES[p.task.type];
      if (story) this.add(story.icon, story.text);
    });
  }

  recent(): readonly StoryEntry[] { return this.entries.slice(); }

  dispose(): void {
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers.length = 0;
  }

  /** The first phase after connecting is a sync, not a sunrise. */
  private time(phase: "day" | "night"): void {
    const previous = this.phase;
    this.phase = phase;
    if (previous === null || previous === phase) return;
    this.add(phase, phase === "day" ? "A new day dawns" : "Night falls");
  }

  private describe(description: string): string {
    const clean = stripCoordinates(description).replace(/[.!]+$/, "");
    return clean.length > 90 ? `${clean.slice(0, 89).trimEnd()}…` : clean || "something new";
  }

  private add(icon: StoryIcon, text: string, highlight = false, facts?: StoryFacts): void {
    const at = this.now();
    const last = this.entries.at(-1);
    if (last && last.text === text && at - Date.parse(last.at) < REPEAT_WINDOW_MS) return;
    const entry = { at: new Date(at).toISOString(), icon, text, highlight, ...(facts === undefined ? {} : { facts }) };
    let id = this.nextId++;
    if (this.store !== undefined) {
      try { id = this.store.append(entry); } catch { /* keep the in-memory line */ }
      // A failed write must not reuse an id an earlier persisted line holds.
      id = Math.max(id, (last?.id ?? 0) + 1);
    }
    this.entries.push({ id, ...entry });
    if (this.entries.length > this.maxEntries) this.entries.splice(0, this.entries.length - this.maxEntries);
  }
}
