import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { Encoder, progressParser } from "./encoder.mjs";

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

test("stop ends stdin and does not schedule a restart", async () => {
  const { enc, procs, timers } = harness();
  enc.start();
  const stopped = enc.stop();
  procs[0].emit("exit", 0);
  await stopped;
  assert.equal(timers.length, 0);
});
