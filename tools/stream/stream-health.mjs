/**
 * Health checks for the broadcast: evaluates the local alert conditions once
 * a second from what stream.mjs already knows, counts service restarts across
 * process lifetimes, and runs the frame watch. Everything here is advisory:
 * `createStreamHealth` never throws, and every call it returns swallows its
 * own errors, so a fault in alerting can't touch the live stream.
 *
 * Durations use CLOCK_MONOTONIC (process.hrtime), which is shared by every
 * process of one boot, so a pending condition and the restart window survive
 * a service restart without trusting the wall clock.
 *
 * Restart counting: lifecycle.jsonl gets a "start" record when the process
 * starts and a "stop" record (with the exit code) when it exits. A start whose
 * previous record isn't a clean stop (code 0) is unplanned: a crash, an OOM
 * kill or the encoder budget giving up (exit 1). An operator's
 * `systemctl --user restart` stops cleanly and isn't counted.
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AlertBook, AlertSink, ALERTS_FILE, loadBook, saveBook } from "./alerts.mjs";
import { FrameWatch } from "./frame-watch.mjs";

export const HEALTH_DEFAULTS = Object.freeze({
  restartThreshold: 3,          // unplanned starts …
  restartWindowMs: 30 * 60_000, // … inside this window → "service-restarting"
  lifecycleKeep: 100,
});

export const LIFECYCLE_FILE = "lifecycle.jsonl";

export const bootMonoMs = () => Number(process.hrtime.bigint() / 1_000_000n);
export function bootId(read = readFileSync) {
  try { return read("/proc/sys/kernel/random/boot_id", "utf8").trim().slice(0, 64) || "unknown"; } catch { return "unknown"; }
}

/** Reads the lifecycle records (bounded), appends this start, and says whether it was planned. */
export function recordStart(dir, { boot, mono, time = new Date(), keep = HEALTH_DEFAULTS.lifecycleKeep } = {}) {
  const file = join(dir, LIFECYCLE_FILE);
  let records = [];
  try { records = readFileSync(file, "utf8").split("\n").filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean); } catch {}
  const previous = records.at(-1);
  const planned = !previous || (previous.event === "stop" && previous.code === 0);
  const start = { event: "start", time: time.toISOString(), boot, mono, unplanned: !planned };
  records.push(start);
  if (records.length > keep) {
    records = records.slice(-keep);
    writeFileSync(`${file}.tmp`, records.map(r => JSON.stringify(r)).join("\n") + "\n", { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  } else appendFileSync(file, `${JSON.stringify(start)}\n`, { mode: 0o600 });
  return { planned, records };
}

export function recordStop(dir, { code, boot, mono, time = new Date() }) {
  appendFileSync(join(dir, LIFECYCLE_FILE), `${JSON.stringify({ event: "stop", time: time.toISOString(), boot, mono, code: Number.isInteger(code) ? code : null })}\n`, { mode: 0o600 });
}

/** Unplanned starts inside the window: monotonic within this boot, wall clock across boots. */
export function unplannedStarts(records, { boot, mono, time = new Date(), windowMs }) {
  return records.filter(r => r.event === "start" && r.unplanned).filter(r => r.boot === boot && Number.isFinite(r.mono)
    ? mono - r.mono <= windowMs
    : time.getTime() - Date.parse(r.time) <= windowMs).length;
}

export class StreamHealth {
  constructor({ dir, log = () => {}, now = bootMonoMs, boot = bootId(), wallClock = () => new Date(), command = "", spawn, frameWatch, decode, ...options }) {
    this.o = { ...HEALTH_DEFAULTS, ...options };
    Object.assign(this, { dir, log, now, boot, wallClock });
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const { planned, records } = recordStart(dir, { boot, mono: now(), time: wallClock(), keep: this.o.lifecycleKeep });
    this.planned = planned;
    this.starts = records.filter(r => r.event === "start" && r.unplanned);
    this.stopped = false;
    this.sink = new AlertSink({ file: join(dir, ALERTS_FILE), log, command, now, ...(spawn ? { spawn } : {}) });
    // After a clean stop, a pending condition's onset is from another run; after a crash, the gap counts.
    this.book = new AlertBook({ now, boot, wallClock, saved: loadBook(dir), resume: !planned, onEvent: event => this.sink.emit(event) });
    this.frames = frameWatch ?? new FrameWatch({ dir, now, log, wallClock, ...(decode ? { decode } : {}) });
    this.persist();
    this.log("health checks started", { plannedStart: planned, restartsInWindow: this.restartsInWindow(), open: this.book.openIncidents().map(i => i.condition), hook: this.sink.command ? "configured" : "off" });
  }

  restartsInWindow() {
    return unplannedStarts(this.starts, { boot: this.boot, mono: this.now(), time: this.wallClock(), windowMs: this.o.restartWindowMs });
  }

  /**
   * @param s.state       broadcast state name
   * @param s.live        the publisher is sending live frames
   * @param s.frame       the current live JPEG (or null)
   * @param s.encoder     { ok, reason }
   * @param s.exhausted   encoder restart budget exhausted
   * @param s.holdingMissing  holding card names that fell back
   */
  observe(s) {
    const b = this.book;
    const restarts = this.restartsInWindow();
    b.update("service-restarting", restarts >= this.o.restartThreshold, { restarts, windowMinutes: this.o.restartWindowMs / 60_000 });
    b.update("encoder-exhausted", s.exhausted ? true : s.encoder?.ok ? false : null, { reason: "encoder-exhausted" });
    b.update("output-stalled", !s.encoder?.ok, { reason: s.encoder?.reason });
    // The operator's maintenance latch is a choice, not an outage.
    b.update("not-live", s.state !== "LIVE" && s.state !== "MAINTENANCE", { state: String(s.state ?? "").toLowerCase() });
    b.update("holding-assets-missing", (s.holdingMissing?.length ?? 0) > 0, { missing: s.holdingMissing ?? [] });
    const live = s.state === "LIVE" && s.live;
    this.frames.observe(live, s.frame ?? null);
    const fs = this.frames.status();
    b.update("picture-frozen", live && this.frames.frozen, { unchangedMinutes: fs.unchangedMinutes });
    b.update("picture-black", live && !!this.frames.black, { reason: this.frames.black ?? undefined, mean: fs.last?.mean, spread: fs.last?.spread });
    if (b.dirty) this.persist();
  }

  persist() {
    try { saveBook(this.dir, this.book); } catch (error) { this.book.dirty = false; this.log("alert state save failed", { error: error?.code ?? error?.name }); }
  }

  status() {
    return {
      open: this.book.openIncidents(), last: this.sink.last, restartsInWindow: this.restartsInWindow(),
      hook: this.sink.command ? "configured" : "off", frames: this.frames.status(),
    };
  }

  stop(code) {
    if (this.stopped) return; this.stopped = true;
    recordStop(this.dir, { code, boot: this.boot, mono: this.now(), time: this.wallClock() });
  }

  drain(ms) { return this.sink.drain(ms); }
}

/** For stream.mjs: a StreamHealth whose every call is guarded, or a no-op if it can't start. */
export function createStreamHealth({ stateDir, log, env = process.env, onExit = handler => process.once("exit", handler), ...rest }) {
  let health = null;
  try {
    health = new StreamHealth({ dir: stateDir, log, command: env.STREAM_ALERT_COMMAND ?? "", ...rest });
    onExit(code => { try { health.stop(code); } catch {} });
  } catch (error) { log("health checks unavailable", { error: error?.code ?? error?.name }); }
  let failures = 0;
  const guard = (fn, fallback) => (...args) => {
    if (!health) return fallback;
    try { return fn(...args); } catch (error) {
      if (failures++ % 300 === 0) log("health check error", { error: error?.name, failures });
      return fallback;
    }
  };
  return {
    observe: guard(s => health.observe(s)),
    status: guard(() => health.status(), null),
    drain: guard(ms => health.drain(ms).catch(() => {}), Promise.resolve()),
  };
}
