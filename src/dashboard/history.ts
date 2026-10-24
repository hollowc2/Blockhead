import type { StoryRepository, StoredStoryEntry } from "../memory/story.js";

/**
 * "Since your last visit" for the private viewer: the persisted story after
 * the viewer's last visit, counted into buildings finished, resources
 * gathered and deaths, plus the problems still open right now.
 */

export interface UnresolvedProblem { kind: "task" | "goal" | "build" | "blocker" | "system"; title: string; detail: string | null; since: string | null }

export interface HistorySummary {
  since: string | null;
  entries: readonly StoredStoryEntry[];
  /** More lines happened than `entries` holds. */
  truncated: boolean;
  summary: {
    buildsFinished: readonly string[];
    buildsStarted: number;
    gathered: readonly { resource: string; count: number }[];
    deaths: number;
    killers: readonly string[];
    goalsCompleted: number;
    toolsBroken: readonly string[];
    recoveries: number;
  };
  unresolved: readonly UnresolvedProblem[];
}

const MAX_ENTRIES = 150;

export function readHistory(store: StoryRepository, since: string | null, unresolved: readonly UnresolvedProblem[]): HistorySummary {
  const valid = since !== null && Number.isFinite(Date.parse(since)) ? new Date(since).toISOString() : null;
  const entries = valid === null ? store.recent(MAX_ENTRIES) : store.since(valid, MAX_ENTRIES + 1);
  const truncated = entries.length > MAX_ENTRIES;
  const facts = valid === null ? entries.flatMap((entry) => entry.facts === undefined ? [] : [entry.facts]) : store.factsSince(valid);
  const gathered = new Map<string, number>();
  const killers = new Map<string, number>();
  const summary = { buildsFinished: [] as string[], buildsStarted: 0, deaths: 0, goalsCompleted: 0, toolsBroken: [] as string[], recoveries: 0 };
  for (const fact of facts) {
    if (fact.kind === "gathered" && fact.resource !== undefined) gathered.set(fact.resource, (gathered.get(fact.resource) ?? 0) + (fact.count ?? 0));
    else if (fact.kind === "build_finished") summary.buildsFinished.push(fact.structure ?? "structure");
    else if (fact.kind === "build_started") summary.buildsStarted += 1;
    else if (fact.kind === "death") { summary.deaths += 1; if (fact.killer) killers.set(fact.killer, (killers.get(fact.killer) ?? 0) + 1); }
    else if (fact.kind === "goal_completed") summary.goalsCompleted += 1;
    else if (fact.kind === "tool_broken") summary.toolsBroken.push(fact.item ?? "tool");
    else if (fact.kind === "recovered") summary.recoveries += 1;
  }
  return {
    since: valid,
    entries: truncated ? entries.slice(1) : entries,
    truncated,
    summary: {
      ...summary,
      // factsSince is newest first; show builds in the order they finished.
      buildsFinished: valid === null ? summary.buildsFinished : summary.buildsFinished.reverse(),
      gathered: [...gathered].map(([resource, count]) => ({ resource, count })).sort((a, b) => b.count - a.count),
      killers: [...killers].sort((a, b) => b[1] - a[1]).map(([killer, count]) => count > 1 ? `${killer} ×${count}` : killer),
    },
    unresolved,
  };
}
