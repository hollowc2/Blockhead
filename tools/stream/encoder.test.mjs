import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { Encoder, encoderArgs, progressParser, teeEscape } from "./encoder.mjs";

class FakeProc extends EventEmitter {
  constructor() {
    super();
    this.stdin = new PassThrough(); this.stderr = new PassThrough(); this.progress = new PassThrough();
    this.stdio = [this.stdin, null, this.stderr, this.progress];
    this.killed = null;
  }
  kill(signal) { this.killed = signal; queueMicrotask(() => this.emit("exit", null, signal)); }
  report(frame) { this.progress.write(`frame=${frame}\nfps=30.0\nout_time_us=${frame * 33333}\nspeed=1.0x\nprogress=continue\n`); }
}

function harness(options = {}) {
  let t = 0;
  const now = () => t;
  const procs = [], timers = [], logs = [];
  const enc = new Encoder({
    args: () => ["-i", "-"], now, log: (msg, extra) => logs.push({ msg, ...extra }), secrets: ["abcd-efgh-ijkl-mnop-qrst"],
    spawn: () => { const p = new FakeProc(); procs.push(p); return p; },
    setTimer: (fn, ms) => { const timer = { fn, at: t + ms }; timers.push(timer); return timer; },
    clearTimer: timer => { const i = timers.indexOf(timer); if (i >= 0) timers.splice(i, 1); },
    onStdin: () => {}, ...options,
  });
  const advance = ms => { t += ms; for (const timer of [...timers]) if (timer.at <= t) { timers.splice(timers.indexOf(timer), 1); timer.fn(); } };
  return { enc, procs, logs, advance, timers, now };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

test("progress parser assembles split key=value blocks", () => {
  const blocks = [];
  const feed = progressParser(b => blocks.push(b));
  feed("frame=1"); feed("0\nfps=29.9\nprogr"); feed("ess=continue\nframe=20\nprogress=continue\n");
  assert.deepEqual(blocks.map(b => b.frame), ["10", "20"]);
});

test("health follows encoded frames, not writes", async () => {
  const { enc, procs, advance } = harness();
  enc.start();
  assert.equal(enc.health().ok, true, "inside the start grace");
  advance(31_000);
  assert.equal(enc.health().reason, "encoder-no-progress");
  procs[0].report(10); await flush();
  assert.equal(enc.health().ok, true);
  advance(10_000); procs[0].report(10); await flush();
  advance(11_000);
  assert.equal(enc.health().reason, "encoder-stalled", "a repeated frame count is not progress");
  procs[0].report(500); await flush();
  assert.equal(enc.health().ok, true);
  assert.equal(enc.health(16_000).reason, "encoder-input-blocked");
});

test("an exited encoder restarts with backoff and counts an interruption", async () => {
  const { enc, procs, advance } = harness();
  enc.start();
  procs[0].emit("exit", 1);
  assert.equal(enc.proc, null);
  assert.equal(enc.interruptions, 1);
  assert.equal(enc.health().reason, "encoder-restarting");
  advance(1_999); assert.equal(procs.length, 1);
  advance(1); assert.equal(procs.length, 2);
  procs[1].emit("exit", 1);
  advance(3_999); assert.equal(procs.length, 2, "second retry waits longer");
  advance(1); assert.equal(procs.length, 3);
});

test("events from a replaced ffmpeg are ignored", async () => {
  const { enc, procs, advance } = harness();
  enc.start();
  enc.restart("encoder-stalled");
  advance(2_000);
  assert.equal(procs.length, 2);
  procs[0].report(999); await flush();
  assert.equal(enc.progress, null);
  procs[0].emit("exit", 0);
  assert.ok(enc.proc === procs[1], "old exit does not tear down the new process");
});

test("the restart budget is bounded; exhaustion is reported, not looped", () => {
  const { enc, procs, advance } = harness({ budget: 3 });
  enc.start();
  for (let i = 0; i < 3; i++) { procs.at(-1).emit("exit", 1); advance(120_000); }
  procs.at(-1).emit("exit", 1);
  advance(600_000);
  assert.equal(enc.exhausted, true);
  assert.equal(procs.length, 4);
  assert.equal(enc.health().reason, "encoder-exhausted");
});

test("ffmpeg stderr is redacted before logging", async () => {
  const { enc, procs, logs } = harness();
  enc.start();
  procs[0].stderr.write("rtmp://a.rtmp.youtube.com/live2/abcd-efgh-");
  procs[0].stderr.write("ijkl-mnop-qrst: I/O error\n");
  await flush();
  const line = logs.find(l => l.msg === "ffmpeg")?.line ?? "";
  assert.ok(line.includes("I/O error"));
  assert.ok(!line.includes("ijkl") && !line.includes("youtube"), line);
});

const base = { fps: 30, width: 1280, height: 720, bitrateK: 3000, video: ["-c:v", "libx264"], output: { format: "flv", target: "rtmp://a.rtmp.youtube.com/live2/abcd-efgh-ijkl-mnop-qrst" } };

test("without music or clips the encode is the plain silent-AAC stream with the progress pipe", () => {
  const args = encoderArgs(base);
  assert.deepEqual(args.slice(0, 8), ["-hide_banner", "-loglevel", "warning", "-nostats", "-progress", "pipe:3", "-stats_period", "2"]);
  assert.ok(args.join(" ").includes("-f image2pipe -framerate 30 -c:v mjpeg -i - -f lavfi -i anullsrc=r=44100:cl=stereo -map 0:v -map 1:a"));
  assert.deepEqual(args.slice(-3), ["-f", "flv", base.output.target]);
  assert.ok(!args.includes("tee") && !args.includes("-filter_complex") && !args.includes("-y"));
  assert.ok(args.includes("-shortest"));
});

test("music is mixed quietly onto the silent track, which outlives it", () => {
  const args = encoderArgs({ ...base, music: { list: "/state/music.ffconcat", volume: 0.15 } });
  const s = args.join(" ");
  assert.ok(s.includes("-f lavfi -i anullsrc=r=44100:cl=stereo -f concat -safe 0 -i /state/music.ffconcat"));
  assert.ok(!args.includes("-stream_loop"), "ffmpeg can't loop a concat input; the playlist repeats instead");
  const graph = args[args.indexOf("-filter_complex") + 1];
  assert.match(graph, /^\[2:a\]volume=0\.300,/, "amix halves each input");
  assert.ok(graph.endsWith("[1:a][music]amix=inputs=2:duration=first:dropout_transition=0[aout]"), "the silent input sets the length");
  assert.ok(!graph.includes("apad"));
  assert.ok(s.includes("-map 0:v -map [aout]"));
});

test("clips add a tee with the stream as the aborting main slave and global headers", () => {
  const args = encoderArgs({ ...base, segments: "[f=segment:onfail=ignore]/s/seg%03d.ts" });
  assert.deepEqual(args.slice(-7), ["-flags:v", "+global_header", "-flags:a", "+global_header", "-f", "tee", `[f=flv]${base.output.target}|[f=segment:onfail=ignore]/s/seg%03d.ts`]);
  assert.ok(args.includes("pipe:3"), "health still reads -progress");
  const file = encoderArgs({ ...base, output: { format: "mpegts", target: "/tmp/a|b.ts", overwrite: true }, segments: "[f=segment]/s/x.ts" });
  assert.equal(file.at(-1), "[f=mpegts]/tmp/a\\|b.ts|[f=segment]/s/x.ts");
  assert.ok(file.includes("-y"));
  assert.equal(teeEscape("a'b[c]\\"), "a\\'b\\[c\\]\\\\");
});

test("args() learns how the previous generation went", async () => {
  const seen = [];
  const { enc, procs, advance } = harness({ args: run => { seen.push(run); return ["-i", "-"]; } });
  enc.start();
  procs[0].report(10); await flush();
  advance(5_000);
  procs[0].emit("exit", 1);
  advance(2_000);
  assert.deepEqual(seen[0], { generation: 1, previous: null });
  assert.deepEqual(seen[1], { generation: 2, previous: { generation: 1, ranMs: 5_000, progressed: true } });
  enc.restart("encoder-stalled");
  advance(4_000);
  assert.deepEqual(seen[2].previous, { generation: 2, ranMs: 0, progressed: false });
});

test("stop ends stdin and does not schedule a restart", async () => {
  const { enc, procs, timers } = harness();
  enc.start();
  const stopped = enc.stop();
  procs[0].emit("exit", 0);
  await stopped;
  assert.equal(timers.length, 0);
});
