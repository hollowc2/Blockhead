#!/usr/bin/env node
// Streams the public broadcast page to an RTMP endpoint (YouTube Live) or a file.
//
// The encoder starts first and is fed the "Starting up" holding card at once,
// before Minecraft, the status endpoint or Chromium exist. Headless Chromium
// then renders the loopback broadcast page; a broadcast state machine admits live
// frames only after the bot, viewer and renderer have been healthy for a
// while, and falls back to the holding card when any of them fails. Renderer
// failures never stop the encoder; encoder failures restart only ffmpeg.
// Outbound only: nothing listens.
//
// Env:
//   STREAM_PAGE        page to render (default http://127.0.0.1:3003/broadcast, the
//                      bot's TV-frame page; the interactive viewer at / isn't made for it)
//   STREAM_HEALTH_URL  bot's private status (default http://127.0.0.1:8155/health)
//   STREAM_KEY_FILE    file holding the YouTube stream key (never logged)
//   STREAM_OUTPUT      instead of YouTube, write here (e.g. /tmp/test.mp4) — for tests
//   STREAM_SECONDS     stop after this many seconds (tests); default: run forever
//   STREAM_STATE_DIR   status.json, transitions.jsonl and the operator latch
//                      (default ~/.local/state/cobblebob-stream)
//   STREAM_ASSETS      holding card directory (default ./assets beside this file)
//   STREAM_WIDTH/STREAM_HEIGHT/STREAM_FPS/STREAM_BITRATE_K
//   STREAM_ENCODER     libx264 (default) or h264_nvenc
//   STREAM_CHROMIUM    Chromium executable (default: playwright-core's)
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BroadcastState, STATES, withOfflineScene } from "./broadcast-state.mjs";
import { BotHealthMonitor } from "./bot-health.mjs";
import { Encoder } from "./encoder.mjs";
import { loadHoldingFrames } from "./holding.mjs";
import { FramePublisher } from "./publisher.mjs";
import { Renderer } from "./renderer.mjs";

const env = process.env;
const here = dirname(fileURLToPath(import.meta.url));
const pageUrl = env.STREAM_PAGE ?? "http://127.0.0.1:3003/broadcast";
const healthUrl = env.STREAM_HEALTH_URL ?? "http://127.0.0.1:8155/health";
const width = Number(env.STREAM_WIDTH ?? 1280), height = Number(env.STREAM_HEIGHT ?? 720);
const fps = Number(env.STREAM_FPS ?? 30), bitrate = Number(env.STREAM_BITRATE_K ?? 3000);
const encoderName = env.STREAM_ENCODER ?? "libx264";  // maia's Pascal driver is too old for ffmpeg's NVENC API
const seconds = env.STREAM_SECONDS ? Number(env.STREAM_SECONDS) : 0;
const stateDir = env.STREAM_STATE_DIR ?? join(env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "cobblebob-stream");
const assetsDir = env.STREAM_ASSETS ?? join(here, "assets");
const now = () => performance.now();

const log = (msg, extra = {}) => console.log(JSON.stringify({ time: new Date().toISOString(), msg, ...extra }));

mkdirSync(stateDir, { recursive: true, mode: 0o700 });
const latchFile = join(stateDir, "maintenance");
const reconnectFile = join(stateDir, "reconnect-encoder.request");
const statusFile = join(stateDir, "status.json");
const transitionsFile = join(stateDir, "transitions.jsonl");

function output() {
  if (env.STREAM_OUTPUT) return { args: ["-f", env.STREAM_OUTPUT.endsWith(".flv") ? "flv" : env.STREAM_OUTPUT.endsWith(".ts") ? "mpegts" : "mp4", "-y", env.STREAM_OUTPUT], label: "file", secrets: [] };
  if (!env.STREAM_KEY_FILE) throw new Error("set STREAM_KEY_FILE or STREAM_OUTPUT");
  const key = readFileSync(env.STREAM_KEY_FILE, "utf8").trim();
  if (!/^[\w-]{8,}$/.test(key)) throw new Error("stream key file looks wrong");
  return { args: ["-f", "flv", `rtmp://a.rtmp.youtube.com/live2/${key}`], label: "youtube", secrets: [key] };
}

