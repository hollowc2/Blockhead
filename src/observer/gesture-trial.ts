import { PUBLIC_ACTIONS, type PublicAction } from "../agent/public-actions.js";
import type { Capture, CaptureIntegrity } from "./gesture-collector.js";
import { evaluateGesture, GESTURE_RULES, type GestureEvaluation, type GestureRequest } from "./gesture-evaluator.js";
import type { StatusRecord } from "./gesture-records.js";

/** The subset of the private loopback GET /public-interactions the trial reads. */
export interface TrialDiagnostics {
  configuredActions: boolean;
  questionsEnabled: boolean;
  actions: boolean;
  actionsCooldownMs: number;
  helloCooldownMs: number;
  admissionSafe: boolean;
  blocked: string[];
  quarantined: boolean;
  gestureActive: boolean;
  /** Controller dispatch counters: a change not caused by the trial means another visitor acted. */
  dispatches: Record<"refused" | "dispatched" | "interrupted" | "uncertain", number>;
}
export interface TrialIO {
  now(): number;
  sleep(ms: number): Promise<void>;
  observerStatus(): Promise<StatusRecord>;
  arm(seconds: number): Capture;
  diagnostics(): Promise<TrialDiagnostics>;
  /** Private authenticated control; questions keep their current setting. */
  setActions(enabled: boolean, questionsEnabled: boolean): Promise<void>;
  /** One public POST, never retried. Resolves to the response's delivery field or "lost". */
  publicAction(action: PublicAction): Promise<{ status: number; delivery: GestureRequest["delivery"] }>;
  log(event: Record<string, unknown>): void;
}
export interface TrialOptions {
  /** Authorized enablement window; actions are off again when it ends, whatever happened. */
  windowMs: number;
  /** Longest one capture may wait for an eligible moment before re-arming. */
  captureWaitMs: number;
  actions?: readonly PublicAction[];
  signal?: AbortSignal;
}
export type TrialStop = "completed" | "observer_not_ready" | "preflight_failed" | "window_expired" | "not_pass" | "transport" | "other_visitor" | "quarantined" | "aborted" | "error";
export interface TrialReport {
  stop: TrialStop;
  enabledMs: number | null;
  disabledVerified: boolean;
  results: (Pick<GestureEvaluation, "action" | "outcome" | "reasons" | "delivery" | "evidence"> & { http: number })[];
  integrity: CaptureIntegrity[];
}

const BASELINE_MS = GESTURE_RULES.baselineTicks * 50 + 500;
const POST_MS = GESTURE_RULES.settleMs + GESTURE_RULES.postTicks * 50 + 500;

/**
 * Staged supervised trial. Observer health and baseline are established while
 * actions are still off; actions are enabled only for *windowMs*; each gesture
 * is requested at most once, only when every admission gate passes in the same
 * session; anything but an independent pass stops the trial without a retry;
 * actions are disabled in every outcome, and that is verified.
 */
