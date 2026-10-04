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
  /** A builder replacing a block it placed itself (door/window cut-in). */
  ownBuildReplacement?: boolean;
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
/**
 * How long a cancelled action may keep running before its lease gives up on
 * it. Without this bound a primitive that ignores its signal (a plugin
 * promise on a dead connection) held the lease forever: after a server kick
 * the task's watchdog requested cancellation every 5 s for 10+ minutes and
 * the session never tore down to reconnect (2026-10-04).
 */
export const CANCEL_SETTLE_MS = 10_000;
/** Bound for each awaited plugin stop in `stopWorldPrimitives`. */
export const TEARDOWN_STEP_MS = 2_000;

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
    const abandoned = Promise.withResolvers<never>();
    let abandonTimer: ReturnType<typeof setTimeout> | undefined;
    const cancel = (reason: unknown = new Error("world action cancelled")): void => {
      if (cancelled) return;
      cancelled = true;
      cancelReason = reason;
      controller.abort(reason);
      cancellationCleanup = Promise.resolve(options.onCancel?.()).catch(() => undefined);
      abandonTimer = setTimeout(() => abandoned.reject(abortError(reason)), CANCEL_SETTLE_MS);
    };
    void abandoned.promise.catch(() => undefined);
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
          result = await Promise.race([actionPromise, abandoned.promise]);
        } else {
          const timeoutResult = new Promise<never>((_, reject) => {
            const handle = setTimeout(() => reject(new Error("world action lease timed out")), timeoutMs);
            void actionPromise.then(() => clearTimeout(handle), () => clearTimeout(handle));
          });
          result = await Promise.race([actionPromise, timeoutResult, abandoned.promise]);
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
      if (abandonTimer !== undefined) clearTimeout(abandonTimer);
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
 * Await a Mineflayer promise that has no cancellation of its own (dig,
 * lookAt). Rejects with an AbortError as soon as `signal` aborts, or with a
 * timeout error after `timeoutMs`; `onStop` releases the primitive either
 * way. `bot.dig` settles only on a block update to air, so a dig in flight
 * across a death and respawn never settles; awaiting it bare wedged a food
 * task until systemd SIGKILLed the process (2026-09-27).
 */
export function raceAbort<T>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
  options: { timeoutMs?: number; label?: string; onStop?: () => void } = {},
): Promise<T> {
  // The abandoned promise may still reject later; never let it go unhandled.
  work.catch(() => undefined);
  if (signal === undefined && options.timeoutMs === undefined) return work;
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = (error: Error): void => {
      cleanup();
      try { options.onStop?.(); } catch { /* best effort */ }
      reject(error);
    };
    const onAbort = (): void => stop(abortError(signal?.reason));
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener("abort", onAbort, { once: true });
    if (options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs)) {
      timer = setTimeout(() => stop(new Error(`${options.label ?? "world action"} timed out after ${options.timeoutMs}ms`)), options.timeoutMs);
    }
    work.then(
      (value) => { cleanup(); resolve(value); },
      (error: unknown) => { cleanup(); reject(error); },
    );
  });
}

/** Upper bound for one `bot.dig`: the expected dig time plus slack for lag. */
export function digBudgetMs(bot: { digTime?: (block: never) => number }, block: unknown): number | undefined {
  if (typeof bot.digTime !== "function") return undefined;
  try {
    const expected = bot.digTime(block as never);
    return Number.isFinite(expected) ? expected + 10_000 : undefined;
  } catch {
    return undefined;
  }
}

/** Wait for `work` at most `ms`; errors and late settlement are ignored. */
async function settleWithin(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), ms); });
  try {
    return await Promise.race([work.then(() => true, () => true), expired]);
  } finally {
    clearTimeout(timer);
  }
}

interface CollectBlockLike {
  cancelTask?: () => Promise<void> | void;
}

/**
 * Cancel the collectblock task, bounded. When the plugin cannot finish on its
 * own (no physics ticks after a disconnect), clear its targets and emit the
 * event it waits on, so the next `collect` call does not block forever in its
 * leading `cancelTask()`.
 */
export async function cancelCollectTask(bot: { collectBlock?: CollectBlockLike; emit?: (event: never) => unknown }): Promise<void> {
  const collect = bot.collectBlock;
  if (collect?.cancelTask === undefined) return;
  const settled = await settleWithin(Promise.resolve().then(() => collect.cancelTask?.()), TEARDOWN_STEP_MS);
  if (settled) return;
  logger.warn("collectblock did not finish cancelling; force-clearing its task");
  // `targets` is private in the plugin's typings but is what makes the next
  // collect() think a task is still running.
  try { (collect as { targets?: { clear?: () => void } }).targets?.clear?.(); } catch { /* best effort */ }
  try { (bot.emit as ((event: string) => unknown) | undefined)?.call(bot, "collectBlock_finished"); } catch { /* best effort */ }
}

/**
 * Disconnect/process teardown adapter. This is intentionally unleased: it is
 * the authority that runs when a lease context is unavailable. Calls are
 * serialized per bot, every async cleanup is awaited, and registered dynamic
 * ownership is invalidated before plugin stop requests are issued.
 */
export async function stopWorldPrimitives(bot: {
  pathfinder?: { stop?: () => void; setGoal?: (goal: null) => void };
  collectBlock?: CollectBlockLike;
  emit?: (event: never) => unknown;
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
    // Each plugin stop is bounded: on a dead connection physics never ticks
    // again, so collectblock's cancelTask (which waits for its own
    // "finished" event) and similar never resolve.
    await cancelCollectTask(bot);
    await settleWithin(Promise.resolve().then(() => bot.pvp?.stop?.()), TEARDOWN_STEP_MS);
    await settleWithin(Promise.resolve().then(() => {
      const window = bot.currentWindow as { close?: () => Promise<void> | void } | null | undefined;
      return window?.close?.();
    }), TEARDOWN_STEP_MS);
  });
  teardownChains.set(bot, cleanup);
  await cleanup;
  if (teardownChains.get(bot) === cleanup) teardownChains.delete(bot);
}
