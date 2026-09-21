import { AsyncLocalStorage } from "node:async_hooks";
import { logger } from "../logger.js";
import type { MutationAuthorizationContext } from "../policy/destructive-authorization.js";

/** Scheduler-owned serialization and common cancellation helpers for Mineflayer. */
export interface WorldActionLease {
  readonly owner: string;
  /** A lease-local signal. It is aborted when the caller cancels or the lease times out. */
  readonly signal: AbortSignal;
  /** Primitive acknowledgement: resolves only after the leased action settles. */
  readonly acknowledged: Promise<void>;
  /** Last-safe-point policy check supplied by the session dispatcher. */
  readonly beforeMutation?: (mutation: WorldMutation) => void;
  readonly authorization?: MutationAuthorizationContext;
}

export interface WorldMutation {
  action: string;
  point?: { x: number; y: number; z: number };
  blockName?: string;
  userRequested?: boolean;
}

const worldActionContext = new AsyncLocalStorage<WorldActionLease>();
const teardownHooks = new WeakMap<object, Set<() => void>>();
const teardownChains = new WeakMap<object, Promise<void>>();

/** Register synchronous state invalidation for the unleased teardown boundary. */
export function registerWorldActionTeardown(bot: object, hook: () => void): () => void {
  let hooks = teardownHooks.get(bot);
  if (!hooks) { hooks = new Set(); teardownHooks.set(bot, hooks); }
  hooks.add(hook);
  return () => hooks?.delete(hook);
}

/** Run code with the lease that owns its Mineflayer mutations. */
export function withWorldActionLease<T>(lease: WorldActionLease, action: () => Promise<T>): Promise<T> {
  return worldActionContext.run(lease, action);
}

/** Require a scheduler-owned context before a primitive touches the world. */
export function requireWorldActionLease(signal?: AbortSignal): WorldActionLease {
  const lease = worldActionContext.getStore();
  if (lease === undefined) throw new Error("world mutation requires an active scheduler lease");
  throwIfAborted(lease.signal);
  throwIfAborted(signal);
  return lease;
}

/** Require ownership for cleanup that must still run after the lease signal aborts. */
export function requireWorldActionCleanupLease(): WorldActionLease {
  const lease = worldActionContext.getStore();
  if (lease === undefined) throw new Error("world cleanup requires an active scheduler lease");
  return lease;
}

export interface WorldActionOptions {
  /** Maximum time to wait for the primitive to settle after cancellation. */
  timeoutMs?: number;
  /** Called when the lease is cancelled or times out, before acknowledgement is awaited. */
  onCancel?: () => void | Promise<void>;
  /** Recovery hook for a plugin that ignores cancellation or leaves state open. */
  onRecovery?: (reason: unknown) => void | Promise<void>;
  beforeMutation?: (mutation: WorldMutation) => void;
  authorization?: MutationAuthorizationContext;
}

export interface WorldActionDiagnostics {
  owner: string | null;
  pending: number;
  cancelled: boolean;
  startedAt: number | null;
}

const RECOVERY_GRACE_MS = 5_000;

interface Waiter {
  owner: string; signal: AbortSignal;
  resolve: (lease: WorldActionLease) => void;
  reject: (error: Error) => void;
  onAbort: () => void;
}

export class WorldActionExecutor {
  private owner: string | null = null;
  private readonly waiters: Waiter[] = [];
  private cancelled = false;
  private startedAt: number | null = null;
  get activeOwner(): string | null { return this.owner; }
  get pendingCount(): number { return this.waiters.length; }
  get diagnostics(): WorldActionDiagnostics { return { owner: this.owner, pending: this.waiters.length, cancelled: this.cancelled, startedAt: this.startedAt }; }

