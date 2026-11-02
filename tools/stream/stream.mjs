#!/usr/bin/env node
// Streams the public viewer page to an RTMP endpoint (YouTube Live) or a file.
// Headless Chromium renders the loopback page; CDP screencast frames are paced
// to a constant frame rate and encoded by ffmpeg. Outbound only: nothing listens.
//
// Env:
//   STREAM_PAGE      page to render (default http://127.0.0.1:3003/)
//   STREAM_KEY_FILE  file holding the YouTube stream key (never logged)
//   STREAM_OUTPUT    instead of YouTube, write here (e.g. /tmp/test.mp4) — for tests
//   STREAM_SECONDS   stop after this many seconds (tests); default: run forever
//   STREAM_WIDTH/STREAM_HEIGHT/STREAM_FPS/STREAM_BITRATE_K
//   STREAM_ENCODER   libx264 (default) or h264_nvenc
//   STREAM_CHROMIUM  Chromium executable (default: playwright-core's)
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { chromium } from "playwright-core";

const env = process.env;
const page_url = env.STREAM_PAGE ?? "http://127.0.0.1:3003/";
const width = Number(env.STREAM_WIDTH ?? 1280), height = Number(env.STREAM_HEIGHT ?? 720);
const fps = Number(env.STREAM_FPS ?? 30), bitrate = Number(env.STREAM_BITRATE_K ?? 3000);
const encoder = env.STREAM_ENCODER ?? "libx264";  // maia's Pascal driver is too old for ffmpeg's NVENC API
const seconds = env.STREAM_SECONDS ? Number(env.STREAM_SECONDS) : 0;
const RELOAD_MS = 6 * 3600_000;    // fresh page every 6 h bounds browser memory growth
const STALE_MS = 5_000;            // no screencast frame this long → take a screenshot
const DEAD_MS = 60_000;            // no frame at all this long → exit; systemd restarts us

const log = (msg, extra = {}) => console.log(JSON.stringify({ time: new Date().toISOString(), msg, ...extra }));

function output() {
  if (env.STREAM_OUTPUT) return { args: ["-f", env.STREAM_OUTPUT.endsWith(".flv") ? "flv" : "mp4", "-y", env.STREAM_OUTPUT], label: env.STREAM_OUTPUT };
  if (!env.STREAM_KEY_FILE) throw new Error("set STREAM_KEY_FILE or STREAM_OUTPUT");
  const key = readFileSync(env.STREAM_KEY_FILE, "utf8").trim();
  if (!/^[\w-]{8,}$/.test(key)) throw new Error("stream key file looks wrong");
  return { args: ["-f", "flv", `rtmp://a.rtmp.youtube.com/live2/${key}`], label: "youtube" };
}

const out = output();
const video = encoder === "libx264"
  ? ["-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency"]
  : ["-c:v", "h264_nvenc", "-preset", "p4", "-tune", "ll", "-rc", "cbr"];
const ffmpeg = spawn("ffmpeg", [
  "-hide_banner", "-loglevel", "warning",
  "-f", "image2pipe", "-framerate", String(fps), "-c:v", "mjpeg", "-i", "-",
  // YouTube rejects streams without audio; send silence.
  "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
  ...video, "-b:v", `${bitrate}k`, "-maxrate", `${bitrate}k`, "-bufsize", `${bitrate * 2}k`,
  "-g", String(fps * 2), "-pix_fmt", "yuv420p", "-vf", `scale=${width}:${height}`,
  "-c:a", "aac", "-b:a", "128k", "-shortest",
  ...out.args,
], { stdio: ["pipe", "inherit", "pipe"] });
// ffmpeg's own messages can echo the RTMP URL (and so the key): drop those lines.
ffmpeg.stderr.on("data", chunk => { for (const line of String(chunk).split("\n")) if (line && !line.includes("rtmp://")) log("ffmpeg", { line }); });
ffmpeg.on("exit", code => { log("ffmpeg exited", { code }); shutdown(1); });
ffmpeg.stdin.on("error", () => {});

const browser = await chromium.launch({
  executablePath: env.STREAM_CHROMIUM || undefined,
  args: ["--ignore-gpu-blocklist", "--enable-gpu", "--use-angle=vulkan", "--enable-features=Vulkan", "--mute-audio", "--autoplay-policy=no-user-gesture-required"],
});
// bypassCSP lets us inject the broadcast stylesheet; this browser only ever loads the loopback page.
const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, bypassCSP: true });
await context.addInitScript(() => { try { localStorage.setItem("cobblebob.help", "dismissed"); } catch {} });
const page = await context.newPage();
const cdp = await context.newCDPSession(page);

let latest = null, latestAt = Date.now(), frames = 0, written = 0, stopping = false;
cdp.on("Page.screencastFrame", ({ data, sessionId }) => {
  latest = Buffer.from(data, "base64"); latestAt = Date.now(); frames++;
  cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
});

async function open() {
  await page.goto(page_url, { waitUntil: "load", timeout: 30_000 });
  // Broadcast viewers can't click: hide the question box, gestures and view toggles.
  await page.addStyleTag({ content: ".viewer-choices, article:has(#publicQuestionForm) { display: none !important; }" });
  // The 3D world renders inside the shell's iframe.
  const viewer = page.frameLocator(".stage iframe").locator("canvas").first();
  await viewer.waitFor({ state: "visible", timeout: 60_000 });
  await page.waitForTimeout(3000);
  await page.keyboard.press("t");  // follow behind CobbleBob
  const frame = page.frames().find(f => f !== page.mainFrame()) ?? page.mainFrame();
  const gl = await frame.evaluate(() => {
    const c = document.createElement("canvas").getContext("webgl");
    const ext = c?.getExtension("WEBGL_debug_renderer_info");
    return ext ? c.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "unknown";
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 85, maxWidth: width, maxHeight: height, everyNthFrame: 2 });  // the page paints at ~60 Hz; the stream needs 30
  log("page open", { renderer: gl, output: out.label });
}

async function shutdown(code) {
  if (stopping) return; stopping = true;
  log("stopping", { code, frames, written });
  ffmpeg.stdin.end();
  await browser.close().catch(() => {});
  setTimeout(() => process.exit(code), 3000).unref();
  ffmpeg.once("exit", () => process.exit(code));
}
process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));
process.on("exit", () => { try { ffmpeg.kill("SIGKILL"); } catch {} });

try { await open(); } catch (error) { log("page open failed", { error: error?.name, detail: String(error?.message ?? "").slice(0, 200) }); await shutdown(1); }
let lastReload = Date.now(), refreshing = false;
const pace = setInterval(() => { if (latest && !stopping) { ffmpeg.stdin.write(latest); written++; } }, 1000 / fps);
const watch = setInterval(async () => {
  if (stopping || refreshing) return;
  const idle = Date.now() - latestAt;
  if (idle > DEAD_MS) { log("no frames", { idle }); return shutdown(1); }
  refreshing = true;
  try {
    if (Date.now() - lastReload > RELOAD_MS) { lastReload = Date.now(); await cdp.send("Page.stopScreencast"); await open(); }
    // A still scene yields no screencast frames; a screenshot proves the page is alive.
    else if (idle > STALE_MS) { latest = await page.screenshot({ type: "jpeg", quality: 85, timeout: 10_000 }); latestAt = Date.now(); }
  } catch (error) { log("page check failed", { error: error?.name }); }
  refreshing = false;
}, 2000);
setInterval(() => log("stats", { frames, written }), 60_000).unref();
if (seconds > 0) setTimeout(() => { clearInterval(pace); clearInterval(watch); shutdown(0); }, seconds * 1000);
