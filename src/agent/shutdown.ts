/**
 * Process shutdown coordinator. Runs teardown steps in order, bounds every
 * step with its own timeout, and arms a hard exit timer so a skill that
 * ignores its abort signal can never hold the process past systemd's
 * TimeoutStopSec (the 2026-09-27 SIGKILL on maia).
 */

export interface ShutdownStep {
  name: string;
  run: () => void | Promise<void>;
  /** Upper bound for this step; shutdown moves on when it elapses. */
  timeoutMs?: number;
}

export interface ShutdownLogger {
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
}

export interface ShutdownOptions {
  steps: () => readonly ShutdownStep[];
  logger: ShutdownLogger;
  /** Whole-shutdown ceiling; exit(1) fires when it elapses. */
  hardTimeoutMs: number;
  /** Default per-step bound when a step names none. */
  stepTimeoutMs?: number;
  /**
   * A repeated signal this long after the first forces an immediate exit.
   * Shorter gaps are ignored: under systemd, tsx relays SIGTERM to the node
   * child while systemd's control-group kill signals it directly too.
   */
  forceAfterMs?: number;
  exit?: (code: number) => void;
  /** Last-resort diagnostics once the logger may already be closed (journald). */
  stderr?: (line: string) => void;
  now?: () => number;
}

/** Resolve "done" when `work` settles (fulfilled or rejected), "timeout" after `ms`. */
export async function withTimeout(work: Promise<unknown>, ms: number): Promise<"done" | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), ms); });
  try {
    return await Promise.race([work.then(() => "done" as const, () => "done" as const), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export class ShutdownCoordinator {
  private readonly opts: ShutdownOptions;
  private startedAt: number | null = null;
  private hardTimer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;

  constructor(options: ShutdownOptions) {
    this.opts = options;
  }

  get inProgress(): boolean {
    return this.startedAt !== null;
  }

  private get now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private exit(code: number): void {
    if (this.hardTimer !== null) clearTimeout(this.hardTimer);
    this.hardTimer = null;
    (this.opts.exit ?? ((c: number) => process.exit(c)))(code);
  }

  private stderr(line: string): void {
    (this.opts.stderr ?? ((text: string) => { process.stderr.write(`${text}\n`); }))(line);
  }

  /** Signal entry point: the first signal starts shutdown, a late repeat forces exit. */
  handleSignal(signal: string): void {
    if (this.startedAt === null) {
      void this.run(0, signal);
      return;
    }
    const elapsed = this.now - this.startedAt;
    if (elapsed >= (this.opts.forceAfterMs ?? 1000)) {
      this.stderr(`blockhead: second ${signal} during shutdown; exiting immediately`);
      this.exit(1);
    }
  }

  /** Run every step once, then exit with `code`. Idempotent. */
  run(code: number, reason: string): Promise<void> {
    if (this.running !== null) return this.running;
    this.startedAt = this.now;
    this.hardTimer = setTimeout(() => {
      this.stderr(`blockhead: shutdown did not finish within ${this.opts.hardTimeoutMs}ms; forcing exit`);
      this.exit(1);
    }, this.opts.hardTimeoutMs);
    // Nothing else should keep the process alive for this timer's sake.
    this.hardTimer.unref?.();
    this.running = this.runSteps(code, reason);
    return this.running;
  }

  private async runSteps(code: number, reason: string): Promise<void> {
    const { logger } = this.opts;
    logger.info({ reason, hardTimeoutMs: this.opts.hardTimeoutMs }, "shutdown requested");
    const steps = this.opts.steps();
    for (const [index, step] of steps.entries()) {
      const last = index === steps.length - 1;
      const timeoutMs = step.timeoutMs ?? this.opts.stepTimeoutMs ?? 2000;
      const started = this.now;
      let work: Promise<void>;
      try {
        work = Promise.resolve(step.run());
      } catch (err) {
        work = Promise.reject(err);
      }
      const failure: { error?: unknown } = {};
      work = work.catch((err: unknown) => { failure.error = err; });
      const outcome = await withTimeout(work, timeoutMs);
      // The final step closes the log streams; report through stderr only.
      if (outcome === "timeout") {
        if (last) this.stderr(`blockhead: shutdown step "${step.name}" timed out after ${timeoutMs}ms`);
        else logger.warn({ step: step.name, timeoutMs }, "shutdown step timed out; continuing");
      } else if ("error" in failure) {
        if (last) this.stderr(`blockhead: shutdown step "${step.name}" failed: ${String(failure.error)}`);
        else logger.warn({ step: step.name, err: String(failure.error), elapsedMs: this.now - started }, "shutdown step failed; continuing");
      }
    }
    this.exit(code);
  }
}
