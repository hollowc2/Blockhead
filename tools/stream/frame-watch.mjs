/**
 * Watches the live picture viewers actually get. About once a minute, while
 * the broadcast is live, the current live JPEG is decoded by a short-lived
 * ffmpeg into a 64×36 greyscale thumbnail (2 KB; the stream runtime has no
 * image decoder of its own). From those thumbnails it judges:
 *
 *   frozen  every sample for `frozenMs` matches the first one (≤ 0.2 % of
 *           pixels moved by more than a few grey levels)
 *   black   the whole frame is uniform (any colour) or dark and flat, or the
 *           game area is pure black, for `blackMs`
 *
 * It also keeps one live frame per day (`snapshots/frame-YYYY-MM-DD.jpg`,
 * newest `snapshotKeep` kept) for a person to glance at.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export const FRAME_DEFAULTS = Object.freeze({
  sampleMs: 60_000,
  frozenMs: 15 * 60_000,
  blackMs: 3 * 60_000,
  changeLevel: 6,          // grey levels a thumbnail pixel must move to count as changed
  changedFraction: 0.002,  // more than this share of pixels changed → the picture moved
  width: 64, height: 36,
  // The game view on /broadcast is the top-left 960×540 of 1280×720.
  region: { x: 0, y: 0, w: 0.75, h: 0.75 },
  snapshotKeep: 14,
  snapshotHour: 12,        // the first live sample at or after this local hour is the day's snapshot
  decodeTimeoutMs: 10_000,
});

/** Decodes one JPEG into width×height 8-bit greyscale with ffmpeg. */
export function ffmpegGray(jpeg, { width = 64, height = 36, timeoutMs = 10_000, spawn = nodeSpawn } = {}) {
  return new Promise((resolve, reject) => {
    const size = width * height;
    let child;
    try {
      child = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "image2pipe", "-c:v", "mjpeg", "-i", "pipe:0",
        "-vf", `scale=${width}:${height}:flags=area,format=gray`, "-frames:v", "1", "-f", "rawvideo", "pipe:1"], { stdio: ["pipe", "pipe", "ignore"] });
    } catch (error) { reject(error); return; }
    const chunks = []; let length = 0, settled = false;
    const done = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} done(new Error("decode timeout")); }, timeoutMs);
    child.stdout.on("data", chunk => { if (length <= size) { chunks.push(chunk); length += chunk.length; } });
    child.on("error", error => done(error));
    child.on("close", code => {
      const out = Buffer.concat(chunks);
      if (code === 0 && out.length === size) done(null, out); else done(new Error(`decode failed (${code}, ${out.length} bytes)`));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(jpeg);
  });
}

/** Mean and standard deviation of a greyscale buffer, whole and inside `region` (fractions of the frame). */
export function analyze(gray, width, height, region = FRAME_DEFAULTS.region) {
  const stats = (x0, y0, x1, y1) => {
    let sum = 0, sq = 0, n = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const v = gray[y * width + x]; sum += v; sq += v * v; n++; }
    const mean = n ? sum / n : 0;
    return { mean, std: n ? Math.sqrt(Math.max(0, sq / n - mean * mean)) : 0 };
  };
  const whole = stats(0, 0, width, height);
  const r = stats(Math.floor(region.x * width), Math.floor(region.y * height), Math.ceil((region.x + region.w) * width), Math.ceil((region.y + region.h) * height));
  return { mean: whole.mean, std: whole.std, regionMean: r.mean, regionStd: r.std };
}

/** Uniform frame (any colour), a dark flat frame, or a pure-black game area. */
export function blankReason(s) {
  if (s.std < 3) return "frame-uniform";
  if (s.mean < 20 && s.std < 10) return "frame-dark";
  if (s.regionMean < 8 && s.regionStd < 3) return "game-black";
  return null;
}

/** Share of pixels that moved by more than `level` grey levels. */
export function changedShare(a, b, level = FRAME_DEFAULTS.changeLevel) {
  if (!a || !b || a.length !== b.length) return 1;
  let changed = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > level) changed++;
  return changed / a.length;
}

