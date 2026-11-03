/**
 * Chooses what the broadcast shows. Pure: callers pass monotonic time
 * (performance.now()) and health observations; nothing here reads a clock.
 *
 *   STARTING    process up, live world not yet admitted      → holding "starting"
 *   LIVE        all required signals healthy                 → live world frames
 *   RECOVERING  live failed; automatic recovery is running   → holding "reconnecting"
 *   HOLDING     still unhealthy after holdAfterMs            → holding "break"
 *   MAINTENANCE operator latch; never cleared automatically  → holding "break"
 *
 * Precedence: maintenance latch > hard failure > debounced health loss.
 * Unknown health (null/undefined) counts as unhealthy. Returning to LIVE needs
 * admitMs of continuously healthy signals AND a live frame rendered after that
 * window began, so a cached frame from before the outage can never re-admit.
 */

export const STATES = Object.freeze({ STARTING: "STARTING", LIVE: "LIVE", RECOVERING: "RECOVERING", HOLDING: "HOLDING", MAINTENANCE: "MAINTENANCE" });

/** Holding copy per state. Only these allowlisted labels ever reach the picture. */
export const HOLDING_VARIANT = Object.freeze({ STARTING: "starting", RECOVERING: "reconnecting", HOLDING: "break", MAINTENANCE: "break" });

export const DEFAULTS = Object.freeze({
  debounceMs: 5_000,        // transient loss → holding; ≤ 10 s with the 2 s poll and its 3 s probe timeout
  admitMs: 15_000,          // sustained health before returning to live
  maxAdmitMs: 120_000,      // admission window grows with flapping, capped here
  flapWindowMs: 600_000,    // live exits counted over this window
  holdAfterMs: 600_000,     // stop saying "Reconnecting" after 10 min of failed recovery
  gapMs: 8_000,             // an evaluation this late means *we* stalled: don't judge on it
});

const REQUIRED = ["bot", "viewer", "renderer"];

/**
 * The page's offline scene (recent story, milestones, lifetime stats) is a
 * truthful picture while the bot process is up but Bob is disconnected from
 * Minecraft, so exactly that combination counts as healthy: the bot's /health
 * answers and says "disconnected" (not unreachable, unknown, dead or stale),
 * the page reports its own offline scene (it holds a fresh answer from the bot
 * saying so; see renderer.viewerHealthSignal), and the renderer is healthy.
 * Everything else passes through unchanged, so a down bot, a crashed or frozen
 * renderer, or a page without the scene still gets the fixed holding card.
 */
export function withOfflineScene(health) {
  if (health?.bot?.reason !== "bot-disconnected" || health?.viewer?.reason !== "viewer-offline-scene" || health?.renderer?.ok !== true) return health;
  return { ...health, bot: { ok: true, reason: "offline-scene" }, viewer: { ok: true, reason: "offline-scene" } };
}

export class BroadcastState {
  constructor(now, options = {}) {
    this.o = { ...DEFAULTS, ...options };
    this.state = STATES.STARTING;
    this.reason = "startup";
    this.since = now;
    this.startedAt = now;
    this.unhealthySince = null;
    this.healthySince = null;
    this.failedAt = now;
    this.lastEvalAt = null;
    this.liveExits = [];
    this.transitions = 0;
  }

  get variant() { return this.state === STATES.LIVE ? null : HOLDING_VARIANT[this.state]; }
  get sourceKind() { return this.state === STATES.LIVE ? "live" : "holding"; }

  /** Current admission window: doubles per recent live exit beyond the first. */
  admitWindow(now) {
    this.liveExits = this.liveExits.filter(at => now - at < this.o.flapWindowMs);
    const extra = Math.max(0, this.liveExits.length - 1);
    return Math.min(this.o.maxAdmitMs, this.o.admitMs * 2 ** Math.min(extra, 4));
  }

  /**
   * @param {number} now monotonic ms
   * @param {{ health: Record<string, {ok: boolean, reason?: string} | null | undefined>,
   *           hardFailure?: string | null, liveFrameAt?: number | null, maintenance?: boolean }} input
   * @returns {null | {from: string, to: string, reason: string, at: number}} the transition, if any
   */
  update(now, { health = {}, hardFailure = null, liveFrameAt = null, maintenance = false }) {
    const gap = this.lastEvalAt !== null && now - this.lastEvalAt > this.o.gapMs;
    this.lastEvalAt = now;
    if (maintenance) {
      this.unhealthySince = this.healthySince = null;
      return this.state === STATES.MAINTENANCE ? null : this.go(now, STATES.MAINTENANCE, "operator-maintenance");
    }
    const failing = REQUIRED.map(name => [name, health[name]]).find(([, h]) => !h?.ok);
    const failReason = hardFailure ?? (failing ? (failing[1]?.reason ?? `${failing[0]}-unknown`) : null);

    if (this.state === STATES.LIVE) {
      if (hardFailure) return this.fail(now, hardFailure);
      if (!failReason) { this.unhealthySince = null; return null; }
      // After our own stall every age looks old; restart the debounce instead of trusting it.
      if (gap || this.unhealthySince === null) { this.unhealthySince = now; return null; }
      return now - this.unhealthySince >= this.o.debounceMs ? this.fail(now, failReason) : null;
    }

    // Leaving maintenance resumes from the honest "not yet admitted" state.
    if (this.state === STATES.MAINTENANCE) return this.go(now, STATES.RECOVERING, "maintenance-cleared", { failedAt: now });

    if (failReason || gap) {
      this.healthySince = null;
      if (failReason) this.reason = failReason;
      if (this.state !== STATES.HOLDING && now - this.failedAt >= this.o.holdAfterMs) return this.go(now, STATES.HOLDING, failReason ?? this.reason);
      return null;
    }
    this.healthySince ??= now;
    const admitted = now - this.healthySince >= this.admitWindow(now) && liveFrameAt !== null && liveFrameAt >= this.healthySince;
    return admitted ? this.go(now, STATES.LIVE, "healthy") : null;
  }

  fail(now, reason) {
    this.liveExits.push(now);
    return this.go(now, STATES.RECOVERING, reason, { failedAt: now });
  }

  go(now, to, reason, { failedAt } = {}) {
    const from = this.state;
    this.state = to; this.reason = reason; this.since = now; this.transitions++;
    this.unhealthySince = this.healthySince = null;
    if (failedAt !== undefined) this.failedAt = failedAt;
    return { from, to, reason, at: now };
  }
}
