#!/usr/bin/env node
// Read-only qualification sampler for the private 24-hour soak. Appends one
// JSON line per interval with the broadcast's own status, service restart
// counts, memory, memory pressure, load and process counts. Writes explicit
// start and end records (with the deployed file hashes) so an early stop is
// visible as an incomplete soak. Never reads the stream key or prints private
// /health content: only the streamer's coded status and systemd properties.
//
//   node soak-sample.mjs --hours 24 --interval 60 --out ~/.local/state/cobblebob-stream/soak-<date>.jsonl
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, i, all) => (i % 2 === 0 ? [...pairs, [value.replace(/^--/, ""), all[i + 1]]] : pairs), []));
const hours = Number(args.hours ?? 24), interval = Number(args.interval ?? 60);
const stateDir = process.env.STREAM_STATE_DIR ?? join(homedir(), ".local", "state", "cobblebob-stream");
const out = args.out ?? join(stateDir, `soak-${new Date().toISOString().slice(0, 10)}.jsonl`);
const runtime = join(homedir(), ".local", "share", "cobblebob-stream");
const botRuntime = join(homedir(), ".local", "share", "blockhead-runtime");
const MAX_BYTES = 8 * 1024 * 1024;

const write = record => {
  try { if (statSync(out).size > MAX_BYTES) return; } catch {}
  appendFileSync(out, `${JSON.stringify({ time: new Date().toISOString(), ...record })}\n`, { mode: 0o600 });
};
const sh = (cmd, argv) => { try { return execFileSync(cmd, argv, { encoding: "utf8", timeout: 10_000 }).trim(); } catch { return null; } };
const unit = name => Object.fromEntries((sh("systemctl", ["--user", "show", name, "-p", "ActiveState", "-p", "NRestarts", "-p", "MemoryCurrent", "-p", "MainPID", "-p", "ExecMainStartTimestampMonotonic"]) ?? "").split("\n").filter(Boolean).map(line => line.split("=", 2)));
const hash = file => { try { return createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 16); } catch { return null; } };
const pressure = () => { try { return readFileSync("/proc/pressure/memory", "utf8").trim().split("\n").map(l => l.split(" ").slice(0, 2).join(" ")); } catch { return null; } };
const meminfo = () => { try { const m = Object.fromEntries(readFileSync("/proc/meminfo", "utf8").split("\n").filter(Boolean).map(l => { const [k, v] = l.split(":"); return [k, parseInt(v, 10)]; })); return { availableMB: Math.round(m.MemAvailable / 1024), swapUsedMB: Math.round((m.SwapTotal - m.SwapFree) / 1024) }; } catch { return null; } };
const vmstat = () => { try { const v = Object.fromEntries(readFileSync("/proc/vmstat", "utf8").split("\n").map(l => l.split(" "))); return { pswpin: Number(v.pswpin), pswpout: Number(v.pswpout) }; } catch { return null; } };
const count = pattern => { const r = sh("pgrep", ["-c", "-f", pattern]); return r === null ? 0 : Number(r); };
const gpu = () => sh("nvidia-smi", ["--query-gpu=utilization.gpu,memory.used,memory.total", "--format=csv,noheader,nounits"]);

const hashes = Object.fromEntries([
  ...readdirSync(runtime).filter(f => f.endsWith(".mjs")).map(f => [`stream/${f}`, hash(join(runtime, f))]),
  ...["holding-starting.jpg", "holding-reconnecting.jpg", "holding-break.jpg"].map(f => [`stream/assets/${f}`, hash(join(runtime, "assets", f))]),
  ["bot/src/index.ts", hash(join(botRuntime, "src", "index.ts"))],
]);
write({ kind: "start", hours, interval, botRevision: sh("git", ["-C", botRuntime, "log", "-1", "--format=%h"]), hashes, stream: unit("cobblebob-stream.service"), bot: unit("blockhead.service") });

const end = Date.now() + hours * 3600_000;
let last = null;
const sample = () => {
  let status = null;
  try { status = JSON.parse(readFileSync(join(stateDir, "status.json"), "utf8")); } catch {}
  const s = status && { state: status.state, reason: status.reason, sourceKind: status.sourceKind, health: status.health, autonomy: status.autonomy, encoder: status.encoder, publisher: status.publisher, renderer: status.renderer, totals: status.totals, statusAgeSeconds: Math.round((Date.now() - Date.parse(status.time)) / 1000) };
  const record = { kind: "sample", status: s, stream: unit("cobblebob-stream.service"), bot: unit("blockhead.service"), chromium: count("chrome-headless-shell"), ffmpeg: count("^ffmpeg .*anullsrc"), load: readFileSync("/proc/loadavg", "utf8").split(" ").slice(0, 3).join(" "), memory: meminfo(), pressure: pressure(), swap: vmstat(), gpu: gpu() };
  // Encoded fps over this interval, from ffmpeg's own frame counter.
  if (last && s?.encoder?.frame != null && last.frame != null && s.encoder.generation === last.generation) record.encodedFps = Math.round((s.encoder.frame - last.frame) / ((Date.now() - last.at) / 1000) * 100) / 100;
  last = { frame: s?.encoder?.frame ?? null, generation: s?.encoder?.generation, at: Date.now() };
  write(record);
};
sample();
const timer = setInterval(() => {
  if (Date.now() >= end) { clearInterval(timer); write({ kind: "end", complete: true, stream: unit("cobblebob-stream.service"), bot: unit("blockhead.service") }); return; }
  sample();
}, interval * 1000);
const stop = () => { write({ kind: "end", complete: false, reason: "sampler stopped early" }); process.exit(0); };
process.on("SIGTERM", stop); process.on("SIGINT", stop);
