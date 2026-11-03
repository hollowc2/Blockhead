/**
 * Background music for the stream's audio track. Tracks are files the owner
 * puts in a local directory; nothing is downloaded. Each track is checked
 * with ffprobe before it is used, and every encoder generation gets a freshly
 * shuffled concat playlist, repeated to cover days. Without usable tracks the
 * encoder keeps its silent track.
 *
 * A bad file must never take the stream down: unreadable files are skipped at
 * probe time, a track that fails mid-playlist ends the music for that
 * generation (the silent track it is mixed onto carries on), and if an encoder generation with
 * music fails early the next generations run silent for a cool-off, so music
 * can use at most one restart from the encoder's budget per cool-off.
 */
import { execFile } from "node:child_process";
import { readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";

export const MUSIC_DEFAULTS = Object.freeze({
  volume: 0.15,              // linear gain on each track; quiet under the picture
  minTrackSeconds: 5,
  maxTrackBytes: 200 * 1024 * 1024,
  maxTracks: 500,
  playlistHours: 168,        // one encoder generation can run for days
  maxEntries: 20_000,
  probeTimeoutMs: 10_000,
  probeConcurrency: 2,
  healthyRunMs: 60_000,      // a music generation that ends sooner counts as a music failure
  cooloffMs: 30 * 60_000,    // silent this long after one; doubles per repeat
  maxCooloffMs: 6 * 3600_000,
});

export const AUDIO_EXTENSIONS = Object.freeze([".mp3", ".ogg", ".oga", ".opus", ".flac", ".m4a", ".aac", ".wav"]);

/**
 * ffprobe JSON → { codec, sampleRate, channels, seconds, layout } for the first
 * audio stream, or null. `layout` is the stream lineup (e.g. "a" or "a,v" for
 * an MP3 with cover art): the concat demuxer matches streams by position.
 */
export function parseProbe(json) {
  let data;
  try { data = typeof json === "string" ? JSON.parse(json) : json; } catch { return null; }
  const streams = Array.isArray(data?.streams) ? data.streams : [];
  const stream = streams.find(s => s?.codec_type === "audio");
  if (!stream || typeof stream.codec_name !== "string") return null;
  const sampleRate = Number(stream.sample_rate), channels = Number(stream.channels);
  const seconds = Number(data?.format?.duration ?? stream.duration);
  if (!(sampleRate > 0) || !(channels > 0) || !Number.isFinite(seconds)) return null;
  const layout = streams.map(s => String(s?.codec_type ?? "?").charAt(0)).join(",");
  return { codec: stream.codec_name, sampleRate, channels, seconds, layout };
}

/**
 * The concat demuxer feeds one decoder per stream position, so every track
 * must share codec, sample rate, channel count and stream lineup. Keeps the
 * largest such group (ties: the group holding the alphabetically first file).
 */
export function compatibleTracks(tracks) {
  const groups = new Map();
  for (const track of [...tracks].sort((a, b) => a.path.localeCompare(b.path))) {
    const key = `${track.codec}/${track.sampleRate}/${track.channels}/${track.layout ?? "a"}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(track);
  }
  let best = [];
  for (const group of groups.values()) if (group.length > best.length) best = group;
  return best;
}

/** Quotes a path for an ffconcat `file` line. */
export function concatQuote(path) {
  return `'${String(path).replaceAll("'", "'\\''")}'`;
}

/** An ffconcat playlist: shuffled rounds of the tracks until `hours` are covered. */
export function playlistText(tracks, { hours = MUSIC_DEFAULTS.playlistHours, maxEntries = MUSIC_DEFAULTS.maxEntries, random = Math.random } = {}) {
  const lines = ["ffconcat version 1.0"];
  const round = Math.max(1, tracks.reduce((sum, t) => sum + t.seconds, 0));
  const rounds = Math.max(1, Math.ceil((hours * 3600) / round));
  for (let r = 0; r < rounds && lines.length <= maxEntries; r++) {
    const order = [...tracks];
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    for (const track of order) { if (lines.length > maxEntries) break; lines.push(`file ${concatQuote(track.path)}`); }
  }
  return `${lines.join("\n")}\n`;
}

/** Runs ffprobe on one file; resolves its parsed summary or null. Never rejects. */
export function ffprobe(path, { timeoutMs = MUSIC_DEFAULTS.probeTimeoutMs } = {}) {
  return new Promise(resolve => {
    try {
      execFile("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,sample_rate,channels,duration:format=duration", "-of", "json", path],
        { timeout: timeoutMs, maxBuffer: 256 * 1024, killSignal: "SIGKILL" },
        (error, stdout) => resolve(error ? null : parseProbe(stdout)));
    } catch { resolve(null); }
  });
}

export class MusicLibrary {
  constructor({ dir, playlistFile, enabled = true, log = () => {}, now = () => performance.now(), probe = ffprobe, random = Math.random, ...options }) {
    Object.assign(this, { dir, playlistFile, enabled, log, now, probe, random });
    this.o = { ...MUSIC_DEFAULTS, ...options };
    this.o.volume = Number.isFinite(this.o.volume) ? Math.min(1, Math.max(0, this.o.volume)) : MUSIC_DEFAULTS.volume;
    this.cache = new Map();          // path → { size, mtimeMs, track | null }
    this.tracks = [];                // the usable, mutually compatible set
    this.found = 0; this.rejected = 0; this.incompatible = 0;
    this.usedBy = null;              // encoder generation that got music
    this.silentUntil = null; this.trips = 0;
    this.refreshing = null;
  }

  /** Rescans the directory; probes only new or changed files. Never throws. */
  refresh() {
    if (!this.enabled) return Promise.resolve();
    this.refreshing ??= this.scan().catch(error => this.log("music scan failed", { error: error?.code ?? error?.name })).finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  async scan() {
    let names = [];
    try { names = readdirSync(this.dir); }
    catch (error) { if (error?.code !== "ENOENT") this.log("music directory unreadable", { error: error?.code }); this.publish([], 0); return; }
    const files = [];
    for (const name of names.sort()) {
      if (!AUDIO_EXTENSIONS.includes(extname(name).toLowerCase()) || /[\n\r]/.test(name) || name.startsWith(".")) continue;
      const path = join(this.dir, name);
      try {
        const st = statSync(path);
        if (st.isFile() && st.size > 0 && st.size <= this.o.maxTrackBytes) files.push({ path, size: st.size, mtimeMs: st.mtimeMs });
      } catch {}
      if (files.length >= this.o.maxTracks) break;
    }
    const todo = files.filter(f => { const c = this.cache.get(f.path); return !c || c.size !== f.size || c.mtimeMs !== f.mtimeMs; });
    for (let i = 0; i < todo.length; i += this.o.probeConcurrency) {
      await Promise.all(todo.slice(i, i + this.o.probeConcurrency).map(async f => {
        const info = await this.probe(f.path, { timeoutMs: this.o.probeTimeoutMs });
        const track = info && info.seconds >= this.o.minTrackSeconds ? { path: f.path, ...info } : null;
        this.cache.set(f.path, { size: f.size, mtimeMs: f.mtimeMs, track });
      }));
    }
    const keep = new Set(files.map(f => f.path));
    for (const path of this.cache.keys()) if (!keep.has(path)) this.cache.delete(path);
    this.publish(files.map(f => this.cache.get(f.path)?.track).filter(Boolean), files.length);
  }

  publish(usable, found) {
    const tracks = compatibleTracks(usable);
    const changed = tracks.length !== this.tracks.length || tracks.some((t, i) => t.path !== this.tracks[i]?.path);
    this.tracks = tracks; this.found = found;
    this.rejected = found - usable.length; this.incompatible = usable.length - tracks.length;
    if (changed) this.log("music library", { tracks: tracks.length, rejected: this.rejected, incompatible: this.incompatible, format: tracks[0] ? `${tracks[0].codec}/${tracks[0].sampleRate}/${tracks[0].channels}` : null });
  }

  /**
   * Music for one encoder generation ({ list, volume }), or null for silence.
   * `run` is what Encoder passes to args(): { generation, previous }.
   */
  forRun({ generation, previous } = {}) {
    const now = this.now();
    if (previous && this.usedBy !== null && previous.generation === this.usedBy && (!previous.progressed || previous.ranMs < this.o.healthyRunMs)) {
      const cooloff = Math.min(this.o.maxCooloffMs, this.o.cooloffMs * 2 ** this.trips);
      this.trips++; this.silentUntil = now + cooloff;
      this.log("music paused after an early encoder failure", { cooloffMinutes: Math.round(cooloff / 60_000) });
    } else if (previous && this.usedBy !== null && previous.generation === this.usedBy) this.trips = 0;
    this.usedBy = null;
    if (!this.enabled || !this.tracks.length) return null;
    if (this.silentUntil !== null && now < this.silentUntil) return null;
    // Files can vanish between scans; a missing first file would stop ffmpeg from opening the playlist.
    const present = this.tracks.filter(t => { try { return statSync(t.path).isFile(); } catch { return false; } });
    if (!present.length) return null;
    try {
      writeFileSync(`${this.playlistFile}.tmp`, playlistText(present, { hours: this.o.playlistHours, maxEntries: this.o.maxEntries, random: this.random }), { mode: 0o600 });
      renameSync(`${this.playlistFile}.tmp`, this.playlistFile);
    } catch (error) { this.log("music playlist not written", { error: error?.code }); return null; }
    this.usedBy = generation ?? null;
    return { list: this.playlistFile, volume: this.o.volume };
  }

  status() {
    const now = this.now();
    return {
      enabled: this.enabled, tracks: this.tracks.length, rejected: this.rejected, incompatible: this.incompatible,
      playing: this.usedBy !== null, pausedMinutes: this.silentUntil !== null && now < this.silentUntil ? Math.ceil((this.silentUntil - now) / 60_000) : 0,
    };
  }
}