const localDay = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

export class FrameWatch {
  constructor({ dir, now, log = () => {}, decode, wallClock = () => new Date(), ...options }) {
    this.o = { ...FRAME_DEFAULTS, ...options };
    Object.assign(this, { dir, now, log, wallClock });
    this.decode = decode ?? (jpeg => ffmpegGray(jpeg, { width: this.o.width, height: this.o.height, timeoutMs: this.o.decodeTimeoutMs }));
    this.epoch = 0; this.busy = false; this.lastSampleAt = null;
    this.reference = null; this.unchangedSince = null; this.blankSince = null;
    this.frozen = false; this.black = null;  // black: null or the reason code
    this.last = null; this.samples = 0; this.decodeFailures = 0; this.lastSnapshot = null;
  }

  /** Call often. Not live: forget everything (the holding card is still by design). */
  observe(live, frame) {
    const t = this.now();
    if (!live || !frame) { this.reset(); return; }
    if (this.busy || (this.lastSampleAt !== null && t - this.lastSampleAt < this.o.sampleMs)) return;
    this.lastSampleAt = t; this.busy = true;
    const epoch = this.epoch;
    Promise.resolve().then(() => this.decode(frame)).then(gray => {
      if (epoch === this.epoch) this.sample(this.now(), gray, frame);
    }).catch(error => {
      this.decodeFailures++;
      if (this.decodeFailures === 1 || this.decodeFailures % 60 === 0) this.log("frame check decode failed", { error: error?.code ?? error?.name, failures: this.decodeFailures });
    }).finally(() => { this.busy = false; });
  }

  reset() {
    if (this.reference === null && this.blankSince === null && !this.frozen && !this.black) return;
    this.epoch++;
    this.reference = null; this.unchangedSince = null; this.blankSince = null;
    this.frozen = false; this.black = null;
  }

  sample(t, gray, jpeg) {
    if (!Buffer.isBuffer(gray) || gray.length !== this.o.width * this.o.height) throw new Error("bad thumbnail");
    this.samples++;
    const s = analyze(gray, this.o.width, this.o.height, this.o.region);
    if (this.reference === null || changedShare(this.reference, gray, this.o.changeLevel) > this.o.changedFraction) { this.reference = gray; this.unchangedSince = t; }
    this.frozen = t - this.unchangedSince >= this.o.frozenMs;
    const reason = blankReason(s);
    this.blankSince = reason ? (this.blankSince ?? t) : null;
    this.black = reason && t - this.blankSince >= this.o.blackMs ? reason : null;
    this.last = { at: t, mean: Math.round(s.mean), spread: Math.round(s.std), blank: reason };
    this.snapshot(jpeg);
  }

  snapshot(jpeg) {
    const date = this.wallClock();
    const day = localDay(date);
    if (this.lastSnapshot === day || date.getHours() < this.o.snapshotHour) return;
    const dir = join(this.dir, "snapshots");
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = join(dir, `frame-${day}.jpg`);
      if (!existsSync(file)) writeFileSync(file, jpeg, { mode: 0o600 });
      this.lastSnapshot = day;
      const old = readdirSync(dir).filter(f => /^frame-\d{4}-\d{2}-\d{2}\.jpg$/.test(f)).sort().slice(0, -this.o.snapshotKeep);
      for (const f of old) rmSync(join(dir, f), { force: true });
    } catch (error) { this.log("frame snapshot failed", { error: error?.code ?? error?.name }); this.lastSnapshot = day; }
  }

  status() {
    const t = this.now();
    return {
      samples: this.samples, decodeFailures: this.decodeFailures, frozen: this.frozen, black: this.black,
      unchangedMinutes: this.unchangedSince === null ? null : Math.floor((t - this.unchangedSince) / 60_000),
      last: this.last && { ageSeconds: Math.round((t - this.last.at) / 1000), mean: this.last.mean, spread: this.last.spread, blank: this.last.blank },
      lastSnapshot: this.lastSnapshot,
    };
  }
}
