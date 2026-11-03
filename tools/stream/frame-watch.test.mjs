import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { analyze, blankReason, changedShare, ffmpegGray, FrameWatch } from "./frame-watch.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const W = 64, H = 36, MIN = 60_000;
const noise = (seed = 1) => { let s = seed; return Buffer.from(Array.from({ length: W * H }, () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return 40 + ((s >> 16) % 160); })); };
const flat = value => Buffer.alloc(W * H, value);

function harness(options = {}) {
  let t = 0; const now = () => t;
  const dir = mkdtempSync(join(tmpdir(), "frames-"));
  let date = new Date(2026, 10, 2, 13, 0, 0);
  const queue = [];
  const watch = new FrameWatch({ dir, now, wallClock: () => date, decode: async () => queue.shift(), ...options });
  const flush = () => new Promise(resolve => setImmediate(resolve));
  // One sample: advance a minute, hand the next thumbnail to the fake decoder, observe.
  const step = async (gray, live = true, frame = Buffer.from(`jpeg-${t}`)) => { t += MIN; queue.push(gray); watch.observe(live, frame); await flush(); await flush(); };
  return { watch, dir, step, setDate: d => { date = d; }, advance: ms => { t += ms; } };
}

test("analysis: uniform, dark and black-game frames are blank; a busy frame is not", () => {
  assert.equal(blankReason(analyze(flat(128), W, H)), "frame-uniform");
  assert.equal(blankReason(analyze(flat(255), W, H)), "frame-uniform", "a white page is as blank as a black one");
  const dark = Buffer.from(noise().map(v => v % 16));
  assert.equal(blankReason(analyze(dark, W, H)), "frame-dark");
  const gameBlack = noise();
  for (let y = 0; y < 27; y++) gameBlack.fill(0, y * W, y * W + 48);
  assert.equal(blankReason(analyze(gameBlack, W, H)), "game-black");
  assert.equal(blankReason(analyze(noise(), W, H)), null);
  assert.equal(changedShare(noise(1), noise(1)), 0);
  assert.ok(changedShare(noise(1), noise(2)) > 0.5);
});

test("an unchanged live picture is frozen only after the full window; a real change resets it", async () => {
  const { watch, step } = harness();
  const still = noise(7);
  for (let i = 0; i < 15; i++) await step(still);
  assert.equal(watch.frozen, false, "14 minutes since the first sample");
  await step(still);
  assert.equal(watch.frozen, true);
  assert.equal(watch.status().unchangedMinutes, 15);
  await step(noise(8));
  assert.equal(watch.frozen, false);
});

test("tiny changes (a few pixels, a grey level or two everywhere) don't count as movement", async () => {
  const { watch, step } = harness();
  const base = noise(3);
  for (let i = 0; i < 16; i++) {
    const g = Buffer.from(base.map(v => v + (i % 2)));
    g[i] = 255 - g[i];                     // one or two pixels flicker (< 0.2 %)
    await step(g);
  }
  assert.equal(watch.frozen, true);
});

test("leaving live forgets the frozen and black evidence (the holding card is still by design)", async () => {
  const { watch, step } = harness();
  for (let i = 0; i < 16; i++) await step(flat(0));
  assert.equal(watch.frozen, true);
  assert.equal(watch.black, "frame-uniform");
  await step(null, false);
  assert.equal(watch.frozen, false);
  assert.equal(watch.black, null);
  await step(flat(0));
  assert.equal(watch.black, null, "the black window starts again");
});

test("black needs the black window, not one dark sample", async () => {
  const { watch, step } = harness();
  await step(flat(0)); await step(flat(0)); await step(flat(0));
  assert.equal(watch.black, null, "2 minutes");
  await step(flat(0));
  assert.equal(watch.black, "frame-uniform");
  await step(noise(4));
  assert.equal(watch.black, null);
});

test("samples are at most one a minute and never overlap", async () => {
  let calls = 0, release;
  const { watch, advance } = harness({ decode: () => { calls++; return new Promise(resolve => { release = resolve; }); } });
  const tick = () => new Promise(r => setImmediate(r));
  watch.observe(true, Buffer.from("a")); await tick();
  advance(2 * MIN); watch.observe(true, Buffer.from("b")); await tick();
  assert.equal(calls, 1, "the previous decode is still running");
  release(noise()); await tick(); await tick();
  watch.observe(true, Buffer.from("c")); await tick();
  assert.equal(calls, 2);
  advance(30_000); watch.observe(true, Buffer.from("d")); await tick();
  assert.equal(calls, 2);
});

test("decode failures are counted and never throw", async () => {
  const { watch, step } = harness({ decode: async () => { throw new Error("no ffmpeg"); } });
  await step(null); await step(null);
  assert.equal(watch.status().decodeFailures, 2);
  assert.equal(watch.frozen, false);
});

test("one snapshot a day after the snapshot hour, newest 14 kept", async () => {
  const { dir, step, setDate } = harness();
  mkdirSync(join(dir, "snapshots"));
  for (let d = 1; d <= 20; d++) writeFileSync(join(dir, "snapshots", `frame-2026-10-${String(d).padStart(2, "0")}.jpg`), "old");
  setDate(new Date(2026, 10, 3, 9, 0));
  await step(noise(), true, Buffer.from("morning"));
  assert.equal(existsSync(join(dir, "snapshots", "frame-2026-11-03.jpg")), false, "before noon");
  setDate(new Date(2026, 10, 3, 12, 5));
  await step(noise(), true, Buffer.from("noon"));
  await step(noise(), true, Buffer.from("later"));
  assert.equal(readFileSync(join(dir, "snapshots", "frame-2026-11-03.jpg"), "utf8"), "noon");
  const files = readdirSync(join(dir, "snapshots")).sort();
  assert.equal(files.length, 14);
  assert.equal(files.at(-1), "frame-2026-11-03.jpg");
  assert.equal(files[0], "frame-2026-10-08.jpg");
});

const hasFfmpeg = (() => { try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); return true; } catch { return false; } })();

test("ffmpeg decodes a real holding card into a 64×36 thumbnail that isn't blank", { skip: !hasFfmpeg && "ffmpeg not installed" }, async () => {
  const gray = await ffmpegGray(readFileSync(join(here, "assets", "holding-break.jpg")));
  assert.equal(gray.length, W * H);
  assert.equal(blankReason(analyze(gray, W, H)), null);
  await assert.rejects(ffmpegGray(Buffer.from("not a jpeg")));
});
