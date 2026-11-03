import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClipRecorder, clipName, parseSegmentList, pickSegments, retentionPlan, segmentSlave, teeUnsafe } from "./clips.mjs";

test("the segment slave is bounded, fifo-buffered with drops, and can never fail the stream", () => {
  const slave = segmentSlave({ dir: "/s/g1", segmentSeconds: 4, wrap: 30, fifoPackets: 600 });
  assert.match(slave, /^\[f=segment:onfail=ignore:use_fifo=1:/);
  assert.ok(slave.includes("fifo_options='queue_size=600\\:drop_pkts_on_overflow=1'"));
  assert.ok(slave.includes(":segment_wrap=30:") && slave.includes(":segment_list_size=29]"));
  assert.ok(slave.endsWith("]/s/g1/seg%03d.ts"));
  assert.equal(teeUnsafe("/home/corey/.local/state/cobblebob-stream/clip-segments/g1"), false);
  for (const bad of ["/a:b", "/a|b", "/a[b", "/a'b", "/a=b", "/a\\b"]) assert.equal(teeUnsafe(bad), true, bad);
});

test("the segment list parser keeps only well-formed segment lines", () => {
  assert.deepEqual(parseSegmentList("seg002.ts,10.0,14.0\nseg003.ts,14.0,18.0\n../x.ts,1,2\nseg004.ts,18.0\nseg005.ts,20,19\n"), [
    { name: "seg002.ts", start: 10, end: 14 }, { name: "seg003.ts", start: 14, end: 18 },
  ]);
});

test("segments overlapping the window are picked in order", () => {
  const segs = [3, 1, 2, 4].map(i => ({ name: `seg00${i}.ts`, startAt: i * 4000, endAt: (i + 1) * 4000 }));
  assert.deepEqual(pickSegments(segs, 6000, 13000).map(s => s.name), ["seg001.ts", "seg002.ts", "seg003.ts"]);
  assert.deepEqual(pickSegments(segs, 30000, 40000), []);
});

test("retention keeps the newest clips inside both the count and byte caps", () => {
  const files = [1, 2, 3, 4, 5].map(i => ({ name: `clip-${i}.mp4`, bytes: 100, mtimeMs: i }));
  assert.deepEqual(retentionPlan(files, { maxCount: 3, maxBytes: 1000 }).sort(), ["clip-1.mp4", "clip-2.mp4"]);
  assert.deepEqual(retentionPlan(files, { maxCount: 10, maxBytes: 250 }).sort(), ["clip-1.mp4", "clip-2.mp4", "clip-3.mp4"]);
  assert.deepEqual(retentionPlan([{ name: "huge.mp4", bytes: 2000, mtimeMs: 1 }], { maxCount: 10, maxBytes: 1000 }), ["huge.mp4"], "a clip alone over the byte cap goes too");
});

test("clip names carry only the time and the banner kinds", () => {
  assert.equal(clipName(Date.UTC(2026, 10, 2, 20, 15, 3, 456), new Set(["death", "tier"])), "clip-2026-11-02T20-15-03Z-death+tier.mp4");
});

/** A recorder over a temp dir with a fake clock, fake timers and a fake ffmpeg that writes its output file. */
function harness(options = {}) {
  const root = mkdtempSync(join(tmpdir(), "clips-test-"));
  let t = Date.UTC(2026, 10, 2, 20, 0, 0);
  const timers = [], runs = [], logs = [];
  let exitCode = 0;
  const rec = new ClipRecorder({
    clipsDir: join(root, "clips"), segmentsDir: join(root, "segments"), log: (msg, extra) => logs.push({ msg, ...extra }),
    wallNow: () => t, freeBytes: () => 100 * 1024 ** 3,
    setTimer: (fn, ms) => { const timer = { fn, at: t + ms }; timers.push(timer); return timer; },
    clearTimer: timer => { const i = timers.indexOf(timer); if (i >= 0) timers.splice(i, 1); },
    spawn: (cmd, args) => {
      const proc = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), kill() {} });
      runs.push({ cmd, args, list: readFileSync(args[args.indexOf("-i") + 1], "utf8") });
      if (exitCode === 0) writeFileSync(args.at(-1), Buffer.alloc(1000));
      queueMicrotask(() => proc.emit("exit", exitCode));
      return proc;
    },
    segmentSeconds: 4, preRollMs: 20_000, postRollMs: 15_000, maxClipMs: 75_000, settleMs: 3_000, ...options,
  });
  rec.start();
  // ffmpeg's segment muxer, faked: one closed 4 s segment per call, listed with its stream times.
  let n = 0;
  const writeSegment = () => {
    const name = `seg${String(n % 30).padStart(3, "0")}.ts`;
    writeFileSync(join(rec.current, name), "ts");
    const at = new Date(t); utimesSync(join(rec.current, name), at, at);
    const lines = `${readSafe(join(rec.current, "segments.csv"))}${name},${n * 4}.0,${(n + 1) * 4}.0\n`.trim().split("\n").slice(-29);
    writeFileSync(join(rec.current, "segments.csv"), `${lines.join("\n")}\n`);
    n++;
  };
  const advance = async ms => {
    const end = t + ms;
    while (t < end) {
      t = Math.min(end, t + 4000);
      if (rec.current && existsSync(rec.current) && (t -Date.UTC(2026, 10, 2, 20, 0, 0)) % 4000 === 0) writeSegment();
      for (const timer of [...timers]) if (timer.at <= t) { timers.splice(timers.indexOf(timer), 1); timer.fn(); }
      await rec.chain;
    }
  };
  return { rec, root, runs, logs, timers, advance, setExit: code => { exitCode = code; }, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const readSafe = path => { try { return readFileSync(path, "utf8"); } catch { return ""; } };

test("a banner cuts one clip from the segments around it; nearby banners merge", async () => {
  const h = harness();
  try {
    assert.ok(h.rec.slave(1));
    await h.advance(60_000);
    h.rec.event("death");
    await h.advance(8_000);
    h.rec.event("tier");            // inside the same window: merged, window extended
    await h.advance(40_000);
    assert.equal(h.runs.length, 1, "one cut for both banners");
    const listed = h.runs[0].list.trim().split("\n").slice(1);
    // From 20 s before the first banner to 15 s after the second: about 43 s of 4 s segments.
    assert.ok(listed.length >= 10 && listed.length <= 13, `${listed.length} segments`);
    assert.ok(h.runs[0].args.includes("copy"), "stream copy, no re-encode");
    const saved = readdirSync(join(h.root, "clips"));
    assert.deepEqual(saved, ["clip-2026-11-02T20-01-00Z-death+tier.mp4"]);
    assert.equal(h.rec.status().saved, 1);
  } finally { h.cleanup(); }
});

test("a failed cut leaves no file, and no segments means no clip", async () => {
  const h = harness();
  try {
    h.rec.slave(1);
    await h.advance(40_000);
    h.setExit(1);
    h.rec.event("build");
    await h.advance(30_000);
    assert.equal(h.runs.length, 1);
    assert.deepEqual(readdirSync(join(h.root, "clips")), [], "partial removed");
    assert.equal(h.rec.status().failed, 1);
    // The encoder restarted into a fresh directory with nothing closed yet.
    h.setExit(0);
    h.rec.slave(2);
    assert.equal(existsSync(join(h.root, "segments", "g1")), false, "old generation removed");
    h.rec.event("milestone");
    h.rec.current = join(h.root, "segments", "gone");   // segments vanished (e.g. disk trouble)
    await h.advance(30_000);
    assert.equal(h.runs.length, 1, "nothing to cut");
    assert.ok(h.logs.some(l => l.msg === "clip skipped" && l.reason === "no-segments"));
  } finally { h.cleanup(); }
});

test("clips are capped per hour and pruned to the retention caps", async () => {
  const h = harness({ perHour: 2, maxCount: 1 });
  try {
    h.rec.slave(1);
    await h.advance(40_000);
    for (let i = 0; i < 3; i++) { h.rec.event("death"); await h.advance(100_000); }
    assert.equal(h.runs.length, 2, "the third moment in the hour is skipped");
    assert.equal(readdirSync(join(h.root, "clips")).length, 1, "only the newest clip is kept");
    assert.ok(h.logs.some(l => l.msg === "clip skipped" && l.reason === "hourly-cap"));
  } finally { h.cleanup(); }
});

test("low disk skips the cut; leftovers from a crash are cleared at start", async () => {
  const root = mkdtempSync(join(tmpdir(), "clips-test-"));
  try {
    mkdirSync(join(root, "clips"));
    writeFileSync(join(root, "clips", "clip-x.partial.mp4"), "half");
    const rec = new ClipRecorder({ clipsDir: join(root, "clips"), segmentsDir: join(root, "segments"), freeBytes: () => 1024 }).start();
    assert.deepEqual(readdirSync(join(root, "clips")), []);
    rec.slave(1);
    await rec.cut({ from: 0, to: 1, kinds: new Set(["death"]) });
    assert.equal(rec.status().lastResult, "low-disk");
    rec.stop();
    assert.equal(rec.slave(2), null, "stopped recorders add no slave");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an unknown banner kind is recorded as a generic moment", () => {
  const h = harness();
  try {
    h.rec.slave(1);
    h.rec.event("<script>");
    assert.deepEqual([...h.rec.pending[0].kinds], ["moment"]);
  } finally { h.rec.stop(); h.cleanup(); }
});
