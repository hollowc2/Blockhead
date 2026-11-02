/** Broadcast recovery is separate from the interactive viewer's bounded retries. */
export class BroadcastViewerHealth {
  constructor({ stallMs = 120_000, cooldownMs = 120_000 } = {}) {
    this.stallMs = stallMs;
    this.cooldownMs = cooldownMs;
    this.stalledSince = null;
    this.lastRecoveryAt = null;
  }

  shouldRecover(state, now) {
    // Waiting for Minecraft is expected. Its return will trigger the viewer's
    // normal reconnect path; reloading while Bob is offline adds needless work.
    if (state === "connected" || state === "offline") {
      this.stalledSince = null;
      return false;
    }
    this.stalledSince ??= now;
    if (now - this.stalledSince < this.stallMs) return false;
    if (this.lastRecoveryAt !== null && now - this.lastRecoveryAt < this.cooldownMs) return false;
    this.stalledSince = now;
    this.lastRecoveryAt = now;
    return true;
  }
}
