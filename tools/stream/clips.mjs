/**
 * Clips around the broadcast's event banners, without re-encoding.
 *
 * The encoder's tee muxer writes a rolling window of short MPEG-TS segments
 * (stream copy, ffmpeg's segment_wrap bounds the count) beside the stream
 * output. That slave runs through a dropping fifo with onfail=ignore, so a
 * slow or failing disk loses segments, never the stream. When a banner shows
 * on the live picture, the segments around it are joined (`-c copy`) into an
 * MP4 under the clips directory, which a retention pass keeps under hard
 * count and byte caps. Nothing is uploaded anywhere.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, statfsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { concatQuote } from "./music.mjs";

export const CLIP_DEFAULTS = Object.freeze({
  segmentSeconds: 4,          // a multiple of the 2 s keyframe interval
  wrap: 30,                   // segments kept on disk: ~2 min, ~50 MB at 3 Mbit/s
  fifoPackets: 600,           // ~8 s of packets buffered for a slow disk, then dropped
  preRollMs: 20_000,
  postRollMs: 15_000,
  maxClipMs: 75_000,          // merged moments stop growing a clip here (must stay inside the window)
  settleMs: 3_000,            // after the window ends, wait for its last segment to close
  maxCount: 30,
  maxBytes: 600 * 1024 * 1024,
  perHour: 12,
  minFreeBytes: 2 * 1024 ** 3,
  cutTimeoutMs: 60_000,
});

export const CLIP_KINDS = Object.freeze(["death", "tier", "build", "milestone"]);
const SEGMENT_RE = /^seg\d{3,}\.ts$/;
const CLIP_RE = /^clip-[\w+-]+\.mp4$/;

/** Characters the tee muxer's option syntax would misread in a path. */
export function teeUnsafe(path) {
  return /[\\'|[\]:=\n\r]/.test(String(path));
}

/** The tee slave that writes rolling segments into `dir` (a teeUnsafe-checked path). */
export function segmentSlave({ dir, segmentSeconds = CLIP_DEFAULTS.segmentSeconds, wrap = CLIP_DEFAULTS.wrap, fifoPackets = CLIP_DEFAULTS.fifoPackets }) {
  return `[f=segment:onfail=ignore:use_fifo=1:fifo_options='queue_size=${fifoPackets}\\:drop_pkts_on_overflow=1'`
    + `:segment_format=mpegts:segment_time=${segmentSeconds}:segment_wrap=${wrap}`
    // One fewer list entry than files: the segment being (re)written is never listed.
    + `:segment_list=${dir}/segments.csv:segment_list_type=csv:segment_list_size=${wrap - 1}]${dir}/seg%03d.ts`;
}

/** segment_list csv → [{ name, start, end }] (stream seconds); malformed lines are skipped. */
export function parseSegmentList(text) {
  const out = [];
  for (const line of String(text).split("\n")) {
    const [name, start, end] = line.trim().split(",");
    const s = Number(start), e = Number(end);
    if (SEGMENT_RE.test(name ?? "") && Number.isFinite(s) && Number.isFinite(e) && e > s) out.push({ name, start: s, end: e });
  }
  return out;
}

/** Segments (with wall-clock startAt/endAt) overlapping [from, to], oldest first. */
export function pickSegments(segments, from, to) {
  return segments.filter(s => s.endAt > from && s.startAt < to).sort((a, b) => a.startAt - b.startAt);
}

/** Which clips to delete so that the newest ones fit both caps. `files`: [{ name, bytes, mtimeMs }]. */
export function retentionPlan(files, { maxCount = CLIP_DEFAULTS.maxCount, maxBytes = CLIP_DEFAULTS.maxBytes } = {}) {
  const newest = [...files].sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
  const remove = [];
  let count = 0, bytes = 0;
  for (const file of newest) {
    if (count < maxCount && bytes + file.bytes <= maxBytes) { count++; bytes += file.bytes; } else remove.push(file.name);
  }
  return remove;
}

export function clipName(wallMs, kinds) {
  const stamp = new Date(wallMs).toISOString().replace(/\.\d+Z$/, "Z").replaceAll(":", "-");
  return `clip-${stamp}-${[...kinds].join("+") || "moment"}.mp4`;
}

export class ClipRecorder {
  constructor({ clipsDir, segmentsDir, log = () => {}, spawn = nodeSpawn, wallNow = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, freeBytes = defaultFreeBytes, ...options }) {
    Object.assign(this, { clipsDir, segmentsDir, log, spawn, wallNow, setTimer, clearTimer, freeBytes });
    this.o = { ...CLIP_DEFAULTS, ...options };
    this.current = null;        // this generation's segment directory
    this.pending = [];          // { from, to, kinds: Set, timer }
    this.recent = [];           // wall times of accepted moments (hourly cap)
    this.chain = Promise.resolve();
    this.proc = null; this.stopped = false;
    this.stats = { saved: 0, failed: 0, skipped: 0, lastSavedAt: null, lastResult: null };
  }

  /** Creates the directories and clears leftovers from a previous run. */
  start() {
    mkdirSync(this.clipsDir, { recursive: true, mode: 0o700 });
    mkdirSync(this.segmentsDir, { recursive: true, mode: 0o700 });
    for (const name of safeReaddir(this.clipsDir)) if (name.endsWith(".partial.mp4")) rmSync(join(this.clipsDir, name), { force: true });
    this.retain();
    return this;
  }

  /**
   * The tee slave for one encoder generation, or null to run without one.
   * Each generation writes into its own directory; older ones are removed.
   */
  slave(generation) {
    if (this.stopped) return null;
    const dir = join(this.segmentsDir, `g${generation}`);
    if (teeUnsafe(dir)) { this.log("clip segments disabled: unsafe path for ffmpeg's tee muxer"); return null; }
    try {
      for (const name of safeReaddir(this.segmentsDir)) if (name !== `g${generation}`) rmSync(join(this.segmentsDir, name), { recursive: true, force: true });
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch (error) { this.log("clip segments disabled for this generation", { error: error?.code }); this.current = null; return null; }
    this.current = dir;
    return segmentSlave({ dir, segmentSeconds: this.o.segmentSeconds, wrap: this.o.wrap, fifoPackets: this.o.fifoPackets });
  }

  /** A banner went up on the live picture. */
  event(kind) {
    if (this.stopped || !this.current) return;
    const t = this.wallNow();
    const label = CLIP_KINDS.includes(kind) ? kind : "moment";
    const last = this.pending.at(-1);
    if (last && t + this.o.postRollMs - last.from <= this.o.maxClipMs) {
      last.to = t + this.o.postRollMs; last.kinds.add(label);
      this.schedule(last);
      return;
    }
    this.recent = this.recent.filter(at => t - at < 3600_000);
    if (this.recent.length >= this.o.perHour) { this.stats.skipped++; this.log("clip skipped", { reason: "hourly-cap", kind: label }); return; }
    this.recent.push(t);
    const moment = { from: t - this.o.preRollMs, to: t + this.o.postRollMs, kinds: new Set([label]), timer: null };
    this.pending.push(moment);
    this.schedule(moment);
  }

  schedule(moment) {
    if (moment.timer) this.clearTimer(moment.timer);
    const delay = Math.max(0, moment.to - this.wallNow()) + this.o.segmentSeconds * 1000 + this.o.settleMs;
    moment.timer = this.setTimer(() => {
      moment.timer = null;
      this.pending = this.pending.filter(m => m !== moment);
      this.chain = this.chain.then(() => this.cut(moment)).catch(error => this.log("clip failed", { error: error?.name }));
    }, delay);
  }

  /** The current generation's closed segments with wall-clock times (file mtime ≈ segment end). */
  segments() {
    if (!this.current) return [];
    let text = "";
    try { text = readFileSync(join(this.current, "segments.csv"), "utf8"); } catch { return []; }
    const out = [];
    for (const entry of parseSegmentList(text)) {
      try {
        const st = statSync(join(this.current, entry.name));
        out.push({ ...entry, path: join(this.current, entry.name), endAt: st.mtimeMs, startAt: st.mtimeMs - (entry.end - entry.start) * 1000 });
      } catch {}
    }
    return out;
  }

  async cut(moment) {
    if (this.stopped) return;
    const skip = reason => { this.stats.skipped++; this.stats.lastResult = reason; this.log("clip skipped", { reason, kinds: [...moment.kinds].join("+") }); };
    const free = this.freeBytes(this.clipsDir);
    if (free !== null && free < this.o.minFreeBytes) return skip("low-disk");
    const picked = pickSegments(this.segments(), moment.from, moment.to);
    if (!picked.length) return skip("no-segments");
    const list = join(this.segmentsDir, "clip.ffconcat");
    const name = clipName(moment.from + this.o.preRollMs, moment.kinds);
    const partial = join(this.clipsDir, name.replace(/\.mp4$/, ".partial.mp4"));
    writeFileSync(list, `ffconcat version 1.0\n${picked.map(s => `file ${concatQuote(s.path)}`).join("\n")}\n`, { mode: 0o600 });
    const code = await this.run(["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-f", "concat", "-safe", "0", "-i", list,
      "-map", "0", "-c", "copy", "-bsf:a", "aac_adtstoasc", "-movflags", "+faststart", "-f", "mp4", partial]);
    let bytes = 0;
    try { bytes = statSync(partial).size; } catch {}
    if (code !== 0 || bytes === 0) {
      rmSync(partial, { force: true });
      this.stats.failed++; this.stats.lastResult = "failed";
      this.log("clip failed", { code });
    } else {
      renameSync(partial, join(this.clipsDir, name));
      const seconds = Math.round(picked.at(-1).endAt / 1000 - picked[0].startAt / 1000);
      this.stats.saved++; this.stats.lastSavedAt = new Date(this.wallNow()).toISOString(); this.stats.lastResult = "saved";
      this.log("clip saved", { file: name, seconds, segments: picked.length, megabytes: Math.round(bytes / 1048576) });
    }
    this.retain();
  }

  run(args) {
    return new Promise(resolve => {
      let proc;
      try { proc = this.spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] }); } catch { resolve(null); return; }
      this.proc = proc;
      let err = "";
      proc.stderr?.on("data", chunk => { if (err.length < 2000) err += chunk; });
      const timer = this.setTimer(() => { try { proc.kill("SIGKILL"); } catch {} }, this.o.cutTimeoutMs);
      const done = code => { this.clearTimer(timer); this.proc = null; if (code !== 0 && err) this.log("clip ffmpeg", { line: err.trim().split("\n").at(-1).slice(0, 200) }); resolve(code); };
      proc.on("error", () => done(null));
      proc.on("exit", code => done(code));
    });
  }

  /** Enforces the count and byte caps on saved clips. */
  retain() {
    const files = [];
    for (const name of safeReaddir(this.clipsDir)) {
      if (!CLIP_RE.test(name) || name.endsWith(".partial.mp4")) continue;
      try { const st = statSync(join(this.clipsDir, name)); files.push({ name, bytes: st.size, mtimeMs: st.mtimeMs }); } catch {}
    }
    const remove = retentionPlan(files, this.o);
    for (const name of remove) rmSync(join(this.clipsDir, name), { force: true });
    if (remove.length) this.log("clips pruned", { removed: remove.length });
    const kept = files.filter(f => !remove.includes(f.name));
    this.kept = { count: kept.length, bytes: kept.reduce((sum, f) => sum + f.bytes, 0) };
  }

  status() {
    return { enabled: true, recording: this.current !== null, pending: this.pending.length, clips: this.kept?.count ?? 0, megabytes: Math.round((this.kept?.bytes ?? 0) / 1048576), ...this.stats };
  }

  stop() {
    this.stopped = true;
    for (const moment of this.pending) if (moment.timer) this.clearTimer(moment.timer);
    this.pending = [];
    try { this.proc?.kill("SIGKILL"); } catch {}
  }
}

function safeReaddir(dir) {
  try { return readdirSync(dir); } catch { return []; }
}

function defaultFreeBytes(dir) {
  try { const s = statfsSync(dir); return Number(s.bavail) * Number(s.bsize); } catch { return null; }
}
