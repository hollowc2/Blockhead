/**
 * Local alerting for the broadcast. An AlertBook turns condition samples into
 * incidents: a condition must hold for `forMs` before one alert is raised, and
 * must stay clear for `clearMs` before one "recovered" note closes it. The
 * book's state is persisted, so an incident that outlives a service restart
 * is not raised again. An AlertSink records every event to an append-only
 * JSONL file and the journal, and optionally hands it to an owner-configured
 * command (rate-limited, time-limited, never awaited by the stream).
 *
 * Alerts carry only fixed summaries, reason codes and counts: never the
 * stream key, the server address, coordinates or any free text.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { appendFileSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const ALERTS_FILE = "alerts.jsonl";
export const ALERT_STATE_FILE = "alerts-state.json";

/** Thresholds per condition. Times are ms of boot-monotonic time. */
export const CONDITIONS = Object.freeze({
  "service-restarting": { forMs: 0, clearMs: 0, summary: "The stream service keeps restarting." },
  "encoder-exhausted": { forMs: 0, clearMs: 300_000, summary: "The encoder used up its restart budget; the service is restarting it." },
  "output-stalled": { forMs: 600_000, clearMs: 120_000, summary: "The encoder has not been sending video for 10 minutes." },
  "not-live": { forMs: 600_000, clearMs: 120_000, summary: "The broadcast has not shown the live world for 10 minutes." },
  "picture-frozen": { forMs: 0, clearMs: 120_000, summary: "The live picture has not changed for a long time." },
  "picture-black": { forMs: 0, clearMs: 120_000, summary: "The live picture is black or blank." },
  "holding-assets-missing": { forMs: 0, clearMs: 0, summary: "A holding card is missing; the plain fallback card is in use." },
});

const CODE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const DETAIL_KEYS = new Set(["restarts", "windowMinutes", "reason", "state", "missing", "unchangedMinutes", "mean", "spread", "region", "generation", "interruptions"]);

/** Keeps only allowlisted keys holding finite numbers, booleans, reason codes or short lists of codes. */
export function cleanDetail(detail) {
  const out = {};
  if (!detail || typeof detail !== "object") return out;
  for (const [key, value] of Object.entries(detail)) {
    if (!DETAIL_KEYS.has(key)) continue;
    if (typeof value === "number" && Number.isFinite(value)) out[key] = Math.round(value * 10) / 10;
    else if (typeof value === "boolean") out[key] = value;
    else if (typeof value === "string" && CODE.test(value)) out[key] = value;
    else if (Array.isArray(value)) { const codes = value.filter(v => typeof v === "string" && CODE.test(v)).slice(0, 8); if (codes.length) out[key] = codes; }
  }
  return out;
}

const fresh = () => ({ open: false, id: null, openedAt: null, openedMono: null, onset: null, clearSince: null, detail: {} });

export class AlertBook {
  /**
   * @param saved   persisted state ({ boot, conditions }) or null
   * @param resume  false drops pending onsets/clear timers (a planned start or a new boot); open incidents stay open
   */
  constructor({ now, boot = "unknown", saved = null, resume = true, conditions = CONDITIONS, wallClock = () => new Date(), onEvent = () => {} }) {
    Object.assign(this, { now, boot, conditions, wallClock, onEvent });
    this.dirty = false;
    this.state = {};
    const sameBoot = saved?.boot === boot;
    for (const name of Object.keys(conditions)) {
      const old = saved?.conditions?.[name];
      const s = fresh();
      if (old && typeof old === "object") {
        s.open = old.open === true; s.id = typeof old.id === "string" ? old.id : null; s.openedAt = typeof old.openedAt === "string" ? old.openedAt : null;
        s.detail = cleanDetail(old.detail);
        if (sameBoot) {
          s.openedMono = Number.isFinite(old.openedMono) ? old.openedMono : null;
          if (resume) { s.onset = Number.isFinite(old.onset) ? old.onset : null; s.clearSince = Number.isFinite(old.clearSince) ? old.clearSince : null; }
        }
      }
      this.state[name] = s;
    }
    if (!sameBoot || !resume) this.dirty = true;
  }

  /** value: true = condition holds, false = clear, null = unknown (changes nothing). */
  update(name, value, detail = {}) {
    const rule = this.conditions[name], s = this.state[name];
    if (!rule || !s || value === null || value === undefined) return null;
    const t = this.now();
    if (value) {
      if (s.clearSince !== null) { s.clearSince = null; this.dirty = true; }
      if (s.open) return null;
      if (s.onset === null) { s.onset = t; this.dirty = true; }
      if (t - s.onset < rule.forMs) return null;
      const at = this.wallClock();
      Object.assign(s, { open: true, id: `${name}-${at.toISOString().replace(/[-:]/g, "").slice(0, 15)}`, openedAt: at.toISOString(), openedMono: t, detail: cleanDetail(detail) });
      this.dirty = true;
      return this.emit({ kind: "alert", condition: name, id: s.id, summary: rule.summary, sinceSeconds: Math.round((t - s.onset) / 1000), detail: s.detail });
    }
    if (s.onset !== null) { s.onset = null; this.dirty = true; }
    if (!s.open) return null;
    if (s.clearSince === null) { s.clearSince = t; this.dirty = true; }
    if (t - s.clearSince < rule.clearMs) return null;
    const event = { kind: "recovered", condition: name, id: s.id, summary: rule.summary, openedAt: s.openedAt };
    if (s.openedMono !== null) event.durationSeconds = Math.round((t - s.openedMono) / 1000);
    Object.assign(s, fresh());
    this.dirty = true;
    return this.emit(event);
  }

