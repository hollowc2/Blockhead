import type { Bot } from "mineflayer";
import { assessPublicAdmission, type AdmissionAssessment, type AdmissionCheck } from "./public-action-admission.js";
import { safePublicPhysicalState, safePublicThreatState } from "./public-action-safety.js";
import type { GestureBot } from "./public-actions.js";
import type { Scheduler } from "./scheduler.js";

/** The live objects public admission reads. index.ts passes the real ones; tests pass a real scheduler/lease. */
export interface PublicAdmissionSources {
  session: () => { bot: Bot; publicSafety: { fresh(): boolean }; background: { publicWorkPending: boolean } } | null;
  connectionReady: () => boolean;
  retreatHealth: () => number;
  inDeathLoop: () => boolean;
  scheduler: Pick<Scheduler, "isHalted" | "worldActionDiagnostics" | "worldActionOwner" | "active" | "queued" | "interruptPending">;
  /** Any build/world project a slice could resume, including paused ones. */
  currentProject: () => unknown;
  decisionThinking: () => boolean;
  activeGoal: () => unknown;
  bootstrapComplete: () => boolean;
}

/** Owner of the world lease while a public gesture runs; see Scheduler.tryPublicWorldAction. */
export const PUBLIC_GESTURE_OWNER = "public-gesture";

/**
 * The single, synchronous admission predicate. Execution (before and inside
 * the lease) and private diagnostics call this same function, so a diagnostic
 * pass cannot disagree with what execution would decide at the same instant.
 */
export function createPublicAdmission(src: PublicAdmissionSources): (candidate: GestureBot | null, collectAll?: boolean) => AdmissionAssessment {
  return (candidate, collectAll = false) => {
    const live = src.session();
    return assessPublicAdmission([
      ["session", () => live !== null && candidate !== null && (live.bot as unknown) === candidate && src.connectionReady()],
      ["physical", () => safePublicPhysicalState(live!.bot, src.retreatHealth())],
      ["freshness", () => live!.publicSafety.fresh()],
      ["threats", () => safePublicThreatState(live!.bot)],
      ["death_loop", () => !src.inDeathLoop()],
      ["scheduler", () => !src.scheduler.isHalted],
      ["projects", () => src.currentProject() === null],
      ["lease_waiters", () => src.scheduler.worldActionDiagnostics.pending === 0],
      ["lease_owner", () => src.scheduler.worldActionOwner === null || src.scheduler.worldActionOwner === PUBLIC_GESTURE_OWNER],
      ["active_task", () => src.scheduler.active === null],
      ["queued_tasks", () => src.scheduler.queued.length === 0],
      ["interrupt", () => !src.scheduler.interruptPending],
      ["background", () => !live!.background.publicWorkPending],
      ["decision", () => !src.decisionThinking()],
      ["goal", () => src.activeGoal() === null],
      ["bootstrap", () => src.bootstrapComplete()],
    ] satisfies AdmissionCheck[], collectAll);
  };
}