// 1. Holding frames first: they must exist before anything can fail.
const holding = loadHoldingFrames(assetsDir, { width, height, log });
const out = output();

// 2. Publisher + encoder: output starts on the holding card immediately.
const publisher = new FramePublisher({ fps, now });
const state = new BroadcastState(now());
publisher.select("holding", holding.frames[state.variant]);
const video = encoderName === "libx264"
  ? ["-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency"]
  : ["-c:v", "h264_nvenc", "-preset", "p4", "-tune", "ll", "-rc", "cbr"];
const encoder = new Encoder({
  now, log, secrets: out.secrets,
  onStdin: stdin => stdin ? publisher.attach(stdin) : publisher.detach(),
  args: () => [
    "-hide_banner", "-loglevel", "warning", "-nostats", "-progress", "pipe:3", "-stats_period", "2",
    "-f", "image2pipe", "-framerate", String(fps), "-c:v", "mjpeg", "-i", "-",
    // YouTube rejects streams without audio; send silence.
    "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
    ...video, "-b:v", `${bitrate}k`, "-maxrate", `${bitrate}k`, "-bufsize", `${bitrate * 2}k`,
    // A keyframe at least every 2 s, as YouTube asks; scene cuts may add more.
    "-g", String(fps * 2), "-pix_fmt", "yuv420p", "-vf", `scale=${width}:${height}`,
    "-c:a", "aac", "-b:a", "128k", "-shortest",
    ...out.args,
  ],
});
encoder.start();
const pace = setInterval(() => publisher.tick(), 5);

// 3. Renderer: starts in the background; its failures only change the scene.
const { chromium } = await import("playwright-core");
const renderer = new Renderer({
  chromium, pageUrl, width, height, log, now, executablePath: env.STREAM_CHROMIUM,
  onFrame: (frame, generation) => publisher.offerLive(frame, generation),
  onGeneration: generation => publisher.setGeneration(generation),
});
renderer.start();

// 4. Health and scene selection.
const bot = new BotHealthMonitor();
let maintenance = existsSync(latchFile);
let lastHealth = {};
const outageStartedAt = { at: null };
const totals = { liveMs: 0, holdingMs: 0, outages: 0, lastOutageMs: null };
let lastAccountAt = now();

function rotateIfLarge(file, max = 512 * 1024) {
  try { if (statSync(file).size > max) renameSync(file, `${file}.1`); } catch {}
}

function record(transition) {
  const entry = { time: new Date().toISOString(), from: transition.from, to: transition.to, reason: transition.reason,
    health: Object.fromEntries(Object.entries(lastHealth).map(([k, v]) => [k, v?.ok ? v.reason ?? "ok" : v?.reason ?? "unknown"])) };
  if (transition.to === STATES.LIVE && outageStartedAt.at !== null) { entry.outageMs = Math.round(now() - outageStartedAt.at); totals.lastOutageMs = entry.outageMs; outageStartedAt.at = null; }
  if (transition.from === STATES.LIVE) { outageStartedAt.at = now(); totals.outages++; }
  log("broadcast state", entry);
  try { rotateIfLarge(transitionsFile); appendFileSync(transitionsFile, `${JSON.stringify(entry)}\n`, { mode: 0o600 }); } catch {}
}

function evaluate() {
  const t = now();
  if (publisher.kind === "live") totals.liveMs += t - lastAccountAt; else totals.holdingMs += t - lastAccountAt;
  lastAccountAt = t;
  maintenance = existsSync(latchFile);
  if (existsSync(reconnectFile)) {
    try { rmSync(reconnectFile); } catch {}
    log("operator requested encoder reconnect");
    encoder.restart("operator-reconnect");
  }
  // Bob disconnected but the bot and page fine: the page's offline scene is shown live, not the holding card.
  lastHealth = withOfflineScene({ bot: bot.health(t), viewer: renderer.viewerHealthSignal(), renderer: renderer.health() });
  const transition = state.update(t, { health: lastHealth, hardFailure: renderer.takeHardFailure(), liveFrameAt: publisher.liveFrameAt(), maintenance });
  if (transition) record(transition);
  publisher.select(state.sourceKind, state.variant ? holding.frames[state.variant] : null);

  const encoderHealth = encoder.health(publisher.blockedFor());
  if (encoder.exhausted) { log("encoder keeps failing; exiting for systemd to restart the service"); void shutdown(1); return; }
  if (!encoderHealth.ok && encoder.proc) { log("encoder unhealthy", { reason: encoderHealth.reason }); encoder.restart(encoderHealth.reason); }
}