export async function runGestureTrial(io: TrialIO, options: TrialOptions): Promise<TrialReport> {
  const report: TrialReport = { stop: "error", enabledMs: null, disabledVerified: false, results: [], integrity: [] };
  const actions = options.actions ?? PUBLIC_ACTIONS;
  let enabledAt: number | null = null, questions: boolean | null = null;
  const effects = (d: TrialDiagnostics["dispatches"]): string => `${d.dispatched}/${d.interrupted}/${d.uncertain}`;
  const aborted = (): boolean => options.signal?.aborted === true;
  try {
    const status = await io.observerStatus();
    if (!status.supported || !status.complete || status.unhooked) { report.stop = "observer_not_ready"; return report; }
    const before = await io.diagnostics();
    questions = before.questionsEnabled;
    if (before.configuredActions || before.quarantined || before.gestureActive) { report.stop = "preflight_failed"; io.log({ event: "preflight", configuredActions: before.configuredActions, quarantined: before.quarantined }); return report; }
    // Baseline and observer health with actions still off.
    const health = io.arm(5);
    await health.ready;
    await io.sleep(3000);
    const healthIntegrity = await health.stop();
    const ticks = health.records.filter(r => r.type === "tick");
    if (healthIntegrity.invalidLines > 0 || healthIntegrity.truncated || ticks.length < 40 || ticks.some(t => t.type === "tick" && t.bob === null)) {
      report.stop = "observer_not_ready"; io.log({ event: "observer_health", ticks: ticks.length, ...healthIntegrity }); return report;
    }
    if (aborted()) { report.stop = "aborted"; return report; }

    await io.setActions(true, before.questionsEnabled);
    enabledAt = io.now();
    io.log({ event: "actions_enabled", windowMs: options.windowMs });
    const deadline = enabledAt + options.windowMs;
    let expected = (await io.diagnostics()).dispatches;
    for (const action of actions) {
      let done = false;
      while (!done) {
        if (aborted()) { report.stop = "aborted"; return report; }
        if (io.now() >= deadline) { report.stop = "window_expired"; return report; }
        const capture = io.arm(Math.min(300, Math.ceil((options.captureWaitMs + BASELINE_MS + POST_MS) / 1000) + 5));
        try {
          await capture.ready;
          await io.sleep(BASELINE_MS);
          // Wait (bounded) for a moment when every gate passes and no cooldown applies.
          const until = Math.min(deadline, io.now() + options.captureWaitMs);
          let eligible: TrialDiagnostics | null = null;
          while (io.now() < until && !aborted()) {
            const d = await io.diagnostics();
            if (d.quarantined) { report.stop = "quarantined"; return report; }
            if (effects(d.dispatches) !== effects(expected)) { report.stop = "other_visitor"; return report; }
            if (d.admissionSafe && d.actions && d.actionsCooldownMs === 0 && (action !== "hello" || d.helloCooldownMs === 0)) { eligible = d; break; }
            await io.sleep(500);
          }
          if (!eligible) { await capture.stop(); continue; }
          const sentAtMs = io.now();
          const reply = await io.publicAction(action).catch(() => ({ status: 0, delivery: "lost" as const }));
          const respondedAtMs = io.now();
          await io.sleep(POST_MS);
          const integrity = await capture.stop();
          report.integrity.push(integrity);
          const evaluation = evaluateGesture(capture.records, { action, sentAtMs, respondedAtMs, delivery: reply.delivery }, GESTURE_RULES, integrity);
          report.results.push({ action, outcome: evaluation.outcome, reasons: evaluation.reasons, delivery: evaluation.delivery, evidence: evaluation.evidence, http: reply.status });
          io.log({ event: "gesture", action, http: reply.status, delivery: reply.delivery, outcome: evaluation.outcome, reasons: evaluation.reasons });
          const after = await io.diagnostics();
          const ours = { ...expected, ...(reply.delivery === "sent" ? { dispatched: expected.dispatched + 1 } : {}) };
          if (reply.delivery !== "sent") { report.stop = "transport"; return report; }
          if (after.dispatches.dispatched !== ours.dispatched || after.dispatches.interrupted !== expected.interrupted || after.dispatches.uncertain !== expected.uncertain) { report.stop = "other_visitor"; return report; }
          if (evaluation.outcome !== "pass") { report.stop = "not_pass"; return report; }
          expected = after.dispatches;
          done = true;
        } finally { await capture.stop().catch(() => undefined); }
      }
    }
    report.stop = "completed";
    return report;
  } catch (error) {
    io.log({ event: "error", error: error instanceof Error ? error.message.slice(0, 200) : "unknown" });
    report.stop = "error";
    return report;
  } finally {
    // Always leave actions off, and prove it. Questions keep their prior state.
    if (enabledAt !== null) report.enabledMs = io.now() - enabledAt;
    for (let attempt = 0; attempt < 3 && !report.disabledVerified; attempt++) {
      try {
        // Without a preflight read the question setting is unknown: do not write it, only verify.
        if (questions !== null) await io.setActions(false, questions);
        report.disabledVerified = (await io.diagnostics()).configuredActions === false;
      } catch { await io.sleep(1000).catch(() => undefined); }
    }
    io.log({ event: "actions_disabled", verified: report.disabledVerified, stop: report.stop });
  }
}
