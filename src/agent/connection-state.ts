export type ConnectionState = "DISCONNECTED" | "CONNECTING" | "SPAWNED" | "INTERRUPTING" | "REINITIALIZING" | "READY";

export interface ReconnectBackoffOptions { baseMs?: number; maxMs?: number; jitter?: number; random?: () => number; }

/** Explicit connection lifecycle and bounded reconnect timing. */
export class ConnectionStateMachine {
  private _state: ConnectionState = "DISCONNECTED";
  private attempts = 0;
  private readonly options: Required<ReconnectBackoffOptions>;
  constructor(options: ReconnectBackoffOptions = {}) {
    this.options = { baseMs: options.baseMs ?? 1_000, maxMs: options.maxMs ?? 60_000, jitter: options.jitter ?? 0.2, random: options.random ?? Math.random };
  }
  get state(): ConnectionState { return this._state; }
  transition(next: ConnectionState): void {
    const allowed: Record<ConnectionState, readonly ConnectionState[]> = {
      DISCONNECTED: ["CONNECTING"], CONNECTING: ["SPAWNED", "DISCONNECTED"],
      SPAWNED: ["READY", "INTERRUPTING", "DISCONNECTED"], INTERRUPTING: ["REINITIALIZING", "DISCONNECTED"],
      REINITIALIZING: ["READY", "DISCONNECTED"], READY: ["INTERRUPTING", "DISCONNECTED"],
    };
    if (!allowed[this._state].includes(next)) throw new Error(`invalid connection transition ${this._state} -> ${next}`);
    this._state = next;
  }
  failureDelayMs(): number {
    const nominal = Math.min(this.options.maxMs, this.options.baseMs * 2 ** this.attempts++);
    const spread = 1 - this.options.jitter + this.options.random() * this.options.jitter * 2;
    return Math.round(nominal * spread);
  }
  markStable(): void { this.attempts = 0; }
}
