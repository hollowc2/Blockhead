import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { dirname, resolve } from "node:path";
import pino from "pino";
import type { Logger } from "pino";

/**
 * Dev logging (spec 32): two streams.
 *
 * - `logs/blockhead.log`: human-readable lines (see the formatter below).
 * - stdout: the previous console stream. An interactive dashboard (Phase 12,
 *   spec 33) owns the terminal, so `setLogEcho(false)` redirects the console
 *   stream into the void; the file stream keeps every line either way.
 *
 * The pino destination is a static multistream whose stdout entry is a
 * switchable target, so the echo can be toggled at runtime without touching
 * the module-level `logger` singleton every module imports.
 */

const LEVEL_LABELS: ReadonlyArray<[number, string]> = [
  [10, "TRACE"],
  [20, "DEBUG"],
  [30, "INFO"],
  [40, "WARN"],
  [50, "ERROR"],
  [60, "FATAL"],
];

/** Keys pino injects; everything else is a structured field (`k=v`). */
const NOISE_KEYS: ReadonlySet<string> = new Set(["time", "level", "msg", "pid", "hostname", "v"]);

function levelLabel(level: number): string {
  for (const [threshold, label] of LEVEL_LABELS) {
    if (level <= threshold) return label;
  }
  return "????";
}

function timestamp(time: number): string {
  const date = new Date(time);
  const pad = (n: number): string => (n < 10 ? "0" : "") + n;
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * Parse one pino JSON line and re-emit the spec 32.1 shape:
 * `14:21:02 TASK  Collect 64 oak logs taskId=task_183`. Long values are
 * truncated so a straggling field never wraps the dashboard feed.
 */
function humanLine(data: string): string {
  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(data);
  } catch {
    return data;
  }
  const fields: string[] = [];
  for (const [key, value] of Object.entries(entry)) {
    if (NOISE_KEYS.has(key)) continue;
    let text = typeof value === "string" ? value : JSON.stringify(value);
    if (text.length > 90) text = `${text.slice(0, 87)}...`;
    fields.push(`${key}=${text}`);
  }
  const tail = fields.length > 0 ? ` ${fields.join(" ")}` : "";
  const message = typeof entry.msg === "string" ? entry.msg : String(entry.msg ?? "");
  return `${timestamp(Number(entry.time) || Date.now())} ${levelLabel(Number(entry.level) || 30).padEnd(5)} ${message}${tail}\n`;
}

/** A destination stream whose target can be swapped at runtime (log echo). */
class SwitchableStream {
  private target: { write(data: string): void; end?(): void } | null;

  constructor(target: { write(data: string): void } | null) {
    this.target = target;
  }

  /** Swap the sink; null silences the stream (TUI owns the terminal). */
  setTarget(target: { write(data: string): void } | null): void {
    this.target = target;
  }

  write(data: string): void {
    if (this.target !== null) this.target.write(data);
  }

  /** Drop the target. Never closes it: stdout belongs to the process. */
  end(): void {
    this.target = null;
  }
}

function openLogFile(path: string): WriteStream {
  const abs = resolve(path);
  mkdirSync(dirname(abs), { recursive: true });
  return createWriteStream(abs, { flags: "a" });
}

/**
 * True under a test runner. Tests import the same module singleton as the
 * agent; a test run must not append to the production log — concurrent test
 * processes interleaved partial records into `logs/blockhead.log` (glued
 * lines, cut mid-word) beside the live agent.
 */
function underTestRunner(): boolean {
  return (
    process.env.BUN_TEST === "1" ||
    process.env.NODE_ENV === "test" ||
    process.env.VITEST === "true" ||
    process.env.JEST_WORKER_ID !== undefined ||
    process.env.NODE_TEST_CONTEXT !== undefined ||
    process.env.NODE_TEST_WORKER_ID !== undefined
  );
}

/** Spec 32.1 human-readable file stream (always on outside tests). */
const fileStream = underTestRunner() ? null : openLogFile("logs/blockhead.log");
const fileSink: { write(data: string): void; end(): void } = {
  write: (data) => {
    if (fileStream !== null) fileStream.write(humanLine(data));
  },
  end: () => {
    if (fileStream !== null) fileStream.end();
  },
};

/** Console echo; null target means "driven by the TUI, write nothing". */
const echoStream = new SwitchableStream(process.stdout);

const destination = pino.multistream([
  { stream: fileSink, level: "info" },
  { stream: echoStream, level: "info" },
]);

export const logger: Logger = pino(
  {
    level: process.env.LOG_LEVEL ?? "info",
  },
  destination,
);

/**
 * Phase 12: the development TUI owns the terminal. `false` silences the
 * stdout echo (the file stream keeps recording); `true` restores it.
 */
export function setLogEcho(enabled: boolean): void {
  echoStream.setTarget(enabled ? process.stdout : null);
}

/** Flush and close every log stream. Call exactly once at process shutdown. */
export function closeLogs(): void {
  destination.flushSync();
  fileSink.end();
  echoStream.end();
}