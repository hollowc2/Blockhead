/**
 * Reads the bot's private loopback /health and reduces it to booleans and
 * reason codes. Nothing from the snapshot is forwarded: coordinates, task and
 * goal text, model endpoints and errors stay inside this function.
 */

export const BOT_DEFAULTS = Object.freeze({
  // Minecraft sends a time update every 20 ticks (1 s). 30 s allows server lag
  // spikes and matches the client's own keep-alive timeout; a quiet connection
  // (idle bot, no chunk or entity traffic) still gets time updates.
  maxObservationAgeMs: 30_000,
  // The status server shares the bot's event loop; long synchronous planning
  // can delay replies. Only a missing answer for this long counts as loss.
  unreachableMs: 10_000,
  timeoutMs: 3_000,
});

/** @returns {{ ok: boolean, reason?: string }} */
export function assessBot(snapshot, { maxObservationAgeMs = BOT_DEFAULTS.maxObservationAgeMs } = {}) {
  if (!snapshot || typeof snapshot !== "object" || snapshot.schema !== 1 || typeof snapshot.minecraft !== "object" || snapshot.minecraft === null) return { ok: false, reason: "bot-unknown" };
  const mc = snapshot.minecraft;
  if (mc.connected !== true) return { ok: false, reason: "bot-disconnected" };
  if (!(typeof mc.health === "number" && mc.health > 0)) return { ok: false, reason: "bot-dead" };
  const age = mc.serverObservationAgeMs;
  if (typeof age !== "number" || !Number.isFinite(age) || age < 0 || age > maxObservationAgeMs) return { ok: false, reason: "bot-stale" };
  return { ok: true };
}

/** Coarse, private autonomy summary. Degraded autonomy never selects the holding scene. */
export function assessAutonomy(snapshot) {
  if (!snapshot || snapshot.schema !== 1) return "unknown";
  const reasons = Array.isArray(snapshot.autonomy?.reasons) ? snapshot.autonomy.reasons : [];
  if (reasons.includes("death-loop-brake")) return "death-loop-brake";
  if (snapshot.autonomy?.paused === true) return "paused";
  if (snapshot.llm?.state === "failing") return "model-degraded";
  if (typeof snapshot.consecutiveTaskFailures === "number" && snapshot.consecutiveTaskFailures >= 5) return "task-failures";
  return "ok";
}

export async function fetchSnapshot(url, { timeoutMs = BOT_DEFAULTS.timeoutMs, fetchFn = fetch } = {}) {
  try {
    const response = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
    if (!response.ok) return null;
    const text = await response.text();
    if (text.length > 2_000_000) return null;
    return JSON.parse(text);
  } catch { return null; }
}

export class BotHealthMonitor {
  constructor(options = {}) {
    this.o = { ...BOT_DEFAULTS, ...options };
    this.last = null;           // { ok, reason, at }
    this.autonomy = "unknown";
    this.inFlight = false;
  }

  /** Record one poll; snapshot null means no answer. */
  observe(now, snapshot) {
    if (snapshot === null) return;
    this.last = { ...assessBot(snapshot, this.o), at: now };
    this.autonomy = assessAutonomy(snapshot);
  }

  health(now) {
    if (this.last === null) return { ok: false, reason: "bot-unknown" };
    if (now - this.last.at > this.o.unreachableMs) return { ok: false, reason: "bot-unreachable" };
    return this.last.ok ? { ok: true } : { ok: false, reason: this.last.reason };
  }

  async poll(url, now, fetchFn) {
    if (this.inFlight) return;
    this.inFlight = true;
    try { this.observe(now(), await fetchSnapshot(url, { timeoutMs: this.o.timeoutMs, fetchFn })); }
    finally { this.inFlight = false; }
  }
}
