import type { Bot } from "mineflayer";
import { assessPublicAdmission, type AdmissionAssessment, type AdmissionCheck } from "./public-action-admission.js";
import { safePublicPhysicalState, safePublicThreatState, type ThreatProfile } from "./public-action-safety.js";
import { GESTURE_PROFILE, type GestureBot, type PublicAction } from "./public-actions.js";
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

/** The controller's per-action safety check: each gesture under its own threat profile. */
export function gestureSafety(admission: ReturnType<typeof createPublicAdmission>): (bot: GestureBot, action: PublicAction) => boolean {
  return (bot, action) => admission(bot, false, GESTURE_PROFILE[action]).safe;
}

/** Owner of the world lease while a public gesture runs; see Scheduler.tryPublicWorldAction. */
export const PUBLIC_GESTURE_OWNER = "public-gesture";

/**
 * The single, synchronous admission predicate. Execution (before and inside
 * the lease) and private diagnostics call this same function, so a diagnostic
 * pass cannot disagree with what execution would decide at the same instant.
 */
export function createPublicAdmission(src: PublicAdmissionSources): (candidate: GestureBot | null, collectAll?: boolean, profile?: ThreatProfile) => AdmissionAssessment {
  // Without a profile the strict turn policy applies.
  return (candidate, collectAll = false, profile = "turn") => {
    const live = src.session();
    return assessPublicAdmission([
      ["session", () => live !== null && candidate !== null && (live.bot as unknown) === candidate && src.connectionReady()],
      ["physical", () => safePublicPhysicalState(live!.bot, src.retreatHealth())],
      ["freshness", () => live!.publicSafety.fresh()],
      ["threats", () => safePublicThreatState(live!.bot, profile)],
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
