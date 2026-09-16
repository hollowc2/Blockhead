/** Scheduler-owned serialization and common cancellation helpers for Mineflayer. */
export interface WorldActionLease {
  readonly owner: string;
  /** A lease-local signal. It is aborted when the caller cancels or the lease times out. */
  readonly signal: AbortSignal;
  /** Primitive acknowledgement: resolves only after the leased action settles. */
  readonly acknowledged: Promise<void>;
}

export interface WorldActionOptions {
  /** Maximum time to wait for the primitive to settle after cancellation. */
  timeoutMs?: number;
  /** Called when the lease is cancelled or times out, before acknowledgement is awaited. */
  onCancel?: () => void | Promise<void>;
}

interface Waiter {
  owner: string; signal: AbortSignal;
  resolve: (lease: WorldActionLease) => void;
  reject: (error: Error) => void;
  onAbort: () => void;
}

export class WorldActionExecutor {
  private owner: string | null = null;
  private readonly waiters: Waiter[] = [];
  get activeOwner(): string | null { return this.owner; }
  get pendingCount(): number { return this.waiters.length; }

  async run<T>(owner: string, signal: AbortSignal, action: (lease: WorldActionLease) => Promise<T>, options: WorldActionOptions = {}): Promise<T> {
    const lease = await this.acquire(owner, signal);
    const controller = new AbortController();
    let cancelled = false;
    let cancelReason: unknown;
    const forwardAbort = (): void => {
      cancelled = true;
      cancelReason = signal.reason;
      controller.abort(signal.reason);
    };
    if (signal.aborted) forwardAbort();
    else signal.addEventListener("abort", forwardAbort, { once: true });
    const cancel = (reason: unknown = new Error("world action cancelled")): void => {
      if (cancelled) return;
      cancelled = true;
      cancelReason = reason;
      controller.abort(reason);
      void options.onCancel?.();
    };
    const acknowledged = Promise.withResolvers<void>();
    const leased: WorldActionLease = { owner, signal: controller.signal, acknowledged: acknowledged.promise };
    const actionPromise = Promise.resolve().then(() => action(leased));
    const timeout = options.timeoutMs === undefined ? undefined : setTimeout(() => cancel(new Error("world action lease timed out")), options.timeoutMs);
    try {
      const result = await actionPromise;
      if (cancelled) throw abortError(cancelReason);
      return result;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      signal.removeEventListener("abort", forwardAbort);
      acknowledged.resolve();
      this.release(leased);
    }
  }

  assertAvailable(): void {
    if (this.owner !== null) throw new Error(`world action still owned by ${this.owner}`);
  }

  private acquire(owner: string, signal: AbortSignal): Promise<WorldActionLease> {
    if (signal.aborted) return Promise.reject(abortError(signal.reason));
    if (this.owner === null) {
      this.owner = owner;
      return Promise.resolve({ owner, signal, acknowledged: Promise.resolve() });
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { owner, signal, resolve, reject, onAbort: () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(abortError(signal.reason));
      }};
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private release(lease: WorldActionLease): void {
    if (lease.owner !== this.owner) return;
    this.owner = null;
    while (this.waiters.length > 0) {
      const next = this.waiters.shift()!;
      next.signal.removeEventListener("abort", next.onAbort);
      if (next.signal.aborted) { next.reject(abortError(next.signal.reason)); continue; }
      this.owner = next.owner;
      next.resolve({ owner: next.owner, signal: next.signal, acknowledged: Promise.resolve() });
      return;
    }
  }
}

export function abortError(reason: unknown): Error {
  const error = reason instanceof Error ? reason : new Error(reason === undefined ? "operation aborted" : String(reason));
  error.name = "AbortError";
  return error;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal.reason);
}

/** Best-effort shutdown for every long-lived primitive used by the agent. */
export async function stopWorldPrimitives(bot: {
  pathfinder?: { stop?: () => void; setGoal?: (goal: null) => void };
  collectBlock?: { cancelTask?: () => Promise<void> | void };
  pvp?: { stop?: () => void | Promise<void> };
  currentWindow?: unknown;
}): Promise<void> {
  try { bot.pathfinder?.stop?.(); } catch { /* best effort */ }
  try { bot.pathfinder?.setGoal?.(null); } catch { /* best effort */ }
  try { await bot.collectBlock?.cancelTask?.(); } catch { /* best effort */ }
  try { await bot.pvp?.stop?.(); } catch { /* best effort */ }
  try {
    const window = bot.currentWindow as { close?: () => Promise<void> | void } | null | undefined;
    await window?.close?.();
  } catch { /* best effort */ }
}
