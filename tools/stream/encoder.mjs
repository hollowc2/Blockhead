/**
 * Supervises one ffmpeg process. Health is judged from ffmpeg's own progress
 * reports (frames actually encoded), not from writes Node accepted. A dead,
 * stalled or input-blocked encoder is replaced with backoff; every replacement
 * is an output interruption and is recorded as one.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { lineRedactor } from "./redact.mjs";

export const ENCODER_DEFAULTS = Object.freeze({
  startGraceMs: 30_000,   // RTMP connect + first keyframe
  stallMs: 20_000,        // encoded frame count unchanged this long → stalled
  blockedMs: 15_000,      // stdin refusing data this long → blocked
  backoffMs: 2_000,
  maxBackoffMs: 60_000,
  budget: 6,              // restarts allowed per budgetWindowMs before giving up to systemd
  budgetWindowMs: 600_000,
  stableMs: 300_000,      // healthy this long resets the backoff
});

/** Parses ffmpeg -progress key=value blocks. */
export function progressParser(onBlock) {
  let pending = "", block = {};
  return chunk => {
    pending += String(chunk);
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    if (pending.length > 4096) pending = "";
    for (const line of lines) {
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim(), value = line.slice(eq + 1).trim();
      block[key] = value;
      if (key === "progress") { onBlock(block); block = {}; }
    }
  };
}

export class Encoder {
  constructor({ args, secrets = [], log, now, spawn = nodeSpawn, setTimer = setTimeout, clearTimer = clearTimeout, onStdin, ...options }) {
    this.args = args; this.secrets = secrets; this.log = log; this.now = now;
    this.spawn = spawn; this.setTimer = setTimer; this.clearTimer = clearTimer;
    this.onStdin = onStdin;                // (stdin | null) — publisher attach/detach
    this.o = { ...ENCODER_DEFAULTS, ...options };
    this.proc = null; this.generation = 0; this.startedAt = null;
    this.progress = null;                  // { frame, fps, speed, outTimeMs, at }
    this.frameAdvancedAt = null;
    this.restarts = [];                    // monotonic times of restarts (budget)
    this.failures = 0;                     // consecutive, for backoff
    this.timer = null; this.stopped = false; this.exhausted = false;
    this.interruptions = 0; this.lastInterruption = null;
  }

  start() {
    if (this.stopped || this.proc) return;
    const generation = ++this.generation;
    const proc = this.spawn("ffmpeg", this.args(), { stdio: ["pipe", "ignore", "pipe", "pipe"] });
    this.proc = proc; this.startedAt = this.now(); this.progress = null; this.frameAdvancedAt = null;
    const stderr = lineRedactor(line => this.log("ffmpeg", { line }), this.secrets);
    proc.stderr?.on("data", chunk => stderr.push(chunk));
    proc.stderr?.on("end", () => stderr.end());
    proc.stdio[3]?.on("data", progressParser(block => this.onProgress(block, generation)));
    proc.stdin?.on("error", () => {});
    proc.on("error", error => { this.log("ffmpeg spawn failed", { error: error?.code ?? error?.name }); this.onExit(generation, null); });
    proc.on("exit", code => this.onExit(generation, code));
    this.onStdin?.(proc.stdin ?? null);
    this.log("encoder started", { generation });
  }

  onProgress(block, generation) {
    if (generation !== this.generation) return;
    const frame = Number(block.frame);
    if (!Number.isFinite(frame)) return;
    const now = this.now();
    if (this.progress === null || frame > this.progress.frame) this.frameAdvancedAt = now;
    this.progress = { frame, fps: Number(block.fps) || 0, speed: String(block.speed ?? "").slice(0, 12), outTimeMs: Math.round(Number(block.out_time_us ?? block.out_time_ms) / 1000) || 0, at: now };
    if (this.failures && now - this.startedAt > this.o.stableMs) this.failures = 0;
  }

  onExit(generation, code) {
    if (generation !== this.generation || !this.proc) return;
    this.proc = null;
    this.onStdin?.(null);
    if (this.stopped) return;
    this.log("ffmpeg exited", { code });
    this.scheduleRestart("encoder-exited");
  }

  /** @param blockedFor ms the publisher has been waiting for 'drain' */
  health(blockedFor = 0) {
    if (this.exhausted) return { ok: false, reason: "encoder-exhausted" };
    if (!this.proc) return { ok: false, reason: this.timer ? "encoder-restarting" : "encoder-down" };
    const now = this.now();
    if (blockedFor > this.o.blockedMs) return { ok: false, reason: "encoder-input-blocked" };
    const since = this.frameAdvancedAt ?? this.startedAt;
    const limit = this.frameAdvancedAt === null ? this.o.startGraceMs : this.o.stallMs;
    if (now - since > limit) return { ok: false, reason: this.frameAdvancedAt === null ? "encoder-no-progress" : "encoder-stalled" };
    return { ok: true };
  }

  /** Tear down the current process (if any) and start another after backoff. */
  restart(reason) {
    const proc = this.proc;
    if (proc) {
      this.proc = null;
      this.onStdin?.(null);
      try { proc.stdin?.destroy(); } catch {}
      try { proc.kill("SIGKILL"); } catch {}
    }
    this.scheduleRestart(reason);
  }

  scheduleRestart(reason) {
    if (this.stopped || this.timer || this.exhausted) return;
    const now = this.now();
    this.restarts = this.restarts.filter(at => now - at < this.o.budgetWindowMs);
    this.interruptions++;
    this.lastInterruption = { reason, at: now };
    if (this.restarts.length >= this.o.budget) {
      this.exhausted = true;
      this.log("encoder restart budget exhausted", { reason, restarts: this.restarts.length });
      return;
    }
    this.restarts.push(now);
    const delay = Math.min(this.o.maxBackoffMs, this.o.backoffMs * 2 ** this.failures);
    this.failures++;
    this.log("encoder restart scheduled", { reason, delayMs: delay, interruption: this.interruptions });
    this.timer = this.setTimer(() => { this.timer = null; this.start(); }, delay);
  }

  stop() {
    this.stopped = true;
    if (this.timer) { this.clearTimer(this.timer); this.timer = null; }
    const proc = this.proc;
    if (!proc) return Promise.resolve();
    return new Promise(resolve => {
      const kill = this.setTimer(() => { try { proc.kill("SIGKILL"); } catch {} resolve(); }, 3_000);
      proc.once("exit", () => { this.clearTimer(kill); resolve(); });
      try { proc.stdin?.end(); } catch {}
    });
  }
}