function writeStatus() {
  const t = now();
  const encoderHealth = encoder.health(publisher.blockedFor());
  const status = {
    time: new Date().toISOString(), pid: process.pid, output: out.label,
    state: state.state, reason: state.reason, sourceKind: publisher.kind, stateAgeSeconds: Math.round((t - state.since) / 1000),
    maintenance, holdingVariant: state.variant, holdingAssetsMissing: holding.missing,
    health: Object.fromEntries(Object.entries(lastHealth).map(([k, v]) => [k, v?.ok ? v.reason ?? "ok" : v?.reason ?? "unknown"])),
    autonomy: bot.autonomy,
    encoder: { health: encoderHealth.ok ? "ok" : encoderHealth.reason, generation: encoder.generation, frame: encoder.progress?.frame ?? null, fps: encoder.progress?.fps ?? null, speed: encoder.progress?.speed ?? null, progressAgeSeconds: encoder.progress ? Math.round((t - encoder.progress.at) / 1000) : null, interruptions: encoder.interruptions, blockedMs: Math.round(publisher.blockedFor()) },
    publisher: { ...publisher.stats, liveFrameAgeSeconds: publisher.liveFrameAt() === null ? null : Math.round((t - publisher.liveFrameAt()) / 1000) },
    renderer: { generation: renderer.generation, opens: renderer.relaunches, frames: renderer.frames, viewerState: typeof renderer.viewerState === "string" ? renderer.viewerState.slice(0, 24) : null },
    totals: { liveSeconds: Math.round(totals.liveMs / 1000), holdingSeconds: Math.round(totals.holdingMs / 1000), outages: totals.outages, lastOutageSeconds: totals.lastOutageMs === null ? null : Math.round(totals.lastOutageMs / 1000) },
    // Only a human (or a separate authorized checker) can verify YouTube playback.
    playback: "unknown",
    memory: { rssMB: Math.round(process.memoryUsage().rss / 1048576) },
  };
  try { writeFileSync(`${statusFile}.tmp`, JSON.stringify(status, null, 1), { mode: 0o600 }); renameSync(`${statusFile}.tmp`, statusFile); } catch {}
}

const timers = [
  pace,
  setInterval(evaluate, 1000),
  setInterval(() => void renderer.check(), 2000),
  setInterval(() => void bot.poll(healthUrl, now), 2000),
  setInterval(writeStatus, 2000),
  setInterval(() => log("stats", { state: state.state, ...publisher.stats, encoderFrame: encoder.progress?.frame ?? null, encoderFps: encoder.progress?.fps ?? null, interruptions: encoder.interruptions, rendererGeneration: renderer.generation }), 60_000),
];
void bot.poll(healthUrl, now);

let stopping = false;
async function shutdown(code) {
  if (stopping) return; stopping = true;
  log("stopping", { code, ...publisher.stats });
  for (const timer of timers) clearInterval(timer);
  writeStatus();
  const force = setTimeout(() => process.exit(code), 15_000); force.unref();
  await renderer.stop().catch(() => {});
  await encoder.stop().catch(() => {});
  process.exit(code);
}
process.on("SIGTERM", () => void shutdown(0));
process.on("SIGINT", () => void shutdown(0));
process.on("exit", () => { try { encoder.proc?.kill("SIGKILL"); } catch {} });
if (seconds > 0) setTimeout(() => void shutdown(0), seconds * 1000);
log("broadcast started", { output: out.label, fps, width, height, holdingAssetsMissing: holding.missing });