  emit(event) { const full = { time: this.wallClock().toISOString(), ...event }; this.onEvent(full); return full; }

  openIncidents() {
    return Object.entries(this.state).filter(([, s]) => s.open).map(([condition, s]) => ({ condition, id: s.id, openedAt: s.openedAt }));
  }

  toJSON() {
    return { boot: this.boot, conditions: Object.fromEntries(Object.entries(this.state).map(([name, s]) => [name, { ...s }])) };
  }
}

export const SINK_DEFAULTS = Object.freeze({
  hookTimeoutMs: 10_000,
  maxHooksPerHour: 6,     // storm guard for the push hook; the JSONL and journal always get every event
  maxQueue: 10,
  maxBytes: 256 * 1024,   // alerts.jsonl rotates to alerts.jsonl.1 past this
});

export class AlertSink {
  constructor({ file, log = () => {}, command = "", now, spawn = nodeSpawn, setTimer = setTimeout, clearTimer = clearTimeout, env = process.env, ...options }) {
    Object.assign(this, { file, log, command: String(command ?? "").trim(), now, spawn, setTimer, clearTimer });
    this.o = { ...SINK_DEFAULTS, ...options };
    // The hook gets the service environment minus anything naming the stream key.
    this.env = Object.fromEntries(Object.entries(env).filter(([k]) => !/KEY|SECRET|TOKEN/i.test(k)));
    this.hooks = []; this.queue = []; this.running = null; this.idle = [];
    this.last = null;
  }

  emit(event) {
    let hook = "off";
    if (this.command) {
      const t = this.now();
      this.hooks = this.hooks.filter(at => t - at < 3600_000);
      if (this.hooks.length >= this.o.maxHooksPerHour) hook = "rate-limited";
      else { this.hooks.push(t); hook = "queued"; }
    }
    const line = { ...event, hook };
    this.last = { time: event.time, kind: event.kind, condition: event.condition };
    try {
      try { if (statSync(this.file).size > this.o.maxBytes) renameSync(this.file, `${this.file}.1`); } catch {}
      appendFileSync(this.file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    } catch (error) { this.log("alert record failed", { error: error?.code ?? error?.name }); }
    this.log("stream alert", line);
    if (hook === "queued") {
      if (this.queue.length >= this.o.maxQueue) this.queue.shift();
      this.queue.push(event);
      this.pump();
    }
  }

  pump() {
    if (this.running || !this.queue.length) { if (!this.running) this.settle(); return; }
    const event = this.queue.shift();
    this.running = new Promise(resolve => {
      let done = false, child = null, timer = null;
      const finish = result => {
        if (done) return; done = true;
        if (timer) this.clearTimer(timer);
        this.log("alert hook finished", { condition: event.condition, kind: event.kind, result });
        resolve();
      };
      try {
        child = this.spawn("/bin/sh", ["-c", this.command], { stdio: ["pipe", "ignore", "ignore"], env: this.env });
        child.on("error", error => finish(`error:${error?.code ?? "spawn"}`));
        child.on("exit", (code, signal) => finish(signal ? `signal:${signal}` : `exit:${code}`));
        child.stdin?.on("error", () => {});
        child.stdin?.end(`${JSON.stringify(event)}\n`);
        timer = this.setTimer(() => { try { child.kill("SIGKILL"); } catch {} finish("timeout"); }, this.o.hookTimeoutMs);
      } catch (error) { finish(`error:${error?.code ?? error?.name ?? "spawn"}`); }
    }).then(() => { this.running = null; this.pump(); });
  }

  settle() { const waiters = this.idle; this.idle = []; for (const resolve of waiters) resolve(); }

  /** Resolves once queued hooks have run, or after ms. */
  drain(ms = 5_000) {
    if (!this.running && !this.queue.length) return Promise.resolve();
    return new Promise(resolve => {
      const timer = this.setTimer(resolve, ms);
      this.idle.push(() => { this.clearTimer(timer); resolve(); });
    });
  }
}

const readLines = file => { try { return readFileSync(file, "utf8").split("\n").filter(Boolean); } catch { return []; } };

/** Last n recorded alert events (including the rotated file), oldest first. */
export function readAlerts(dir, n = 20) {
  return [...readLines(join(dir, `${ALERTS_FILE}.1`)), ...readLines(join(dir, ALERTS_FILE))].slice(-n);
}

/** Open incidents from the persisted book; works while the streamer is stopped. */
export function openAlerts(dir) {
  try {
    const saved = JSON.parse(readFileSync(join(dir, ALERT_STATE_FILE), "utf8"));
    return Object.entries(saved?.conditions ?? {}).filter(([, s]) => s?.open).map(([condition, s]) => ({ condition, openedAt: s.openedAt ?? null }));
  } catch { return []; }
}

export function saveBook(dir, book) {
  const file = join(dir, ALERT_STATE_FILE);
  writeFileSync(`${file}.tmp`, JSON.stringify(book.toJSON()), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
  book.dirty = false;
}

export function loadBook(dir) {
  try { return JSON.parse(readFileSync(join(dir, ALERT_STATE_FILE), "utf8")); } catch { return null; }
}