  async run<T>(owner: string, signal: AbortSignal, action: (lease: WorldActionLease) => Promise<T>, options: WorldActionOptions = {}): Promise<T> {
    if (owner.trim() === "") return Promise.reject(new Error("world action owner must be non-empty"));
    const lease = await this.acquire(owner, signal);
    const controller = new AbortController();
    let cancelled = false;
    let cancelReason: unknown;
    let cancellationCleanup: Promise<void> = Promise.resolve();
    const cancel = (reason: unknown = new Error("world action cancelled")): void => {
      if (cancelled) return;
      cancelled = true;
      cancelReason = reason;
      controller.abort(reason);
      cancellationCleanup = Promise.resolve(options.onCancel?.()).catch(() => undefined);
    };
    const forwardAbort = (): void => { cancel(signal.reason); };
    if (signal.aborted) forwardAbort();
    else signal.addEventListener("abort", forwardAbort, { once: true });
    const acknowledged = Promise.withResolvers<void>();
    const leased: WorldActionLease = { owner, signal: controller.signal, acknowledged: acknowledged.promise, beforeMutation: options.beforeMutation, authorization: options.authorization };
    this.cancelled = false;
    this.startedAt = Date.now();
    const actionPromise = withWorldActionLease(leased, async () => {
      throwIfAborted(controller.signal);
      return action(leased);
    });
    // Always observe a late plugin settlement. The race below is the terminal
    // boundary; actionPromise is intentionally not awaited after it wins.
    void actionPromise.catch(() => undefined);
    const timeoutMs = options.timeoutMs;
    const timeout = timeoutMs === undefined ? undefined : setTimeout(() => cancel(new Error("world action lease timed out")), timeoutMs);
    let actionError: unknown = null;
    try {
      let result: T;
      try {
        if (timeoutMs === undefined) {
          result = await actionPromise;
        } else {
          const timeoutResult = new Promise<never>((_, reject) => {
            const handle = setTimeout(() => reject(new Error("world action lease timed out")), timeoutMs);
            void actionPromise.then(() => clearTimeout(handle), () => clearTimeout(handle));
          });
          result = await Promise.race([actionPromise, timeoutResult]);
        }
      }
      catch (error) { actionError = error; throw error; }
      // A primitive is not considered successful if cancellation raced its
      // final await. This prevents a stale operation from reporting success
      // and allowing its caller to advance to another mutation.
      throwIfAborted(controller.signal);
      return result;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      signal.removeEventListener("abort", forwardAbort);
      if (cancelled || actionError !== null) {
        await cancellationCleanup;
        await Promise.race([
          Promise.resolve(options.onRecovery?.(cancelReason ?? actionError)).catch(() => undefined),
          new Promise<void>((resolve) => setTimeout(resolve, RECOVERY_GRACE_MS)),
        ]);
        if (actionError !== null) {
          // The plugin may still be running after the lease is released. The
          // recovery hook is responsible for stopping primitives/quarantining
          // the session; this log makes that unsafe boundary explicit.
          logger.error({ owner, elapsedMs: this.startedAt === null ? null : Date.now() - this.startedAt, recovery: "bounded" }, "world action recovery completed without awaiting plugin settlement");
        }
      }
      acknowledged.resolve();
      this.release(leased);
      this.cancelled = false;
      this.startedAt = null;
    }
  }

  assertAvailable(): void {
    if (this.owner !== null) throw new Error(`world action still owned by ${this.owner}`);
  }

  private acquire(owner: string, signal: AbortSignal): Promise<WorldActionLease> {
    if (signal.aborted) return Promise.reject(abortError(signal.reason));
    if (this.owner === owner || this.waiters.some((waiter) => waiter.owner === owner)) {
      return Promise.reject(new Error(`world action owner already active or pending: ${owner}`));
    }
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
  // DOMException and some Mineflayer/plugin errors expose a read-only `name`.
  // Clone the message instead of mutating the original cancellation reason.
  const error = reason instanceof Error
    ? new Error(reason.message, { cause: reason })
    : new Error(reason === undefined ? "operation aborted" : String(reason));
  error.name = "AbortError";
  return error;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal.reason);
}

/**
 * Disconnect/process teardown adapter. This is intentionally unleased: it is
 * the authority that runs when a lease context is unavailable. Calls are
 * serialized per bot, every async cleanup is awaited, and registered dynamic
 * ownership is invalidated before plugin stop requests are issued.
 */
export async function stopWorldPrimitives(bot: {
  pathfinder?: { stop?: () => void; setGoal?: (goal: null) => void };
  collectBlock?: { cancelTask?: () => Promise<void> | void };
  pvp?: { stop?: () => void | Promise<void> };
  currentWindow?: unknown;
}): Promise<void> {
  const previous = teardownChains.get(bot) ?? Promise.resolve();
  const cleanup = previous.catch(() => undefined).then(async () => {
    for (const hook of teardownHooks.get(bot) ?? []) {
      try { hook(); } catch { /* invalidation must not block shutdown */ }
    }
    try { bot.pathfinder?.stop?.(); } catch { /* best effort */ }
    try { bot.pathfinder?.setGoal?.(null); } catch { /* best effort */ }
    try { await bot.collectBlock?.cancelTask?.(); } catch { /* best effort */ }
    try { await bot.pvp?.stop?.(); } catch { /* best effort */ }
    try {
      const window = bot.currentWindow as { close?: () => Promise<void> | void } | null | undefined;
      await window?.close?.();
    } catch { /* best effort */ }
  });
  teardownChains.set(bot, cleanup);
  await cleanup;
  if (teardownChains.get(bot) === cleanup) teardownChains.delete(bot);
}
